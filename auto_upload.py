import os
import time
import argparse
import json
import requests
from huggingface_hub import HfApi


def print_error(message):
    """Prints the message in red."""
    print(f"\033[91m{message}\033[0m")


def upload_file_to_hf(file_path, hfuser, hfrepo, hffolder, max_attempts=3):
    api = HfApi()
    repo_id = f"{hfuser}/{hfrepo}"

    for attempt in range(1, max_attempts + 1):
        try:
            print(f"Attempt {attempt}: Uploading {file_path} to HF: huggingface.co/{repo_id}/{hffolder}/")

            response = api.upload_file(
                path_or_fileobj=file_path,
                path_in_repo=f"{hffolder}/{os.path.basename(file_path)}",
                repo_id=repo_id,
                repo_type=None,
                create_pr=1,
            )

            print(f"Upload successful for {file_path}")
            return True  # Success flag

        except requests.exceptions.RequestException as req_err:
            # Handle network-related errors (e.g., DNS failure, refused connection)
            print_error(f"Network error while uploading {file_path}: {req_err}")
        except Exception as e:
            # Handle other types of exceptions
            print_error(f"Error uploading {file_path}: {e}")

        # If reached the maximum attempts without success
        if attempt == max_attempts:
            print_error(f"Failed to upload {file_path} after {max_attempts} attempts")
            return False

    return False  # Failed all attempts


def monitor_and_upload(base_dir, hfuser, hfrepo, hffolder, N=3, sleep_interval=15 * 60, max_attempts=3):
    if not os.path.exists(base_dir):
        print_error(f"The provided base directory '{base_dir}' does not exist.")
        return

    # Set to track uploaded files
    uploaded_files_list = []

    while True:
        # Create a list to track all the ckpt and safetensors files
        all_files = []

        # Walk through the base directory to locate all the ckpt and safetensors files
        for dirpath, _, filenames in os.walk(base_dir):
            for file in filenames:
                if file.endswith('.ckpt') or file.endswith('.safetensors'):
                    all_files.append(os.path.join(dirpath, file))

        # Sort files by modification time
        all_files.sort(key=lambda x: os.path.getmtime(x), reverse=True)

        all_uploaded = True  # Assume all files are uploaded

        # Upload all files not in the uploaded_files_list and delete the ones that aren't the latest N
        for idx, file in enumerate(all_files):
            if file not in uploaded_files_list:
                all_uploaded = False  # File not uploaded, set the flag to False
                success = upload_file_to_hf(
                    file,
                    hfuser,
                    hfrepo,
                    hffolder,
                    max_attempts
                )
                if success:
                    uploaded_files_list.append(file)

        while N < len(uploaded_files_list):
            try:
                uploaded_files_list.sort(key=lambda x: os.path.getmtime(x))
                oldest_file = uploaded_files_list[0]  # Get the last item (oldest file)
                print(f"Deleting file {oldest_file}\r", end="")
                os.remove(oldest_file)
                uploaded_files_list.remove(oldest_file)  # Remove from set after deleting
            except Exception as e:
                print_error(f"Error deleting {oldest_file}: {e}")

        # If all files are uploaded, then sleep
        if all_uploaded:
            print(f"Next cleanup in {sleep_interval} seconds... Press CTRL+C to terminate the script.\r", end="")
            time.sleep(sleep_interval)


def load_settings_from_json(json_path):
    with open(json_path, 'r') as f:
        return json.load(f)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description='Monitor and upload files to HuggingFace Hub.')

    parser.add_argument('--settings_json', type=str, help='Path to the settings JSON file')
    parser.add_argument('--base_dir', type=str, help='Base directory to monitor for ckpt and safetensors files')
    parser.add_argument('--hfuser', type=str, help='HuggingFace username')
    parser.add_argument('--hfrepo', type=str, help='HuggingFace repository name')
    parser.add_argument('--hffolder', type=str, help='Folder name in the HuggingFace repository')
    parser.add_argument('--N', type=int, help='Number of recent files to keep')
    parser.add_argument('--sleep_interval', type=int, help='Sleep interval in seconds between cleanup cycles')
    parser.add_argument('--max_attempts', type=int, help='Maximum attempts to upload a file to HuggingFace')

    args = parser.parse_args()

    settings = {}
    if args.settings_json:
        settings = load_settings_from_json(args.settings_json)

    # Override settings with command-line arguments if provided
    base_dir = args.base_dir or settings.get('base_dir')
    hfuser = args.hfuser or settings.get('hfuser')
    hfrepo = args.hfrepo or settings.get('hfrepo')
    hffolder = args.hffolder or settings.get('hffolder')
    N = args.N or settings.get('N', 1)
    sleep_interval = args.sleep_interval or settings.get('sleep_interval', 15 * 60)
    max_attempts = args.max_attempts or settings.get('max_attempts', 3)

    monitor_and_upload(base_dir, hfuser, hfrepo, hffolder, N, sleep_interval, max_attempts)