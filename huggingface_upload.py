import argparse
import hashlib
import os
import json
import logging
from huggingface_hub import HfApi
from tqdm import tqdm
import concurrent.futures
import time
import threading



def get_args():
    parser = argparse.ArgumentParser(description="Upload files to Hugging Face")
    parser.add_argument("--configurations", required=True,
                        help="Configuration file with list of files and base directory")
    parser.add_argument("--repository", required=True, help="Repository on huggingface.com")
    parser.add_argument("--token", required=True, help="File containing your Hugging Face token")
    parser.add_argument("--remove", action="store_true", help="Remove files after upload")
    return parser.parse_args()

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

def compute_sha256(filepath, chunk_size=8192):
    """Compute the sha256 hash of a file."""
    hash_sha256 = hashlib.sha256()
    with open(filepath, "rb") as f:
        for chunk in iter(lambda: f.read(chunk_size), b""):
            hash_sha256.update(chunk)
    return hash_sha256.hexdigest()

def upload_file(filepath, base_directory, repo_id, token, api, progress_bar, progress_bar_lock, max_attempts=3, remove=False):
    filename = os.path.basename(filepath)
    readable_hash = ""

    # Compute the path in the repository by removing the base directory
    path_in_repo = os.path.relpath(filepath, base_directory)

    readable_hash = compute_sha256(filepath)

    for attempt in range(1, max_attempts + 1):
        try:
            logger.info(
                f"Attempt {attempt}: Uploading to HF: huggingface.co/{repo_id}/{path_in_repo}, sha256: {readable_hash}")

            with open(filepath, "rb") as file:
                response = api.upload_file(
                    path_or_fileobj=file,
                    path_in_repo=path_in_repo,
                    repo_id=repo_id,
                    repo_type=None,
                    token=token,
                    create_pr=True,
                )

            # Update progress bar
            with progress_bar_lock:
                progress_bar.update(os.path.getsize(filepath))

            # Check if the upload was successful
            if response and isinstance(response, str) and response.startswith("https://"):
                logger.info(f"File {filepath} uploaded successfully.")

                # If remove flag is set, remove the file locally
                if remove:
                    os.remove(filepath)
                    logger.info(f"File {filepath} deleted locally.")
            else:
                logger.info(f"Failed to upload file {filepath}.")

            break
        except Exception as e:
            logger.info(f"Error uploading {filename}: {e}")
            if attempt == max_attempts:
                logger.info(f"Failed to upload {filename} after {max_attempts} attempts")


def upload_files(args):
    # Read configurations
    with open(args.configurations, 'r') as config_file:
        config = json.load(config_file)

    base_directory = config.get('base_directory')
    file_list = config.get('files', [])

    with open(args.token, "r") as token_file:
        token = token_file.read().strip()

    api = HfApi()
    repo_id = args.repository


    # Calculate total size of all files
    total_size = sum(os.path.getsize(filepath) for filepath in file_list)

    # Create a progress bar
    progress_bar = tqdm(total=total_size, unit="GB", unit_scale=True)

    # Create a lock for progress bar
    progress_bar_lock = threading.Lock()

    # Use ThreadPoolExecutor to parallelize the uploads
    with concurrent.futures.ThreadPoolExecutor(max_workers=5) as executor:
        futures = [
            # pass the progress_bar to the upload_file function
            executor.submit(upload_file, filepath, base_directory, repo_id, token, api, progress_bar,
                            progress_bar_lock, remove=args.remove)
            for filepath in file_list
        ]
        for future in concurrent.futures.as_completed(futures):
            future.result()

    logger.info("DONE")
    logger.info("Go to your repo and accept the PRs this created to see your files")


def main():
    args = get_args()
    upload_files(args)


if __name__ == "__main__":
    main()

# Example Usage:
# python3 huggingface_upload.py --configurations "huggingface_upload_settings.json" --repository "your_username/your_repository" --token "token_file.txt"
# Use --remove to remove files after upload, for example:
# python3 huggingface_upload.py --configurations "huggingface_upload_settings.json" --repository "your_username/your_repository" --token "token_file.txt" --remove
