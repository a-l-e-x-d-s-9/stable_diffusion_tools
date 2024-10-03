import os
import sys
import argparse


def count_images_in_folder(folder_path, include_subfolders=True):
    """Helper function to count images in a given folder.
    If include_subfolders is True, it will count images in all subdirectories.
    """
    if include_subfolders:
        return sum(
            [len([f for f in files if f.lower().endswith(('.webp', '.png', '.jpg', '.jpeg', '.gif'))])
             for _, _, files in os.walk(folder_path, topdown=True)]
        )
    else:
        return len([f for f in os.listdir(folder_path)
                    if f.lower().endswith(('.webp', '.png', '.jpg', '.jpeg', '.gif'))])


def traverse_folders(parent_dir, target_depth, relative_path):
    """Traverse the directory up to the target depth using depth-limited os.walk()."""
    results = []

    for current_dir, subdirs, files in os.walk(parent_dir, topdown=True):
        # Calculate the relative depth from the parent_dir
        rel_depth = current_dir[len(parent_dir):].count(os.sep)

        # Calculate relative folder path for output
        rel_dir_path = os.path.relpath(current_dir, start=relative_path)

        if rel_depth == target_depth:
            # At target depth, count files in this folder (including all subfolders)
            file_count = count_images_in_folder(current_dir, include_subfolders=True)
            results.append((rel_dir_path, file_count))
            # Stop walking into deeper subdirectories by clearing the subdirs list
            subdirs.clear()
        elif rel_depth < target_depth:
            # For folders before the target depth, count files only in this folder (without subfolders)
            file_count = count_images_in_folder(current_dir, include_subfolders=False)
            if file_count > 0:
                results.append((rel_dir_path, file_count))

    return results


def main(parent_dir, minimum_warning=None, depth=0):
    # Traverse the folder up to the specified depth
    results = traverse_folders(parent_dir, target_depth=depth, relative_path=parent_dir)

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
    parser.add_argument("-d", "--depth", type=int, default=0, help="Depth of folder traversal (default is 0)")

    args = parser.parse_args()

    if not os.path.isdir(args.parent_dir):
        print(f"Error: '{args.parent_dir}' is not a valid directory.")
        sys.exit(1)

    main(args.parent_dir, args.min_warning, args.depth)
