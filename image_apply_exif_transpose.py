import os
import argparse
import threading
from PIL import Image, UnidentifiedImageError
from concurrent.futures import ThreadPoolExecutor
import piexif

# Thread-safe counters
counter_lock = threading.Lock()
total_images = 0
processed_images = 0
errors_counter = 0

# Transpose and rotate operations based on EXIF orientation values
ORIENTATION_ACTIONS = {
    2: Image.FLIP_LEFT_RIGHT,
    3: Image.ROTATE_180,
    4: Image.FLIP_TOP_BOTTOM,
    5: lambda img: img.transpose(Image.FLIP_LEFT_RIGHT).rotate(-90),
    6: Image.ROTATE_270,
    7: lambda img: img.transpose(Image.FLIP_LEFT_RIGHT).rotate(90),
    8: Image.ROTATE_90
}

def process_image(chunk):
    global total_images
    global processed_images
    global errors_counter

    for path in chunk:
        try:
            # Open image just for the exif data
            with open(path, 'rb') as file:
                img = Image.open(file)
                img_exif = piexif.load(img.info["exif"])

        except (UnidentifiedImageError, OSError, ValueError, PermissionError):
            print(f"\nError processing image: {path}")
            with counter_lock:
                errors_counter += 1
            continue

        if "0th" not in img_exif or piexif.ImageIFD.Orientation not in img_exif["0th"]:
            continue

        orientation = img_exif["0th"][piexif.ImageIFD.Orientation]

        # Check if the image needs rotation or transposition
        if orientation in ORIENTATION_ACTIONS:
            # Reload image to apply transformations
            img = Image.open(path)
            action = ORIENTATION_ACTIONS[orientation]

            if callable(action):
                img = action(img)
            else:
                img = img.transpose(action)

            # Remove the orientation tag from the EXIF data
            del img_exif["0th"][piexif.ImageIFD.Orientation]
            exif_bytes = piexif.dump(img_exif)

            # Save the image with new data
            img.save(path, exif=exif_bytes)

        # Update the counter
        with counter_lock:
            processed_images += 1

        print(f'\rProcessed {processed_images} out of {total_images} images, errors: {errors_counter}.', end='', flush=True)


def main(folder_path):
    global total_images

    threads_number = 30

    # Get a list of all image files in the directory
    image_paths = []
    for root, dirs, files in os.walk(folder_path):
        for file in files:
            if file.lower().endswith(('.jpg', '.jpeg', '.png')):
                image_paths.append(os.path.join(root, file))

    total_images = len(image_paths)

    # Split image paths into threads_number parts
    chunks = [image_paths[i::threads_number] for i in range(threads_number)]

    # Use 10 threads to process the images
    with ThreadPoolExecutor(max_workers=threads_number) as executor:
        for chunk in chunks:
            executor.submit(process_image, chunk)


if __name__ == '__main__':

    parser = argparse.ArgumentParser(description='Apply EXIF rotation to images.')
    parser.add_argument('--scan-folder', required=True, help='Root folder for scanning')

    args = parser.parse_args()

    main(args.scan_folder)


    print(f"\nImage processing complete! Processed {processed_images} out of {total_images} images, errors: {errors_counter}")
