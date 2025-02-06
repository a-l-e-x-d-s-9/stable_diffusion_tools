import argparse
import os
import shutil
import random
import re
import string

# List of image extensions to filter by
IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.tiff', '.webp']

# Characters to use for generating random suffixes
RANDOM_CHARS = string.ascii_letters + string.digits

def sanitize_filename(filename, target_folder):
    base_name, ext = os.path.splitext(filename)
    sanitized_base_name = re.sub(r'[<>:"/\\|?*]', '', base_name)
    original_sanitized_name = sanitized_base_name
    count = 0

    def file_exists_in_target(name):
        return os.path.exists(os.path.join(target_folder, name))

    sanitized_name = f"{sanitized_base_name}{ext}"
    while file_exists_in_target(sanitized_name) and count < 100:
        suffix = ''.join(random.choices(RANDOM_CHARS, k=4))
        sanitized_name = f"{sanitized_base_name}_{suffix}{ext}"
        count += 1

    if count >= 100:
        raise Exception("Failed to generate a unique filename after 100 attempts.")

    return sanitized_name

def split_files(source_folder, target_folder, split_amount, copy_files, exclude_folder, exclude_files, with_captions, split_by_subfolder, flatten):
    if split_by_subfolder:
        subfolders = [os.path.join(source_folder, d) for d in os.listdir(source_folder) if os.path.isdir(os.path.join(source_folder, d))]
        for subfolder in subfolders:
            subfolder_name = os.path.basename(subfolder)
            target_subfolder = os.path.join(target_folder, subfolder_name)
            process_images(subfolder, target_subfolder, split_amount, copy_files, exclude_folder, exclude_files, with_captions, flatten, keep_subfolder=subfolder_name)
    else:
        process_images(source_folder, target_folder, split_amount, copy_files, exclude_folder, exclude_files, with_captions, flatten)

def process_images(source_folder, target_folder, split_amount, copy_files, exclude_folder, exclude_files, with_captions, flatten, keep_subfolder=None):
    all_images = []

    for root, _, files in os.walk(source_folder):
        if exclude_folder and exclude_folder in root:
            continue

        for file in files:
            base_name, ext = os.path.splitext(file)
            if ext.lower() in IMAGE_EXTENSIONS and base_name not in exclude_files:
                all_images.append(os.path.join(root, file))

    if len(all_images) < split_amount:
        print(f"Not enough images in {source_folder} to meet the required split_amount of {split_amount}. Available images: {len(all_images)}")
        split_amount = len(all_images)

    selected_images = random.sample(all_images, split_amount)

    for src_image in selected_images:
        if flatten:
            dst_dir = target_folder
        else:
            relative_path = os.path.relpath(os.path.dirname(src_image), source_folder)
            dst_dir = os.path.join(target_folder, relative_path)

        os.makedirs(dst_dir, exist_ok=True)

        sanitized_filename = sanitize_filename(os.path.basename(src_image), dst_dir)
        dst_image = os.path.join(dst_dir, sanitized_filename)

        if copy_files:
            shutil.copy2(src_image, dst_image)
        else:
            shutil.move(src_image, dst_image)

        if with_captions:
            base_name, _ = os.path.splitext(src_image)
            src_caption_file = base_name + ".txt"
            if os.path.exists(src_caption_file):
                sanitized_caption_filename = os.path.splitext(sanitized_filename)[0] + ".txt"
                dst_caption_file = os.path.join(dst_dir, sanitized_caption_filename)
                if copy_files:
                    shutil.copy2(src_caption_file, dst_caption_file)
                else:
                    shutil.move(src_caption_file, dst_caption_file)

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description='Move or copy random images from a source folder to a target folder.')
    parser.add_argument('--source-folder', required=True, help='The source folder to move or copy images from.')
    parser.add_argument('--target-folder', required=True, help='The target folder to move or copy images to.')
    parser.add_argument('--split-amount', type=int, required=True, help='The number of images to move or copy per folder.')
    parser.add_argument('--copy-files', action='store_true', default=False, help='Copy images instead of moving them.')
    parser.add_argument('--exclude-folder', type=str, help='Folder to exclude from the operation.')
    parser.add_argument('--exclude-files', default=[], required=False, type=str, nargs='*', help='Files (without extension) to exclude from the operation.')
    parser.add_argument('--with-captions', action='store_true', default=False, help='Move or copy corresponding TXT files for each image.')
    parser.add_argument('--split-by-subfolder', action='store_true', default=False, help='Process each subfolder within the source folder separately.')
    parser.add_argument('--flatten', action='store_true', default=False, help='Flatten the target folder structure, placing all files directly in the target folder.')

    args = parser.parse_args()

    split_files(args.source_folder, args.target_folder, args.split_amount, args.copy_files, args.exclude_folder, args.exclude_files, args.with_captions, args.split_by_subfolder, args.flatten)
