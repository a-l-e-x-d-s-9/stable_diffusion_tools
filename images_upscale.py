#!/usr/bin/env python3
"""
Batch upscale images in a folder to a target maximum long-side resolution.

Designed for mixed .pth super-resolution models such as ESRGAN, RealESRGAN,
SwinIR, BSRGAN, UltraSharp, AnimeSharp, etc. It uses spandrel so you do not
need to hard-code the architecture for each model.

Features:
- Uses CUDA when available.
- Keeps aspect ratio and targets the longest side.
- Repeats upscale passes when the source image is very small.
- Supports optional blend mode with two upscalers.
- Supports tiled inference to reduce VRAM usage.
- Processes folders recursively and preserves folder structure.

Install:
  pip install torch torchvision pillow opencv-python tqdm spandrel spandrel-extra-arches

Examples:

Single upscaler:
  python3 images_upscale.py \
    --source_folder /path/input \
    --target_folder /path/output \
    --target_size 2048 \
    --upscaler_dir /path/upscalers \
    --upscaler 4x-UltraSharp.pth \
    --device cuda --half \
    --tile 512 --tile_pad 32 \
    --workers 4

Blend mode with two upscalers:
  python3 images_upscale.py \
    --source_folder /path/input \
    --target_folder /path/output \
    --target_size 2048 \
    --upscaler_dir /path/upscalers \
    --upscaler 4x_RealisticRescaler_100000_G.pth \
    --upscaler2_dir /path/upscalers \
    --upscaler2 4x-UltraSharp.pth \
    --blend 0.25 \
    --device cuda --half \
    --tile 512 --tile_pad 32 \
    --workers 4
"""

from __future__ import annotations

import argparse
import concurrent.futures as futures
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Optional, Tuple
import threading

import cv2
import numpy as np
import torch
from tqdm import tqdm

try:
    from spandrel import ModelLoader
except Exception as e:
    raise SystemExit(
        "Missing dependency: spandrel. Install with:\n"
        "  pip install spandrel spandrel-extra-arches\n"
        f"Original error: {e}"
    )

try:
    import spandrel_extra_arches
    spandrel_extra_arches.install()
except Exception:
    pass

IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tif", ".tiff"}


@dataclass(frozen=True)
class Job:
    src: Path
    dst: Path


def imread_any(path: Path) -> Optional[np.ndarray]:
    data = np.fromfile(str(path), dtype=np.uint8)
    if data.size == 0:
        return None
    return cv2.imdecode(data, cv2.IMREAD_UNCHANGED)


def imwrite_any(path: Path, image: np.ndarray, jpeg_quality: int, webp_quality: int) -> bool:
    path.parent.mkdir(parents=True, exist_ok=True)
    ext = path.suffix.lower()
    params = []
    if ext in {".jpg", ".jpeg"}:
        params = [int(cv2.IMWRITE_JPEG_QUALITY), int(jpeg_quality)]
    elif ext == ".webp":
        params = [int(cv2.IMWRITE_WEBP_QUALITY), int(webp_quality)]
    ok, encoded = cv2.imencode(ext, image, params)
    if not ok:
        return False
    encoded.tofile(str(path))
    return True


def long_side_shape(width: int, height: int, target_long: int) -> Tuple[int, int]:
    if width <= 0 or height <= 0:
        return width, height
    scale = float(target_long) / float(max(width, height))
    return max(1, round(width * scale)), max(1, round(height * scale))


def resize_long_side(image: np.ndarray, target_long: int) -> np.ndarray:
    h, w = image.shape[:2]
    nw, nh = long_side_shape(w, h, target_long)
    if (nw, nh) == (w, h):
        return image
    interpolation = cv2.INTER_AREA if target_long < max(w, h) else cv2.INTER_LANCZOS4
    return cv2.resize(image, (nw, nh), interpolation=interpolation)


def resize_to_shape(image: np.ndarray, width: int, height: int) -> np.ndarray:
    h, w = image.shape[:2]
    if (w, h) == (width, height):
        return image
    interpolation = cv2.INTER_AREA if (width < w or height < h) else cv2.INTER_LANCZOS4
    return cv2.resize(image, (width, height), interpolation=interpolation)


def bgr_to_tensor(image_bgr: np.ndarray, device: torch.device, half: bool) -> torch.Tensor:
    rgb = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2RGB)
    arr = np.ascontiguousarray(rgb.transpose(2, 0, 1)).astype(np.float32) / 255.0
    t = torch.from_numpy(arr).unsqueeze(0).to(device=device, non_blocking=True)
    return t.half() if half else t


