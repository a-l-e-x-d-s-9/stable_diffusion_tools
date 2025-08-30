#!/usr/bin/env python3
# png_info_copy.py
# Copy A1111/Forge metadata between PNG and JPG with correct encoding.

import argparse
import sys
from typing import Dict, Optional

from PIL import Image
from PIL.PngImagePlugin import PngInfo
import io, os, struct, zlib
from pathlib import Path

try:
    import piexif
except Exception:
    piexif = None

PNG_SIG = b"\x89PNG\r\n\x1a\n"


def rewrite_png_parameters_text(png_path: Path, parameters_str: str, debug: bool = False):
    """
    Rewrites the PNG to remove any existing Parameters (tEXt/iTXt/zTXt) and
    appends a single clean Latin-1 tEXt chunk with keyword 'parameters'
    immediately before IEND. Atomic replace.
    """
    p = Path(png_path)
    raw = p.read_bytes()
    if not raw.startswith(PNG_SIG):
        raise ValueError(f"{p} is not PNG")

    out = io.BytesIO()
    out.write(PNG_SIG)

    # Copy all chunks except any text chunks whose keyword == 'parameters'
    # Then remember IEND position to append our new chunk right before it.
    removed = 0
    for ctype, data, start, end in _iter_chunks(raw):
        if ctype == b"IEND":
            # Insert our new clean tEXt chunk before IEND
            new_chunk = _build_text_chunk("parameters", parameters_str.replace("\x00", ""))
            out.write(new_chunk)
            out.write(raw[start:end])  # write IEND as-is
            break
        elif ctype in (b"tEXt", b"iTXt", b"zTXt"):
            # Decide if this is a 'parameters' entry; keyword is up to first NUL (tEXt/zTXt) or within iTXt structure.
            is_parameters = False
            try:
                if ctype == b"tEXt" or ctype == b"zTXt":
                    nul = data.find(b"\x00")
                    if nul > 0:
                        key = data[:nul]
                        if key.lower() == b"parameters":
                            is_parameters = True
                elif ctype == b"iTXt":
                    # iTXt layout: keyword\0 compression_flag\0 compression_method\0 language_tag\0 translated_keyword\0 text
                    nul = data.find(b"\x00")
                    if nul > 0 and data[:nul].lower() == b"parameters":
                        is_parameters = True
            except Exception:
                pass
            if is_parameters:
                removed += 1
                continue  # skip old/empty/mis-encoded Parameters
            else:
                out.write(raw[start:end])
        else:
            out.write(raw[start:end])

    new_bytes = out.getvalue()
    # Atomic replace
    tmp = p.with_name(p.stem + ".tmp" + p.suffix)
    Path(tmp).write_bytes(new_bytes)
    os.replace(tmp, p)
    if debug:
        print(f"[debug] PNG:{p.name} wrote clean tEXt Parameters ({len(parameters_str)} bytes), removed={removed}")


def _iter_chunks(buf: bytes):
    pos = len(PNG_SIG)
    n = len(buf)
    while pos + 8 <= n:
        length = int.from_bytes(buf[pos:pos+4], "big")
        ctype  = buf[pos+4:pos+8]
        data_s = pos + 8
        data_e = data_s + length
        crc_e  = data_e + 4
        if crc_e > n:
            raise ValueError("Corrupt PNG")
        yield (ctype, buf[data_s:data_e], pos, crc_e)
        pos = crc_e

def _build_text_chunk(keyword: str, text: str) -> bytes:
    # PNG tEXt must be Latin-1. Drop non-Latin-1 chars to avoid mojibake.
    k = (keyword or "parameters").encode("latin-1", "ignore")
    t = (text or "").replace("\x00", "").encode("latin-1", "ignore")
    data = k + b"\x00" + t
    ctype = b"tEXt"
    crc = zlib.crc32(ctype)
    crc = zlib.crc32(data, crc) & 0xFFFFFFFF
    return len(data).to_bytes(4, "big") + ctype + data + crc.to_bytes(4, "big")

