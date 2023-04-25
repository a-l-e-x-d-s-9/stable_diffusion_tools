import argparse
import math
import os
import shutil
import sys
from PIL import Image
from random import random

def sort_images_by_ratio(image_path: str) -> bool :

    try:
        base_path = os.path.dirname(image_path)
        file_name = os.path.basename(image_path)

        width, height = 0, 0
        # with Image.open(image_path) as img:
        img = Image.open(open(image_path, 'rb'))
        width, height = img.size
        img.close()

        dimensions_gcd = math.gcd(width, height)

        target_path: str = os.path.join(base_path, f"{int(width/dimensions_gcd):05d}x{int(height/dimensions_gcd):05d}")

        if not os.path.isdir(target_path):
            os.mkdir(target_path)

        shutil.move(image_path, os.path.join(target_path, file_name))
                
    except Exception as e:
        print(f'Error processing {image_path}: {e}')

            

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Images sort into folders by aspect ration of image.')
    parser.add_argument('folder_path', type=str, help='Path to folder containing images.')
    args = parser.parse_args()
    
    folder_path = args.folder_path
    
    
    if not os.path.isdir(folder_path):
        print(f'Error: {folder_path} is not a directory')
        sys.exit(1)
        

    count = 0
    total = len(os.listdir(folder_path))

    for file_name in os.listdir(folder_path):
        file_path = os.path.join(folder_path, file_name)
        if os.path.isfile(file_path):
            count += 1
            file_is_image = file_name.lower().endswith(('.png', '.jpg', '.jpeg'))
            if file_is_image:
                sort_images_by_ratio(file_path)
                print(f'\rProcessed {count}/{total} images.', end='', flush=True)
                
    print('\nDone.')  # Print a message to indicate when all images have been processed.


#Run example: python images_sort_by_ratio.py /path/to/folder
