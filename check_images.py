import os
import argparse
from concurrent.futures import ThreadPoolExecutor
from PIL import Image, UnidentifiedImageError
from tqdm import tqdm

def check_image(source_path):
    try:
        with Image.open(source_path):
            # If this succeeds, the image is accessible and can be opened
            pass  # We don't do anything as we only want to catch errors

    except UnidentifiedImageError:
        # If the file is not an image, skip it
        pass

    except Exception as e:
        # If any other error occurs, print the file path and the error message
        print(f"Error processing file {source_path}: {e}")
        try:
            os.remove(source_path)
            print(f"File {source_path} successfully deleted.")
        except Exception as delete_error:
            print(f"Failed to delete {source_path}: {delete_error}")

def get_all_images(source_folder):
    all_images = []

    for root, dirs, files in os.walk(source_folder):
        for file in files:
            source_path = os.path.join(root, file)
            all_images.append(source_path)

    return all_images

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--source-folder', required=True, help='The source directory')
    args = parser.parse_args()

    all_images = get_all_images(args.source_folder)

    with ThreadPoolExecutor(max_workers=20) as executor:
        # Wrap the executor.map call with tqdm for the progress bar
        list(tqdm(executor.map(check_image, all_images), total=len(all_images)))

if __name__ == '__main__':
    main()
