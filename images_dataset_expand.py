#!/usr/bin/env python3
"""
augment_dataset_to_target.py

Expand a small image dataset by generating randomized augmentations until the
output folder reaches a target number of images.

Sizing behavior:
- Default: preserve each source image width/height (after EXIF transpose).
- Optional: force exact output size via --width and --height (must provide both).
- Optional: apply min/max constraints (aspect-preserving scaling) via:
  --min-width/--min-height/--max-width/--max-height

Key behavior:
- Scans input folder recursively (no symlink following).
- Counts images in output folder; generates more until output count >= target.
- Random augmentations (configurable): crop jitter, rotate, flip, color jitter,
  blur/sharpen, gaussian noise.
- Optionally copies caption sidecars (*.txt) for each augmented image.
- Optionally writes metadata.jsonl.

Dependencies:
- Pillow (PIL): pip install pillow
"""

from __future__ import annotations

import argparse
import json
import os
import random
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Optional, Tuple
import math

from PIL import Image, ImageEnhance, ImageFilter, ImageOps


IMAGE_EXTS_DEFAULT = {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tif", ".tiff"}


@dataclass
class AugConfig:
    # Crop jitter: random crop then resize back to base size (preserves dims)
    crop_jitter_prob: float
    crop_min_scale: float
    crop_max_scale: float
    max_translate_frac: float

    # Rotation
    rotate_prob: float
    max_rotate_deg: float

    # Flip
    hflip_prob: float

    # Color jitter
    color_jitter_prob: float
    brightness_range: float
    contrast_range: float
    saturation_range: float

    # Blur / sharpen
    blur_prob: float
    blur_max_radius: float
    sharpen_prob: float
    sharpen_max_percent: int

    # Noise
    noise_prob: float
    noise_std_range: float  # as fraction of 255

    # Output
    out_format: str
    jpg_quality: int
    png_compress_level: int
    webp_quality: int

    # Metadata
    write_metadata_jsonl: bool


def _is_image_file(p: Path, exts: set[str]) -> bool:
    return p.is_file() and p.suffix.lower() in exts


def _walk_images(root: Path, exts: set[str]) -> List[Path]:
    files: List[Path] = []
    for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
        dpath = Path(dirpath)
        for fn in filenames:
            p = dpath / fn
            if _is_image_file(p, exts):
                files.append(p)
    files.sort()
    return files


def _count_images(root: Path, exts: set[str]) -> int:
    if not root.exists():
        return 0
    n = 0
    for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
        dpath = Path(dirpath)
        for fn in filenames:
            p = dpath / fn
            if _is_image_file(p, exts):
                n += 1
    return n


def _safe_open_image(path: Path) -> Image.Image:
    img = Image.open(path)
    img = ImageOps.exif_transpose(img)
    return img


def _to_rgb(img: Image.Image) -> Image.Image:
    # Convert to RGB robustly; if image has alpha, composite on white.
    if img.mode == "RGB":
        return img
    if img.mode in ("RGBA", "LA") or ("transparency" in img.info):
        rgba = img.convert("RGBA")
        bg = Image.new("RGBA", rgba.size, (255, 255, 255, 255))
        comp = Image.alpha_composite(bg, rgba).convert("RGB")
        return comp
    return img.convert("RGB")


def _rand_uniform(rng: random.Random, lo: float, hi: float) -> float:
    return lo + (hi - lo) * rng.random()


def _random_crop_jitter(
    img: Image.Image,
    rng: random.Random,
    cfg: AugConfig,
) -> Image.Image:
    w, h = img.size
    if w < 2 or h < 2:
        return img

    s = _rand_uniform(rng, cfg.crop_min_scale, cfg.crop_max_scale)
    s = max(0.10, min(1.0, s))

    crop_w = max(2, int(round(w * s)))
    crop_h = max(2, int(round(h * s)))

    max_shift = cfg.max_translate_frac * float(min(w, h))
    dx = _rand_uniform(rng, -max_shift, max_shift)
    dy = _rand_uniform(rng, -max_shift, max_shift)

    cx = (w / 2.0) + dx
    cy = (h / 2.0) + dy

    left = int(round(cx - crop_w / 2.0))
    top = int(round(cy - crop_h / 2.0))
    right = left + crop_w
    bottom = top + crop_h

    # Clamp
    if left < 0:
        right -= left
        left = 0
    if top < 0:
        bottom -= top
        top = 0
    if right > w:
        left -= (right - w)
        right = w
    if bottom > h:
        top -= (bottom - h)
        bottom = h

    left = max(0, left)
    top = max(0, top)
    right = min(w, right)
    bottom = min(h, bottom)

    if right - left < 2 or bottom - top < 2:
        return img

    return img.crop((left, top, right, bottom))


def _resize_exact(img: Image.Image, w: int, h: int) -> Image.Image:
    return img.resize((w, h), resample=Image.LANCZOS)


def _compute_scale_for_constraints(
    w: int,
    h: int,
    min_w: Optional[int],
    min_h: Optional[int],
    max_w: Optional[int],
    max_h: Optional[int],
) -> Tuple[float, float, float]:
    """
    Returns (s_final, s_min, s_max) where:
    - s_min is the minimum scale needed to satisfy mins (>= 1.0 if upscaling required)
    - s_max is the maximum allowed scale to satisfy maxes (<= 1.0 if downscaling required)
    - s_final is the chosen scale (must satisfy constraints if possible)
    """
    s_min = 1.0
    if min_w is not None:
        s_min = max(s_min, min_w / float(w))
    if min_h is not None:
        s_min = max(s_min, min_h / float(h))

    s_max = float("inf")
    if max_w is not None:
        s_max = min(s_max, max_w / float(w))
    if max_h is not None:
        s_max = min(s_max, max_h / float(h))

    if s_max == float("inf"):
        s_max = 1.0 if (max_w is None and max_h is None) else s_max

    # If no max constraints, treat s_max as large enough
    if (max_w is None) and (max_h is None):
        s_max = float("inf")

    # Pick scale
    if s_max == float("inf"):
        s_final = s_min
    else:
        if s_min > s_max:
            raise ValueError(
                f"Conflicting size constraints: need scale >= {s_min:.4f} to satisfy mins, "
                f"but scale must be <= {s_max:.4f} to satisfy maxes."
            )
        # Prefer preserving size when already within bounds
        if s_min <= 1.0 <= s_max:
            s_final = 1.0
        else:
            # If too small, upscale to s_min; if too large, downscale to s_max
            s_final = s_min if s_min > 1.0 else s_max

    return (s_final, s_min, s_max)


def _apply_constraints_keep_aspect(
    img: Image.Image,
    min_w: Optional[int],
    min_h: Optional[int],
    max_w: Optional[int],
    max_h: Optional[int],
) -> Image.Image:
    if min_w is None and min_h is None and max_w is None and max_h is None:
        return img

    w, h = img.size
    s_final, s_min, s_max = _compute_scale_for_constraints(w, h, min_w, min_h, max_w, max_h)

    if abs(s_final - 1.0) < 1e-9:
        return img

    new_w = max(1, int(round(w * s_final)))
    new_h = max(1, int(round(h * s_final)))
    return img.resize((new_w, new_h), resample=Image.LANCZOS)


def _maybe_copy_caption(src_path: Path, out_img_path: Path) -> None:
    src_txt = src_path.with_suffix(".txt")
    if not src_txt.exists() or not src_txt.is_file():
        return
    out_txt = out_img_path.with_suffix(".txt")
    try:
        out_txt.write_text(src_txt.read_text(encoding="utf-8", errors="replace"), encoding="utf-8")
    except Exception:
        pass

def _rotated_rect_with_max_area(w: int, h: int, angle_rad: float) -> Tuple[float, float]:
    """
    Compute width/height of the largest axis-aligned rectangle within a rotated w x h rectangle.
    Returns (crop_w, crop_h) in float pixels.
    Reference: common "max area rect in rotated rect" derivation used in image border-cropping.
    """
    if w <= 0 or h <= 0:
        return 0.0, 0.0

    angle = abs(angle_rad) % (math.pi / 2.0)
    if angle < 1e-12:
        return float(w), float(h)

    sin_a = abs(math.sin(angle))
    cos_a = abs(math.cos(angle))

    width_is_longer = w >= h
    side_long = float(w if width_is_longer else h)
    side_short = float(h if width_is_longer else w)

    # "Half constrained" case
    if side_short <= 2.0 * sin_a * cos_a * side_long or abs(sin_a - cos_a) < 1e-12:
        x = 0.5 * side_short
        if width_is_longer:
            crop_w = x / sin_a
            crop_h = x / cos_a
        else:
            crop_w = x / cos_a
            crop_h = x / sin_a
    else:
        cos_2a = (cos_a * cos_a) - (sin_a * sin_a)
        crop_w = (w * cos_a - h * sin_a) / cos_2a
        crop_h = (h * cos_a - w * sin_a) / cos_2a

    return abs(float(crop_w)), abs(float(crop_h))


def _center_crop(img: Image.Image, crop_w: int, crop_h: int) -> Image.Image:
    w, h = img.size
    crop_w = max(1, min(w, crop_w))
    crop_h = max(1, min(h, crop_h))
    left = int(round((w - crop_w) / 2.0))
    top = int(round((h - crop_h) / 2.0))
    return img.crop((left, top, left + crop_w, top + crop_h))


def _save_image(img: Image.Image, out_path: Path, cfg: AugConfig) -> None:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    fmt = cfg.out_format.lower()

    if fmt in ("jpg", "jpeg"):
        img.save(out_path, format="JPEG", quality=cfg.jpg_quality, optimize=True, subsampling=0)
    elif fmt == "png":
        img.save(out_path, format="PNG", compress_level=cfg.png_compress_level, optimize=True)
    elif fmt == "webp":
        img.save(out_path, format="WEBP", quality=cfg.webp_quality, method=6)
    else:
        raise ValueError(f"Unsupported out format: {cfg.out_format}")


def _pick_output_name(
    rng: random.Random,
    src_path: Path,
    out_ext: str,
    out_dir: Path,
    counter: int,
) -> Path:
    suffix = f"{rng.getrandbits(32):08x}"
    name = f"{src_path.stem}__aug_{counter:08d}_{suffix}{out_ext}"
    return out_dir / name


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="Expand a dataset by generating randomized augmentations until output reaches a target image count."
    )
    p.add_argument("--input", required=True, help="Input dataset folder (scanned recursively).")
    p.add_argument("--output", required=True, help="Output folder for augmented images.")
    p.add_argument("--target-count", type=int, required=True, help="Target number of images to have in output folder.")

    # Sizing: preserve by default
    p.add_argument("--width", type=int, default=None, help="Optional: force exact output width (requires --height).")
    p.add_argument("--height", type=int, default=None, help="Optional: force exact output height (requires --width).")

    p.add_argument("--min-width", type=int, default=None, help="Optional: minimum output width (aspect-preserving).")
    p.add_argument("--min-height", type=int, default=None, help="Optional: minimum output height (aspect-preserving).")
    p.add_argument("--max-width", type=int, default=None, help="Optional: maximum output width (aspect-preserving).")
    p.add_argument("--max-height", type=int, default=None, help="Optional: maximum output height (aspect-preserving).")

    p.add_argument("--seed", type=int, default=0, help="RNG seed (0 is valid).")

    p.add_argument(
        "--ignore-existing",
        action="store_true",
        help="Ignore existing images in output; generate exactly --target-count new images.",
    )

    p.add_argument("--overwrite", action="store_true", help="Allow overwriting output filenames if collision occurs.")
    p.add_argument("--exts", default=",".join(sorted(IMAGE_EXTS_DEFAULT)),
                   help="Comma-separated input image extensions (default common formats).")

    p.add_argument("--out-format", default="jpg", choices=["jpg", "png", "webp"], help="Output image format.")
    p.add_argument("--jpg-quality", type=int, default=95, help="JPEG quality (1-100).")
    p.add_argument("--png-compress-level", type=int, default=6, help="PNG compress level (0-9).")
    p.add_argument("--webp-quality", type=int, default=92, help="WEBP quality (1-100).")

    p.add_argument("--copy-captions", action="store_true",
                   help="If input has sidecar .txt captions, copy them to output with the new basename.")
    p.add_argument("--metadata-jsonl", action="store_true",
                   help="Write a metadata.jsonl file in output describing each augmentation.")

    # Augmentation knobs
    p.add_argument("--crop-jitter-prob", type=float, default=0.95)
    p.add_argument("--crop-min-scale", type=float, default=0.78)
    p.add_argument("--crop-max-scale", type=float, default=1.00)
    p.add_argument("--max-translate-frac", type=float, default=0.06)

    p.add_argument("--rotate-prob", type=float, default=0.40)
    p.add_argument("--max-rotate-deg", type=float, default=4.0)

    p.add_argument("--hflip-prob", type=float, default=0.50)

    p.add_argument("--color-jitter-prob", type=float, default=0.55)
    p.add_argument("--brightness-range", type=float, default=0.12)
    p.add_argument("--contrast-range", type=float, default=0.12)
    p.add_argument("--saturation-range", type=float, default=0.10)

    p.add_argument("--blur-prob", type=float, default=0.12)
    p.add_argument("--blur-max-radius", type=float, default=0.9)
    p.add_argument("--sharpen-prob", type=float, default=0.18)
    p.add_argument("--sharpen-max-percent", type=int, default=140)

    p.add_argument("--noise-prob", type=float, default=0.12)
    p.add_argument("--noise-std-range", type=float, default=0.02)

    p.add_argument("--progress-every", type=int, default=100, help="Print progress every N generated images.")
    p.add_argument("--max-errors", type=int, default=50, help="Abort if too many image failures happen.")
    return p.parse_args()


