import concurrent
import os
import random
import argparse
import logging
from concurrent.futures import ThreadPoolExecutor
from typing import List, Tuple
import glob
from PIL import Image, UnidentifiedImageError
import traceback
import mimetypes
from queue import Queue, Empty
from threading import Lock
from pathlib import Path
from tqdm import tqdm
from multiprocessing import Value

IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.bmp', '.tiff', '.webp']
VALID_MIME_TYPES = [mimetypes.types_map[ext] for ext in IMAGE_EXTENSIONS if ext in mimetypes.types_map]
VALID_MIME_TYPES.append('image/webp')
LOG_FORMAT = "%(asctime)s — %(levelname)s — %(message)s"
logging.basicConfig(level=logging.INFO, format=LOG_FORMAT)


def get_image_files_in_current_folder(subject_folder):
    # Initialize empty list to hold image file paths
    image_files_list = []

    # Loop over each image extension
    for extension in IMAGE_EXTENSIONS:
        # Use glob to find all files with the current extension in the subject folder

        found_captions_1 = glob.glob(os.path.join(subject_folder, f"*{extension}"), recursive=False)
        if found_captions_1:
            image_files_list += found_captions_1


        found_captions_2 = glob.glob(os.path.join(subject_folder, f"*{extension.upper()}"), recursive=False)
        # Also check for uppercase versions of the extension
        if found_captions_2:
            image_files_list += found_captions_2

    return image_files_list


def get_caption_files(subject_folder):
    captions_files_list = []

    # Now using the recursive parameter to search within subdirectories
    found_captions = glob.glob(f"{subject_folder}/*.txt", recursive=True)
    #print(f"DEBUG: Searching in {subject_folder}, found captions len: {len(found_captions)}")  # Debugging line
    if found_captions:
        captions_files_list += found_captions

    return captions_files_list



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
            return tags_str_to_list(file.read())
    except (IOError, PermissionError) as e:
        logging.error(f"Unable to read file {file_path}: {str(e)}")
        raise

def tags_str_to_list(all_tags_str: str) -> List[str]:
    tags = all_tags_str.lower().split(',')
    return [tag.strip() for tag in tags if tag.strip()]


def detect_and_remove_empty_tags(file_path: str) -> None:
    validate_input(file_path)
    try:
        with open(file_path, 'r') as file:
            tags_str = file.read()

            # Replace newline characters with commas
            new_tags_str = tags_str.replace('\n', ',')
            newline_replaced = tags_str != new_tags_str

            tags = new_tags_str.split(',')

        new_tags = tags_str_to_list(new_tags_str)

        # Write back to the file if empty tags were removed or newlines were replaced
        if len(tags) != len(new_tags) or newline_replaced:
            logging.info(f"Remove empty tags from or replaced newlines in: {file_path}.")
            with open(file_path, 'w') as file:
                file.write(', '.join(new_tags))
    except (IOError, PermissionError) as e:
        logging.error(f"Unable to read or write to file {file_path}: {str(e)}")
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

# def get_all_sub_folders(root_folder: str):
#     validate_input(root_folder)
#     folders = [os.path.join(root_folder, name) for name in os.listdir(root_folder) if os.path.isdir(os.path.join(root_folder, name))]
#     folders.append(root_folder)  # Include the root_folder itself in the list
#     return folders

def get_all_sub_folders(root_folder: str):
    validate_input(root_folder)
    folders = []

    folders.append(root_folder)  # Include the root_folder itself in the list

    for dirpath, dirnames, files in os.walk(root_folder):
        for name in dirnames:
            folders.append(os.path.join(dirpath, name))

    return folders

def validate_folder_structure(subject_folder: str) -> None:
    validate_input(subject_folder)
    if not all(os.path.isdir(os.path.join(subject_folder, subfolder)) for subfolder in ['core', 'occasional']): # , 'validation'
        logging.error(f"Folder structure for {subject_folder} is not valid. Expected subfolders: 'core', 'occasional', 'validation'.")
        raise ValueError(f"Folder structure for {subject_folder} is not valid. Expected subfolders: 'core', 'occasional', 'validation'.")

