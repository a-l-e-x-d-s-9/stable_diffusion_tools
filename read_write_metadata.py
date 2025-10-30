#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Clean, robust utility for PNG/JPEG/WEBP Stable-Diffusion-style metadata.
No hidden control chars; only Python escape sequences like "\x00" inside bytes literals.

Features
- Read/Write `order_in_post`  (PNG: tEXt; JPEG/WEBP: EXIF XPComment)
- Read/Write `parameters`     (PNG: tEXt; JPEG/WEBP: EXIF UserComment)
- Parameters substring search/replace via CLI

Examples
  python read_write_metadata_v5.py image.webp
  python read_write_metadata_v5.py image.jpg --set 7
  python read_write_metadata_v5.py image.png --param-search "foo" --param-replace "bar"
  python read_write_metadata_v5.py image.png --set 0   # remove order_in_post
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Dict, Optional, Tuple
import io
import zlib

from PIL import Image

try:
    import piexif  # type: ignore
except Exception:
    piexif = None  # JPEG/WEBP EXIF write will require this

# -------------------- PNG helpers --------------------
PNG_SIG = b"\x89PNG\r\n\x1a\n"
# Where to store the JSON blob for PNG kv
PNG_KV_TEXT_KEY = "Description"  # exiftool shows as PNG:Description

def _iter_chunks(buf: bytes):
    pos = len(PNG_SIG)
    n = len(buf)
    while pos + 8 <= n:
        length = int.from_bytes(buf[pos:pos+4], "big")
        ctype = buf[pos+4:pos+8]
        data_s = pos + 8
        data_e = data_s + length
        crc_e = data_e + 4
        if crc_e > n:
            raise ValueError("Corrupt PNG")
        yield (ctype, buf[data_s:data_e], pos, crc_e)
        pos = crc_e


def _decode_png_text(ctype: bytes, data: bytes) -> Optional[Tuple[str, str]]:
    try:
        if ctype == b"tEXt":
            i = data.find(b"\x00")
            if i <= 0:
                return None
            key = data[:i].decode("latin-1", "ignore")
            txt = data[i+1:].decode("latin-1", "ignore")
            return key, txt
        if ctype == b"zTXt":
            i = data.find(b"\x00")
            if i <= 0 or i+2 > len(data):
                return None
            key = data[:i].decode("latin-1", "ignore")
            method = data[i+1]
            if method != 0:
                return None
            comp = data[i+2:]
            try:
                txt = zlib.decompress(comp).decode("latin-1", "ignore")
            except Exception:
                return None
            return key, txt
        if ctype == b"iTXt":
            parts = data.split(b"\x00", 5)
            if len(parts) < 6:
                return None
            key = parts[0].decode("latin-1", "ignore")
            compressed_flag = parts[1][:1]
            comp_method = parts[2][:1]
            rest = parts[5]
            if compressed_flag == b"\x01" and comp_method == b"\x00":
                try:
                    txt = zlib.decompress(rest).decode("utf-8", "ignore")
                except Exception:
                    txt = zlib.decompress(rest).decode("latin-1", "ignore")
            else:
                try:
                    txt = rest.decode("utf-8", "ignore")
                except Exception:
                    txt = rest.decode("latin-1", "ignore")
            return key, txt
    except Exception:
        return None
    return None


def _build_text_chunk(keyword: str, text: str) -> bytes:
    k = (keyword or "").encode("latin-1", "ignore")
    t = (text or "").replace("\x00", "").encode("latin-1", "ignore")
    data = k + b"\x00" + t
    ctype = b"tEXt"
    import zlib as _z
    crc = _z.crc32(ctype)
    crc = _z.crc32(data, crc) & 0xFFFFFFFF
    return len(data).to_bytes(4, "big") + ctype + data + crc.to_bytes(4, "big")


def _png_text_map(buf: bytes) -> Dict[str, str]:
    out: Dict[str, str] = {}
    if not buf.startswith(PNG_SIG):
        return out
    for ctype, data, _s, _e in _iter_chunks(buf):
        kv = _decode_png_text(ctype, data)
        if kv:
            k, v = kv
            out[k] = v
    return out


