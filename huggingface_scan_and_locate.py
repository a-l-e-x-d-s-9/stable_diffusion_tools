import argparse
import hashlib
import json
import os
import sys
from huggingface_hub import HfApi, DatasetInfo, SpaceInfo

# ANSI color codes for terminal output
RED = "\033[91m"
RESET = "\033[0m"


def load_config(config_path):
    """Load Hugging Face username and token from a JSON configuration file."""
    with open(config_path, "r") as f:
        config = json.load(f)
    return config.get("username"), config.get("token")


def compute_file_hash(file_path):
    """Compute the SHA256 hash of a file efficiently by checking metadata first."""
    hash_file = file_path + ".hash256"

    file_mtime = os.path.getmtime(file_path)  # When file was last modified

    # Check if cached hash file exists
    if os.path.exists(hash_file):
        hash_mtime = os.path.getmtime(hash_file)  # When hash was last generated

        # If file hasn't changed, return the cached hash
        if file_mtime <= hash_mtime:
            with open(hash_file, "r") as f:
                return f.read().strip()

    # Compute hash since file was modified or no cached hash exists
    hasher = hashlib.sha256()
    with open(file_path, "rb") as f:
        while chunk := f.read(8192):
            hasher.update(chunk)

    file_hash = hasher.hexdigest()

    # Save the hash with an updated timestamp
    with open(hash_file, "w") as f:
        f.write(file_hash)

    # Update hash file timestamp to match the scanned file
    os.utime(hash_file, (file_mtime, file_mtime))

    return file_hash


def scan_and_report(local_folder, hash_json, only_missing):
    """Scan local files and report their presence on Hugging Face."""
    with open(hash_json, "r") as f:
        repo_hashes = json.load(f)

    tracked_extensions = {".safetensors", ".ckpt"}

    for root, _, files in os.walk(local_folder):
        for file in files:
            if not any(file.endswith(ext) for ext in tracked_extensions):
                continue
            file_path = os.path.join(root, file)
            file_hash = compute_file_hash(file_path)

            locations = [f"{repo}/{filename}" for repo, files in repo_hashes.items() for filename, h in files.items() if
                         h == file_hash]

            if locations:
                if not only_missing:
                    print(f"{file}: {file_path} - Found in Hugging Face: {locations[0]}")
            else:
                print(f"{RED}{file}: {file_path} - NOT found in Hugging Face!{RESET}")


def scan_and_make_download_script(local_folder, hash_json, remove_found):
    """Generate a download script for files found on Hugging Face and optionally remove local copies."""
    with open(hash_json, "r") as f:
        repo_hashes = json.load(f)

    tracked_extensions = {".safetensors", ".ckpt"}

    for root, _, files in os.walk(local_folder):
        script_path = os.path.join(root, "download_all.sh")
        existing_lines = set()

        # Load existing script if present
        if os.path.exists(script_path):
            with open(script_path, "r") as script:
                existing_lines = set(script.readlines())

        with open(script_path, "w") as script:
            script.write("#!/usr/bin/env bash\n")
            script.write("HF_TOKEN=`cat ~/stable-diffusion-webui/models/Stable-diffusion/hf_token`\n")
            script.write("HEADER=\"Authorization: Bearer ${HF_TOKEN}\"\n")

            for file in files:
                if not any(file.endswith(ext) for ext in tracked_extensions):
                    continue
                file_path = os.path.join(root, file)
                file_hash = compute_file_hash(file_path)

                locations = [f"https://huggingface.co/{repo}/resolve/main/{filename}" for repo, files in
                             repo_hashes.items() for filename, h in files.items() if h == file_hash]

                if locations:
                    download_line = f"wget --header=\"$HEADER\" \"{locations[0]}\"\n"

                    if download_line not in existing_lines:
                        script.write(download_line)
                        existing_lines.add(download_line)

                    if remove_found:
                        os.remove(file_path)
                        print(f"Removed: {file_path}")

        os.chmod(script_path, 0o755)
        print(f"Download script updated: {script_path}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Hugging Face File Management Script")
    parser.add_argument("--config", required=True, help="Path to JSON config file with username and token")
    parser.add_argument("--mode", required=True, choices=["sync", "scan_report", "scan_download"], help="Working mode")
    parser.add_argument("--local-folder", help="Local folder to scan")
    parser.add_argument("--hash-json", default="huggingface_hashes.json", help="Path to stored hashes JSON")
    parser.add_argument("--only-missing", action="store_true", help="Only show missing files in scan report")
    parser.add_argument("--remove-found", action="store_true",
                        help="Remove files found in Hugging Face after generating download script")
    parser.add_argument("--resume", action="store_true", help="Resume scanning from the last checkpoint")

    args = parser.parse_args()

    username, token = load_config(args.config)

    if args.mode == "sync":
        sync_with_huggingface(username, token, args.hash_json, args.resume)
    elif args.mode == "scan_report":
        if not args.local_folder:
            print("--local-folder is required for scan_report mode.")
            sys.exit(1)
        scan_and_report(args.local_folder, args.hash_json, args.only_missing)
    elif args.mode == "scan_download":
        if not args.local_folder:
            print("--local-folder is required for scan_download mode.")
            sys.exit(1)
        scan_and_make_download_script(args.local_folder, args.hash_json, args.remove_found)
