import argparse
import os
import shutil
import collections
import random
import common


def split_files(source_folder, target_folder, split_amount, copy_files, exclude_folder, exclude_files, with_captions):
    #print(
    #    f"Starting split_files with source_folder={source_folder}, target_folder={target_folder}, split_amount={split_amount}, copy_files={copy_files}, exclude_folder={exclude_folder}, exclude_files={exclude_files}, with_captions={with_captions}")

    for root, _, files in os.walk(source_folder):
        #print(f"Checking directory: {root}")

        if exclude_folder and exclude_folder in root:
            #print(f"Excluding directory: {root}")
            continue

        file_groups = collections.defaultdict(list)
        for file in files:
            base_name, ext = os.path.splitext(file)
            if base_name not in exclude_files:
                file_groups[base_name].append(file)

        #print(f"Found file groups: {file_groups.keys()}")

        base_names_to_move = random.sample(list(file_groups.keys()), min(split_amount, len(file_groups)))
        #print(f"Selected base names to move: {base_names_to_move}")

        for base_name in base_names_to_move:
            files_to_move = file_groups[base_name]
            for file in files_to_move:
                src_file = os.path.join(root, file)
                dst_dir = os.path.join(target_folder, os.path.relpath(root, source_folder))
                os.makedirs(dst_dir, exist_ok=True)
                dst_file = os.path.join(dst_dir, file)

                #print(f"Moving {'copying' if copy_files else 'moving'} file from {src_file} to {dst_file}")

                if copy_files:
                    shutil.copy2(src_file, dst_file)
                else:
                    shutil.move(src_file, dst_file)

                # If --with_captions is used, move or copy the corresponding TXT file (if it exists)
                if with_captions and ext.lower() in common.image_extensions:
                    caption_file = base_name + ".txt"
                    src_caption_file = os.path.join(root, caption_file)
                    dst_caption_file = os.path.join(dst_dir, caption_file)
                    if os.path.exists(src_caption_file):
                        #print(
                        #    f"Moving {'copying' if copy_files else 'moving'} caption file from {src_caption_file} to {dst_caption_file}")

                        if copy_files:
                            shutil.copy2(src_caption_file, dst_caption_file)
                        else:
                            shutil.move(src_caption_file, dst_caption_file)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description='Move or copy random files from a source folder to a target folder.')
    parser.add_argument('--source-folder', required=True, help='The source folder to move or copy files from.')
    parser.add_argument('--target-folder', required=True, help='The target folder to move or copy files to.')
    parser.add_argument('--split-amount', type=int, required=True,
                        help='The number of files to move or copy.')
    parser.add_argument('--copy-files', action='store_true', default=False, help='Copy files instead of moving them.')
    parser.add_argument('--exclude-folder', type=str, help='Folder to exclude from the operation.')
    parser.add_argument('--exclude-files', default=[], required=False, type=str, nargs='*', help='Files (without extension) to exclude from the operation.')
    parser.add_argument('--with_captions', action='store_true', default=False,
                        help='Move or copy corresponding TXT files for each image.')

    args = parser.parse_args()

    split_files(args.source_folder, args.target_folder, args.split_amount, args.copy_files, args.exclude_folder, args.exclude_files, args.with_captions)


# python3 split_files_exact_number.py --source-folder /path/to/source/folder --target-folder /path/to/target/folder --split-amount 3 --copy-files --exclude-folder /path/to/exclude/folder --exclude-files file1 file2 file3


