import os
import argparse
import re
import json

# Supported image extensions
IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.bmp', '.gif', '.tiff']

FOLDER_SETTINGS_FILE_NAME = "folder_settings.json"

def has_images(folder_path):
    """Check if the folder contains any image files."""
    try:
        for filename in os.listdir(folder_path):
            if any(filename.endswith(ext) for ext in IMAGE_EXTENSIONS):
                return True
    except PermissionError:
        print(f"Warning: No permission to access {folder_path}. Skipping.")
    return False

def read_folder_settings(folder_path):
    """Read folder_settings.json from the given folder if it exists."""
    settings_path = os.path.join(folder_path, FOLDER_SETTINGS_FILE_NAME)
    if os.path.exists(settings_path):
        try:
            with open(settings_path, 'r') as f:
                return json.load(f)
        except json.JSONDecodeError:
            print(f"Warning: Invalid JSON format in {settings_path}. Skipping.")
    return {}

def generate_toml_content(folders_with_images):
    """Generate TOML content based on folders with images as plain text."""
    content = "[[datasets]]\n\n"

    for folder in folders_with_images:
        # Escape backslashes for Windows paths
        folder = folder.replace("\\", "\\\\")

        content += "  [[datasets.subsets]]\n"
        content += f"  image_dir = \"{folder}\"\n"
        
        # Check if folder name starts with a number followed by an underscore
        match = re.match(r'(\d+)_', os.path.basename(folder))
        if match:
            content += f"  num_repeats = {match.group(1)}\n"
        
        # Add additional settings from folder_settings.json
        settings = read_folder_settings(folder)
        for key, value in settings.items():
            # Check if the value is numeric or string and format accordingly
            if isinstance(value, (int, float)):
                content += f"  {key} = {value}\n"
            else:
                content += f"  {key} = \"{value}\"\n"

        content += "\n"

    return content


def main(directory_path, output_file_path):
    """Scan the directory and write folders with images to TOML."""
    folders_with_images = []

    # Traverse the directory
    for root, dirs, files in os.walk(directory_path):
        if has_images(root):
            folders_with_images.append(root)

    # Generate TOML content
    toml_content = generate_toml_content(folders_with_images)

    # Write to output file
    with open(output_file_path, 'w') as f:
        f.write(toml_content)

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Scan a directory for folders with images and write to a TOML file.")
    parser.add_argument("--directory", "-d", required=True, help="Path to the directory to be scanned.")
    parser.add_argument("--output", "-o", required=True, help="Path to the output TOML file.")

    args = parser.parse_args()

    main(args.directory, args.output)
