import os
import re
import random
import math
import json

image_extensions = ['.jpg', '.jpeg', '.png', '.bmp', '.gif', '.tiff', '.webp']

FOLDER_SETTINGS_FILE_NAME = "folder_settings.json"

def get_image_count_in_folder(folder_path):
    """Return the number of image files in the given folder."""

    return sum(1 for f in os.listdir(folder_path) if os.path.splitext(f)[1].lower() in image_extensions)


def get_multiplier_from_file(folder_path):
    """Return the multiplier from multiply.txt in the given folder, or 1.0 if the file doesn't exist."""
    multiply_file_path = os.path.join(folder_path, 'multiply.txt')
    if os.path.exists(multiply_file_path):
        with open(multiply_file_path, 'r') as f:
            return float(f.read().strip())
    return 1.0


def calculate_repeats(total_epochs, folder_multiplier):
    """Return the number of repeats for a folder."""
    return int(math.ceil(total_epochs * folder_multiplier))


def rename_folder(folder_path, repeats):
    """Rename the folder by prefixing it with the number of repeats."""
    folder_name = os.path.basename(folder_path)
    # Remove existing prefix if it exists
    new_name = re.sub(r'^\d+_', '', folder_name)
    new_name = f"{repeats}_{new_name}"
    os.rename(folder_path, os.path.join(os.path.dirname(folder_path), new_name))


def unhide_images(folder_path):
    """Unhide images by removing the dot prefix from their names."""

    # List all files that start with a dot
    hidden_files = [f for f in os.listdir(folder_path) if f.startswith('.')]

    for img in hidden_files:
        # Check if the file is an image
        if os.path.splitext(img)[1].lower() in image_extensions:
            # Rename the file by removing the dot from the beginning
            os.rename(os.path.join(folder_path, img), os.path.join(folder_path, img[1:]))



def hide_random_images(folder_path, number_images_to_hide):
    """Select random images and hide them by prefixing with a dot."""

    # List all the image files in the folder
    all_images = [f for f in os.listdir(folder_path) if os.path.splitext(f)[1].lower() in image_extensions]

    # Randomly select images to hide
    images_to_hide = random.sample(all_images, number_images_to_hide)

    # Rename the selected images by adding a dot to the beginning of their names
    for img in images_to_hide:
        os.rename(os.path.join(folder_path, img), os.path.join(folder_path, "." + img))


def save_folder_settings(folder_path, repeats):
    """Save the calculated repeats to a folder_settings.json file inside the folder."""
    settings_file_path = os.path.join(folder_path, FOLDER_SETTINGS_FILE_NAME)

    # If folder_settings.json exists, read its contents
    if os.path.exists(settings_file_path):
        with open(settings_file_path, "r") as f:
            settings = json.load(f)
    else:
        settings = {}

    # Update the num_repeats key
    settings["num_repeats"] = repeats

    # Write the updated settings back to folder_settings.json
    with open(settings_file_path, "w") as f:
        json.dump(settings, f, indent=4)


def process_folders(root_path, total_epochs):
    """Scan folders, calculate repeats and rename them."""
    total_images_used = 0
    num_folders = 0

    for folder in os.listdir(root_path):
        folder_path = os.path.join(root_path, folder)
        if os.path.isdir(folder_path):
            # Unhide images before counting them
            unhide_images(folder_path)

            num_folders += 1
            images_in_folder = get_image_count_in_folder(folder_path)
            multiplier = get_multiplier_from_file(folder_path)
            repeats = calculate_repeats(total_epochs, multiplier)
            if (repeats == 0):
                repeats = 1



            desired_images_from_folder = int(multiplier * images_in_folder * total_epochs)
            number_images_to_hide = 0

            #if  desired_images_from_folder < images_in_folder:
            #    number_images_to_hide = images_in_folder - desired_images_from_folder
            #    hide_random_images(folder_path, number_images_to_hide)

            # Calculate repeats * images for the folder
            total_images_for_folder = repeats * (images_in_folder - number_images_to_hide)

            total_images_used += total_images_for_folder

            # Print results
            print(f"Folder '{folder}':")
            print(f"\tImages: {images_in_folder}")
            print(f"\tMultiplier: {multiplier}")
            print(f"\tRepeats: {repeats}")
            print(f"\tHidden: {number_images_to_hide}")
            print(f"\tImages per epoch (repeats * images / total_epochs): {total_images_for_folder / total_epochs}")
            print("-" * 50)

            # Save the repeats to a folder_settings.json file inside the folder
            save_folder_settings(folder_path, repeats)

            # No longer using renames
            # rename_folder(folder_path, repeats)

    avg_images_per_epoch = total_images_used / total_epochs
    print(f"Total images used for all epoch: {total_images_used}")
    print(f"Average number of images used per epoch: {avg_images_per_epoch:2f}")

# Example usage:
root_folder_path = "/workspace/input/dataset/"
total_epochs_value = 10
process_folders(root_folder_path, total_epochs_value)