def _png_write_text_keys(p: Path, mapping: Dict[str, Optional[str]]) -> None:
    raw = p.read_bytes()
    if not raw.startswith(PNG_SIG):
        raise ValueError("Not a PNG")
    drop = {k.lower() for k in mapping.keys()}
    out = io.BytesIO()
    out.write(PNG_SIG)
    for ctype, data, start, end in _iter_chunks(raw):
        if ctype == b"IEND":
            for k, v in mapping.items():
                if v is not None:
                    out.write(_build_text_chunk(k, v))
            out.write(raw[start:end])
            break
        if ctype in (b"tEXt", b"zTXt", b"iTXt"):
            kv = _decode_png_text(ctype, data)
            if kv and kv[0].lower() in drop:
                continue
        out.write(raw[start:end])
    tmp = p.with_name(p.stem + ".tmp" + p.suffix)
    Path(tmp).write_bytes(out.getvalue())
    os.replace(tmp, p)

HEADER_PREFIXES = ("ASCII\0\0\0", "UNICODE\0", "JIS\0\0\0\0")

def _strip_uc_header_and_nulls_str(s: str) -> str:
    for h in HEADER_PREFIXES:
        if s.startswith(h):
            s = s[len(h):]
            break
        
    return s.replace("\x00", "")

def _decode_utf16_no_bom_select(data: bytes) -> Optional[str]:
    # If BOM present, trust it.
    if len(data) >= 2 and data[:2] in (b"\xff\xfe", b"\xfe\xff"):
        try:
            return data.decode("utf-16", "ignore").replace("\x00", "")
        except Exception:
            return None

    pairs = len(data) // 2
    if pairs == 0:
        return None

    # Heuristic: where are the zeros? (ASCII-in-UTF16 has ~50% zeros)
    zeros_le = sum(1 for i in range(0, pairs * 2, 2) if data[i+1:i+2] == b"\x00") / pairs
    zeros_be = sum(1 for i in range(0, pairs * 2, 2) if data[i:i+1] == b"\x00") / pairs

    # Prefer the side with more NULs; tie-break by ASCII score.
    def ascii_score(s: str) -> float:
        if not s:
            return 0.0
        ok = sum(1 for ch in s if ch == "\n" or ch == "\r" or ch == "\t" or (" " <= ch <= "~"))
        return ok / len(s)

    choice = None
    if zeros_le > zeros_be:
        choice = "utf-16le"
    elif zeros_be > zeros_le:
        choice = "utf-16be"
    if choice:
        try:
            return data.decode(choice, "ignore").replace("\x00", "")
        except Exception:
            pass

    # Tie: try both and pick the more ASCII-looking string
    candidates = []
    for enc in ("utf-16le", "utf-16be"):
        try:
            s = data.decode(enc, "ignore").replace("\x00", "")
            candidates.append((ascii_score(s), s))
        except Exception:
            pass
    if candidates:
        candidates.sort(reverse=True)
        return candidates[0][1]
    return None

# -------------------- EXIF helpers (JPEG/WEBP) --------------------

