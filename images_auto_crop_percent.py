import argparse
import os
import sys
import traceback

from PIL import Image
from random import random


class ImageCropParams:
    def __init__(self, left, top, right, bottom):
        self.crop_left = left
        self.crop_top = top
        self.crop_right = right
        self.crop_bottom = bottom


def crop_image(image_path: str, crop_params: ImageCropParams) -> bool:

    if crop_params is None:
        print(f'Error: crop_params cannot be None')
        return False

    try:

        # with Image.open(image_path) as img:
        img = Image.open(open(image_path, 'rb'))
        width, height = img.size
        # Define the box coordinates for cropping (left, upper, right, lower)
        box = (
            int(width * crop_params.crop_left / 100),
            int(height * crop_params.crop_top / 100),
            int(width - (width * crop_params.crop_right / 100)),
            int(height - (height * crop_params.crop_bottom / 100)) )

        # Crop box
        img = img.crop(box)  # as a (left, upper, right, lower)-tuple.

        # Save the flipped image
        img.save(image_path)
        img.close()

    except Exception as e:
        print(f'Error processing {image_path}: {e}, {traceback.format_exc()}')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Flip images horizontally.')
    parser.add_argument('folder_path', type=str, help='Path to folder containing images.')
    parser.add_argument('--crop_left', type=int, help='Crop percent from left.')
    parser.add_argument('--crop_top', type=int, help='Crop percent from top.')
    parser.add_argument('--crop_right', type=int, help='Crop percent from right.')
    parser.add_argument('--crop_bottom', type=int, help='Crop percent from bottom.')

    args = parser.parse_args()

    crop_params: ImageCropParams = ImageCropParams(args.crop_left, args.crop_top, args.crop_right,
                                                   args.crop_bottom)  # left_px, top_px, right_px, bottom_px

    folder_path = args.folder_path

    if not os.path.isdir(folder_path):
        print(f'Error: {folder_path} is not a directory')
        sys.exit(1)

    count = 0
    total = len(os.listdir(folder_path))

    for file_name in os.listdir(folder_path):
        file_path = os.path.join(folder_path, file_name)
        if os.path.isfile(file_path):
            count += 1
            file_is_image = file_name.lower().endswith(('.png', '.jpg', '.jpeg'))
            if file_is_image:
                crop_image(file_path, crop_params)
                print(f'\rProcessed {count}/{total} images.', end='', flush=True)

    print('\nDone.')  # Print a message to indicate when all images have been processed.

# Run example: python images_auto_crop_percent.py /path/to/folder --crop_left 20 --crop_top 30 --crop_right 20 --crop_bottom 30