def get_caption_files_recursively(subject_folder: str) -> List[str]:
    validate_input(subject_folder)
    caption_files = []
    for root, dirs, files in os.walk(subject_folder):
        for file in files:
            if file.endswith('.txt'):
                caption_files.append(os.path.join(root, file))
    return caption_files

def clean_tags(tags: List[str]) -> List[str]:
    return list(dict.fromkeys(tags))

import re

def is_valid_tag(tag: str) -> bool:
    # Check if the tag is empty
    if not tag:
        return False

    # Check if the tag starts or ends with a hyphen or underscore
    if tag[0] in "-_" or tag[-1] in "-_":
        return False

    # Check if the tag contains consecutive hyphens or underscores
    if "--" in tag or "__" in tag:
        return False

    return True


def remove_tags_from_file(file_path: str, tags_to_remove: str, output_file: str, dry_run: bool = False) -> None:
    # Convert the input string to a list of tags
    tags_to_remove = [tag.strip() for tag in tags_to_remove.split(',') if tag.strip() and tag.strip() != "_"]

    # Normalize the tags (lowercase, replace underscores with spaces)
    tags_to_remove = [tag.lower().replace('_', ' ') for tag in tags_to_remove]

    # Validate the tags to remove
    invalid_tags = [tag for tag in tags_to_remove if not is_valid_tag(tag)]
    if invalid_tags:
        tags_to_remove = [tag for tag in tags_to_remove if is_valid_tag(tag)]
        with open(output_file, 'a') as file:   # Change 'w' to 'a' to append instead of overwriting
            file.write(f"Invalid tags in {file_path}: {', '.join(invalid_tags)}\n")

    # Read the existing tags from the file
    existing_tags = read_file(file_path)

    # Normalize the existing tags
    existing_tags = [tag.lower().strip().replace('_', ' ') for tag in existing_tags]

    # Remove the specified tags from the list of existing tags
    updated_tags = [tag for tag in existing_tags if tag not in tags_to_remove]

    if not dry_run:
        # Write the updated list of tags back to the file
        write_file(file_path, updated_tags)
    else:
        with open(output_file, 'a') as file:   # Change 'w' to 'a' to append instead of overwriting
            file.write(f"Tags to be removed from {file_path}: {', '.join(tags_to_remove)}\n")


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
        start = min(start, stop)
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


def tag_replace_in_file(caption_file: str, old_tag: str, new_tag: str, dry_run=False)-> None:
    if not os.path.exists(caption_file):
        logging.error(f"{caption_file} does not exist.")
        return
    if not os.path.isfile(caption_file):
        logging.error(f"{caption_file} is not a file.")
        return
    if old_tag is None or old_tag.strip() == '':
        logging.error("Invalid old tag. Old tag must be a non-empty string.")
        return
    if new_tag is None or new_tag.strip() == '':
        logging.error("Invalid new tag. New tag must be a non-empty string.")
        return

    is_changed = False
    tags_original = read_file(caption_file)
    tags = clean_tags(tags_original)
    is_changed = len(tags_original) != len(tags)

    if old_tag in tags:
        # Replace all occurrences of old_tag with new_tag and ensure the tag only appears once
        tags = [new_tag if tag == old_tag else tag for tag in tags]
        tags = list(dict.fromkeys(tags))

        is_changed = True

        logging.info(f"Tag {old_tag} replaced with {new_tag}")
    else:
        pass
        # logging.info(f"Tag {old_tag} not present, no changes made")

    if not dry_run:
        try:
            if is_changed:
                write_file(caption_file, tags)
        except (IOError, PermissionError) as e:
            logging.error(f"Unable to write to file: {str(e)}")
            raise
    else:
        logging.info("Dry run mode, no changes were made to the file.")