def tensor_to_bgr(t: torch.Tensor) -> np.ndarray:
    t = t.detach().float().clamp_(0, 1).squeeze(0).cpu().numpy()
    rgb = (t.transpose(1, 2, 0) * 255.0 + 0.5).astype(np.uint8)
    return cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)


def call_model(model, x: torch.Tensor) -> torch.Tensor:
    try:
        return model(x)
    except TypeError:
        return model.model(x)


def get_model_scale(model) -> int:
    scale = getattr(model, "scale", None)
    if scale is None and hasattr(model, "model"):
        scale = getattr(model.model, "scale", None)
    if scale is None:
        return 4
    if isinstance(scale, (tuple, list)):
        scale = scale[0]
    return int(scale)


@torch.inference_mode()
def upscale_tensor_tiled(model, x: torch.Tensor, scale: int, tile: int, tile_pad: int) -> torch.Tensor:
    if tile <= 0:
        return call_model(model, x)

    b, c, h, w = x.shape
    out = torch.empty((b, c, h * scale, w * scale), device=x.device, dtype=x.dtype)

    for y in range(0, h, tile):
        for x0 in range(0, w, tile):
            y0 = max(y - tile_pad, 0)
            x1 = max(x0 - tile_pad, 0)
            y2 = min(y + tile + tile_pad, h)
            x2 = min(x0 + tile + tile_pad, w)

            patch = x[:, :, y0:y2, x1:x2]
            out_patch = call_model(model, patch)

            crop_y0 = (y - y0) * scale
            crop_x0 = (x0 - x1) * scale
            crop_y2 = crop_y0 + min(tile, h - y) * scale
            crop_x2 = crop_x0 + min(tile, w - x0) * scale

            oy0 = y * scale
            ox0 = x0 * scale
            oy2 = oy0 + min(tile, h - y) * scale
            ox2 = ox0 + min(tile, w - x0) * scale

            out[:, :, oy0:oy2, ox0:ox2] = out_patch[:, :, crop_y0:crop_y2, crop_x0:crop_x2]

    return out


class Upscaler:
    def __init__(self, model_path: Path, device: str, half: bool, tile: int, tile_pad: int):
        self.model_path = model_path
        self.device = torch.device(device if device != "auto" else ("cuda" if torch.cuda.is_available() else "cpu"))
        self.half = bool(half and self.device.type == "cuda")
        self.tile = tile
        self.tile_pad = tile_pad

        if self.device.type == "cuda":
            torch.backends.cudnn.benchmark = True
            torch.set_float32_matmul_precision("high")

        desc = ModelLoader().load_from_file(str(model_path))
        self.model = desc.to(self.device).eval()
        if self.half:
            self.model = self.model.half()
        self.scale = get_model_scale(self.model)

    @torch.inference_mode()
    def upscale_bgr_once(self, image_bgr: np.ndarray) -> np.ndarray:
        t = bgr_to_tensor(image_bgr, self.device, self.half)
        out = upscale_tensor_tiled(self.model, t, self.scale, self.tile, self.tile_pad)
        result = tensor_to_bgr(out)
        del t, out
        if self.device.type == "cuda":
            torch.cuda.empty_cache()
        return result


class UpscalePipeline:
    def __init__(self, primary: Upscaler, secondary: Optional[Upscaler] = None, blend: float = 0.0):
        self.primary = primary
        self.secondary = secondary
        self.blend = float(blend)
        self.use_blend = self.secondary is not None and self.blend > 0.0

    def describe(self) -> str:
        if not self.use_blend:
            return f"single: {self.primary.model_path.name}"
        primary_w = 1.0 - self.blend
        secondary_w = self.blend
        return (
            f"blend: {self.primary.model_path.name} ({primary_w:.2f}) + "
            f"{self.secondary.model_path.name} ({secondary_w:.2f})"
        )

    def expected_scale(self) -> int:
        if not self.use_blend:
            return self.primary.scale
        return max(self.primary.scale, self.secondary.scale)

    def upscale_bgr_once(self, image_bgr: np.ndarray) -> np.ndarray:
        out1 = self.primary.upscale_bgr_once(image_bgr)
        if not self.use_blend:
            return out1

        out2 = self.secondary.upscale_bgr_once(image_bgr)
        target_h = max(out1.shape[0], out2.shape[0])
        target_w = max(out1.shape[1], out2.shape[1])
        out1 = resize_to_shape(out1, target_w, target_h)
        out2 = resize_to_shape(out2, target_w, target_h)
        blended = cv2.addWeighted(out1, 1.0 - self.blend, out2, self.blend, 0.0)
        return blended


