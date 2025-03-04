import argparse
import hashlib
import json
import os
import sys
from huggingface_hub import HfApi

# ANSI color codes for terminal output
RED = "\033[91m"
RESET = "\033[0m"


def load_config(config_path):
    """Load Hugging Face username and token from a JSON configuration file."""
    with open(config_path, "r") as f:
        config = json.load(f)
    return config.get("username"), config.get("token")


def compute_file_hash(file_path):
    """Compute the SHA256 hash of a file."""
    hasher = hashlib.sha256()
    with open(file_path, "rb") as f:
        while chunk := f.read(8192):
            hasher.update(chunk)
    return hasher.hexdigest()


def sync_with_huggingface(username, token, output_json):
    """Synchronize local data with Hugging Face repositories by fetching file hashes."""
    api = HfApi()
    repo_hashes = {}

    # Fetch repositories of all types for the specified user
    repos = list(api.list_models(author=username, token=token))
    repos += list(api.list_datasets(author=username, token=token))
    repos += list(api.list_spaces(author=username, token=token))

    for repo in repos:
        repo_id = repo.modelId  # For models
        repo_type = "model"
        if hasattr(repo, 'datasetId'):
            repo_id = repo.datasetId  # For datasets
            repo_type = "dataset"
        elif hasattr(repo, 'spaceId'):
            repo_id = repo.spaceId  # For spaces
            repo_type = "space"

        repo_hashes[repo_id] = {}

        try:
            # Fetch repository information with file metadata
            file_metadata = api.repo_info(repo_id=repo_id, repo_type=repo_type, token=token, files_metadata=True)
            for entry in file_metadata.siblings:
                if "lfs" in entry and "sha256" in entry["lfs"]:
                    repo_hashes[repo_id][entry.rfilename] = entry["lfs"]["sha256"]
        except Exception as e:
            print(f"Error fetching metadata for {repo_id}: {e}")

    # Save the collected hashes to a JSON file
    with open(output_json, "w") as f:
        json.dump(repo_hashes, f, indent=4)

    print("Hashes synchronized successfully!")


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
                print(f"{file}: {file_path} - Found in Hugging Face: {locations}")
            else:
                if only_missing:
                    print(f"{RED}{file}: {file_path} - NOT found in Hugging Face!{RESET}")
                else:
                    print(f"{file}: {file_path} - {RED}NOT found in Hugging Face!{RESET}")


def scan_and_make_download_script(local_folder, hash_json, remove_found):
    """Generate a download script for files found on Hugging Face and optionally remove local copies."""
    with open(hash_json, "r") as f:
        repo_hashes = json.load(f)

    tracked_extensions = {".safetensors", ".ckpt"}

    for root, _, files in os.walk(local_folder):
        script_path = os.path.join(root, "download_all.sh")
        with open(script_path, "w") as script:
            script.write("#!/bin/bash\n")

            for file in files:
                if not any(file.endswith(ext) for ext in tracked_extensions):
                    continue
                file_path = os.path.join(root, file)
                file_hash = compute_file_hash(file_path)

                locations = [f"https://huggingface.co/{repo}/resolve/main/{filename}" for repo, files in
                             repo_hashes.items() for filename, h in files.items() if h == file_hash]

                if locations:
                    for url in locations:
                        script.write(f"wget -c {url} -P {root}\n")
                    if remove_found:
                        os.remove(file_path)
                        print(f"Removed: {file_path}")

        os.chmod(script_path, 0o755)
        print(f"Download script created: {script_path}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Hugging Face File Management Script")
    parser.add_argument("--config", required=True, help="Path to JSON config file with username and token")
    parser.add_argument("--mode", required=True, choices=["sync", "scan_report", "scan_download"], help="Working mode")
    parser.add_argument("--local-folder", help="Local folder to scan")
    parser.add_argument("--hash-json", default="huggingface_hashes.json", help="Path to stored hashes JSON")
    parser.add_argument("--only-missing", action="store_true", help="Only show missing files in scan report")
    parser.add_argument("--remove-found", action="store_true",
                        help="Remove files found in Hugging Face after generating download script")

    args = parser.parse_args()

    username, token = load_config(args.config)

    if args.mode == "sync":
        sync_with_huggingface(username, token, args.hash_json)
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

