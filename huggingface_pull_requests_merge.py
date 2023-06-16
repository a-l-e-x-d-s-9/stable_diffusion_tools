import argparse
from huggingface_hub import HfApi, merge_pull_request, get_repo_discussions


def get_args():
    parser = argparse.ArgumentParser(description="Merge pull requests in a Hugging Face repository")
    parser.add_argument("--repository", required=True, help="Repository on huggingface.com")
    parser.add_argument("--token_file", required=True, help="File containing your Hugging Face token")
    parser.add_argument("--repo_type", default=None, choices=["dataset", "space", "model"], help="Type of the repository (dataset, space, model). Default is model.")
    return parser.parse_args()


def merge_pull_requests(args):
    with open(args.token_file, "r") as token_file:
        token = token_file.read().strip()

    api = HfApi()
    repo_id = args.repository
    repo_type = args.repo_type

    # Fetch all discussions (including pull requests)
    discussions = get_repo_discussions(repo_id=repo_id, repo_type=repo_type, token=token)

    # Loop through each discussion and merge it if it's a pull request
    for discussion in discussions:
        if discussion.is_pull_request and discussion.status == "open":
            print(f"Merging pull request #{discussion.num}: {discussion.title}")
            merge_pull_request(repo_id=repo_id, discussion_num=discussion.num, token=token)
            print(f"Pull request #{discussion.num} merged.")


def main():
    args = get_args()
    merge_pull_requests(args)


if __name__ == "__main__":
    main()




# python3 huggingface_pull_requests_merge.py --repository "your_username/your_repository" --token_file "token_file.txt" --repo_type "model"
