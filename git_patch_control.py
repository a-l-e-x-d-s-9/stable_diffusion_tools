import os
import subprocess
import datetime
import argparse
import json
from enum import Enum


class Operation(Enum):
    CREATE_PATCH = 1
    APPLY_PATCH = 2
    REMOVE_CHANGES = 3
    LIST_PATCHES = 4


def run_git_command(command, git_dir):
    return subprocess.check_output(command, cwd=git_dir, shell=True)


def create_patch(git_dir, patches_dir, tag):
    date = datetime.datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
    patch_file = os.path.join(patches_dir, f"{date}_{tag}.patch")

    command = f"git diff > {patch_file}"
    run_git_command(command, git_dir)


def apply_patch(git_dir, patches_dir, patch_name):
    patch_file = os.path.join(patches_dir, patch_name)

    command = f"git apply {patch_file}"
    run_git_command(command, git_dir)


def remove_changes(git_dir):
    command = "git diff-index --quiet HEAD --"
    try:
        run_git_command(command, git_dir)
    except subprocess.CalledProcessError:
        response = input(
            "There are changes in the repository. Do you want to create a patch before discarding changes? (y/n): ")
        if response.lower() == 'y':
            tag = input("Enter a tag for the patch: ")
            create_patch(git_dir, patches_dir, tag)
        elif response.lower() != 'n':
            print("Invalid input. Cancelling removal of changes.")
            return

    commands = ["git reset --hard", "git clean -fd"]
    for command in commands:
        run_git_command(command, git_dir)


def list_patches(patches_dir):
    patches = os.listdir(patches_dir)
    for patch in patches:
        print(patch)


def handle_operation(operation, git_dir, patches_dir, arg=None):
    if operation == Operation.CREATE_PATCH:
        assert arg is not None, "Tag is required for creating a patch"
        create_patch(git_dir, patches_dir, arg)
    elif operation == Operation.APPLY_PATCH:
        assert arg is not None, "Patch name is required for applying a patch"
        apply_patch(git_dir, patches_dir, arg)
    elif operation == Operation.REMOVE_CHANGES:
        remove_changes(git_dir, patches_dir)
    elif operation == Operation.LIST_PATCHES:
        list_patches(patches_dir)
    else:
        raise ValueError(f"Unknown operation: {operation}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("operation", type=int, help="The operation to perform")
    parser.add_argument("--arg", help="Additional argument for the operation")
    args = parser.parse_args()

    with open('git_patch_config.json') as config_file:
        config = json.load(config_file)

    git_dir = config["git_dir"]
    patches_dir = config["patches_dir"]

    handle_operation(Operation(args.operation), git_dir, patches_dir, args.arg)
