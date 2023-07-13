import cv2
import os
import argparse
from pathlib import Path
from tqdm import tqdm  # You need to install tqdm. If not installed, run: pip install tqdm

def expand_bounding_box(x, y, w, h, img_width, img_height, margin_ratio):
    """
    Expand the bounding box by a margin ratio while ensuring it stays within image boundaries.
    """
    x_expansion = w * margin_ratio
    y_expansion = h * margin_ratio

    x_start = max(0, int(x - x_expansion // 2))
    y_start = max(0, int(y - y_expansion // 2))

    x_end = min(img_width, int(x + w + x_expansion // 2))
    y_end = min(img_height, int(y + h + y_expansion // 2))

    return x_start, y_start, x_end - x_start, y_end - y_start

def resize_image_with_aspect_ratio(image, min_dimension):
    """
    Resize image while keeping aspect ratio such that minimum dimension matches the provided value.
    """
    height, width = image.shape[:2]

    # Determine the larger dimension
    max_dim = max(height, width)

    # Determine the scaling factor
    scale_factor = min_dimension / max_dim

    # Calculate the new dimensions
    new_width = int(width * scale_factor)
    new_height = int(height * scale_factor)

    # Resize the image
    resized_image = cv2.resize(image, (new_width, new_height), interpolation=cv2.INTER_AREA)

    return resized_image


def detect_and_zoom_to_face(image, min_size=844):
    face_cascade = cv2.CascadeClassifier(cv2.data.haarcascades + 'haarcascade_frontalface_default.xml')
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)

    faces = face_cascade.detectMultiScale(gray, scaleFactor=1.1, minNeighbors=5, minSize=(400, 400))
    is_debug = False

    for (x, y, w, h) in faces:
        expand_ratio = 2
        half_expand_w = int(w * (expand_ratio - 1) / 2)
        half_expand_h = int(h * (expand_ratio - 1) / 2)

        expanded_x = max(0, x - half_expand_w)
        expanded_y = max(0, y - half_expand_h)
        expanded_w = min(image.shape[1] - expanded_x, w + 2 * half_expand_w)
        expanded_h = min(image.shape[0] - expanded_y, h + 2 * half_expand_h)

        if is_debug:
            # Draw a rectangle and center dot on the original image
            cv2.rectangle(image, (x, y), (x + w, y + h), (0, 255, 0), 2)
            cv2.circle(image, (x + w // 2, y + h // 2), radius=3, color=(0, 255, 0), thickness=-1)

        cropped_face = image[expanded_y:expanded_y + expanded_h, expanded_x:expanded_x + expanded_w]
        min_dimension = min(cropped_face.shape[:2])
        scale_ratio = min_size / min_dimension

        resized_face = cv2.resize(cropped_face, None, fx=scale_ratio, fy=scale_ratio, interpolation=cv2.INTER_AREA)

        return resized_face  # return the original image as well for debugging

def process_images(source_folder, target_folder=None):
    source_folder_path = Path(source_folder)
    target_folder_path = Path(target_folder) if target_folder else source_folder_path

    # Prepare list of image paths, ignoring hidden files and directories
    image_paths = [p for p in source_folder_path.glob('**/*.jpg') if '/.' not in p.as_posix()]

    total_images = len(image_paths)
    processed_images = 0

    for image_path in tqdm(image_paths, total=total_images):  # using tqdm for progress bar
        # Open the image file
        image = cv2.imread(str(image_path))

        # Process the image
        processed_image = detect_and_zoom_to_face(image)

        if processed_image is not None:
            # Create the output path
            relative_path = image_path.relative_to(source_folder_path)
            output_path = target_folder_path / relative_path.with_stem("face_" + relative_path.stem)  # add "face_" prefix

            # Make sure the output directory exists
            output_path.parent.mkdir(parents=True, exist_ok=True)

            # Save the processed image
            cv2.imwrite(str(output_path), processed_image)
            processed_images += 1

        # Show progress
        #print(f"Processed {processed_images}/{total_images} images", end='\r')



def main():
    parser = argparse.ArgumentParser(description='Process images in a folder.')
    parser.add_argument('--source_folder', required=True, help='The source folder with images to process.')
    parser.add_argument('--target_folder', help='The target folder to save processed images. If not provided, images are saved to the source folder.')
    args = parser.parse_args()

    process_images(args.source_folder, args.target_folder)


if __name__ == "__main__":
    main()
