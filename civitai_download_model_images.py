import requests
import os
import argparse
import concurrent.futures
import sys
import json
import io
from PIL import Image
from tqdm import tqdm

# Timeout value for server responses
TIMEOUT = 30  # in seconds


# Load API Key from JSON
def load_api_key(json_path):
    if not os.path.exists(json_path):
        sys.exit(f"Error: File not found: {json_path}")

    try:
        with open(json_path, "r") as file:
            data = json.load(file)
            api_key = data.get("api_key")
            if not api_key:
                sys.exit("Error: API key not found in the JSON file.")
            return api_key
    except json.JSONDecodeError:
        sys.exit("Error: Invalid JSON file.")


# Ensure the target folder exists
def ensure_directory_exists(directory):
    try:
        if not os.path.exists(directory):
            os.makedirs(directory)
        elif not os.path.isdir(directory):
            sys.exit(f"❌ Error: '{directory}' exists but is not a directory.")
    except PermissionError:
        sys.exit(f"❌ Permission denied: Unable to create directory '{directory}'.")
    except OSError as e:
        sys.exit(f"❌ OS error while creating directory '{directory}': {e}")


# Fetch Image Data from Civitai API
def fetch_image_data(model_version_id, api_key):
    endpoint = "https://civitai.com/api/v1/images"
    limit = 100
    cursor = None
    image_data = []
    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}

    while True:
        params = {
            "limit": limit,
            "modelVersionId": model_version_id,
            "sort": "Newest",
            "cursor": cursor,
            "nsfw": "X"
        }

        try:
            response = requests.get(endpoint, params=params, headers=headers, timeout=TIMEOUT)
            response.raise_for_status()
        except requests.RequestException as e:
            sys.exit(f"Failed to fetch data: {e}")

        data = response.json()
        image_data.extend(data.get("items", []))

        cursor = data.get("metadata", {}).get("nextCursor")
        if not cursor:
            break

    return image_data


# Download Images with Progress Bar & Error Handling
def download_images(image_data, target_folder):
    failed_downloads = []

    def download_image(item):
        image_id = item["id"]
        image_url = item["url"]

        try:
            image_response = requests.get(image_url, stream=True, timeout=TIMEOUT)
            image_response.raise_for_status()
            temp_image_data = image_response.content
        except requests.RequestException:
            failed_downloads.append(image_id)
            return

        try:
            image_stream = io.BytesIO(temp_image_data)
            image = Image.open(image_stream)
            file_extension = f".{image.format.lower()}"
        except Exception:
            file_extension = ".jpeg"

        image_filename = os.path.join(target_folder, f"{image_id}{file_extension}")
        metadata_filename = os.path.join(target_folder, f"{image_id}.metadata")

        if os.path.isfile(image_filename) and os.path.isfile(metadata_filename):
            return

        with open(image_filename, "wb") as image_file:
            image_file.write(temp_image_data)

        with open(metadata_filename, "w") as metadata_file:
            json.dump(item, metadata_file, indent=4)

        meta = item.get("meta")
        prompt_text = meta.get("prompt") if isinstance(meta, dict) else None

        if prompt_text:
            prompt_filename = os.path.join(target_folder, f"{image_id}.txt")
            with open(prompt_filename, "w") as text_file:
                text_file.write(prompt_text)

    with concurrent.futures.ThreadPoolExecutor(max_workers=10) as executor:
        list(tqdm(executor.map(download_image, image_data), total=len(image_data), desc="Downloading Images"))

    if failed_downloads:
        failed_log = os.path.join(target_folder, ".failed_downloads.txt")
        with open(failed_log, "w") as log_file:
            for failed_id in failed_downloads:
                log_file.write(f"{failed_id}\n")
        print(f"\n⚠️ Failed to download {len(failed_downloads)} images. See '{failed_log}' for details.")


# Main Function
def main():
    parser = argparse.ArgumentParser(description="Download images from Civitai based on model_version_id.")
    parser.add_argument("--model_version_id", type=str, required=True, help="The model_version_id to fetch images for.")
    parser.add_argument("--target_path", type=str, required=True, help="The target folder to download images.")
    parser.add_argument("--api_key_json", type=str, required=True, help="Path to the JSON file containing the API key.")

    args = parser.parse_args()
    api_key = load_api_key(args.api_key_json)

    ensure_directory_exists(args.target_path)

    try:
        image_data = fetch_image_data(args.model_version_id, api_key)

        files_list_filename = os.path.join(args.target_path, f"{args.model_version_id}_filelist.txt")
        with open(files_list_filename, "w") as files_list_file:
            for item in image_data:
                image_id = item["id"]
                image_url = item["url"]
                file_extension = os.path.splitext(image_url)[1].lower()
                if file_extension not in [".jpeg", ".jpg", ".png", ".webp"]:
                    file_extension = ".jpeg"
                files_list_file.write(f"{image_id}{file_extension}\n")

        download_images(image_data, args.target_path)

    except Exception as e:
        sys.exit(str(e))


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        sys.exit(str(e))
