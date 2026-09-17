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


def adjust_bgr_image(img, gamma, alpha):
    """Return a contrast/exposure adjusted BGR image without changing the input.

    This is shared by batch processing and the dataset preparation preview.
    ``gamma`` below 1 brightens; ``alpha`` above 1 increases contrast.
    """
    if img is None:
        raise ValueError("Could not read image")
    if gamma <= 0 or alpha <= 0:
        raise ValueError("Gamma and contrast must be positive")
    img_yuv = cv2.cvtColor(img, cv2.COLOR_BGR2YUV).astype(float) / 255
    y = img_yuv[:, :, 0]
    y -= 0.5
    y *= alpha
    y += 0.5
    np.clip(y, 0, 1, out=y)
    np.power(y, gamma, out=y)
    np.clip(y, 0, 1, out=y)
    return cv2.cvtColor((img_yuv * 255).astype(np.uint8), cv2.COLOR_YUV2BGR)


def make_preview_rgb_images(image_path, gamma, alpha, max_dimension=900):
    """Load a small preview and return original and adjusted RGB arrays.

    The UI can display these directly without repeating OpenCV color conversion
    or the exposure/contrast calculation.
    """
    source = cv2.imread(str(image_path), cv2.IMREAD_COLOR)
    if source is None:
        raise ValueError(f"Could not read image: {image_path}")
    if max_dimension < 1:
        raise ValueError("Preview maximum dimension must be positive")
    height, width = source.shape[:2]
    scale = min(1, max_dimension / max(width, height))
    if scale < 1:
        source = cv2.resize(
            source,
            (max(1, int(width * scale)), max(1, int(height * scale))),
            interpolation=cv2.INTER_AREA,
        )
    adjusted = adjust_bgr_image(source, gamma, alpha)
    return (
        cv2.cvtColor(source, cv2.COLOR_BGR2RGB),
        cv2.cvtColor(adjusted, cv2.COLOR_BGR2RGB),
    )

def process_images(dir_path, output_path, min_exp, max_exp, min_cont, max_cont, n_copies, threads):
    try:
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
        with ThreadPoolExecutor(max_workers=threads) as executor:
            # For each image
            for image_path in images:
                # For each copy
                for i in range(n_copies):
                    # Submit a task to adjust the image and update the progress bar
                    executor.submit(adjust_image, image_path, dir_path, min_exp, max_exp, min_cont, max_cont, output_path, chr(97 + i)).add_done_callback(update_pbar)
        pbar.close()

    except Exception as e:
        print(f"Error processing image {image_path}: {e}")

def adjust_image(image_path, dir_path, min_exp, max_exp, min_cont, max_cont, output_path, suffix):
    try:
        # Load image
        img = cv2.imread(image_path, cv2.IMREAD_COLOR)

        alpha = random.uniform(min_cont, max_cont)  # Contrast control
        gamma = random.uniform(min_exp, max_exp)  # Exposure control
        img_output = adjust_bgr_image(img, gamma, alpha)

        # Create output directory if it doesn't exist
        output_dir = os.path.join(output_path, os.path.dirname(os.path.relpath(image_path, dir_path)))
        if not os.path.exists(output_dir):
            os.makedirs(output_dir)

        # Save image
        output_file = os.path.join(output_dir, os.path.splitext(os.path.basename(image_path))[0] + suffix + '.jpg')
        cv2.imwrite(output_file, img_output, [int(cv2.IMWRITE_JPEG_QUALITY), 95])

    except Exception as e:
        print(f"adjust_image {image_path}: {e}")


def scan_images(dir_path):
    img_types = ('.jpg', '.jpeg', '.png', '.bmp', '.tiff', '.JPG', '.JPEG', '.PNG', '.BMP', '.TIFF')
    return [img for img in glob.glob(dir_path + '**/*', recursive=True) if img.endswith(img_types)]


def main():
    # Create the parser
    parser = argparse.ArgumentParser(description="Adjust the exposure, contrast, and histogram of images")

    # Add the arguments
    parser.add_argument('--source_path', type=str, help='The source path to scan for images', required=True)
    parser.add_argument('--target_path', type=str, help='The target path to save the processed images', required=True)
    parser.add_argument('--copies', type=int, default=2, help='The number of copies to make for each image (default: 2)')
    parser.add_argument('--threads', type=int, default=10, help='The number of threads to use for image processing (default: 10)')
    parser.add_argument('--min_exp', type=float, default=0.6, help='The minimum exposure adjustment (default: 0.6, below 1 brigher, above 1 darker)')
    parser.add_argument('--max_exp', type=float, default=1.0, help='The maximum exposure adjustment (default: 1.0, below 1 brigher, above 1 darker)')
    parser.add_argument('--min_cont', type=float, default=1, help='The minimum contrast adjustment (default: 1, below 1 less contrast, above 1 more contrast)')
    parser.add_argument('--max_cont', type=float, default=1.25, help='The maximum contrast adjustment (default: 1.2, below 1 less contrast, above 1 more contrast5)')

    # Parse the arguments
    args = parser.parse_args()

    # Call the process_images function with the arguments
    process_images(args.source_path, args.target_path, args.min_exp, args.max_exp, args.min_cont, args.max_cont, args.copies, args.threads)

if __name__ == "__main__":
    main()

# Example: python3 images_auto_adjust_exposure_and_contrast.py --source_path source_path --target_path target_path --copies 2 --threads 10 --min_exp 1.0 --max_exp 3.0 --min_cont 1 --max_cont 3
