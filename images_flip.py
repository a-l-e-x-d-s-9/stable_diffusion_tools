import argparse
import os
import sys
from PIL import Image
from random import random


def flip_image(image_path: str, h_flip_chance: float, v_flip_chance: float, make_copy: bool) -> bool:
    was_flipped = False
    try:
        img = Image.open(image_path)
        img.load()

        # Flip image horizontally
        if random() < h_flip_chance:
            img = img.transpose(Image.FLIP_LEFT_RIGHT)
            was_flipped = True

        # Flip image vertically
        if random() < v_flip_chance:
            img = img.transpose(Image.FLIP_TOP_BOTTOM)
            was_flipped = True

        # Decide the path to save the image
        base, ext = os.path.splitext(image_path)
        ext_lower = ext.lower()

        if make_copy and was_flipped:
            save_path = f"{base}_f{ext}"
        else:
            save_path = image_path

        # If saving as JPEG, make sure mode is compatible
        if ext_lower in (".jpg", ".jpeg") and img.mode not in ("RGB", "L"):
            img = img.convert("RGB")

        # Save the flipped image
        img.save(save_path)

        return was_flipped

    except Exception as e:
        print(f"Error processing {image_path}: {e}")
        # If we were writing a copy and it ended up as an empty file, delete it
        try:
            if "save_path" in locals() and save_path != image_path:
                if os.path.exists(save_path) and os.path.getsize(save_path) == 0:
                    os.remove(save_path)
        except Exception:
            pass
        return False


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Flip images based on given chances.')
    parser.add_argument('--folder_path', type=str, required=True, help='Path to folder containing images.')
    parser.add_argument('--h_flip_chance', type=float, default=0.0, help='Chance to flip image horizontally (0 to 1).')
    parser.add_argument('--v_flip_chance', type=float, default=0.0, help='Chance to flip image vertically (0 to 1).')
    parser.add_argument('--make_copy', action='store_true', default=False,
                        help='If set, creates a copy of the flipped image instead of replacing the original.')
    args = parser.parse_args()

    folder_path = args.folder_path

    if not os.path.isdir(folder_path):
        print(f'Error: {folder_path} is not a directory')
        sys.exit(1)

    flipped_counter = 0
    count = 0
    total = sum(len(files) for _, _, files in os.walk(folder_path))

    for root, _, files in os.walk(folder_path):
        for file_name in files:
            file_path = os.path.join(root, file_name)
            if file_name.lower().endswith(('.png', '.jpg', '.jpeg', '.webp', '.bmp')):
                count += 1
                was_flipped = flip_image(file_path, args.h_flip_chance, args.v_flip_chance, args.make_copy)
                if was_flipped:
                    flipped_counter += 1
                print(f'\rProcessed {count} images, flipped: {flipped_counter}.', end='', flush=True)

    print('\nDone.')  # Print a message to indicate when all images have been processed.

# Run example: python images_flip.py --folder_path /path/to/folder --h_flip_chance 0.5 --v_flip_chance 0.5 --make_copy
