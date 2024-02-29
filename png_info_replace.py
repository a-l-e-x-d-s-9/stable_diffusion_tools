import string
import sys
import argparse
import json

import PIL
import piexif
from PIL import Image
from PIL.ExifTags import TAGS
import io
import re
from PIL.PngImagePlugin import PngInfo

PIL.Image.MAX_IMAGE_PIXELS = 1000000000

allowed_chars = set(string.printable + '\t\n\r')


def remove_invisible_characters(s):
    # Retain characters that are in the allowed set
    return ''.join(ch for ch in s if ch in allowed_chars)

def read_names(file_path):
    modified_names = []
    with open(file_path, 'r') as file:
        for line in file:
            name = line.strip()
            modified_names.append(name)
    return modified_names


def replace_exif_strings(exif_dict, names):
    # pattern = "Emily Ratajkowski"
    # replacement = "Emily( :0)Ratajkowski"
    for ifd in exif_dict.keys():
        if ifd == "thumbnail":  # Skip thumbnail data
            continue
        for tag in exif_dict[ifd]:
            if isinstance(exif_dict[ifd][tag], bytes):
                try:

                    decoded_value = exif_dict[ifd][tag].decode('utf-8')
                    decoded_value = remove_invisible_characters(decoded_value)
                    #print(f"111 {decoded_value}")
                    # for i in range(30):
                    #     print(f"222[{i}] {decoded_value[i]}")

                    for name in names:
                        # print(f"name: {name}")
                        if name.lower() in decoded_value.lower():
                            # Prepare the name with spaces replaced by "( :0)"
                            replacement_name = name.replace(" ", "( :0)")
                            if len(replacement_name) == len(name):
                                size = len(name)
                                replacement_name = name[0:size-1] + "(:0)" + name[size-1:size]
                            # Use a regular expression for case-insensitive replacement
                            pattern = re.compile(re.escape(name), re.IGNORECASE)
                            decoded_value = pattern.sub(replacement_name, decoded_value)
                            # print(f"replacement_name: {replacement_name}")

                    exif_dict[ifd][tag] = decoded_value.encode('utf-8')
                except UnicodeDecodeError:
                    pass  # Handle or log decode error if needed
    return exif_dict

def remove_header(value):
    if value.startswith("UNICODE"):
        value = value[len("UNICODE"):]
        # print("UNICODE Removed")
    return value


def get_exif(image_path):
    try:
        with Image.open(image_path) as img:
            #exif_data_raw = img.info.get("exif")
            exif_data_raw = img.text

            print(f"image_path: {image_path}, exif_data_raw: {exif_data_raw}")
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
                            # print("uni - remove")
                            exif_dict[ifd][tag_id] = value.encode('utf-8')

                        exif[tag] = value

                return exif, exif_dict
            else:
                print(f"None, None")
                return None, None
    except Exception as e:
        print(f"Error: {e}")
        return None, None


def modify_exif(exif_data, changes):
    for key, value in changes.items():
        if key in exif_data:
            exif_data[key] = value
    return exif_data


def save_exif(input_image_path, output_image_path, exif_data):
    exif_bytes = piexif.dump(exif_data)
    with Image.open(input_image_path) as img:
        img.save(output_image_path, "jpeg", exif=exif_bytes)

import os

def get_image_files(input_folder):
    supported_formats = ['.jpg', '.jpeg', '.png', '.tiff', '.bmp']
    image_files = []
    for file in os.listdir(input_folder):
        if any(file.lower().endswith(ext) for ext in supported_formats):
            image_files.append(os.path.join(input_folder, file))
    return image_files


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Extract and modify EXIF data from an image.")
    parser.add_argument("--input-folder", required=True, help="Path to the input folder containing images.")
    parser.add_argument("--output-folder", required=True, help="Path to the output folder for saving modified images.")
    parser.add_argument("--names-file", type=str, help="Path to the file containing names.")

    args = parser.parse_args()



    image_files = get_image_files(args.input_folder)
    names = read_names(args.names_file) if args.names_file else []

    for image_path in image_files:
        exif_data, exif_dict = get_exif(image_path)

        if exif_data:
            print("exif_data")
            if names:
                exif_dict = replace_exif_strings(exif_dict, names)

            output_image_path = os.path.join(args.output_folder, os.path.basename(image_path))
            save_exif(image_path, output_image_path, exif_dict)

    # image_files = get_image_files(args.input_folder)
    # exif_data, exif_dict = get_exif(args.image_path)
    #
    # if exif_data:
    #
    #     if args.image_output_path != None:
    #
    #         modified_names = read_and_modify_names(args.names_file)
    #         exif_dict = replace_exif_strings(exif_dict, modified_names)
    #
    #         save_exif(args.image_path, args.image_output_path, exif_dict)
    #
    #     for key, value in exif_data.items():
    #         if key != "ExifOffset":
    #             print(f"{key}: {value}")
    #
    # else:
    #     print("No exif data found in image")
