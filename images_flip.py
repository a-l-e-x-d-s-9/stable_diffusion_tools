#!/usr/bin/env python3
"""Apply independent flips, followed by one probabilistic clockwise rotation."""

import argparse
import math
import os
from pathlib import Path
from random import random
import shutil
import sys

from PIL import Image, ImageOps


ROTATION_ANGLES = (0, 90, 180, 270)
DEFAULT_ROTATION_CHANCES = (1.0, 0.0, 0.0, 0.0)


def validate_rotation_chances(chances):
    if len(chances) != 4 or any(not 0 <= chance <= 1 for chance in chances):
        raise ValueError("Provide a probability between 0 and 1 for each rotation: 0, 90, 180, 270 degrees.")
    if not math.isclose(sum(chances), 1.0, rel_tol=0, abs_tol=1e-6):
        raise ValueError("Rotation probabilities must sum to 1 (100%).")


def choose_rotation(chances):
    """Choose one angle, using half-open cumulative probability intervals."""
    validate_rotation_chances(chances)
    draw = random() * sum(chances)
    cumulative = 0.0
    for angle, chance in zip(ROTATION_ANGLES, chances):
        cumulative += chance
        if draw < cumulative:
            return angle
    return next(angle for angle, chance in reversed(tuple(zip(ROTATION_ANGLES, chances))) if chance > 0)


def flip_image(image_path: str, h_flip_chance: float, v_flip_chance: float,
               make_copy: bool, rotation_chances=DEFAULT_ROTATION_CHANCES) -> bool:
    """Return whether transformed; unselected images are left byte-for-byte intact."""
    validate_rotation_chances(rotation_chances)
    if not 0 <= h_flip_chance <= 1 or not 0 <= v_flip_chance <= 1:
        raise ValueError("Flip probabilities must be between 0 and 1.")
    save_path = None
    try:
        horizontal = random() < h_flip_chance
        vertical = random() < v_flip_chance
        angle = choose_rotation(rotation_chances)
        if not (horizontal or vertical or angle):
            return False

        source = Path(image_path)
        with Image.open(source) as opened:
            img = ImageOps.exif_transpose(opened)
            if horizontal:
                img = img.transpose(Image.Transpose.FLIP_LEFT_RIGHT)
            if vertical:
                img = img.transpose(Image.Transpose.FLIP_TOP_BOTTOM)
            # Pillow's right-angle transpose is lossless in pixels and expands
            # dimensions automatically; its rotation names are counterclockwise.
            operation = {90: Image.Transpose.ROTATE_270, 180: Image.Transpose.ROTATE_180,
                         270: Image.Transpose.ROTATE_90}.get(angle)
            if operation is not None:
                img = img.transpose(operation)

            save_path = source
            if make_copy:
                index = 0
                while True:
                    suffix = "_f" if index == 0 else f"_f_{index}"
                    candidate = source.with_name(f"{source.stem}{suffix}{source.suffix}")
                    if not (candidate.exists() or candidate.is_symlink() or
                            candidate.with_suffix(".txt").exists() or candidate.with_suffix(".txt").is_symlink()):
                        save_path = candidate
                        break
                    index += 1

            if source.suffix.lower() in {".jpg", ".jpeg"} and img.mode not in {"RGB", "L"}:
                img = img.convert("RGB")
            img.save(save_path)
        if make_copy and source.with_suffix(".txt").is_file():
            shutil.copy2(source.with_suffix(".txt"), save_path.with_suffix(".txt"))
        return True
    except Exception as error:
        print(f"Error processing {image_path}: {error}", file=sys.stderr)
        try:
            if save_path is not None and save_path != Path(image_path):
                if save_path.is_file() and save_path.stat().st_size == 0:
                    save_path.unlink()
        except OSError:
            pass
        return False


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--folder_path', type=Path, required=True, help='Folder scanned recursively for images.')
    parser.add_argument('--h_flip_chance', type=float, default=0.0, help='Independent horizontal flip probability (0 to 1).')
    parser.add_argument('--v_flip_chance', type=float, default=0.0, help='Independent vertical flip probability (0 to 1).')
    parser.add_argument('--make_copy', action='store_true', help='Save transformed copies with an _f suffix; keep originals.')
    for angle, default in zip(ROTATION_ANGLES, DEFAULT_ROTATION_CHANCES):
        parser.add_argument(f'--rotation-{angle}-chance', f'--rotation_{angle}_chance',
                            dest=f'rotation_{angle}_chance', type=float, default=default,
                            help=f'Probability of {angle} degrees clockwise (default: {default:g}); all four must sum to 1.')
    return parser, parser.parse_args(argv)


def main(argv=None):
    parser, args = parse_args(argv)
    chances = tuple(getattr(args, f'rotation_{angle}_chance') for angle in ROTATION_ANGLES)
    try:
        validate_rotation_chances(chances)
        if not 0 <= args.h_flip_chance <= 1 or not 0 <= args.v_flip_chance <= 1:
            raise ValueError("Flip probabilities must be between 0 and 1.")
        if not args.folder_path.is_dir():
            raise ValueError(f"Not a folder: {args.folder_path}")
    except ValueError as error:
        parser.error(str(error))

    # Snapshot inputs before creating copies so new outputs are not processed.
    images = [Path(root) / name for root, _, files in os.walk(args.folder_path)
              for name in sorted(files) if Path(name).suffix.lower() in {'.png', '.jpg', '.jpeg', '.webp', '.bmp'}]
    transformed = 0
    for count, image in enumerate(images, 1):
        transformed += flip_image(str(image), args.h_flip_chance, args.v_flip_chance, args.make_copy, chances)
        print(f'\rProcessed {count}/{len(images)} images, transformed: {transformed}.', end='', flush=True)
    print('\nDone.')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