def rewrite_png_parameters_text_before_idat(png_path: Path, parameters_str: str, debug: bool = False):
    raw = Path(png_path).read_bytes()
    if not raw.startswith(PNG_SIG):
        raise ValueError(f"{png_path} is not a PNG")

    def iter_chunks(buf: bytes):
        pos = len(PNG_SIG)
        n = len(buf)
        while pos + 8 <= n:
            length = int.from_bytes(buf[pos:pos+4], "big")
            ctype  = buf[pos+4:pos+8]
            data_s = pos + 8
            data_e = data_s + length
            crc_e  = data_e + 4
            if crc_e > n:
                raise ValueError("Corrupt PNG")
            yield (ctype, buf[data_s:data_e], pos, crc_e)
            pos = crc_e

    def build_text_chunk(keyword: str, text: str) -> bytes:
        k = (keyword or "parameters").encode("latin-1", "ignore")
        t = (text or "").replace("\x00", "").encode("latin-1", "ignore")
        data = k + b"\x00" + t
        ctype = b"tEXt"
        crc = zlib.crc32(ctype)
        crc = zlib.crc32(data, crc) & 0xFFFFFFFF
        return len(data).to_bytes(4, "big") + ctype + data + crc.to_bytes(4, "big")

    out = io.BytesIO()
    out.write(PNG_SIG)

    inserted = False
    removed  = 0
    for ctype, data, start, end in iter_chunks(raw):
        # remove any existing parameters in tEXt/zTXt/iTXt
        if ctype in (b"tEXt", b"zTXt", b"iTXt"):
            try:
                nul = data.find(b"\x00")
                if nul > 0:
                    key = data[:nul].lower()
                    if key == b"parameters":
                        removed += 1
                        continue
            except Exception:
                pass

        if not inserted and ctype == b"IDAT":
            out.write(build_text_chunk("parameters", parameters_str))
            inserted = True

        out.write(raw[start:end])

    if not inserted:
        # fallback: insert before IEND
        out2 = io.BytesIO()
        out2.write(PNG_SIG)
        buf = out.getvalue()
        for ctype, data, start, end in iter_chunks(buf):
            if ctype == b"IEND" and not inserted:
                out2.write(build_text_chunk("parameters", parameters_str))
                inserted = True
            out2.write(buf[start:end])
        out = out2

    tmp = png_path.with_name(png_path.stem + ".tmp" + png_path.suffix)  # foo.tmp.png
    Path(tmp).write_bytes(out.getvalue())
    os.replace(tmp, png_path)
    if debug:
        print(f"[debug] PNG:{png_path.name} inserted_before_idat={inserted}, removed_old={removed}, new_len={len(parameters_str)}")

# ---------------- encoding helpers ----------------

def _decode_user_comment(raw) -> Optional[str]:
    if raw is None:
        return None
    # If it is already str, normalize and return
    if isinstance(raw, str):
        return raw.replace("\x00", "")

    if not isinstance(raw, (bytes, bytearray)):
        return None
    b = bytes(raw)

    # EXIF UserComment header is 8 bytes: ASCII\0\0\0, UNICODE\0, or JIS\0\0\0\0
    head, body = b[:8], b[8:]

    # ASCII
    if head == b"ASCII\x00\x00\x00":
        try:
            return body.decode("ascii", "ignore")
        except Exception:
            return body.decode("latin-1", "ignore")

    # JIS
    if head == b"JIS\x00\x00\x00\x00":
        try:
            return body.decode("shift_jis", "ignore").replace("\x00", "")
        except Exception:
            return body.decode("latin-1", "ignore").replace("\x00", "")

    # UNICODE: often UTF-16 without BOM. Try utf-16, then LE, then BE; choose the one with most ASCII.
    if head == b"UNICODE\x00":
        candidates = []
        for enc in ("utf-16", "utf-16le", "utf-16be"):
            try:
                s = body.decode(enc, "ignore").replace("\x00", "")
                # score by how many characters survive Latin-1 encoding
                score = len(s.encode("latin-1", "ignore"))
                candidates.append((score, s))
            except Exception:
                continue
        if candidates:
            candidates.sort(reverse=True)
            return candidates[0][1]
        # last resort
        try:
            return body.decode("utf-8", "ignore").replace("\x00", "")
        except Exception:
            return body.decode("latin-1", "ignore").replace("\x00", "")

    # Unknown header: try utf-8 then latin-1
    try:
        return b.decode("utf-8", "ignore").replace("\x00", "")
    except Exception:
        return b.decode("latin-1", "ignore").replace("\x00", "")