def remove_tags_beside_specified(caption_file: str, tags_to_preserve: List[str], output_file: str, dry_run=False) -> None:
    #logging.info(f"start.")

    if not os.path.exists(caption_file):
        logging.error(f"{caption_file} does not exist.")
        return
    if not os.path.isfile(caption_file):
        logging.error(f"{caption_file} is not a file.")
        return
    if not isinstance(tags_to_preserve, list) or len(tags_to_preserve) == 0:
        logging.error("Invalid tags to preserve. Must be a non-empty list of strings.")
        return

    is_changed = False
    tags_original = read_file(caption_file)
    tags = clean_tags(tags_original)
    is_changed = len(tags_original) != len(tags)

    preserved_tags = [tag for tag in tags if tag in tags_to_preserve]

    #logging.info(f"preserved_tags amount: {len(preserved_tags)}.")

    if len(tags_original) != len(preserved_tags):
        tags = preserved_tags
        is_changed = True
        #logging.info(f"Preserved tags: {', '.join(tags_to_preserve)}")
    else:
        logging.info("No changes made.")

    if not dry_run:
        try:
            if is_changed:
                write_file(caption_file, tags)
        except (IOError, PermissionError) as e:
            logging.error(f"Unable to write to file: {str(e)}")
            raise
    else:
        logging.info("Dry run mode, no changes were made to the file.")

def move_to_validation(root_folder: str, from_folders: List[str], validation_folder: str, num_files: int, dry_run: bool = False) -> None:
    all_subject_folders = get_subject_folders(root_folder)
    max_failures = 10  # Maximum number of consecutive failed attempts before giving up
    print(1)
    for subject_folder in all_subject_folders:
        if os.path.basename(subject_folder) not in from_folders:
            continue

        print(1.1)
        print(f"subject_folder: {subject_folder}")
        relative_subject_folder = os.path.relpath(subject_folder, root_folder)
        from_folder_path = os.path.join(root_folder, relative_subject_folder)
        validation_folder_path = os.path.join(validation_folder, relative_subject_folder)
        print(f"1.2, validation_folder: {validation_folder}, subject_folder: {subject_folder}")
        if not os.path.exists(from_folder_path) or not os.path.isdir(from_folder_path):
            logging.error(f"{from_folder_path} does not exist or is not a directory.")
            continue
        print(1.3)
        if not os.path.exists(validation_folder_path) or not os.path.isdir(validation_folder_path):
            logging.info(f"{validation_folder_path} does not exist or is not a directory. Creating it.")
            if not dry_run:
                try:
                    os.makedirs(validation_folder_path, exist_ok=True)
                except Exception as e:
                    logging.error(f"Failed to create validation directory: {str(e)}")
                    continue

        print(2)
        num_successes = 0  # Number of successful moves
        num_failures = 0  # Number of consecutive failures

        while num_successes < num_files and num_failures < max_failures:
            print(f"3, validation_folder_path: {validation_folder_path}")
            image_files = [os.path.join(from_folder_path, file) for file in os.listdir(from_folder_path) if
                           file.endswith(tuple(IMAGE_EXTENSIONS))]


            if not image_files:
                logging.error(f"No image files found in {from_folder_path}.")
                break
            random_image_file = random.choice(image_files)

            # First generate the name of the validation image file without changing the original path
            validation_image_file = os.path.join(validation_folder_path, os.path.basename(random_image_file))

            if os.path.exists(validation_image_file):
                logging.error(f"Image file {random_image_file} already exists in validation folder.")
                num_failures += 1
                continue

            # Do the same for the caption file
            caption_file = os.path.splitext(random_image_file)[0] + '.txt'
            validation_caption_file = os.path.join(validation_folder_path, os.path.basename(caption_file))

            if os.path.exists(validation_caption_file):
                logging.error(f"Caption file {caption_file} already exists in validation folder.")
                num_failures += 1
                continue

            if dry_run:
                logging.info(
                    f"Dry run: Would move {random_image_file} to {validation_image_file}")
                logging.info(f"Dry run: Would move {caption_file} to {validation_caption_file}")
            else:
                try:
                    os.rename(random_image_file, validation_image_file)
                    if os.path.exists(caption_file):
                        os.rename(caption_file, validation_caption_file)
                except (IOError, PermissionError) as e:
                    logging.error(f"Unable to move files: {str(e)}")
                    raise

            num_successes += 1
            num_failures = 0  # Reset the number of failures

        if num_failures == max_failures:
            logging.error(f"Failed to move files after {max_failures} consecutive attempts.")



