import argparse
import concurrent.futures
import json
import os
import requests
from urllib.parse import urlparse
import multiprocessing

def download_image(image_url, target_folder, txt_content, counter):
    url_path = urlparse(image_url).path
    image_name = os.path.basename(url_path)
    target_path = os.path.join(target_folder, image_name)

    # Check if the file already exists
    if os.path.exists(target_path):
        with counter.get_lock():
            counter.value += 1
            # print(f"Existing {counter.value} images", end="\r")
        return

    response = requests.get(image_url)
    response.raise_for_status()

    with open(target_path, 'wb') as f:
        f.write(response.content)

    txt_path = os.path.splitext(target_path)[0] + ".txt"
    with open(txt_path, 'w') as f:
        f.write(txt_content)

    with counter.get_lock():
        counter.value += 1
        print(f"Downloaded {counter.value} images", end="\r")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--data", type=str, required=True)
    parser.add_argument("--folder", type=str, required=True)
    parser.add_argument("--additional-tags", type=str, required=True)
    args = parser.parse_args()

    with open(args.data, 'r') as f:
        raw_data = json.load(f)
        data = {key: value for key, value in raw_data.items()}

    os.makedirs(args.folder, exist_ok=True)

    counter = multiprocessing.Value('i', 0)

    with concurrent.futures.ThreadPoolExecutor(max_workers=30) as executor:
        for entry in data.values():
            modelName = ", ".join(tag.lower() for tag in entry["modelName"])
            tags = ", ".join(tag.lower() for tag in entry["tags"])

            additional_tags = args.additional_tags
            # remove leading and trailing spaces, convert to lowercase, replace "_" with space, and split into a list
            tag_list = [tag.strip().lower().replace("_", " ") for tag in additional_tags.split(",")]

            if tag_list:
                # convert list back to string
                tag_string_cleaned = ", ".join(tag_list)
                tag_string_cleaned = ", " + tag_string_cleaned

            txt_content = f"{modelName}, {tags}{tag_string_cleaned}"

            for image_url in entry["imageLinks"]:
                if image_url.lower().endswith(('.png', '.jpg', '.jpeg', '.gif')):
                    executor.submit(download_image, image_url, args.folder, txt_content, counter)
                #else:
                    #print(f"Skipping non-image URL: {image_url}")


if __name__ == "__main__":
    main()


# Usage example: python3 /home/alexds9/Documents/stable_diffusion/stable_diffusion_tools/images_gathering/morepics/morepics_download.py --data '/path/download_info.json'  --folder '/path/Dowloads' --additional-tags "text, English text, signature, watermark, site address"