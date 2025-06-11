import argparse
import os
import shutil
from PIL import Image
import numpy as np
from tqdm import tqdm
from scipy.interpolate import interp1d

def parse_curve_string(curve_str):
    points = []
    for pair in curve_str.split(','):
        x, y = map(int, pair.split(':'))
        points.append((x, y))
    return points

def build_lut(points):
    x, y = zip(*sorted(points))
    f = interp1d(x, y, kind='linear', bounds_error=False, fill_value=(y[0], y[-1]))
    lut = np.clip(f(np.arange(256)), 0, 255).astype(np.uint8)
    return lut

def apply_curve_to_image(img, luts, mode):
    arr = np.array(img)
    if arr.ndim == 2:  # grayscale
        arr = luts['all'][arr]
    elif arr.ndim == 3:
        if mode == 'all':
            arr = luts['all'][arr]
        elif mode == 'per_channel':
            for i, ch in enumerate(['r', 'g', 'b']):
                arr[..., i] = luts[ch][arr[..., i]]
    return Image.fromarray(arr)

def is_image_file(filename):
    ext = os.path.splitext(filename)[1].lower()
    return ext in ['.jpg', '.jpeg', '.png', '.bmp', '.webp']

def process_images(src, dst, luts, mode):
    image_paths = []
    for root, _, files in os.walk(src):
        for name in files:
            if is_image_file(name):
                full_path = os.path.join(root, name)
                image_paths.append(full_path)

    with tqdm(total=len(image_paths), desc="Processing images") as pbar:
        for path in image_paths:
            rel_path = os.path.relpath(path, src)
            target_path = os.path.join(dst, rel_path)
            os.makedirs(os.path.dirname(target_path), exist_ok=True)

            try:
                img = Image.open(path).convert("RGB")
                img = apply_curve_to_image(img, luts, mode)
                img.save(target_path)
            except Exception as e:
                print(f"Error processing {path}: {e}")

            pbar.update(1)

def main():
    parser = argparse.ArgumentParser(description="Apply color curves to images.")
    parser.add_argument("--source", required=True, help="Source folder (recursive)")
    parser.add_argument("--target", required=True, help="Target folder")
    parser.add_argument("--mode", choices=["all", "per_channel"], default="all",
                        help="Apply curve to all channels or per RGB channel")
    parser.add_argument("--curve", help="Curve for all channels, e.g. 0:0,62:42,255:255")
    parser.add_argument("--curve_r", help="Red channel curve (per_channel mode only)")
    parser.add_argument("--curve_g", help="Green channel curve (per_channel mode only)")
    parser.add_argument("--curve_b", help="Blue channel curve (per_channel mode only)")

    args = parser.parse_args()

    luts = {}

    if args.mode == 'all':
        if not args.curve:
            parser.error("--curve is required for mode=all")
        luts['all'] = build_lut(parse_curve_string(args.curve))

    elif args.mode == 'per_channel':
        for ch in ['r', 'g', 'b']:
            curve_arg = getattr(args, f"curve_{ch}")
            if not curve_arg:
                parser.error(f"--curve_{ch} is required for mode=per_channel")
            luts[ch] = build_lut(parse_curve_string(curve_arg))

    process_images(args.source, args.target, luts, args.mode)

if __name__ == "__main__":
    main()