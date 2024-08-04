import os
import re
import argparse


def delete_safetensors_files(base_path, besides_final, only_inside_training_folder):
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
                            if only_inside_training_folder and 'Training' not in file_path.split(os.sep):
                                continue
                            if besides_final:
                                if '-000' in file_name:
                                    print(f"Deleting: {file_path}")
                                    os.remove(file_path)
                            else:
                                print(f"Deleting: {file_path}")
                                os.remove(file_path)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description='Delete .safetensors files in specific folders.')
    parser.add_argument('path', type=str, help='The base path to scan')
    parser.add_argument('--besides-final', action='store_true',
                        help='Delete only files containing "-000" in their names')
    parser.add_argument('--only-inside-training-folder', action='store_true',
                        help='Delete files only if they have "Training" in their path')
    args = parser.parse_args()
    delete_safetensors_files(args.path, args.besides_final, args.only_inside_training_folder)
