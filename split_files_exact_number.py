import argparse
import os
import shutil
import collections
import random

def split_files(source_folder, target_folder, split_amount, copy_files, exclude_folder, exclude_files):
    for root, _, files in os.walk(source_folder):
        if exclude_folder and exclude_folder in root:
            continue

        file_groups = collections.defaultdict(list)
        for file in files:
            base_name, _ = os.path.splitext(file)
            if base_name not in exclude_files:
                file_groups[base_name].append(file)

        base_names_to_move = random.sample(list(file_groups.keys()), min(split_amount, len(file_groups)))

        for base_name in base_names_to_move:
            files_to_move = file_groups[base_name]
            for file in files_to_move:
                src_file = os.path.join(root, file)
                dst_dir = os.path.join(target_folder, os.path.relpath(root, source_folder))
                os.makedirs(dst_dir, exist_ok=True)
                dst_file = os.path.join(dst_dir, file)

                if copy_files:
                    shutil.copy2(src_file, dst_file)
                else:
                    shutil.move(src_file, dst_file)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description='Move or copy random files from a source folder to a target folder.')
    parser.add_argument('--source-folder', required=True, help='The source folder to move or copy files from.')
    parser.add_argument('--target-folder', required=True, help='The target folder to move or copy files to.')
    parser.add_argument('--split-amount', type=int, required=True,
                        help='The number of files to move or copy.')
    parser.add_argument('--copy-files', action='store_true', default=False, help='Copy files instead of moving them.')
    parser.add_argument('--exclude-folder', type=str, help='Folder to exclude from the operation.')
    parser.add_argument('--exclude-files', type=str, nargs='*', help='Files (without extension) to exclude from the operation.')
    args = parser.parse_args()

    split_files(args.source_folder, args.target_folder, args.split_amount, args.copy_files, args.exclude_folder, args.exclude_files)


# python3 split_files_exact_number.py --source-folder /path/to/source/folder --target-folder /path/to/target/folder --split-amount 3 --copy-files --exclude-folder /path/to/exclude/folder --exclude-files file1 file2 file3


