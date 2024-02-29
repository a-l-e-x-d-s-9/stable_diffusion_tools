import json
import os.path
import subprocess
import argparse
from collections import Counter

def get_clipboard_content():
    return subprocess.check_output(['xclip', '-selection', 'clipboard', '-o']).decode('utf-8')


def process_json(json_data):
    # Count occurrences of each model name
    all_model_names = [name for entry in json_data.values() for name in entry['modelName']]
    name_counts = Counter(all_model_names)

    # Find the most popular name
    popular_name = name_counts.most_common(1)[0][0]

    # Reorder modelName field in each entry
    for entry in json_data.values():
        if popular_name in entry['modelName']:
            entry['modelName'].remove(popular_name)
            entry['modelName'].insert(0, popular_name)

    popular_name_with_underscores = popular_name.replace(" ", "_")

    return json_data, popular_name_with_underscores

def save_json(base_folder, json_data, popular_name):
    path = os.path.join(base_folder, f"{popular_name}.json")
    with open(path, 'w') as f:
        json.dump(json_data, f, indent=4)
    return path

def run_bash_commands(base_folder, popular_name):
    folder_path = os.path.join(base_folder, f"{popular_name}")
    json_path = os.path.join(base_folder, f"{popular_name}.json")

    os.makedirs(folder_path, exist_ok=True)
    # Removed: "text, English text, signature, watermark, site address"
    commands = [
        f'python3  images_gathering/morepics/morepics_download.py --folder "{folder_path}" --additional-tags "" --data "{json_path}"'
    ]
    
    for cmd in commands:
        subprocess.run(cmd, shell=True)

def main():
    # Parse command-line arguments
    parser = argparse.ArgumentParser(description="Process JSON data.")
    parser.add_argument('--base_folder', type=str, required=True, help="Base folder path.")
    args = parser.parse_args()

    base_folder = args.base_folder

    # Get JSON content from clipboard
    clipboard_content = get_clipboard_content()
    json_content = json.loads(clipboard_content)

    processed_json, popular_name = process_json(json_content)
    save_json(base_folder, processed_json, popular_name)
    run_bash_commands(base_folder, popular_name)

if __name__ == "__main__":
    main()