def search_for_tags(root_folder, tag, output_file, threads=10):
    results = []
    with ThreadPoolExecutor(max_workers=threads) as executor:
        for subject_folder in get_all_sub_folders(root_folder):
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
        for subject_folder in get_all_sub_folders(root_folder):
            for caption_file in get_caption_files(subject_folder):
                tags = read_file(caption_file)
                tag_counter.update(tags)
    with open(output_file, 'w') as file:
        for tag, count in tag_counter.most_common():
            file.write(f"{tag}: {count}\n")


def statistic_for_subject(root_folder, output_file, threads):
    tag_counter = Counter()
    with ThreadPoolExecutor(max_workers=threads) as executor:
        for subject_folder in get_all_sub_folders(root_folder):
            for caption_file in get_caption_files(subject_folder):
                tags = read_file(caption_file)
                tag_counter.update([tags[0]])
    with open(output_file, 'w') as file:
        for tag, count in tag_counter.most_common():
            file.write(f"{tag}: {count}\n")

def check_image_validity_and_size_slow(file_path: str, min_size: int, max_size: int) -> str:
    try:
        with open(file_path, 'rb') as file:
            img = Image.open(file)
            img.verify()

        with open(file_path, 'rb') as file:
            img = Image.open(file)

            if Image.MIME.get(img.format) not in VALID_MIME_TYPES:
                return f"Invalid image format: {Image.MIME.get(img.format)}"

            width, height = img.size
            if width * height < min_size**2:
                return f"Image size below minimum: {width}x{height}"
            if width * height > max_size**2:
                return f"Image size above maximum: {width}x{height}"

            img = img.convert('RGB')

    except Exception as e:
        return f"Invalid image file: {str(e)}"
    return None


def check_image_validity_and_size_fast(file_path: str, min_size: int, max_size: int) -> str:
    try:
        with open(file_path, 'rb') as file:
            img = Image.open(file)
            img.load()  # This will decode the image and read it into memory

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

def check_image_validity_and_size(file_path: str, min_size: int, max_size: int) -> str:
    try:
        with open(file_path, 'rb') as file:
            img = Image.open(file)

            img_format = img.format
            mime_type = Image.MIME.get(img_format)
            if mime_type not in VALID_MIME_TYPES:
                return f"Invalid image format: {mime_type}"

            width, height = img.size
            if width * height < min_size**2:
                return f"Image size below minimum: {width}x{height}"
            if width * height > max_size**2:
                return f"Image size above maximum: {width}x{height}"

            img.load()

    except Exception as e:
        return f"Invalid image file: {str(e)}"
    return None


def check_caption_validity(file_path: str, min_tags: int, dry_run: bool) -> str:
    try:
        if False == dry_run:
            detect_and_remove_empty_tags(file_path)
        tags = read_file(file_path)
        if len(tags) < min_tags:
            return f"Number of tags in caption below minimum: {len(tags)} < {min_tags}."
    except Exception as e:
        return f"Invalid caption file: {str(e)}"
    return None


def find_duplicate_image_names(image_files):
    base_names = {}
    duplicates = []
    for image_file in image_files:
        base_name = os.path.splitext(image_file)[0]
        if base_name in base_names:
            base_names[base_name].append(image_file)
        else:
            base_names[base_name] = [image_file]

    for base_name, files in base_names.items():
        if len(files) > 1:
            duplicates.append((base_name, files))

    return duplicates


