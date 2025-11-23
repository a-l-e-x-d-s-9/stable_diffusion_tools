#!/usr/bin/env python3

from __future__ import annotations

import os
import sys
import json
import argparse
import logging
import hashlib
import zipfile
import tempfile
from datetime import datetime
from pathlib import Path, PurePosixPath
from typing import List, Dict, Any, Optional, Tuple, Set
from concurrent.futures import ThreadPoolExecutor, as_completed
from collections import defaultdict

from huggingface_hub import HfApi, CommitOperationAdd
from tqdm import tqdm

# ANSI colors for terminal highlighting
RED = "\033[31m"
RESET = "\033[0m"

# ------------- Logging -------------

def setup_logging(verbose: bool) -> None:
    level = logging.DEBUG if verbose else logging.INFO
    fmt = "%(asctime)s | %(levelname)s | %(message)s"
    logging.basicConfig(level=level, format=fmt)

# ------------- Utils -------------

def read_text(path: str) -> str:
    with open(os.path.expanduser(path), "r", encoding="utf-8") as f:
        return f.read().strip()

def load_token(token_file: Optional[str], token_env: Optional[str]) -> Optional[str]:
    if token_env:
        tok = os.environ.get(token_env)
        if tok:
            return tok.strip()
    if token_file:
        p = os.path.expanduser(token_file)
        if os.path.isfile(p):
            return read_text(p)
    return None

def compute_sha256(path: str, chunk_size: int = 1024 * 1024) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while True:
            b = f.read(chunk_size)
            if not b:
                break
            h.update(b)
    return h.hexdigest()

def to_posix(*parts: str) -> str:
    posix = PurePosixPath("")
    for p in parts:
        if p is None or p == "":
            continue
        posix = posix / PurePosixPath(str(p).replace("\\\\", "/").replace("\\", "/"))
    return str(posix)

def now_timestamp() -> str:
    return datetime.utcnow().strftime("%Y%m%d-%H%M%S")

def strip_components(path_str: str, n: int) -> str:
    """Strip first n components from a posix path string."""
    parts = [p for p in path_str.split("/") if p not in ("", ".")]
    if n <= 0 or n >= len(parts):
        return "/".join(parts) if n <= 0 else parts[-1] if parts else ""
    return "/".join(parts[n:])

# ------------- Config Normalization -------------

class ConfigError(ValueError):
    pass

DEFAULT_ARCHIVE = {
    "mode": "none",  # none | zip_per_file | zip_source | zip_folders
    "name_template": "{source_basename}_{timestamp}.zip",
    "preserve_tree_inside": True,
    "strip_components": 0,
    "remove_archives_after_upload": False,
    "remove_originals_after_archive": False,
    "level": 6,
    # only for zip_folders
    "folders": [],
    # add to DEFAULT_ARCHIVE
    "folders_glob": None,       # e.g. "**/sample"
    "preserve_repo_tree": False, # if True, zip lands under the folder's relative path in the repo
    "exclude_globs": []

}

