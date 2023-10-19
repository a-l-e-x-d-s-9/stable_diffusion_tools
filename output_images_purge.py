import argparse
import concurrent
import string

from PIL import Image
from PIL.ExifTags import TAGS
from PIL.PngImagePlugin import PngImageFile
import re
from pathlib import Path
from tqdm import tqdm
import concurrent.futures
import os

# Set the pixel limit to a higher value
Image.MAX_IMAGE_PIXELS = None  # This will remove the limit

def is_content_valid(decoded_str: str) -> bool:
    """Check if the decoded string is likely valid using string.printable."""
    return all(char in string.printable for char in decoded_str)

def read_image_metadata(image_path):
    metadata = {}

    try:
        with Image.open(image_path) as img:

            if img.format == "PNG":
                if not isinstance(img, PngImageFile):
                    #print(f"Image with error: {image_path}")
                    return metadata
                    #raise ValueError("Not a valid PNG image")
                pnginfo = img.info
                for k, v in pnginfo.items():
                    metadata[k] = v
            elif img.format in ["JPEG", "JPG"]:
                exif_data = img._getexif()
                if exif_data is None:
                    #raise ValueError("No EXIF data found in the JPEG image")
                    #print(f"Image with error: {image_path}")
                    return metadata
                for tag, value in exif_data.items():
                    tag_name = TAGS.get(tag, tag)
                    content_decoded = value

                    # Handle the UserComment tag
                    if tag_name == "UserComment" and isinstance(value, bytes):
                        prefix = value[:8]
                        is_decoded = False

                        if prefix == b'UNICODE\0':
                            content = value[8:]
                        else:
                            content = value

                        # Try decoding with UTF-16 first
                        content_decoded = content.decode('utf-16be', errors='ignore')
                        is_decoded = is_content_valid(content_decoded)

                        if False == is_decoded:
                            content_decoded = content.decode('utf-16le', errors='ignore')
                            is_decoded = is_content_valid(content_decoded)

                        if False == is_decoded:
                            content_decoded = content.decode('utf-8', errors='ignore')
                            is_decoded = is_content_valid(content_decoded)

                        if False == is_decoded:
                            content_decoded = content.decode('iso-8859-1', errors='ignore')
                            is_decoded = is_content_valid(content_decoded)

                        if False == is_decoded:
                            content_decoded = content.decode('windows-1252', errors='ignore')
                            is_decoded = is_content_valid(content_decoded)

                        if False == is_decoded:
                            content_decoded = content
                            print(f"Failed to decode, image: {image_path}")


                    metadata[tag_name] = content_decoded
            else:
                raise ValueError(f"Unsupported image format: {img.format}")
    except Exception as e:
        pass

    return metadata


def extract_patterns(s: str):
    extracted = {
        "seed": None,
        "width": None,
        "height": None,
        "multiplier": None
    }

    # Check if the input is a string
    if not isinstance(s, str):
        # print("Warning: Input is not a string!")
        return extracted

    # Pattern 1: Seed
    seed_match = re.search(r'Seed: (\d+)(,|$)', s)
    if seed_match:
        seed = int(seed_match.group(1))
    else:
        seed = None
        # print("Warning: Seed pattern missing!")

    # Pattern 2: Size
    size_match = re.search(r'Size: (\d+)x(\d+)(,|$)', s)
    if size_match:
        width = int(size_match.group(1))
        height = int(size_match.group(2))
    else:
        width, height = None, None
        # print("Warning: Size pattern missing!")

    # Pattern 3: Hires upscale
    multiplier_match = re.search(r'Hires upscale: ([\d\.]+)(,|$)', s)
    if multiplier_match:
        multiplier = float(multiplier_match.group(1))
    else:
        multiplier = None
        # print("Warning: Hires upscale pattern missing!")

    extracted = {
        "seed": seed,
        "width": width,
        "height": height,
        "multiplier": multiplier
    }

    return extracted

def handle_image(input_image, args):
    metadata = read_image_metadata(input_image)
    deleted_file_size = 0

    for key, value in metadata.items():
        #print(f"KEY: {key}: \n VALUE:\n {value}")

        if key == "UserComment" or key == "parameters":

            is_need_to_delete = False
            image_data = extract_patterns(value)

            if args.seed_start:
                if None != image_data["seed"]:
                    if (args.seed_start <= image_data["seed"]) and (image_data["seed"] <= args.seed_end):
                        is_need_to_delete = True

            if args.min_width:
                if None != image_data["width"]:
                    if (image_data["width"] <= args.min_width) and (image_data["height"] <= args.min_height):
                        if None == image_data["multiplier"]:
                            is_need_to_delete = True

            if is_need_to_delete:
                deleted_file_size = os.path.getsize(input_image)  # Get the file size
                if args.dry_run_off:
                    os.remove(input_image)
                    return deleted_file_size
                else:
                    print(f"[NOT] Delete: {input_image}")

    return deleted_file_size

def process_images(args):
    source_folder_path = Path(args.path)

    # Prepare list of image paths, ignoring hidden files and directories
    image_paths = [p for p in source_folder_path.glob('**/*')
                   if ('/.' not in p.as_posix()
                       and p.suffix.lower() in ['.jpg', '.jpeg', '.png'])]

    total_images = len(image_paths)
    total_deleted_size = 0

    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as executor:
        with tqdm(total=total_images, unit="file", desc="Total deleted: 0 GB") as pbar:
            for deleted_size in executor.map(lambda image_path: handle_image(image_path, args), image_paths):
                pbar.update(1)
                total_deleted_size += deleted_size
                pbar.set_description(f"Total deleted: {total_deleted_size / (1024 ** 3):.3f} GB")



if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Delete images by seed or size - based on PNG info.")

    parser.add_argument("--path", required=True, help="Path with all images.")

    # Seed start and end
    parser.add_argument("--seed_start", type=int, help="Starting seed value (inclusive).")
    parser.add_argument("--seed_end", type=int, help="Ending seed value (inclusive).")

    # Min width and height
    parser.add_argument("--min_width", type=int, help="Minimum width for image deletion.")
    parser.add_argument("--min_height", type=int, help="Minimum height for image deletion.")

    # Dry run flag
    parser.add_argument("--dry_run_off", action="store_true",
                        help="Enable the removal of images. Without this flag, the script runs in dry run mode.")

    args = parser.parse_args()

    # Validation: seed_start and seed_end must come together
    if (args.seed_start is not None) != (args.seed_end is not None):
        parser.error("Both --seed_start and --seed_end must be provided together.")

    # Validation: min_width and min_height must come together
    if (args.min_width is not None) != (args.min_height is not None):
        parser.error("Both --min_width and --min_height must be provided together.")

    # Validation: At least one removal criteria should be provided
    if (not args.seed_start) and (not args.min_width):
        parser.error("No removal criteria provided. Provide at least one of the criteria.")


    process_images(args)

    # output_images_purge.py --path "/some/path/" --seed_start 0 --seed_end 300 --min_width 512 --min_height 768