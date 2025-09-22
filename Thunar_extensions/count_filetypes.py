#!/usr/bin/env python3
import argparse
import os
import sys
from pathlib import Path
from collections import Counter

IMAGE_EXTS = {
    "jpg","jpeg","png","webp","gif","bmp","tif","tiff","heic","heif","avif","svg","ico","jfif","pjpeg","pjp",
    # common RAW formats
    "dng","cr2","cr3","nef","arw","orf","rw2","raf","sr2","pef","mrw","kdc","x3f","rwl","srw"
}

def parse_args():
    p = argparse.ArgumentParser(
        description="Count how many files of every type exist under given paths (recursive)."
    )
    p.add_argument("paths", nargs="+", help="One or more files or directories. In Thunar use %F to pass multiple.")
    p.add_argument("--exclude-hidden", action="store_true", help="Skip hidden files and hidden directories.")
    p.add_argument("--follow-symlinks", action="store_true", help="Follow directory symlinks during the walk.")
    p.add_argument("--no-gui", action="store_true", help="Print to stdout instead of GUI popup.")
    p.add_argument(
        "--ext-mode",
        choices=["last", "full"],
        default="last",
        help="How to determine extension: 'last' = last suffix only (default), 'full' = join all suffixes like .tar.gz."
    )
    return p.parse_args()

def is_hidden(path: Path) -> bool:
    name = path.name
    return name.startswith(".") and name not in (".", "..")

def get_extension(p: Path, mode: str) -> str:
    """
    mode='last': use only the last suffix (preferred for grouping .json, .webp, etc.)
    mode='full': join all suffixes (e.g., .tar.gz)
    Special case: when mode='last', still recognize .tar.<comp> as a pair.
    """
    name = p.name
    suffixes = [s.lower() for s in p.suffixes]  # includes the dot, e.g. ['.tar', '.gz']
    if not suffixes:
        return ""
    # Treat dotfiles like .bashrc as no extension
    if name.startswith(".") and name.count(".") == 1:
        return ""

    if mode == "full":
        return "".join(suffixes)

    # mode == 'last'
    if len(suffixes) >= 2 and suffixes[-2] == ".tar" and suffixes[-1] in {".gz", ".bz2", ".xz", ".zst", ".lz", ".lzma", ".lz4"}:
        return ".tar" + suffixes[-1]
    return suffixes[-1]

def iter_files(root: Path, exclude_hidden: bool, follow_symlinks: bool):
    if root.is_file():
        if not exclude_hidden or not is_hidden(root):
            yield root
        return

    def walk(d: Path):
        try:
            with os.scandir(d) as it:
                for entry in it:
                    try:
                        p = Path(entry.path)
                        if exclude_hidden and is_hidden(p):
                            continue
                        if entry.is_file(follow_symlinks=False):
                            yield p
                        elif entry.is_dir(follow_symlinks=follow_symlinks):
                            yield from walk(p)
                    except (PermissionError, FileNotFoundError):
                        continue
        except (PermissionError, FileNotFoundError):
            return

    if root.is_dir():
        yield from walk(root)

def sanitize_path(s: str) -> Path:
    s = s.strip()
    if s.startswith("file://"):
        s = s[len("file://"):]
    return Path(s).expanduser()

def build_table(rows3, roots, total, images_total=None, images_pct=None):
    lines = []
    lines.append("File type counts")
    if len(roots) == 1:
        lines.append(f"Root: {roots[0]}")
    else:
        lines.append("Roots:")
        for r in roots:
            lines.append(f"  - {r}")
    lines.append(f"Total files: {total}")
    if images_total is not None:
        lines.append(f"Images (all, no video): {images_total} ({images_pct:.2f}%)")
    lines.append("")

    type_w = max(12, max((len(t) for t, _, _ in rows3), default=12))
    lines.append(f"{'Type'.ljust(type_w)}  {'Count'.rjust(10)}  {'Percent'.rjust(8)}")
    lines.append(f"{'-'*type_w}  {'-'*10}  {'-'*8}")
    for t, c, pct in rows3:
        lines.append(f"{t.ljust(type_w)}  {str(c).rjust(10)}  {format(pct, '.2f').rjust(8)}")
    return "\n".join(lines)

