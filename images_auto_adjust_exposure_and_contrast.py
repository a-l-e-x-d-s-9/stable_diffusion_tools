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


# def adjust_image(image_path, dir_path, min_exp, max_exp, min_cont, max_cont, output_path, suffix):
#     # Load image
#     img = cv2.imread(image_path, cv2.IMREAD_COLOR)
#
#     # Convert image to YUV color space
#     img_yuv = cv2.cvtColor(img, cv2.COLOR_BGR2YUV)
#
#     # Adjust exposure and contrast
#     # Adjust contrast and brightness
#     alpha = random.uniform(min_cont, max_cont)  # Simple contrast control, same at 1
#     beta = random.uniform(min_exp, max_exp)  # Simple brightness control, same at 0
#     img_yuv[:, :, 0] = cv2.convertScaleAbs(img_yuv[:, :, 0], alpha=alpha, beta=beta)
#
#     # Equalize the histogram of the Y channel
#     # img_yuv[:, :, 0] = cv2.equalizeHist(img_yuv[:, :, 0])
#
#     # Convert back to BGR color space
#     img_output = cv2.cvtColor(img_yuv, cv2.COLOR_YUV2BGR)
#
#     # Create output directory if it doesn't exist
#     output_dir = os.path.join(output_path, os.path.dirname(os.path.relpath(image_path, dir_path)))
#     if not os.path.exists(output_dir):
#         os.makedirs(output_dir)
#
#     # Save image
#     output_file = os.path.join(output_dir, os.path.splitext(os.path.basename(image_path))[0] + suffix + '.jpg')
#     cv2.imwrite(output_file, img_output, [int(cv2.IMWRITE_JPEG_QUALITY), 100])


def adjust_image(image_path, dir_path, min_exp, max_exp, min_cont, max_cont, output_path, suffix):
    try:
        # Load image
        img = cv2.imread(image_path, cv2.IMREAD_COLOR)

        # Convert image to YUV color space
        img_yuv = cv2.cvtColor(img, cv2.COLOR_BGR2YUV).astype(float) / 255


        # Adjust contrast
        alpha = random.uniform(min_cont, max_cont)  # Contrast control
        #img_yuv[:, :, 0] = alpha * (img_yuv[:, :, 0] - 0.5) + 0.5
        #img_yuv[:, :, 0] = np.clip(img_yuv[:, :, 0], 0, 1)  # Clip values to range [0,1]


        # Adjust exposure
        gamma = random.uniform(min_exp, max_exp)  # Exposure control
        #img_yuv[:, :, 0] = np.power(img_yuv[:, :, 0], gamma)
        # img_yuv[:, :, 0] = np.clip(img_yuv[:, :, 0], 0, 1)  # Clip values to range [0,1]


        # img_yuv[:, :, 0] = np.power(alpha * (img_yuv[:, :, 0] - 0.5) + 0.5, gamma)
        # img_yuv[:, :, 0] = np.maximum(0, np.minimum(1, img_yuv[:, :, 0]))  # Clip values to range [0,1]

        y = img_yuv[:, :, 0]
        y -= 0.5
        y *= alpha
        y += 0.5

        np.maximum(0, y, out=y)
        np.minimum(1, y, out=y)

        np.power(y, gamma, out=y)

        np.maximum(0, y, out=y)
        np.minimum(1, y, out=y)

        # Equalize the histogram of the Y channel
        # y_uint8 = (y * 255).astype(np.uint8)
        # y_uint8 = cv2.equalizeHist(y_uint8)
        # img_yuv[:, :, 0] = y_uint8.astype(float) / 255

        # Adjust brightness
        # beta = random.uniform(min_exp, max_exp)  # Brightness control
        # img_yuv[:, :, 0] += beta
        # img_yuv[:, :, 0] = np.clip(img_yuv[:, :, 0], 0, 1)  # Clip values to range [0,1]


        # Convert back to BGR color space
        img_yuv = (img_yuv * 255).astype(np.uint8)
        img_output = cv2.cvtColor(img_yuv, cv2.COLOR_YUV2BGR)

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