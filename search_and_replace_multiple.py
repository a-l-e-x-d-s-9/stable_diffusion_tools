import os
import glob
import re
import argparse
from concurrent.futures import ThreadPoolExecutor
from tqdm import tqdm


def replace_string_in_file(file_path, search_pattern, replacement_pattern):
    try:
        with open(file_path, 'r') as file:
            file_contents = file.read()

        file_contents = re.sub(search_pattern, replacement_pattern, file_contents)

        with open(file_path, 'w') as file:
            file.write(file_contents)
    except Exception as e:
        print(f"Error processing file {file_path}: {e}")

def replace_in_all_files(directory_path, search_pattern, replacement_pattern, extension='txt', num_threads=None):
    files = [f for f in glob.glob(directory_path + '/**/*.' + extension, recursive=True)]
    with ThreadPoolExecutor(max_workers=num_threads) as executor:
        list(tqdm(executor.map(replace_string_in_file, files, [search_pattern]*len(files), [replacement_pattern]*len(files)), total=len(files)))

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Search and Replace Strings in Files")
    parser.add_argument("--directory", type=str, required=True, help="Directory path containing files for search and replace")
    parser.add_argument("--search_pattern", type=str, required=True, help="Regular expression pattern for search")
    parser.add_argument("--replacement_pattern", type=str, required=True, help="Replacement string, can include regex groups")
    parser.add_argument("--extension", type=str, default='txt', help="File extension to search for")
    parser.add_argument("--threads", type=int, default=os.cpu_count() * 2, help="Number of threads to use")

    args = parser.parse_args()

    replace_in_all_files(directory_path=args.directory, search_pattern=args.search_pattern, replacement_pattern=args.replacement_pattern, extension=args.extension, num_threads=args.threads)


# Example: python3 search_and_replace_multiple.py --directory "/path/to/directory" --search_pattern "original_regex" --replacement_pattern "new_string" --extension "txt" --threads 10
