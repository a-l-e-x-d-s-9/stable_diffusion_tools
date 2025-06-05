import argparse
import os
import json
from safetensors import safe_open
from safetensors.torch import save_file as torch_save_file


def read_sd_metadata(file_path):
    import json
    from pprint import pprint

    with safe_open(file_path, framework="numpy") as f:
        raw_meta = f.metadata()
        print(f"📂 Metadata for: {file_path}")
        print(f"🔑 Raw metadata keys: {list(raw_meta.keys())}")

        if not raw_meta:
            print("ℹ️ No metadata found.")
            return {"note": "No metadata found.", "tensor_keys amount": len(f.keys())}

        decoded_metadata = {}
        for key, value in raw_meta.items():
            if isinstance(value, str):
                try:
                    decoded = json.loads(value)
                    decoded_metadata[key] = decoded
                    print(f"\n📘 Parsed JSON metadata under key '{key}':")
                    pprint(decoded if isinstance(decoded, dict) else {"value": decoded})
                except json.JSONDecodeError:
                    print(f"\n📝 Raw string metadata under key '{key}':")
                    print(value[:300] + "..." if len(value) > 300 else value)
                    decoded_metadata[key] = value
            else:
                print(f"\n⚠️ Unexpected non-string metadata at key '{key}': {value}")
                decoded_metadata[key] = value

        return decoded_metadata


def write_metadata_from_json(file_path, json_metadata):
    import torch  # required by safetensors.torch

    with safe_open(file_path, framework="pt") as f:
        tensors = {key: f.get_tensor(key) for key in f.keys()}
        existing_metadata = dict(f.metadata())

    # Store each key at top level (ComfyUI style)
    for k, v in json_metadata.items():
        existing_metadata[str(k)] = str(v)

    torch_save_file(tensors, file_path, metadata=existing_metadata)
    print(f"✅ Metadata written to: {file_path}")

def load_metadata_json(json_path):
    with open(json_path, 'r', encoding='utf-8') as f:
        data = json.load(f)
    if not isinstance(data, dict):
        raise ValueError("Metadata JSON must be a dictionary of key-value pairs.")
    return {str(k): str(v) for k, v in data.items()}

def main():
    parser = argparse.ArgumentParser(description="Read/write metadata for .safetensors files.")
    parser.add_argument("path", help="Path to .safetensors file or a directory.")
    parser.add_argument("--read", action="store_true", help="Read and print metadata.")
    parser.add_argument("--write-json", help="Path to JSON file containing metadata to write.")

    args = parser.parse_args()

    if os.path.isfile(args.path) and args.path.endswith(".safetensors"):
        files = [args.path]
    elif os.path.isdir(args.path):
        files = [
            os.path.join(args.path, f)
            for f in os.listdir(args.path)
            if f.endswith(".safetensors")
        ]
    else:
        print("Invalid file or directory path.")
        return

    if args.read:
        for file in files:
            print(f"\nMetadata for: {file}")
            metadata = read_sd_metadata(file)
            for k, v in metadata.items():
                print(f"  {k}: {v}")

    if args.write_json:
        metadata = load_metadata_json(args.write_json)
        for file in files:
            write_metadata_from_json(file, metadata)

if __name__ == "__main__":
    main()
