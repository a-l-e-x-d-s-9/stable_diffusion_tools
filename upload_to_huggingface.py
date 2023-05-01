import argparse
import hashlib
import os
from huggingface_hub import HfApi
from tqdm import tqdm
import io

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
        filename = os.path.basename(filepath)  # Extract file name from path
        readable_hash = ""

        with open(filepath, "rb") as f:
            bytes = f.read()
            readable_hash = hashlib.sha256(bytes).hexdigest()
            print(f"# sha256: {readable_hash}")

        for attempt in range(1, max_attempts + 1):
            try:
                path_in_repo = os.path.join(args.path, filename)  # Use os.path.join to avoid double slashes
                print(f"Attempt {attempt}: Uploading to HF: huggingface.co/{repo_id}/{path_in_repo}, sha256: {readable_hash}")

                with open(filepath, "rb") as file:
                    tqdm_file = TqdmFileReader(file)

                    response = api.upload_file(
                        path_or_fileobj=tqdm_file,
                        path_in_repo=path_in_repo,
                        repo_id=repo_id,
                        repo_type=None,
                        token=token,
                        create_pr=1,
                    )
                print(response)
                print(f"Upload successful for {filename}")
                break
            except Exception as e:
                print(f"Error uploading {filename}: {e}")
                if attempt == max_attempts:
                    print(f"Failed to upload {filename} after {max_attempts} attempts")

    print("DONE")
    print("Go to your repo and accept the PRs this created to see your files")

def main():
    args = get_args()
    upload_files(args)

if __name__ == "__main__":
    main()



# ./upload_to_huggingface.py file1.txt file2.txt "your_username/your_repository" "path_in_repository" "token_file.txt"