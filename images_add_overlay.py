import os
import argparse
from PIL import Image
from concurrent.futures import ThreadPoolExecutor
import shutil

def process_image(image_path, output_folder, overlay_image):
    try:
        with Image.open(image_path) as base_image:
            base_image = base_image.convert("RGBA")
            resized_overlay = overlay_image.resize(base_image.size, Image.ANTIALIAS)

            # Create a new image with the same size as base_image
            combined = Image.alpha_composite(base_image, resized_overlay)

            # Convert to RGB if the output format is JPEG
            if image_path.lower().endswith('.jpg') or image_path.lower().endswith('.jpeg'):
                combined = combined.convert("RGB")

            output_path = os.path.join(output_folder, os.path.basename(image_path))
            combined.save(output_path)
            print(f"Processed {image_path}")

        # Copy associated files with the same name but different extensions
        base_name, _ = os.path.splitext(image_path)
        for file in os.listdir(os.path.dirname(image_path)):
            if file.startswith(os.path.basename(base_name)) and not file.endswith(('.png', '.jpg', '.jpeg')):
                shutil.copy(os.path.join(os.path.dirname(image_path), file), output_folder)
    except Exception as e:
        print(f"Failed to process {image_path}: {e}")

def process_images_in_thread(image_paths, output_folder, overlay_image):
    for image_path in image_paths:
        process_image(image_path, output_folder, overlay_image)

def main():
    parser = argparse.ArgumentParser(description="Overlay an image on a folder of images.")
    parser.add_argument('--input_folder', required=True, help="Folder with images to edit.")
    parser.add_argument('--output_folder', required=True, help="Folder to save edited images.")
    parser.add_argument('--overlay_image', required=True, help="Overlay image with transparency.")
    parser.add_argument('--threads', type=int, default=4, help="Number of threads to use.")

    args = parser.parse_args()

    if not os.path.exists(args.output_folder):
        os.makedirs(args.output_folder)

    overlay_image = Image.open(args.overlay_image).convert("RGBA")

    image_paths = [os.path.join(args.input_folder, f) for f in os.listdir(args.input_folder) if f.lower().endswith(('png', 'jpg', 'jpeg'))]

    chunk_size = len(image_paths) // args.threads

    with ThreadPoolExecutor(max_workers=args.threads) as executor:
        for i in range(0, len(image_paths), chunk_size):
            executor.submit(process_images_in_thread, image_paths[i:i + chunk_size], args.output_folder, overlay_image)

if __name__ == "__main__":
    main()

# python images_add_overlay.py --input_folder /path/to/input_folder --output_folder /path/to/output_folder --overlay_image /path/to/overlay_image.png --threads 4