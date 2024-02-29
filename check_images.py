import os
import argparse
from concurrent.futures import ThreadPoolExecutor
from PIL import Image, UnidentifiedImageError, ImageFile
from tqdm import tqdm

def check_image(source_path):
    ImageFile.LOAD_TRUNCATED_IMAGES = False  # Handle truncated images

    # Define a set of acceptable image formats
    acceptable_formats = {'JPEG', 'PNG', 'BMP', 'GIF', 'TIFF', 'WEBP'}

    try:
        with Image.open(source_path) as img:
            img.load()  # Explicitly load the image data
            if img.format not in acceptable_formats:
                print(f"Unacceptable image format ({img.format}) for file: {source_path}")
                return False
            # If this succeeds, the image is accessible, in the correct format, and can be opened
            return True

    except UnidentifiedImageError:
        print(f"File is not an image or unrecognized format: {source_path}")
        return False

    except Exception as e:
        print(f"Error processing file {source_path}: {e}")
        try:
            os.remove(source_path)
            print(f"File {source_path} successfully deleted.")
        except Exception as delete_error:
            print(f"Failed to delete {source_path}: {delete_error}")
        return False

def get_all_images(source_folder):
    all_images = []
    # Define a set of acceptable image file extensions
    image_extensions = {'.jpg', '.jpeg', '.png', '.bmp', '.gif', '.tiff', '.tif', '.webp'}

    for root, dirs, files in os.walk(source_folder):
        for file in files:
            if os.path.splitext(file)[1].lower() in image_extensions:
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
