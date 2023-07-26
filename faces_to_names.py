import os
import face_recognition
from PIL import Image
import argparse
import re
import numpy as np
from mtcnn import MTCNN


def recognize_faces(image_dir, known_faces_dir, unknown_faces_dir, min_face_width):
    min_face_area = min_face_width ** 2  # Squaring the minimum face width to get the minimum face area
    detector = MTCNN()
    # Load known faces
    known_faces = {}
    unknown_faces = []
    for directory, faces in [(known_faces_dir, known_faces)]:
        for filename in os.listdir(directory):
            if filename.endswith(".jpg") or filename.endswith(".png"):
                try:
                    # Ignore the number at the end of the filename
                    name = re.sub(r" \d+$", "", filename.rsplit(".", 1)[0])
                    img = face_recognition.load_image_file(os.path.join(directory, filename))
                    encodings = face_recognition.face_encodings(img)
                    for encoding in encodings:
                        if name in faces:
                            faces[name].append(encoding)
                        else:
                            faces[name] = [encoding]
                except Exception as e:
                    print(f"Error processing known face image {filename}: {str(e)}")
    # Process images
    for filename in os.listdir(image_dir):
        if filename.endswith(".jpg") or filename.endswith(".png"):
            try:
                # Skip if a text file for this image already exists and it says "No faces", "ignore", or does not contain "Unknown"
                txt_filename = f"{os.path.splitext(filename)[0]}.txt"
                txt_path = os.path.join(image_dir, txt_filename)
                if os.path.exists(txt_path):
                    with open(txt_path, "r") as f:
                        content = f.read().strip()
                        if content == "No faces" or content.lower() == "ignore":
                            continue
                        elif 0 < len(content):
                            continue
                        elif "Unknown" not in content:
                            pass

                print(f"Processing {filename}")
                img_path = os.path.join(image_dir, filename)
                img = face_recognition.load_image_file(img_path)
                encodings = face_recognition.face_encodings(img)
                face_locations = face_recognition.face_locations(img)
                if not faces:  # if no faces were detected
                    faces = detector.detect_faces(img)
                    # MTCNN returns a list of dictionaries, where each dictionary contains the bounding box and facial landmarks for one face
                    faces = [face['box'] for face in faces]  # extract just the bounding boxes

                faces = []
                for encoding, location in zip(encodings, face_locations):
                    top, right, bottom, left = location
                    width = right - left
                    height = bottom - top
                    # Ignore faces that are too small
                    if width * height < min_face_area:
                        continue
                    name = "Unknown"
                    for known_name, known_encodings in known_faces.items():
                        matches = face_recognition.compare_faces(known_encodings, encoding)
                        if True in matches:
                            name = known_name
                            break
                    faces.append((name, width * height, (top, right, bottom, left), encoding))
                # Sort faces by area, from largest to smallest
                faces.sort(key=lambda x: x[1], reverse=True)
                names = [face[0] for face in faces]
                if names:
                    # Write names to text file
                    with open(txt_path, "w") as f:
                        f.write(", ".join(names))
                    # Save unknown faces
                    for name, _, location, encoding in faces:
                        if name == "Unknown":
                            already_known = False
                            for unknown_encoding in unknown_faces:
                                match = face_recognition.compare_faces([unknown_encoding], encoding)
                                if match[0]:
                                    already_known = True
                                    break
                            if not already_known:
                                unknown_faces.append(encoding)
                                top, right, bottom, left = location
                                face_image = img[top:bottom, left:right]
                                pil_image = Image.fromarray(face_image)
                                pil_image.save(
                                    os.path.join(unknown_faces_dir, f"unknown_{os.path.splitext(filename)[0]}.png"))

                else:
                    # Write "No faces" to text file
                    with open(txt_path, "w") as f:
                        f.write("No faces")
            except Exception as e:
                print(f"Error processing image {filename}: {str(e)}")

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Recognize faces in images.")
    parser.add_argument("--image_dir", required=True, help="Directory with images.")
    parser.add_argument("--known_faces_dir", required=True, help="Directory with known faces.")
    parser.add_argument("--unknown_faces_dir", required=True, help="Directory to save unknown faces.")
    parser.add_argument("--min_face_width", required=True, type=int, help="Minimum face width for recognition.")
    args = parser.parse_args()
    recognize_faces(args.image_dir, args.known_faces_dir, args.unknown_faces_dir, args.min_face_width)

# Usage example:
# python faces_to_names.py --image_dir /path/to/images --known_faces_dir /path/to/known_faces --unknown_faces_dir /path/to/unknown_faces --min_face_width 70
