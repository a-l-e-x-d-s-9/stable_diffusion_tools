import requests
import os
import argparse
import concurrent.futures
import sys
import json

# Timeout value for server responses
TIMEOUT = 30  # in seconds

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

# Function to fetch image data from Civitai API based on the username
def fetch_image_data(username, api_key):
    # The endpoint to get images from the specified user
    endpoint = "https://civitai.com/api/v1/images"
    counter = 0

    # Variables for paging through results
    limit = 200  # Maximum allowed limit for batch size
    cursor = None
    image_data = []

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json"
    }

    while True:
        # Build query parameters
        params = {
            "limit": limit,
            "username": username,
            "sort": "Newest",  # Fetching latest images
            "cursor": cursor,  # Paging system,
            "nsfw": "X" # (None, Soft, Mature, X)
        }

        try:
            # Make API call with timeout
            response = requests.get(endpoint, params=params, headers=headers,
                                    timeout=TIMEOUT)
        except requests.Timeout:
            raise Exception(f"Timeout while fetching data from server after {TIMEOUT} seconds.")
        except requests.RequestException as e:
            raise Exception(f"Failed to fetch data due to a request exception: {e}")

        if response.status_code != 200:
            # If server returns an error, try to extract error message
            try:
                error_message = response.json().get("error", {}).get("issues", [{}])[0].get("message", "Unknown error")
            except:
                error_message = "Unknown error"
            raise Exception(f"Failed to fetch data. Server Error: {error_message}")

        data = response.json()
        image_data.extend(data["items"])
        print(f"Fetching[{counter}]:" + str(len(data["items"])))
        counter += 1

        # Check if there's a next cursor to continue paging
        cursor = data.get("metadata", {}).get("nextCursor")
        if not cursor:
            break

    return image_data


# Function to download images and associated metadata
def download_images(image_data, target_folder):
    if not os.path.exists(target_folder):
        os.makedirs(target_folder)

    # Threaded download for efficiency
    def download_image(item):
        image_id = item["id"]
        image_url = item["url"]
        image_filename = os.path.join(target_folder, f"{image_id}.jpeg")

        # Check if image already exists
        if os.path.isfile(image_filename):
            return

        try:
            # Download the image with timeout
            image_response = requests.get(image_url, stream=True, timeout=TIMEOUT)
            if image_response.status_code == 200:
                # Save the image
                with open(image_filename, "wb") as image_file:
                    for chunk in image_response.iter_content(chunk_size=1024):
                        if chunk:
                            image_file.write(chunk)
            else:
                raise Exception(f"Failed to download image. HTTP Status: {image_response.status_code}")

        except requests.Timeout:
            raise Exception(f"Timeout while downloading image {image_id} after {TIMEOUT} seconds.")

        # Save the metadata file
        metadata_filename = os.path.join(target_folder, f"{image_id}.metadata")
        with open(metadata_filename, "w") as metadata_file:
            metadata_file.write(str(item))  # Convert to string and save

        # Save the prompt text if exists
        prompt_text = item.get("meta", {}).get("prompt")
        if prompt_text:
            prompt_filename = os.path.join(target_folder, f"{image_id}.txt")
            with open(prompt_filename, "w") as text_file:
                text_file.write(prompt_text)

    # Use threading for concurrent image downloads
    with concurrent.futures.ThreadPoolExecutor(max_workers=10) as executor:
        executor.map(download_image, image_data)


# Main function to execute the script with named arguments
def main():
    # Argument parser to get named arguments
    parser = argparse.ArgumentParser(description="Download images from Civitai based on username.")
    parser.add_argument("--username", type=str, help="The username to fetch images for.")
    parser.add_argument("--target_path", type=str, help="The target folder to download images.")
    parser.add_argument("--api_key_json", type=str, required=True, help="Path to the JSON file containing the API key.")

    # Parse arguments
    args = parser.parse_args()

    username = args.username
    target_folder = args.target_path
    api_key_json = args.api_key_json

    api_key = load_api_key(api_key_json)

    # Ensure the target folder exists or create it
    if not os.path.exists(target_folder):
        os.makedirs(target_folder)

    # Fetch the image data for the specified user
    image_data = fetch_image_data(username, api_key)

    # Save the list of files with the filename of the username
    files_list_filename = os.path.join(target_folder, f"{username}_filelist.txt")
    with open(files_list_filename, "w") as files_list_file:
        for item in image_data:
            files_list_file.write(f"{item['id']}.jpeg\n")

    # Download images with metadata and text files
    download_images(image_data, target_folder)


# Execute the script
if __name__ == "__main__":
    try:
        main()  # Run the main function
    except Exception as e:
        sys.exit(str(e))  # Exit with error message
