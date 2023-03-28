import argparse
import os
import sys
from PIL import Image
from random import random

def flip_image( image_path: str, is_flip_randomly: bool ) -> bool :
    was_flipped = False
    try:
        need_to_flip = True
        
        if is_flip_randomly:
            need_to_flip = random() < 0.5
            
        if need_to_flip:

            # with Image.open(image_path) as img:
            img = Image.open(open(image_path, 'rb'))
            # Flip image horizontally
            img = img.transpose(Image.FLIP_LEFT_RIGHT)


            # Save the flipped image
            img.save(image_path)
            was_flipped = True
                
    except Exception as e:
        print(f'Error processing {image_path}: {e}')
        
    return was_flipped
            

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Flip images horizontally.')
    parser.add_argument('folder_path', type=str, help='Path to folder containing images.')
    parser.add_argument('--flip_randomly', action='store_true', default=False, help='Flip images randomly with chance of a in 2 for each.')
    args = parser.parse_args()
    
    folder_path = args.folder_path
    is_flip_randomly = args.flip_randomly
    
    
    if not os.path.isdir(folder_path):
        print(f'Error: {folder_path} is not a directory')
        sys.exit(1)
        
        
    flipped_counter = 0
    count = 0
    total = len(os.listdir(folder_path))
    
    
    for file_name in os.listdir(folder_path):
        file_path = os.path.join(folder_path, file_name)
        if os.path.isfile(file_path):
            count += 1
            file_is_image = file_name.lower().endswith(('.png', '.jpg', '.jpeg'))
            if file_is_image:
                was_flipped = flip_image(file_path, is_flip_randomly)
                
                if was_flipped:
                    flipped_counter += 1
                
                print(f'\rProcessed {count}/{total} images, flipped: {flipped_counter}.', end='', flush=True)
                
    print('\nDone.')  # Print a message to indicate when all images have been processed.


#Run example: python images_flip_horizontal.py /path/to/folder --flip_randomly
