#!/usr/bin/env python3
"""
Expand a small image dataset by generating randomized augmentations until the
output folder reaches a target number of images.

Sizing behavior:
- Default: downscale very large source images to --source-max-dim first, then preserve that size.
- Optional: force exact output size via --width and --height (must provide both).
- Optional: disable source downscaling with --source-max-dim 0.
- Optional: apply min/max constraints (aspect-preserving scaling) via:
  --min-width/--min-height/--max-width/--max-height

Key behavior:
- Scans input folder recursively (no symlink following).
- Counts images in output folder; generates more until output count >= target.
- Random augmentations (configurable): crop jitter, rotate, flip, color jitter,
  blur/sharpen, gaussian noise, autocontrast, gamma jitter, JPEG quality jitter.
- Optionally copies caption sidecars (*.txt) for each augmented image.
- Optionally writes metadata.jsonl.
- Optional multi-process generation via --workers.

Dependencies:
- Required: Pillow (PIL): pip install pillow
- Optional speed-up for noise: numpy: pip install numpy
"""

from __future__ import annotations

import argparse
import json
import math
import os
import random
import shutil
import sys
import time
from concurrent.futures import FIRST_COMPLETED, ProcessPoolExecutor, wait
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Optional, Tuple

from PIL import Image, ImageEnhance, ImageFilter, ImageOps

try:
    import numpy as np  # type: ignore
except Exception:  # pragma: no cover - optional dependency
    np = None


