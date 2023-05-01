import argparse
import glob
import hashlib
from huggingface_hub import HfApi

def get_args():
    parser = argparse.ArgumentParser(description="Upload files to Hugging Face")
    parser.add_argument("files", nargs="+", help="File(s) to upload")
    parser.add_argument("repository", help="Repository on huggingface.com")
    parser.add_argument("path", help="Path in the repository")
    parser.add_argument("token", help="File containing your Hugging Face token")
    return parser.parse_args()

def upload_files(args):
    with open(args.token, "r") as token_file:
        token = token_file.read().strip()

    api = HfApi()
    repo_id = args.repository
    max_attempts = 3

    for filepath in args.files:
        readable_hash = ""

        with open(filepath, "rb") as f:
            bytes = f.read()
            readable_hash = hashlib.sha256(bytes).hexdigest()
            print(f"# sha256: {readable_hash}")

        for attempt in range(1, max_attempts + 1):
            try:
                print(f"Attempt {attempt}: Uploading to HF: huggingface.co/{repo_id}/{args.path}/{filepath}, sha256: {readable_hash}")
                response = api.upload_file(
                    path_or_fileobj=filepath,
                    path_in_repo=f"{args.path}/{filepath}",
                    repo_id=repo_id,
                    repo_type=None,
                    token=token,
                    create_pr=1,
                )
                print(response)
                print(f"Upload successful for {filepath}")
                break
            except Exception as e:
                print(f"Error uploading {filepath}: {e}")
                if attempt == max_attempts:
                    print(f"Failed to upload {filepath} after {max_attempts} attempts")

    print("DONE")
    print("Go to your repo and accept the PRs this created to see your files")

def main():
    args = get_args()
    upload_files(args)

if __name__ == "__main__":
    main()

# ./upload_to_huggingface.py file1.txt file2.txt "your_username/your_repository" "path_in_repository" "token_file.txt"