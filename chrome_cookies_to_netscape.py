#!/usr/bin/env python3
"""Convert cookies copied from Chrome DevTools into Netscape cookies.txt format.

Input formats:
  - Tab-separated rows copied from Application > Storage > Cookies
    (with or without a column-header row)
  - JSON cookie arrays exported/copied from DevTools or extensions
  - A Cookie: request header, or a plain `name=value; name2=value2` string

Usage:
  python3 chrome_cookies_to_netscape.py /path/to/cookies.txt
  python3 chrome_cookies_to_netscape.py /path/to/headers.txt --domain example.com

With no input argument, a file selection dialog opens if tkinter is available.
The output is written beside the input, with '_netscape' added to its name.
"""

import argparse
import csv
import io
import json
import os
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path


@dataclass
class Cookie:
    name: str
    value: str
    domain: str
    path: str = "/"
    secure: bool = False
    http_only: bool = False
    expires: int = 0
    host_only: bool | None = None


def flag(value):
    if isinstance(value, bool):
        return value
    return str(value or "").strip().lower() in {"true", "yes", "1", "✓", "✔", "☑", "checked"}


def expiry(value):
    if value is None or str(value).strip().lower() in {"", "session", "session cookie", "-1", "null", "none", "n/a"}:
        return 0
    if isinstance(value, (int, float)) or re.fullmatch(r"\d+(?:\.\d+)?", str(value).strip()):
        timestamp = float(value)
        if timestamp > 1e12:  # JavaScript epoch milliseconds
            timestamp /= 1000
        return int(timestamp)
    date_text = str(value).strip()
    try:
        parsed = datetime.fromisoformat(date_text.replace("Z", "+00:00"))
    except ValueError:
        try:
            parsed = parsedate_to_datetime(date_text)
        except (ValueError, TypeError) as exc:
            raise ValueError(f"Unrecognized cookie expiry: {date_text!r}") from exc
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return int(parsed.timestamp())


def field(entry, *keys, default=None):
    """Fetch a JSON field independently of capitalization and punctuation."""
    normalized = {re.sub(r"[^a-z0-9]", "", str(k).lower()): v for k, v in entry.items()}
    for key in keys:
        clean = re.sub(r"[^a-z0-9]", "", key.lower())
        if clean in normalized:
            return normalized[clean]
    return default


def from_entry(entry, default_domain):
    name = field(entry, "name")
    if name is None or name == "":
        return None
    domain = str(field(entry, "domain", default=default_domain) or default_domain or "").strip()
    if not domain:
        raise ValueError(f"Cookie {name!r} has no domain. Pass --domain example.com.")
    host_only = field(entry, "hostOnly")
    return Cookie(
        name=str(name),
        value=str(field(entry, "value", default="") or ""),
        domain=domain,
        path=str(field(entry, "path", default="/") or "/"),
        secure=flag(field(entry, "secure")),
        http_only=flag(field(entry, "httpOnly")),
        expires=expiry(field(entry, "expires", "expirationDate", "expiry", "expires/max-age", "expires / max-age")),
        host_only=flag(host_only) if host_only is not None else None,
    )


def from_json(data, default_domain):
    if isinstance(data, dict):
        if isinstance(data.get("cookies"), list):
            data = data["cookies"]
        elif isinstance(data.get("Cookies"), list):
            data = data["Cookies"]
        elif field(data, "name") is not None:
            data = [data]
        else:
            raise ValueError("JSON must contain a cookie array or a 'cookies' list.")
    if not isinstance(data, list):
        raise ValueError("JSON must be a list of cookie objects.")
    return [cookie for item in data if isinstance(item, dict)
            if (cookie := from_entry(item, default_domain)) is not None]


def from_tsv(text, default_domain):
    rows = [row for row in csv.reader(io.StringIO(text), delimiter="\t") if any(cell.strip() for cell in row)]
    if not rows:
        return []
    headings = [re.sub(r"[^a-z0-9]", "", c.strip().lower()) for c in rows[0]]
    has_header = "name" in headings and "value" in headings
    cookies = []
    for number, row in enumerate(rows[1:] if has_header else rows, start=2 if has_header else 1):
        if len(row) < 2:
            continue
        if has_header:
            entry = {key: row[i] for i, key in enumerate(headings) if key and i < len(row)}
        else:
            # Common Chrome DevTools Application > Cookies column order.
            columns = ["name", "value", "domain", "path", "expiresmaxage",
                       "size", "httponly", "secure", "samesite", "priority", "partitionkey"]
            entry = dict(zip(columns, row))
        try:
            cookie = from_entry(entry, default_domain)
        except ValueError as exc:
            raise ValueError(f"TSV row {number}: {exc}") from exc
        if cookie:
            cookies.append(cookie)
    return cookies


