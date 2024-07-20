import os
import re
import argparse


def delete_safetensors_files(base_path):
    # Compile regex for matching the folder format
    folder_pattern = re.compile(r'tr_\d{2,3}$')

    for root, dirs, files in os.walk(base_path):
        for dir_name in dirs:
            if folder_pattern.match(dir_name):
                full_dir_path = os.path.join(root, dir_name)
                for subdir_root, subdir_dirs, subdir_files in os.walk(full_dir_path):
                    for file_name in subdir_files:
                        if file_name.endswith('.safetensors'):
                            file_path = os.path.join(subdir_root, file_name)
                            print(f"Deleting: {file_path}")
                            os.remove(file_path)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description='Delete .safetensors files in specific folders.')
    parser.add_argument('path', type=str, help='The base path to scan')
    args = parser.parse_args()
    delete_safetensors_files(args.path)
