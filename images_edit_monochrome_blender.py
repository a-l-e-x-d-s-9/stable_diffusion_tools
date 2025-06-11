import argparse
import os
import shutil
import numpy as np
from PIL import Image, ImageEnhance, ImageChops
from tqdm import tqdm


def hex_to_rgb(hex_color):
    hex_color = hex_color.lstrip('#')
    return tuple(int(hex_color[i:i + 2], 16) for i in (0, 2, 4))


def apply_blending(image, blend_color, mode, second_color=None, third_color=None):
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
        img_np = np.array(image).astype(np.float32) / 255.0
        color_np = np.array(color_layer).astype(np.float32) / 255.0
        mask = img_np <= 0.5
        blended_np = np.where(mask, 2 * img_np * color_np, 1 - 2 * (1 - img_np) * (1 - color_np))
        blended = Image.fromarray((blended_np * 255).astype(np.uint8), "RGBA")
    elif mode == "luminosity":
        img_lab = image.convert("LAB")
        color_lab = color_layer.convert("LAB")
        img_l, img_a, img_b = img_lab.split()
        _, color_a, color_b = color_lab.split()
        blended_lab = Image.merge("LAB", (img_l, color_a, color_b)).convert("RGB")
        blended = blended_lab
    elif mode == "difference":
        blended = ImageChops.difference(image, color_layer)

    # New Light Effects
    elif mode == "light_multiply_screen":
        multiply_blend = ImageChops.multiply(image, color_layer)

        # Apply Screen with reduced intensity
        screen_blend = ImageChops.screen(multiply_blend, color_layer)

        # Blend back some of the original image to retain details
        blended = Image.blend(screen_blend, image, alpha=0.5)
    elif mode == "light_soft_overlay":
        soft_light_blend = ImageChops.soft_light(image, color_layer)
        blended = ImageChops.overlay(soft_light_blend, color_layer)
    elif mode == "light_color_screen":
        grayscale = image.convert("L").convert("RGB")
        colorized = Image.blend(grayscale, color_layer.convert("RGB"), 0.5)

        # Ensure both images are in RGB mode before blending
        color_layer = color_layer.convert("RGB")
        blended = ImageChops.screen(colorized, color_layer)
    elif mode == "light_lab_soft":
        img_lab = image.convert("LAB")
        color_lab = color_layer.convert("LAB")

        img_l, img_a, img_b = img_lab.split()
        _, color_a, color_b = color_lab.split()

        blended_lab = Image.merge("LAB", (img_l, color_a, color_b)).convert("RGB")

        # Ensure both images are in RGB mode and the same size before blending
        color_layer = color_layer.convert("RGB")
        color_layer = color_layer.resize(blended_lab.size)

        blended = ImageChops.soft_light(blended_lab, color_layer)


    # Complex Effects
    elif mode == "dual_tone":
        if not second_color:
            raise ValueError("dual_tone mode requires --second_color argument.")
        shadow_color = hex_to_rgb(second_color)
        shadow_layer = Image.new("RGB", image.size, shadow_color)
        grayscale = image.convert("L").convert("RGB")
        blended = ImageChops.blend(shadow_layer, grayscale, 0.5)
    elif mode == "gradient_light":
        if not second_color:
            raise ValueError("gradient_light mode requires --second_color argument.")
        color_1 = blend_color
        color_2 = hex_to_rgb(second_color)
        width, height = image.size
        gradient = Image.new("RGB", (width, height), color_1)
        for y in range(height):
            blend_factor = y / height
            blended_color = tuple(
                int(color_1[i] * (1 - blend_factor) + color_2[i] * blend_factor) for i in range(3)
            )
            gradient.paste(blended_color, (0, y, width, y + 1))
        blended = ImageChops.multiply(image.convert("RGB"), gradient)

    elif mode == "tri_color":
        if not (second_color and third_color):
            raise ValueError("tri_color mode requires --second_color and --third_color arguments.")
        color_mid = hex_to_rgb(second_color)
        color_highlight = hex_to_rgb(third_color)
        shadow_layer = Image.new("RGB", image.size, blend_color)
        mid_layer = Image.new("RGB", image.size, color_mid)
        highlight_layer = Image.new("RGB", image.size, color_highlight)
        grayscale = image.convert("L")
        blended = ImageChops.multiply(shadow_layer, grayscale.convert("RGB"))
        blended = ImageChops.overlay(blended, mid_layer)
        blended = ImageChops.screen(blended, highlight_layer)

    elif mode == "grayscale":
        blended = image.convert("L").convert("RGB")

    else:
        blended = image

    return blended


def process_images(src, dest, hex_color, blend_mode, preview=False, second_color=None, third_color=None):
    blend_color = hex_to_rgb(hex_color)
    supported_formats = [".jpg", ".jpeg", ".png", ".bmp", ".webp"]
    can_continue = True

    images = []
    for root, _, files in os.walk(src):
        for file in files:
            if any(file.lower().endswith(ext) for ext in supported_formats):
                images.append(os.path.join(root, file))

    if preview:
        preview_images = images[:3]
        for img_path in preview_images:
            img = Image.open(img_path)
            img = apply_blending(img, blend_color, blend_mode, second_color, third_color)
            img.show()
        confirm = input("Proceed with processing all images? (y/n): ")
        if confirm.lower() != 'y':
            print("Operation canceled.")
            can_continue = False
            return can_continue

    with tqdm(total=len(images), desc="Processing images", unit="file") as pbar:
        for img_path in images:
            relative_path = os.path.relpath(img_path, src)
            target_path = os.path.join(dest, relative_path)
            os.makedirs(os.path.dirname(target_path), exist_ok=True)

            img = Image.open(img_path)
            img = apply_blending(img, blend_color, blend_mode, second_color, third_color)

            if img.mode == "RGBA":
                img = img.convert("RGB")

            img.save(target_path)
            pbar.update(1)

    return can_continue


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
        description="Apply various blending effects to images while copying non-image files unchanged.")
    parser.add_argument("--source", required=True, help="Path to source folder")
    parser.add_argument("--target", required=True, help="Path to target folder")
    parser.add_argument("--color", required=True, help="Hex color for blending")
    parser.add_argument("--second_color", help="Optional second color for complex effects")
    parser.add_argument("--third_color", help="Optional third color for tri-color effect")
    parser.add_argument("--blend_mode", default="multiply",
                        choices=["multiply", "color_burn", "overlay", "color", "hue", "screen", "soft_light", "hard_light", "luminosity", "difference", "light_multiply_screen", "light_soft_overlay", "light_color_screen", "light_lab_soft", "dual_tone", "gradient_light", "tri_color", "grayscale"],
                        help="Blending mode to use")
    parser.add_argument("--preview", action="store_true", help="Preview first three images before processing")

    args = parser.parse_args()

    print("Processing images...")
    can_continue = process_images(args.source, args.target, args.color, args.blend_mode, args.preview, args.second_color, args.third_color)

    if can_continue:
        print("Copying non-image files...")
        copy_non_images(args.source, args.target)

    print("Processing completed.")


if __name__ == "__main__":
    main()
