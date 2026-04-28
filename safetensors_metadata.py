#!/usr/bin/env python3
"""
safetensors_metadata.py

Read, replace, clear, or add metadata in .safetensors files.

Safe defaults:
- Writing is done through a temporary file first, then atomically moved into place.
- In-place writes create a .bak backup by default.
- Existing metadata can be fully replaced with --replace-metadata.
- Selected existing metadata keys can be preserved during replace/clear operations.
- Metadata can be provided from JSON and/or direct CLI key=value pairs.
- Nested JSON values are stored as valid JSON strings, not Python repr strings.

Notes:
- This script rewrites the safetensors file using safetensors.torch.save_file.
  Tensor values should be preserved, but the file will not remain byte-for-byte identical.
- For pure metadata removal while preserving tensor bytes exactly, use a header-only tool.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
import tempfile
from pathlib import Path
from pprint import pprint
from typing import Any, Dict, Iterable, List, Optional, Tuple

from safetensors import safe_open
from safetensors.torch import save_file as torch_save_file


SAFETENSORS_SUFFIX = ".safetensors"


def _metadata_value_to_string(value: Any) -> str:
    """Convert metadata values to strings accepted by safetensors."""
    if isinstance(value, str):
        return value
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def _load_metadata_json(json_path: Path) -> Dict[str, str]:
    with json_path.open("r", encoding="utf-8") as f:
        data = json.load(f)

    if not isinstance(data, dict):
        raise ValueError("Metadata JSON must be a dictionary/object of key-value pairs.")

    return {str(k): _metadata_value_to_string(v) for k, v in data.items()}


def _parse_key_list(values: Optional[List[str]]) -> List[str]:
    """Parse repeated/comma-separated key arguments while preserving order."""
    if not values:
        return []

    keys: List[str] = []
    seen = set()
    for value in values:
        for part in str(value).split(","):
            key = part.strip()
            if key and key not in seen:
                keys.append(key)
                seen.add(key)
    return keys


def _parse_set_metadata(values: Optional[List[str]]) -> Dict[str, str]:
    """Parse repeatable CLI metadata overrides in key=value form."""
    metadata: Dict[str, str] = {}
    if not values:
        return metadata

    for item in values:
        if "=" not in item:
            raise ValueError(f"Invalid --set-meta value: {item!r}. Expected key=value.")
        key, value = item.split("=", 1)
        key = key.strip()
        if not key:
            raise ValueError(f"Invalid --set-meta value: {item!r}. Key cannot be empty.")
        metadata[key] = value
    return metadata


def _parse_set_metadata_json(values: Optional[List[str]]) -> Dict[str, str]:
    """Parse repeatable CLI metadata overrides in key=json_value form."""
    metadata: Dict[str, str] = {}
    if not values:
        return metadata

    for item in values:
        if "=" not in item:
            raise ValueError(f"Invalid --set-meta-json value: {item!r}. Expected key=json_value.")
        key, value = item.split("=", 1)
        key = key.strip()
        if not key:
            raise ValueError(f"Invalid --set-meta-json value: {item!r}. Key cannot be empty.")
        try:
            decoded = json.loads(value)
        except json.JSONDecodeError as e:
            raise ValueError(f"Invalid JSON for --set-meta-json {key!r}: {e}") from e
        metadata[key] = _metadata_value_to_string(decoded)
    return metadata


def _decode_metadata_for_display(raw_meta: Optional[Dict[str, str]]) -> Dict[str, Any]:
    if not raw_meta:
        return {}

    decoded_metadata: Dict[str, Any] = {}
    for key, value in raw_meta.items():
        if isinstance(value, str):
            try:
                decoded_metadata[key] = json.loads(value)
            except json.JSONDecodeError:
                decoded_metadata[key] = value
        else:
            decoded_metadata[key] = value
    return decoded_metadata


def read_sd_metadata(file_path: Path) -> Dict[str, Any]:
    with safe_open(str(file_path), framework="numpy") as f:
        raw_meta = f.metadata() or {}
        tensor_keys = list(f.keys())

    print(f"File: {file_path}")
    print(f"Tensor count: {len(tensor_keys)}")
    print(f"Metadata key count: {len(raw_meta)}")
    print(f"Raw metadata keys: {list(raw_meta.keys())}")

    if not raw_meta:
        print("No metadata found.")
        return {"note": "No metadata found.", "tensor_key_count": len(tensor_keys)}

    decoded_metadata = _decode_metadata_for_display(raw_meta)
    for key, value in decoded_metadata.items():
        if isinstance(value, (dict, list)):
            print(f"\nParsed JSON metadata under key '{key}':")
            pprint(value)
        else:
            text = str(value)
            print(f"\nRaw string metadata under key '{key}':")
            print(text[:1000] + ("..." if len(text) > 1000 else ""))

    return decoded_metadata


def _tensor_signature(file_path: Path) -> List[Tuple[str, str, Tuple[int, ...]]]:
    """Return a lightweight tensor structure signature: name, dtype, shape."""
    sig: List[Tuple[str, str, Tuple[int, ...]]] = []
    with safe_open(str(file_path), framework="pt") as f:
        for key in f.keys():
            t = f.get_tensor(key)
            sig.append((key, str(t.dtype), tuple(int(x) for x in t.shape)))
    return sig


def _read_raw_metadata(file_path: Path) -> Dict[str, str]:
    with safe_open(str(file_path), framework="numpy") as f:
        return dict(f.metadata() or {})


def _make_backup(file_path: Path, *, overwrite_backup: bool = True) -> Path:
    backup_path = file_path.with_name(file_path.name + ".bak")
    if backup_path.exists() and not overwrite_backup:
        raise FileExistsError(f"Backup already exists: {backup_path}")
    shutil.copy2(file_path, backup_path)
    return backup_path


def _write_metadata_one_file(
    input_path: Path,
    output_path: Path,
    new_metadata: Dict[str, str],
    *,
    replace_metadata: bool,
    clear_metadata: bool,
    preserve_keys: List[str],
    backup: bool,
    overwrite: bool,
    verify: bool,
) -> None:
    if not input_path.is_file():
        raise FileNotFoundError(f"Input file not found: {input_path}")
    if input_path.suffix != SAFETENSORS_SUFFIX:
        raise ValueError(f"Input is not a .safetensors file: {input_path}")

    same_file = input_path.resolve() == output_path.resolve()
    if output_path.exists() and not same_file and not overwrite:
        raise FileExistsError(f"Output file already exists: {output_path} (use --overwrite)")

    old_sig = _tensor_signature(input_path) if verify else []

    with safe_open(str(input_path), framework="pt") as f:
        tensors = {key: f.get_tensor(key) for key in f.keys()}
        existing_metadata = dict(f.metadata() or {})

    missing_preserve_keys = [key for key in preserve_keys if key not in existing_metadata]
    if missing_preserve_keys:
        print(
            "WARNING: requested preserve keys not found in existing metadata: "
            + ", ".join(missing_preserve_keys),
            file=sys.stderr,
        )

    if clear_metadata or replace_metadata:
        final_metadata: Dict[str, str] = {
            key: existing_metadata[key]
            for key in preserve_keys
            if key in existing_metadata
        }
    else:
        final_metadata = dict(existing_metadata)

    if not clear_metadata:
        # New metadata intentionally wins over preserved metadata when the same key
        # is provided through JSON or CLI overrides. This makes overrides useful.
        final_metadata.update(new_metadata)

    output_path.parent.mkdir(parents=True, exist_ok=True)

    backup_path: Optional[Path] = None
    if same_file and backup:
        backup_path = _make_backup(input_path)

    tmp_dir = output_path.parent if output_path.parent.exists() else Path.cwd()
    tmp_name: Optional[str] = None
    try:
        with tempfile.NamedTemporaryFile(
            prefix=output_path.name + ".tmp.",
            suffix=SAFETENSORS_SUFFIX,
            dir=str(tmp_dir),
            delete=False,
        ) as tmp_fp:
            tmp_name = tmp_fp.name

        tmp_path = Path(tmp_name)
        torch_save_file(tensors, str(tmp_path), metadata=final_metadata)

        if verify:
            new_sig = _tensor_signature(tmp_path)
            if old_sig != new_sig:
                raise RuntimeError("Verification failed: tensor names, dtypes, or shapes changed.")

            written_metadata = _read_raw_metadata(tmp_path)
            if written_metadata != final_metadata:
                raise RuntimeError("Verification failed: written metadata does not match requested metadata.")

        os.replace(str(tmp_path), str(output_path))
    finally:
        if tmp_name:
            tmp_path = Path(tmp_name)
            if tmp_path.exists():
                tmp_path.unlink()

    action = "cleared metadata" if clear_metadata else "wrote metadata"
    print(f"OK: {action}: {output_path}")
    if backup_path:
        print(f"Backup: {backup_path}")


def _collect_safetensors_files(path: Path, *, recursive: bool) -> List[Path]:
    if path.is_file() and path.suffix == SAFETENSORS_SUFFIX:
        return [path]
    if path.is_dir():
        pattern = f"**/*{SAFETENSORS_SUFFIX}" if recursive else f"*{SAFETENSORS_SUFFIX}"
        return sorted(p for p in path.glob(pattern) if p.is_file())
    raise FileNotFoundError(f"Invalid file or directory path: {path}")


def _derive_output_path(input_path: Path, output: Optional[Path], *, multiple_files: bool) -> Path:
    if output is None:
        return input_path
    if multiple_files:
        output.mkdir(parents=True, exist_ok=True)
        return output / input_path.name
    return output


def main(argv: Optional[Iterable[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Read, clear, replace, or add metadata for .safetensors files.")
    parser.add_argument("path", type=Path, help="Path to a .safetensors file or a directory.")
    parser.add_argument("--read", action="store_true", help="Read and print metadata.")
    parser.add_argument("--write-json", type=Path, help="Path to JSON metadata to write.")
    parser.add_argument(
        "--set-meta",
        action="append",
        metavar="KEY=VALUE",
        help=(
            "Set or override one metadata key directly from the command line. "
            "Can be repeated. The value is stored as a plain string."
        ),
    )
    parser.add_argument(
        "--set-meta-json",
        action="append",
        metavar="KEY=JSON_VALUE",
        help=(
            "Set or override one metadata key from a JSON value. Can be repeated. "
            "Example: --set-meta-json config='{\"a\":1}'"
        ),
    )
    parser.add_argument(
        "--preserve-key",
        action="append",
        help=(
            "Existing metadata key to preserve during --replace-metadata or --clear-metadata. "
            "Can be repeated or comma-separated."
        ),
    )
    parser.add_argument(
        "--replace-metadata",
        action="store_true",
        help="Remove existing metadata first, except --preserve-key keys, then write new metadata.",
    )
    parser.add_argument(
        "--clear-metadata",
        action="store_true",
        help="Remove metadata, except --preserve-key keys. Cannot be combined with new metadata input.",
    )
    parser.add_argument(
        "--output",
        type=Path,
        help="Output file path. For directory input, this must be an output directory. Default: in-place.",
    )
    parser.add_argument("--overwrite", action="store_true", help="Overwrite output file if it exists.")
    parser.add_argument("--recursive", action="store_true", help="Recurse into subdirectories for directory input.")
    parser.add_argument("--no-backup", action="store_true", help="Do not create .bak backup for in-place writes.")
    parser.add_argument("--no-verify", action="store_true", help="Skip post-write verification.")

    args = parser.parse_args(list(argv) if argv is not None else None)

    try:
        preserve_keys = _parse_key_list(args.preserve_key)
        cli_json_metadata = _parse_set_metadata_json(args.set_meta_json)
        cli_metadata = _parse_set_metadata(args.set_meta)

        if args.clear_metadata and (args.write_json or cli_json_metadata or cli_metadata):
            raise ValueError("--clear-metadata cannot be combined with --write-json, --set-meta, or --set-meta-json.")

        do_write = bool(args.write_json or args.clear_metadata or cli_json_metadata or cli_metadata)
        if not args.read and not do_write:
            args.read = True

        files = _collect_safetensors_files(args.path, recursive=bool(args.recursive))
        if not files:
            raise FileNotFoundError(f"No .safetensors files found under: {args.path}")

        if args.output and len(files) > 1 and args.output.exists() and not args.output.is_dir():
            raise ValueError("When processing multiple files, --output must be a directory.")

        metadata = _load_metadata_json(args.write_json) if args.write_json else {}
        # CLI values intentionally override JSON values. Plain --set-meta is last,
        # so it can override --set-meta-json too.
        metadata.update(cli_json_metadata)
        metadata.update(cli_metadata)

        if args.read:
            for file_path in files:
                print("\n" + "=" * 80)
                read_sd_metadata(file_path)

        if do_write:
            for file_path in files:
                out_path = _derive_output_path(file_path, args.output, multiple_files=len(files) > 1)
                _write_metadata_one_file(
                    file_path,
                    out_path,
                    metadata,
                    replace_metadata=bool(args.replace_metadata),
                    clear_metadata=bool(args.clear_metadata),
                    preserve_keys=preserve_keys,
                    backup=not bool(args.no_backup),
                    overwrite=bool(args.overwrite),
                    verify=not bool(args.no_verify),
                )

    except Exception as e:
        print(f"ERROR: {e}", file=sys.stderr)
        return 2

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