IMAGE_EXTS_DEFAULT = {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tif", ".tiff"}


@dataclass(frozen=True)
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

    # Extra cheap augmentations
    autocontrast_prob: float
    gamma_jitter_prob: float
    gamma_range: float
    jpeg_reencode_prob: float
    jpeg_reencode_min_quality: int
    jpeg_reencode_max_quality: int

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


@dataclass(frozen=True)
class WorkItem:
    idx: int
    src: str
    out: str
    seed: int


class ProgressBar:
    def __init__(self, total: int, *, enabled: bool = True, width: int = 34) -> None:
        self.total = max(0, int(total))
        self.enabled = bool(enabled) and self.total > 0
        self.width = max(10, int(width))
        self.done = 0
        self.errors = 0
        self.t0 = time.time()
        self._last_len = 0
        self._last_draw = 0.0

    def update(self, step: int = 1, *, errors: int = 0, force: bool = False) -> None:
        self.done += int(step)
        self.errors += int(errors)
        if not self.enabled:
            return
        now = time.time()
        if not force and self.done < self.total and (now - self._last_draw) < 0.05:
            return
        self._last_draw = now
        elapsed = max(1e-9, now - self.t0)
        rate = self.done / elapsed
        frac = min(1.0, self.done / float(self.total))
        filled = int(round(self.width * frac))
        bar = "#" * filled + "-" * (self.width - filled)
        msg = (
            f"\r[{bar}] {self.done}/{self.total} "
            f"({frac * 100:5.1f}%) | {rate:5.2f} img/s | errors {self.errors}"
        )
        pad = " " * max(0, self._last_len - len(msg))
        print(msg + pad, end="", flush=True)
        self._last_len = len(msg)

    def finish(self) -> None:
        if self.enabled:
            self.update(0, force=True)
            print()


def _is_image_file(p: Path, exts: set[str]) -> bool:
    return p.is_file() and p.suffix.lower() in exts


def _walk_images(root: Path, exts: set[str]) -> List[Path]:
    files: List[Path] = []
    for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
        dirnames.sort()
        for fn in sorted(filenames):
            p = Path(dirpath) / fn
            if _is_image_file(p, exts):
                files.append(p)
    return files


def _count_images(root: Path, exts: set[str]) -> int:
    if not root.exists():
        return 0
    n = 0
    for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
        for fn in filenames:
            p = Path(dirpath) / fn
            if _is_image_file(p, exts):
                n += 1
    return n


def _safe_open_image(path: Path) -> Image.Image:
    with Image.open(path) as opened:
        img = ImageOps.exif_transpose(opened)
        return img.copy()


def _downscale_to_max_dim(img: Image.Image, max_dim: int) -> Tuple[Image.Image, bool]:
    """Downscale image so the largest dimension is max_dim. Use max_dim=0 to disable."""
    max_dim = int(max_dim)
    if max_dim <= 0:
        return img, False

    w, h = img.size
    largest = max(w, h)
    if largest <= max_dim:
        return img, False

    scale = max_dim / float(largest)
    new_w = max(1, int(round(w * scale)))
    new_h = max(1, int(round(h * scale)))
    return img.resize((new_w, new_h), resample=Image.LANCZOS), True


def _to_rgb(img: Image.Image) -> Image.Image:
    # Convert to RGB robustly; if image has alpha, composite on white.
    if img.mode == "RGB":
        return img
    if img.mode in ("RGBA", "LA") or ("transparency" in img.info):
        rgba = img.convert("RGBA")
        bg = Image.new("RGBA", rgba.size, (255, 255, 255, 255))
        return Image.alpha_composite(bg, rgba).convert("RGB")
    return img.convert("RGB")


def _rand_uniform(rng: random.Random, lo: float, hi: float) -> float:
    return lo + (hi - lo) * rng.random()


def _random_crop_jitter(img: Image.Image, rng: random.Random, cfg: AugConfig) -> Image.Image:
    w, h = img.size
    if w < 2 or h < 2:
        return img

    lo = min(cfg.crop_min_scale, cfg.crop_max_scale)
    hi = max(cfg.crop_min_scale, cfg.crop_max_scale)
    s = max(0.10, min(1.0, _rand_uniform(rng, lo, hi)))

    crop_w = max(2, int(round(w * s)))
    crop_h = max(2, int(round(h * s)))

    max_shift = max(0.0, cfg.max_translate_frac) * float(min(w, h))
    dx = _rand_uniform(rng, -max_shift, max_shift)
    dy = _rand_uniform(rng, -max_shift, max_shift)

    cx = (w / 2.0) + dx
    cy = (h / 2.0) + dy

    left = int(round(cx - crop_w / 2.0))
    top = int(round(cy - crop_h / 2.0))
    right = left + crop_w
    bottom = top + crop_h

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
    if img.size == (w, h):
        return img
    return img.resize((w, h), resample=Image.LANCZOS)


def _compute_scale_for_constraints(
    w: int,
    h: int,
    min_w: Optional[int],
    min_h: Optional[int],
    max_w: Optional[int],
    max_h: Optional[int],
) -> Tuple[float, float, float]:
    if w <= 0 or h <= 0:
        raise ValueError(f"Invalid image size: {w}x{h}")

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
        s_final = s_min
    else:
        if s_min > s_max:
            raise ValueError(
                f"Conflicting size constraints: need scale >= {s_min:.4f} to satisfy mins, "
                f"but scale must be <= {s_max:.4f} to satisfy maxes."
            )
        if s_min <= 1.0 <= s_max:
            s_final = 1.0
        else:
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
    s_final, _s_min, _s_max = _compute_scale_for_constraints(w, h, min_w, min_h, max_w, max_h)
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
        shutil.copy2(src_txt, out_txt)
    except Exception:
        try:
            out_txt.write_text(src_txt.read_text(encoding="utf-8", errors="replace"), encoding="utf-8")
        except Exception:
            pass


def _rotated_rect_with_max_area(w: int, h: int, angle_rad: float) -> Tuple[float, float]:
    """Compute width/height of the largest axis-aligned rectangle within a rotated w x h rectangle."""
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


def _apply_gamma_jitter(img: Image.Image, rng: random.Random, gamma_range: float) -> Tuple[Image.Image, float]:
    gamma_range = max(0.0, float(gamma_range))
    gamma = _rand_uniform(rng, 1.0 - gamma_range, 1.0 + gamma_range)
    gamma = max(0.05, gamma)
    inv = 1.0 / gamma
    lut = [max(0, min(255, int(round(((i / 255.0) ** inv) * 255.0)))) for i in range(256)]
    return img.point(lut * 3), gamma


def _apply_noise(img: Image.Image, rng: random.Random, std: float) -> Image.Image:
    if std <= 0.01:
        return img

    if np is not None:
        arr = np.asarray(img, dtype=np.int16)
        # Seed NumPy deterministically from the per-image RNG.
        nrng = np.random.default_rng(rng.getrandbits(63))
        noise = nrng.normal(0.0, std, arr.shape)
        out = np.clip(arr + noise, 0, 255).astype(np.uint8)
        return Image.fromarray(out)

    # Fallback without NumPy: still correct, but slower.
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
    return out


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


def _output_name(src_path: Path, out_ext: str, out_dir: Path, counter: int, seed: int) -> Path:
    # counter makes the name stable and easy to sort; seed suffix avoids collisions across reruns/workers.
    suffix = f"{seed & 0xffffffff:08x}"
    name = f"{src_path.stem}__aug_{counter:08d}_{suffix}{out_ext}"
    return out_dir / name


def _augment_and_save(
    item: WorkItem,
    cfg: AugConfig,
    width: Optional[int],
    height: Optional[int],
    min_width: Optional[int],
    min_height: Optional[int],
    max_width: Optional[int],
    max_height: Optional[int],
    copy_captions: bool,
    overwrite: bool,
    source_max_dim: int,
) -> Dict[str, object]:
    rng = random.Random(int(item.seed))
    src = Path(item.src)
    out_path = Path(item.out)

    if out_path.exists() and not overwrite:
        return {"ok": False, "error": "output_exists", "src": str(src), "out": str(out_path)}

    img0 = _safe_open_image(src)
    img0 = _to_rgb(img0)
    original_w, original_h = img0.size
    img0, was_source_downscaled = _downscale_to_max_dim(img0, int(source_max_dim))

    base_w, base_h = img0.size
    if width is not None and height is not None:
        base_w, base_h = int(width), int(height)

    aug_ops: Dict[str, object] = {}
    if was_source_downscaled:
        aug_ops["source_downscale"] = {
            "from_w": original_w,
            "from_h": original_h,
            "to_w": img0.size[0],
            "to_h": img0.size[1],
            "max_dim": int(source_max_dim),
        }
    img = img0

    if rng.random() < cfg.crop_jitter_prob:
        img = _random_crop_jitter(img, rng, cfg)
        img = _resize_exact(img, base_w, base_h)
        aug_ops["crop_jitter"] = True
        aug_ops["crop_min_scale"] = cfg.crop_min_scale
        aug_ops["crop_max_scale"] = cfg.crop_max_scale
        aug_ops["max_translate_frac"] = cfg.max_translate_frac
    else:
        if width is not None:
            img = _resize_exact(img, base_w, base_h)
        aug_ops["crop_jitter"] = False

    if rng.random() < cfg.rotate_prob and cfg.max_rotate_deg > 0:
        deg = _rand_uniform(rng, -cfg.max_rotate_deg, cfg.max_rotate_deg)
        angle_rad = math.radians(deg)
        pre_w, pre_h = img.size
        rotated = img.rotate(deg, resample=Image.BICUBIC, expand=True, fillcolor=(255, 255, 255))
        crop_w_f, crop_h_f = _rotated_rect_with_max_area(pre_w, pre_h, angle_rad)
        crop_w = int(round(crop_w_f))
        crop_h = int(round(crop_h_f))
        if crop_w >= 2 and crop_h >= 2:
            rotated = _center_crop(rotated, crop_w, crop_h)
        img = _resize_exact(rotated, base_w, base_h)
        aug_ops["rotate_deg"] = deg
        aug_ops["rotate_crop_w"] = crop_w
        aug_ops["rotate_crop_h"] = crop_h

    if rng.random() < cfg.hflip_prob:
        img = ImageOps.mirror(img)
        aug_ops["hflip"] = True

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

    if rng.random() < cfg.autocontrast_prob:
        img = ImageOps.autocontrast(img)
        aug_ops["autocontrast"] = True

    if rng.random() < cfg.gamma_jitter_prob and cfg.gamma_range > 0:
        img, gamma = _apply_gamma_jitter(img, rng, cfg.gamma_range)
        aug_ops["gamma"] = gamma

    if cfg.blur_max_radius > 0 and rng.random() < cfg.blur_prob:
        radius = _rand_uniform(rng, 0.1, cfg.blur_max_radius)
        img = img.filter(ImageFilter.GaussianBlur(radius=radius))
        aug_ops["blur_radius"] = radius

    if cfg.sharpen_max_percent > 0 and rng.random() < cfg.sharpen_prob:
        percent = int(round(_rand_uniform(rng, 10.0, float(cfg.sharpen_max_percent))))
        img = img.filter(ImageFilter.UnsharpMask(radius=1.0, percent=percent, threshold=3))
        aug_ops["sharpen_percent"] = percent

    if cfg.noise_std_range > 0 and rng.random() < cfg.noise_prob:
        std = _rand_uniform(rng, 0.0, cfg.noise_std_range) * 255.0
        img = _apply_noise(img, rng, std)
        aug_ops["noise_std"] = std

    if width is None:
        img = _apply_constraints_keep_aspect(img, min_width, min_height, max_width, max_height)

    # Fast extra augmentation: simulate recompression before the final save.
    # Kept disabled by default because it can slightly change detail texture.
    if rng.random() < cfg.jpeg_reencode_prob:
        from io import BytesIO

        q_min = min(cfg.jpeg_reencode_min_quality, cfg.jpeg_reencode_max_quality)
        q_max = max(cfg.jpeg_reencode_min_quality, cfg.jpeg_reencode_max_quality)
        q = rng.randint(max(1, q_min), min(100, q_max))
        buf = BytesIO()
        img.save(buf, format="JPEG", quality=q, optimize=False, subsampling=0)
        buf.seek(0)
        with Image.open(buf) as tmp:
            img = tmp.convert("RGB")
        aug_ops["jpeg_reencode_quality"] = q

    _save_image(img, out_path, cfg)

    if copy_captions:
        _maybe_copy_caption(src, out_path)

    return {
        "ok": True,
        "out": str(out_path.name),
        "src": str(src),
        "out_w": img.size[0],
        "out_h": img.size[1],
        "seed": int(item.seed),
        "ops": aug_ops,
        "ts": time.time(),
    }


def _prob_arg(name: str, value: float) -> Optional[str]:
    if not (0.0 <= value <= 1.0):
        return f"ERROR: --{name} must be between 0 and 1"
    return None


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="Expand a dataset by generating randomized augmentations until output reaches a target image count."
    )
    p.add_argument("--input", required=True, help="Input dataset folder (scanned recursively).")
    p.add_argument("--output", required=True, help="Output folder for augmented images.")
    p.add_argument("--target-count", type=int, required=True, help="Target number of images to have in output folder.")

    p.add_argument("--width", type=int, default=None, help="Optional: force exact output width (requires --height).")
    p.add_argument("--height", type=int, default=None, help="Optional: force exact output height (requires --width).")

    p.add_argument("--min-width", type=int, default=None, help="Optional: minimum output width (aspect-preserving).")
    p.add_argument("--min-height", type=int, default=None, help="Optional: minimum output height (aspect-preserving).")
    p.add_argument("--max-width", type=int, default=None, help="Optional: maximum output width (aspect-preserving).")
    p.add_argument("--max-height", type=int, default=None, help="Optional: maximum output height (aspect-preserving).")

    p.add_argument("--seed", type=int, default=0, help="RNG seed (0 is valid).")
    p.add_argument("--ignore-existing", action="store_true", help="Ignore existing images in output; generate exactly --target-count new images.")
    p.add_argument("--overwrite", action="store_true", help="Allow overwriting output filenames if collision occurs.")
    p.add_argument("--exts", default=",".join(sorted(IMAGE_EXTS_DEFAULT)), help="Comma-separated input image extensions.")

    p.add_argument("--source-max-dim", type=int, default=2560, help="Before augmentations, downscale source images whose largest dimension is above this value. Use 0 to disable.")

    p.add_argument("--workers", type=int, default=16, help="Parallel worker processes. Use 1 for deterministic single-process mode. Try 2-8 for speed.")
    p.add_argument("--jobs-buffer", type=int, default=0, help="Internal queued jobs. Default: workers * 4.")
    p.add_argument("--no-progress-bar", action="store_true", help="Disable the in-place progress bar.")

    p.add_argument("--out-format", default="jpg", choices=["jpg", "png", "webp"], help="Output image format.")
    p.add_argument("--jpg-quality", type=int, default=95, help="JPEG quality (1-100).")
    p.add_argument("--png-compress-level", type=int, default=6, help="PNG compress level (0-9).")
    p.add_argument("--webp-quality", type=int, default=92, help="WEBP quality (1-100).")

    p.add_argument("--copy-captions", action="store_true", help="Copy sidecar .txt captions to output with the new basename.")
    p.add_argument("--metadata-jsonl", action="store_true", help="Write metadata.jsonl in output describing each augmentation.")

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

    p.add_argument("--autocontrast-prob", type=float, default=0.0, help="Optional extra: fast autocontrast augmentation probability.")
    p.add_argument("--gamma-jitter-prob", type=float, default=0.0, help="Optional extra: gamma jitter probability.")
    p.add_argument("--gamma-range", type=float, default=0.08, help="Gamma jitter range around 1.0.")
    p.add_argument("--jpeg-reencode-prob", type=float, default=0.0, help="Optional extra: simulate JPEG recompression before final save.")
    p.add_argument("--jpeg-reencode-min-quality", type=int, default=82)
    p.add_argument("--jpeg-reencode-max-quality", type=int, default=96)

    p.add_argument("--blur-prob", type=float, default=0.12)
    p.add_argument("--blur-max-radius", type=float, default=0.9)
    p.add_argument("--sharpen-prob", type=float, default=0.18)
    p.add_argument("--sharpen-max-percent", type=int, default=140)

    p.add_argument("--noise-prob", type=float, default=0.12)
    p.add_argument("--noise-std-range", type=float, default=0.02)

    p.add_argument("--max-errors", type=int, default=50, help="Abort if too many image failures happen.")
    return p.parse_args()


