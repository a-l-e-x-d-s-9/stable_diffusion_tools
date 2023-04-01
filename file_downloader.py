import argparse
import os
import urllib.request
import concurrent.futures

# Create the argument parser
parser = argparse.ArgumentParser(description='Download files from a list of URLs.')
parser.add_argument('--file', metavar='FILE', type=str, help='the path to the file containing the URLs')
parser.add_argument('--folder', metavar='FOLDER', type=str, help='the path to the folder to save downloaded files')

# Define a function to download a file
def download_file(url, folder):
    try:
        # Get the file name from the URL
        file_name = os.path.basename(url)
        # Create the full path to save the file
        file_path = os.path.join(folder, file_name)
        # Check if the file already exists
        if os.path.exists(file_path):
            #print(f"{file_name} already exists, skipping download.")
            None
        else:
            # Download the file
            urllib.request.urlretrieve(url, file_path)
            #print(f"{file_name} downloaded successfully.")

    except urllib.error.HTTPError as e:
        print(f"HTTP error ({e.code}): {e.reason} - {url}")
    except urllib.error.URLError as e:
        print(f"URL error: {e.reason} - {url}")
    except Exception as e:
        print(f"Error downloading {url}: {e}")


# Parse the command line arguments
args = parser.parse_args()

if not os.path.isdir(args.folder):
    print(f"Error: {args.folder} is not a valid directory.")
    exit()

try:
    # Open the file of URLs


    with open(args.file, 'r') as url_file:
        urls = url_file.read().splitlines()
        total = len(urls)
        counter = 0

        # Use a thread pool executor to download files in parallel
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as executor:
            # Download each file in the list of URLs
            futures = [executor.submit(download_file, url, args.folder) for url in urls]
            # Wait for all downloads to finish
            concurrent.futures.wait(futures)
            counter += 1

            print(f'\rProcessed {counter}/{total} images.', end='', flush=True)
except FileNotFoundError:
    print(f"Error: File {args.file} not found.")


# Usage: python3 file_downloader.py --file urls.txt --folder downloads