def show_gui(text, rows_for_csv):
    try:
        import tkinter as tk
        from tkinter import ttk, filedialog, messagebox
        import csv
    except Exception:
        print(text)
        print("\nNote: GUI requires python3-tk. Install with: sudo apt install python3-tk")
        return

    root = tk.Tk()
    root.title("File type counts")
    root.geometry("720x520+120+120")
    try:
        root.attributes("-topmost", True)
    except Exception:
        pass

    main = ttk.Frame(root, padding=8)
    main.pack(fill="both", expand=True)

    txt = tk.Text(main, wrap="none")
    try:
        txt.configure(font=("Courier New", 10))
    except Exception:
        pass

    yscroll = ttk.Scrollbar(main, orient="vertical", command=txt.yview)
    xscroll = ttk.Scrollbar(main, orient="horizontal", command=txt.xview)
    txt.configure(yscrollcommand=yscroll.set, xscrollcommand=xscroll.set)

    txt.grid(row=0, column=0, sticky="nsew")
    yscroll.grid(row=0, column=1, sticky="ns")
    xscroll.grid(row=1, column=0, sticky="ew")

    main.rowconfigure(0, weight=1)
    main.columnconfigure(0, weight=1)

    txt.insert("1.0", text)
    txt.configure(state="disabled")

    btns = ttk.Frame(main)
    btns.grid(row=2, column=0, columnspan=2, sticky="ew", pady=(8, 0))
    btns.columnconfigure(0, weight=1)
    btns.columnconfigure(1, weight=1)
    btns.columnconfigure(2, weight=1)

    def do_copy():
        try:
            root.clipboard_clear()
            root.clipboard_append(text)
            messagebox.showinfo("Copied", "Results copied to clipboard.")
        except Exception:
            pass

    def do_save_csv():
        if not rows_for_csv:
            messagebox.showwarning("No data", "No rows to save.")
            return
        path = filedialog.asksaveasfilename(defaultextension=".csv", initialfile="filetype_counts.csv")
        if not path:
            return
        try:
            with open(path, "w", newline="", encoding="utf-8") as fh:
                w = csv.writer(fh)
                w.writerow(["type", "count", "percent"])
                for t, c, pct in rows_for_csv:
                    w.writerow([t, c, f"{pct:.2f}"])
            messagebox.showinfo("Saved", f"CSV saved to:\n{path}")
        except Exception as e:
            messagebox.showerror("Error", f"Failed to save CSV:\n{e}")

    def do_close():
        root.destroy()

    ttk.Button(btns, text="Copy", command=do_copy).grid(row=0, column=0, sticky="ew", padx=4)
    ttk.Button(btns, text="Save CSV...", command=do_save_csv).grid(row=0, column=1, sticky="ew", padx=4)
    ttk.Button(btns, text="Close", command=do_close).grid(row=0, column=2, sticky="ew", padx=4)

    root.mainloop()

def main():
    args = parse_args()

    roots = []
    for raw in args.paths:
        p = sanitize_path(raw)
        if not p.exists():
            print(f"Warning: path does not exist: {p}", file=sys.stderr)
            continue
        roots.append(p)

    counters = Counter()
    total = 0
    for r in roots:
        for f in iter_files(r, exclude_hidden=args.exclude_hidden, follow_symlinks=args.follow_symlinks):
            total += 1
            ext = get_extension(f, args.ext_mode)
            key = "(no extension)" if ext == "" else ext
            counters[key] += 1

    # Add after counters/total are computed
    images_total = sum(
        c for ext, c in counters.items()
        if ext and ext != "(no extension)" and ext.lstrip(".") in IMAGE_EXTS
    )
    images_pct = (images_total / total * 100.0) if total else 0.0

    rows_sorted = sorted(counters.items(), key=lambda kv: (-kv[1], kv[0]))
    rows_for_csv = [(t, c, (c / total * 100.0) if total else 0.0) for t, c in rows_sorted]
    table = build_table(rows_for_csv, roots, total, images_total, images_pct)

    if args.no_gui:
        print(table)
    else:
        show_gui(table, rows_for_csv)

if __name__ == "__main__":
    main()