def _validate_args(args: argparse.Namespace) -> Optional[str]:
    if (args.width is None) ^ (args.height is None):
        return "ERROR: If you set --width you must also set --height (and vice versa)."

    for k in ("width", "height", "min_width", "min_height", "max_width", "max_height"):
        v = getattr(args, k)
        if v is not None and v <= 0:
            return f"ERROR: --{k.replace('_', '-')} must be > 0"

    target = int(args.target_count)
    if target <= 0:
        return "ERROR: --target-count must be > 0"

    for name in (
        "crop_jitter_prob", "rotate_prob", "hflip_prob", "color_jitter_prob",
        "blur_prob", "sharpen_prob", "noise_prob", "autocontrast_prob",
        "gamma_jitter_prob", "jpeg_reencode_prob",
    ):
        err = _prob_arg(name.replace("_", "-"), float(getattr(args, name)))
        if err:
            return err

    if not (0.0 < float(args.crop_min_scale) <= 1.0):
        return "ERROR: --crop-min-scale must be > 0 and <= 1"
    if not (0.0 < float(args.crop_max_scale) <= 1.0):
        return "ERROR: --crop-max-scale must be > 0 and <= 1"
    if float(args.max_translate_frac) < 0:
        return "ERROR: --max-translate-frac must be >= 0"
    if int(args.jpg_quality) < 1 or int(args.jpg_quality) > 100:
        return "ERROR: --jpg-quality must be between 1 and 100"
    if int(args.webp_quality) < 1 or int(args.webp_quality) > 100:
        return "ERROR: --webp-quality must be between 1 and 100"
    if int(args.png_compress_level) < 0 or int(args.png_compress_level) > 9:
        return "ERROR: --png-compress-level must be between 0 and 9"
    if int(args.jpeg_reencode_min_quality) < 1 or int(args.jpeg_reencode_max_quality) > 100:
        return "ERROR: --jpeg-reencode quality bounds must be between 1 and 100"
    if int(args.source_max_dim) < 0:
        return "ERROR: --source-max-dim must be >= 0 (use 0 to disable)"
    if int(args.workers) < 1:
        return "ERROR: --workers must be >= 1"
    if int(args.max_errors) < 1:
        return "ERROR: --max-errors must be >= 1"
    return None


