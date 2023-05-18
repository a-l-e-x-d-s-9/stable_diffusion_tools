import os
import re
import concurrent.futures
import argparse
import shutil

# Supported image file extensions
image_extensions = {'.jpg', '.jpeg', '.png', '.gif', '.bmp', '.tiff', '.ico'}


def rename_file(file_path, pattern):
    try:
        dirname = os.path.dirname(file_path)
        filename = os.path.basename(file_path)
        extension = os.path.splitext(filename)[1].lower()

        if extension not in image_extensions:
            return False

        new_filename = pattern.sub("", filename)

        if new_filename != filename:
            new_file_path = os.path.join(dirname, new_filename)
            if os.path.exists(new_file_path):
                os.remove(new_file_path)
            os.rename(file_path, new_file_path)
            return True

    except Exception as e:
        print(f'\nError processing file {file_path}: {str(e)}', flush=True)

    return False


def scan_directory(scan_dir, pattern, max_workers):
    renamed_count = 0
    compiled_pattern = re.compile(pattern)
    with concurrent.futures.ThreadPoolExecutor(max_workers=max_workers) as executor:
        for dirpath, dirnames, filenames in os.walk(scan_dir):
            futures = {executor.submit(rename_file, os.path.join(dirpath, filename), compiled_pattern): filename for
                       filename in filenames}
            for future in concurrent.futures.as_completed(futures):
                if future.result():
                    renamed_count += 1
                    print(f'\rRenamed files: {renamed_count}', end='', flush=True)
    print()  # Newline after loop


# Argument parser
parser = argparse.ArgumentParser(
    description='Scan a directory and its subdirectories recursively. Rename image files by removing a specific pattern (i.e., -0000, -0001, etc.).')
parser.add_argument('scan_dir', type=str, help='The directory to scan.')
parser.add_argument('-p', '--pattern', type=str, default='-\d{4}',
                    help='The pattern to remove from file names (default: "-\d{4}").')
parser.add_argument('-w', '--max_workers', type=int, default=4,
                    help='The maximum number of worker threads (default: 4).')

args = parser.parse_args()

scan_directory(args.scan_dir, args.pattern, args.max_workers)
