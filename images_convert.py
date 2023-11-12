import os
import argparse
from concurrent.futures import ThreadPoolExecutor
from PIL import Image
from PIL import UnidentifiedImageError
import threading

# We'll use a Lock to make sure that the counter is thread-safe
counter_lock = threading.Lock()
num_converted = 0

def compress_image(args):
    source_path, target_path, quality = args

    try:
        img = Image.open(source_path)
        img.save(target_path, 'JPEG', quality=quality)

        global num_converted
        with counter_lock:
            num_converted += 1
            print(f'\rImages converted and copied: {num_converted}', end='')

    except:
        pass

def get_all_images(source_folder, target_folder, quality):
    all_images = []

    for root, dirs, files in os.walk(source_folder):
        for file in files:
            source_path = os.path.join(root, file)
            rel_path = os.path.relpath(source_path, source_folder)
            target_path = os.path.join(target_folder, rel_path)

            base, _ = os.path.splitext(target_path)
            target_path = base + '.jpg'

            target_subfolder = os.path.dirname(target_path)
            os.makedirs(target_subfolder, exist_ok=True)

            # Check if the target file already exists
            if not os.path.exists(target_path):
                try:
                    with Image.open(source_path):
                        all_images.append((source_path, target_path, quality))
                except UnidentifiedImageError:
                    # Not an image, skip this file
                    pass

    return all_images

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--source-folder', required=True, help='The source directory')
    parser.add_argument('--target-folder', required=True, help='The target directory')
    parser.add_argument('--quality-level', required=True, type=int, help='The quality level for the JPEG compression')
    args = parser.parse_args()

    all_images = get_all_images(args.source_folder, args.target_folder, args.quality_level)

    with ThreadPoolExecutor(max_workers=20) as executor:
        executor.map(compress_image, all_images)

if __name__ == '__main__':
    main()
