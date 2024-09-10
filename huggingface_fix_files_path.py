import argparse
from huggingface_hub import HfApi, CommitOperationDelete, CommitOperationCopy


def get_args():
    parser = argparse.ArgumentParser(description="Rename and move safetensors files in Hugging Face repository")
    parser.add_argument("--repository", required=True, help="Repository on huggingface.com (e.g., 'alexds9/JL')")
    parser.add_argument("--token_file", required=True, help="File containing your Hugging Face token")
    parser.add_argument("--repo_type", default="model", choices=["dataset", "space", "model"],
                        help="Type of the repository (dataset, space, model). Default is model.")
    parser.add_argument("--path", required=True,
                        help="Base path inside the repository where the safetensors files are located (e.g., 'JL08/Training/tr_09a/')")
    return parser.parse_args()


def rename_safetensors_files(repo_id, token, repo_type, base_path):
    api = HfApi()

    # Ensure base_path ends with a "/"
    if not base_path.endswith("/"):
        base_path += "/"

    # List all files in the repository
    repo_files = api.list_repo_files(repo_id=repo_id, repo_type=repo_type, token=token)

    # Prepare operations for renaming safetensors files in nested directories
    rename_operations = []
    for file_path in repo_files:
        if file_path.endswith(".safetensors") and file_path.startswith(base_path):
            # Extract the filename
            file_name = file_path.split("/")[-1]
            new_file_path = f"{base_path}{file_name}"

            # If the file is not already in the base path, prepare a copy (move) operation
            if file_path != new_file_path:
                print(f"Renaming {file_path} -> {new_file_path}")

                # Copy the file to the new path
                copy_operation = CommitOperationCopy(src_path_in_repo=file_path, path_in_repo=new_file_path)
                # Delete the old file path
                delete_operation = CommitOperationDelete(path_in_repo=file_path)

                # Append operations to the list
                rename_operations.append(copy_operation)
                rename_operations.append(delete_operation)

    # Perform the renaming operation in the repository
    if rename_operations:
        api.create_commit(
            repo_id=repo_id,
            repo_type=repo_type,
            token=token,
            operations=rename_operations,
            commit_message=f"Renaming safetensors files to {base_path}",
        )
        print("Renaming completed successfully.")
    else:
        print("No files to rename.")


def main():
    args = get_args()

    # Read the Hugging Face token
    with open(args.token_file, "r") as token_file:
        token = token_file.read().strip()

    # Execute the renaming function
    rename_safetensors_files(
        repo_id=args.repository,
        token=token,
        repo_type=args.repo_type,
        base_path=args.path
    )


if __name__ == "__main__":
    main()
