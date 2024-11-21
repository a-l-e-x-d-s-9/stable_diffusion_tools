import argparse
from huggingface_hub import HfApi, merge_pull_request, get_repo_discussions, change_discussion_status
from huggingface_hub.utils._errors import BadRequestError


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
            print(f"Processing pull request #{discussion.num}: {discussion.title}")
            try:
                merge_pull_request(repo_id=repo_id, discussion_num=discussion.num, token=token)
                print(f"Pull request #{discussion.num} merged.")
            except BadRequestError as e:
                if "This Pull Request has no associated changes" in str(e):
                    print(f"Pull request #{discussion.num} has no associated changes. Closing it.")
                    change_discussion_status(repo_id=repo_id, discussion_num=discussion.num, new_status="closed", token=token)
                    print(f"Pull request #{discussion.num} closed.")
                else:
                    print(f"Failed to merge pull request #{discussion.num} due to unexpected error: {e}")
            except Exception as e:
                print(f"An error occurred while processing pull request #{discussion.num}: {e}")


def main():
    args = get_args()
    merge_pull_requests(args)


if __name__ == "__main__":
    main()

# python3 huggingface_pull_requests_merge.py --repository "your_username/your_repository" --token_file "token_file.txt" --repo_type "model"
