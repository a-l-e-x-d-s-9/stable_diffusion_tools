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
    """Compute the SHA256 hash of a file, using a cached hash file if available."""
    hash_file = file_path + ".hash256"

    # If hash file exists, read the hash from it
    if os.path.exists(hash_file):
        with open(hash_file, "r") as f:
            return f.read().strip()

    # Compute the hash if not cached
    hasher = hashlib.sha256()
    with open(file_path, "rb") as f:
        while chunk := f.read(8192):
            hasher.update(chunk)
    file_hash = hasher.hexdigest()

    # Save the hash to a file for future use
    with open(hash_file, "w") as f:
        f.write(file_hash)

    return file_hash


def sync_with_huggingface(username, token, output_json, resume=False):
    """Fetch all file hashes from Hugging Face repositories and save incrementally."""
    api = HfApi()
    repo_hashes = {}

    # Load existing progress if resume is enabled
    if resume:
        if os.path.exists(output_json):
            with open(output_json, "r") as f:
                repo_hashes = json.load(f)
        else:
            print(f"Resume mode enabled, but {output_json} does not exist. Starting fresh.")
            repo_hashes = {}

    repos = list(api.list_models(author=username, token=token))
    repos += list(api.list_datasets(author=username, token=token))
    repos += list(api.list_spaces(author=username, token=token))

    total_repos = len(repos)
    print(f"Total repositories to scan: {total_repos}")

    for i, repo in enumerate(repos, start=1):
        repo_id = repo.id if hasattr(repo, 'id') else repo.modelId  # Handle different repo types
        repo_type = "dataset" if isinstance(repo, DatasetInfo) else "model"
        if isinstance(repo, SpaceInfo):
            repo_type = "space"

        # Skip already scanned repositories in resume mode
        if resume and repo_id in repo_hashes:
            sys.stdout.write(f"\rSkipping ({i}/{total_repos}) - {repo_id} (already scanned)     ")
            sys.stdout.flush()
            continue

        # Progress update in the same line
        sys.stdout.write(f"\rScanning ({i}/{total_repos}) - {repo_id} [{repo_type}]...     ")
        sys.stdout.flush()

        try:
            file_metadata = api.repo_info(repo_id=repo_id, repo_type=repo_type, token=token, files_metadata=True)
            repo_data = {}
            for entry in file_metadata.siblings:
                if hasattr(entry, "lfs") and isinstance(entry.lfs, dict) and "sha256" in entry.lfs:
                    repo_data[entry.rfilename] = entry.lfs["sha256"]

            # Save repo data only after a successful scan
            repo_hashes[repo_id] = repo_data

            # Save JSON incrementally after each repo
            with open(output_json, "w") as f:
                json.dump(repo_hashes, f, indent=4)

        except Exception as e:
            print(f"\nError fetching metadata for {repo_id}: {e}")

    print("\nHashes synchronized successfully!")


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