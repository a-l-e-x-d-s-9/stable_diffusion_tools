#!/usr/bin/env python3
import argparse
import os
import re
import sys
from pathlib import Path
from typing import Dict, Set, Tuple, List, DefaultDict
from collections import defaultdict


# Your requested simple extractor: captures only basename "file.safetensors"
BASENAME_RE = re.compile(r'[\/"]([^\/"]+\.safetensors)', re.IGNORECASE)

# Optional: capture a repo/local relative path when present (keeps nested folders)
RESOLVE_PATH_RE = re.compile(
    r"/resolve/[^/\s\"]+/(?P<path>[^\"\s]+?\.safetensors)",
    re.IGNORECASE,
)

# Optional: reconstruct nested folder from wget -P "folder"
WGET_P_RE = re.compile(r'-P\s+"([^"]+)"')


def normalize_relpath(p: str) -> str:
    p = p.replace("\\", "/").strip()
    p = p.lstrip("./")
    p = p.lstrip("/")  # prevent absolute
    return p


def extract_targets_from_text(text: str) -> Tuple[Set[str], Set[str]]:
    """
    Returns:
      - relpaths: possible relative paths like "FolderA/x.safetensors"
      - basenames: filenames only like "x.safetensors"
    No assumptions about Hugging Face correctness.
    """
    relpaths: Set[str] = set()
    basenames: Set[str] = set()

    # 1) If resolve-style path exists, capture it
    for m in RESOLVE_PATH_RE.finditer(text):
        p = normalize_relpath(m.group("path"))
        if p.lower().endswith(".safetensors"):
            relpaths.add(p)

    # 2) Basename extraction (your regex)
    for m in BASENAME_RE.finditer(text):
        bn = m.group(1).strip()
        if bn.lower().endswith(".safetensors"):
            basenames.add(bn)

    # 3) Reconstruct relpaths using wget -P "folder" + basename on same line
    for line in text.splitlines():
        pm = WGET_P_RE.search(line)
        if not pm:
            continue
        folder = normalize_relpath(pm.group(1).strip())
        if not folder:
            continue
        for m in BASENAME_RE.finditer(line):
            bn = m.group(1).strip()
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


def scan_local_safetensors(root_dir: str) -> Tuple[Dict[str, str], Dict[str, List[str]], int]:
    """
    Returns:
      - relpath_posix -> abs_path
      - basename -> list of relpaths (for ambiguity detection)
      - skipped_symlink_files_count
    Notes:
      - os.walk(..., followlinks=False) means we do not traverse symlinked dirs.
      - We also skip symlinked .safetensors files.
    """
    root = Path(root_dir).expanduser().resolve()
    if not root.exists():
        raise RuntimeError(f"Root folder does not exist: {root}")
    if not root.is_dir():
        raise RuntimeError(f"Root is not a folder: {root}")

    rel_to_abs: Dict[str, str] = {}
    base_to_rels: DefaultDict[str, List[str]] = defaultdict(list)
    skipped_symlink_files = 0

    for dirpath, dirnames, filenames in os.walk(str(root), topdown=True, followlinks=False):
        # prune symlinked dirs explicitly (extra safety/clarity)
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
                skipped_symlink_files += 1
                continue

            rel = os.path.relpath(full_f, str(root))
            rel_posix = Path(rel).as_posix().lstrip("./")

            if rel_posix not in rel_to_abs:
                rel_to_abs[rel_posix] = full_f
                base_to_rels[Path(rel_posix).name].append(rel_posix)

    return rel_to_abs, dict(base_to_rels), skipped_symlink_files


def delete_files(abs_paths: List[str], dry_run: bool) -> Tuple[int, List[Tuple[str, str]]]:
    deleted = 0
    errors: List[Tuple[str, str]] = []
    for p in abs_paths:
        try:
            if not dry_run:
                os.remove(p)
            deleted += 1
        except Exception as e:
            errors.append((p, str(e)))
    return deleted, errors


