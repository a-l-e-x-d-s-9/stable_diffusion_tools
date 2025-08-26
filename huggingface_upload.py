from __future__ import annotations

import os
import sys
import json
import argparse
import logging
import hashlib
from datetime import datetime
from pathlib import Path, PurePosixPath
from typing import List, Dict, Any, Optional, Tuple, Set
from concurrent.futures import ThreadPoolExecutor, as_completed
from collections import defaultdict

from huggingface_hub import HfApi, CommitOperationAdd
from tqdm import tqdm

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

# ------------- Config Normalization -------------

class ConfigError(ValueError):
    pass

def normalize_config(cfg: Dict[str, Any]) -> Dict[str, Any]:
    # Top-level defaults and options
    top_repo = cfg.get("repository")
    top_repo_type = cfg.get("repo_type", "model")
    top_token_file = cfg.get("token_file")
    top_token_env = cfg.get("token_env")
    top_source_base = cfg.get("source_base")  # optional new feature
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

            norm_dests.append({
                "repository": repo_id,
                "repo_type": repo_type,
                "token_file": token_file,
                "token_env": token_env,
                "create_pr": create_pr,
                "exists": exists_policy,
                "commit_message": commit_message,
            })

        normalized_sources.append({
            "source_base": source_base,
            "path_in_repository": path_in_repo,
            "preserve_tree": preserve_tree,
            "include": include,
            "exclude": exclude,
            "destinations": norm_dests,
        })

    return {
        "threads": threads,
        "remove": remove_after,
        "dry_run": dry_run,
        "use_checksum": use_checksum,
        "progress_colour": progress_colour,
        "max_inflight_per_repo": max_inflight_per_repo,
        "sources": normalized_sources,
    }

# ------------- File Selection -------------

def resolve_globs(base: str, patterns: List[str]) -> Set[Path]:
    matches: Set[Path] = set()
    base_path = Path(base)
    for pat in patterns:
        if os.path.isabs(pat):
            # Absolute pattern: use glob module to be safe across platforms
            import glob as _glob
            for p in _glob.glob(pat, recursive=True):
                pth = Path(p)
                if pth.is_file():
                    matches.add(pth.resolve())
            continue
        # Relative pattern anchored at base
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

# ------------- Planning and Existence Checks -------------

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

def plan_operations(cfg: Dict[str, Any]) -> Tuple[List[Dict[str, Any]], Dict[str, Any]]:
    dry_run = cfg["dry_run"]
    use_checksum = cfg["use_checksum"]

    plans: List[Dict[str, Any]] = []
    delete_tracker: Dict[str, Dict[str, int]] = defaultdict(lambda: {"planned": 0, "succeeded": 0})

    # Per-destination caches
    dest_cache_key_map: Dict[Tuple[str, str, str], int] = {}  # (repo_id, repo_type, token) -> plan idx
    dest_state_files: Dict[int, Set[str]] = {}
    dest_clients: Dict[int, Optional[HFClient]] = {}

    skipped_count = 0
    exists_fail_hits = 0

    for src in cfg["sources"]:
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

            for f in files:
                repo_path = build_repo_path(path_prefix, preserve_tree, base, f)
                size = f.stat().st_size
                sha256 = None

                exists_remote = repo_path in existing_paths

                take_action = True
                if exists_remote:
                    if exists_policy == "skip":
                        take_action = False
                        skipped_count += 1
                    elif exists_policy == "fail":
                        logging.error(f"Exists policy fail: {repo_id}:{repo_path} already exists")
                        exists_fail_hits += 1
                        take_action = False
                    elif exists_policy == "overwrite":
                        take_action = True
                    else:
                        take_action = False

                    if take_action and use_checksum and not dry_run and client is not None:
                        sha256 = compute_sha256(str(f))
                        if remote_blob_matches(client, repo_id, repo_type, repo_path, sha256):
                            take_action = False
                            skipped_count += 1
                            logging.info(f"Identical content, skipping: {repo_id}:{repo_path}")

                if take_action:
                    plans[plan_idx]["files"].append((str(f), repo_path, size, sha256))
                    delete_tracker[str(f)]["planned"] += 1

    totals = {
        "bytes_planned": sum(sz for p in plans for (_, _, sz, _) in p["files"]),
        "files_planned": sum(1 for p in plans for _ in p["files"]),
        "destinations": len(plans),
        "skipped_planned": skipped_count,
        "exists_fail_hits": exists_fail_hits,
    }

    return plans, {"delete_tracker": delete_tracker, "totals": totals}

# ------------- Execution -------------

def execute_plans(plans: List[Dict[str, Any]], cfg: Dict[str, Any]) -> Dict[str, Any]:
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

    def _commit_for_plan(plan: Dict[str, Any]) -> Tuple[bool, Dict[str, Any]]:
        repo_id = plan["repo_id"]
        repo_type = plan["repo_type"]
        token = plan["token"]
        create_pr = plan["create_pr"]
        commit_tpl = plan["commit_message_tpl"]
        files = plan["files"]
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

    if remove_after:
        for local_path, counters in delete_tracker.items():
            if counters["planned"] > 0 and counters["succeeded"] == counters["planned"] and local_path not in failed_files:
                try:
                    os.remove(local_path)
                    logging.info(f"Removed local file: {local_path}")
                except Exception as e:
                    logging.warning(f"Failed to remove {local_path}: {e}")

    return results

# ------------- CLI -------------

def main(argv: Optional[List[str]] = None) -> int:
    ap = argparse.ArgumentParser(description="Batch upload files to Hugging Face repos with multi-destination support.")
    ap.add_argument("--configurations", required=True, help="Path to configuration JSON")
    ap.add_argument("--repository", default=None, help="Override top-level repository")
    ap.add_argument("--token_file", default=None, help="Override top-level token_file")
    ap.add_argument("--token_env", default=None, help="Override top-level token_env")
    ap.add_argument("--source_base", default=None, help="Override top-level source_base (new)")
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

    # exists=fail guard
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
    results = execute_plans(plans, cfg)

    # Summary
    summary = {
        "uploaded_files": results["uploaded"],
        "failed_destinations": results["failed"],
        "bytes_uploaded": results["bytes_uploaded"],
        "planned_files": totals["files_planned"],
        "planned_bytes": totals["bytes_planned"],
        "skipped_planned": totals.get("skipped_planned", 0),
    }
    print(json.dumps(summary, indent=2))

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

    return 0

if __name__ == "__main__":
    sys.exit(main())