def main() -> int:
    args = parse_args()

    if (args.width is None) ^ (args.height is None):
        print("ERROR: If you set --width you must also set --height (and vice versa).", file=sys.stderr)
        return 2

    for k in ("min_width", "min_height", "max_width", "max_height"):
        v = getattr(args, k)
        if v is not None and v <= 0:
            print(f"ERROR: --{k.replace('_','-')} must be > 0", file=sys.stderr)
            return 2

    in_dir = Path(args.input).expanduser().resolve()
    out_dir = Path(args.output).expanduser().resolve()
    out_dir.mkdir(parents=True, exist_ok=True)

    exts = {e.strip().lower() for e in args.exts.split(",") if e.strip()}
    if not exts:
        exts = set(IMAGE_EXTS_DEFAULT)

    input_files = _walk_images(in_dir, exts)
    if not input_files:
        print(f"ERROR: No input images found in: {in_dir}", file=sys.stderr)
        return 2

    target = int(args.target_count)
    if target <= 0:
        print("ERROR: --target-count must be > 0", file=sys.stderr)
        return 2

    existing_out = _count_images(out_dir, IMAGE_EXTS_DEFAULT)
    start_count = 0 if args.ignore_existing else existing_out

    cfg = AugConfig(
        crop_jitter_prob=float(args.crop_jitter_prob),
        crop_min_scale=float(args.crop_min_scale),
        crop_max_scale=float(args.crop_max_scale),
        max_translate_frac=float(args.max_translate_frac),

        rotate_prob=float(args.rotate_prob),
        max_rotate_deg=float(args.max_rotate_deg),

        hflip_prob=float(args.hflip_prob),

        color_jitter_prob=float(args.color_jitter_prob),
        brightness_range=float(args.brightness_range),
        contrast_range=float(args.contrast_range),
        saturation_range=float(args.saturation_range),

        blur_prob=float(args.blur_prob),
        blur_max_radius=float(args.blur_max_radius),
        sharpen_prob=float(args.sharpen_prob),
        sharpen_max_percent=int(args.sharpen_max_percent),

        noise_prob=float(args.noise_prob),
        noise_std_range=float(args.noise_std_range),

        out_format=str(args.out_format),
        jpg_quality=int(args.jpg_quality),
        png_compress_level=int(args.png_compress_level),
        webp_quality=int(args.webp_quality),

        write_metadata_jsonl=bool(args.metadata_jsonl),
    )

    rng = random.Random(int(args.seed))

    out_ext = "." + args.out_format.lower().replace("jpeg", "jpg")

    meta_path = out_dir / "metadata.jsonl"
    meta_fh = meta_path.open("a", encoding="utf-8") if cfg.write_metadata_jsonl else None

    generated = 0
    errors = 0
    counter = _count_images(out_dir, IMAGE_EXTS_DEFAULT)

    t0 = time.time()

    print(f"Input images: {len(input_files)}")
    print(f"Output folder: {out_dir}")
    print(f"Existing output images (counted): {start_count}")
    print(f"Target output images: {target}")
    print(f"Seed: {args.seed}")
    if args.width is None:
        print("Sizing: preserve source width/height by default")
    else:
        print(f"Sizing: force exact {args.width}x{args.height}")
    if any(v is not None for v in (args.min_width, args.min_height, args.max_width, args.max_height)):
        print(
            f"Constraints: min=({args.min_width},{args.min_height}) "
            f"max=({args.max_width},{args.max_height}) (aspect-preserving)"
        )
    print("Generating...")

    try:
        while (start_count + generated) < target:
            src = input_files[rng.randrange(0, len(input_files))]

            try:
                img0 = _safe_open_image(src)
                img0 = _to_rgb(img0)

                base_w, base_h = img0.size
                if args.width is not None:
                    base_w, base_h = int(args.width), int(args.height)

                aug_ops: Dict[str, object] = {}
                img = img0

                # Crop jitter: crop then resize back to base size (keeps dims)
                if rng.random() < cfg.crop_jitter_prob:
                    img = _random_crop_jitter(img, rng, cfg)
                    img = _resize_exact(img, base_w, base_h)
                    aug_ops["crop_jitter"] = True
                    aug_ops["crop_min_scale"] = cfg.crop_min_scale
                    aug_ops["crop_max_scale"] = cfg.crop_max_scale
                    aug_ops["max_translate_frac"] = cfg.max_translate_frac
                else:
                    # If forcing exact size, still normalize to target
                    if args.width is not None:
                        img = _resize_exact(img, base_w, base_h)
                    aug_ops["crop_jitter"] = False

                # Rotate (preserves dims due to expand=False)
                # Rotate, then crop to remove white corners, then resize back to base size
                if rng.random() < cfg.rotate_prob and cfg.max_rotate_deg > 0:
                    deg = _rand_uniform(rng, -cfg.max_rotate_deg, cfg.max_rotate_deg)
                    angle_rad = math.radians(deg)

                    pre_w, pre_h = img.size

                    # Rotate with expand so we do not lose content before cropping
                    rotated = img.rotate(deg, resample=Image.BICUBIC, expand=True, fillcolor=(255, 255, 255))

                    crop_w_f, crop_h_f = _rotated_rect_with_max_area(pre_w, pre_h, angle_rad)
                    crop_w = int(round(crop_w_f))
                    crop_h = int(round(crop_h_f))

                    # Center-crop to remove triangles
                    if crop_w >= 2 and crop_h >= 2:
                        rotated = _center_crop(rotated, crop_w, crop_h)

                    # Keep dims stable (base_w/base_h already set to original size unless --width/--height is used)
                    img = _resize_exact(rotated, base_w, base_h)

                    aug_ops["rotate_deg"] = deg
                    aug_ops["rotate_crop_w"] = crop_w
                    aug_ops["rotate_crop_h"] = crop_h

                # Flip
                if rng.random() < cfg.hflip_prob:
                    img = ImageOps.mirror(img)
                    aug_ops["hflip"] = True

                # Color jitter
                if rng.random() < cfg.color_jitter_prob:
                    b = _rand_uniform(rng, 1.0 - cfg.brightness_range, 1.0 + cfg.brightness_range)
                    c = _rand_uniform(rng, 1.0 - cfg.contrast_range, 1.0 + cfg.contrast_range)
                    s = _rand_uniform(rng, 1.0 - cfg.saturation_range, 1.0 + cfg.saturation_range)
                    img = ImageEnhance.Brightness(img).enhance(b)
                    img = ImageEnhance.Contrast(img).enhance(c)
                    img = ImageEnhance.Color(img).enhance(s)
                    aug_ops["brightness"] = b
                    aug_ops["contrast"] = c
                    aug_ops["saturation"] = s

                # Blur/sharpen
                if cfg.blur_max_radius > 0 and rng.random() < cfg.blur_prob:
                    radius = _rand_uniform(rng, 0.1, cfg.blur_max_radius)
                    img = img.filter(ImageFilter.GaussianBlur(radius=radius))
                    aug_ops["blur_radius"] = radius

                if cfg.sharpen_max_percent > 0 and rng.random() < cfg.sharpen_prob:
                    percent = int(round(_rand_uniform(rng, 10.0, float(cfg.sharpen_max_percent))))
                    img = img.filter(ImageFilter.UnsharpMask(radius=1.0, percent=percent, threshold=3))
                    aug_ops["sharpen_percent"] = percent

                # Noise
                if cfg.noise_std_range > 0 and rng.random() < cfg.noise_prob:
                    std = _rand_uniform(rng, 0.0, cfg.noise_std_range) * 255.0
                    if std > 0.01:
                        w, h = img.size
                        px = img.load()
                        out = img.copy()
                        opx = out.load()
                        for y in range(h):
                            for x in range(w):
                                r, g, bch = px[x, y]
                                nr = int(round(r + rng.gauss(0.0, std)))
                                ng = int(round(g + rng.gauss(0.0, std)))
                                nb = int(round(bch + rng.gauss(0.0, std)))
                                opx[x, y] = (
                                    0 if nr < 0 else (255 if nr > 255 else nr),
                                    0 if ng < 0 else (255 if ng > 255 else ng),
                                    0 if nb < 0 else (255 if nb > 255 else nb),
                                )
                        img = out
                        aug_ops["noise_std"] = std

                # If not forcing exact size, apply optional constraints (aspect-preserving)
                if args.width is None:
                    img = _apply_constraints_keep_aspect(
                        img,
                        min_w=args.min_width,
                        min_h=args.min_height,
                        max_w=args.max_width,
                        max_h=args.max_height,
                    )

                counter += 1
                out_path = _pick_output_name(rng, src, out_ext, out_dir, counter)

                if out_path.exists() and not args.overwrite:
                    continue

                _save_image(img, out_path, cfg)

                if args.copy_captions:
                    _maybe_copy_caption(src, out_path)

                if meta_fh is not None:
                    record = {
                        "out": str(out_path.name),
                        "src": str(src),
                        "out_w": img.size[0],
                        "out_h": img.size[1],
                        "seed": int(args.seed),
                        "ops": aug_ops,
                        "ts": time.time(),
                    }
                    meta_fh.write(json.dumps(record, ensure_ascii=False) + "\n")
                    meta_fh.flush()

                generated += 1

                if args.progress_every > 0 and (generated % int(args.progress_every) == 0):
                    elapsed = time.time() - t0
                    rate = generated / elapsed if elapsed > 0 else 0.0
                    print(f"Generated {generated} (rate {rate:.2f} img/s)")

            except Exception as e:
                errors += 1
                if errors <= 5:
                    print(f"WARN: Failed on {src}: {e}", file=sys.stderr)
                if errors >= int(args.max_errors):
                    print(f"ERROR: Too many errors ({errors}). Aborting.", file=sys.stderr)
                    return 3

        elapsed = time.time() - t0
        final_count = _count_images(out_dir, IMAGE_EXTS_DEFAULT)
        print("Done.")
        print(f"Generated new images: {generated}")
        print(f"Output images now: {final_count}")
        if elapsed > 0:
            print(f"Elapsed: {elapsed:.2f}s, avg rate: {generated / elapsed:.2f} img/s")
        if cfg.write_metadata_jsonl:
            print(f"Metadata: {meta_path}")

        return 0

    finally:
        if meta_fh is not None:
            meta_fh.close()


if __name__ == "__main__":
    raise SystemExit(main())
