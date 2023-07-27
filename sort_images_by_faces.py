import os
import face_recognition
import shutil
import argparse
import re
import random
from concurrent.futures import ThreadPoolExecutor, as_completed
import threading
from tqdm import tqdm
from multiprocessing import Pool, cpu_count
from functools import partial

# def load_known_faces(known_faces_dir, num_samples):
#     known_faces = {}
#     for directory in os.listdir(known_faces_dir):
#         directory_path = os.path.join(known_faces_dir, directory)
#         if os.path.isdir(directory_path):
#             images = [f for f in os.listdir(directory_path) if f.endswith(('.png', '.jpg'))]
#             samples = random.sample(images, min(len(images), num_samples))
#             for filename in samples:
#                 img_path = os.path.join(directory_path, filename)
#                 print(f"Loading: {img_path}.")
#                 img = face_recognition.load_image_file(img_path)
#                 encodings = face_recognition.face_encodings(img)
#                 if len(encodings) > 0:
#                     if directory in known_faces:
#                         known_faces[directory].append(encodings[0])
#                     else:
#                         known_faces[directory] = [encodings[0]]
#     return known_faces, threading.Lock()

def load_known_faces_for_person(directory_path, num_samples):
    known_faces = {}
    images = [f for f in os.listdir(directory_path) if f.endswith(('.png', '.jpg'))]
    samples = random.sample(images, min(len(images), num_samples))
    for filename in samples:
        img_path = os.path.join(directory_path, filename)
        print(f"Loading: {img_path}.")
        img = face_recognition.load_image_file(img_path)
        encodings = face_recognition.face_encodings(img)
        if len(encodings) > 0:
            directory = os.path.basename(directory_path)
            if directory in known_faces:
                known_faces[directory].append(encodings[0])
            else:
                known_faces[directory] = [encodings[0]]
    return known_faces

def load_known_faces(known_faces_dir, num_samples):
    directories = [os.path.join(known_faces_dir, d) for d in os.listdir(known_faces_dir) if os.path.isdir(os.path.join(known_faces_dir, d))]
    with Pool(cpu_count()) as pool:
        results = pool.map(partial(load_known_faces_for_person, num_samples=num_samples), directories)
    known_faces = {k: v for result in results for k, v in result.items()}
    return known_faces, threading.Lock()

def sort_image(image_path, known_faces, known_faces_lock, sorted_dir):
    img = face_recognition.load_image_file(image_path)
    encodings = face_recognition.face_encodings(img)

    if len(encodings) > 0:
        for name, face_encodings in known_faces.items():
            matches = face_recognition.compare_faces(face_encodings, encodings[0])
            if True in matches:
                dest_dir = os.path.join(sorted_dir, name)
                os.makedirs(dest_dir, exist_ok=True)
                shutil.move(image_path, dest_dir)
                return

        with known_faces_lock:
            for name, face_encodings in known_faces.items():
                matches = face_recognition.compare_faces(face_encodings, encodings[0])
                if True in matches:
                    dest_dir = os.path.join(sorted_dir, name)
                    os.makedirs(dest_dir, exist_ok=True)
                    shutil.move(image_path, dest_dir)
                    return

            # If we get here, the face was not recognized
            unknown_dir = os.path.join(sorted_dir, 'unknown')
            os.makedirs(unknown_dir, exist_ok=True)
            unknown_faces = [f for f in os.listdir(unknown_dir) if os.path.isdir(os.path.join(unknown_dir, f))]
            new_dir = os.path.join(sorted_dir, f"unknown_{len(unknown_faces) + 1:03d}")
            os.makedirs(new_dir, exist_ok=True)
            shutil.move(image_path, new_dir)
            known_faces[new_dir.split('/')[-1]] = [encodings[0]]  # Update the known_faces dictionary
    else:
        # No faces found in the image
        no_face_dir = os.path.join(sorted_dir, 'no_face')
        os.makedirs(no_face_dir, exist_ok=True)
        shutil.move(image_path, no_face_dir)



def sort_images(unsorted_dir, sorted_dir, num_samples):
    print("Started scanning known faces.")
    known_faces, known_faces_lock = load_known_faces(sorted_dir, num_samples)
    print("Finished scanning known faces.")
    images = [os.path.join(unsorted_dir, f) for f in os.listdir(unsorted_dir) if f.endswith(('.png', '.jpg'))]
    futures = []
    with ThreadPoolExecutor(max_workers=1) as executor:
        for image_path in images:
            futures.append(executor.submit(sort_image, image_path, known_faces, known_faces_lock, sorted_dir))
        for future in tqdm(as_completed(futures), total=len(futures)):
            pass

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Sort images by face.")
    parser.add_argument("--unsorted_dir", required=True, help="Directory with images to sort.")
    parser.add_argument("--sorted_dir", required=True, help="Directory to save sorted images.")
    parser.add_argument("--num_samples", required=False, type=int, default=5, help="Number of samples to use for each known person.")
    args = parser.parse_args()
    sort_images(args.unsorted_dir, args.sorted_dir, args.num_samples)


# python sort_images_by_faces.py --unsorted_dir /path/to/unsorted --sorted_dir /path/to/sorted --num_samples 5