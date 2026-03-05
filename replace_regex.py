#!/usr/bin/env python3
import argparse
import os
import re
import sys
from pathlib import Path
from tempfile import NamedTemporaryFile

TEXT_EXT_DEFAULT = [
    ".py", ".js", ".ts", ".tsx", ".json", ".yaml", ".yml", ".toml",
    ".md", ".txt", ".html", ".css", ".scss", ".sh", ".ini", ".cfg"
]

def looks_binary(sample: bytes) -> bool:
    # Heuristic: NUL byte usually means binary
    return b"\x00" in sample

def iter_files(root: Path, includes, excludes, exts, follow_symlinks: bool):
    for p in root.rglob("*"):
        try:
            if not follow_symlinks and p.is_symlink():
                continue
            if not p.is_file():
                continue
        except OSError:
            continue

        rel = str(p)
        if excludes and any(p.match(x) or rel.endswith(x) for x in excludes):
            continue

        if includes:
            ok = any(p.match(x) or rel.endswith(x) for x in includes)
            if not ok:
                continue
        elif exts:
            if p.suffix not in exts:
                continue

        yield p

def atomic_write(path: Path, new_text: str, encoding: str):
    # Write to temp file in same dir, then replace
    with NamedTemporaryFile("w", delete=False, dir=str(path.parent), encoding=encoding, newline="") as tf:
        tf.write(new_text)
        tmp_name = tf.name
    os.replace(tmp_name, str(path))

def main():
    ap = argparse.ArgumentParser(description="Regex replace across many files safely.")
    ap.add_argument("--root", required=True, help="Root folder to scan")
    ap.add_argument("--regex", required=True, help="Regex pattern")
    ap.add_argument("--repl", required=True, help="Replacement (supports backrefs like \\1)")
    ap.add_argument("--include", action="append", default=[], help="Include glob (repeatable), ex: '*.py'")
    ap.add_argument("--exclude", action="append", default=[], help="Exclude glob or suffix (repeatable)")
    ap.add_argument("--ext", action="append", default=[], help="File extensions to include (repeatable), ex: .py")
    ap.add_argument("--encoding", default="utf-8", help="File encoding (default: utf-8)")
    ap.add_argument("--dry-run", action="store_true", help="Do not write changes, just report")
    ap.add_argument("--backup-ext", default="", help="If set, write backup copy with this extension, ex: .bak")
    ap.add_argument("--follow-symlinks", action="store_true", help="Follow symlinks")
    ap.add_argument("--count-only", action="store_true", help="Only count matches, no replacement")
    ap.add_argument("--multiline", action="store_true", help="re.MULTILINE")
    ap.add_argument("--dotall", action="store_true", help="re.DOTALL")
    args = ap.parse_args()

    root = Path(args.root).expanduser().resolve()
    if not root.exists():
        print(f"ERROR: root does not exist: {root}", file=sys.stderr)
        return 2

    flags = 0
    if args.multiline:
        flags |= re.MULTILINE
    if args.dotall:
        flags |= re.DOTALL

    rx = re.compile(args.regex, flags)

    exts = args.ext[:] if args.ext else TEXT_EXT_DEFAULT
    changed_files = 0
    total_repls = 0

    for path in iter_files(root, args.include, args.exclude, exts, args.follow_symlinks):
        try:
            with open(path, "rb") as f:
                sample = f.read(4096)
                if looks_binary(sample):
                    continue
        except OSError:
            continue

        try:
            text = path.read_text(encoding=args.encoding)
        except UnicodeDecodeError:
            # Skip files that are not this encoding
            continue
        except OSError:
            continue

        if args.count_only:
            n = len(rx.findall(text))
            if n:
                print(f"{path}: {n}")
                total_repls += n
            continue

        new_text, n = rx.subn(args.repl, text)
        if n == 0:
            continue

        total_repls += n
        changed_files += 1
        print(f"{path}: replacements={n}")

        if args.dry_run:
            continue

        try:
            if args.backup_ext:
                backup_path = Path(str(path) + args.backup_ext)
                if not backup_path.exists():
                    backup_path.write_text(text, encoding=args.encoding)
            atomic_write(path, new_text, args.encoding)
        except OSError as e:
            print(f"ERROR writing {path}: {e}", file=sys.stderr)

    if args.count_only:
        print(f"Total matches: {total_repls}")
    else:
        print(f"Changed files: {changed_files}, total replacements: {total_repls}")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())