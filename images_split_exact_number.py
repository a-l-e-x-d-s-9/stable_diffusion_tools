import argparse
import os
import shutil
import random
import collections

# List of image extensions to filter by
IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.tiff', '.webp']

def split_files(source_folder, target_folder, split_amount, copy_files, exclude_folder, exclude_files, with_captions):
    all_images = []

    for root, _, files in os.walk(source_folder):
        if exclude_folder and exclude_folder in root:
            continue

        for file in files:
            base_name, ext = os.path.splitext(file)
            if ext.lower() in IMAGE_EXTENSIONS and base_name not in exclude_files:
                all_images.append(os.path.join(root, file))

    # Ensure we have enough images
    if len(all_images) < split_amount:
        print(f"Not enough images to meet the required split_amount of {split_amount}. Available images: {len(all_images)}")
        split_amount = len(all_images)

    # Randomly select the required number of images
    selected_images = random.sample(all_images, split_amount)

    for src_image in selected_images:
        dst_dir = os.path.join(target_folder, os.path.relpath(os.path.dirname(src_image), source_folder))
        os.makedirs(dst_dir, exist_ok=True)
        dst_image = os.path.join(dst_dir, os.path.basename(src_image))

        if copy_files:
            shutil.copy2(src_image, dst_image)
        else:
            shutil.move(src_image, dst_image)

        # Move or copy the corresponding caption file if necessary
        if with_captions:
            base_name, _ = os.path.splitext(src_image)
            src_caption_file = base_name + ".txt"
            dst_caption_file = os.path.join(dst_dir, os.path.basename(src_caption_file))
            if os.path.exists(src_caption_file):
                if copy_files:
                    shutil.copy2(src_caption_file, dst_caption_file)
                else:
                    shutil.move(src_caption_file, dst_caption_file)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description='Move or copy random images from a source folder to a target folder.')
    parser.add_argument('--source-folder', required=True, help='The source folder to move or copy images from.')
    parser.add_argument('--target-folder', required=True, help='The target folder to move or copy images to.')
    parser.add_argument('--split-amount', type=int, required=True, help='The number of images to move or copy.')
    parser.add_argument('--copy-files', action='store_true', default=False, help='Copy images instead of moving them.')
    parser.add_argument('--exclude-folder', type=str, help='Folder to exclude from the operation.')
    parser.add_argument('--exclude-files', default=[], required=False, type=str, nargs='*', help='Files (without extension) to exclude from the operation.')
    parser.add_argument('--with_captions', action='store_true', default=False, help='Move or copy corresponding TXT files for each image.')

    args = parser.parse_args()

    split_files(args.source_folder, args.target_folder, args.split_amount, args.copy_files, args.exclude_folder, args.exclude_files, args.with_captions)


# python3 images_split_exact_number.py --source-folder /path/to/source/folder --target-folder /path/to/target/folder --split-amount 3 --copy-files --exclude-folder /path/to/exclude/folder --exclude-files file1 file2 file3


