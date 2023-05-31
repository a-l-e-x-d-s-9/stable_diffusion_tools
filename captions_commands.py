import os
import random
import argparse
import logging
from concurrent.futures import ThreadPoolExecutor
from typing import List, Tuple
import glob
from PIL import Image
from io import BytesIO
import traceback
import mimetypes

IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.bmp', '.tiff']
VALID_MIME_TYPES = [mimetypes.types_map[ext] for ext in IMAGE_EXTENSIONS if ext in mimetypes.types_map]
LOG_FORMAT = "%(asctime)s — %(levelname)s — %(message)s"
logging.basicConfig(level=logging.INFO, format=LOG_FORMAT)


def get_image_files(subject_folder):
    # Initialize empty list to hold image file paths
    image_files = []

    # Loop over each image extension
    for extension in IMAGE_EXTENSIONS:
        # Use glob to find all files with the current extension in the subject folder
        image_files += glob.glob(os.path.join(subject_folder, f"**/*{extension}"), recursive=True)
        # Also check for uppercase versions of the extension
        image_files += glob.glob(os.path.join(subject_folder, f"**/*{extension.upper()}"), recursive=True)

    return image_files

def get_caption_files(subject_folder):
    return glob.glob(f"{subject_folder}/*.txt")

def validate_input(path: str, tag: str = None) -> None:
    if not os.path.exists(path):
        logging.error(f"Path {path} does not exist.")
        raise ValueError(f"Path {path} does not exist.")
    if tag and not isinstance(tag, str):
        logging.error(f"Tag {tag} is not a string.")
        raise ValueError(f"Tag {tag} is not a string.")

def read_file(file_path: str) -> List[str]:
    validate_input(file_path)
    try:
        with open(file_path, 'r') as file:
            return file.read().split(', ')
    except (IOError, PermissionError) as e:
        logging.error(f"Unable to read file {file_path}: {str(e)}")
        raise

def write_file(file_path: str, tags: List[str], dry_run: bool = False) -> None:
    validate_input(file_path)
    if dry_run:
        logging.info(f"Dry run: Would write {tags} to {file_path}")
    else:
        try:
            with open(file_path, 'w') as file:
                file.write(', '.join(tags))
        except (IOError, PermissionError) as e:
            logging.error(f"Unable to write to file {file_path}: {str(e)}")
            raise


def get_subject_folders(root_folder: str) -> List[str]:
    validate_input(root_folder)
    folders = [os.path.join(root_folder, folder) for folder in os.listdir(root_folder)]
    return [folder for folder in folders if os.path.isdir(folder)]

def validate_folder_structure(subject_folder: str) -> None:
    validate_input(subject_folder)
    if not all(os.path.isdir(os.path.join(subject_folder, subfolder)) for subfolder in ['core', 'occasional', 'validation']):
        logging.error(f"Folder structure for {subject_folder} is not valid. Expected subfolders: 'core', 'occasional', 'validation'.")
        raise ValueError(f"Folder structure for {subject_folder} is not valid. Expected subfolders: 'core', 'occasional', 'validation'.")

def get_caption_files(subject_folder: str) -> List[str]:
    validate_input(subject_folder)
    caption_files = []
    for root, dirs, files in os.walk(subject_folder):
        for file in files:
            if file.endswith('.txt'):
                caption_files.append(os.path.join(root, file))
    return caption_files

def clean_tags(tags: List[str]) -> List[str]:
    return list(dict.fromkeys(tags))

def remove_tag_from_file(file_path: str, tag: str) -> None:
    tags = read_file(file_path)
    tags = [t for t in tags if t != tag]
    write_file(file_path, tags)

def add_tag_to_file(file_path: str, tag: str, start: int, stop: int, dry_run: bool=False) -> None:
    if not os.path.exists(file_path):
        logging.error(f"{file_path} does not exist.")
        return
    if not os.path.isfile(file_path):
        logging.error(f"{file_path} is not a file.")
        return
    if start < 0 or stop < 0:
        logging.error("Start and stop must be non-negative.")
        return
    if start > stop:
        logging.error("Start must be less than or equal to stop.")
        return
    if tag is None or tag.strip() == '':
        logging.error("Invalid tag. Tag must be a non-empty string.")
        return
    tags = read_file(file_path)
    tags = clean_tags(tags)
    if tag not in tags:
        if stop > len(tags):
            stop = len(tags)
        position = random.randint(start, stop)
        tags.insert(position, tag)
        logging.info(f"Tag {tag} added at position {position}")
    else:
        logging.info(f"Tag {tag} already present")
    if not dry_run:
        try:
            write_file(file_path, tags)
        except (IOError, PermissionError) as e:
            logging.error(f"Unable to write to file: {str(e)}")
            raise
    else:
        logging.info("Dry run mode, no changes were made to the file.")