def _make_work_items(
    *,
    input_files: List[Path],
    out_dir: Path,
    out_ext: str,
    start_counter: int,
    needed: int,
    seed: int,
) -> List[WorkItem]:
    rng = random.Random(seed)
    items: List[WorkItem] = []
    for i in range(needed):
        src = input_files[rng.randrange(0, len(input_files))]
        per_image_seed = rng.getrandbits(63)
        counter = start_counter + i + 1
        out_path = _output_name(src, out_ext, out_dir, counter, per_image_seed)
        items.append(WorkItem(idx=i + 1, src=str(src), out=str(out_path), seed=per_image_seed))
    return items


def _write_meta(meta_fh, result: Dict[str, object], root_out_dir: Path) -> None:
    if meta_fh is None or not result.get("ok"):
        return
    record = {
        "out": result.get("out"),
        "src": result.get("src"),
        "out_w": result.get("out_w"),
        "out_h": result.get("out_h"),
        "seed": result.get("seed"),
        "ops": result.get("ops"),
        "ts": result.get("ts"),
    }
    meta_fh.write(json.dumps(record, ensure_ascii=False) + "\n")


def _run_single_process(
    items: List[WorkItem],
    cfg: AugConfig,
    args: argparse.Namespace,
    progress: ProgressBar,
    meta_fh,
) -> Tuple[int, int]:
    generated = 0
    errors = 0
    for item in items:
        try:
            result = _augment_and_save(
                item,
                cfg,
                args.width,
                args.height,
                args.min_width,
                args.min_height,
                args.max_width,
                args.max_height,
                bool(args.copy_captions),
                bool(args.overwrite),
                int(args.source_max_dim),
            )
            if result.get("ok"):
                generated += 1
                _write_meta(meta_fh, result, Path(args.output))
                progress.update(1)
            else:
                errors += 1
                progress.update(1, errors=1)
        except Exception as e:
            errors += 1
            progress.update(1, errors=1)
            if errors <= 5:
                print(f"\nWARN: Failed on {item.src}: {e}", file=sys.stderr)
            if errors >= int(args.max_errors):
                raise RuntimeError(f"Too many errors ({errors}). Aborting.")
    return generated, errors


