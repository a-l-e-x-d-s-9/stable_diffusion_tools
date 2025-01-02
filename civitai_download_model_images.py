import requests
import os
import argparse
import concurrent.futures
import sys
import json
import imghdr
import io
from PIL import Image

# Timeout value for server responses
TIMEOUT = 30  # in seconds


# Function to load the API key from a JSON file
def load_api_key(json_path):
    if not os.path.exists(json_path):
        print(f"Error: File not found: {json_path}")
        exit(1)

    try:
        with open(json_path, "r") as file:
            data = json.load(file)
            api_key = data.get("api_key")
            if not api_key:
                print("Error: API key not found in the JSON file.")
                exit(1)
            return api_key
    except json.JSONDecodeError:
        print("Error: Invalid JSON file.")
        exit(1)


# Function to fetch image data from Civitai API based on the model_version_id
def fetch_image_data(model_version_id, api_key):
    endpoint = "https://civitai.com/api/v1/images"

    limit = 100  # Maximum allowed limit for batch size
    cursor = None
    image_data = []

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json"
    }

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
        except requests.Timeout:
            raise Exception(f"Timeout while fetching data from server after {TIMEOUT} seconds.")
        except requests.RequestException as e:
            raise Exception(f"Failed to fetch data due to a request exception: {e}")

        if response.status_code != 200:
            try:
                error_message = response.json().get("error", {}).get("issues", [{}])[0].get("message", "Unknown error")
            except:
                error_message = "Unknown error"
            raise Exception(f"Failed to fetch data. Server Error: {error_message}")

        data = response.json()
        image_data.extend(data["items"])

        cursor = data.get("metadata", {}).get("nextCursor")
        if not cursor:
            break

    return image_data


# Function to download images and associated metadata
def download_images(image_data, target_folder):
    if not os.path.exists(target_folder):
        os.makedirs(target_folder)

    def download_image(item):
        image_id = item["id"]
        image_url = item["url"]

        # Download the image to a temporary byte stream
        try:
            image_response = requests.get(image_url, stream=True, timeout=TIMEOUT)
            if image_response.status_code != 200:
                raise Exception(f"Failed to download image. HTTP Status: {image_response.status_code}")

            temp_image_data = image_response.content

        except requests.Timeout:
            raise Exception(f"Timeout while downloading image {image_id} after {TIMEOUT} seconds.")

        # Detect the image type using Pillow
        try:
            image_stream = io.BytesIO(temp_image_data)
            image = Image.open(image_stream)
            file_extension = f".{image.format.lower()}"
        except Exception:
            file_extension = ".jpeg"  # Default if detection fails

        image_filename = os.path.join(target_folder, f"{image_id}{file_extension}")

        # Check if the file already exists
        if os.path.isfile(image_filename):
            return

        # Save the image to the target folder
        with open(image_filename, "wb") as image_file:
            image_file.write(temp_image_data)

        # Save the metadata file
        metadata_filename = os.path.join(target_folder, f"{image_id}.metadata")
        with open(metadata_filename, "w") as metadata_file:
            metadata_file.write(str(item))

        # Save the prompt text if it exists
        prompt_text = item.get("meta", {}).get("prompt")
        if prompt_text:
            prompt_filename = os.path.join(target_folder, f"{image_id}.txt")
            with open(prompt_filename, "w") as text_file:
                text_file.write(prompt_text)

    with concurrent.futures.ThreadPoolExecutor(max_workers=10) as executor:
        executor.map(download_image, image_data)


# Main function to execute the script with named arguments
def main():
    parser = argparse.ArgumentParser(description="Download images from Civitai based on model_version_id.")
    parser.add_argument("--model_version_id", type=str, required=True, help="The model_version_id to fetch images for.")
    parser.add_argument("--target_path", type=str, required=True, help="The target folder to download images.")
    parser.add_argument("--api_key_json", type=str, required=True, help="Path to the JSON file containing the API key.")

    args = parser.parse_args()

    model_version_id = args.model_version_id
    target_folder = args.target_path
    api_key_json = args.api_key_json

    api_key = load_api_key(api_key_json)

    if not os.path.exists(target_folder):
        os.makedirs(target_folder)

    try:
        image_data = fetch_image_data(model_version_id, api_key)

        # Save the list of files with the correct extensions
        files_list_filename = os.path.join(target_folder, f"{model_version_id}_filelist.txt")
        with open(files_list_filename, "w") as files_list_file:
            for item in image_data:
                image_id = item["id"]
                image_url = item["url"]
                file_extension = os.path.splitext(image_url)[1].lower()
                if file_extension not in [".jpeg", ".jpg", ".png", ".webp"]:
                    file_extension = ".jpeg"
                files_list_file.write(f"{image_id}{file_extension}\n")

        download_images(image_data, target_folder)

    except Exception as e:
        sys.exit(str(e))


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        sys.exit(str(e))
