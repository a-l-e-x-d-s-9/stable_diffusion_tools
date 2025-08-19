import os
import argparse
from concurrent.futures import ThreadPoolExecutor
from PIL import Image, UnidentifiedImageError, ImageOps
import threading
import shutil

# Try to enable HEIC/HEIF (and AVIF) support via pillow-heif
HEIF_AVAILABLE = False
try:
    from pillow_heif import register_heif_opener
    register_heif_opener()
    HEIF_AVAILABLE = True
except Exception:
    # We will proceed without HEIC support and print a hint once.
    pass

# Thread-safe counter
counter_lock = threading.Lock()
num_converted = 0
heif_hint_printed = False

# Known image extensions
image_extensions = {'.png', '.webp', '.jpg', '.jpeg'}
if HEIF_AVAILABLE:
    image_extensions.update({'.heic', '.heif', '.avif'})  # avif optional

def _save_as_jpeg(img: Image.Image, target_path: str, quality: int) -> None:
    # Respect EXIF orientation and convert to RGB for JPEG
    img = ImageOps.exif_transpose(img)
    img = img.convert('RGB')
    # Try to preserve EXIF if present
    exif = img.info.get('exif')
    save_kwargs = {'quality': quality, 'optimize': True}
    if exif:
        save_kwargs['exif'] = exif
    img.save(target_path, 'JPEG', **save_kwargs)

def process_file(args):
    source_path, target_path, quality = args
    ext = os.path.splitext(source_path)[1].lower()

    try:
        if ext in {'.jpg', '.jpeg'}:
            # If it's already JPEG, just copy
            shutil.copy2(source_path, target_path)
            return

        if ext in image_extensions:
            # Convert other image formats to JPEG
            img = Image.open(source_path)
            _save_as_jpeg(img, target_path, quality)
            global num_converted
            with counter_lock:
                num_converted += 1
                print(f'\rImages converted and copied: {num_converted}', end='')
            return

        # Non-image file, just copy
        shutil.copy2(source_path, target_path)

    except UnidentifiedImageError:
        # If Pillow cannot identify it as an image, copy as-is
        shutil.copy2(source_path, target_path)
        print(f'\nCopied non-image or unsupported image file: {source_path}')
    except OSError as e:
        # Typical case if HEIC support not installed
        global heif_hint_printed
        if (ext in {'.heic', '.heif', '.avif'}) and not HEIF_AVAILABLE and not heif_hint_printed:
            print('\nHEIC/HEIF support not available. Install with: pip install pillow-heif')
            heif_hint_printed = True
        print(f'\nFailed {source_path}: {e}')
    except Exception as e:
        print(f'\nFailed {source_path}: {e}')

def get_all_files(source_folder, target_folder, quality):
    all_files = []
    for root, dirs, files in os.walk(source_folder):
        for file in files:
            source_path = os.path.join(root, file)
            rel_path = os.path.relpath(source_path, source_folder)
            ext = os.path.splitext(source_path)[1].lower()

            if ext in image_extensions:
                if ext not in {'.jpg', '.jpeg'}:
                    base, _ = os.path.splitext(rel_path)
                    target_path = os.path.join(target_folder, base + '.jpg')
                else:
                    target_path = os.path.join(target_folder, rel_path)
            else:
                target_path = os.path.join(target_folder, rel_path)

            target_subfolder = os.path.dirname(target_path)
            os.makedirs(target_subfolder, exist_ok=True)

            # Skip if already exists
            if not os.path.exists(target_path):
                all_files.append((source_path, target_path, quality))
    return all_files

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--source-folder', required=True, help='The source directory')
    parser.add_argument('--target-folder', required=True, help='The target directory')
    parser.add_argument('--quality-level', required=True, type=int, help='JPEG compression quality, 1-95')
    args = parser.parse_args()

    if not HEIF_AVAILABLE:
        print('Note: HEIC/HEIF files will only be converted if pillow-heif is installed.')
        print('Install: pip install pillow-heif')

    all_files = get_all_files(args.source_folder, args.target_folder, args.quality_level)

    with ThreadPoolExecutor(max_workers=20) as executor:
        executor.map(process_file, all_files)

if __name__ == '__main__':
    main()