def check_image_caption_pairs(root_folder: str, min_size: int, max_size: int, min_tags: int, threads: int, dry_run: bool) -> List[Tuple[str, str]]:
    errors = []
    all_sub_folders = get_all_sub_folders(root_folder)
    subject_folders = iter(all_sub_folders)
    image_caption_queues = [Queue() for _ in range(threads)]
    scan_lock = Lock()

    # create a shared counter and initialize the progress bar
    scan_counter = Value('i', 0)
    scan_progress_bar = tqdm(total=len(all_sub_folders), desc="Scanning", dynamic_ncols=True)

    # counter for the checking phase
    check_counter = Value('i', 0)

    def folder_scanner(index):
        while True:
            with scan_lock:
                try:
                    subject_folder = next(subject_folders)
                except StopIteration:
                    break

            # update the shared counter and refresh the progress bar
            with scan_counter.get_lock():
                scan_counter.value += 1
                scan_progress_bar.update()

            caption_files = get_caption_files(subject_folder)
            image_files = get_image_files_in_current_folder(subject_folder)

            # Check for duplicate image names with different extensions
            duplicates = find_duplicate_image_names(image_files)
            if duplicates:
                for base_name, files in duplicates:
                    errors.append((base_name, f"Duplicate image names with different extensions: {', '.join(files)}"))

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

                # add the pair to the queue
                image_caption_queues[index].put((image_file, caption_file))

                # increment the check_counter each time you put an item in the queue
                with check_counter.get_lock():
                    check_counter.value += 1

    with ThreadPoolExecutor(max_workers=threads) as executor:
        # scanning phase
        for i in range(threads):
            executor.submit(folder_scanner, i)

    # close the scanning progress bar
    scan_progress_bar.close()

    # initialize the checking progress bar
    check_progress_bar = tqdm(total=check_counter.value, desc="Checking", dynamic_ncols=True)


    def worker(queue):
        while True:
            try:
                image_file, caption_file = queue.get_nowait()
            except Empty:
                break

            # update the shared counter and refresh the progress bar
            with check_counter.get_lock():
                check_counter.value -= 1
                check_progress_bar.update()

            image_error = check_image_validity_and_size(image_file, min_size, max_size)
            caption_error = check_caption_validity(caption_file, min_tags, dry_run)
            if image_error:
                errors.append((image_file, image_error))
            if caption_error:
                errors.append((caption_file, caption_error))

    with ThreadPoolExecutor(max_workers=threads) as executor:
        # checking phase
        for q in image_caption_queues:
            executor.submit(worker, q)

    # close the checking progress bar
    check_progress_bar.close()

    return errors


def check_images_and_captions(root_folder: str, min_size: int, max_size: int, min_tags: int, output_file: str, threads: int, dry_run: bool) -> None:
    errors = check_image_caption_pairs(root_folder, min_size, max_size, min_tags, threads, dry_run)
    try:
        with open(output_file, 'w') as file:
            for error in errors:
                file.write(f"{error[0]}: {error[1]}\n")
    except (IOError, PermissionError) as e:
        logging.error(f"Unable to open output file for writing: {str(e)}")
        raise

def remove_captions_without_image(root_folder: str, threads_number:int, output_file: str, is_dry_run:bool = True):
    errors = remove_captions_without_image_work(root_folder, threads_number, is_dry_run)
    try:
        with open(output_file, 'w') as file:
            for error in errors:
                file.write(f"{error[0]}: {error[1]}\n")
    except (IOError, PermissionError) as e:
        logging.error(f"Unable to open output file for writing: {str(e)}")
        raise

def remove_captions_without_image_work(root_folder: str, threads_number:int, is_dry_run:bool = True) -> List[
    Tuple[str, str]]:
    errors = []
    subject_folders = iter(get_all_sub_folders(root_folder))
    caption_queues = [Queue() for _ in range(threads_number)]
    scan_lock = Lock()

    def folder_scanner(index):
        while True:
            with scan_lock:
                try:
                    subject_folder = next(subject_folders)

                except StopIteration:
                    break

            #print(f"THREAD {index} ON: {subject_folder}")

            caption_files = get_caption_files(subject_folder)
            image_files = get_image_files_in_current_folder(subject_folder)

            # if len(caption_files) != len(image_files):
            #     print(f"PROBLEM: {len(caption_files)} != {len(image_files)}, subject_folder: {subject_folder}")


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

                # if no corresponding image file was found, add the caption file to the queue
                if image_file is None:
                    caption_queues[index].put(caption_file)

    with ThreadPoolExecutor(max_workers=threads_number) as executor:
        # scanning phase
        for i in range(threads_number):
            executor.submit(folder_scanner, i)

    def worker(queue):
        while True:
            try:
                caption_file = queue.get_nowait()
            except Empty:
                break

            # If in dry run, just record the caption file
            if is_dry_run:
                errors.append((caption_file, "Would be removed"))
            else:
                try:
                    errors.append((caption_file, "Removed"))
                    os.remove(caption_file)
                except Exception as e:
                    errors.append((caption_file, f"Error removing file: {str(e)}"))

    with ThreadPoolExecutor(max_workers=threads_number) as executor:
        # removing phase
        for q in caption_queues:
            executor.submit(worker, q)

    return errors

