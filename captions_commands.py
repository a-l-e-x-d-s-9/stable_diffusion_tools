import os
import random
import argparse
import logging
from concurrent.futures import ThreadPoolExecutor
from typing import List

IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.bmp', '.tiff']
LOG_FORMAT = "%(asctime)s — %(levelname)s — %(message)s"
logging.basicConfig(level=logging.INFO, format=LOG_FORMAT)

def validate_input(path: str, tag: str = None) -> None:
    if not os.path.exists(path):
        logging.error(f"Path {path} does not exist.")
        raise ValueError(f"Path {path} does not exist.")
    if tag and not isinstance(tag, str):
        logging.error(f"Tag {tag} is not a string.")
        raise ValueError(f"Tag {tag} is not a string.")

def read_file(file_path: str) -> List[str]:
    validate_input(file_path)
    with open(file_path, 'r') as file:
        return file.read().split(', ')

def write_file(file_path: str, tags: List[str]) -> None:
    validate_input(file_path)
    with open(file_path, 'w') as file:
        file.write(', '.join(tags))

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

def add_tag_to_file(file_path: str, tag: str, start: int, stop: int) -> None:
    tags = read_file(file_path)
    tags = clean_tags(tags)
    if tag not in tags:
        if stop > len(tags):
            stop = len(tags)
        position = random.randint(start, stop)
        tags.insert(position, tag)
    write_file(file_path, tags)

def move_to_validation(root_folder: str, from_folder: str) -> None:
    subject_folders = get_subject_folders(root_folder)
    for subject_folder in subject_folders:
        validate_folder_structure(subject_folder)
        from_folder_path = os.path.join(subject_folder, from_folder)
        validation_folder_path = os.path.join(subject_folder, 'validation')
        image_files = [os.path.join(from_folder_path, file) for file in os.listdir(from_folder_path) if file.endswith(tuple(IMAGE_EXTENSIONS))]
        random_image_file = random.choice(image_files)
        caption_file = random_image_file.replace(from_folder, 'validation').replace(os.path.splitext(random_image_file)[-1], '.txt')
        os.rename(random_image_file, random_image_file.replace(from_folder, 'validation'))
        os.rename(caption_file, caption_file.replace(from_folder, 'validation'))

def main(mode, root_folder, tag=None, start=None, stop=None, from_folder=None, threads=10):
    if mode == 'remove_tag_all':
        with ThreadPoolExecutor(max_workers=threads) as executor:
            for subject_folder in get_subject_folders(root_folder):
                for caption_file in get_caption_files(subject_folder):
                    executor.submit(remove_tag_from_file, caption_file, tag)
    elif mode == 'add_tag_all':
        with ThreadPoolExecutor(max_workers=threads) as executor:
            for subject_folder in get_subject_folders(root_folder):
                for caption_file in get_caption_files(subject_folder):
                    executor.submit(add_tag_to_file, caption_file, tag, start, stop)
    elif mode == 'add_tag_single':
        subject_folder = os.path.join(root_folder, tag)
        validate_folder_structure(subject_folder)
        with ThreadPoolExecutor(max_workers=threads) as executor:
            for caption_file in get_caption_files(subject_folder):
                executor.submit(add_tag_to_file, caption_file, tag, start, stop)
    elif mode == 'move_to_validation':
        move_to_validation(root_folder, from_folder)

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description='Script for handling captions for images.')
    parser.add_argument('-m', '--mode', help='Mode of operation. Options: remove_tag_all, add_tag_all, add_tag_single, move_to_validation.')
    parser.add_argument('-r', '--root', help='Root folder containing all subject folders.')
    parser.add_argument('-t', '--tag', help='Tag to add or remove.')
    parser.add_argument('-s', '--start', type=int, help='Start index for adding tag.')
    parser.add_argument('-e', '--end', type=int, help='End index for adding tag.')
    parser.add_argument('-f', '--from', dest='from_folder', help='Folder from which to move images to validation.')
    parser.add_argument('-th', '--threads', type=int, default=10, help='Number of threads for parallel processing.')
    args = parser.parse_args()
    main(args.mode, args.root, args.tag, args.start, args.end, args.from_folder, args.threads)