def _normalize_to_str(v) -> Optional[str]:
    if v is None:
        return None
    if isinstance(v, bytes):
        s = _decode_user_comment(v)
        if s is None:
            try:
                s = v.decode("utf-8", "ignore")
            except Exception:
                s = v.decode("latin-1", "ignore")
        return s.replace("\x00", "") if isinstance(s, str) else s
    if isinstance(v, str):
        return v.replace("\x00", "")
    return None


def _encode_user_comment(s: str) -> bytes:
    try:
        s.encode("ascii")
        return b"ASCII\x00\x00\x00" + s.encode("ascii")
    except UnicodeEncodeError:
        return b"UNICODE\x00" + s.encode("utf-16")


def _is_png(p: Path) -> bool:
    return p.suffix.lower() == ".png"


def _is_jpg(p: Path) -> bool:
    return p.suffix.lower() in {".jpg", ".jpeg", ".jpe"}


# ---------------- extract ----------------

def extract_from_png(path: Path, debug: bool = False) -> Dict[str, str]:
    im = Image.open(path)
    info = dict(im.info or {})
    out: Dict[str, str] = {}
    for k in ("parameters", "sd-metadata", "Comment", "Description", "Software"):
        val = _normalize_to_str(info.get(k))
        if val:
            out[k] = val
            if debug:
                print(f"[debug] PNG:{path.name} found {k} length={len(val)}")
    return out


def extract_from_jpg(path: Path, debug: bool = False) -> Dict[str, str]:
    out: Dict[str, str] = {}

    # 1) Prefer piexif for robust EXIF parsing
    if piexif is not None:
        try:
            exif = piexif.load(str(path))
            user_comment = exif.get("Exif", {}).get(piexif.ExifIFD.UserComment)
            uc = _normalize_to_str(user_comment)
            if uc:
                out["parameters"] = uc
                if debug:
                    print(f"[debug] JPEG:{path.name} parameters from EXIF UserComment length={len(uc)}")
            image_desc = _normalize_to_str(exif.get("0th", {}).get(piexif.ImageIFD.ImageDescription))
            if image_desc and "parameters" not in out:
                out["parameters"] = image_desc
                if debug:
                    print(f"[debug] JPEG:{path.name} parameters from EXIF ImageDescription length={len(image_desc)}")
            sw = _normalize_to_str(exif.get("0th", {}).get(piexif.ImageIFD.Software))
            if sw:
                out["Software"] = sw
        except Exception as e:
            if debug:
                print(f"[debug] piexif.load failed on {path.name}: {e}")

    # 2) Fallbacks via Pillow
    try:
        im = Image.open(path)
        if "parameters" not in out:
            com = _normalize_to_str(im.info.get("comment"))
            if com:
                out["parameters"] = com
                if debug:
                    print(f"[debug] JPEG:{path.name} parameters from JPEG COM length={len(com)}")
        # Pillow EXIF fallback (sometimes empty, but cheap to try)
        exif = getattr(im, "getexif", lambda: {})()
        if exif and "parameters" not in out:
            v = _normalize_to_str(exif.get(270))  # ImageDescription
            if v:
                out["parameters"] = v
                if debug:
                    print(f"[debug] JPEG:{path.name} parameters from PIL EXIF ImageDescription length={len(v)}")
        if exif:
            sw2 = _normalize_to_str(exif.get(305))  # Software
            if sw2 and "Software" not in out:
                out["Software"] = sw2
    except Exception as e:
        if debug:
            print(f"[debug] PIL fallback read failed on {path.name}: {e}")

    return out


def extract_sd_metadata(path: Path, debug: bool = False) -> Dict[str, str]:
    if _is_png(path):
        return extract_from_png(path, debug=debug)
    if _is_jpg(path):
        return extract_from_jpg(path, debug=debug)
    raise ValueError(f"Unsupported source format: {path.suffix}")


