import cv2
import os
import argparse
from pathlib import Path
from tqdm import tqdm  # You need to install tqdm. If not installed, run: pip install tqdm
import concurrent.futures

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


def detect_and_zoom_to_face(image, min_size=512):
    face_cascade_front = cv2.CascadeClassifier(cv2.data.haarcascades + 'haarcascade_frontalface_default.xml')
    face_cascade_side = cv2.CascadeClassifier(cv2.data.haarcascades + 'haarcascade_profileface.xml')
    # eye_cascade = cv2.CascadeClassifier(cv2.data.haarcascades + 'haarcascade_eye.xml')

    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)

    processed_faces = []

    def filter_faces(faces):
        # Sort the faces by area (from largest to smallest)
        faces.sort(key=lambda bbox: bbox[2] * bbox[3], reverse=True)

        filtered_faces = []

        for new_face in faces:
            x1, y1, w1, h1 = new_face

            # Check if new_face overlaps with any face in filtered_faces
            for existing_face in filtered_faces:
                x2, y2, w2, h2 = existing_face

                # Calculate the overlap coordinates
                x_overlap = max(x1, x2)
                y_overlap = max(y1, y2)
                w_overlap = min(x1 + w1, x2 + w2) - x_overlap
                h_overlap = min(y1 + h1, y2 + h2) - y_overlap

                # If the overlap is not empty, there is an overlap
                if w_overlap > 0 and h_overlap > 0:
                    break
            else:
                # If we didn't break from the loop, there is no overlap
                filtered_faces.append(new_face)

        return filtered_faces

    def extract_faces(faces):
        is_debug = False
        extracted_faces = []

        for (x, y, w, h) in faces:
            expand_ratio = 1.8

            expanded_x = int(max(0, x - w * (expand_ratio - 1) // 2))
            expanded_y = int(max(0, y - h * (expand_ratio - 1) // 2))
            expanded_w = int(min(image.shape[1] - expanded_x, w * expand_ratio))
            expanded_h = int(min(image.shape[0] - expanded_y, h * expand_ratio))

            if is_debug:
                # Draw a rectangle and center dot on the original image
                cv2.rectangle(image, (x, y), (x + w, y + h), (0, 255, 0), 2)
                #cv2.circle(image, (x + w // 2, y + h // 2), radius=3, color=(0, 255, 0), thickness=-1)

            cropped_face = image[expanded_y:expanded_y + expanded_h, expanded_x:expanded_x + expanded_w]

            # eyes = eye_cascade.detectMultiScale(gray, scaleFactor=1.1, minNeighbors=7,
            #                                                     minSize=(int(min_size * 0.05), int(min_size * 0.05)))


            # print(f"face added: x:{x},y:{y},w:{w},h:{h}")

            # if 1 <= len(eyes):
            #    pass
            # else:
            # for (x, y, w, h) in eyes:
            #     cv2.rectangle(cropped_face, (x - expanded_x, y - expanded_y), (x + w - expanded_x, y + h - expanded_y), color=(0, 0, 255), thickness=2)

            extracted_faces.append(cropped_face)

        return extracted_faces  # return the original image as well for debugging

    faces_all = []
    faces_all.extend( face_cascade_front.detectMultiScale(gray, scaleFactor=1.1, minNeighbors=7,
                                                      minSize=(min_size, min_size)) )

    faces_all.extend( face_cascade_side.detectMultiScale(gray, scaleFactor=1.1, minNeighbors=7,
                                                    minSize=(int(min_size * 0.6), min_size)))

    filter_faces_list = filter_faces(faces_all)


    processed_faces = extract_faces(filter_faces_list)

    return processed_faces


import concurrent.futures

def process_single_image(image_path, source_folder_path, target_folder_path):
    # Open the image file
    image = cv2.imread(str(image_path))

    # Process the image
    processed_faces = detect_and_zoom_to_face(image)

    for i, processed_face in enumerate(processed_faces):
        if processed_face is not None:
            # Create the output path
            relative_path = image_path.relative_to(source_folder_path)
            output_path = target_folder_path / relative_path.with_stem(relative_path.stem + f"_face_{i}")  # add "_face_{i}" suffix and face index

            # Make sure the output directory exists
            output_path.parent.mkdir(parents=True, exist_ok=True)

            # Save the processed image
            cv2.imwrite(str(output_path), processed_face)

def process_images(source_folder, target_folder=None):
    source_folder_path = Path(source_folder)
    target_folder_path = Path(target_folder) if target_folder else source_folder_path

    # Prepare list of image paths, ignoring hidden files and directories
    image_paths = [p for p in source_folder_path.glob('**/*')
                   if ('/.' not in p.as_posix()
                       and p.suffix.lower() in ['.jpg', '.jpeg', '.png'])]

    total_images = len(image_paths)

    with concurrent.futures.ThreadPoolExecutor(max_workers=16) as executor:
        # The map function takes a function and an iterable and applies the function to every element in the iterable
        # Wrap tqdm around it to add a progress bar
        list(tqdm(executor.map(lambda image_path: process_single_image(image_path, source_folder_path, target_folder_path), image_paths), total=total_images))



def main():
    parser = argparse.ArgumentParser(description='Process images in a folder.')
    parser.add_argument('--source_folder', required=True, help='The source folder with images to process.')
    parser.add_argument('--target_folder', help='The target folder to save processed images. If not provided, images are saved to the source folder.')
    args = parser.parse_args()

    process_images(args.source_folder, args.target_folder)


if __name__ == "__main__":
    main()
