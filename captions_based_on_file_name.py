import os
import re
import argparse
from concurrent.futures import ThreadPoolExecutor

def process_file(root, file):
    file_base, ext = os.path.splitext(os.path.basename(file))

    # check if file is an image
    if ext.lower() in ['.jpeg', '.jpg', '.png', '.gif', '.webp']:
        txt_file_path = os.path.join(root, file_base + '.txt')

        # handle empty file case
        prefix = ', ' if os.path.exists(txt_file_path) and os.path.getsize(txt_file_path) > 0 else ''

        with open(txt_file_path, 'a') as txt_file:
            txt_file.write(prefix + file_base)

def process_files(path):
    with ThreadPoolExecutor(max_workers=10) as executor:
        for root, _, files in os.walk(path):
            for file in files:
                executor.submit(process_file, root, file)

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Scan for image files and update corresponding text files.')
    parser.add_argument('--path', required=True, help='Path to the directory to scan')

    args = parser.parse_args()

    process_files(args.path)
