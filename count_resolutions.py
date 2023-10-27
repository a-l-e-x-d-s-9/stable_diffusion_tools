import os
from PIL import Image
from collections import defaultdict, Counter
import threading

# Thread-safe counter
class SafeCounter:
    def __init__(self):
        self.data = defaultdict(int)
        self.lock = threading.Lock()

    def increment(self, key):
        with self.lock:
            self.data[key] += 1

    def get_data(self):
        return dict(self.data)

def process_image(image_path, counter):
    try:
        with Image.open(image_path) as img:
            width, height = img.size
            counter.increment((width, height))
    except Exception as e:
        print(f"Error processing {image_path}: {e}")

def scan_folder(folder):
    # Find all image files in the directory and its subdirectories
    image_files = []
    for dirpath, _, filenames in os.walk(folder):
        for filename in filenames:
            if filename.lower().endswith(('.png', '.jpg', '.jpeg', '.bmp', '.gif', '.tiff')):
                image_files.append(os.path.join(dirpath, filename))

    counter = SafeCounter()
    threads = []

    # Create and start threads
    for i in range(8):
        thread_files = image_files[i::8]
        t = threading.Thread(target=lambda: [process_image(f, counter) for f in thread_files])
        t.start()
        threads.append(t)

    # Wait for all threads to finish
    for t in threads:
        t.join()

    # Process and display the results
    data = counter.get_data()
    if args.sort == "area":
        sorted_resolutions = sorted(data.keys(), key=lambda x: x[0] * x[1])
    else:  # sort by count
        sorted_resolutions = sorted(data.keys(), key=lambda x: data[x], reverse=True)

    max_len = max([len(f"{w}x{h}") for w, h in sorted_resolutions])

    for w, h in sorted_resolutions:
        print(f"{w}x{h:>{max_len-len(str(w))-1}}   [{data[(w, h)]:6}]")

if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="Scan a folder for images and count resolutions.")
    parser.add_argument("folder", help="Folder to scan for images.")
    parser.add_argument("-s", "--sort", choices=["area", "count"], default="area",
                        help="Sort by 'area' (default) or 'count'.")
    args = parser.parse_args()
    scan_folder(args.folder)
