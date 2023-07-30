import os
import shutil
import random
import argparse
from pathlib import Path

def move_random_files(source_dir, sub_dir_name, num_files, target_dir, is_copy):
    for root, dirs, files in os.walk(source_dir):
        if Path(root).name == sub_dir_name and len(files) > 0:
            selected_files = random.sample(files, min(len(files), num_files))
            for file in selected_files:
                source_file = os.path.join(root, file)
                relative_path = os.path.relpath(source_file, source_dir)
                target_file = os.path.join(target_dir, relative_path)
                os.makedirs(os.path.dirname(target_file), exist_ok=True)
                if is_copy:
                    shutil.copy(source_file, target_file)
                else:
                    shutil.move(source_file, target_file)

def main():
    parser = argparse.ArgumentParser(description="Move a specified number of random files from each subdirectory matching a certain name in the source directory to a target directory, maintaining the same relative file paths.")
    parser.add_argument('-s', '--source', required=True, help='The source directory.')
    parser.add_argument('-n', '--name', required=True, help='The name of the subdirectory to move files from.')
    parser.add_argument('-f', '--files', required=True, type=int, help='The number of random files to move from each matching subdirectory.')
    parser.add_argument('-t', '--target', required=True, help='The target directory.')
    parser.add_argument('-c', '--copy', required=False, action='store_true', default=False, help='Copy instead of move.')
    args = parser.parse_args()

    move_random_files(args.source, args.name, args.files, args.target, args.copy)

if __name__ == "__main__":
    main()