def _decode_user_comment(raw) -> Optional[str]:
    """Decode EXIF UserComment robustly (bytes OR str). Strip header even if raw is str."""
    if raw is None:
        return None
    
    if isinstance(raw, str):
        return _strip_uc_header_and_nulls_str(raw)

    # Usual path: bytes
    if not isinstance(raw, (bytes, bytearray)):
        return None
    b = bytes(raw)
    head, body = b[:8], b[8:]

    if head == b'ASCII\x00\x00\x00':
        # If it *looks* like UTF-16 anyway (lots of NULs), decode as UTF-16
        if body and (body.count(b"\x00") / len(body) >= 0.20):
            maybe = _decode_utf16_no_bom_select(body)
            if maybe is not None:
                return maybe
        return body.decode("ascii", "ignore").replace("\x00", "")

    if head == b'JIS\x00\x00\x00\x00':
        maybe = _decode_utf16_no_bom_select(body)
        if maybe is not None:
            return maybe
        try:
            return body.decode('shift_jis', 'ignore').replace('\x00', '')
        except Exception:
            return body.decode('latin-1', 'ignore').replace('\x00', '')

    if head == b'UNICODE\x00':
        # Decide: single-byte vs UTF-16 based on NUL density
        if body:
            nul_ratio = body.count(b"\x00") / len(body)
        else:
            nul_ratio = 0.0

        # If < 0.20 NULs → treat as single-byte (UTF-8 prefer, then Latin-1)
        if nul_ratio < 0.20:
            try:
                return body.decode("utf-8", "ignore").replace("\x00", "")
            except Exception:
                return body.decode("latin-1", "ignore").replace("\x00", "")

        # Otherwise assume true UTF-16 (without BOM) and choose LE/BE
        s = _decode_utf16_no_bom_select(body)
        if s is not None:
            return s

        # Last resorts
        try:
            return body.decode("utf-8", "ignore").replace("\x00", "")
        except Exception:
            return body.decode("latin-1", "ignore").replace("\x00", "")

    # No/unknown header: try UTF-16 heuristics, then UTF-8/Latin-1
    maybe = _decode_utf16_no_bom_select(b)
    if maybe is not None:
        return maybe
    try:
        return b.decode('utf-8', 'ignore').replace('\x00', '')
    except Exception:
        return b.decode('latin-1', 'ignore').replace('\x00', '')


def _normalize_to_str(v) -> Optional[str]:
    if v is None:
        return None
    if isinstance(v, str):
        # If someone handed us a UserComment-as-str, strip header + NULs
        return _strip_uc_header_and_nulls_str(v)
    if isinstance(v, (list, tuple)):
        try:
            v = bytes(v)
        except Exception:
            return None
    if isinstance(v, (bytes, bytearray)):
        b = bytes(v)
        try:
            return b.decode("utf-8").replace("\x00", "")
        except Exception:
            pass
        if len(b) >= 2 and b[:2] in (b"\xff\xfe", b"\xfe\xff"):
            try:
                return b.decode("utf-16", "ignore").replace("\x00", "")
            except Exception:
                pass
        pairs = len(b) // 2
        if pairs:
            zeros_le = sum(1 for i in range(0, pairs * 2, 2) if b[i+1:i+2] == b"\x00") / pairs
            zeros_be = sum(1 for i in range(0, pairs * 2, 2) if b[i:i+1] == b"\x00") / pairs
            try:
                if zeros_le >= 0.3:
                    return b.decode("utf-16le", "ignore").replace("\x00", "")
                if zeros_be >= 0.3:
                    return b.decode("utf-16be", "ignore").replace("\x00", "")
            except Exception:
                pass
        try:
            return b.decode("latin-1", "ignore").replace("\x00", "")
        except Exception:
            return None
    return None


def _encode_user_comment(s: str) -> bytes:
    try:
        s.encode("ascii")
        return b"ASCII\x00\x00\x00" + s.encode("ascii")
    except UnicodeEncodeError:
        return b"UNICODE\x00" + s.encode("utf-16")


def _encode_xp(s: str) -> bytes:
    return (s or "").encode("utf-16le") + b"\x00\x00"


# -------------------- Public API --------------------

