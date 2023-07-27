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


def get_center_and_radius(image):
    center = (image.shape[1] // 2, image.shape[0] // 2)
    radius = int(min(image.shape[0], image.shape[1]) / 3 * 0.71)

    return center, radius


def apply_center_mask(image):
    # Create a circular mask with diameter 1/3 of the image's smallest dimension
    mask = np.zeros(image.shape, dtype=np.uint8)
    center, radius = get_center_and_radius(image)
    cv2.circle(mask, center, radius, (255, 255, 255), thickness=-1)

    # Apply the mask to the image
    return cv2.bitwise_and(image, mask)


def variance_of_laplacian(image):
    return cv2.Laplacian(image, cv2.CV_64F).var()


def ssim_index(image):
    blurred = cv2.GaussianBlur(image, (25, 25), 0)
    return structural_similarity(image, blurred, data_range=image.max() - image.min())


def cpbd_metric(image):
    # Compute the CPBD metric
    return cpbd.compute(image)


def normalize_value(value, a, b):
    return (value - a) / (b - a)


def process_image(filename, src_folder, blurry_folder, check_center, pbar, threshold_vol_low_is_blurry,
                  threshold_ssim_high_is_blurry, debug):
    image_path = os.path.join(src_folder, filename)
    image = cv2.imread(image_path)

    if image is None or image.size == 0:
        tqdm.write(f'Invalid image or could not read the image: {image_path}')
        return 0

    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    # fm = variance_of_laplacian(gray, check_center)

    if check_center:
        image_center_if_needed = apply_center_mask(gray)
    else:
        image_center_if_needed = gray

    # fm = np.mean(
    #     [variance_of_laplacian(image_center_if_needed), ssim_index(image_center_if_needed), cpbd_metric(image_center_if_needed)]) #, ssim_index(image_center_if_needed), cpbd_metric(image_center_if_needed)

    if threshold_vol_low_is_blurry:
        # Normalized Variance of Laplacian (assume maximum value is 1000 for normalization)
        vol = normalize_value(variance_of_laplacian(image_center_if_needed), 0, 100)

    if threshold_ssim_high_is_blurry:
        # Normalized SSIM Index (range is -1 to 1)
        si = normalize_value(ssim_index(image_center_if_needed), -1, 1)

    # print(f"vol: {vol}, si: {si}")
    # CPBD Metric (already normalized to range 0 to 1)
    # cm = cpbd_metric(image_center_if_needed)

    if debug:
        if check_center:
            center, radius = get_center_and_radius(image)
            cv2.circle(image, center, radius=radius, color=(0, 255, 0), thickness=2)

        file_name = ""
        if threshold_vol_low_is_blurry:
            file_name += f"vol {vol:.8f}"

        if threshold_ssim_high_is_blurry:
            if "" != file_name:
                file_name += ", "
            file_name += f"si {si:.8f}"

        cv2.imwrite(str(os.path.join(blurry_folder, f"{file_name}.jpg")), image)

        return 1
    else:
        if ((threshold_vol_low_is_blurry is not None) and (threshold_vol_low_is_blurry < vol)) or \
           ((threshold_ssim_high_is_blurry is not None) and (threshold_ssim_high_is_blurry < si)):
            move(image_path, os.path.join(blurry_folder, filename))
            return 1

    return 0


def move_blurry_images(src_folder, blurry_folder, check_center, threshold_vol_low_is_blurry,
                       threshold_ssim_high_is_blurry, debug):
    if not os.path.exists(blurry_folder):
        os.makedirs(blurry_folder)

    filenames = [filename for filename in sorted(os.listdir(src_folder)) if
                 filename.endswith(".jpg") or filename.endswith(".png")]

    with ThreadPoolExecutor(max_workers=8) as executor:
        with tqdm(total=len(filenames), dynamic_ncols=True) as pbar:
            futures = [
                executor.submit(process_image, filename, src_folder, blurry_folder, check_center, pbar,
                                threshold_vol_low_is_blurry, threshold_ssim_high_is_blurry, debug) for
                filename in filenames]
            count_blurry = 0
            for future in concurrent.futures.as_completed(futures):
                count_blurry += future.result()
                pbar.update()
                pbar.set_postfix({'Moved': count_blurry})


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description='Move blurry images.')
    parser.add_argument('--src_folder', type=str, required=True, help='Source folder containing images.')
    parser.add_argument('--blurry_folder', type=str, required=True, help='Destination folder to move blurry images.')
    parser.add_argument('--debug', action='store_true', default=False, help='Debug')
    parser.add_argument('--threshold_vol_low_is_blurry', type=float, default=None,
                        help='Blurry threshold for Variance of Laplacian.')
    parser.add_argument('--threshold_ssim_high_is_blurry', type=float, default=None, help='Blurry threshold for SSIM.')
    parser.add_argument('--check-center', action='store_true',
                        help='Check only the center of the image for blurriness.')

    args = parser.parse_args()

    if (None == args.threshold_vol_low_is_blurry) and (None == args.threshold_ssim_high_is_blurry):
        print("Specify at least one: --threshold_vol_low_is_blurry OR --threshold_ssim_high_is_blurry OR Both")
        exit(-1)

    move_blurry_images(args.src_folder, args.blurry_folder, args.check_center, args.threshold_vol_low_is_blurry,
                       args.threshold_ssim_high_is_blurry, args.debug)

# python3 images_filter_blurry.py --src_folder /path/to/images --blurry_folder /path/to/blurry_images --threshold_vol_low_is_blurry 0.14 --threshold_ssim_high_is_blurry 0.997 --check-center