def main() -> int:
    ap = argparse.ArgumentParser(
        description="Delete local .safetensors referenced in a messy text file (regex-based). Only reports local results."
    )
    ap.add_argument("--root", required=True, help="Local root folder to scan (recursive, no symlink traversal)")
    ap.add_argument("--text", required=True, help="Text file to parse (e.g. the commented wget script output)")
    ap.add_argument("--dry-run", action="store_true", help="Do not delete, only report what would be deleted")
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
    target_relpaths, target_basenames = extract_targets_from_text(text)

    if not target_relpaths and not target_basenames:
        print("ERROR: did not find any .safetensors references in the text file.", file=sys.stderr)
        return 3

    local_rel_to_abs, local_base_to_rels, skipped_symlink_files = scan_local_safetensors(str(root))
    local_rel_set = set(local_rel_to_abs.keys())

    # Decide what to delete
    to_delete_rel: Set[str] = set()

    # 1) Prefer exact relpath match (preserves folder structure)
    to_delete_rel.update(local_rel_set.intersection(target_relpaths))

    # 2) Basename match only when safe (or if forced)
    ambiguous_skipped: Dict[str, List[str]] = {}
    for bn in target_basenames:
        rels = local_base_to_rels.get(bn, [])
        if not rels:
            continue

        uncovered = [r for r in rels if r not in to_delete_rel]
        if not uncovered:
            continue

        if len(uncovered) == 1:
            to_delete_rel.add(uncovered[0])
        else:
            if args.allow_ambiguous_basenames:
                for r in uncovered:
                    to_delete_rel.add(r)
            else:
                ambiguous_skipped[bn] = uncovered

    delete_rel_sorted = sorted(to_delete_rel)
    delete_abs_sorted = [local_rel_to_abs[r] for r in delete_rel_sorted]

    deleted_count, errors = delete_files(delete_abs_sorted, dry_run=args.dry_run)

    # Local files that remain
    not_deleted_rel = sorted(local_rel_set.difference(to_delete_rel))

    # Report (local only)
    print("")
    print("Summary")
    print("-------")
    print(f"Root: {Path(args.root).expanduser().resolve()}")
    print(f"Local .safetensors found (non-symlink): {len(local_rel_to_abs)}")
    if skipped_symlink_files:
        print(f"Skipped symlinked local .safetensors (never deleted): {skipped_symlink_files}")
    if args.dry_run:
        print(f"Would delete: {len(delete_abs_sorted)}")
    else:
        print(f"Deleted: {deleted_count}")
    if errors:
        print(f"Delete errors: {len(errors)}")
    if ambiguous_skipped and not args.allow_ambiguous_basenames:
        print(f"Ambiguous basenames skipped: {len(ambiguous_skipped)}")

    print("")
    if args.dry_run:
        print("Would delete local safetensors (full paths):")
        print("-----------------------------------------")
    else:
        print("Deleted local safetensors (full paths):")
        print("-------------------------------------")
    if delete_abs_sorted:
        for p in delete_abs_sorted:
            print(p)
    else:
        print("(none)")

    print("")
    print("Not deleted local safetensors (full paths):")
    print("----------------------------------------")
    if not_deleted_rel:
        for r in not_deleted_rel:
            print(local_rel_to_abs[r])
    else:
        print("(none)")

    if ambiguous_skipped and not args.allow_ambiguous_basenames:
        print("")
        print("Ambiguous basenames (not deleted). Use --allow-ambiguous-basenames to delete all matches:")
        print("--------------------------------------------------------------------------------------")
        for bn, rels in sorted(ambiguous_skipped.items(), key=lambda x: x[0].lower()):
            print(f"{bn}:")
            for r in rels:
                print(f"  {local_rel_to_abs[r]}")

    if errors:
        print("")
        print("Delete errors (path -> error):")
        print("-----------------------------")
        for p, e in errors:
            print(f"{p} -> {e}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
