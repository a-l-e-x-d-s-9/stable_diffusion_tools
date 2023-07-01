import os
import sys
from PIL import Image
import random
from argparse import ArgumentParser
from unittest.mock import patch

def mock_crop(*args):
    # Perform rounding similar to actual image.crop function
    crop_box = tuple(map(round, args[1]))
    crop_box_size = (crop_box[2]-crop_box[0], crop_box[3]-crop_box[1])
    return crop_box_size

def mock_resize(*args):
    # Convert the map object to a tuple
    resized_dims = tuple(args[1])
    return resized_dims

def _percent_random_crop(image, crop_jitter=0.02):
    width, height = image.size
    max_crop_pixels = min(width, height) * crop_jitter

    left_crop_pixels = random.uniform(0, max_crop_pixels)
    right_crop_pixels = random.uniform(0, max_crop_pixels)
    top_crop_pixels = random.uniform(0, max_crop_pixels)
    bottom_crop_pixels = random.uniform(0, max_crop_pixels)

    left = left_crop_pixels
    right = width - right_crop_pixels
    top = top_crop_pixels
    bottom = height - bottom_crop_pixels

    with patch.object(Image.Image, "crop", new=mock_crop):
        crop_size = image.crop((left, top, right, bottom))

    cropped_width = width - int(left_crop_pixels + right_crop_pixels)
    cropped_height = height - int(top_crop_pixels + bottom_crop_pixels)

    cropped_aspect_ratio = cropped_width / cropped_height

    if cropped_aspect_ratio > 1:
        new_width = cropped_width
        new_height = int(cropped_width / cropped_aspect_ratio)
    else:
        new_width = int(cropped_height * cropped_aspect_ratio)
        new_height = cropped_height

    with patch.object(Image.Image, "resize", new=mock_resize):
        resized_dims = image.resize((new_width, new_height))

    equal_dims = resized_dims == crop_size
    return crop_size, resized_dims, equal_dims

def _percent_random_crop_fix1(image, crop_jitter=0.02):
    width, height = image.size
    max_crop_pixels = min(width, height) * crop_jitter

    left_crop_pixels = random.uniform(0, max_crop_pixels)
    right_crop_pixels = random.uniform(0, max_crop_pixels)
    top_crop_pixels = random.uniform(0, max_crop_pixels)
    bottom_crop_pixels = random.uniform(0, max_crop_pixels)

    left = left_crop_pixels
    right = width - right_crop_pixels
    top = top_crop_pixels
    bottom = height - bottom_crop_pixels

    with patch.object(Image.Image, "crop", new=mock_crop):
        crop_size = image.crop((left, top, right, bottom))

    cropped_width = width - int(left_crop_pixels + right_crop_pixels)
    cropped_height = height - int(top_crop_pixels + bottom_crop_pixels)

    cropped_aspect_ratio = cropped_width / cropped_height

    if cropped_aspect_ratio > 1:
        new_width = cropped_width
        new_height = int(cropped_width / cropped_aspect_ratio)
    else:
        new_width = int(cropped_height * cropped_aspect_ratio)
        new_height = cropped_height

    with patch.object(Image.Image, "resize", new=mock_resize):
        resized_dims = image.resize((new_width, new_height))

    equal_dims = resized_dims == crop_size
    return crop_size, resized_dims, equal_dims


# if __name__ == "__main__":
#     parser = ArgumentParser()
#     parser.add_argument("-f", "--folder", dest="folder", help="Path to the folder containing images.", required=True)
#     args = parser.parse_args()
#
#     total_images = 0
#     mismatch_count = 0
#     for root, dirs, files in os.walk(args.folder):
#         for file in files:
#             if file.lower().endswith(('.png', '.jpg', '.jpeg')):
#                 total_images += 1
#                 image_path = os.path.join(root, file)
#                 image = Image.open(image_path)
#                 crop_size, resized_dims, equal_dims = _percent_random_crop(image)
#                 if not equal_dims:
#                     mismatch_count += 1
#                 diff_dims = tuple(a_i - b_i for a_i, b_i in zip(resized_dims, crop_size))
#                 color_code = "\033[32m" if equal_dims else "\033[31m"
#                 reset_code = "\033[0m"
#                 filename = os.path.basename(image_path)
#                 print(f"{color_code}{filename}{reset_code} - Image Size: {image.size}, Crop Box Size: {crop_size}, Resized Dimensions: {resized_dims}, Difference: {diff_dims}")
#
#     print(f"\nTotal images processed: {total_images}")
#     print(f"Number of images with size mismatch: {mismatch_count}")


def test_random_crop(image_path, mode):
    # existing code goes here
    crop_jitter = 0.02

    image = Image.open(image_path)

    if mode == "original":
        crop_size, resized_dims, equal_dims = _percent_random_crop(image, crop_jitter)
    elif mode == "fix1":
        crop_size, resized_dims, equal_dims = _percent_random_crop_fix1(image, crop_jitter)
    else:
        raise ValueError(f"Unknown mode: {mode}")


    diff_dims = tuple(a_i - b_i for a_i, b_i in zip(resized_dims, crop_size))
    color_code = "\033[32m" if equal_dims else "\033[31m"
    reset_code = "\033[0m"
    filename = os.path.basename(image_path)
    print(
        f"{color_code}{filename}{reset_code} - Image Size: {image.size}, Crop Box Size: {crop_size}, Resized Dimensions: {resized_dims}, Difference: {diff_dims}")

    return not equal_dims

def main():
    parser = ArgumentParser(description='Test the _percent_random_crop function')
    parser.add_argument("-f", "--folder", dest="folder", help="Path to the folder containing images.", required=True)
    parser.add_argument("-m", "--mode", type=str, default="original",
                        help='Choose the mode of operation: "original" or "fix1"')

    args = parser.parse_args()

    folder = args.folder
    mode = args.mode

    total_files = 0
    mismatched_files = 0
    for root, dirs, files in os.walk(folder):
        for file in files:
            if file.endswith((".png", ".jpg", ".jpeg")):
                total_files += 1
                image_path = os.path.join(root, file)
                #print(f"Processing file: {image_path}")
                if test_random_crop(image_path, mode):
                    mismatched_files += 1

    print(f"Number of mismatched files: {mismatched_files} / {total_files}")


if __name__ == "__main__":
    main()


# python3 crop_jitter_unitest.py --folder "/path/to/your/folder" --mode "original"
