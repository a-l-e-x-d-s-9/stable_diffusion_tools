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
        file_name = os.path.basename(url)
        file_path = os.path.join(folder, file_name)

        if os.path.exists(file_path):
            return "skipped"
        else:
            urllib.request.urlretrieve(url, file_path)
            return "downloaded"

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
    with open(args.file, 'r') as url_file:
        urls = url_file.read().splitlines()
        total = len(urls)
        counter = 0

        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as executor:
            futures = {executor.submit(download_file, url, args.folder): url for url in urls}

            for future in concurrent.futures.as_completed(futures):
                url = futures[future]
                try:
                    status = future.result()
                    counter += 1
                    print(f'\rProcessed {counter}/{total} images. {status} - {url}', end='', flush=True)
                except Exception as e:
                    print(f"Error downloading {url}: {e}")

            print(f'\nFinished downloading {total} images.')

except FileNotFoundError:
    print(f"Error: File {args.file} not found.")

# Usage: python3 file_downloader.py --file urls.txt --folder downloads
