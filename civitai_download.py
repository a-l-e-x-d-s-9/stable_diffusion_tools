import subprocess
import os
import sys
import json
from concurrent.futures import ThreadPoolExecutor, as_completed
import time
import requests
from tqdm import tqdm
import logging
import re

def get_filename_from_headers_PRODUCTION(url):
    try:
        wget_cmd = f"wget --content-disposition --spider --server-response {url}"
        result = subprocess.run(wget_cmd, shell=True, text=True, capture_output=True, timeout=10)

        content_disposition = ""
        for line in result.stdout.splitlines() + result.stderr.splitlines():
            if "Content-Disposition" in line:
                content_disposition = line.strip()
                print(f"CONTENT: {content_disposition}")
                break

        if content_disposition:
            filename = re.search(r'filename="?([^"]+)"?', content_disposition)
            if filename:
                return filename.group(1)

    except Exception as e:
        logging.debug(f"Error while getting filename from wget headers for {url}: {e}")

    return None

def get_filename_from_headers_DEBUG(url):
    try:
        wget_cmd = f"wget --content-disposition --spider --server-response {url}"
        result = subprocess.run(wget_cmd, shell=True, text=True, capture_output=True, timeout=10)

        print("STDOUT:")
        print(result.stdout)
        print("STDERR:")
        print(result.stderr)

        content_disposition = ""
        for line in result.stdout.splitlines() + result.stderr.splitlines():
            if "Content-Disposition" in line:
                content_disposition = line.strip()
                print(f"CONTENT: {content_disposition}")
                break

        if content_disposition:
            filename = re.search(r'filename="?([^"]+)"?', content_disposition)
            if filename:
                return filename.group(1)
            else:
                print("Filename not found in content_disposition")
        else:
            print("Content-Disposition not found in stdout and stderr")

    except Exception as e:
        logging.debug(f"Error while getting filename from wget headers for {url}: {e}")

    return None

def get_filename_from_headers_POST_FAILED(url):
    try:
        response = requests.head(url, timeout=10)
        content_disposition = response.headers.get("Content-Disposition", "")

        if content_disposition:
            filename = re.search(r'filename="?([^"]+)"?', content_disposition)
            if filename:
                return filename.group(1)
        else:
            print("Content-Disposition not found in headers")

    except Exception as e:
        print(f"Error while getting filename from headers for {url}: {e}")

    return None

def get_filename_from_log(log):
    try:
        filename = re.search(r'filename="?([^"]+)"?', log)
        if filename:
            return filename.group(1)
    except Exception as e:
        print(f"Error while getting filename from log: {e}")

    return None

def get_filename_from_headers(url):
    try:
        with requests.get(url, stream=True, timeout=10) as response:
            content_disposition = response.headers.get("Content-Disposition", "")

        if content_disposition:
            filename = re.search(r'filename="?([^"]+)"?', content_disposition)
            if filename:
                return filename.group(1)
        else:
            print("Content-Disposition not found in headers")

    except Exception as e:
        print(f"Error while getting filename from headers for {url}: {e}")

    return None

def call_wget(url, output_path, timeout, retries, range_header):
    for attempt in range(retries):
        try:
            logging.debug(f"Attempt {attempt + 1} for downloading {url}")

            # Construct the wget command with timeout, headers, and content-disposition
            wget_cmd = f"wget --content-disposition   -O {output_path} --timeout={timeout} {range_header} {url}"

            # Run the wget command
            result = subprocess.run(wget_cmd, shell=True, text=True, capture_output=True)

            # Check the exit code to determine if the download was successful
            if result.returncode == 0:
                return True, ""
            else:
                error_message = f"Error while downloading: {result.stderr}"
                logging.debug(f"Error while downloading {url}: {error_message}")

        except Exception as e:
            error_message = f"Unexpected error: {e}"
            logging.debug(f"Unexpected error while downloading {url}: {error_message}")

    return False, error_message
    
    

