import os
import re
import argparse
from concurrent.futures import ThreadPoolExecutor

def process_file(root, file):
    image_file_pattern = re.compile(r'(.*)(\.\w+)$')  # Regular expression to match file name with any extension
    matched = image_file_pattern.match(file)
    if matched:
        file_base, ext = matched.groups()

        # Check if file is an image
        if ext.lower() in ['.jpeg', '.jpg', '.png', '.gif']:
            txt_file_path = os.path.join(root, file_base + '.txt')

            # Extract folder name and remove underscores
            folder_name = os.path.basename(root).replace('_', ' ')

            # Check if the text file exists and is not empty
            prefix = ', ' if os.path.exists(txt_file_path) and os.path.getsize(txt_file_path) > 0 else ''

            # Read existing content, if any
            existing_content = ''
            if os.path.exists(txt_file_path):
                with open(txt_file_path, 'r') as txt_file:
                    existing_content = txt_file.read()

            # Write folder name as the first tag, followed by existing content
            with open(txt_file_path, 'w') as txt_file:
                txt_file.write(f"{folder_name}{prefix}{existing_content}")

def process_files(path):
    with ThreadPoolExecutor(max_workers=10) as executor:
        for root, _, files in os.walk(path):
            # Skip the parent folder, only process subfolders
            if root == path:
                continue

            for file in files:
                executor.submit(process_file, root, file)

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Scan for image files and update corresponding text files with folder name as the first tag.')
    parser.add_argument('--path', required=True, help='Path to the directory to scan')

    args = parser.parse_args()

    process_files(args.path)