# ---------------- write ----------------

def write_to_png(target: Path, meta: dict, debug: bool = False) -> None:
    im = Image.open(target)
    newinfo = PngInfo()

    # write only clean Latin-1 tEXt "parameters"
    if "parameters" in meta:
        val = (_normalize_to_str(meta["parameters"]) or "").replace("\x00", "")
        try:
            val.encode("latin-1")
            newinfo.add_text("parameters", val)
        except UnicodeEncodeError:
            cleaned = val.encode("latin-1", "ignore").decode("latin-1", "ignore")
            newinfo.add_text("parameters", cleaned)
        if debug:
            print(f"[debug] PNG:{target.name} wrote parameters as tEXt, length={len(val)}")

    # optional Software
    if "Software" in meta:
        sw = (_normalize_to_str(meta["Software"]) or "").replace("\x00", "")
        try:
            sw.encode("latin-1")
            newinfo.add_text("Software", sw)
        except UnicodeEncodeError:
            pass

    # atomic save: keep .png suffix so Pillow knows the format
    tmp = target.with_name(target.stem + ".tmp" + target.suffix)  # e.g., foo.tmp.png
    im.save(tmp, pnginfo=newinfo)
    tmp.replace(target)


def write_to_jpg(target: Path, meta: Dict[str, str], debug: bool = False) -> None:
    if piexif is None:
        raise RuntimeError("piexif is required for writing JPEG EXIF. pip install piexif")

    im = Image.open(target)
    try:
        exif_dict = piexif.load(im.info.get("exif", b""))
    except Exception:
        exif_dict = {"0th": {}, "Exif": {}, "GPS": {}, "1st": {}, "thumbnail": None}

    if "parameters" in meta:
        s = _normalize_to_str(meta["parameters"]) or ""
        exif_dict.setdefault("Exif", {})[piexif.ExifIFD.UserComment] = _encode_user_comment(s)
        if debug:
            print(f"[debug] JPEG:{target.name} wrote EXIF UserComment length={len(s)}")

    if "Software" in meta:
        sw = _normalize_to_str(meta["Software"]) or ""
        exif_dict.setdefault("0th", {})[piexif.ImageIFD.Software] = sw.encode("utf-8", "ignore")

    exif_bytes = piexif.dump(exif_dict)
    im.save(target, exif=exif_bytes, quality="keep")


def copy_metadata(src: Path, dst: Path, debug: bool = False) -> None:
    meta = extract_sd_metadata(src, debug=debug)
    if debug:
        print(f"[debug] extracted keys: {list(meta.keys())}")
    if not meta or not any(k in meta for k in ("parameters", "sd-metadata")):
        raise RuntimeError(f"No A1111 or Forge metadata found in {src}")

    if _is_png(dst):
        # normalize and sanity-check before writing
        val = _normalize_to_str(meta.get("parameters")) or ""
        try:
            lb = val.encode("latin-1", "ignore")
        except Exception:
            lb = b""
        if debug:
            printable = sum(32 <= c <= 126 or c in (9, 10, 13) for c in lb)
            print(f"[debug] parameters latin-1 bytes: {len(lb)} printable: {printable}")
        rewrite_png_parameters_text_before_idat(dst, val, debug=debug)
    elif _is_jpg(dst):
        write_to_jpg(dst, meta, debug=debug)
    else:
        raise ValueError(f"Unsupported target format: {dst.suffix}")


# ---------------- cli ----------------

def main():
    ap = argparse.ArgumentParser(description="Copy A1111/Forge metadata between PNG and JPG with correct encoding.")
    ap.add_argument("--metadata-source", required=True)
    ap.add_argument("--metadata-target", required=True)
    ap.add_argument("--debug", action="store_true", help="Print where metadata was found and written.")
    args = ap.parse_args()

    src = Path(args.metadata_source)
    dst = Path(args.metadata_target)
    if not src.exists():
        sys.exit(f"Source not found: {src}")
    if not dst.exists():
        sys.exit(f"Target not found: {dst}")

    copy_metadata(src, dst, debug=args.debug)
    print(f"Metadata copied from {src} to {dst}")


if __name__ == "__main__":
    main()
