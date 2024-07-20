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
        self.speed_pbar = tqdm(total=31, bar_format='{l_bar}{bar}| Upload speed: {n:.2f} MB/s', ncols=160, colour='green')

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
        self.total_size = 0
        self.uploaded_size = 0
        self.upload_pbar = tqdm(total=self.total_size / (1024 * 1024), unit='MB',
                                bar_format='{l_bar}{bar}| {n:,.1f}/{total:,.1f} MB, ETA: {remaining}',
                                ncols=160,
                                colour='yellow')
        self.speed_bytes = 0
        self.running = False
        self.upload_efficiency = 0.90

    def run(self):
        self.running = True
        old_value = psutil.net_io_counters().bytes_sent
        while self.running:
            time.sleep(1)
            new_value = psutil.net_io_counters().bytes_sent
            self.speed_bytes = (new_value - old_value) * self.upload_efficiency
            self.uploaded_size += self.speed_bytes
            old_value = new_value
            with progress_estimation_lock:
                self.uploaded_size = min(self.uploaded_size, self.total_size)
                self.upload_pbar.n = self.uploaded_size / (1024 * 1024)
                self.upload_pbar.total = self.total_size / (1024 * 1024)
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
        self.total_size += file_size
        self.total_size = max(self.total_size, 0)
        with progress_estimation_lock:
            self.upload_pbar.total = self.total_size / 1024 / 1024
            self.upload_pbar.refresh()

    def finish_file(self, file_size):
        self.total_size = max(0, self.total_size - file_size)
        self.uploaded_size = max(0, self.uploaded_size - file_size)
        with progress_estimation_lock:
            self.upload_pbar.n = self.uploaded_size / (1024 * 1024)
            self.upload_pbar.total = self.total_size / 1024 / 1024
            self.upload_pbar.refresh()

    def set_speed(self, speed):
        self.speed_bytes = speed

upload_monitor = UploadMonitor()

def get_args():
    parser = argparse.ArgumentParser(description="Upload files to Hugging Face")
    parser.add_argument("--configurations", required=True, help="Configuration file with list of files and their target paths in the repository")
    parser.add_argument("--repository", required=False, help="Repository on huggingface.com")
    parser.add_argument("--token_file", required=False, help="File containing your Hugging Face token")
    parser.add_argument("--remove", action="store_true", help="Remove files after upload")
    parser.add_argument("--threads", type=int, default=3, help='Number of threads for parallel processing.')
    return parser.parse_args()

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

def compute_sha256(filepath, chunk_size=8192):
    hash_sha256 = hashlib.sha256()
    with open(filepath, "rb") as f:
        for chunk in iter(lambda: f.read(chunk_size), b""):
            hash_sha256.update(chunk)
    return hash_sha256.hexdigest()

def upload_file(filepath, path_in_repository, repo_id, token, api, progress_bar_lock, base_source_folder, remove=False):
    relative_path = os.path.relpath(filepath, start=base_source_folder)
    path_in_repo = os.path.join(path_in_repository, relative_path)
    repo_files = api.list_repo_files(repo_id=repo_id, token=token)
    full_path_in_repo = path_in_repo.strip('/')

    if full_path_in_repo in repo_files:
        logger.info(f"File {filepath} already exists in the repository. Skipping upload.")
        return

    for attempt in range(1, 4):
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
            with progress_bar_lock:
                progress_updates.put(os.path.getsize(filepath))
                upload_monitor.finish_file(os.path.getsize(filepath))
            if response and isinstance(response, str) and response.startswith("https://"):
                logger.info(f"File {filepath} uploaded successfully.")
                if remove:
                    os.remove(filepath)
                    logger.info(f"File {filepath} deleted locally.")
            else:
                logger.info(f"Failed to upload file {filepath}.")
            break
        except Exception as e:
            logger.exception(f"Error uploading {filepath}: {e}")
            if attempt == 3:
                logger.exception(f"Failed to upload {filepath} after {attempt} attempts")
                break
    upload_monitor.finish_file(os.path.getsize(filepath))

def upload_files(config, path_in_repository, valid_files_paths, base_source_folder):
    try:
        with open(config['token_file'], "r") as token_file:
            token = token_file.read().strip()
    except Exception as e:
        logger.exception(f"Token file {config['token_file']}: {e}")
        return

    api = HfApi()
    repo_id = config['repository']
    progress_bar_lock = Lock()

    upload_func = lambda filepath: upload_file(filepath, path_in_repository, repo_id, token, api, progress_bar_lock, base_source_folder, remove=config.get('remove', False))

    thread_map(upload_func, valid_files_paths, max_workers=config.get('threads', 3))
    progress_updates.put(None)
    logger.info("DONE")
    logger.info("Go to your repo and accept the PRs this created to see your files")

def manage_progress_bar(progress_bar):
    while True:
        update = progress_updates.get()
        if update is None:
            break
        with stdout_lock:
            progress_bar.update(update)

def main():
    args = get_args()

    # Load configurations from file
    try:
        with open(args.configurations, 'r') as config_file:
            config = json.load(config_file)
    except Exception as e:
        logger.exception(f"Configurations file {args.configurations}: {e}")
        return

    # Override configuration with command-line arguments if provided
    if args.repository:
        config['repository'] = args.repository
    if args.token_file:
        config['token_file'] = args.token_file
    if args.remove:
        config['remove'] = True
    if args.threads:
        config['threads'] = args.threads

    if 'repository' not in config or not config['repository']:
        logger.error("Repository not specified in either command line or JSON settings.")
        return

    if 'token_file' not in config or not config['token_file']:
        logger.error("Token not specified in either command line or JSON settings.")
        return

    speed_monitor = SpeedMonitor()
    speed_monitor.start()
    upload_monitor.start()

    total_size = 0
    all_valid_files_paths = []

    for source_config in config['sources']:
        base_source_folder = source_config['source_base']
        path_in_repository = source_config['path_in_repository']
        file_patterns = source_config['files']

        expanded_file_list = []
        for file_pattern in file_patterns:
            matched_files = glob.glob(os.path.join(base_source_folder, file_pattern), recursive=True)
            expanded_file_list.extend(matched_files)

        expanded_file_list = list(set(expanded_file_list))

        valid_files_paths = []
        for filepath in expanded_file_list:
            if os.path.isfile(filepath):
                total_size += os.path.getsize(filepath)
                valid_files_paths.append(filepath)
            else:
                logger.warning(f"File {filepath} does not exist.")

        all_valid_files_paths.append((path_in_repository, valid_files_paths, base_source_folder))

    progress_bar = tqdm(total=total_size, unit="MB", unit_scale=True, ncols=160, colour='red')

    thread_manage_progress_bar = threading.Thread(target=manage_progress_bar, args=(progress_bar,), daemon=True)
    thread_manage_progress_bar.start()

    for path_in_repository, valid_files_paths, base_source_folder in all_valid_files_paths:
        upload_files(config, path_in_repository, valid_files_paths, base_source_folder)

    thread_manage_progress_bar.join()

    speed_monitor.stop()
    upload_monitor.stop()

if __name__ == "__main__":
    main()

# Example Usage:
# python3 huggingface_upload.py --configurations "huggingface_upload_settings.json" --repository "your_username/your_repository" --token_file "token_file.txt"
# Use --remove to remove files after upload, for example:
# python3 huggingface_upload.py --configurations "huggingface_upload_settings.json" --repository "your_username/your_repository" --token_file "token_file.txt" --remove
