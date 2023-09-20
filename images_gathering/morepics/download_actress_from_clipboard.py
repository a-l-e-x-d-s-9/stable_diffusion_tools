import json
import subprocess
from collections import Counter

base_folder = "/path_to_base_folder/"


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

def save_json(json_data, popular_name):
    path = f"{base_folder}/datset_preparations/{popular_name}.json"
    with open(path, 'w') as f:
        json.dump(json_data, f, indent=4)
    return path

def run_bash_commands(popular_name):
    folder_path = f"{base_folder}/datset_preparations/{popular_name}/"
    json_path = f"{base_folder}/datset_preparations/{popular_name}.json"
    
    commands = [
        f'mkdir "{folder_path}"',
        f'python3 morepics/morepics_download.py --folder "{folder_path}" --additional-tags "text, English text, signature, watermark, site address" --data "{json_path}"'
    ]
    
    for cmd in commands:
        subprocess.run(cmd, shell=True)

# Get JSON content from clipboard
clipboard_content = get_clipboard_content()
json_content = json.loads(clipboard_content)

processed_json, popular_name = process_json(json_content)
save_json(processed_json, popular_name)
run_bash_commands(popular_name)
