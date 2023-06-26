import argparse
import os
import shutil
import collections


def split_files(source_folder, split_amount):
    unique_files = collections.defaultdict(list)
    for root, _, files in os.walk(source_folder):
        for file in files:
            name, ext = os.path.splitext(file)
            unique_files[name].append(os.path.join(root, file))

    unique_names = list(unique_files.keys())
    split_folders = [f"{source_folder}_{i}" for i in range(1, split_amount + 1)]

    for i, name in enumerate(unique_names):
        split_folder = split_folders[i % split_amount]
        for file in unique_files[name]:
            dest_dir = os.path.join(split_folder, os.path.relpath(os.path.dirname(file), source_folder))
            os.makedirs(dest_dir, exist_ok=True)
            shutil.copy(file, dest_dir)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description='Split files from a source folder into multiple folders.')
    parser.add_argument('--source-folder', required=True, help='The source folder to split files from.')
    parser.add_argument('--split-amount', type=int, required=True,
                        help='The number of folders to split the files into.')
    args = parser.parse_args()

    split_files(args.source_folder, args.split_amount)


# python split_files.py --source-folder /path/to/source/folder --split-amount 2