def is_image(file_path):
    _, ext = os.path.splitext(file_path)
    mime_type, _ = mimetypes.guess_type(file_path)
    return ext.lower() in IMAGE_EXTENSIONS and mime_type in VALID_MIME_TYPES

def scan_for_images(directory):
    image_files = []
    for root, _, files in os.walk(directory):
        for file in files:
            file_path = os.path.join(root, file)
            if is_image(file_path):
                image_files.append(file_path)
    return image_files

def scan_directories(directories, max_workers=5):
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        future_to_dir = {executor.submit(scan_for_images, dir): dir for dir in directories}
        all_image_files = []
        for future in concurrent.futures.as_completed(future_to_dir):


            dir = future_to_dir[future]
            print(f"scan_directories, dir: {dir}")
            try:
                image_files = future.result()
                all_image_files.extend(image_files)
            except Exception as exc:
                print(f'{dir} generated an exception: {exc}')
    return all_image_files

def add_tags_from_folder(args):
    all_images = scan_directories([args.root], args.threads)

    with ThreadPoolExecutor(max_workers=args.threads) as executor:
        for image in all_images:

            parent_name = Path(image).parent.name
            tags = parent_name.lower().replace("_", " ")

            caption_file = os.path.splitext(image)[0] + ".txt"

            if not os.path.exists(caption_file):
                open(caption_file, 'a').close()

            executor.submit(add_tag_to_file, caption_file, tags, 0, 0, args.dry_run)


def add_tags_from_argument(args):
    all_images = scan_directories([args.root], args.threads)

    with ThreadPoolExecutor(max_workers=args.threads) as executor:
        for image in all_images:

            caption_file = os.path.splitext(image)[0] + ".txt"
            # print(f"caption_file: {caption_file}")
            # print(f"args.tag: {args.tag}")
            # print(f"args.start: {args.start}")
            # print(f"args.end: {args.end}")

            if not os.path.exists(caption_file):
                open(caption_file, 'a').close()

            executor.submit(add_tag_to_file, caption_file, args.tag, args.start, args.end, args.dry_run)

