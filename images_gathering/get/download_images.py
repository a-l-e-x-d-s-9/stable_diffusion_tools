import requests
import os
import urllib.parse
import re
import argparse
from concurrent.futures import ThreadPoolExecutor
from threading import Lock
import time
import random
import brotli
from urllib.parse import quote
import base64
import hashlib

# Specify the URL and the headers
url_dla = 'https://downloader.la/gt.php'
headers_dla = {
    'Accept': 'application/json, text/javascript, */*; q=0.01',
    'Accept-Encoding': 'gzip, deflate, br',
    'Accept-Language': 'en-IL,en;q=0.9,he-IL;q=0.8,he;q=0.7,en-GB;q=0.6,en-US;q=0.5',
    'Content-Type': 'application/x-www-form-urlencoded',
    'Origin': 'https://downloader.la',
    'Referer': 'https://downloader.la/gettyimages-downloader.html',
    'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/113.0.0.0 Safari/537.36',
    'Cookie': ""
}

url_sdw = 'https://steptodown.com/getty-images-downloader/get.php'
headers_sdw = {
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
    'Accept-Encoding': 'gzip, deflate, br',
    'Accept-Language': 'en-IL,en;q=0.9,he-IL;q=0.8,he;q=0.7,en-GB;q=0.6,en-US;q=0.5',
    'Content-Type': 'application/x-www-form-urlencoded',
    'Origin': 'https://steptodown.com',
    'Referer': 'https://steptodown.com/getty-images-downloader/',
    'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/113.0.0.0 Safari/537.36',
    'Cookie': ""
}

# Create a lock for file operations
file_lock = Lock()

def extract_img_url(html_content: str, base_domain: str, pattern) -> str:
    # Regex pattern to find image tag with the given style and src attributes
    #pattern = r'temp/([^"]+)'

    # Find all matches
    matches = re.findall(pattern, html_content)

    # If a match was found
    if matches:
        # Complete the URL if it is relative and return
        return base_domain + matches[0]

    # Return empty string if no match was found
    return ""

MAX_FILE_SIZE = 4 * 1024 * 1024  # 4 MB in bytes

# Function to extract components from a given text line
def extract_components(line):
    # Initialize the image_path as None
    image_path = ""

    # Check for "https://media." to find and extract the image path
    if "https://media." in line:
        # Split by space and identify the image path (first occurrence of "https://media.")
        words = line.split(" ")
        for word in words:
            if word.startswith("https://media."):
                image_path = word
                break

        # Remove the image path from the original line
        cleaned_line = " ".join([w for w in words if w != image_path])
    else:
        cleaned_line = line  # If no image path, use the original line

    # Split the cleaned line by "Alt:" to get the original URL and alt text
    if "Alt:" in cleaned_line:
        original_url, alt_text = cleaned_line.split(" Alt: ", 1)
    else:
        raise ValueError("Line does not contain 'Alt:'")

    return image_path, original_url, alt_text

def generate_unique_filename(image_url):
    # Find the text between "/photo/" and "?"
    match = re.search(r'/photo/(.+?)\?', image_url)
    if match:
        # Get the original file name
        original_file_name = match.group(1)

        # Generate a hash from the full URL path
        url_path = image_url.split('?')[0]  # Exclude query parameters
        hash_value = hashlib.md5(url_path.encode()).hexdigest()[:8]  # Get first 8 characters of the hash

        # Append the hash to the original file name
        file_name_without_ext, ext = os.path.splitext(original_file_name)
        unique_file_name = f"{file_name_without_ext}_{hash_value}{ext}"

        return unique_file_name
    else:
        raise ValueError("Could not extract file name from URL")

def download_preview_image(image_url, file_path):
    attempts = 5
    success = False

    for attempt in range(attempts):
        response = requests.get(image_url, stream=True)

        if response.status_code == 200:
            # Check content type to ensure it's an image
            if 'image' not in response.headers.get('Content-Type', ''):
                print(f"Invalid content type for image download: {response.headers.get('Content-Type')}")
                break

            # Check file size to ensure it's within the limit
            content_length = int(response.headers.get('Content-Length', 0))
            if content_length > MAX_FILE_SIZE:
                print(f"File size too large ({content_length} bytes). Skipping download.")
                break

            with open(file_path, 'wb') as file:
                for chunk in response.iter_content(chunk_size=8192):
                    file.write(chunk)

            # Verify file size after download
            if os.path.getsize(file_path) > 0:
                success = True
                break
            else:
                os.remove(file_path)  # remove zero-sized files

        else:
            print(f"Failed to download with status code {response.status_code}")

        time.sleep(random.uniform(2, 6))  # Random wait between 2 and 6 seconds

    return success

