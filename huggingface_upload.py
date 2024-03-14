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
from tqdm.contrib.concurrent import thread_map
import queue
import psutil
from collections import deque
from threading import Lock
import glob

progress_updates = queue.Queue()


stdout_lock = Lock()
progress_estimation_lock = Lock()

class SpeedMonitor(threading.Thread):
    def __init__(self, interval=1):
        super().__init__(daemon=True)
        self.interval = interval
        self.history = deque(maxlen=15)
        self.running = True
        self.speed_pbar = tqdm(total=31, bar_format='{l_bar}{bar}| Upload speed: {n:.2f} MB/s', ncols=160, colour='green')  # Speed progress bar

    def run(self):
        old_value = psutil.net_io_counters().bytes_sent
        while self.running:
            time.sleep(self.interval)
            new_value = psutil.net_io_counters().bytes_sent
            self.history.append(new_value - old_value)
            old_value = new_value
            if len(self.history) == self.history.maxlen:
                speed = sum(self.history) / len(self.history) / self.interval / 1024 / 1024
                self.speed_pbar.n = speed
                if self.speed_pbar.total is not None:
                    self.speed_pbar.refresh()

    def stop(self):
        self.running = False
        self.speed_pbar.close()


class UploadMonitor(threading.Thread):
    def __init__(self):
        super().__init__(daemon=True)
        self.total_size = 0  # Total file size to be uploaded
        self.uploaded_size = 0  # File size uploaded so far
        self.upload_pbar = tqdm(total=self.total_size / (1024 * 1024), unit='MB',
                                bar_format='{l_bar}{bar}| {n:,.1f}/{total:,.1f} MB, ETA: {remaining}',
                                ncols=160,
                                colour='yellow')  # Upload progress bar

        self.speed_bytes = 0  # Upload speed
        self.running = False
        self.upload_efficiency = 0.90

    def run(self):
        self.running = True
        old_value = psutil.net_io_counters().bytes_sent
        while self.running:
            time.sleep(1)
            new_value = psutil.net_io_counters().bytes_sent
            self.speed_bytes = (new_value - old_value) * self.upload_efficiency  # Calculate the speed in Bytes/s
            self.uploaded_size += self.speed_bytes  # Update uploaded size based on current speed
            old_value = new_value

            with progress_estimation_lock:
                self.uploaded_size = min(self.uploaded_size,
                                         self.total_size)  # Clamp uploaded size to not exceed total size

                self.upload_pbar.n = self.uploaded_size / (
                            1024 * 1024)  # Convert uploaded size to MB when updating progress bar
                self.upload_pbar.total = self.total_size / (
                            1024 * 1024)  # Convert total size to MB when updating progress bar

                if self.upload_pbar.n is not None and self.upload_pbar.total is not None:
                    if self.upload_pbar.n > 0 and self.upload_pbar.total > 0:
                        try:
                            self.upload_pbar.refresh()
                        except TypeError as e:
                            print(f"Error during refresh: {e}")
                            print(f"Current state of the progress bar: {vars(self.upload_pbar)}")

    def stop(self):
        self.running = False
        self.upload_pbar.close()

    def add_file(self, file_size):
        # Call this method whenever a new file starts to upload
        self.total_size += file_size
        self.total_size = max(self.total_size, 0)  # Make sure total size is not negative

        with progress_estimation_lock:
            self.upload_pbar.total = self.total_size / 1024 / 1024

            self.upload_pbar.refresh()

    def finish_file(self, file_size):
        # Call this method whenever a file finishes uploading
        self.total_size = max(0, self.total_size - file_size)
        self.uploaded_size = max(0, self.uploaded_size - file_size)

        with progress_estimation_lock:
            self.upload_pbar.n = self.uploaded_size / (1024 * 1024)
            self.upload_pbar.total = self.total_size / 1024 / 1024

            self.upload_pbar.refresh()

    def set_speed(self, speed):
        # Update the upload speed
        self.speed_bytes = speed


upload_monitor = UploadMonitor()

def get_args():
    parser = argparse.ArgumentParser(description="Upload files to Hugging Face")
    parser.add_argument("--configurations", required=True,
                        help="Configuration file with list of files and their target paths in the repository")
    parser.add_argument("--repository", required=False, help="Repository on huggingface.com")
    parser.add_argument("--token_file", required=False, help="File containing your Hugging Face token")
    parser.add_argument("--remove", action="store_true", help="Remove files after upload")
    parser.add_argument("--threads", type=int, default=3, help='Number of threads for parallel processing.')
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