def split_alpha(image: np.ndarray) -> Tuple[np.ndarray, Optional[np.ndarray]]:
    if image.ndim == 2:
        return cv2.cvtColor(image, cv2.COLOR_GRAY2BGR), None
    if image.shape[2] == 4:
        return image[:, :, :3], image[:, :, 3]
    return image[:, :, :3], None


def merge_alpha(bgr: np.ndarray, alpha: Optional[np.ndarray]) -> np.ndarray:
    if alpha is None:
        return bgr
    alpha_resized = cv2.resize(alpha, (bgr.shape[1], bgr.shape[0]), interpolation=cv2.INTER_LANCZOS4)
    return np.dstack([bgr, alpha_resized])


def process_image(
    job: Job,
    pipeline: UpscalePipeline,
    target_size: int,
    margin_px: int,
    no_downscale_large: bool,
    jpeg_quality: int,
    webp_quality: int,
    gpu_semaphore: threading.Semaphore,
) -> Tuple[Path, bool, str]:
    img = imread_any(job.src)
    if img is None:
        return job.src, False, "read failed"

    bgr, alpha = split_alpha(img)
    h, w = bgr.shape[:2]
    original_long = max(w, h)
    allowed_long = target_size + margin_px

    if original_long >= target_size:
        if no_downscale_large:
            final_bgr = bgr
        else:
            final_bgr = resize_long_side(bgr, target_size)
        final = merge_alpha(final_bgr, alpha)
        ok = imwrite_any(job.dst, final, jpeg_quality, webp_quality)
        return job.src, ok, "downscaled/copied" if ok else "write failed"

    current = bgr
    while max(current.shape[:2]) < target_size:
        with gpu_semaphore:
            current = pipeline.upscale_bgr_once(current)
        if max(current.shape[:2]) >= target_size:
            break

    if max(current.shape[:2]) > allowed_long:
        current = resize_long_side(current, target_size)

    final = merge_alpha(current, alpha)
    ok = imwrite_any(job.dst, final, jpeg_quality, webp_quality)
    return job.src, ok, "ok" if ok else "write failed"


def iter_images(source: Path, recursive: bool) -> Iterable[Path]:
    it = source.rglob("*") if recursive else source.glob("*")
    for p in it:
        if p.is_file() and p.suffix.lower() in IMAGE_EXTS and "/." not in p.as_posix():
            yield p


def resolve_model_path(path_value: Optional[str], dir_value: Optional[str], name_value: Optional[str], label: str) -> Optional[Path]:
    if path_value:
        p = Path(path_value).expanduser()
        if not p.is_file():
            raise SystemExit(f"{label} file not found: {p}")
        return p

    if dir_value or name_value:
        if not dir_value or not name_value:
            raise SystemExit(f"For {label}, use either --{label}_path or both --{label}_dir and --{label}")
        p = Path(dir_value).expanduser() / name_value
        if not p.is_file():
            raise SystemExit(f"{label} file not found: {p}")
        return p

    return None