def move_to_validation(root_folder: str, from_folder: str, dry_run: bool = False) -> None:
    subject_folders = get_subject_folders(root_folder)
    for subject_folder in subject_folders:
        validate_folder_structure(subject_folder)
        from_folder_path = os.path.join(subject_folder, from_folder)
        validation_folder_path = os.path.join(subject_folder, 'validation')
        if not os.path.exists(from_folder_path) or not os.path.isdir(from_folder_path):
            logging.error(f"{from_folder_path} does not exist or is not a directory.")
            continue
        if not os.path.exists(validation_folder_path) or not os.path.isdir(validation_folder_path):
            logging.error(f"{validation_folder_path} does not exist or is not a directory.")
            continue
        image_files = [os.path.join(from_folder_path, file) for file in os.listdir(from_folder_path) if
                       file.endswith(tuple(IMAGE_EXTENSIONS))]
        if not image_files:
            logging.error(f"No image files found in {from_folder_path}.")
            continue
        random_image_file = random.choice(image_files)
        validation_image_file = random_image_file.replace(from_folder, 'validation')
        if os.path.exists(validation_image_file):
            logging.error(f"Image file {random_image_file} already exists in validation folder.")
            continue
        caption_file = random_image_file.replace(from_folder, 'validation').replace(
            os.path.splitext(random_image_file)[-1], '.txt')
        validation_caption_file = caption_file.replace(from_folder, 'validation')
        if os.path.exists(validation_caption_file):
            logging.error(f"Caption file {caption_file} already exists in validation folder.")
            continue

        if dry_run:
            logging.info(
                f"Dry run: Would move {random_image_file} to {validation_image_file}")
            logging.info(f"Dry run: Would move {caption_file} to {validation_caption_file}")
        else:
            try:
                os.rename(random_image_file, validation_image_file)
                os.rename(caption_file, validation_caption_file)
            except (IOError, PermissionError) as e:
                logging.error(f"Unable to move files: {str(e)}")
                raise





def search_for_tags(root_folder, tag, output_file, threads=10):
    results = []
    with ThreadPoolExecutor(max_workers=threads) as executor:
        for subject_folder in get_subject_folders(root_folder):
            for caption_file in get_caption_files(subject_folder):
                if tag in read_file(caption_file):
                    results.append(caption_file)
    with open(output_file, 'w') as file:
        for result in results:
            file.write(f"{result}\n")


from collections import Counter

def full_statistic(root_folder, output_file, threads=10):
    tag_counter = Counter()
    with ThreadPoolExecutor(max_workers=threads) as executor:
        for subject_folder in get_subject_folders(root_folder):
            for caption_file in get_caption_files(subject_folder):
                tags = read_file(caption_file)
                tag_counter.update(tags)
    with open(output_file, 'w') as file:
        for tag, count in tag_counter.most_common():
            file.write(f"{tag}: {count}\n")


def statistic_for_subject(subject_folder, output_file):
    tag_counter = Counter()
    for caption_file in get_caption_files(subject_folder):
        tags = read_file(caption_file)
        tag_counter.update(tags)
    with open(output_file, 'w') as file:
        for tag, count in tag_counter.most_common():
            file.write(f"{tag}: {count}\n")

def check_image_validity_and_size(file_path: str, min_size: int, max_size: int) -> str:
    try:
        with open(file_path, 'rb') as file:
            img = Image.open(file)
            img.verify()

            if Image.MIME.get(img.format) not in VALID_MIME_TYPES:
                return f"Invalid image format: {Image.MIME.get(img.format)}"

            width, height = img.size
            if width * height < min_size**2:
                return f"Image size below minimum: {width}x{height}"
            if width * height > max_size**2:
                return f"Image size above maximum: {width}x{height}"
    except Exception as e:
        return f"Invalid image file: {str(e)}"
    return None

def check_caption_validity(file_path: str, min_tags: int) -> str:
    try:
        tags = read_file(file_path)
        if len(tags) < min_tags:
            return f"Number of tags in caption below minimum: {len(tags)}"
    except Exception as e:
        return f"Invalid caption file: {str(e)}"
    return None

def check_image_caption_pairs(root_folder: str, min_size: int, max_size: int, min_tags: int, threads: int) -> List[Tuple[str, str]]:
    errors = []
    with ThreadPoolExecutor(max_workers=threads) as executor:
        subject_folders = get_subject_folders(root_folder)
        for subject_folder in subject_folders:
            caption_files = get_caption_files(subject_folder)
            image_files = get_image_files(subject_folder)  # assumes this function exists and returns image files
            for caption_file in caption_files:
                # get the file name without the extension
                base_name = os.path.splitext(caption_file)[0]

                # find the corresponding image file
                image_file = None
                for ext in IMAGE_EXTENSIONS:
                    potential_image_file = base_name + ext
                    if potential_image_file in image_files:
                        image_file = potential_image_file
                        break

                # if no corresponding image file was found, add an error and skip this caption file
                if image_file is None:
                    errors.append((caption_file, 'No corresponding image file found'))
                    continue

                image_error = executor.submit(check_image_validity_and_size, image_file, min_size, max_size)
                caption_error = executor.submit(check_caption_validity, caption_file, min_tags)
                if image_error.result():
                    errors.append((image_file, image_error.result()))
                if caption_error.result():
                    errors.append((caption_file, caption_error.result()))

            for image_file in image_files:
                # get the file name without the extension
                base_name = os.path.splitext(image_file)[0]

                # find the corresponding caption file
                potential_caption_file = base_name + ".txt"
                if potential_caption_file not in caption_files:
                    errors.append((image_file, 'No corresponding caption file found'))

    return errors


