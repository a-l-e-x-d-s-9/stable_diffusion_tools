import os
import argparse
from huggingface_hub import HfApi, hf_hub_url, HfFolder

def download_file_from_huggingface(repo_id, file_path, token=None, revision=None, local_dir=None, use_symlinks='auto'):
    # Ensure token is set if available
    if token:
        os.environ["HUGGINGFACE_TOKEN"] = token

    # Initialize the HfApi
    api = HfApi()

    # Download single file
    local_file_path = api.hf_hub_download(
        repo_id=repo_id,
        filename=file_path,
        revision=revision,
        cache_dir=None,
        local_dir=local_dir,
        local_dir_use_symlinks=use_symlinks
    )

    return local_file_path


def download_repo_from_huggingface(repo_id, token=None, revision=None, allow_patterns=None, ignore_patterns=None, local_dir=None, use_symlinks='auto'):
    # Ensure token is set if available
    if token:
        os.environ["HUGGINGFACE_TOKEN"] = token

    # Initialize the HfApi
    api = HfApi()

    # Download entire repository
    local_repo_path = api.snapshot_download(
        repo_id=repo_id,
        revision=revision,
        cache_dir=None,
        allow_patterns=allow_patterns,
        ignore_patterns=ignore_patterns,
        local_dir=local_dir,
        use_symlinks=use_symlinks
    )

    return local_repo_path


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description='Download files from Huggingface')
    parser.add_argument('--repo_id', required=True, help='Repository ID')
    parser.add_argument('--file_path', help='File path in the repository')
    parser.add_argument('--token', help='Huggingface token')
    parser.add_argument('--revision', help='Revision/branch of the file')
    parser.add_argument('--local_dir', help='Local directory to save the file')
    parser.add_argument('--use_symlinks', default='auto', help='Use symlinks (auto/True/False)')
    parser.add_argument('--allow_patterns', help='Patterns to allow for repository download')
    parser.add_argument('--ignore_patterns', help='Patterns to ignore for repository download')

    args = parser.parse_args()

    if args.file_path:
        local_file_path = download_file_from_huggingface(
            repo_id=args.repo_id,
            file_path=args.file_path,
            token=args.token,
            revision=args.revision,
            local_dir=args.local_dir,
            use_symlinks=args.use_symlinks
        )
        print(f'File downloaded to {local_file_path}')
    else:
        local_repo_path = download_repo_from_huggingface(
            repo_id=args.repo_id,
            token=args.token,
            revision=args.revision,
            allow_patterns=args.allow_patterns,
            ignore_patterns=args.ignore_patterns,
            local_dir=args.local_dir,
            use_symlinks=args.use_symlinks
        )
        print(f'Repository downloaded to {local_repo_path}')


# Example: python huggingface_download.py --repo_id="lysandre/arxiv-nlp" --file_path="config.json" --token="your_token_here"
# Download an entire repository:
# python script.py --repo_id="lysandre/arxiv-nlp" --token="your_token