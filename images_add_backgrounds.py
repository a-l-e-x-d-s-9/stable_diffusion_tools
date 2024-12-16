import argparse
import os
import random
from PIL import Image, ImageChops
from tqdm import tqdm


def process_images(subjects_dir, backgrounds_dir, output_dir, num_backgrounds_per_subject):
    # Ensure output directory exists
    os.makedirs(output_dir, exist_ok=True)

    # Get list of subject images and background images
    subject_images = [f for f in os.listdir(subjects_dir) if f.endswith('.png')]
    background_images = [f for f in os.listdir(backgrounds_dir) if f.endswith(('.png', '.jpg', '.jpeg'))]

    if not subject_images:
        print("No PNG images found in the subjects folder.")
        return

    if not background_images:
        print("No images found in the backgrounds folder.")
        return

    total_images = len(subject_images) * num_backgrounds_per_subject

    # Process each subject image with the specified number of backgrounds
    with tqdm(total=total_images, desc="Processing images") as pbar:
        for subject_image_name in subject_images:
            subject_path = os.path.join(subjects_dir, subject_image_name)
            subject_image = Image.open(subject_path).convert("RGBA")
            subject_width, subject_height = subject_image.size

            for i in range(num_backgrounds_per_subject):
                # Randomly select a background image
                background_image_name = random.choice(background_images)
                background_path = os.path.join(backgrounds_dir, background_image_name)
                background_image = Image.open(background_path).convert("RGBA")

                # Resize the background while preserving aspect ratio
                background_resized = resize_background_to_subject(background_image, subject_width, subject_height)

                # Randomly apply an offset within the 20% margin
                offset_x, offset_y = calculate_random_offset(subject_width, subject_height, background_resized.size)

                # Create a new image by blending the subject over the background
                combined = blend_images(background_resized, subject_image, offset_x, offset_y)

                # Save the result
                combined = combined.convert("RGB")
                output_path = os.path.join(output_dir, f"{os.path.splitext(subject_image_name)[0]}_{i + 1}.jpg")
                combined.save(output_path, format="JPEG", quality=95)

                # Update progress bar
                pbar.update(1)


def resize_background_to_subject(background, subject_width, subject_height):
    bg_width, bg_height = background.size

    # Calculate the scaling factor while maintaining aspect ratio
    scale_factor = max(subject_width / bg_width, subject_height / bg_height)
    new_width = int(bg_width * scale_factor)
    new_height = int(bg_height * scale_factor)

    # Resize background to the new size
    return background.resize((new_width, new_height), Image.LANCZOS)


def calculate_random_offset(subject_width, subject_height, background_size):
    bg_width, bg_height = background_size

    # Calculate maximum allowed discrepancy (20% of subject dimensions)
    max_offset_x = int(0.2 * subject_width)
    max_offset_y = int(0.2 * subject_height)

    # Random offset within the allowed range
    offset_x = random.randint(-max_offset_x, max_offset_x)
    offset_y = random.randint(-max_offset_y, max_offset_y)

    # Ensure the background fully covers the subject
    offset_x = min(max(offset_x, 0), bg_width - subject_width)
    offset_y = min(max(offset_y, 0), bg_height - subject_height)

    return offset_x, offset_y


def blend_images(background, subject, offset_x, offset_y):
    # Crop the background to match the subject dimensions with the offset
    bg_cropped = background.crop((offset_x, offset_y, offset_x + subject.width, offset_y + subject.height))

    # Blend the subject over the background using the subject's alpha channel
    combined = Image.alpha_composite(bg_cropped, subject)

    return combined


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Generate images by placing subjects over random backgrounds.")
    parser.add_argument("--subjects", required=True,
                        help="Path to the folder containing subject images (PNG with transparency).")
    parser.add_argument("--backgrounds", required=True, help="Path to the folder containing background images.")
    parser.add_argument("--output", required=True, help="Path to the output folder.")
    parser.add_argument("--num", type=int, default=1, help="Number of backgrounds to apply per subject.")

    args = parser.parse_args()

    process_images(args.subjects, args.backgrounds, args.output, args.num)

# python images_add_backgrounds.py --subjects "/path/to/subjects" --backgrounds "/path/to/backgrounds" --output "/path/to/output" --num 2