def read_metadata(path: Path, debug: bool = False) -> Dict[str, Optional[str]]:
    out: Dict[str, Optional[str]] = {"parameters": None, "Software": None, "order_in_post": None}
    suf = path.suffix.lower()

    if suf == ".png":
        raw = path.read_bytes()
        tmap = _png_text_map(raw)
        out["parameters"] = _normalize_to_str(tmap.get("parameters"))
        out["Software"] = _normalize_to_str(tmap.get("Software"))
        oip = tmap.get("order_in_post")
        out["order_in_post"] = None if oip is None or oip == "" else str(oip)
        return out

    if suf in {".jpg", ".jpeg", ".jpe", ".webp"}:
        if piexif is not None:
            try:
                ex = piexif.load(str(path))
                uc = _decode_user_comment(ex.get("Exif", {}).get(piexif.ExifIFD.UserComment))
                if uc:
                    out["parameters"] = uc
                desc = _normalize_to_str(ex.get("0th", {}).get(piexif.ImageIFD.ImageDescription))
                if desc and not out["parameters"]:
                    out["parameters"] = desc
                sw = _normalize_to_str(ex.get("0th", {}).get(piexif.ImageIFD.Software))
                if sw:
                    out["Software"] = sw
                xp = ex.get("0th", {}).get(0x9C9C)
                if isinstance(xp, (bytes, bytearray)):
                    val = xp
                elif isinstance(xp, (list, tuple)):
                    val = bytes(xp)
                else:
                    val = None
                if val:
                    try:
                        out["order_in_post"] = val.decode("utf-16le", "ignore").rstrip("\x00") or None
                    except Exception:
                        out["order_in_post"] = None
            except Exception as e:
                if debug:
                    print(f"[debug] piexif.load failed: {e}")
        # JPEG-only Pillow fallback
        if suf in {".jpg", ".jpeg", ".jpe"}:
            try:
                with Image.open(path) as im:
                    if not out["parameters"]:
                        out["parameters"] = _normalize_to_str(im.info.get("comment"))
            except Exception as e:
                if debug:
                    print(f"[debug] PIL read failed: {e}")
        return out

    raise ValueError(f"Unsupported image format: {suf}")


def write_order_in_post(path: Path, value: Optional[int], debug: bool = False) -> None:
    if value is None:
        return
    suf = path.suffix.lower()
    if suf == ".png":
        _png_write_text_keys(path, {"order_in_post": None if value == 0 else str(int(value))})
        if debug:
            print(f"[debug] PNG write order_in_post -> {value}")
        return
    if suf in {".jpg", ".jpeg", ".jpe", ".webp"}:
        if piexif is None:
            raise RuntimeError("piexif is required to write order_in_post on JPEG/WEBP")
        try:
            ex = piexif.load(str(path))
        except Exception:
            ex = {"0th": {}, "Exif": {}, "GPS": {}, "1st": {}, "thumbnail": None}
        if value == 0:
            try:
                if 0x9C9C in ex.get("0th", {}):
                    del ex["0th"][0x9C9C]
            except Exception:
                pass
        else:
            ex.setdefault("0th", {})[0x9C9C] = _encode_xp(str(int(value)))
        exif_bytes = piexif.dump(ex)
        piexif.insert(exif_bytes, str(path))
        if debug:
            print(f"[debug] {suf} write order_in_post -> {value}")
        return
    raise ValueError(f"Unsupported image format: {suf}")


def write_parameters(path: Path, new_text: str, debug: bool = False) -> None:
    # always sanitize to avoid double headers
    new_text = _strip_uc_header_and_nulls_str(new_text)
    suf = path.suffix.lower()
    if suf == ".png":
        _png_write_text_keys(path, {"parameters": new_text})
        if debug:
            print("[debug] PNG write parameters (tEXt)")
        return
    if suf in {".jpg", ".jpeg", ".jpe", ".webp"}:
        if piexif is None:
            raise RuntimeError("piexif is required to write parameters on JPEG/WEBP")
        try:
            ex = piexif.load(str(path))
        except Exception:
            ex = {"0th": {}, "Exif": {}, "GPS": {}, "1st": {}, "thumbnail": None}
        ex.setdefault("Exif", {})[piexif.ExifIFD.UserComment] = _encode_user_comment(new_text)
        exif_bytes = piexif.dump(ex)
        piexif.insert(exif_bytes, str(path))
        if debug:
            print(f"[debug] {suf} write parameters (UserComment)")
        return
    raise ValueError(f"Unsupported image format: {suf}")

# --- Generic KV read/write on top of current scheme ---
# PNG: arbitrary keys in tEXt (except reserved keys).
# JPG/WEBP: arbitrary keys as a JSON object in EXIF ImageDescription (0x010E).

