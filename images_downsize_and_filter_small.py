import os
import argparse
import sys
import traceback
import shutil
from concurrent.futures import ProcessPoolExecutor
from PIL import Image, ImageOps
from tqdm.contrib.concurrent import process_map


SUPPORTED_EXTENSIONS = ('.png', '.jpg', '.jpeg', '.webp', '.tiff', '.bmp')


def red_print(print_content: str):
    red = '\033[0;31m'
    nc = '\033[0m'
    print(f"{red}{print_content}{nc}", flush=True)


def sanitize_flat_prefix(relative_dir: str) -> str:
    if relative_dir in ('', '.'):
        return 'root'
    safe = relative_dir.replace('\\', '_').replace('/', '_')
    safe = '_'.join(part for part in safe.split('_') if part)
    return safe or 'root'


def build_output_filename(file_path: str, source_path: str, flat_output: bool) -> str:
    file_name_full = os.path.basename(file_path)
    file_name_without_extension, _ = os.path.splitext(file_name_full)

    if not flat_output:
        return file_name_without_extension + '.jpg'

    relative_dir = os.path.relpath(os.path.dirname(file_path), source_path)
    prefix = sanitize_flat_prefix(relative_dir)
    return f'{prefix}_{file_name_without_extension}.jpg'


def unique_destination_path(path: str) -> str:
    if not os.path.exists(path):
        return path

    base, ext = os.path.splitext(path)
    counter = 1
    while True:
        candidate = f'{base}_{counter}{ext}'
        if not os.path.exists(candidate):
            return candidate
        counter += 1


def convert_image(image_path, source_path, target_directory, max_resolution, min_resolution, small_images_folder, flat_output):
    try:
        new_file_name = build_output_filename(image_path, source_path, flat_output)
        new_image_path = os.path.join(target_directory, new_file_name)

        if os.path.isfile(new_image_path):
            print(f'File already exists: {new_image_path}. Skipping...')
            return

        with Image.open(image_path) as img:
            img = ImageOps.exif_transpose(img)
            width, height = img.size

            if ((width * height) < (min_resolution * min_resolution)) and \
                    ((width < min_resolution) and (height < min_resolution)):
                small_base_name = os.path.basename(image_path)
                small_image_path = os.path.join(small_images_folder, small_base_name)
                if flat_output:
                    small_prefix = sanitize_flat_prefix(os.path.relpath(os.path.dirname(image_path), source_path))
                    small_image_path = os.path.join(small_images_folder, f'{small_prefix}_{small_base_name}')
                small_image_path = unique_destination_path(small_image_path)
                os.makedirs(os.path.dirname(small_image_path), exist_ok=True)
                shutil.move(image_path, small_image_path)
                return

            if img.mode not in ('RGB',):
                img = img.convert('RGB')

            if (width * height) > (max_resolution * max_resolution):
                ratio = min(max_resolution / width, max_resolution / height)
                new_size = (
                    max(1, int(width * ratio)),
                    max(1, int(height * ratio)),
                )
                img = img.resize(new_size, resample=Image.LANCZOS)

            os.makedirs(target_directory, exist_ok=True)
            img.save(new_image_path, format='JPEG', quality=95, optimize=True)

    except Exception as e:
        red_print(f'Error processing, possibly not copied: {image_path}: {e}, {traceback.format_exc()}')


def process_image(file_path, source_path, target_path, max_resolution, min_resolution, small_images_folder, flat_output):
    relative_path = os.path.relpath(os.path.dirname(file_path), source_path)

    if flat_output:
        target_directory = target_path
        small_images_directory = small_images_folder
    else:
        target_directory = os.path.join(target_path, relative_path)
        small_images_directory = os.path.join(small_images_folder, relative_path)

    os.makedirs(target_directory, exist_ok=True)
    os.makedirs(small_images_directory, exist_ok=True)

    convert_image(
        file_path,
        source_path,
        target_directory,
        max_resolution,
        min_resolution,
        small_images_directory,
        flat_output,
    )


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Resize images in a directory and filter by size.')
    parser.add_argument('--source_path', type=str, required=True, help='Path to folder with source images.')
    parser.add_argument('--target_path', type=str, required=True, help='Path to folder for output images.')
    parser.add_argument('--small_images_folder', type=str, required=True, help='Path to folder for small images.')
    parser.add_argument('--min_resolution', type=int, default=128, help='Minimum resolution of images.')
    parser.add_argument('--max_resolution', type=int, default=2048, help='Maximum resolution of images.')
    parser.add_argument(
        '--flat-output',
        action='store_true',
        help='Copy all output images into the same output folder and prefix each filename with its source folder path.',
    )
    parser.add_argument(
        '--max-workers',
        type=int,
        default=min(20, os.cpu_count() or 1),
        help='Number of worker processes to use.',
    )
    args = parser.parse_args()

    source_path = os.path.abspath(args.source_path)
    target_path = os.path.abspath(args.target_path)
    small_images_folder = os.path.abspath(args.small_images_folder)
    min_resolution = args.min_resolution
    max_resolution = args.max_resolution
    flat_output = args.flat_output
    max_workers = args.max_workers

    if not os.path.isdir(source_path):
        print(f'Error: {source_path} is not a directory')
        sys.exit(1)

    if os.path.isfile(target_path):
        print(f'Error: {target_path} need to be directory, not a file.')
        sys.exit(1)

    if os.path.isfile(small_images_folder):
        print(f'Error: {small_images_folder} need to be directory, not a file.')
        sys.exit(1)

    os.makedirs(target_path, exist_ok=True)
    os.makedirs(small_images_folder, exist_ok=True)

    if max_resolution <= 0 or min_resolution <= 0:
        print('Error: max and min resolutions must be positive integers')
        sys.exit(1)

    if max_resolution <= min_resolution:
        print('Error: max resolution must be greater than min resolution')
        sys.exit(1)

    if max_workers <= 0:
        print('Error: max-workers must be a positive integer')
        sys.exit(1)

    images_to_process = []
    for dirpath, dirnames, filenames in os.walk(source_path):
        for file_name in filenames:
            file_path = os.path.join(dirpath, file_name)
            if file_name.lower().endswith(SUPPORTED_EXTENSIONS):
                images_to_process.append(file_path)

    if not images_to_process:
        print('No supported images found.')
        sys.exit(0)

    process_map(
        process_image,
        images_to_process,
        [source_path] * len(images_to_process),
        [target_path] * len(images_to_process),
        [max_resolution] * len(images_to_process),
        [min_resolution] * len(images_to_process),
        [small_images_folder] * len(images_to_process),
        [flat_output] * len(images_to_process),
        max_workers=max_workers,
        chunksize=1,
    )

    print('\nDone.')
