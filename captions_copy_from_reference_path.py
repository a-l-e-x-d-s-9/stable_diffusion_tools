import os
import shutil
from collections import defaultdict

# Function to scan a directory for specific file types
def scan_directory(path, extensions):
    files = []
    for root, _, filenames in os.walk(path):
        for filename in filenames:
            if filename.lower().endswith(extensions):
                files.append(os.path.join(root, filename))
    return files

# Function to extract base name without extension and optional " (copy X)" part
def clean_basename(file_name):
    base_name = os.path.splitext(file_name)[0]
    if " (copy" in base_name:
        base_name = base_name[:base_name.rfind(" (copy")]
    return base_name

# Main function to process images and match TXT files
def process_files(work_path, reference_path):
    # Supported image extensions
    image_extensions = (".jpg", ".jpeg", ".png", ".webp")
    text_extension = ".txt"

    # Scan directories
    image_files = scan_directory(work_path, image_extensions)
    text_files = scan_directory(reference_path, (text_extension,))

    # Organize TXT files by basename and folder
    text_files_dict = defaultdict(list)
    for text_file in text_files:
        folder_name = os.path.basename(os.path.dirname(text_file))
        base_name = os.path.splitext(os.path.basename(text_file))[0]
        text_files_dict[base_name].append((text_file, folder_name))

    matched_count = 0
    missing_count = 0

    for image_file in image_files:
        image_folder = os.path.basename(os.path.dirname(image_file))
        image_name = os.path.basename(image_file)
        clean_name = clean_basename(image_name)

        # Try matching TXT file with exact and cleaned names
        potential_matches = text_files_dict.get(clean_name, [])

        if not potential_matches:
            potential_matches = text_files_dict.get(image_name, [])

        if potential_matches:
            # Prefer matches in the same folder as the image
            preferred_matches = [t for t in potential_matches if t[1] == image_folder]
            selected_match = preferred_matches[0] if preferred_matches else potential_matches[0]

            # Copy and rename the matched TXT file
            source_txt_path = selected_match[0]
            dest_txt_path = os.path.join(os.path.dirname(image_file), f"{os.path.splitext(image_name)[0]}{text_extension}")
            shutil.copy(source_txt_path, dest_txt_path)
            matched_count += 1
        else:
            print(f"No matching TXT file found for image: {image_file}")
            missing_count += 1

    # Print final report
    print(f"Matched TXT files: {matched_count}")
    print(f"Missing TXT files: {missing_count}")

# Example usage
if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Match images with TXT files.")
    parser.add_argument("--work", required=True, help="Path to the work directory containing images.")
    parser.add_argument("--references", required=True, help="Path to the references directory containing TXT files.")

    args = parser.parse_args()
    process_files(args.work, args.references)