def read_kv(path: Path, debug: bool = False) -> Dict[str, str]:
    """Return arbitrary metadata KVs managed by this tool.
    PNG: JSON blob in tEXt['Description'] if present; otherwise fall back to legacy per-key tEXt.
    JPG/WEBP: JSON object from EXIF ImageDescription.
    """
    suf = path.suffix.lower()
    if suf == ".png":
        raw = path.read_bytes()
        tmap = _png_text_map(raw)

        # Preferred: one JSON blob under "Description"
        blob = tmap.get(PNG_KV_TEXT_KEY)
        if blob:
            return _parse_json_maybe(blob)

        # Backward-compat: assemble legacy per-key tEXt (excluding reserved)
        out: Dict[str, str] = {}
        for k, v in tmap.items():
            if k in ("parameters", "Software", "order_in_post"):
                continue
            out[str(k)] = (v or "")
        return out

    if suf in {".jpg", ".jpeg", ".jpe", ".webp"}:
        if piexif is None:
            if debug:
                print("[debug] piexif missing; no generic KV for JPEG/WEBP available")
            return {}
        try:
            ex = piexif.load(str(path))
            desc = _normalize_to_str(ex.get("0th", {}).get(piexif.ImageIFD.ImageDescription))
            return _parse_json_maybe(desc)
        except Exception as e:
            if debug:
                print(f"[debug] read_kv EXIF failed: {e}")
            return {}

    raise ValueError(f"Unsupported image format: {suf}")


def write_kv(path: Path, mapping: Dict[str, Optional[str]], debug: bool = False) -> None:
    """Write or delete arbitrary keys.
    PNG: merge keys into a single JSON blob in tEXt['Description'].
    JPG/WEBP: merge keys into EXIF ImageDescription JSON.
    Reserved keys handled elsewhere: parameters, Software, order_in_post.
    """
    suf = path.suffix.lower()
    if suf == ".png":
        raw = path.read_bytes()
        tmap = _png_text_map(raw)
        current = _parse_json_maybe(tmap.get(PNG_KV_TEXT_KEY))

        # Merge requested changes into the current JSON map
        for k, v in mapping.items():
            if k in ("parameters", "Software", "order_in_post"):
                continue
            if v is None:
                current.pop(str(k), None)
            else:
                current[str(k)] = str(v)

        # Write back the single JSON blob under "Description"
        _png_write_text_keys(path, {PNG_KV_TEXT_KEY: _json_str(current)})
        if debug:
            print(f"[debug] PNG write_kv updated {PNG_KV_TEXT_KEY} with keys: {list(mapping.keys())}")
        return

    if suf in {".jpg", ".jpeg", ".jpe", ".webp"}:
        if piexif is None:
            raise RuntimeError("piexif is required to write generic KV on JPEG/WEBP")
        try:
            ex = piexif.load(str(path))
        except Exception:
            ex = {"0th": {}, "Exif": {}, "GPS": {}, "1st": {}, "thumbnail": None}

        current = _parse_json_maybe(_normalize_to_str(ex.get("0th", {}).get(piexif.ImageIFD.ImageDescription)))
        for k, v in mapping.items():
            if k in ("parameters", "order_in_post"):
                continue
            if v is None:
                current.pop(str(k), None)
            else:
                current[str(k)] = str(v)

        ex.setdefault("0th", {})[piexif.ImageIFD.ImageDescription] = _json_str(current).encode("utf-8")
        exif_bytes = piexif.dump(ex)
        piexif.insert(exif_bytes, str(path))
        if debug:
            print(f"[debug] {suf} write_kv merged keys: {list(mapping.keys())}")
        return

    raise ValueError(f"Unsupported image format: {suf}")


# --- Generic KV helpers ---

def _parse_json_maybe(s: Optional[str]) -> Dict[str, str]:
    if not s:
        return {}
    try:
        obj = json.loads(s)
        if isinstance(obj, dict):
            return {str(k): ("" if v is None else str(v)) for k, v in obj.items()}
    except Exception:
        pass
    return {}

