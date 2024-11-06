import concurrent
import cv2
import numpy as np
import argparse
import os
from shutil import move, copy
from tqdm import tqdm
from concurrent.futures import ThreadPoolExecutor
from skimage.metrics import structural_similarity  # pip install scikit-image
from skimage.filters import gaussian
import cpbd  # had to change "from imageio import imread" in compute.py
from pathlib import Path
import cv2
import numpy as np
import torch
import piq
from torchvision import transforms

def get_center_and_radius(image):
    center = (image.shape[1] // 2, image.shape[0] // 2)
    radius = int(min(image.shape[0], image.shape[1]) / 3 * 0.71)

    return center, radius


def apply_center_mask(image):
    # Create a circular mask with diameter 1/3 of the image's smallest dimension
    mask = np.zeros(image.shape, dtype=np.uint8)
    center, radius = get_center_and_radius(image)
    cv2.circle(mask, center, radius, (255, 255, 255), thickness=-1)
    image_masked = cv2.bitwise_and(image, mask)

    # Create a rectangle around the circle
    x, y, r = center[0], center[1], radius
    bounding_rect = (x - r, y - r, 2 * r, 2 * r)

    # Crop the image to the rectangle
    cropped_image = image_masked[bounding_rect[1]:bounding_rect[1] + bounding_rect[3],
                    bounding_rect[0]:bounding_rect[0] + bounding_rect[2]]


    return cropped_image


def variance_of_laplacian(image):
    MAX_IMAGE_DIMENSION = 1024  # Maximum dimension (width or height) of an image before it is resized

    # If the image is too large, resize it
    if image.shape[0] > MAX_IMAGE_DIMENSION or image.shape[1] > MAX_IMAGE_DIMENSION:
        scale = MAX_IMAGE_DIMENSION / max(image.shape[0], image.shape[1])
        image = cv2.resize(image, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)

    return cv2.Laplacian(image, cv2.CV_64F).var()


def ssim_index(image):
    blurred = cv2.GaussianBlur(image, (25, 25), 0)
    return structural_similarity(image, blurred, data_range=image.max() - image.min())


def cpbd_metric(image):
    # Compute the CPBD metric
    return cpbd.compute(image)


def normalize_value(value, a, b):
    return (value - a) / (b - a)

def load_image_for_brisque(image):
    image_rgb = image  # Assuming the image is already in RGB format
    preprocess = transforms.Compose([
        transforms.ToTensor(),
        transforms.Resize((512, 512)),  # Resize the image to a fixed size for the model
    ])
    image_tensor = preprocess(image_rgb).unsqueeze(0)  # Add batch dimension

    # Ensure the tensor values are within [0, 1]
    image_tensor = torch.clamp(image_tensor, 0, 1)

    return image_tensor


def compute_brisque(image_tensor):
    # Calculate BRISQUE score using piq (lower score = better quality)
    brisque_score = piq.brisque(image_tensor)
    return brisque_score.item()


def process_image(filename, src_folder, blurry_folder, check_center, threshold_vol_low_is_blurry,
                  threshold_ssim_high_is_blurry, threshold_brisque_high_is_blurry, debug):
    image_path = os.path.join(src_folder, filename)
    image = cv2.imread(image_path)

    if image is None or image.size == 0:
        tqdm.write(f'Invalid image or could not read the image: {image_path}')
        return 0

    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)

    # If --check-center is used, apply mask
    if check_center:
        image_test = apply_center_mask(gray)
    else:
        image_test = gray

    # Initialize variables
    vol, si, brisque_score = None, None, None
    is_blurry = False
    debug_text = []

    # Calculate Variance of Laplacian if threshold is provided
    if threshold_vol_low_is_blurry is not None:
        vol = normalize_value(variance_of_laplacian(image_test), 0, 100)
        if vol < threshold_vol_low_is_blurry:
            is_blurry = True
        debug_text.append(f"vol {vol:.8f}")

    # Calculate SSIM if threshold is provided
    if threshold_ssim_high_is_blurry is not None:
        si = normalize_value(ssim_index(image_test), -1, 1)
        if si > threshold_ssim_high_is_blurry:
            is_blurry = True
        debug_text.append(f"si {si:.8f}")

    # Calculate BRISQUE score if threshold is provided
    if threshold_brisque_high_is_blurry is not None:
        image_tensor = load_image_for_brisque(image_test)
        brisque_score = compute_brisque(image_tensor)
        if brisque_score > threshold_brisque_high_is_blurry:
            is_blurry = True
        debug_text.append(f"BRISQUE {brisque_score:.2f}")

    # Handle debug case: save images with blur info in the name
    if debug:
        if debug_text:
            debug_filename = f"{'_'.join(debug_text)}_{filename}"
        else:
            debug_filename = f"debug_{filename}"  # Fallback if no calculations were made
        cv2.imwrite(os.path.join(blurry_folder, debug_filename), image)
        return 1

    # Move the image to blurry folder if it's blurry
    if is_blurry:
        move(image_path, os.path.join(blurry_folder, filename))
        return 1

    return 0


