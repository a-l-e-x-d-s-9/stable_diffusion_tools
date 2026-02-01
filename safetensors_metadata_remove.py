#!/usr/bin/env python3
"""
safetensors_metadata_remove.py

Remove training metadata from a .safetensors LoRA (commonly added by kohya-ss)
by rewriting ONLY the safetensors JSON header while copying the raw tensor
byte-buffer unchanged.

This keeps the tensor bytes bit-for-bit identical and should work for SDXL LoRAs
trained with kohya-ss (and generally any safetensors file).

References:
- Safetensors format: 8-byte header length + JSON header + byte-buffer.
  Special key "__metadata__" is allowed. data_offsets are relative to the byte-buffer.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import struct
import sys
from pathlib import Path
from typing import Any, Dict, Tuple


METADATA_KEYS = ("__metadata__", "metadata")


def _is_tensor_entry(v: Any) -> bool:
    if not isinstance(v, dict):
        return False
    # Minimal checks for a tensor descriptor in safetensors header
    return (
        "dtype" in v
        and "shape" in v
        and "data_offsets" in v
        and isinstance(v.get("data_offsets"), list)
        and len(v.get("data_offsets")) == 2
    )


def _read_safetensors_header(fp) -> Tuple[int, bytes, Dict[str, Any], int]:
    """
    Returns:
      header_len: int
      header_json_bytes: bytes
      header_obj: dict
      data_start: int (file offset where raw byte-buffer begins)
    """
    fp.seek(0, os.SEEK_SET)
    first8 = fp.read(8)
    if len(first8) != 8:
        raise ValueError("File too small to be a valid safetensors file (missing 8-byte header length).")

    (header_len,) = struct.unpack("<Q", first8)
    if header_len <= 0:
        raise ValueError(f"Invalid header length: {header_len}")

    header_json_bytes = fp.read(header_len)
    if len(header_json_bytes) != header_len:
        raise ValueError("File truncated while reading safetensors JSON header.")

    try:
        header_text = header_json_bytes.decode("utf-8")
    except UnicodeDecodeError as e:
        raise ValueError(f"Header is not valid UTF-8: {e}") from e

    try:
        header_obj = json.loads(header_text)
    except json.JSONDecodeError as e:
        raise ValueError(f"Header is not valid JSON: {e}") from e

    if not isinstance(header_obj, dict):
        raise ValueError("Safetensors header JSON must be a JSON object (dict).")

    data_start = 8 + header_len
    return int(header_len), header_json_bytes, header_obj, data_start


def _sha256_stream(fp, start: int, chunk_size: int = 8 * 1024 * 1024) -> str:
    h = hashlib.sha256()
    fp.seek(start, os.SEEK_SET)
    while True:
        b = fp.read(chunk_size)
        if not b:
            break
        h.update(b)
    return h.hexdigest()


def _copy_stream(in_fp, out_fp, start: int, chunk_size: int = 8 * 1024 * 1024) -> None:
    in_fp.seek(start, os.SEEK_SET)
    while True:
        b = in_fp.read(chunk_size)
        if not b:
            break
        out_fp.write(b)


def strip_metadata(
    src_path: Path,
    dst_path: Path,
    *,
    drop_non_tensor_keys: bool,
    overwrite: bool,
    verify: bool,
) -> None:
    if not src_path.is_file():
        raise FileNotFoundError(f"Input file not found: {src_path}")

    if src_path.resolve() == dst_path.resolve():
        raise ValueError("Refusing to overwrite input in-place. Please provide a different output path.")

    if dst_path.exists() and not overwrite:
        raise FileExistsError(f"Output file already exists: {dst_path} (use --overwrite to replace)")

    with src_path.open("rb") as in_fp:
        old_hlen, old_hbytes, header_obj, data_start_in = _read_safetensors_header(in_fp)

        # If there is no metadata and we are not dropping other keys, we can do a byte-for-byte copy.
        has_meta = any(k in header_obj for k in METADATA_KEYS)
        if (not has_meta) and (not drop_non_tensor_keys):
            # Exact copy for minimal change.
            dst_path.parent.mkdir(parents=True, exist_ok=True)
            with dst_path.open("wb") as out_fp:
                in_fp.seek(0, os.SEEK_SET)
                _copy_stream(in_fp, out_fp, 0)
            if verify:
                with src_path.open("rb") as a, dst_path.open("rb") as b:
                    sha_a = _sha256_stream(a, 0)
                    sha_b = _sha256_stream(b, 0)
                if sha_a != sha_b:
                    raise RuntimeError("Verification failed: output differs from input, unexpected for no-op copy.")
            return

        # Build new header dict, preserving insertion order as loaded.
        new_header: Dict[str, Any] = {}
        for k, v in header_obj.items():
            if k in METADATA_KEYS:
                continue
            if drop_non_tensor_keys and (not _is_tensor_entry(v)):
                continue
            new_header[k] = v

        # Serialize compactly; safetensors readers do not require pretty formatting.
        new_htext = json.dumps(new_header, ensure_ascii=False, separators=(",", ":"))
        new_hbytes = new_htext.encode("utf-8")
        new_hlen = len(new_hbytes)

        dst_path.parent.mkdir(parents=True, exist_ok=True)
        with dst_path.open("wb") as out_fp:
            out_fp.write(struct.pack("<Q", new_hlen))
            out_fp.write(new_hbytes)
            _copy_stream(in_fp, out_fp, data_start_in)

    if verify:
        # Verify: metadata absent, and raw data buffer identical.
        with dst_path.open("rb") as out_fp:
            _, _, out_header, data_start_out = _read_safetensors_header(out_fp)
            if any(k in out_header for k in METADATA_KEYS):
                raise RuntimeError("Verification failed: metadata keys still present in output header.")

        # Compare sha256 of raw byte-buffer only (tensors live here).
        with src_path.open("rb") as a, dst_path.open("rb") as b:
            _, _, _, data_start_a = _read_safetensors_header(a)
            _, _, _, data_start_b = _read_safetensors_header(b)
            sha_a = _sha256_stream(a, data_start_a)
            sha_b = _sha256_stream(b, data_start_b)

        if sha_a != sha_b:
            raise RuntimeError(
                "Verification failed: raw tensor byte-buffer differs. "
                "This should not happen - please report the input file and environment."
            )


def main() -> int:
    p = argparse.ArgumentParser(
        description="Remove safetensors header metadata (kohya training params) from a LoRA without changing tensor bytes."
    )
    p.add_argument("input", type=Path, help="Path to input .safetensors LoRA")
    p.add_argument("output", type=Path, help="Path to output .safetensors LoRA (metadata stripped)")
    p.add_argument(
        "--drop-non-tensor-keys",
        action="store_true",
        help="Keep only tensor entries in the header (drops any non-tensor top-level keys in addition to metadata).",
    )
    p.add_argument(
        "--overwrite",
        action="store_true",
        help="Overwrite output file if it exists.",
    )
    p.add_argument(
        "--no-verify",
        action="store_true",
        help="Skip verification (by default verifies metadata removal and tensor byte-buffer sha256 match).",
    )

    args = p.parse_args()

    try:
        strip_metadata(
            args.input,
            args.output,
            drop_non_tensor_keys=bool(args.drop_non_tensor_keys),
            overwrite=bool(args.overwrite),
            verify=not bool(args.no_verify),
        )
    except Exception as e:
        print(f"ERROR: {e}", file=sys.stderr)
        return 2

    print("OK: wrote output with metadata stripped.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
