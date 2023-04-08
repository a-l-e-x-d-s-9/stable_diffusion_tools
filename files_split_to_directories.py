import os
import sys
import platform
from datetime import datetime
from concurrent.futures import ThreadPoolExecutor
import argparse

def get_creation_date(entry):
    try:
        if platform.system() == 'Windows':
            timestamp = entry.stat().st_ctime
        else:
            try:
                timestamp = entry.stat().st_birthtime
            except AttributeError:
                timestamp = entry.stat().st_mtime
        return datetime.fromtimestamp(timestamp)
    except Exception as e:
        print(f"\rError getting creation date for {entry.name}: {e}", end="")
        return None

def move_file_preserving_metadata(src, dst):
    try:
        # Get the original access and modification timestamps
        original_timestamps = (os.path.getatime(src), os.path.getmtime(src))

        # Move the file using os.replace()
        os.replace(src, dst)

        # Update the access and modification timestamps
        os.utime(dst, original_timestamps)
    except Exception as e:
        print(f"\rError moving {src} to {dst}: {e}", end="")
        return False
    return True

def process_file(entry, directory):
    creation_date = get_creation_date(entry)
    if creation_date is None:
        return False

    folder_name = creation_date.strftime("%Y-%m-%d")
    target_folder = os.path.join(directory, folder_name)

    # Create target folder if it doesn't exist
    try:
        os.makedirs(target_folder, exist_ok=True)
    except Exception as e:
        print(f"\rError creating directory {target_folder}: {e}", end="")
        return False

    target_path = os.path.join(target_folder, entry.name)
    return move_file_preserving_metadata(entry.path, target_path)

def split_files_by_creation_date(directory, max_workers=None):
    if not os.path.exists(directory):
        print(f"Directory {directory} does not exist.")
        return

    if not os.path.isdir(directory):
        print(f"{directory} is not a directory.")
        return

    total_files = sum(1 for _ in os.scandir(directory))
    processed_files = 0
    errors_encountered = 0

    if max_workers is None:
        max_cores = os.cpu_count()
        if max_cores is not None and max_cores > 1:
            max_workers = max_cores - 1
        else:
            max_workers = 1

    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures = {executor.submit(process_file, entry, directory): entry for entry in os.scandir(directory) if entry.is_file()}

        for future in futures:
            entry = futures[future]
            try:
                success = future.result()
                if not success:
                    errors_encountered += 1
            except Exception as e:
                print(f"\rError processing {entry.name}: {e}", end="")
                errors_encountered += 1

            processed_files += 1
            print(f"\rProcessed: {processed_files}/{total_files}, Errors: {errors_encountered}", end="")

    print("\nProcessing completed.")

def main():
    parser = argparse.ArgumentParser(description="Split files in a directory by their creation date.")
    parser.add_argument("directory", help="The directory containing files to process.")
    args = parser.parse_args()

    split_files_by_creation_date(args.directory)

if __name__ == "__main__":
    main()
