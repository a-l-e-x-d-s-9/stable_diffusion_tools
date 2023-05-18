import argparse
import os
import sys
import traceback

from PIL import Image
from random import random


def check_image_integrity(file_path, is_remove_exif):
    #image_extensions = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.tiff']

    #for file_name in os.listdir(folder_path):
    # file_path = os.path.join(folder_path, file_name)
    # file_extension = os.path.splitext(file_name)[1].lower()
    is_valid = False
    is_failed_to_read_exif = False
    is_exif_removed = False

    try:
        img = Image.open(open(file_path, 'rb'))

        #print(f"File: {file_name}, info: {img.info}")

        image_exif = img.getexif()

        img.close()

        is_valid = True

    except IOError as e:
        #print(f"{file_name} cannot be opened. Error: {str(e)}, {traceback.format_exc()}")
        is_failed_to_read_exif = True
    except Exception as e:
        #print(f"Error occurred while processing {file_name}. Error: {str(e)}, {traceback.format_exc()}")
        is_failed_to_read_exif = True

    if (True == is_failed_to_read_exif) and (False == is_remove_exif):
        print(f'Found problem with exif in file: {file_name}')

    if (True == is_failed_to_read_exif) and (True == is_remove_exif):
        try:
            img = Image.open(open(file_path, 'rb'))

            image_data = list(img.getdata())
            image_without_exif = Image.new(img.mode, img.size)
            image_without_exif.putdata(image_data)

            img.close()
            image_without_exif.save(file_path)
            image_without_exif.close()

            is_valid = True
            is_exif_removed = True

        except Exception as e:
            print(f"Error occurred while trying to remove exif for: {file_name}. Error: {str(e)}, {traceback.format_exc()}")

    return is_valid, is_exif_removed

if __name__ == "__main__":
    
    parser = argparse.ArgumentParser(description='Check exif data can be read, and allow to remove exif from images with problematic exif.')
    parser.add_argument('folder_path', type=str, help='Path to folder containing images.')
    parser.add_argument('--remove_exif', action='store_true', default=False,
                        help='Try to remove exif.')


    args = parser.parse_args()

    folder_path = args.folder_path
    is_remove_exif = args.remove_exif


    count_all = 0
    total = len(os.listdir(folder_path))
    count_valid = 0
    count_invalid = 0
    count_exif_removed = 0

    for file_name in os.listdir(folder_path):
        file_path = os.path.join(folder_path, file_name)
        if os.path.isfile(file_path):
            count_all += 1
            file_is_image = file_name.lower().endswith(('.jpg', '.jpeg', '.png', '.gif', '.bmp', '.tiff'))
            if file_is_image:
                is_valid, is_exif_removed = check_image_integrity( file_path, is_remove_exif )

                if is_exif_removed == is_valid:
                    count_invalid += 1
                else:
                    count_valid += 1

                if is_exif_removed:
                    count_exif_removed += 1
                print(f'\rProcessed {count_all}/{total} images.', end='', flush=True)

    print(f'\rDone, valid: {count_valid} images, invalid: {count_invalid} images, removed exif: {count_exif_removed}.', end='', flush=True)