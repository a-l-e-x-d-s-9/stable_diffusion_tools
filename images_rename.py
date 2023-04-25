import argparse
import os
import shutil
import sys
import random
import traceback

def red_print(print_content:str):
    RED = '\033[0;31m'
    NC = '\033[0m'  # No Color
    print(f"{RED}{print_content}{NC}")

def image_rename(image_path: str, file_prefix: str):
    try:
        base_path = os.path.dirname(image_path)
        # file_name = os.path.basename(image_path)
        _, file_extension = os.path.splitext(image_path)
        is_found_new_name = False
        new_file_path: str = ""
        retries_counter = 0
        while (False == is_found_new_name) and (retries_counter < 1000):
            rand_int: int = random.randint(0, 999999)
            new_file_path = os.path.join(base_path, f"{file_prefix}{rand_int:06d}{file_extension}")#6

            is_found_new_name = False == os.path.isfile(new_file_path)
            retries_counter += 1

        if is_found_new_name:
            shutil.move(image_path, new_file_path)
        else:
            red_print(f"\nCould not found a file name for: {image_path}\n")

    except Exception as e:
        print(f'Error processing {image_path}: {e}, {traceback.format_exc()}')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Rename files in folder, use a pattern.')
    parser.add_argument('folder_path', type=str, help='Path to folder containing images.')
    parser.add_argument('--prefix', type=str, help='prefix for images')
    args = parser.parse_args()

    folder_path: str = args.folder_path
    file_prefix: str = args.prefix

    if not os.path.isdir(folder_path):
        print(f'Error: {folder_path} is not a directory')
        sys.exit(1)

    count = 0
    total = len(os.listdir(folder_path))

    for file_name in os.listdir(folder_path):
        file_path = os.path.join(folder_path, file_name)
        if os.path.isfile(file_path):
            count += 1
            file_is_image = file_name.lower().endswith(('.png', '.jpg', '.jpeg'))
            if file_is_image:
                image_rename(file_path, file_prefix)

                print(f'\rProcessed {count}/{total} images.', end='', flush=True)

    print('\nDone.')  # Print a message to indicate when all images have been processed.

# Run example: python images_rename.py /path/to/folder --prefix "start_"