def from_header(text, default_domain):
    # Chrome's Network > Headers > Request Headers can contain many header lines.
    header_match = re.search(r"^\s*cookie\s*:\s*(.+)$", text, flags=re.I | re.M)
    if header_match:
        raw = header_match.group(1)
    else:
        raw = text.strip()
        if "\n" in raw:
            raise ValueError("No Cookie: header found. For cookie tables, copy as tab-separated rows.")
    domain = default_domain
    if not domain:
        authority = re.search(r"^\s*(?::authority|host)\s*:\s*([^\s]+)", text, re.I | re.M)
        if authority:
            domain = authority.group(1).split(":", 1)[0]
    if not domain:
        raise ValueError("Cookie header strings do not contain domain information. Pass --domain example.com.")

    cookies = []
    for part in raw.split(";"):
        if "=" not in part:
            continue
        name, value = part.strip().split("=", 1)
        if name:
            cookies.append(Cookie(name=name.strip(), value=value.strip(), domain=domain))
    return cookies


def convert(text, default_domain):
    stripped = text.lstrip("\ufeff \t\r\n")
    if stripped.startswith(("[", "{")):
        return from_json(json.loads(stripped), default_domain)
    if "\t" in text:
        return from_tsv(text, default_domain)
    return from_header(text, default_domain)


def to_netscape_line(cookie):
    domain = cookie.domain.strip()
    if domain.startswith("http://") or domain.startswith("https://"):
        from urllib.parse import urlsplit
        domain = urlsplit(domain).hostname or ""
    domain = domain.split(":", 1)[0]
    if not domain:
        raise ValueError(f"Invalid domain for {cookie.name!r}")
    include_subdomains = not cookie.host_only if cookie.host_only is not None else domain.startswith(".")
    if include_subdomains and not domain.startswith("."):
        domain = "." + domain
    if cookie.host_only:
        domain = domain.lstrip(".")
    if cookie.http_only:
        domain = "#HttpOnly_" + domain
    path = cookie.path if cookie.path.startswith("/") else "/" + cookie.path
    columns = [domain, "TRUE" if include_subdomains else "FALSE", path,
               "TRUE" if cookie.secure else "FALSE", str(cookie.expires),
               cookie.name, cookie.value]
    if any("\t" in item or "\n" in item or "\r" in item for item in columns):
        raise ValueError(f"Cookie {cookie.name!r} contains a tab or newline, which Netscape format cannot represent")
    return "\t".join(columns)


def pick_file():
    try:
        from tkinter import Tk, filedialog
        root = Tk()
        root.withdraw()
        filename = filedialog.askopenfilename(title="Select copied Chrome cookies file")
        root.destroy()
        return filename
    except Exception as exc:
        raise ValueError("Supply an input file path (file picker unavailable).") from exc


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("file", nargs="?", help="Text, TSV or JSON file containing Chrome cookies")
    parser.add_argument("--domain", help="Cookie domain (required for raw Cookie: headers without Host/:authority)")
    args = parser.parse_args()
    try:
        filename = args.file or pick_file()
        if not filename:
            parser.error("No input file selected")
        source = Path(filename).expanduser().resolve()
        contents = source.read_text(encoding="utf-8-sig")
        cookies = convert(contents, args.domain)
        if not cookies:
            raise ValueError("No cookies were detected in the input file")
        output = source.with_name(source.stem + "_netscape.txt")
        lines = ["# Netscape HTTP Cookie File", "# Converted locally from Chrome DevTools cookies", ""]
        lines.extend(to_netscape_line(cookie) for cookie in cookies)
        # Mode 0600 protects potentially sensitive authentication cookies on Linux/macOS.
        fd = os.open(output, os.O_CREAT | os.O_TRUNC | os.O_WRONLY, 0o600)
        os.chmod(output, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as outfile:
            outfile.write("\n".join(lines) + "\n")
        print(f"Converted {len(cookies)} cookie(s) -> {output}")
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        parser.exit(1, f"Error: {exc}\n")


if __name__ == "__main__":
    main()
