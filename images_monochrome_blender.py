import argparse
import os
import shutil
import numpy as np
from PIL import Image, ImageEnhance
from tqdm import tqdm
from PIL import ImageChops


def hex_to_rgb(hex_color):
    hex_color = hex_color.lstrip('#')
    return tuple(int(hex_color[i:i + 2], 16) for i in (0, 2, 4))


def apply_blending(image, blend_color, mode):
    image = image.convert("RGBA")
    r, g, b = blend_color
    color_layer = Image.new("RGBA", image.size, (r, g, b, 255))

    if mode == "multiply":
        blended = Image.blend(image, color_layer, 0.5)
    elif mode == "color_burn":
        blended = ImageChops.multiply(image, color_layer)
    elif mode == "overlay":
        blended = ImageChops.overlay(image, color_layer)
    elif mode == "color":
        grayscale = image.convert("L").convert("RGB")
        color_layer = color_layer.convert("RGB")
        blended = Image.blend(grayscale, color_layer, 0.5)
    elif mode == "hue":
        hsv = image.convert("HSV")
        hue_layer = color_layer.convert("HSV")
        hsv = Image.merge("HSV", (hue_layer.split()[0], hsv.split()[1], hsv.split()[2]))
        blended = hsv.convert("RGB")
    elif mode == "screen":
        blended = ImageChops.screen(image, color_layer)
    elif mode == "soft_light":
        blended = ImageChops.soft_light(image, color_layer)
    elif mode == "hard_light":
        blended = ImageChops.hard_light(image, color_layer)
    elif mode == "luminosity":
        gray = image.convert("L")
        blended = Image.merge("RGB", (gray, gray, gray)).convert("RGB")
    elif mode == "difference":
        blended = ImageChops.difference(image, color_layer)
    else:
        blended = image

    return blended


def process_images(src, dest, hex_color, blend_mode, preview=False):
    blend_color = hex_to_rgb(hex_color)
    supported_formats = [".jpg", ".jpeg", ".png", ".bmp", ".webp"]

    images = []
    for root, _, files in os.walk(src):
        for file in files:
            if any(file.lower().endswith(ext) for ext in supported_formats):
                images.append(os.path.join(root, file))

    if preview:
        preview_images = images[:3]
        for img_path in preview_images:
            img = Image.open(img_path)
            img = apply_blending(img, blend_color, blend_mode)
            img.show()
        confirm = input("Proceed with processing all images? (y/n): ")
        if confirm.lower() != 'y':
            print("Operation canceled.")
            return False # False == can_continue

    with tqdm(total=len(images), desc="Processing images", unit="file") as pbar:
        for img_path in images:
            relative_path = os.path.relpath(img_path, src)
            target_path = os.path.join(dest, relative_path)
            os.makedirs(os.path.dirname(target_path), exist_ok=True)

            img = Image.open(img_path)
            img = apply_blending(img, blend_color, blend_mode)
            img.save(target_path)
            pbar.update(1)

    return True # True == can_continue


def copy_non_images(src, dest):
    supported_formats = [".jpg", ".jpeg", ".png", ".bmp", ".webp"]
    for root, _, files in os.walk(src):
        for file in files:
            if not any(file.lower().endswith(ext) for ext in supported_formats):
                src_path = os.path.join(root, file)
                relative_path = os.path.relpath(src_path, src)
                target_path = os.path.join(dest, relative_path)
                os.makedirs(os.path.dirname(target_path), exist_ok=True)
                shutil.copy2(src_path, target_path)


def main():
    parser = argparse.ArgumentParser(
        description="Apply a monochromatic effect to images while copying other files unchanged.")
    parser.add_argument("--source", required=True, help="Path to source folder")
    parser.add_argument("--target", required=True, help="Path to target folder")
    parser.add_argument("--color", required=True, help="Hex color for blending")
    parser.add_argument("--blend_mode", default="multiply",
                        choices=["multiply", "color_burn", "overlay", "color", "hue", "screen", "soft_light",
                                 "hard_light", "luminosity", "difference"], help="Blending mode to use")
    parser.add_argument("--preview", action="store_true", help="Preview first three images before processing")

    args = parser.parse_args()



    print("Processing images...")
    can_continue = process_images(args.source, args.target, args.color, args.blend_mode, args.preview)

    if True == can_continue:
        print("Copying non-image files...")
        copy_non_images(args.source, args.target)

    print("Processing completed.")


if __name__ == "__main__":
    main()