def _run_multi_process(
    items: List[WorkItem],
    cfg: AugConfig,
    args: argparse.Namespace,
    progress: ProgressBar,
    meta_fh,
) -> Tuple[int, int]:
    generated = 0
    errors = 0
    workers = int(args.workers)
    jobs_buffer = int(args.jobs_buffer) if int(args.jobs_buffer) > 0 else workers * 4
    jobs_buffer = max(workers, jobs_buffer)

    def submit_one(pool: ProcessPoolExecutor, item: WorkItem):
        return pool.submit(
            _augment_and_save,
            item,
            cfg,
            args.width,
            args.height,
            args.min_width,
            args.min_height,
            args.max_width,
            args.max_height,
            bool(args.copy_captions),
            bool(args.overwrite),
            int(args.source_max_dim),
        )

    iterator = iter(items)
    pending = set()
    with ProcessPoolExecutor(max_workers=workers) as pool:
        for _ in range(min(jobs_buffer, len(items))):
            try:
                pending.add(submit_one(pool, next(iterator)))
            except StopIteration:
                break

        while pending:
            done, pending = wait(pending, return_when=FIRST_COMPLETED)
            for fut in done:
                try:
                    result = fut.result()
                    if result.get("ok"):
                        generated += 1
                        _write_meta(meta_fh, result, Path(args.output))
                        progress.update(1)
                    else:
                        errors += 1
                        progress.update(1, errors=1)
                except Exception as e:
                    errors += 1
                    progress.update(1, errors=1)
                    if errors <= 5:
                        print(f"\nWARN: Worker failed: {e}", file=sys.stderr)
                    if errors >= int(args.max_errors):
                        raise RuntimeError(f"Too many errors ({errors}). Aborting.")

                try:
                    pending.add(submit_one(pool, next(iterator)))
                except StopIteration:
                    pass

    return generated, errors


