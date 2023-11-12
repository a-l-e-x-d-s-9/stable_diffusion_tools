import argparse
import os
import urllib.request
import concurrent.futures

# Create the argument parser
parser = argparse.ArgumentParser(description='Download files from a list of URLs.')
parser.add_argument('--file', metavar='FILE', type=str, help='the path to the file containing the URLs')
parser.add_argument('--folder', metavar='FOLDER', type=str, help='the path to the folder to save downloaded files')
parser.add_argument('--delimiter', metavar='DELIMITER', type=str, nargs='?', default=None, help='delimiter to split the text and save to a txt file')

# Define a function to download a file and create a text file if needed
def download_file(url_text, folder, delimiter=None):
    try:
        #print(f"url_text: {url_text}")
        #print(f"delimiter: '{delimiter}'")
        # Split the URL and the text if a delimiter is provided
        if delimiter and delimiter in url_text:
            url, text = url_text.split(delimiter, 1)
            text = text.strip()
        else:
            url = url_text
            text = None

        #print(f"text: '{text}'")

        file_name = os.path.basename(url)
        file_path = os.path.join(folder, file_name)

        # Download the file
        if not os.path.exists(file_path):
            urllib.request.urlretrieve(url, file_path)

        # If text is available, create a .txt file
        if text:
            text_file_path = os.path.splitext(file_path)[0] + ".txt"
            #print(f"text_file_path: {text_file_path}")
            with open(text_file_path, 'w') as text_file:
                text_file.write(text)

        return "downloaded"

    except urllib.error.HTTPError as e:
        print(f"HTTP error ({e.code}): {e.reason} - {url}")
    except urllib.error.URLError as e:
        print(f"URL error: {e.reason} - {url}")
    except Exception as e:
        print(f"Error downloading {url}: {e}")

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
            futures = {executor.submit(download_file, url, args.folder, args.delimiter): url for url in urls}

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
