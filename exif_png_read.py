import argparse

from PIL import Image
from PIL.ExifTags import TAGS
from PIL.PngImagePlugin import PngImageFile


def read_image_metadata(image_path):
    with Image.open(image_path) as img:
        metadata = {}
        if img.format == "PNG":
            if not isinstance(img, PngImageFile):
                raise ValueError("Not a valid PNG image")
            pnginfo = img.info
            for k, v in pnginfo.items():
                metadata[k] = v
        elif img.format in ["JPEG", "JPG"]:
            exif_data = img._getexif()
            if exif_data is None:
                raise ValueError("No EXIF data found in the JPEG image")
            for tag, value in exif_data.items():
                tag_name = TAGS.get(tag, tag)

                # Handle the UserComment tag
                if tag_name == "UserComment" and isinstance(value, bytes):
                    prefix = value[:8]
                    if b'UNICODE' in prefix:
                        try:
                            value = value[8:].decode('utf-8', errors='ignore')
                        except UnicodeDecodeError:
                            value = value[8:].decode('utf-16', errors='ignore')

                metadata[tag_name] = value
        else:
            raise ValueError(f"Unsupported image format: {img.format}")

    return metadata


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Extract metadata from a PNG, JPG, or JPEG image.")
    parser.add_argument("--image-path", required=True, help="Path to the image.")
    args = parser.parse_args()

    input_image = args.image_path
    metadata = read_image_metadata(input_image)

    for key, value in metadata.items():
        print(f"{key}: {value}")