def main() -> int:
    args = parse_args()
    err = _validate_args(args)
    if err:
        print(err, file=sys.stderr)
        return 2

    in_dir = Path(args.input).expanduser().resolve()
    out_dir = Path(args.output).expanduser().resolve()
    out_dir.mkdir(parents=True, exist_ok=True)

    exts = {e.strip().lower() for e in str(args.exts).split(",") if e.strip()}
    if not exts:
        exts = set(IMAGE_EXTS_DEFAULT)
    exts = {e if e.startswith(".") else "." + e for e in exts}

    input_files = _walk_images(in_dir, exts)
    if not input_files:
        print(f"ERROR: No input images found in: {in_dir}", file=sys.stderr)
        return 2

    target = int(args.target_count)
    actual_existing_out = _count_images(out_dir, IMAGE_EXTS_DEFAULT)
    effective_start_count = 0 if args.ignore_existing else actual_existing_out
    needed = target - effective_start_count
    if needed <= 0:
        print(f"Input images: {len(input_files)}")
        print(f"Output folder: {out_dir}")
        print(f"Existing output images: {actual_existing_out}")
        print(f"Target output images: {target}")
        print("Nothing to do: output already reached target.")
        return 0

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
        autocontrast_prob=float(args.autocontrast_prob),
        gamma_jitter_prob=float(args.gamma_jitter_prob),
        gamma_range=float(args.gamma_range),
        jpeg_reencode_prob=float(args.jpeg_reencode_prob),
        jpeg_reencode_min_quality=int(args.jpeg_reencode_min_quality),
        jpeg_reencode_max_quality=int(args.jpeg_reencode_max_quality),
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

    out_ext = "." + args.out_format.lower().replace("jpeg", "jpg")
    start_counter = actual_existing_out
    items = _make_work_items(
        input_files=input_files,
        out_dir=out_dir,
        out_ext=out_ext,
        start_counter=start_counter,
        needed=needed,
        seed=int(args.seed),
    )

    meta_path = out_dir / "metadata.jsonl"
    meta_fh = meta_path.open("a", encoding="utf-8") if cfg.write_metadata_jsonl else None

    t0 = time.time()
    print(f"Input images: {len(input_files)}")
    print(f"Output folder: {out_dir}")
    print(f"Existing output images: {actual_existing_out}")
    if args.ignore_existing:
        print(f"Effective existing count: 0 (--ignore-existing enabled)")
    print(f"Target output images: {target}")
    print(f"Images to generate now: {needed}")
    print(f"Seed: {args.seed}")
    print(f"Workers: {args.workers}")
    print(f"NumPy noise acceleration: {'yes' if np is not None else 'no'}")
    if args.width is None:
        if int(args.source_max_dim) > 0:
            print(f"Sizing: preserve source size after source downscale max-dim {args.source_max_dim}")
        else:
            print("Sizing: preserve source width/height exactly (--source-max-dim 0)")
    else:
        print(f"Sizing: force exact {args.width}x{args.height} (source downscale max-dim {args.source_max_dim})")
    if any(v is not None for v in (args.min_width, args.min_height, args.max_width, args.max_height)):
        print(
            f"Constraints: min=({args.min_width},{args.min_height}) "
            f"max=({args.max_width},{args.max_height}) (aspect-preserving)"
        )
    print("Generating...")

    progress = ProgressBar(needed, enabled=not bool(args.no_progress_bar))

    try:
        if int(args.workers) == 1:
            generated, errors = _run_single_process(items, cfg, args, progress, meta_fh)
        else:
            generated, errors = _run_multi_process(items, cfg, args, progress, meta_fh)
        progress.finish()

        if meta_fh is not None:
            meta_fh.flush()

        elapsed = time.time() - t0
        final_count = _count_images(out_dir, IMAGE_EXTS_DEFAULT)
        print("Done.")
        print(f"Generated new images: {generated}")
        print(f"Errors: {errors}")
        print(f"Output images now: {final_count}")
        if elapsed > 0:
            print(f"Elapsed: {elapsed:.2f}s, avg rate: {generated / elapsed:.2f} img/s")
        if cfg.write_metadata_jsonl:
            print(f"Metadata: {meta_path}")
        return 0 if errors < int(args.max_errors) else 3
    except RuntimeError as e:
        progress.finish()
        print(f"ERROR: {e}", file=sys.stderr)
        return 3
    finally:
        if meta_fh is not None:
            meta_fh.close()


if __name__ == "__main__":
    raise SystemExit(main())