def move_blurry_images(src_folder, blurry_folder, check_center, threshold_vol_low_is_blurry,
                       threshold_ssim_high_is_blurry, threshold_brisque_high_is_blurry, debug, threads):
    if not os.path.exists(blurry_folder):
        os.makedirs(blurry_folder)

    filenames = [filename for filename in sorted(os.listdir(src_folder)) if
                 filename.endswith(".jpg") or filename.endswith(".png") or filename.endswith(".jpeg")
                 or filename.endswith(".webp")
                 ]

    with ThreadPoolExecutor(max_workers=threads) as executor:
        with tqdm(total=len(filenames), dynamic_ncols=True) as pbar:
            futures = [
                executor.submit(process_image, filename, src_folder, blurry_folder, check_center,
                                threshold_vol_low_is_blurry, threshold_ssim_high_is_blurry,
                                threshold_brisque_high_is_blurry, debug) for
                filename in filenames]
            count_blurry = 0
            for future in concurrent.futures.as_completed(futures):
                count_blurry += future.result()

                pbar.update(1)                # Get the result and update the blurry count if the image was blurry
                count_blurry += future.result()
                pbar.set_postfix({'Moved': count_blurry})


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description='Move blurry images.')
    parser.add_argument('--src_folder', type=str, required=True, help='Source folder containing images.')
    parser.add_argument('--threads', type=int, required=False, default=8, help='Threads to use.')
    parser.add_argument('--blurry_folder', type=str, required=True, help='Destination folder to move blurry images.')
    parser.add_argument('--debug', action='store_true', default=False, help='Debug')
    parser.add_argument('--threshold_vol_low_is_blurry', type=float, default=None,
                        help='Blurry threshold for Variance of Laplacian.')
    parser.add_argument('--threshold_ssim_high_is_blurry', type=float, default=None, help='Blurry threshold for SSIM.')
    parser.add_argument('--threshold_brisque_high_is_blurry', type=float, default=None, help='Blurry threshold for BRISQUE.')
    parser.add_argument('--check-center', action='store_true',
                        help='Check only the center of the image for blurriness.')

    args = parser.parse_args()

    if (None == args.threshold_vol_low_is_blurry) and (None == args.threshold_ssim_high_is_blurry) and (None == args.threshold_brisque_high_is_blurry):
        print("Specify at least one: --threshold_vol_low_is_blurry OR --threshold_ssim_high_is_blurry OR --threshold_brisque_high_is_blurry")
        exit(-1)

    move_blurry_images(args.src_folder, args.blurry_folder, args.check_center, args.threshold_vol_low_is_blurry,
                        args.threshold_ssim_high_is_blurry, args.threshold_brisque_high_is_blurry, args.debug, args.threads)

# python3 images_filter_blurry.py --src_folder /path/to/images --blurry_folder /path/to/blurry_images --threshold_vol_low_is_blurry 0.14 --threshold_ssim_high_is_blurry 0.997 --check-center
