import os
import argparse
import random
from PIL import Image
from concurrent.futures import ThreadPoolExecutor
import shutil

def process_image(image_path, output_folder, overlay_image, prefix):
    try:
        with Image.open(image_path) as base_image:
            base_image = base_image.convert("RGBA")
            resized_overlay = overlay_image.resize(base_image.size, Image.ANTIALIAS)

            # Create a new image with the same size as base_image
            combined = Image.alpha_composite(base_image, resized_overlay)

            # Convert to RGB if the output format is JPEG
            if image_path.lower().endswith('.jpg') or image_path.lower().endswith('.jpeg'):
                combined = combined.convert("RGB")

            output_filename = prefix + os.path.basename(image_path)
            output_path = os.path.join(output_folder, output_filename)
            combined.save(output_path)
            print(f"Processed {image_path}")

        # Copy associated files with the same name but different extensions
        base_name, _ = os.path.splitext(image_path)
        for file in os.listdir(os.path.dirname(image_path)):
            if file.startswith(os.path.basename(base_name)) and not file.endswith(('.png', '.jpg', '.jpeg')):
                src_path = os.path.join(os.path.dirname(image_path), file)
                dest_filename = prefix + file
                dest_path = os.path.join(output_folder, dest_filename)
                shutil.copy(src_path, dest_path)
    except Exception as e:
        print(f"Failed to process {image_path}: {e}")

def process_images_in_thread(image_paths, output_folder, overlay_image, prefix):
    for image_path in image_paths:
        process_image(image_path, output_folder, overlay_image, prefix)

def main():
    parser = argparse.ArgumentParser(description="Overlay an image on a folder of images.")
    parser.add_argument('--input_folder', required=True, help="Folder with images to edit.")
    parser.add_argument('--output_folder', required=True, help="Folder to save edited images.")
    parser.add_argument('--overlay_image', required=True, help="Overlay image with transparency.")
    parser.add_argument('--threads', type=int, default=4, help="Number of threads to use.")
    parser.add_argument('--num_images', type=int, default=0, help="Number of random images to process (0 means all images).")
    parser.add_argument('--prefix', type=str, default="", help="Prefix to add to output images and associated files.")

    args = parser.parse_args()

    if not os.path.exists(args.output_folder):
        os.makedirs(args.output_folder)

    overlay_image = Image.open(args.overlay_image).convert("RGBA")

    image_paths = [os.path.join(args.input_folder, f) for f in os.listdir(args.input_folder) if f.lower().endswith(('png', 'jpg', 'jpeg'))]

    if args.num_images > 0:
        image_paths = random.sample(image_paths, min(args.num_images, len(image_paths)))

    # Ensure all requested images are processed
    chunk_size = max(1, (len(image_paths) + args.threads - 1) // args.threads)

    with ThreadPoolExecutor(max_workers=args.threads) as executor:
        for i in range(0, len(image_paths), chunk_size):
            executor.submit(process_images_in_thread, image_paths[i:i + chunk_size], args.output_folder, overlay_image, args.prefix)

if __name__ == "__main__":
    main()


# python images_add_overlay.py python overlay_images.py --input_folder /path/to/input_folder --output_folder /path/to/output_folder --overlay_image /path/to/overlay_image.png --threads 4 --num_images 20