def _json_str(d: Dict[str, str]) -> str:
    return json.dumps(d, ensure_ascii=False, separators=(",", ":"))

# -------------------- CLI --------------------

def main():
    ap = argparse.ArgumentParser(description="Read/Write metadata + order_in_post + parameters replace (PNG/JPEG/WEBP).")
    ap.add_argument("image", help="Path to PNG, JPG, or WEBP")
    ap.add_argument("--set", dest="set_value", type=int, default=None, help="Set order_in_post (0 to remove)")
    ap.add_argument("--param-search", type=str, default=None, help="Substring to search inside 'parameters'")
    ap.add_argument("--param-replace", type=str, default=None, help="Replacement text for 'parameters'")
    # Generic KV controls
    ap.add_argument("--kv-set", action="append", default=[],
                    help="Repeatable key=value to set arbitrary metadata keys")
    ap.add_argument("--kv-del", action="append", default=[],
                    help="Repeatable key to delete from arbitrary metadata")
    ap.add_argument("--kv-load-json", type=str, default=None,
                    help="Path to JSON file with keys to merge into arbitrary metadata")
    ap.add_argument("--kv-print", action="store_true",
                    help="Print arbitrary metadata map")
    ap.add_argument("--debug", action="store_true")
    args = ap.parse_args()

    p = Path(args.image)
    if not p.exists():
        sys.exit(f"Not found: {p}")

    meta = read_metadata(p, debug=args.debug)
    print(json.dumps(meta, ensure_ascii=False, indent=2))
    print(f"order_in_post: {meta.get('order_in_post')}")

        # Show current arbitrary KV if requested
    if args.kv_print:
        kv_now = read_kv(p, debug=args.debug)
        print("\nkv:")
        print(json.dumps(kv_now, ensure_ascii=False, indent=2))

    did_param_change = False
    if args.param_search is not None and args.param_replace is not None:
        orig = meta.get("parameters") or ""
        orig = _strip_uc_header_and_nulls_str(orig)  # << add this
        if orig == "":
            if args.debug:
                print("[debug] No existing 'parameters' to modify; skipping")
        else:
            new_text = orig.replace(args.param_search, args.param_replace)
            if new_text != orig:
                write_parameters(p, new_text, debug=args.debug)
                did_param_change = True
            elif args.debug:
                print("[debug] 'parameters' unchanged (search string not found)")

    if args.set_value is not None:
        write_order_in_post(p, args.set_value, debug=args.debug)


    # Build KV mutations
    kv_changes: Dict[str, Optional[str]] = {}

    # --kv-set key=value (repeatable)
    for item in args.kv_set or []:
        if "=" not in item:
            print(f"[warn] --kv-set expects key=value, got: {item}")
            continue
        k, v = item.split("=", 1)
        kv_changes[k.strip()] = v

    # --kv-del key (repeatable)
    for k in args.kv_del or []:
        kv_changes[k.strip()] = None

    # --kv-load-json path.json
    if args.kv_load_json:
        try:
            loaded = json.loads(Path(args.kv_load_json).read_text(encoding="utf-8"))
            if isinstance(loaded, dict):
                for k, v in loaded.items():
                    kv_changes[str(k)] = None if v is None else str(v)
            else:
                print("[warn] --kv-load-json must be a JSON object")
        except Exception as e:
            print(f"[warn] failed to load JSON: {e}")

    # Apply KV changes if any
    if kv_changes:
        write_kv(p, kv_changes, debug=args.debug)


    if did_param_change or args.set_value is not None or kv_changes:
        meta2 = read_metadata(p, debug=args.debug)
        print("\nUpdated:")
        print(json.dumps(meta2, ensure_ascii=False, indent=2))
        print(f"order_in_post: {meta2.get('order_in_post')}")
        # Show updated KV if we changed it or user asked to print
        if kv_changes or args.kv_print:
            kv2 = read_kv(p, debug=args.debug)
            print("\nkv updated:")
            print(json.dumps(kv2, ensure_ascii=False, indent=2))





    


if __name__ == "__main__":
    main()