def check_images_and_captions(root_folder: str, min_size: int, max_size: int, min_tags: int, output_file: str, threads: int) -> None:
    errors = check_image_caption_pairs(root_folder, min_size, max_size, min_tags, threads)
    try:
        with open(output_file, 'w') as file:
            for error in errors:
                file.write(f"{error[0]}: {error[1]}\n")
    except (IOError, PermissionError) as e:
        logging.error(f"Unable to open output file for writing: {str(e)}")
        raise



def main(args):
    if args.mode in ['search_for_tags', 'full_statistic', 'statistic_for_subject'] and args.output_file is None:
        raise Exception(f"Output file must be specified for mode '{args.mode}'.")

    if args.mode == 'check_images_and_captions':
        if args.min_size is None or args.max_size is None or args.min_tags is None:
            raise Exception("min_size, max_size, and min_tags must be specified for 'check_images_and_captions' mode.")
        check_images_and_captions(args.root, args.min_size, args.max_size, args.min_tags, args.output_file, args.threads)
    elif args.mode == 'remove_tag_all':
        with ThreadPoolExecutor(max_workers=args.threads) as executor:
            for subject_folder in get_subject_folders(args.root):
                for caption_file in get_caption_files(subject_folder):
                    executor.submit(remove_tag_from_file, caption_file, args.tag)
    elif args.mode == 'add_tag_all':
        with ThreadPoolExecutor(max_workers=args.threads) as executor:
            for subject_folder in get_subject_folders(args.root):
                for caption_file in get_caption_files(subject_folder):
                    executor.submit(add_tag_to_file, caption_file, args.tag, args.start, args.stop, args.dry_run)
    elif args.mode == 'add_tag_single':
        subject_folder = os.path.join(args.root, args.tag)
        validate_folder_structure(subject_folder)
        with ThreadPoolExecutor(max_workers=args.threads) as executor:
            for caption_file in get_caption_files(subject_folder):
                executor.submit(add_tag_to_file, caption_file, args.tag, args.start, args.stop, args.dry_run)
    elif args.mode == 'move_to_validation':
        move_to_validation(args.root, args.from_folder, args.dry_run)
    elif args.mode == 'search_for_tags':
        search_for_tags(args.root, args.tag, args.output_file, args.threads)
    elif args.mode == 'full_statistic':
        full_statistic(args.root, args.output_file, args.threads)
    elif args.mode == 'statistic_for_subject':
        subject_folder = os.path.join(args.root, args.tag)
        validate_folder_structure(subject_folder)
        statistic_for_subject(subject_folder, args.output_file)
    else:
        print(f"Invalid mode: {args.mode}")

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description='Script for handling captions for images.')
    parser.add_argument('-m', '--mode', help='Mode of operation. Options: check_images_and_captions, remove_tag_all, add_tag_all, add_tag_single, move_to_validation, search_for_tags, full_statistic, statistic_for_subject.')
    parser.add_argument('-r', '--root', help='Root folder containing all subject folders.')
    parser.add_argument('-t', '--tag', help='Tag to add or remove.')
    parser.add_argument('-s', '--start', type=int, help='Start index for adding tag.')
    parser.add_argument('-e', '--end', type=int, help='End index for adding tag.')
    parser.add_argument('-f', '--from', dest='from_folder', help='Folder from which to move images to validation.')
    parser.add_argument('-th', '--threads', type=int, default=10, help='Number of threads for parallel processing.')
    parser.add_argument('-o', '--output_file', type=str, help='Output file for search and statistic modes.')
    parser.add_argument('-mm', '--min_size', type=int,
                        help='Minimum size of images for check_images_and_captions mode.')
    parser.add_argument('-mx', '--max_size', type=int,
                        help='Maximum size of images for check_images_and_captions mode.')
    parser.add_argument('-mt', '--min_tags', type=int,
                        help='Minimum number of tags in captions for check_images_and_captions mode.')
    parser.add_argument('--dry_run', action='store_true', help='Dry run mode. No changes will be made.')


    args = parser.parse_args()

    try:
        main(args)
    except Exception as e:
        print(f"An unexpected error occurred: {str(e)}")
        print(traceback.format_exc())
