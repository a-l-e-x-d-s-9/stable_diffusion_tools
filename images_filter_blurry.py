import concurrent
import cv2
import numpy as np
import argparse
import os
from shutil import move
from tqdm import tqdm
from concurrent.futures import ThreadPoolExecutor


def variance_of_laplacian(image, check_center):
    if check_center:
        mask = np.zeros(image.shape, dtype=np.uint8)
        center = (image.shape[1] // 2, image.shape[0] // 2)
        radius = min(image.shape[0], image.shape[1]) // 3
        cv2.circle(mask, center, radius, (255, 255, 255), thickness=-1)
        image = cv2.bitwise_and(image, mask)
    return cv2.Laplacian(image, cv2.CV_64F).var()


def process_image(filename, src_folder, blurry_folder, threshold, check_center, pbar):
    image_path = os.path.join(src_folder, filename)
    image = cv2.imread(image_path)

    if image is None or image.size == 0:
        tqdm.write(f'Invalid image or could not read the image: {image_path}')
        return 0

    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    fm = variance_of_laplacian(gray, check_center)
    if fm < threshold:
        move(image_path, os.path.join(blurry_folder, filename))
        return 1
    return 0


def move_blurry_images(src_folder, blurry_folder, threshold, check_center):
    if not os.path.exists(blurry_folder):
        os.makedirs(blurry_folder)

    filenames = [filename for filename in sorted(os.listdir(src_folder)) if
                 filename.endswith(".jpg") or filename.endswith(".png")]

    with ThreadPoolExecutor(max_workers=16) as executor:
        with tqdm(total=len(filenames), dynamic_ncols=True) as pbar:
            futures = [
                executor.submit(process_image, filename, src_folder, blurry_folder, threshold, check_center, pbar) for
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
    parser.add_argument('--threshold', type=float, default=100.0, help='Blurry threshold.')
    parser.add_argument('--check-center', action='store_true',
                        help='Check only the center of the image for blurriness.')
    args = parser.parse_args()
    move_blurry_images(args.src_folder, args.blurry_folder, args.threshold, args.check_center)


# python3 images_filter_blurry.py --src_folder /path/to/images --blurry_folder /path/to/blurry_images --threshold 100.0 --check-center