def merge_archive(top: Dict[str, Any], src: Optional[Dict[str, Any]], dst: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    """Merge archive configs with precedence: dst > src > top > defaults."""
    out = dict(DEFAULT_ARCHIVE)
    for d in (top or {}, src or {}, dst or {}):
        for k, v in d.items():
            out[k] = v
    return out

def discover_folders_by_glob(base: Path, glob_pat: str) -> List[str]:
    import glob as _glob
    out = []
    for p in _glob.glob(str(base / glob_pat), recursive=True):
        pp = Path(p)
        if pp.is_dir():
            out.append(str(pp))
    return out

def normalize_config(cfg: Dict[str, Any]) -> Dict[str, Any]:
    # Top-level defaults and options
    top_repo = cfg.get("repository")
    top_repo_type = cfg.get("repo_type", "model")
    top_token_file = cfg.get("token_file")
    top_token_env = cfg.get("token_env")
    top_source_base = cfg.get("source_base")  # optional shared base
    if top_source_base is not None:
        top_source_base = os.path.expanduser(top_source_base)

    threads = int(cfg.get("threads", 3))
    remove_after = bool(cfg.get("remove", False))
    dry_run = bool(cfg.get("dry_run", False))
    default_exists = cfg.get("default_exists", "skip")
    default_commit_message = cfg.get("default_commit_message", "batch upload {timestamp}")
    use_checksum = bool(cfg.get("use_checksum", False))
    progress_colour = cfg.get("progress_colour", "yellow")
    max_inflight_per_repo = int(cfg.get("max_inflight_per_repo", 2))

    archive_defaults = cfg.get("archive_defaults", {})

    sources = cfg.get("sources")
    if not sources or not isinstance(sources, list):
        raise ConfigError("config.sources must be a non-empty list")

    normalized_sources = []
    for idx, src in enumerate(sources, start=1):
        # source_base: per-source or top-level fallback
        source_base = src.get("source_base", top_source_base)
        if not source_base:
            raise ConfigError(f"source[{idx}] missing source_base and no top-level source_base provided")
        source_base = os.path.expanduser(source_base)
        if not os.path.isdir(source_base):
            raise ConfigError(f"source_base does not exist or is not a directory: {source_base}")

        path_in_repo = src.get("path_in_repository", "")
        preserve_tree = bool(src.get("preserve_tree", True))

        # include/exclude: support legacy 'files' as alias for include
        include = src.get("include") or src.get("files")
        if not include:
            raise ConfigError(f"source[{idx}] must define include (or legacy files) globs")
        if isinstance(include, str):
            include = [include]
        exclude = src.get("exclude") or []
        if isinstance(exclude, str):
            exclude = [exclude]

        # destinations single or list, else fallback to top-level repo/token
        destinations = src.get("destinations")
        if destinations is None:
            if not top_repo:
                raise ConfigError("top-level repository is required if a source has no destinations")
            destinations = [{
                "repository": top_repo,
                "repo_type": top_repo_type,
                "token_file": top_token_file,
                "token_env": top_token_env,
            }]
        elif isinstance(destinations, dict):
            destinations = [destinations]
        elif not isinstance(destinations, list):
            raise ConfigError("destinations must be an object or a list")

        # Source-level archive config
        source_archive = src.get("archive")

        norm_dests = []
        for d in destinations:
            repo_id = d.get("repository", top_repo)
            if not repo_id:
                raise ConfigError("destination.repository is required when top-level repository is not set")
            repo_type = d.get("repo_type", top_repo_type)
            token_file = d.get("token_file", top_token_file)
            token_env = d.get("token_env", top_token_env)
            create_pr = bool(d.get("create_pr", False))
            exists_policy = d.get("exists", default_exists)  # skip|overwrite|fail
            if exists_policy not in ("skip", "overwrite", "fail"):
                raise ConfigError("exists must be one of skip|overwrite|fail")
            commit_message = d.get("commit_message", default_commit_message)

            effective_archive = merge_archive(archive_defaults, source_archive, d.get("archive"))
            # Validate zip_folders
            if effective_archive["mode"] == "zip_folders":
                if not effective_archive.get("folders") and not effective_archive.get("folders_glob"):
                    raise ConfigError("archive.mode=zip_folders requires 'folders' or 'folders_glob'")

            norm_dests.append({
                "repository": repo_id,
                "repo_type": repo_type,
                "token_file": token_file,
                "token_env": token_env,
                "create_pr": create_pr,
                "exists": exists_policy,
                "commit_message": commit_message,
                "archive": effective_archive,
            })

        normalized_sources.append({
            "source_base": source_base,
            "path_in_repository": path_in_repo,
            "preserve_tree": preserve_tree,
            "include": include,
            "exclude": exclude,
            "destinations": norm_dests,
            "source_archive": source_archive or {},
        })

    return {
        "threads": threads,
        "remove": remove_after,
        "dry_run": dry_run,
        "use_checksum": use_checksum,
        "progress_colour": progress_colour,
        "max_inflight_per_repo": max_inflight_per_repo,
        "archive_defaults": merge_archive({}, cfg.get("archive_defaults", {}), None),
        "sources": normalized_sources,
    }

# ------------- File Selection -------------

def resolve_globs(base: str, patterns: List[str]) -> Set[Path]:
    matches: Set[Path] = set()
    base_path = Path(base)
    for pat in patterns:
        if os.path.isabs(pat):
            import glob as _glob
            for p in _glob.glob(pat, recursive=True):
                pth = Path(p)
                if pth.is_file():
                    matches.add(pth.resolve())
            continue
        import glob as _glob
        for p in _glob.glob(str(base_path / pat), recursive=True):
            pth = Path(p)
            if pth.is_file():
                matches.add(pth.resolve())
    return matches

def apply_excludes(files: Set[Path], base: str, exclude_patterns: List[str]) -> List[Path]:
    if not exclude_patterns:
        return sorted(files)
    base_path = Path(base)
    out = []
    import fnmatch
    for f in files:
        try:
            rel = f.relative_to(base_path)
            rel_str = str(rel).replace("\\\\", "/").replace("\\", "/")
        except Exception:
            rel_str = ""
        abs_str = str(f).replace("\\\\", "/").replace("\\", "/")
        excluded = False
        for pat in exclude_patterns:
            if os.path.isabs(pat):
                if fnmatch.fnmatch(abs_str, pat):
                    excluded = True
                    break
            else:
                anchored = str(base_path / pat).replace("\\\\", "/").replace("\\", "/")
                if fnmatch.fnmatch(rel_str, pat) or fnmatch.fnmatch(abs_str, anchored):
                    excluded = True
                    break
        if not excluded:
            out.append(f)
    return sorted(set(out))

# ------------- Planning with Archive Support -------------

class HFClient:
    def __init__(self, token: str):
        self.api = HfApi()
        self.token = token

def list_repo_paths(client: HFClient, repo_id: str, repo_type: str) -> Set[str]:
    try:
        files = client.api.list_repo_files(repo_id=repo_id, repo_type=repo_type, token=client.token)
        return set(files)
    except Exception as e:
        logging.warning(f"list_repo_files failed for {repo_id}: {e}")
        return set()

def remote_blob_matches(client: HFClient, repo_id: str, repo_type: str, path_in_repo: str, local_sha: str) -> bool:
    try:
        infos = client.api.get_paths_info(repo_id=repo_id, paths=[path_in_repo], repo_type=repo_type, token=client.token)
        if not infos:
            return False
        info = infos[0]
        remote_sha = None
        if getattr(info, "blob_id", None):
            remote_sha = info.blob_id
        elif getattr(info, "lfs", None) and isinstance(info.lfs, dict):
            remote_sha = info.lfs.get("sha256")
        if not remote_sha:
            return False
        return remote_sha.lower().strip() == local_sha.lower().strip()
    except Exception as e:
        logging.debug(f"Checksum compare unavailable for {repo_id}:{path_in_repo}: {e}")
        return False

def build_repo_path(path_in_repository: str, preserve_tree: bool, source_base: str, local_file: Path) -> str:
    if preserve_tree:
        try:
            rel = local_file.relative_to(Path(source_base))
            rel_posix = str(PurePosixPath(str(rel).replace("\\\\", "/").replace("\\", "/")))
        except Exception:
            rel_posix = local_file.name
        return to_posix(path_in_repository, rel_posix)
    else:
        return to_posix(path_in_repository, local_file.name)

def render_name_template(tpl: str, file: Optional[Path], source_base: Path, folder_name: Optional[str]) -> str:
    timestamp = datetime.utcnow().strftime("%Y%m%d-%H%M%S")
    d = {
        "timestamp": timestamp,
        "source_basename": source_base.name,
        "folder_name": folder_name or "",
        "filename": file.name if file else "",
        "stem": file.stem if file else "",
        "ext": (file.suffix[1:] if file and file.suffix.startswith(".") else (file.suffix if file else "")),
    }
    return tpl.format(**d)

def build_zip_per_file(files: List[Path], source_base: Path, tmpdir: Path, name_tpl: str, preserve_tree_inside: bool, strip_n: int, level: int) -> Dict[str, Path]:
    out: Dict[str, Path] = {}
    for f in files:
        name = render_name_template(name_tpl, f, source_base, None)
        zpath = tmpdir / name
        # Make sure parent exists
        zpath.parent.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(zpath, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=level) as zf:
            if preserve_tree_inside:
                try:
                    rel = f.relative_to(source_base)
                    arc = str(PurePosixPath(str(rel).replace("\\\\", "/").replace("\\", "/")))
                except Exception:
                    arc = f.name
            else:
                arc = f.name
            arc = strip_components(arc, strip_n) if strip_n else arc
            zf.write(f, arcname=arc)
        out[str(f)] = zpath
    return out

def build_zip_source(files: List[Path], source_base: Path, tmpdir: Path, name_tpl: str, preserve_tree_inside: bool, strip_n: int, level: int) -> Path:
    name = render_name_template(name_tpl, None, source_base, None)
    zpath = tmpdir / name
    zpath.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(zpath, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=level) as zf:
        for f in files:
            if preserve_tree_inside:
                try:
                    rel = f.relative_to(source_base)
                    arc = str(PurePosixPath(str(rel).replace("\\\\", "/").replace("\\", "/")))
                except Exception:
                    arc = f.name
            else:
                arc = f.name
            arc = strip_components(arc, strip_n) if strip_n else arc
            zf.write(f, arcname=arc)
    return zpath

def build_zip_folders(folders, source_base, tmpdir, name_tpl, preserve_tree_inside, strip_n, level, exclude_globs=None):
    import fnmatch
    exclude_globs = exclude_globs or []
    out: Dict[str, Path] = {}
    for folder in folders:
        folder_path = Path(folder)
        if not folder_path.is_absolute():
            folder_path = source_base / folder_path
        if not folder_path.exists() or not folder_path.is_dir():
            logging.warning(f"zip_folders: folder not found or not a dir: {folder_path}")
            continue
        name = render_name_template(name_tpl, None, source_base, folder_path.name)
        zpath = tmpdir / name
        zpath.parent.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(zpath, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=level) as zf:
            for root, dirs, files in os.walk(folder_path):
                for fn in files:
                    fp = Path(root) / fn
                    # Skip excluded files (match against basename and folder-relative path)
                    rel_to_folder = str((fp.relative_to(folder_path)).as_posix())
                    if any(fnmatch.fnmatch(fn, pat) or fnmatch.fnmatch(rel_to_folder, pat) for pat in exclude_globs):
                        continue
                    if preserve_tree_inside:
                        try:
                            rel = fp.relative_to(source_base)
                            arc = str(PurePosixPath(str(rel).replace("\\\\", "/").replace("\\", "/")))
                        except Exception:
                            rel2 = fp.relative_to(folder_path)
                            arc = str(PurePosixPath(str(rel2).replace("\\\\", "/").replace("\\", "/")))
                    else:
                        rel2 = fp.relative_to(folder_path)
                        arc = str(PurePosixPath(str(rel2).replace("\\\\", "/").replace("\\", "/")))
                    arc = strip_components(arc, strip_n) if strip_n else arc
                    zf.write(fp, arcname=arc)
        out[str(folder_path)] = zpath
    return out

def plan_operations(cfg: Dict[str, Any]) -> Tuple[List[Dict[str, Any]], Dict[str, Any]]:
    dry_run = cfg["dry_run"]
    use_checksum = cfg["use_checksum"]

    plans: List[Dict[str, Any]] = []
    delete_tracker: Dict[str, Dict[str, int]] = defaultdict(lambda: {"planned": 0, "succeeded": 0})

    dest_cache_key_map: Dict[Tuple[str, str, str], int] = {}
    dest_state_files: Dict[int, Set[str]] = {}
    dest_clients: Dict[int, Optional[HFClient]] = {}

    skipped_count = 0
    exists_fail_hits = 0

    # For removing originals after archive: track per-source archive destination success
    source_archive_plan_counts: Dict[int, int] = defaultdict(int)  # index of source -> number of destinations using archive
    source_archive_succeed_counts: Dict[int, int] = defaultdict(int)
    source_originals: Dict[int, List[str]] = {}

    # Temp dir to store archives
    tmpdir = Path(tempfile.mkdtemp(prefix="_hf_tmp_")) if not dry_run else None

    for s_idx, src in enumerate(cfg["sources"]):
        base = src["source_base"]
        include = src["include"]
        exclude = src["exclude"]
        preserve_tree = src["preserve_tree"]
        path_prefix = src["path_in_repository"]

        found = resolve_globs(base, include)
        files = apply_excludes(found, base, exclude)

        if not files:
            logging.warning(f"No files matched for base={base}")
            continue

        source_originals[s_idx] = [str(p) for p in files]

        # Prepare archives once per source as needed
        per_file_zip_cache: Dict[str, Path] = {}
        source_zip_path: Optional[Path] = None
        folder_zip_cache: Dict[str, Path] = {}

        # Check if any destination wants archive
        any_archive_needed = any(d["archive"]["mode"] != "none" for d in src["destinations"])

        if any_archive_needed and not dry_run:
            # Determine highest level across dests that want archives, and shared settings by merging per dest? We build per mode separately.
            # Build zip_per_file if any destination requests it
            if any(d["archive"]["mode"] == "zip_per_file" for d in src["destinations"]):
                # Use source-level or first dest config for naming/inside structure (per-dest differences in name will be handled via repo_path, not archive filename)
                # We will use source-level effective defaults from archive_defaults merged with source_archive.
                # However, zips are stored locally; their names do not need to vary per destination. We pick the source-level(defaults) naming.
                base_archive = merge_archive(cfg.get("archive_defaults", {}), src.get("source_archive", {}), None)
                per_file_zip_cache = build_zip_per_file(
                    files=list(files),
                    source_base=Path(base),
                    tmpdir=tmpdir,
                    name_tpl=base_archive.get("name_template", "{stem}.zip") if base_archive["mode"] == "zip_per_file" else "{stem}.zip",
                    preserve_tree_inside=base_archive.get("preserve_tree_inside", True),
                    strip_n=int(base_archive.get("strip_components", 0)),
                    level=int(base_archive.get("level", 6)),
                )

            if any(d["archive"]["mode"] == "zip_source" for d in src["destinations"]):
                base_archive = merge_archive(cfg.get("archive_defaults", {}), src.get("source_archive", {}), None)
                source_zip_path = build_zip_source(
                    files=list(files),
                    source_base=Path(base),
                    tmpdir=tmpdir,
                    name_tpl=base_archive.get("name_template", "{source_basename}_{timestamp}.zip"),
                    preserve_tree_inside=base_archive.get("preserve_tree_inside", True),
                    strip_n=int(base_archive.get("strip_components", 0)),
                    level=int(base_archive.get("level", 6)),
                )

            if any(d["archive"]["mode"] == "zip_folders" for d in src["destinations"]):
                base_archive = merge_archive(cfg.get("archive_defaults", {}), src.get("source_archive", {}), None)

                # Collect explicit folders + folders_glob hits (once per source)
                folder_candidates: List[str] = list(base_archive.get("folders", []) or [])
                if base_archive.get("folders_glob"):
                    folder_candidates.extend(discover_folders_by_glob(Path(base), base_archive["folders_glob"]))

                # Deduplicate while preserving order
                seen = set()
                folder_candidates = [f for f in folder_candidates if not (f in seen or seen.add(f))]
                base_archive = merge_archive(cfg.get("archive_defaults", {}), src.get("source_archive", {}), None)
                exclude_globs = base_archive.get("exclude_globs", []) or []

                folder_zip_cache = build_zip_folders(
                    folders=folder_candidates,
                    source_base=Path(base),
                    tmpdir=tmpdir,
                    name_tpl=base_archive.get("name_template", "{folder_name}.zip"),
                    preserve_tree_inside=base_archive.get("preserve_tree_inside", True),
                    strip_n=int(base_archive.get("strip_components", 0)),
                    level=int(base_archive.get("level", 6)),
                    exclude_globs=exclude_globs,
                )

        for dest in src["destinations"]:
            repo_id = dest["repository"]
            repo_type = dest.get("repo_type", "model")
            token_file = dest.get("token_file")
            token_env = dest.get("token_env")
            token = load_token(token_file, token_env)
            if not token:
                raise ConfigError(f"cannot resolve token for destination repo {repo_id}")

            create_pr = bool(dest["create_pr"])
            exists_policy = dest["exists"]
            commit_message_tpl = dest["commit_message"]
            arch = dest["archive"]

            key = (repo_id, repo_type, token)
            plan_idx = dest_cache_key_map.get(key)
            if plan_idx is None:
                plans.append({
                    "repo_id": repo_id,
                    "repo_type": repo_type,
                    "token": token,
                    "create_pr": create_pr,
                    "commit_message_tpl": commit_message_tpl,
                    "files": [],
                    "exists_policy": exists_policy,
                    "preserve_tree": preserve_tree,
                    "archive_remove_local": bool(arch.get("remove_archives_after_upload", False)),
                    "source_index": s_idx,  # for originals removal by archive success
                })
                plan_idx = len(plans) - 1
                dest_cache_key_map[key] = plan_idx
                if not dry_run:
                    client = HFClient(token)
                    dest_clients[plan_idx] = client
                    dest_state_files[plan_idx] = list_repo_paths(client, repo_id, repo_type)
                else:
                    dest_clients[plan_idx] = None
                    dest_state_files[plan_idx] = set()

            existing_paths = dest_state_files[plan_idx]
            client = dest_clients[plan_idx]

            # Select artifacts to upload according to archive mode
            artifacts: List[Tuple[str, str, int, Optional[str]]] = []  # (local_path, repo_path, size, sha)
            if arch["mode"] == "none":
                for f in files:
                    repo_path = build_repo_path(path_prefix, preserve_tree, base, f)
                    size = f.stat().st_size if not dry_run else 0
                    artifacts.append((str(f), repo_path, size, None))
            elif arch["mode"] == "zip_per_file":
                # reuse prepared zips if available; in dry_run, synthesize names
                for f in files:
                    if not dry_run and per_file_zip_cache:
                        zpath = per_file_zip_cache[str(f)]
                        size = zpath.stat().st_size
                        repo_name = Path(zpath).name  # upload zip name
                    else:
                        # dry-run approximations
                        repo_name = render_name_template(dest["archive"]["name_template"] or "{stem}.zip", f, Path(base), None)
                        size = f.stat().st_size if f.exists() else 0
                        zpath = Path("/tmp") / repo_name  # placeholder path, not used
                    repo_path = to_posix(path_prefix, repo_name)
                    artifacts.append((str(zpath), repo_path, size, None))
                source_archive_plan_counts[s_idx] += 1
            elif arch["mode"] == "zip_source":
                if not dry_run and source_zip_path is not None:
                    zpath = source_zip_path
                    size = zpath.stat().st_size
                else:
                    zpath = Path("/tmp") / render_name_template(dest["archive"]["name_template"] or "{source_basename}_{timestamp}.zip", None, Path(base), None)
                    size = sum(fp.stat().st_size for fp in files if fp.exists())
                repo_name = Path(zpath).name
                repo_path = to_posix(path_prefix, repo_name)
                artifacts.append((str(zpath), repo_path, size, None))
                source_archive_plan_counts[s_idx] += 1
            elif arch["mode"] == "zip_folders":
                # Determine which folders we're zipping for this source
                # Prefer prebuilt cache in non-dry-run; otherwise compute names for dry-run
                preserve_repo_tree = bool(arch.get("preserve_repo_tree", False))
                base_arch = dest["archive"]

                if not dry_run and folder_zip_cache:
                    for fpath, zpath in folder_zip_cache.items():
                        zip_name = Path(zpath).name
                        if preserve_repo_tree:
                            # put the zip under the folder's relative path
                            try:
                                rel_folder = Path(fpath).relative_to(base)  # relative to source_base
                                repo_path = to_posix(path_prefix, str(PurePosixPath(str(rel_folder))), zip_name)
                            except Exception:
                                # fallback to flat
                                repo_path = to_posix(path_prefix, zip_name)
                        else:
                            repo_path = to_posix(path_prefix, zip_name)
                        artifacts.append((str(zpath), repo_path, zpath.stat().st_size, None))
                else:
                    # dry-run estimation: expand folders from folders and folders_glob
                    folder_candidates: List[str] = list(base_arch.get("folders", []) or [])
                    if base_arch.get("folders_glob"):
                        folder_candidates.extend(discover_folders_by_glob(Path(base), base_arch["folders_glob"]))
                    # dedupe
                    seen = set()
                    folder_candidates = [f for f in folder_candidates if not (f in seen or seen.add(f))]

                    for folder in folder_candidates:
                        folder_p = Path(folder)
                        zip_name = render_name_template(base_arch.get("name_template", "{folder_name}.zip"),
                                                        None, Path(base), folder_p.name)
                        if preserve_repo_tree:
                            try:
                                rel_folder = folder_p.relative_to(base)
                                repo_path = to_posix(path_prefix, str(PurePosixPath(str(rel_folder))), zip_name)
                            except Exception:
                                repo_path = to_posix(path_prefix, zip_name)
                        else:
                            repo_path = to_posix(path_prefix, zip_name)
                        artifacts.append((str(Path("/tmp") / zip_name), repo_path, 0, None))

                source_archive_plan_counts[s_idx] += 1

            else:
                raise ConfigError(f"Unknown archive mode: {arch['mode']}")

            # Existence policy checks and checksum
            for local_path, repo_path, size, sha in artifacts:
                exists_remote = repo_path in existing_paths
                take_action = True
                if exists_remote:
                    if dest["exists"] == "skip":
                        take_action = False
                        skipped_count += 1
                    elif dest["exists"] == "fail":
                        logging.error(f"Exists policy fail: {repo_id}:{repo_path} already exists")
                        exists_fail_hits += 1
                        take_action = False
                    elif dest["exists"] == "overwrite":
                        take_action = True
                    else:
                        take_action = False

                    if take_action and cfg["use_checksum"] and not dry_run and client is not None:
                        try:
                            sha = compute_sha256(local_path)
                            if remote_blob_matches(client, repo_id, repo_type, repo_path, sha):
                                take_action = False
                                skipped_count += 1
                                logging.info(f"Identical content, skipping: {repo_id}:{repo_path}")
                        except Exception as e:
                            logging.debug(f"checksum failed for {local_path}: {e}")

                if take_action:
                    plans[plan_idx]["files"].append((local_path, repo_path, size, sha))
                    delete_tracker[local_path]["planned"] += 1  # track archives for removal
                    # track originals for raw uploads
                    if arch["mode"] == "none":
                        # increment planned for original if we want to honor remove flag for raw files
                        delete_tracker.get(local_path, {"planned": 0, "succeeded": 0})

    totals = {
        "bytes_planned": sum(sz for p in plans for (_, _, sz, _) in p["files"]),
        "files_planned": sum(1 for p in plans for _ in p["files"]),
        "destinations": len(plans),
        "skipped_planned": skipped_count,
        "exists_fail_hits": exists_fail_hits,
        "tmpdir": str(tmpdir) if tmpdir else "",
        "source_archive_plan_counts": dict(source_archive_plan_counts),
        "source_originals": source_originals,
    }

    return plans, {"delete_tracker": delete_tracker, "totals": totals}

# ------------- Execution -------------

def execute_plans(plans: List[Dict[str, Any]], cfg: Dict[str, Any], totals: Dict[str, Any]) -> Dict[str, Any]:
    threads = cfg["threads"]
    remove_after = cfg["remove"]
    progress_colour = cfg["progress_colour"]
    max_inflight_per_repo = cfg["max_inflight_per_repo"]

    # Per-repo concurrency control
    import threading
    semaphores: Dict[Tuple[str, str], threading.Semaphore] = {}
    for p in plans:
        key = (p["repo_id"], p["token"])
        if key not in semaphores:
            semaphores[key] = threading.Semaphore(max_inflight_per_repo)

    results = {
        "uploaded": 0,
        "failed": 0,
        "bytes_uploaded": 0,
        "per_destination": [],
    }

    total_bytes = sum(sz for p in plans for (_, _, sz, _) in p["files"])
    if total_bytes <= 0:
        logging.info("Nothing to upload after planning.")
        return results

    try:
        pbar = tqdm(total=total_bytes, unit="B", unit_scale=True, unit_divisor=1024,
                    colour=progress_colour, desc="Uploading")
    except TypeError:
        pbar = tqdm(total=total_bytes, unit="B", unit_scale=True, unit_divisor=1024,
                    desc="Uploading")

    delete_tracker: Dict[str, Dict[str, int]] = cfg["__delete_tracker__"]
    failed_files: Set[str] = set()

    # Track per-source archive destination success for original deletion
    source_archive_plan_counts = totals.get("source_archive_plan_counts", {})
    source_archive_succeed_counts: Dict[int, int] = defaultdict(int)

    def _commit_for_plan(plan: Dict[str, Any]) -> Tuple[bool, Dict[str, Any]]:
        repo_id = plan["repo_id"]
        repo_type = plan["repo_type"]
        token = plan["token"]
        create_pr = plan["create_pr"]
        commit_tpl = plan["commit_message_tpl"]
        files = plan["files"]
        src_index = plan.get("source_index", -1)
        remove_archives_local = plan.get("archive_remove_local", False)
        key = (repo_id, token)

        sem = semaphores[key]
        sem.acquire()
        try:
            api = HfApi()

            # Deduplicate by repo_path (last occurrence wins)
            uniq = {}
            for lp, rp, sz, sh in files:
                uniq[rp] = (lp, rp, sz, sh)
            files = list(uniq.values())

            if not files:
                return True, {"repo_id": repo_id, "bytes": 0, "files": 0}

            ops = [CommitOperationAdd(path_in_repo=rp, path_or_fileobj=lp) for (lp, rp, sz, sh) in files]
            bytes_in_commit = sum(sz for (_, _, sz, _) in files)
            commit_msg = commit_tpl.format(timestamp=now_timestamp())

            try:
                api.create_commit(
                    repo_id=repo_id,
                    repo_type=repo_type,
                    operations=ops,
                    commit_message=commit_msg,
                    create_pr=create_pr,
                    token=token,
                )
                pbar.update(bytes_in_commit)
                for lp, rp, sz, sh in files:
                    delete_tracker[lp]["succeeded"] += 1
                # Success for this destination, count toward source archive success
                if src_index in source_archive_plan_counts:
                    source_archive_succeed_counts[src_index] += 1
                # Optionally remove local archives for this destination if all succeeded for those archive files
                if remove_archives_local:
                    for lp, rp, sz, sh in files:
                        # If planned == succeeded for this temp archive, remove it now
                        counters = delete_tracker.get(lp)
                        if counters and counters["planned"] == counters["succeeded"]:
                            try:
                                if os.path.exists(lp):
                                    os.remove(lp)
                                    logging.info(f"Removed local archive: {lp}")
                            except Exception as e:
                                logging.warning(f"Failed to remove archive {lp}: {e}")
                return True, {"repo_id": repo_id, "bytes": bytes_in_commit, "files": len(files)}
            except Exception as e:
                logging.error(f"Commit failed for {repo_id}: {e}")
                for lp, _, _, _ in files:
                    failed_files.add(lp)
                return False, {"repo_id": repo_id, "bytes": 0, "files": 0, "error": str(e)}
        finally:
            sem.release()

    futures = []
    with ThreadPoolExecutor(max_workers=threads) as ex:
        for plan in plans:
            futures.append(ex.submit(_commit_for_plan, plan))
        for fut in as_completed(futures):
            ok, info = fut.result()
            if ok:
                results["uploaded"] += info.get("files", 0)
                results["bytes_uploaded"] += info.get("bytes", 0)
            else:
                results["failed"] += 1
            results["per_destination"].append(info)

    pbar.close()

    # Determine files that failed in all destinations
    completely_failed_files = []
    for local_path, counters in delete_tracker.items():
        # A "completely failed" file is one that was planned for upload
        # but never succeeded in any destination.
        if counters["planned"] > 0 and counters["succeeded"] == 0 and local_path in failed_files:
            completely_failed_files.append(local_path)

    if completely_failed_files:
        logging.error(RED + f"Files that failed in all destinations: {len(completely_failed_files)}" + RESET)
        for lp in sorted(completely_failed_files):
            logging.error(RED + f"FAILED file: {lp}" + RESET)

    # Attach list of failed files to results for main() / exit code
    results["failed_files"] = completely_failed_files

    # Removal rules
    # 1) Remove originals that were uploaded raw when cfg.remove is True
    if remove_after:
        for local_path, counters in list(delete_tracker.items()):
            if counters["planned"] > 0 and counters["succeeded"] == counters["planned"] and os.path.isfile(local_path):
                try:
                    os.remove(local_path)
                    logging.info(f"Removed local file: {local_path}")
                    del delete_tracker[local_path]
                except Exception as e:
                    logging.warning(f"Failed to remove {local_path}: {e}")

    # 2) Remove originals after archive uploads if requested by archive_defaults or source/destination overrides
    # We use top-level default remove_originals_after_archive if any destination for the source used archives and all such destinations succeeded
    ao = cfg.get("archive_defaults", {})
    remove_originals_after_archive = bool(ao.get("remove_originals_after_archive", False))
    if remove_originals_after_archive and source_archive_plan_counts:
        for s_idx, planned_dests in source_archive_plan_counts.items():
            succeeded = source_archive_succeed_counts.get(s_idx, 0)
            if planned_dests > 0 and succeeded >= planned_dests:
                # safe to remove originals for this source
                for fp in totals.get("source_originals", {}).get(s_idx, []):
                    try:
                        if os.path.isfile(fp):
                            os.remove(fp)
                            logging.info(f"Removed original after archive success: {fp}")
                    except Exception as e:
                        logging.warning(f"Failed to remove original {fp}: {e}")

    # Cleanup tmpdir
    tmpdir = totals.get("tmpdir")
    if tmpdir and os.path.isdir(tmpdir):
        try:
            # Remove only empty dirs; archives might have been removed already; if anything left, remove the folder anyway
            import shutil
            shutil.rmtree(tmpdir, ignore_errors=True)
        except Exception as e:
            logging.debug(f"tmpdir cleanup warning: {e}")

    return results


# ------------- CLI -------------

def main(argv: Optional[List[str]] = None) -> int:
    ap = argparse.ArgumentParser(description="Batch upload files to Hugging Face repos with multi-destination and optional ZIP archiving.")
    ap.add_argument("--configurations", required=True, help="Path to configuration JSON")
    ap.add_argument("--repository", default=None, help="Override top-level repository")
    ap.add_argument("--token_file", default=None, help="Override top-level token_file")
    ap.add_argument("--token_env", default=None, help="Override top-level token_env")
    ap.add_argument("--source_base", default=None, help="Override top-level source_base")
    ap.add_argument("--threads", type=int, default=None, help="Override threads")
    ap.add_argument("--remove", action="store_true", help="Remove local files after successful uploads to all destinations")
    ap.add_argument("--dry_run", action="store_true", help="Do not perform network operations")
    ap.add_argument("--verbose", action="store_true", help="Verbose logging")

    args = ap.parse_args(argv)
    setup_logging(args.verbose)

    with open(os.path.expanduser(args.configurations), "r", encoding="utf-8") as f:
        raw_cfg = json.load(f)

    # CLI overrides
    if args.repository is not None:
        raw_cfg["repository"] = args.repository
    if args.token_file is not None:
        raw_cfg["token_file"] = args.token_file
    if args.token_env is not None:
        raw_cfg["token_env"] = args.token_env
    if args.source_base is not None:
        raw_cfg["source_base"] = args.source_base
    if args.threads is not None:
        raw_cfg["threads"] = args.threads
    if args.remove:
        raw_cfg["remove"] = True
    if args.dry_run:
        raw_cfg["dry_run"] = True

    # Normalize and validate
    try:
        cfg = normalize_config(raw_cfg)
    except ConfigError as e:
        logging.error(f"Config error: {e}")
        return 2

    # Planning
    plans, aux = plan_operations(cfg)
    totals = aux["totals"]
    delete_tracker = aux["delete_tracker"]
    cfg["__delete_tracker__"] = delete_tracker

    logging.info(f"Planned: destinations={totals['destinations']}, files={totals['files_planned']}, bytes={totals['bytes_planned']:,}, skipped={totals.get('skipped_planned', 0)}")

    if totals.get("exists_fail_hits", 0) > 0:
        logging.error(f"Aborting due to exists=fail policy: {totals['exists_fail_hits']} conflicting paths found.")
        return 3

    # Dry run
    if cfg["dry_run"]:
        for idx, p in enumerate(plans, 1):
            logging.info(f"[{idx}] repo={p['repo_id']} type={p['repo_type']} create_pr={p['create_pr']} exists={p['exists_policy']} files={len(p['files'])}")
            for local_path, repo_path, size, sha in p["files"][:20]:
                logging.info(f"  {local_path} -> {p['repo_id']}:{repo_path} ({size} bytes)")
            extra = len(p["files"]) - 20
            if extra > 0:
                logging.info(f"  ... and {extra} more")
        logging.info("Dry run finished.")
        return 0

    # Execute
    results = execute_plans(plans, cfg, totals)

    failed_files = results.get("failed_files", []) or []
    failed_file_count = len(failed_files)

    # Summary
    summary = {
        "uploaded_files": results["uploaded"],
        "failed_destinations": results["failed"],
        "bytes_uploaded": results["bytes_uploaded"],
        "planned_files": totals["files_planned"],
        "planned_bytes": totals["bytes_planned"],
        "skipped_planned": totals.get("skipped_planned", 0),
        "failed_files": failed_file_count
    }
    print(json.dumps(summary, indent=2))

    # Highlight failed-files count in the terminal
    if failed_file_count > 0:
        logging.error(RED + f"FAILED FILES (all destinations): {failed_file_count}" + RESET)
    else:
        logging.info("FAILED FILES (all destinations): 0")

    # Redact tokens before writing manifest
    safe_plans = []
    for p in plans:
        q = dict(p)
        if "token" in q:
            q["token"] = "***REDACTED***"
        safe_plans.append(q)

    out_manifest = f"hf_upload_manifest_{datetime.utcnow().strftime('%Y%m%d-%H%M%S')}.json"
    try:
        with open(out_manifest, "w", encoding="utf-8") as mf:
            json.dump({"summary": summary, "plans": safe_plans}, mf, indent=2)
        logging.info(f"Wrote manifest: {out_manifest}")
    except Exception as e:
        logging.warning(f"Failed to write manifest: {e}")

    # Exit code: non-zero if any file completely failed
    if failed_file_count > 0:
        return 4
    return 0


if __name__ == "__main__":
    sys.exit(main())