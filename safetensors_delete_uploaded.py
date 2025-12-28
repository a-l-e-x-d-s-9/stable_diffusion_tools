#!/usr/bin/env python3
import argparse
import os
import re
import sys
from pathlib import Path
from typing import Dict, Set, Tuple, List, DefaultDict
from collections import defaultdict


# Your simple basename extractor (captures only "file.safetensors")
BASENAME_RE = re.compile(r'[\/"]([^\/"]+\.safetensors)', re.IGNORECASE)

# Optional: if a Hugging Face-like path exists, capture the repo-relative path (keeps nested folders)
RESOLVE_PATH_RE = re.compile(
    r"/resolve/[^/\s\"]+/(?P<path>[^\"\s]+?\.safetensors)",
    re.IGNORECASE,
)

# Optional: reconstruct nested folder from wget -P "folder"
WGET_P_RE = re.compile(r'-P\s+"([^"]+)"')


def normalize_relpath(p: str) -> str:
    p = p.replace("\\", "/").strip()
    p = p.lstrip("./")
    # Do not allow absolute paths
    p = p.lstrip("/")
    return p


def extract_safetensors_targets(text: str) -> Tuple[Set[str], Set[str]]:
    """
    Returns:
      - relpaths: possible repo/local relative paths like "FolderA/x.safetensors"
      - basenames: filenames only like "x.safetensors"
    We do not assume the text is clean or HF-valid.
    """
    relpaths: Set[str] = set()
    basenames: Set[str] = set()

    # 1) Capture any resolve-style repo path if present
    for m in RESOLVE_PATH_RE.finditer(text):
        p = normalize_relpath(m.group("path"))
        if p.lower().endswith(".safetensors"):
            relpaths.add(p)

    # 2) Capture basenames using your regex
    for m in BASENAME_RE.finditer(text):
        bn = m.group(1).strip()
        if bn.lower().endswith(".safetensors"):
            basenames.add(bn)

    # 3) Reconstruct relpaths from lines like:
    #    #wget ... -P "Five_Stars_6.0" "....../Five_Stars_6.0.safetensors"
    for line in text.splitlines():
        pm = WGET_P_RE.search(line)
        if not pm:
            continue
        folder = pm.group(1).strip()
        if not folder:
            continue
        folder = normalize_relpath(folder)
        # Find basenames on that same line (your regex)
        line_bns = [m.group(1).strip() for m in BASENAME_RE.finditer(line)]
        for bn in line_bns:
            if not bn.lower().endswith(".safetensors"):
                continue
            if folder in (".", ""):
                rel = normalize_relpath(bn)
            else:
                rel = normalize_relpath(f"{folder}/{bn}")
            relpaths.add(rel)

    return relpaths, basenames


def is_symlink(path: str) -> bool:
    try:
        return os.path.islink(path)
    except OSError:
        return False


def scan_local_safetensors(root_dir: str) -> Tuple[Dict[str, str], Dict[str, List[str]], List[str]]:
    """
    Returns:
      - relpath_posix -> abs_path
      - basename -> list of relpaths (for ambiguity detection)
      - skipped_symlinks: list of symlinked .safetensors abs paths that were skipped
    """
    root = Path(root_dir).expanduser().resolve()
    if not root.exists():
        raise RuntimeError(f"Root folder does not exist: {root}")
    if not root.is_dir():
        raise RuntimeError(f"Root is not a folder: {root}")

    rel_to_abs: Dict[str, str] = {}
    base_to_rels: DefaultDict[str, List[str]] = defaultdict(list)
    skipped_symlinks: List[str] = []

    for dirpath, dirnames, filenames in os.walk(str(root), topdown=True, followlinks=False):
        # prune symlinked dirs explicitly
        pruned = []
        for d in dirnames:
            full_d = os.path.join(dirpath, d)
            if is_symlink(full_d):
                continue
            pruned.append(d)
        dirnames[:] = pruned

        for fn in filenames:
            if not fn.lower().endswith(".safetensors"):
                continue
            full_f = os.path.join(dirpath, fn)

            # skip symlinked files (do not delete through links)
            if is_symlink(full_f):
                skipped_symlinks.append(full_f)
                continue

            rel = os.path.relpath(full_f, str(root))
            rel_posix = Path(rel).as_posix().lstrip("./")

            if rel_posix not in rel_to_abs:
                rel_to_abs[rel_posix] = full_f
                base_to_rels[Path(rel_posix).name].append(rel_posix)

    return rel_to_abs, dict(base_to_rels), skipped_symlinks


def delete_files(abs_paths: List[str], dry_run: bool) -> Tuple[int, List[Tuple[str, str]]]:
    deleted = 0
    errors: List[Tuple[str, str]] = []
    for p in abs_paths:
        try:
            if not dry_run:
                os.remove(p)
            deleted += 1 if not dry_run else 0
        except Exception as e:
            errors.append((p, str(e)))
    return deleted, errors


