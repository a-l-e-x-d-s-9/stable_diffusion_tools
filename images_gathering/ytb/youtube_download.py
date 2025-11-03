#!/usr/bin/env python3
import argparse
import concurrent.futures as futures
import os
import sys
from pathlib import Path
from typing import List

# Import here so the error is clear if missing
try:
    import yt_dlp
except ImportError:
    print("Missing dependency: yt-dlp. Install with: pip install yt-dlp", file=sys.stderr)
    sys.exit(1)


def read_urls(batch_file: Path) -> List[str]:
    urls = []
    with batch_file.open("r", encoding="utf-8") as f:
        for line in f:
            s = line.strip()
            if not s or s.startswith("#"):
                continue
            urls.append(s)
    return urls


def progress_hook(d):
    if d.get("status") == "downloading":
        p = d.get("_percent_str") or ""
        sp = d.get("_speed_str") or ""
        eta = d.get("_eta_str") or ""
        line = f"[downloading] {p} at {sp} ETA {eta}"
        # one-line updating
        print(line, end="\r", flush=True)
    elif d.get("status") == "finished":
        print(" " * 80, end="\r")  # clear line
        print(f"[finished] {d.get('filename','output')}")


def make_ydl_opts(outdir: Path, fmt: str, rate_limit: str, cookies: Path, write_subs: bool, write_auto_subs: bool):
    ydl_opts = {
        "format": fmt,
        "outtmpl": str(outdir / "%(title).200s [%(id)s].%(ext)s"),
        "restrictfilenames": True,
        "noprogress": False,
        "progress_hooks": [progress_hook],
        "concurrent_fragment_downloads": 5,  # faster on large videos
        "ignoreerrors": True,               # continue on errors
        "retries": 5,
        "fragment_retries": 5,
        "continuedl": True,                 # resume partial
        "nopart": False,                    # keep .part for resume
        "quiet": False,
        "no_warnings": True,
    }
    if rate_limit:
        ydl_opts["ratelimit"] = rate_limit
    if cookies and cookies.exists():
        ydl_opts["cookiefile"] = str(cookies)
    if write_subs:
        ydl_opts["writesubtitles"] = True
        ydl_opts["subtitleslangs"] = ["en.*,.*"]  # try English if available, else any
        ydl_opts["subtitlesformat"] = "best"
    if write_auto_subs:
        ydl_opts["writeautomaticsub"] = True
    return ydl_opts


def download_one(url: str, ydl_opts) -> tuple[str, bool, str]:
    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            # Extract only to determine title/id for better logging
            info = ydl.extract_info(url, download=True)
            if info is None:
                return (url, False, "extract_info returned None")
            # Playlists return a dict with entries
            if "entries" in info and info["entries"] is not None:
                # Playlist handled by yt-dlp; success if at least one entry ok
                return (url, True, "playlist processed")
            return (url, True, "ok")
    except Exception as e:
        return (url, False, str(e))


def main():
    parser = argparse.ArgumentParser(
        description="Download YouTube videos listed line-by-line in a text file."
    )
    parser.add_argument("batch_file", help="Path to txt file with one URL per line")
    parser.add_argument(
        "-o", "--outdir", default="yt_downloads",
        help="Output directory (default: yt_downloads)"
    )
    parser.add_argument(
        "-f", "--format",
        default="bv*+ba/best",
        help="yt-dlp format selector (default: bv*+ba/best). Example for mp4: bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]"
    )
    parser.add_argument(
        "-w", "--workers", type=int, default=1,
        help="Concurrent downloads (default: 1). Increase with care."
    )
    parser.add_argument(
        "--rate-limit", default="",
        help="Limit download speed, e.g. 2M or 800K (default: unlimited)"
    )
    parser.add_argument(
        "--cookies", default="",
        help="Path to cookies.txt for age/region-locked videos (optional)"
    )
    parser.add_argument(
        "--subs", action="store_true",
        help="Download available subtitles"
    )
    parser.add_argument(
        "--autosubs", action="store_true",
        help="Download auto-generated subtitles when available"
    )

    parser.add_argument(
        "--cookies-browser",
        choices=["chrome", "chromium", "brave", "edge", "firefox", "safari", "vivaldi", "opera", "opera-gx"],
        help="Load cookies directly from a browser profile"
    )
    parser.add_argument(
        "--cookies-profile", default=None,
        help="Browser profile name to use with --cookies-browser (e.g. 'Default', 'Profile 1')"
    )

    args = parser.parse_args()

    batch_file = Path(args.batch_file).expanduser()
    if not batch_file.exists():
        print(f"Input file not found: {batch_file}", file=sys.stderr)
        sys.exit(2)

    outdir = Path(args.outdir).expanduser()
    outdir.mkdir(parents=True, exist_ok=True)

    urls = read_urls(batch_file)
    if not urls:
        print("No URLs found in the input file.", file=sys.stderr)
        sys.exit(3)

    cookies = Path(args.cookies).expanduser() if args.cookies else None
    ydl_opts = make_ydl_opts(outdir, args.format, args.rate_limit, cookies, args.subs, args.autosubs)

    if args.cookies_browser:
        # Let yt-dlp read cookies from your local browser securely
        # Tuple can include browser and optional profile
        if args.cookies_profile:
            ydl_opts["cookiesfrombrowser"] = (args.cookies_browser, args.cookies_profile)
        else:
            ydl_opts["cookiesfrombrowser"] = (args.cookies_browser,)

        ydl_opts["cookiefile"] = None  # ignore file if both given


    print(f"Found {len(urls)} URL(s). Downloading to: {outdir}")

    results = []
    if args.workers <= 1:
        for u in urls:
            print(f"\n==> {u}")
            results.append(download_one(u, ydl_opts))
    else:
        # Parallel downloads: separate yt-dlp instances per URL
        # Note: heavy concurrency can trigger rate limits
        with futures.ThreadPoolExecutor(max_workers=args.workers) as ex:
            futs = []
            for u in urls:
                print(f"\n==> queued {u}")
                futs.append(ex.submit(download_one, u, ydl_opts))
            for ft in futures.as_completed(futs):
                results.append(ft.result())

    ok = sum(1 for _, success, _ in results if success)
    fail = len(results) - ok

    print("\nSummary:")
    print(f"- Success: {ok}")
    print(f"- Failed:  {fail}")
    if fail:
        print("\nFailures:")
        for url, success, err in results:
            if not success:
                print(f"- {url} -> {err}")


if __name__ == "__main__":
    main()
