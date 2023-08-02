import os
import argparse
import sys
import traceback
import shutil
from tqdm import tqdm
from tqdm.contrib.concurrent import process_map  # or thread_map
from PIL import Image

def red_print(print_content: str):
    RED = '\033[0;31m'
    NC = '\033[0m'  # No Color
    print(f"{RED}{print_content}{NC}", flush=True)


def convert_image(image_path, target_directory, max_resolution, min_resolution, small_images_folder):
    try:
        file_name_full = os.path.basename(image_path)
        file_name_without_extension, file_extension = os.path.splitext(file_name_full)
        new_image_path = os.path.join(target_directory, file_name_without_extension + '.jpg')

        if os.path.isfile(new_image_path):
            print(f'File already exists: {new_image_path}. Skipping...')
            return

        img = Image.open(open(image_path, 'rb'))
        width, height = img.size


        if ((width * height) < (min_resolution * min_resolution)) and \
                ((width < min_resolution) and (height < min_resolution)):
            img.close()
            small_image_path = os.path.join(small_images_folder, os.path.basename(image_path))
            os.makedirs(os.path.dirname(small_image_path), exist_ok=True)  # Ensure directory exists before moving file
            shutil.move(image_path, small_image_path)
            return

        if img.mode != 'RGB':
            img = img.convert('RGB')

        if (width * height) > (max_resolution * max_resolution):
            ratio = min(max_resolution / width, max_resolution / height)
            new_size = (int(width * ratio), int(height * ratio))
            img = img.resize(new_size, resample=Image.LANCZOS)

        img.save(new_image_path, format='JPEG', quality=95, optimize=True)
        img.close()

    except Exception as e:
        red_print(f'Error processing, possibly not copied: {image_path}: {e}, {traceback.format_exc()}')



def process_image(file_path, source_path, target_path, max_resolution, min_resolution, small_images_folder):
    relative_path = os.path.relpath(os.path.dirname(file_path), source_path)
    target_directory = os.path.join(target_path, relative_path)
    small_images_directory = os.path.join(small_images_folder, relative_path)

    os.makedirs(target_directory, exist_ok=True)

    convert_image(file_path, target_directory, max_resolution, min_resolution, small_images_directory)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Resize images in a directory and filter by size.')
    parser.add_argument('--source_path', type=str, help='Path to folder with source images.')
    parser.add_argument('--target_path', type=str, help='Path to folder for output images.')
    parser.add_argument('--small_images_folder', type=str, help='Path to folder for small images.')
    parser.add_argument('--min_resolution', type=int, default=128, help='Minimum resolution of images.')
    parser.add_argument('--max_resolution', type=int, default=2048, help='Maximum resolution of images.')
    args = parser.parse_args()

    source_path = args.source_path
    target_path = args.target_path
    small_images_folder = args.small_images_folder
    min_resolution = args.min_resolution
    max_resolution = args.max_resolution


    if not os.path.isdir(source_path):
        print(f'Error: {source_path} is not a directory')
        sys.exit(1)

    if os.path.isfile(target_path):
        print(f'Error: {target_path} need to be directory, not a file.')
        sys.exit(1)

    if not os.path.isdir(target_path):
        print(f'Created target directory: "{target_path}"')
        os.mkdir(target_path)

    if not os.path.isdir(small_images_folder):
        print(f'Created small images directory: "{small_images_folder}"')
        os.mkdir(small_images_folder)

    if max_resolution <= 0 or min_resolution <= 0:
        print('Error: max and min resolutions must be positive integers')
        sys.exit(1)

    if max_resolution <= min_resolution:
        print('Error: max resolution must be greater than min resolution')
        sys.exit(1)

    images_to_process = []
    for dirpath, dirnames, filenames in os.walk(source_path):
        for file_name in filenames:
            file_path = os.path.join(dirpath, file_name)
            if file_name.lower().endswith(('.png', '.jpg', '.jpeg')):
                images_to_process.append(file_path)

    process_map(process_image, images_to_process, [source_path] * len(images_to_process),
                [target_path] * len(images_to_process), [max_resolution] * len(images_to_process),
                [min_resolution] * len(images_to_process), [small_images_folder] * len(images_to_process),
                max_workers=20, chunksize=1)

    print('\nDone.')  # Print a message to indicate when all images have been processed.