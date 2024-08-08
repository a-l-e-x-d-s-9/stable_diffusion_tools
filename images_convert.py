import os
import argparse
from concurrent.futures import ThreadPoolExecutor
from PIL import Image, UnidentifiedImageError
import threading
import shutil

# We'll use a Lock to make sure that the counter is thread-safe
counter_lock = threading.Lock()
num_converted = 0

# List of known image extensions
image_extensions = {'.png', '.webp', '.jpg', '.jpeg'}

def process_file(args):
    source_path, target_path, quality = args

    try:
        ext = os.path.splitext(source_path)[1].lower()

        if ext in {'.jpg', '.jpeg'}:
            # If it's a JPEG or JPG, just copy it
            shutil.copy2(source_path, target_path)
        elif ext in image_extensions:
            # Convert other image formats
            img = Image.open(source_path)
            img.convert('RGB').save(target_path, 'JPEG', quality=quality)
            global num_converted
            with counter_lock:
                num_converted += 1
                print(f'\rImages converted and copied: {num_converted}', end='')
        else:
            # Non-image file, just copy it
            shutil.copy2(source_path, target_path)

    except UnidentifiedImageError:
        # If the file is not an image, copy it
        shutil.copy2(source_path, target_path)
        print(f'Copied non-image file: {source_path}')
    except Exception as e:
        print(f'Failed {source_path}: {e}')
        pass

def get_all_files(source_folder, target_folder, quality):
    all_files = []

    for root, dirs, files in os.walk(source_folder):
        for file in files:
            source_path = os.path.join(root, file)
            rel_path = os.path.relpath(source_path, source_folder)
            ext = os.path.splitext(source_path)[1].lower()

            if ext in image_extensions:
                if ext not in {'.jpg', '.jpeg'}:
                    base, _ = os.path.splitext(rel_path)
                    target_path = os.path.join(target_folder, base + '.jpg')
                else:
                    target_path = os.path.join(target_folder, rel_path)
            else:
                target_path = os.path.join(target_folder, rel_path)

            target_subfolder = os.path.dirname(target_path)
            os.makedirs(target_subfolder, exist_ok=True)

            # Check if the target file already exists
            if not os.path.exists(target_path):
                all_files.append((source_path, target_path, quality))

    return all_files

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--source-folder', required=True, help='The source directory')
    parser.add_argument('--target-folder', required=True, help='The target directory')
    parser.add_argument('--quality-level', required=True, type=int, help='The quality level for the JPEG compression')
    args = parser.parse_args()

    all_files = get_all_files(args.source_folder, args.target_folder, args.quality_level)

    with ThreadPoolExecutor(max_workers=20) as executor:
        executor.map(process_file, all_files)

if __name__ == '__main__':
    main()
