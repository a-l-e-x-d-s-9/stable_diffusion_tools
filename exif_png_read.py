import argparse

from PIL import Image
from PIL.PngImagePlugin import PngImageFile, PngInfo

def read_png_metadata(image_path):
    with Image.open(image_path) as img:
        if not isinstance(img, PngImageFile):
            raise ValueError("Not a PNG image")

        pnginfo = img.info
        metadata = {}

        for k, v in pnginfo.items():
            metadata[k] = v

    return metadata

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Extract metadata from a PNG image.")
    parser.add_argument("--image-path", required=True, help="Path to the image.")
    args = parser.parse_args()

    input_image = args.image_path
    metadata = read_png_metadata(input_image)

    for key, value in metadata.items():
        print(f"{key}: {value}")