def parse_margin(args: argparse.Namespace) -> int:
    if args.margin_px is not None:
        return max(0, int(args.margin_px))
    return max(0, round(args.target_size * (float(args.margin_percent) / 100.0)))


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Batch upscale images to a target long-side size.")
    parser.add_argument("--source_folder", required=True)
    parser.add_argument("--target_folder", required=True)
    parser.add_argument("--target_size", type=int, required=True, help="Target long side in pixels, e.g. 2048")

    parser.add_argument("--upscaler_path", help="Direct path to primary .pth/.safetensors upscaler")
    parser.add_argument("--upscaler_dir", help="Folder containing primary upscalers")
    parser.add_argument("--upscaler", help="Primary upscaler filename inside --upscaler_dir")

    parser.add_argument("--upscaler2_path", help="Direct path to secondary .pth/.safetensors upscaler for blend mode")
    parser.add_argument("--upscaler2_dir", help="Folder containing secondary upscalers")
    parser.add_argument("--upscaler2", help="Secondary upscaler filename inside --upscaler2_dir")
    parser.add_argument("--blend", type=float, default=0.0, help="Weight of secondary upscaler in blend mode. Range: 0.0 to 1.0")

    parser.add_argument("--margin_percent", type=float, default=10.0, help="Allowed overshoot percent. Default: 10")
    parser.add_argument("--margin_px", type=int, default=None, help="Allowed overshoot in pixels. Overrides --margin_percent")
    parser.add_argument("--device", default="auto", help="auto, cuda, cuda:0, cpu")
    parser.add_argument("--half", action="store_true", help="Use fp16 on CUDA. Faster/lower VRAM for most models")
    parser.add_argument("--tile", type=int, default=512, help="Tile size. Lower if VRAM errors. 0 disables tiling")
    parser.add_argument("--tile_pad", type=int, default=32)
    parser.add_argument("--workers", type=int, default=4, help="Total worker threads for reading, writing, and job scheduling")
    parser.add_argument("--gpu_jobs", type=int, default=1, help="How many images may run through the GPU at the same time. Default: 1. Try 2 only if you have enough VRAM")
    parser.add_argument("--recursive", action="store_true", default=True)
    parser.add_argument("--no_recursive", action="store_false", dest="recursive")
    parser.add_argument("--overwrite", action="store_true")
    parser.add_argument("--no_downscale_large", action="store_true", help="Do not resize images already >= target_size")
    parser.add_argument("--output_ext", default="same", choices=["same", "png", "jpg", "webp"])
    parser.add_argument("--jpeg_quality", type=int, default=95)
    parser.add_argument("--webp_quality", type=int, default=95)
    return parser


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()

    if not (0.0 <= float(args.blend) <= 1.0):
        raise SystemExit("--blend must be between 0.0 and 1.0")

    source = Path(args.source_folder).expanduser().resolve()
    target = Path(args.target_folder).expanduser().resolve()
    if not source.is_dir():
        raise SystemExit(f"Source folder not found: {source}")

    primary_path = resolve_model_path(args.upscaler_path, args.upscaler_dir, args.upscaler, "upscaler")
    if primary_path is None:
        raise SystemExit("Use either --upscaler_path, or both --upscaler_dir and --upscaler")

    secondary_path = resolve_model_path(args.upscaler2_path, args.upscaler2_dir, args.upscaler2, "upscaler2")
    if args.blend > 0.0 and secondary_path is None:
        raise SystemExit("Blend mode requires a secondary upscaler via --upscaler2_path or --upscaler2_dir + --upscaler2")
    if args.blend == 0.0 and secondary_path is not None:
        print("Warning: secondary upscaler was provided, but --blend is 0. Using primary upscaler only.")

    margin_px = parse_margin(args)

    print(f"Loading primary model: {primary_path}")
    primary = Upscaler(primary_path, args.device, args.half, args.tile, args.tile_pad)

    secondary = None
    if secondary_path is not None and args.blend > 0.0:
        print(f"Loading secondary model: {secondary_path}")
        secondary = Upscaler(secondary_path, args.device, args.half, args.tile, args.tile_pad)

    pipeline = UpscalePipeline(primary, secondary, args.blend)
    print(f"Device: {primary.device}, half: {primary.half}")
    print(f"Pipeline: {pipeline.describe()}")
    if secondary is not None and args.blend > 0.0:
        print(f"Primary scale: {primary.scale}x, secondary scale: {secondary.scale}x, pipeline max scale: {pipeline.expected_scale()}x")
    else:
        print(f"Detected scale: {primary.scale}x")
    print(f"Target long side: {args.target_size}px, overshoot allowed: +{margin_px}px")
    print(f"Workers: {args.workers}, concurrent GPU jobs: {max(1, args.gpu_jobs)}")

    jobs = []
    for src in iter_images(source, args.recursive):
        rel = src.relative_to(source)
        ext = src.suffix if args.output_ext == "same" else "." + args.output_ext
        dst = (target / rel).with_suffix(ext)
        if dst.exists() and not args.overwrite:
            continue
        jobs.append(Job(src=src, dst=dst))

    if not jobs:
        print("No images to process.")
        return

    gpu_semaphore = threading.Semaphore(max(1, args.gpu_jobs))
    errors = []
    ok_count = 0

    with futures.ThreadPoolExecutor(max_workers=max(1, args.workers)) as ex:
        futs = [
            ex.submit(
                process_image,
                job,
                pipeline,
                args.target_size,
                margin_px,
                args.no_downscale_large,
                args.jpeg_quality,
                args.webp_quality,
                gpu_semaphore,
            )
            for job in jobs
        ]
        for fut in tqdm(futures.as_completed(futs), total=len(futs), desc="Upscaling"):
            src, ok, msg = fut.result()
            if ok:
                ok_count += 1
            else:
                errors.append((src, msg))

    print(f"Done. Saved: {ok_count}/{len(jobs)}")
    if errors:
        print("Errors:")
        for src, msg in errors[:50]:
            print(f"  {src}: {msg}")
        if len(errors) > 50:
            print(f"  ... and {len(errors) - 50} more")


if __name__ == "__main__":
    main()