def main() -> int:
    ap = argparse.ArgumentParser(
        description="Delete local .safetensors that are referenced in a messy text file (regex-based; no symlink traversal)."
    )
    ap.add_argument("--root", required=True, help="Local root folder to scan (recursive, followlinks=False)")
    ap.add_argument("--text", required=True, help="Text file to parse (e.g. the commented wget script output)")
    ap.add_argument("--dry-run", action="store_true", help="Do not delete, just report")
    ap.add_argument(
        "--allow-ambiguous-basenames",
        action="store_true",
        help="If a basename matches multiple local files, delete all of them (default: skip ambiguous).",
    )
    args = ap.parse_args()

    root = Path(args.root).expanduser()
    text_path = Path(args.text).expanduser()

    if not text_path.exists():
        print(f"ERROR: text file not found: {text_path}", file=sys.stderr)
        return 2

    text = text_path.read_text(encoding="utf-8", errors="replace")
    target_relpaths, target_basenames = extract_safetensors_targets(text)

    if not target_relpaths and not target_basenames:
        print("ERROR: did not find any .safetensors references in the text file.", file=sys.stderr)
        return 3

    local_rel_to_abs, local_base_to_rels, skipped_symlinks = scan_local_safetensors(str(root))
    local_rel_set = set(local_rel_to_abs.keys())

    # 1) Exact relpath deletes (preferred, preserves nested folders)
    relpath_matches = sorted(local_rel_set.intersection(target_relpaths))
    to_delete_rel: Set[str] = set(relpath_matches)

    # 2) Basename-based deletes (only if not already covered by relpath match)
    ambiguous_basenames: Dict[str, List[str]] = {}
    basename_used: Set[str] = set()

    for bn in sorted(target_basenames):
        rels = local_base_to_rels.get(bn, [])
        if not rels:
            continue
        # If exact relpath match already covers them, skip
        uncovered = [r for r in rels if r not in to_delete_rel]
        if not uncovered:
            continue

        if len(uncovered) == 1:
            to_delete_rel.add(uncovered[0])
            basename_used.add(bn)
        else:
            ambiguous_basenames[bn] = uncovered
            if args.allow_ambiguous_basenames:
                for r in uncovered:
                    to_delete_rel.add(r)
                basename_used.add(bn)

    delete_abs = [local_rel_to_abs[r] for r in sorted(to_delete_rel)]
    deleted_count, errors = delete_files(delete_abs, dry_run=args.dry_run)

    # Not deleted local safetensors (print full paths)
    not_deleted_rel = sorted(local_rel_set.difference(to_delete_rel))

    # Optional: targets referenced in text but not found locally
    missing_local_rel = sorted(target_relpaths.difference(local_rel_set))

    # Report
    root_resolved = Path(args.root).expanduser().resolve()
    print("")
    print("Summary")
    print("-------")
    print(f"Root: {root_resolved}")
    print(f"Targets extracted: relpaths={len(target_relpaths)} basenames={len(target_basenames)}")
    print(f"Local .safetensors found (non-symlink): {len(local_rel_to_abs)}")
    if skipped_symlinks:
        print(f"Skipped symlinked local .safetensors: {len(skipped_symlinks)}")
    print(f"Would delete: {len(delete_abs)}")
    if args.dry_run:
        print("Deleted: 0 (dry-run)")
    else:
        print(f"Deleted: {deleted_count}")
    if errors:
        print(f"Delete errors: {len(errors)}")
    if ambiguous_basenames and not args.allow_ambiguous_basenames:
        print(f"Ambiguous basenames skipped: {len(ambiguous_basenames)}")
    if missing_local_rel:
        print(f"Referenced relpaths not found locally: {len(missing_local_rel)}")

    print("")
    print("Not deleted local safetensors (full paths):")
    print("----------------------------------------")
    if not_deleted_rel:
        for r in not_deleted_rel:
            print(local_rel_to_abs[r])
    else:
        print("(none)")

    if ambiguous_basenames and not args.allow_ambiguous_basenames:
        print("")
        print("Ambiguous basenames (not deleted). Use --allow-ambiguous-basenames to delete all matches:")
        print("--------------------------------------------------------------------------------------")
        for bn, rels in sorted(ambiguous_basenames.items(), key=lambda x: x[0].lower()):
            print(f"{bn}:")
            for r in rels:
                print(f"  {local_rel_to_abs[r]}")

    if errors:
        print("")
        print("Delete errors (path -> error):")
        print("-----------------------------")
        for p, e in errors:
            print(f"{p} -> {e}")

    if skipped_symlinks:
        print("")
        print("Skipped symlinked safetensors (not deleted):")
        print("------------------------------------------")
        for p in sorted(skipped_symlinks):
            print(p)

    if missing_local_rel:
        print("")
        print("Referenced relpaths not found locally (maybe already deleted/moved):")
        print("-------------------------------------------------------------------")
        for p in missing_local_rel:
            print(p)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
