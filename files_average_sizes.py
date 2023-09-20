import os
import argparse


def get_file_stats(path: str, extension: str):
    # Check if path exists
    if not os.path.exists(path):
        return "Path doesn't exist."

    # Check if path is a directory
    if not os.path.isdir(path):
        return "Provided path is not a directory."

    print("Path                           | Files | Average| Median")
    print("-" * 56)
    # Iterate over sub-directories in the provided path
    for subdir, _, files in os.walk(path):
        # Consider only direct sub-folders
        if subdir == path:
            continue

        txt_files = [f for f in files if f.endswith("." + extension)]
        txt_file_sizes = [os.path.getsize(os.path.join(subdir, f)) for f in txt_files]

        # Skip directories with no txt files
        if not txt_file_sizes:
            continue

        avg_size = sum(txt_file_sizes) / len(txt_file_sizes)
        median_size = sorted(txt_file_sizes)[len(txt_file_sizes) // 2] if len(txt_file_sizes) % 2 == 1 else \
            (sorted(txt_file_sizes)[len(txt_file_sizes) // 2 - 1] + sorted(txt_file_sizes)[
                len(txt_file_sizes) // 2]) / 2

        print(f"{os.path.basename(subdir):30} | {len(txt_file_sizes):5} | {avg_size:.2f} | {median_size:.2f}")




def main():
    parser = argparse.ArgumentParser(
        description="Get statistics for files with a specific extension in the direct sub-folders of the provided path.")

    # Add arguments
    parser.add_argument("--path", type=str, required=True, help="The path to the directory to be analyzed.")
    parser.add_argument("--extension", type=str, default="txt",
                        help="The file extension to be considered. Default is: txt.")

    args = parser.parse_args()

    # Pass the arguments to get_file_stats
    get_file_stats(path=args.path, extension=args.extension)

if __name__ == "__main__":
    main()  # Uncomment this line to execute the script with command-line arguments.

# python3 files_average_sizes.py --path /path/to/directory [--extension desired_extension]
