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

# Create an argument parser
parser = argparse.ArgumentParser(description='Download images from Getty Images')
parser.add_argument('--output', required=True, help='Output directory for downloaded images')
parser.add_argument('--input', required=True, help='Input file with URLs')
parser.add_argument('--cookie_file', required=True, help='File containing Cookie data for the requests')

# Parse the arguments
args = parser.parse_args()

# Read cookie data from file
with open(args.cookie_file, 'r') as f:
    cookie_data = f.read().strip()


# Create output directory if it doesn't exist
os.makedirs(args.output, exist_ok=True)

# Specify the URL and the headers
url = 'https://steptodown.com/getty-images-downloader/get.php'
headers = {
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
    'Accept-Encoding': 'gzip, deflate, br',
    'Accept-Language': 'en-IL,en;q=0.9,he-IL;q=0.8,he;q=0.7,en-GB;q=0.6,en-US;q=0.5',
    'Content-Type': 'application/x-www-form-urlencoded',
    'Origin': 'https://steptodown.com',
    'Referer': 'https://steptodown.com/getty-images-downloader/',
    'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/113.0.0.0 Safari/537.36',
    'Cookie': cookie_data
}

# Create a lock for file operations
file_lock = Lock()

def extract_img_url(html_content: str, base_domain: str) -> str:
    # Regex pattern to find image tag with the given style and src attributes
    pattern = r'images/steptodown.com([^"]+)'
    
    # Find all matches
    matches = re.findall(pattern, html_content)
    
    # If a match was found
    if matches:
        # Complete the URL if it is relative and return
        return base_domain + matches[0]
    
    # Return empty string if no match was found
    return ""


def download_image(idx, url_and_alt):
    original_url, alt_text = url_and_alt.split(" Alt: ", 1)
    data = {'url': original_url}


    attempts_amount = 4
    success = False  # flag to indicate whether the image download was successful

    for _ in range(attempts_amount):
        # Send the POST request
        response = requests.post(url, headers=headers, data=data)

        # If the POST request is successful, the status code will be 200
        if response.status_code == 200:
            print(f'Request was successful for URL {idx}.')
            rawdata = response.content

            html_content = rawdata.decode('utf-8')
            image_file_url = extract_img_url(html_content, "https://steptodown.com/getty-images-downloader/images/steptodown.com")

            # Get the filename from the image_file_url
            file_name = os.path.join(args.output, os.path.basename(urllib.parse.urlparse(image_file_url).path))

            # Download and save the image
            for _ in range(attempts_amount):
                image_response = requests.get(image_file_url, stream=True)
                if image_response.status_code == 200:
                    with open(file_name, 'wb') as file:
                        for chunk in image_response.iter_content(chunk_size=128):
                            file.write(chunk)
                    if os.path.getsize(file_name) > 0:  # if file is not zero size
                        print(f'Image downloaded and saved as {file_name}')

                        # Split the file name and its extension
                        file_name_without_ext, _ = os.path.splitext(file_name)

                        # Change the extension to .txt
                        new_file_name = file_name_without_ext + ".txt"

                        # Open the new file in write mode and write the alt text
                        with open(new_file_name, 'w') as file:
                            file.write(alt_text)

                        success = True  # set the flag to indicate that the image download was successful
                        break
                    else:  # if file is zero size
                        os.remove(file_name)  # remove the zero-sized file
                else:
                    print('Image download failed with status code', image_response.status_code)

                # Wait before the next attempt
                time.sleep(random.uniform(1, 4))  # wait for 1 to 4 seconds before next attempt

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



with open(args.input, 'r') as f:
    urls_and_alts = f.read().splitlines()

with ThreadPoolExecutor(max_workers=50) as executor:
    for idx, url_and_alt in enumerate(urls_and_alts, start=1):
        executor.submit(download_image, idx, url_and_alt)