def main(args):
    if args.mode in [ 'search_for_tags', 'full_statistic',
                     'check_images_and_captions' ] and args.output_file is None:
        raise Exception(f"Output file must be specified for mode '{args.mode}'.")

    if args.mode == 'check_images_and_captions':
        if args.min_size is None or args.max_size is None or args.min_tags is None:
            raise Exception("min_size, max_size, and min_tags must be specified for 'check_images_and_captions' mode.")
        check_images_and_captions(args.root, args.min_size, args.max_size, args.min_tags, args.output_file, args.threads, args.dry_run)
    elif args.mode == 'remove_captions_without_image':
        remove_captions_without_image(args.root, args.threads, args.output_file, args.dry_run)
    elif args.mode == 'remove_tags_beside_specified':
        if not args.tag.strip():
            logging.error('No tag provided, skipping')
        else:
            tags = clean_tags(tags_str_to_list(args.tag))
            logging.info(f'starting, preserving tags amount: {len(tags)}')
            if 0 < len(tags):
                with ThreadPoolExecutor(max_workers=args.threads) as executor:
                    for subject_folder in get_all_sub_folders(args.root):
                        for caption_file in get_caption_files(subject_folder):
                            #logging.info(f'file: {caption_file}')
                            executor.submit(remove_tags_beside_specified, caption_file, tags, args.output_file, args.dry_run)

                    executor.shutdown()
            else:
                logging.error('No valid tags provided, aborting.')
    elif args.mode == 'remove_tag_all':
        if not args.tag.strip():  # check if the tag is empty after removing leading/trailing whitespace
            logging.error('No tag provided, skipping')
        else:
            with ThreadPoolExecutor(max_workers=args.threads) as executor:
                for subject_folder in get_all_sub_folders(args.root):
                    for caption_file in get_caption_files(subject_folder):
                        executor.submit(remove_tags_from_file, caption_file, args.tag, args.output_file, args.dry_run)
    elif args.mode == 'replace_tag':
        with ThreadPoolExecutor(max_workers=args.threads) as executor:
            for subject_folder in get_all_sub_folders(args.root):
                for caption_file in get_caption_files(subject_folder):
                    executor.submit(tag_replace_in_file, caption_file, args.tag, args.tag_new, args.dry_run)
    elif args.mode == 'add_tag_all':
        # with ThreadPoolExecutor(max_workers=args.threads) as executor:
        #     for subject_folder in get_all_sub_folders(args.root):
        #         for caption_file in get_caption_files(subject_folder):
        #             executor.submit(add_tag_to_file, caption_file, args.tag, args.start, args.end, args.dry_run)

        add_tags_from_argument(args)

    elif args.mode == 'add_tag_single':
        subject_folder = os.path.join(args.root, args.sub_folder)
        #validate_folder_structure(subject_folder)
        with ThreadPoolExecutor(max_workers=args.threads) as executor:
            for caption_file in get_caption_files(subject_folder):
                executor.submit(add_tag_to_file, caption_file, args.tag, args.start, args.end, args.dry_run)

    elif args.mode == 'move_to_validation':
        move_to_validation(args.root, args.from_folder, args.validation_folder, args.move_to_validation_amount,
                           args.dry_run)
    elif args.mode == 'search_for_tags':
        search_for_tags(args.root, args.tag, args.output_file, args.threads)
    elif args.mode == 'full_statistic':
        full_statistic(args.root, args.output_file, args.threads)
    elif args.mode == 'statistic_for_subject':
        #subject_folder = os.path.join(args.root, args.tag)
        #validate_folder_structure(subject_folder)
        statistic_for_subject(args.root, args.output_file, args.threads)
    elif args.mode == 'add_tags_from_folder':

        add_tags_from_folder(args)

    else:
        print(f"Invalid mode: {args.mode}")

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description='Script for handling captions for images.')
    parser.add_argument('-m', '--mode', help='Mode of operation. Options: check_images_and_captions, remove_captions_without_image, remove_tags_beside_specified, remove_tag_all, replace_tag, add_tag_all, add_tag_single, move_to_validation, search_for_tags, full_statistic, statistic_for_subject, add_tags_from_folder.')
    parser.add_argument('-r', '--root', help='Root folder containing all subject folders.')
    parser.add_argument('-t', '--tag', help='Tag to add or remove.')
    parser.add_argument('-tn', '--tag_new', help='New tag to use.')
    parser.add_argument('-s', '--start', type=int, help='Start index for adding tag.')
    parser.add_argument('-e', '--end', type=int, help='End index for adding tag.')
    parser.add_argument('-th', '--threads', type=int, default=10, help='Number of threads for parallel processing.')
    parser.add_argument('-o', '--output_file', type=str, help='Output file for search and statistic modes.')
    parser.add_argument('-mm', '--min_size', type=int,
                        help='Minimum size of images for check_images_and_captions mode.')
    parser.add_argument('-mx', '--max_size', type=int,
                        help='Maximum size of images for check_images_and_captions mode.')
    parser.add_argument('-mt', '--min_tags', type=int,
                        help='Minimum number of tags in captions for check_images_and_captions mode.')
    parser.add_argument('-sf', '--sub_folder', type=str,
                        help='Sub folder that used for add_tag_single.')
    parser.add_argument('-vm', '--move_to_validation_amount', type=int,
                        help='The amount of images move to validation.')
    parser.add_argument('--dry_run', action='store_true', help='Dry run mode. No changes will be made.')
    parser.add_argument('-f', '--from', dest='from_folder', nargs='+',
                        help='Folders from which to move images to validation.')
    parser.add_argument('-v', '--validation_folder', type=str, help='Folder to which images will be moved.')


    args = parser.parse_args()

    try:
        main(args)
    except Exception as e:
        print(f"An unexpected error occurred: {str(e)}")
        print(traceback.format_exc())