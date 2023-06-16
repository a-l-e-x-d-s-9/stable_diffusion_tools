import argparse
import hashlib
import os
import json
from huggingface_hub import HfApi
from tqdm import tqdm
import io
import concurrent.futures


class TqdmFileReader(io.BufferedIOBase):
    def __init__(self, file):
        super().__init__()
        self.file = file
        self.progress_bar = tqdm(total=os.path.getsize(file.name), unit="B", unit_scale=True)

    def read(self, size=-1):
        data = self.file.read(size)
        self.progress_bar.update(len(data))
        return data

    def seek(self, offset, whence=io.SEEK_SET):
        result = self.file.seek(offset, whence)
        return result

    def tell(self):
        return self.file.tell()

    def close(self):
        self.progress_bar.close()
        self.file.close()


def get_args():
    parser = argparse.ArgumentParser(description="Upload files to Hugging Face")
    parser.add_argument("--configurations", required=True,
                        help="Configuration file with list of files and base directory")
    parser.add_argument("--repository", required=True, help="Repository on huggingface.com")
    parser.add_argument("--token", required=True, help="File containing your Hugging Face token")
    parser.add_argument("--remove", action="store_true", help="Remove files after upload")
    return parser.parse_args()


def upload_file(filepath, base_directory, repo_id, token, api, max_attempts=3, remove=False):
    filename = os.path.basename(filepath)
    readable_hash = ""

    # Compute the path in the repository by removing the base directory
    path_in_repo = os.path.relpath(filepath, base_directory)

    with open(filepath, "rb") as f:
        bytes = f.read()
        readable_hash = hashlib.sha256(bytes).hexdigest()

    for attempt in range(1, max_attempts + 1):
        try:
            print(
                f"Attempt {attempt}: Uploading to HF: huggingface.co/{repo_id}/{path_in_repo}, sha256: {readable_hash}")

            with open(filepath, "rb") as file:
                tqdm_file = TqdmFileReader(file)


                response = api.upload_file(
                    path_or_fileobj=tqdm_file,
                    path_in_repo=path_in_repo,
                    repo_id=repo_id,
                    repo_type=None,
                    token=token,
                    create_pr=True,
                )
            print(response)

            # Check if the upload was successful
            if response and isinstance(response, str) and response.startswith("https://"):
                print(f"File {filepath} uploaded successfully.")

                # If remove flag is set, remove the file locally
                if remove:
                    os.remove(filepath)
                    print(f"File {filepath} deleted locally.")
            else:
                print(f"Failed to upload file {filepath}.")

            break
        except Exception as e:
            print(f"Error uploading {filename}: {e}")
            if attempt == max_attempts:
                print(f"Failed to upload {filename} after {max_attempts} attempts")

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

    # Use ThreadPoolExecutor to parallelize the uploads
    with concurrent.futures.ThreadPoolExecutor(max_workers=5) as executor:
        futures = [
            executor.submit(upload_file, filepath, base_directory, repo_id, token, api, remove=args.remove)
            for filepath in file_list
        ]
        for future in concurrent.futures.as_completed(futures):
            future.result()

    print("DONE")
    print("Go to your repo and accept the PRs this created to see your files")


def main():
    args = get_args()
    upload_files(args)


if __name__ == "__main__":
    main()

# Example Usage:
# python3 huggingface_upload.py --configurations "huggingface_upload_settings.json" --repository "your_username/your_repository" --token "token_file.txt"
# Use --remove to remove files after upload, for example:
# python3 huggingface_upload.py --configurations "huggingface_upload_settings.json" --repository "your_username/your_repository" --token "token_file.txt" --remove