def download_image(idx, data_for_entry, download_small, download_large_skip):
    image_path, original_url, alt_text = extract_components(data_for_entry)
    #, 'token': ""

    if download_small and ("" != image_path):
        print("Downloading small")

        # Extract the filename from the image URL
        filename = generate_unique_filename(image_path)
        if filename:
            output_dir = args.output
            preview_image_path = os.path.join(output_dir, filename)

            # Download the image and save it with the correct filename
            if download_preview_image(image_path, preview_image_path):
                print(f"Preview image downloaded and saved as {preview_image_path}")

                # Create a text file to store alt text information and filename
                txt_file_path = os.path.splitext(preview_image_path)[0] + ".txt"
                with open(txt_file_path, 'w') as file:
                    file.write(alt_text)

            else:
                print(f"Failed to download preview image for {idx}")

    if not download_large_skip:
        data = {'url': quote(original_url, safe='')}

        attempts_amount = 8
        success = False  # flag to indicate whether the image download was successful

        for _ in range(attempts_amount):
            # Send the POST request
            #response = requests.get(headers_dla, headers=headers_sdw, params=data) # headers=headers,
            response = requests.post(url_sdw, headers=headers_sdw, data=data)  # headers=headers,

            print("URL accessed:", response.url)
            # If the POST request is successful, the status code will be 200
            if response.status_code == 200:
                print(f'Request was successful for URL {idx}.')
                rawdata = str(response.content)

                if False:
                    json_response = response.json()
                    # html_content = rawdata.decode('utf-8')

                    #print(f'json_response {json_response}.')
                    page_with_image_url = json_response["result"]

                    # Extract the token from the URL fragment
                    token = page_with_image_url.split('#').pop()

                    # Decode the Base64-encoded string
                    decoded_url = base64.b64decode(token).decode('utf-8')

                    #print("Decoded URL:", decoded_url)

                    image_file_url = decoded_url#extract_img_url(html_content, "https://downloader.la/")

                image_file_url = extract_img_url(rawdata, "https://steptodown.com/getty-images-downloader/images/steptodown", r"src=\"images/steptodown([^\"]+)")

                # Get the filename from the image_file_url
                file_name = os.path.join(args.output, os.path.basename(urllib.parse.urlparse(image_file_url).path))

                # Download and save the image
                MAX_FILE_SIZE = 4 * 1024 * 1024  # 4MB in bytes

                for _ in range(attempts_amount):
                    image_response = requests.get(image_file_url, stream=True)
                    if image_response.status_code == 200:
                        # Check if the content length exceeds the limit
                        content_length = int(image_response.headers.get('Content-Length', 0))
                        if content_length > MAX_FILE_SIZE:
                            print(f"Skipping download. File size too large ({content_length} bytes).")
                            break  # If the file is too large, break out of the loop

                        payload_size = len(image_response.content)

                        if payload_size > 0:
                            with open(file_name, 'wb') as file:
                                for chunk in image_response.iter_content(chunk_size=8192):
                                    file.write(chunk)

                            # Verify that the file is not zero-sized after download
                            if os.path.getsize(file_name) > 0:
                                print(f'Image downloaded and saved as {file_name}')

                                # Create a text file with the same base name and alt text
                                file_name_without_ext, _ = os.path.splitext(file_name)
                                txt_file_name = file_name_without_ext + ".txt"
                                with open(txt_file_name, 'w') as file:
                                    file.write(alt_text)

                                success = True  # Set success flag if download is complete
                                break  # Exit the loop if successful
                            else:
                                # If the file is zero-sized, delete it
                                os.remove(file_name)
                        else:
                            print("Payload size is zero; image may be empty.")

                    else:
                        print(f"Image download failed with status code {image_response.status_code}")

                    # Wait a random time before retrying
                    time.sleep(random.uniform(3, 6))
                # wait for 1 to 4 seconds before next attempt

                # if the image is successfully downloaded, break the outer loop as well
                if success:
                    break
                else:  # if the image is still not downloaded or zero size after attempts_amount tries
                    print( f'Image download failed or image is zero size after {attempts_amount} attempts for URL {idx}, retrying POST request.')
            else:
                print(f'Request failed with status code {response.status_code} for URL {idx}.')

            # Wait before the next attempt
            time.sleep(random.uniform(3, 10))  # wait for 3 to 10 seconds before next attempt

        if not success:  # if the process still fails after attempts_amount tries
            print(f'\033[91mProcess failed after {attempts_amount} attempts for URL {idx}, moving to the next URL.\033[0m')
            # Add the original URL to the failed URLs file
            with file_lock:
                with open(args.input + '_failed', 'a') as f:
                    f.write(f'{original_url} Alt: {alt_text}\n')


if __name__ == "__main__":
    # Create an argument parser
    parser = argparse.ArgumentParser(description='Download images from Getty Images')
    parser.add_argument('--output', required=True, help='Output directory for downloaded images')
    parser.add_argument('--input', required=True, help='Input file with URLs')
    parser.add_argument('--cookie_file', required=False, help='File containing Cookie data for the requests')
    parser.add_argument('--download-small', required=False, default=False, action="store_true",
                        help='Download the small image')
    parser.add_argument('--download-large-skip', required=False, default=False, action="store_true",
                        help='Skip downloading of large images')

    # Parse the arguments
    args = parser.parse_args()

    read_cookie = False # It needs
    
    cookie_data = ""
    if args.cookie_file:
        # Read cookie data from file
        with open(args.cookie_file, 'r') as f:
            cookie_data = f.read().strip()

    headers_dla["Cookie"] = cookie_data
    headers_sdw["Cookie"] = cookie_data

    # Create output directory if it doesn't exist
    os.makedirs(args.output, exist_ok=True)

    with open(args.input, 'r') as f:
        urls_and_alts = f.read().splitlines()

    with ThreadPoolExecutor(max_workers=25) as executor:
        for idx, data_for_entry in enumerate(urls_and_alts, start=1):
            executor.submit(download_image, idx, data_for_entry, args.download_small, args.download_large_skip)
