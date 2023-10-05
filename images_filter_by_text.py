import cv2
import pytesseract
import os
import argparse
from enum import Enum


class TextPosition(Enum):
    TOP_LEFT = 'Top-Left'
    TOP_CENTER = 'Top-Center'
    TOP_RIGHT = 'Top-Right'
    MIDDLE_LEFT = 'Middle-Left'
    MIDDLE_CENTER = 'Middle-Center'
    MIDDLE_RIGHT = 'Middle-Right'
    BOTTOM_LEFT = 'Bottom-Left'
    BOTTOM_CENTER = 'Bottom-Center'
    BOTTOM_RIGHT = 'Bottom-Right'


def get_text_position(image_path):
    image = cv2.imread(image_path)
    h, w, _ = image.shape

    d = pytesseract.image_to_data(image, output_type=pytesseract.Output.DICT)
    n_boxes = len(d['text'])
    # print(f"n_boxes: {n_boxes}")
    largest_area = 0
    largest_position = None

    for i in range(n_boxes):
        if int(d['conf'][i]) > 0:
            # print(f"i: {i}, conf: {d['conf'][i]}")
            (x, y, w_box, h_box) = (d['left'][i], d['top'][i], d['width'][i], d['height'][i])

            if h_box > 0.20 * h:
                continue

            area = w_box * h_box
            if area > largest_area:
                largest_area = area

                left_margin = x
                right_margin = w - (x + w_box)

                if abs(left_margin - right_margin) < 0.1 * w:
                    horz_pos = 'CENTER'
                elif left_margin > right_margin:
                    horz_pos = 'RIGHT'
                else:
                    horz_pos = 'LEFT'

                mid_y = y + (h_box / 2)
                # print(f"mid_y: {mid_y}")
                # print(f"x: {x}")
                # print(f"y: {y}")
                # print(f"w_box: {w_box}")
                # print(f"h_box: {h_box}")
                if mid_y > 0.66 * h:
                    vert_pos = 'BOTTOM'
                elif mid_y < 0.33 * h:
                    vert_pos = 'TOP'
                else:
                    vert_pos = 'MIDDLE'

                largest_position = TextPosition[f"{vert_pos}_{horz_pos}"]

    return largest_position


def process_folder(folder_path):
    # Ensure subfolders exist
    for position in TextPosition:
        subfolder = os.path.join(folder_path, position.value)
        if not os.path.exists(subfolder):
            os.makedirs(subfolder)

    for filename in os.listdir(folder_path):
        file_path = os.path.join(folder_path, filename)

        if os.path.isfile(file_path):
            position = get_text_position(file_path)

            if position:
                dest_folder = os.path.join(folder_path, position.value)
                dest_path = os.path.join(dest_folder, filename)
                os.rename(file_path, dest_path)
                print(f"Moved {filename} to {position.value}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Sort images in a folder based on text position.")
    parser.add_argument('--source_folder', required=True, help='Path to the folder containing images to process.')
    args = parser.parse_args()

    process_folder(args.source_folder)
