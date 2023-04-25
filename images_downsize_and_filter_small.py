import argparse
import os
import sys
import traceback

from PIL import Image

def red_print(print_content:str):
    RED = '\033[0;31m'
    NC = '\033[0m'  # No Color
    print(f"{RED}{print_content}{NC}", flush=True)

def convert_image(image_path, target_directory, max_resolution, min_resolution):
    try:
        # img = None
        # with Image.open(image_path) as img:
        # img = Image.open(open(image_path, 'rb'))
        img = Image.open(open(image_path, 'rb'))

        width, height = img.size

        if width < min_resolution and height < min_resolution:
            # print(f'{image_path} not copied - smaller than minimum resolution')
            img.close()
            return


        if img.mode != 'RGB':
            img = img.convert('RGB')

        if width > max_resolution or height > max_resolution:
            ratio = min(max_resolution / width, max_resolution / height)
            new_size = (int(width * ratio), int(height * ratio))
            img = img.resize(new_size, resample=Image.LANCZOS)

        # base_path = os.path.dirname(image_path)
        file_name_full = os.path.basename(image_path)
        file_name_without_extension, file_extension = os.path.splitext(file_name_full)
        new_image_path = os.path.join(target_directory, file_name_without_extension + '.png')

        if os.path.isfile(new_image_path):
            print(f'File already exist: {new_image_path}.')
            img.close()
            return

        # if (file_extension.upper() != 'PNG') or (img.format != 'PNG'):
        #     #print(f'Png converted: {image_path}')
        #
        #     img.save(new_image_path, format='PNG', quality=100,compress_level=1, optimize=True)
        # else:
        #     img.save(new_image_path)

        img.save(new_image_path, format='PNG', quality=100, compress_level=0, optimize=True) # img.save(new_image_path, format='PNG', quality=100, compress_level=0, optimize=True)
        img.close()

    except Exception as e:
        red_print(f'Error processing, possibly not copied: {image_path}: {e}, {traceback.format_exc()}') #, {traceback.format_exc()}
            

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Resize images in a directory and filter by size.')
    parser.add_argument('source_path', type=str, help='Path to folder with source images.')
    parser.add_argument('target_path', type=str, help='Path to folder for output images.')
    parser.add_argument('--min_resolution', type=int, default=128, help='Minimum resolution of images.')
    parser.add_argument('--max_resolution', type=int, default=2048, help='Maximum resolution of images.')
    args = parser.parse_args()
    
    source_path = args.source_path
    target_path = args.target_path
    min_resolution = args.min_resolution
    max_resolution = args.max_resolution
    
    if not os.path.isdir(source_path):
        print(f'Error: {source_path} is not a directory')
        sys.exit(1)

    if os.path.isfile(target_path):
        print(f'Error: {target_path} need to be directory, not a file.')
        sys.exit(1)

    if source_path == target_path:
        print(f'Target must be different from source path: "{source_path}"')
        sys.exit(1)

    if not os.path.isdir(target_path):
        print(f'Created target directory: "{target_path}"')
        os.mkdir(target_path)
        
    if max_resolution <= 0 or min_resolution <= 0:
        print('Error: max and min resolutions must be positive integers')
        sys.exit(1)
    
    if max_resolution <= min_resolution:
        print('Error: max resolution must be greater than min resolution')
        sys.exit(1)
    
    count = 0
    total = len(os.listdir(source_path))
    for file_name in os.listdir(source_path):
        file_path = os.path.join(source_path, file_name)
        if os.path.isfile(file_path):
            count += 1
            file_is_png = file_name.lower().endswith('.png')
            file_is_jpg = file_name.lower().endswith(('.jpg', '.jpeg'))
            if file_is_png or file_is_jpg:
                convert_image(file_path, target_path, max_resolution, min_resolution )
                
                print(f'\rProcessed {count}/{total} images', end='', flush=True)
                
    print('\nDone.')  # Print a message to indicate when all images have been processed. 

#Run example: python images_downsize_and_filter_small.py /path/to/folder /path/to/target --max_resolution 2048 --min_resolution 576