def upload_file(filepath, path_in_repository, repo_id, token, api, progress_bar_lock, max_attempts=3, remove=False):
    filename = os.path.basename(filepath)
    file_size = os.path.getsize(filepath)

    # Use the explicit path in the repository provided
    path_in_repo = os.path.join(path_in_repository, filename)

    # Add file size to upload monitor
    upload_monitor.add_file(file_size)

    for attempt in range(1, max_attempts + 1):
        try:

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
                progress_updates.put(file_size)
                upload_monitor.finish_file(file_size)  # Mark file as finished in upload monitor

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
            logger.exception(f"Error uploading {filename}: {e}")
            if attempt == max_attempts:
                logger.exception(f"Failed to upload {filename} after {max_attempts} attempts")
                break

    upload_monitor.finish_file(file_size)  # Update uploaded size in upload monitor


def upload_files(args, path_in_repository, valid_files_paths):

    try:
        with open(args.token_file, "r") as token_file:
            token = token_file.read().strip()
    except Exception as e:
        logger.exception(f"Token file {args.token_file}: {e}")
        return

    api = HfApi()
    repo_id = args.repository
    progress_bar_lock = Lock()

    upload_func = lambda filepath: upload_file(filepath, path_in_repository, repo_id, token, api, progress_bar_lock, remove=args.remove)

    # Use thread_map function to parallelize the uploads
    thread_map(upload_func, valid_files_paths, max_workers=args.threads)

    # Signal that uploads are done
    progress_updates.put(None)

    logger.info("DONE")
    logger.info("Go to your repo and accept the PRs this created to see your files")



def manage_progress_bar(progress_bar):
    while True:
        update = progress_updates.get()
        if update is None:
            break
        with stdout_lock:  # acquire the lock before updating
            progress_bar.update(update)


def main():
    args = get_args()
    if args.threads <= 0:
        logger.error("Number of threads must be greater than zero.")
        return

    speed_monitor = SpeedMonitor()
    speed_monitor.start()
    upload_monitor.start()

    try:
        with open(args.configurations, 'r') as config_file:
            config = json.load(config_file)
    except Exception as e:
        logger.exception(f"Configurations file {config_file}: {e}")
        return

    path_in_repository = config.get('path_in_repository')
    file_list = config.get('files', [])
    expanded_file_list = []
    for file_pattern in file_list:
        if file_pattern.startswith("*"):
            # Assuming the path is relative to the current working directory
            # or an absolute path is provided in the pattern.
            for filepath in glob.glob(file_pattern):
                expanded_file_list.append(filepath)
        else:
            expanded_file_list.append(file_pattern)

    # Ensure file paths are unique before proceeding
    valid_files_paths = list(set(expanded_file_list))


    if 'repository' in config and not args.repository:
        args.repository = config['repository']
    if 'token_file' in config and not args.token_file:
        args.token_file = config['token_file']

    if not args.repository:
        logger.error("Repository not specified in either command line or JSON settings.")
        return

    if not args.token_file:
        logger.error("Token not specified in either command line or JSON settings.")
        return

    total_size = 0
    valid_files_paths = []
    for filepath in valid_files_paths:
        if os.path.isfile(filepath):
            total_size += os.path.getsize(filepath)
            valid_files_paths.append(filepath)
        else:
            logger.warning(f"File {filepath} does not exist.")

    progress_bar = tqdm(total=total_size, unit="MB", unit_scale=True, ncols=160, colour='red')

    thread_manage_progress_bar = threading.Thread(target=manage_progress_bar, args=(progress_bar,), daemon=True)
    thread_manage_progress_bar.start()

    upload_files(args, path_in_repository, valid_files_paths)

    # Wait for manage_progress_bar thread to finish
    thread_manage_progress_bar.join()

    speed_monitor.stop()
    upload_monitor.stop()


if __name__ == "__main__":
    main()

# Example Usage:
# python3 huggingface_upload.py --configurations "huggingface_upload_settings.json" --repository "your_username/your_repository" --token_file "token_file.txt"
# Use --remove to remove files after upload, for example:
# python3 huggingface_upload.py --configurations "huggingface_upload_settings.json" --repository "your_username/your_repository" --token_file "token_file.txt" --remove