def load_config(config_file):
    with open(config_file, "r") as f:
        config = json.load(f)
    return config


def check_file_size(file_path, min_size_gb):
    file_size_gb = os.path.getsize(file_path) / (1024**3)
    return file_size_gb >= min_size_gb
    
    
def download_file(url, output_directory, timeout, retries, min_file_size_gb):
    type_value = re.search(r"type=([^&]+)", url).group(1)
    format_value = re.search(r"format=([^&]+)", url).group(1)
    file_name = f"{type_value}_{format_value}.bin"
    output_path = os.path.join(output_directory, file_name)

    # Get the file name from wget headers
    wget_filename = get_filename_from_headers(url)
    if wget_filename:
        file_name = wget_filename
        output_path = os.path.join(output_directory, file_name)
        print(f"WGET, file_name: {file_name}, output_path: {output_path}.")
    
    # Check if the file with the same name exists before attempting to download
    if any(file.startswith(file_name) for file in os.listdir(output_directory)):
        logging.info(f"File {file_name} already exists. Skipping download.")
        return f"File {file_name} already exists. Skipping download."

    # Check if the file exists to resume the download
    if os.path.exists(output_path):
        file_size = os.path.getsize(output_path)
        range_header = f"--header=Range:bytes={file_size}-"
    else:
        range_header = ""

    success, error_message = call_wget(url, output_path, timeout, retries, range_header)

    if success:
        # Save the link to the model in a txt file
        txt_file_name = f"{file_name}.txt"
        txt_file_path = os.path.join(output_directory, txt_file_name)
        with open(txt_file_path, "w") as txt_file:
            txt_file.write(url)

        if check_file_size(output_path, min_file_size_gb):
            logging.info(f"File {file_name} downloaded successfully and meets the minimum size requirement.")
            return f"File {file_name} downloaded successfully and meets the minimum size requirement."
        else:
            os.remove(output_path)
            logging.warning(f"File {file_name} downloaded successfully but does not meet the minimum size requirement.")
            return f"File {file_name} downloaded successfully but does not meet the minimum size requirement."
    else:
        logging.error(f"Failed to download the file {file_name}. {error_message}")
        return f"Failed to download the file {file_name}. {error_message}"

        
        
def get_content_length(url):
    try:
        response = requests.head(url)
        content_length = response.headers.get('Content-Length')
        return content_length
    except Exception as e:
        return None

def main():
    config = load_config("download_config.json")

    urls = config["urls"]
    output_directory = config["output_directory"]
    timeout = config["timeout"] * 60  # Convert minutes to seconds
    retries = config["retries"]
    min_file_size_gb = config["min_file_size_gb"]
    max_workers = config["max_workers"]
    log_file = config["log_file"]

    if not os.path.exists(output_directory):
        os.makedirs(output_directory)

    logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
    logger = logging.getLogger()
    logger.setLevel(logging.DEBUG)

    # Add a FileHandler to save logs to a file
    file_handler = logging.FileHandler(log_file)
    file_handler.setFormatter(logging.Formatter('%(asctime)s - %(levelname)s - %(message)s'))
    file_handler.setLevel(logging.DEBUG)
    logger.addHandler(file_handler)

    # Add a StreamHandler to print log messages to the console
    #console_handler = logging.StreamHandler(sys.stdout)
    #console_handler.setFormatter(logging.Formatter('%(asctime)s - %(levelname)s - %(message)s'))
    #console_handler.setLevel(logging.DEBUG)
    #logger.addHandler(console_handler)

    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures = {executor.submit(download_file, url, output_directory, timeout, retries, min_file_size_gb): url for url in urls}
        results = []

        for future in tqdm(as_completed(futures), total=len(urls), desc="Downloading files", ncols=80):
            result = future.result()
            results.append(result)

    for result in results:
        print(result)

if __name__ == "__main__":
    main()
