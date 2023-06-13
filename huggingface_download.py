import argparse
import os
from huggingface_hub import hf_hub_download

def read_token_from_file(token_file_path):
    with open(token_file_path, 'r') as file:
        return file.read().strip()

def download_file_from_huggingface(repo_id, file_path, token=None, local_dir=None):
    try:
        # Downloading the file using hf_hub_download
        downloaded_data_path = hf_hub_download(
            repo_id=repo_id,
            filename=file_path,
            token=token,
            local_dir=local_dir,
            local_dir_use_symlinks=False
        )
        print(f'File downloaded successfully to: {downloaded_data_path}')
    except Exception as e:
        print(f'An error occurred while downloading the file: {str(e)}')

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description='Download a file from a HuggingFace repository.')
    parser.add_argument('--repo_id', type=str, required=True, help='Repository ID in HuggingFace.')
    parser.add_argument('--file_path', type=str, required=True, help='Path to the file in the repository.')
    parser.add_argument('--token', type=str, help='Path to the token file for private repositories.')
    parser.add_argument('--local_dir', type=str, default=".", help='Path to local directory to save the file.')

    args = parser.parse_args()

    if args.token:
        token = read_token_from_file(args.token)
    else:
        token = None

    download_file_from_huggingface(args.repo_id, args.file_path, token, args.local_dir)


# python3 huggingface_download.py --repo_id="username/Dreambooth" --file_path="filename.zip" --token="/path/read_token.secret" --local_dir "/path_local/"