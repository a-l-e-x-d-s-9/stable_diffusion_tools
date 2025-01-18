import os
import subprocess
import argparse

def scan_and_update_user_comment(folder, search_string, replacement_string):
    """
    Scan JPG files in the specified folder (including nested folders),
    search for a string in the User Comment section, and replace it.

    Args:
        folder (str): The folder to scan for JPG files.
        search_string (str): The string to search for in the User Comment section.
        replacement_string (str): The string to replace the searched string with.
    """
    # Ensure exiftool is installed
    if subprocess.run(["which", "exiftool"], stdout=subprocess.PIPE).returncode != 0:
        print("ExifTool is not installed. Please install it using 'sudo apt install libimage-exiftool-perl'.")
        return

    # Traverse folder for JPG files
    for root, _, files in os.walk(folder):
        for file in files:
            if file.lower().endswith(".jpg"):
                file_path = os.path.join(root, file)
                try:
                    # Get the current User Comment
                    result = subprocess.run(
                        ["exiftool", "-UserComment", "-s3", file_path],
                        stdout=subprocess.PIPE,
                        stderr=subprocess.PIPE,
                        text=True
                    )

                    current_comment = result.stdout.strip()

                    if search_string in current_comment:
                        # Replace the target string in User Comment
                        updated_comment = current_comment.replace(search_string, replacement_string)

                        # Write the updated User Comment back to the file
                        subprocess.run(
                            ["exiftool", f"-UserComment={updated_comment}", "-overwrite_original", file_path],
                            check=True
                        )

                        print(f"Updated User Comment in: {file_path}")

                except Exception as e:
                    print(f"Error processing file {file_path}: {e}")

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Update User Comment in JPG files.")
    parser.add_argument("--folder", required=True, help="The folder to scan for JPG images.")
    parser.add_argument("--search_string", required=True, help="The string to search for in User Comment.")
    parser.add_argument("--replacement_string", required=True, help="The string to replace the searched string with.")

    args = parser.parse_args()

    scan_and_update_user_comment(folder=args.folder, search_string=args.search_string, replacement_string=args.replacement_string)