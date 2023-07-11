import cv2
import numpy as np
import argparse
import os
from shutil import move

def variance_of_laplacian(image):
    return cv2.Laplacian(image, cv2.CV_64F).var()

def move_blurry_images(src_folder, dest_folder, threshold):
    if not os.path.exists(dest_folder):
        os.makedirs(dest_folder)
        
    count_blurry = 0

    for filename in sorted(os.listdir(src_folder)):
        if filename.endswith(".jpg") or filename.endswith(".png"):
            image_path = os.path.join(src_folder, filename)
            image = cv2.imread(image_path)
            gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
            fm = variance_of_laplacian(gray)
            if fm < threshold:
                count_blurry += 1
                move(image_path, os.path.join(dest_folder, filename))
                print(f"Moved[{count_blurry}]: {filename}")

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description='Move blurry images.')
    parser.add_argument('--src_folder', type=str, required=True, help='Source folder containing images.')
    parser.add_argument('--dest_folder', type=str, required=True, help='Destination folder to move blurry images.')
    parser.add_argument('--threshold', type=float, default=100.0, help='Blurry threshold.')
    args = parser.parse_args()
    move_blurry_images(args.src_folder, args.dest_folder, args.threshold)
