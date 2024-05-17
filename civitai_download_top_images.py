import requests
import os
import argparse
import concurrent.futures
import sys

# Timeout value for server responses
TIMEOUT = 30  # in seconds

# Function to fetch the top most popular image data from Civitai API with pagination
def fetch_top_images(images_limit, period=None):
    # The endpoint to get images
    endpoint = "https://civitai.com/api/v1/images"

    params = {
        "limit": 200,  # Maximum allowed limit per request
        "sort": "Most Reactions",  # Fetching images sorted by most reactions
    }

    # If a period is specified, add it to the parameters
    if period:
        params['period'] = period

    image_data = []
    remaining_images = images_limit
    next_cursor = None

    while remaining_images > 0:
        params["limit"] = min(remaining_images, 200)
        if next_cursor:
            params["cursor"] = next_cursor

        try:
            # Make API call with timeout
            response = requests.get(endpoint, params=params, headers={"Content-Type": "application/json"}, timeout=TIMEOUT)
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
        remaining_images -= len(data["items"])

        # Check if there's a next cursor to continue paging
        next_cursor = data.get("metadata", {}).get("nextCursor")
        if not next_cursor:
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

# Main function to execute the script
def main(target_folder, images_limit, period=None):
    # Ensure the target folder exists or create it
    if not os.path.exists(target_folder):
        os.makedirs(target_folder)

    # Fetch the top images based on popularity and period
    image_data = fetch_top_images(images_limit, period)

    # Download images with metadata and text files
    download_images(image_data, target_folder)

if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Download the top images from Civitai.",
        epilog="Usage example: python civitai_download_top_images.py --target_path ./images --images_limit 1000 --period Week"
    )
    parser.add_argument("--target_path", type=str, required=True, help="The target folder to download images.")
    parser.add_argument('--images_limit', type=int, default=100, help='Limit of images to fetch.')
    parser.add_argument('--period', type=str, choices=['Week', 'Month'], help='Period to filter images (Week or Month).')

    # Parse arguments
    args = parser.parse_args()

    try:
        main(args.target_path, args.images_limit, args.period)  # Run the main function with the target folder as an argument
    except Exception as e:
        sys.exit(str(e))  # Exit with error message


# python civitai_download_top_images.py --target_path ./images --images_limit 100 --period Week