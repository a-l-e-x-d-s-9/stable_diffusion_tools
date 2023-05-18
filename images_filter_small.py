import argparse
import os
import shutil
from concurrent.futures import ThreadPoolExecutor
from PIL import Image

def process_image(image_file, min_resolution, source_path, small_images_folder):
    try:
        with Image.open(os.path.join(source_path, image_file)) as img:
            width, height = img.size

            if width < min_resolution or height < min_resolution:
                shutil.move(
                    os.path.join(source_path, image_file),
                    os.path.join(small_images_folder, image_file)
                )
    except Exception as e:
        print(f"Error processing {image_file}: {e}")

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--min_resolution", type=int, default=576, help="Minimum resolution")
    parser.add_argument("source_path", help="Source path containing images")
    parser.add_argument("small_images_folder", help="Target folder for small images")

    args = parser.parse_args()

    source_path = args.source_path
    small_images_folder = args.small_images_folder
    min_resolution = args.min_resolution

    if not os.path.exists(small_images_folder):
        os.makedirs(small_images_folder)

    image_files = [f for f in os.listdir(source_path) if os.path.isfile(os.path.join(source_path, f))]

    with ThreadPoolExecutor(max_workers=10) as executor:
        for image_file in image_files:
            executor.submit(process_image, image_file, min_resolution, source_path, small_images_folder)

if __name__ == "__main__":
    main()
