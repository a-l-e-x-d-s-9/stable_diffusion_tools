import os
import glob
import cv2
from PIL import Image
import numpy as np
import random
from concurrent.futures import ThreadPoolExecutor
from tqdm import tqdm
import argparse
from threading import Lock

def process_images(dir_path, output_path, min_exp, max_exp, min_cont, max_cont, n_copies):
    # Scan for images
    images = scan_images(dir_path)

    # Create a progress bar
    pbar = tqdm(total=len(images) * n_copies, desc="Processing Images")

    # Create a lock
    lock = Lock()

    # Define a function to update the progress bar in a thread-safe way
    def update_pbar(x):
        with lock:
            pbar.update()

    # Create a ThreadPoolExecutor
    with ThreadPoolExecutor(max_workers=10) as executor:
        # For each image
        for image_path in images:
            # For each copy
            for i in range(n_copies):
                # Submit a task to adjust the image and update the progress bar
                executor.submit(adjust_image, image_path, min_exp, max_exp, min_cont, max_cont, output_path, chr(97 + i)).add_done_callback(update_pbar)
    pbar.close()


def adjust_image(image_path, min_exp, max_exp, min_cont, max_cont, output_path, suffix):
    # Load image
    img = cv2.imread(image_path, cv2.IMREAD_COLOR)

    # Convert image to YUV color space
    img_yuv = cv2.cvtColor(img, cv2.COLOR_BGR2YUV)

    # Adjust exposure and contrast
    alpha = random.uniform(min_exp, max_exp)  # Simple contrast control
    beta = random.randint(min_cont, max_cont)  # Simple brightness control
    img_yuv[:, :, 0] = cv2.convertScaleAbs(img_yuv[:, :, 0], alpha=alpha, beta=beta)

    # Equalize the histogram of the Y channel
    img_yuv[:, :, 0] = cv2.equalizeHist(img_yuv[:, :, 0])

    # Convert back to BGR color space
    img_output = cv2.cvtColor(img_yuv, cv2.COLOR_YUV2BGR)

    # Create output directory if it doesn't exist
    output_dir = os.path.join(output_path, os.path.dirname(os.path.relpath(image_path, dir_path)))
    if not os.path.exists(output_dir):
        os.makedirs(output_dir)

    # Save image
    output_file = os.path.join(output_dir, os.path.splitext(os.path.basename(image_path))[0] + suffix + '.jpg')
    cv2.imwrite(output_file, img_output, [int(cv2.IMWRITE_JPEG_QUALITY), 100])


def scan_images(dir_path):
    img_types = ('.jpg', '.jpeg', '.png', '.bmp', '.tiff', '.JPG', '.JPEG', '.PNG', '.BMP', '.TIFF')
    return [img for img in glob.glob(dir_path + '**/*', recursive=True) if img.endswith(img_types)]


def main():
    # Create the parser
    parser = argparse.ArgumentParser(description="Adjust the exposure, contrast, and histogram of images")

    # Add the arguments
    parser.add_argument('source_path', type=str, help='The source path to scan for images')
    parser.add_argument('target_path', type=str, help='The target path to save the processed images')
    parser.add_argument('--copies', type=int, default=2, help='The number of copies to make for each image (default: 2)')
    parser.add_argument('--threads', type=int, default=10, help='The number of threads to use for image processing (default: 10)')
    parser.add_argument('--min_exp', type=float, default=1.0, help='The minimum exposure adjustment (default: 1.0)')
    parser.add_argument('--max_exp', type=float, default=3.0, help='The maximum exposure adjustment (default: 3.0)')
    parser.add_argument('--min_cont', type=int, default=1, help='The minimum contrast adjustment (default: 1)')
    parser.add_argument('--max_cont', type=int, default=3, help='The maximum contrast adjustment (default: 3)')

    # Parse the arguments
    args = parser.parse_args()

    # Call the process_images function with the arguments
    process_images(args.source_path, args.target_path, args.min_exp, args.max_exp, args.min_cont, args.max_cont, args.copies, args.threads)

if __name__ == "__main__":
    main()

# Example: python3 images_auto_adjust_exposure_and contrast.py source_path target_path --copies 2 --threads 10 --min_exp 1.0 --max_exp 3.0 --min_cont 1 --max_cont 3