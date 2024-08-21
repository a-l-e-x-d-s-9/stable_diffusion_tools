import sys
import argparse

import PIL
import piexif
from PIL import Image
from PIL.ExifTags import TAGS
import io

PIL.Image.MAX_IMAGE_PIXELS = 1000000000

def remove_header(value):
    if value.startswith("UNICODE"):
        value = value[len("UNICODE"):]
    return value

def get_image_metadata(image_path):
    try:
        with Image.open(image_path) as img:
            if img.format == 'JPEG':
                exif_data_raw = img.info.get('exif')
                if exif_data_raw:
                    exif_dict = piexif.load(exif_data_raw)
                    exif_data = {}
                    for ifd_name in exif_dict:
                        if ifd_name != "thumbnail":  # Skip the thumbnail data
                            for tag, value in exif_dict[ifd_name].items():
                                decoded_tag = TAGS.get(tag, tag)
                                exif_data[decoded_tag] = value
                    return exif_data
            elif img.format == 'PNG':
                text_data = img.info
                print(f"text_data: {text_data}")
                return text_data
                #return {key: text_data[key] for key in text_data if key not in ['exif', 'dpi']}
    except Exception as e:
        print(f"Error: {e}")
        return None

def get_exif(image_path):
    try:
        exif_data = get_image_metadata(image_path)
        for key in exif_data:
            print(f"AAA: {key}")
        with Image.open(image_path) as img:
            # exif_data_raw = img.info.get("exif")
            text_data = img.info
            exif_data_raw = {key: text_data[key] for key in text_data if key not in ['exif', 'dpi']}

            # if img.format == 'JPEG':
            #     exif_data_raw = img.info.get('exif')
            #     if exif_data_raw:
            #         exif_dict = piexif.load(exif_data_raw)
            #         exif_data = {TAGS.get(tag, tag): exif_dict[ifd][tag] for ifd in exif_dict for tag in exif_dict[ifd] if ifd != 'thumbnail'}
            #         return exif_data
            # elif img.format == 'PNG':
            #     text_data = img.info
            #     return {key: text_data[key] for key in text_data if key not in ['exif', 'dpi']}


            if exif_data_raw:
                exif_dict = piexif.load(exif_data_raw)
                exif = {}
                for ifd in exif_dict:
                    if ifd == "thumbnail":
                        continue
                    for tag_id in exif_dict[ifd]:
                        tag = TAGS.get(tag_id, tag_id)
                        value = exif_dict[ifd][tag_id]
                        if isinstance(value, bytes):
                            try:
                                value = value.decode("utf-8")
                            except UnicodeDecodeError:
                                try:
                                    value = value.decode("iso-8859-1")
                                except UnicodeDecodeError:
                                    value = value.decode("windows-1252")
                        if tag == "UserComment":
                            value = remove_header(value)

                        exif[tag] = value
                return exif
            else:
                return None
    except Exception as e:
        print(f"Error: {e}")
        return None

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Extract EXIF data from an image.")
    parser.add_argument("--image-path", required=True, help="Path to the image.")
    parser.add_argument("--save-to-file", action="store_true", help="Save EXIF data to a file.")
    args = parser.parse_args()

    exif_data = get_exif(args.image_path)

    if exif_data:
        for key, value in exif_data.items():
            if key != "ExifOffset":
                print(f"{value}")

        if args.save_to_file:
            exif_file = f"{args.image_path.split('.')[0]}_exif.txt"
            with io.open(exif_file, "w", encoding="utf-8") as f:
                for key, value in exif_data.items():
                    if key != "ExifOffset":
                        f.write(f"{key}: {value}\n")
    else:
        print("No exif data found in image")
