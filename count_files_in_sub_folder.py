import os
import sys
import argparse


def main(parent_dir, minimum_warning=None):
    results = []

    # Iterate over all directories within the parent directory
    for dir_name in os.listdir(parent_dir):
        dir_path = os.path.join(parent_dir, dir_name)

        # Check if it's a directory
        if os.path.isdir(dir_path):
            # Count the number of image files in the subfolder
            file_count = sum(
                [len([f for f in files if f.lower().endswith(('.png', '.jpg', '.jpeg', '.gif'))]) for r, d, files in
                 os.walk(dir_path)])

            results.append((dir_name, file_count))

    if results:
        # Sort the results alphabetically by directory name
        results.sort(key=lambda x: x[0])

        # Find the maximum directory name length and file count length for formatting
        max_name_length = max(len(dir_name) for dir_name, _ in results)
        max_count_length = max(len(str(file_count)) for _, file_count in results)

        # Print the folder names and the file counts in columns
        for dir_name, file_count in results:
            if minimum_warning is not None and file_count < minimum_warning:
                color_code = "\033[93m"  # Yellow color
                reset_code = "\033[0m"
            else:
                color_code = ""
                reset_code = ""

            print(f"{color_code}{dir_name:{max_name_length}}: {file_count:>{max_count_length}} files{reset_code}")
    else:
        print("No subfolders found.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Count files in subfolders.")
    parser.add_argument("parent_dir", help="Path to the parent directory")
    parser.add_argument("-m", "--min-warning", type=int, default=None, help="Minimum warning threshold for file count")

    args = parser.parse_args()

    if not os.path.isdir(args.parent_dir):
        print(f"Error: '{args.parent_dir}' is not a valid directory.")
        sys.exit(1)

    main(args.parent_dir, args.min_warning)
