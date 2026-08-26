#!/usr/bin/env python3
"""
dataset_denoiser.py

Conservative bulk denoising / de-JPEG preprocessing for AI training datasets.

Algorithms:
  - gaussian : mild Gaussian filtering, with optional temporary downsample/upscale
  - scunet   : SCUNet Real PSNR, optionally blended with the original
  - drunet   : DRUNet color denoiser with adjustable sigma
  - fbcnn    : FBCNN JPEG artifact removal, auto or fixed JPEG quality factor
  - blank    : exact file copy, no decoding/re-encoding

Default selection:
  gaussian=0.25, scunet=0.25, drunet=0.25, fbcnn=0.25, blank=0.0

Images are assigned independently in deterministic source-file order using the
configured seed, then processed in algorithm batches. Each neural model is loaded
for its complete batch and released before the next model is loaded.

Probability rules when any custom probability is supplied:
  1. Explicit values are fixed.
  2. blank defaults to 0 unless explicitly supplied.
  3. Remaining probability is split equally among unspecified algorithms.
  4. If explicit values total 1.0, unspecified algorithms become 0.
  5. Explicit values may not total more than 1.0.
  6. If all four algorithms are explicit and total < 1.0, set blank explicitly
     (or adjust the values) so the total reaches 1.0.

Examples:
  python dataset_denoiser.py --install

  python dataset_denoiser.py \
      --source ./sources --target ./cleaned

  python dataset_denoiser.py \
      --source ./sources --target ./cleaned \
      --layout flat \
      --prob scunet=0.50 --prob blank=0.10

  python dataset_denoiser.py --config settings.json

  python dataset_denoiser.py \
      --config settings.json \
      --drunet-sigma 6.0 \
      --prob fbcnn=0.40

CLI values override settings-file values.
Relative paths are resolved from the current working directory.
"""

from __future__ import annotations

import argparse
import csv
import gc
import hashlib
import json
import math
import os
import random
import secrets
import shutil
import subprocess
import sys
import tempfile
import time
from copy import deepcopy
from pathlib import Path
from typing import Any, Callable

SCRIPT_DIR = Path(__file__).resolve().parent

MODEL_INFO = {
    "scunet": {
        "filename": "scunet_color_real_psnr.pth",
        "url": "https://github.com/cszn/KAIR/releases/download/v1.0/scunet_color_real_psnr.pth",
        "expected_arch": "SCUNet",
    },
    "drunet": {
        "filename": "drunet_color.pth",
        "url": "https://github.com/cszn/KAIR/releases/download/v1.0/drunet_color.pth",
        "expected_arch": "DRUNet",
    },
    "fbcnn": {
        "filename": "fbcnn_color.pth",
        "url": "https://github.com/jiaxi-jiang/FBCNN/releases/download/v1.0/fbcnn_color.pth",
        "expected_arch": "FBCNN",
    },
}

ALGORITHMS = ("gaussian", "scunet", "drunet", "fbcnn")
ALL_CHOICES = ALGORITHMS + ("blank",)

# Assignment remains randomized in source-file order, but execution is grouped so
# only one neural model needs to occupy VRAM at a time.
PROCESSING_ORDER = ("blank", "gaussian", "scunet", "drunet", "fbcnn")

DEFAULTS: dict[str, Any] = {
    "source": None,
    "target": None,
    "layout": "preserve",             # preserve | flat
    "recursive": True,
    "extensions": [".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tif", ".tiff"],
    "seed": 12345,
    "device": "cuda",
    "models_dir": str(SCRIPT_DIR / "denoise_models"),
    "probabilities": {
        # None = unspecified. If all are None, defaults resolve to 0.25 each / blank 0.
        "gaussian": None,
        "scunet": None,
        "drunet": None,
        "fbcnn": None,
        "blank": None,
    },
    "gaussian": {
        # Conservative default. Set downsample_factor e.g. 0.90-0.95 to add
        # a temporary AREA downsample + bicubic return to original resolution.
        "sigma": 0.35,
        "downsample_factor": 1.0,
        "blend": 1.0,
    },
    "scunet": {
        # 0.75 = 75% SCUNet result + 25% original, deliberately conservative.
        "blend": 0.75,
    },
    "drunet": {
        # DRUNet noise sigma in 0..255 image units. 5-10 is mild.
        "sigma": 7.5,
        "blend": 1.0,
    },
    "fbcnn": {
        # "auto" uses FBCNN's own predicted JPEG quality.
        # Or set an integer 1..100.
        "quality": "auto",
        "blend": 0.85,
    },
    "inference": {
        # 0 = full image. On CUDA OOM, automatically retry with oom_tile_size.
        "tile_size": 0,
        "tile_overlap": 32,
        "oom_tile_size": 512,
        # fp32 is safest for dataset preparation.
        # fp16 is supported for SCUNet/FBCNN; DRUNet falls back to fp32.
        # bf16 is supported by all three through current Spandrel models.
        "precision": "fp32",           # fp32 | fp16 | bf16
    },
    "output": {
        # Processed images default to lossless PNG.
        # blank images are exact copies and keep their original format.
        "processed_format": "png",     # png | jpg | jpeg | webp | keep
        "png_compress_level": 4,
        "jpeg_quality": 98,
        "webp_quality": 100,
        "overwrite": False,
        "preserve_icc": True,
    },
    "manifest": {
        "enabled": True,
        "filename": "denoise_manifest.csv",
    },
    "fail_fast": False,
}


def eprint(*args: Any, **kwargs: Any) -> None:
    print(*args, file=sys.stderr, **kwargs)


def deep_merge(base: dict[str, Any], override: dict[str, Any]) -> dict[str, Any]:
    result = deepcopy(base)
    for key, value in override.items():
        if isinstance(value, dict) and isinstance(result.get(key), dict):
            result[key] = deep_merge(result[key], value)
        else:
            result[key] = value
    return result


def load_json_config(path: str | None) -> dict[str, Any]:
    if not path:
        return {}
    p = Path(path)
    with p.open("r", encoding="utf-8") as f:
        data = json.load(f)
    if not isinstance(data, dict):
        raise ValueError("Settings file must contain a JSON object at the top level.")
    return data


def write_example_config(path: Path) -> None:
    cfg = deepcopy(DEFAULTS)
    cfg["source"] = "./source"
    cfg["target"] = "./cleaned"
    cfg["models_dir"] = "./denoise_models"
    cfg["probabilities"] = {
        "gaussian": 0.25,
        "scunet": 0.25,
        "drunet": 0.25,
        "fbcnn": 0.25,
        "blank": 0.0,
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(cfg, indent=2) + "\n", encoding="utf-8")


def parse_prob_arg(items: list[str] | None) -> dict[str, float]:
    result: dict[str, float] = {}
    for item in items or []:
        if "=" not in item:
            raise ValueError(f"Invalid --prob '{item}'. Use NAME=VALUE, e.g. scunet=0.5")
        name, raw = item.split("=", 1)
        name = name.strip().lower()
        if name not in ALL_CHOICES:
            raise ValueError(
                f"Unknown probability name '{name}'. Choose: {', '.join(ALL_CHOICES)}"
            )
        try:
            value = float(raw)
        except ValueError as exc:
            raise ValueError(f"Invalid probability value in '{item}'.") from exc
        result[name] = value
    return result


def resolve_probabilities(raw: dict[str, Any]) -> dict[str, float]:
    vals = {name: raw.get(name, None) for name in ALL_CHOICES}

    # Completely untouched defaults.
    if all(vals[name] is None for name in ALL_CHOICES):
        return {
            "gaussian": 0.25,
            "scunet": 0.25,
            "drunet": 0.25,
            "fbcnn": 0.25,
            "blank": 0.0,
        }

    explicit_algorithms: dict[str, float] = {}
    for name in ALGORITHMS:
        if vals[name] is not None:
            v = float(vals[name])
            if not 0.0 <= v <= 1.0:
                raise ValueError(f"Probability {name}={v} is outside 0.0..1.0.")
            explicit_algorithms[name] = v

    blank_explicit = vals["blank"] is not None
    blank = float(vals["blank"]) if blank_explicit else 0.0
    if not 0.0 <= blank <= 1.0:
        raise ValueError(f"Probability blank={blank} is outside 0.0..1.0.")

    assigned = sum(explicit_algorithms.values()) + blank
    eps = 1e-9
    if assigned > 1.0 + eps:
        raise ValueError(
            f"Explicit probabilities total {assigned:.6f}, which is greater than 1.0."
        )

    unspecified = [name for name in ALGORITHMS if name not in explicit_algorithms]
    remainder = max(0.0, 1.0 - assigned)

    result = {name: explicit_algorithms.get(name, 0.0) for name in ALGORITHMS}
    result["blank"] = blank

    if unspecified:
        share = remainder / len(unspecified)
        for name in unspecified:
            result[name] = share
    elif remainder > eps:
        raise ValueError(
            "All four algorithm probabilities were explicitly supplied but they do not "
            "reach 1.0. Set blank explicitly to the remaining fraction, or adjust the "
            "algorithm probabilities."
        )

    # Remove tiny floating error and validate.
    total = sum(result.values())
    if abs(total - 1.0) > 1e-7:
        raise ValueError(f"Resolved probabilities total {total}, expected 1.0.")
    return result


def weighted_choice(rng: random.Random, probs: dict[str, float]) -> str:
    r = rng.random()
    acc = 0.0
    for name in ALL_CHOICES:
        acc += probs[name]
        if r < acc:
            return name
    return ALL_CHOICES[-1]  # floating-point guard


def install_dependencies() -> None:
    print("Installing Python dependencies into the currently active environment...")
    packages = [
        "spandrel==0.4.2",
        "Pillow>=10.0",
        "opencv-python-headless>=4.8",
        "requests>=2.31",
        "tqdm>=4.66",
    ]
    cmd = [sys.executable, "-m", "pip", "install", *packages]
    print(">", " ".join(cmd))
    subprocess.check_call(cmd)

    try:
        import torch
        print(f"PyTorch: {torch.__version__}")
        print(f"CUDA available: {torch.cuda.is_available()}")
        if torch.cuda.is_available():
            print(f"CUDA device: {torch.cuda.get_device_name(0)}")
        else:
            print(
                "WARNING: CUDA is not available in this Python environment. "
                "The script can run on CPU, but neural methods will be much slower."
            )
    except Exception as exc:
        print(f"WARNING: Could not verify PyTorch/CUDA: {exc}")


def download_file(url: str, destination: Path) -> None:
    import requests

    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.exists() and destination.stat().st_size > 1_000_000:
        print(f"Model already exists: {destination}")
        return

    tmp = destination.with_suffix(destination.suffix + ".part")
    print(f"Downloading {destination.name}...")
    with requests.get(
        url,
        stream=True,
        timeout=(20, 180),
        headers={"User-Agent": "dataset-denoiser/1.0"},
    ) as response:
        response.raise_for_status()
        total = int(response.headers.get("content-length", "0"))
        written = 0
        with tmp.open("wb") as f:
            for chunk in response.iter_content(chunk_size=1024 * 1024):
                if chunk:
                    f.write(chunk)
                    written += len(chunk)
                    if total:
                        print(
                            f"\r  {written / (1024**2):.1f} / {total / (1024**2):.1f} MiB",
                            end="",
                            flush=True,
                        )
    if total:
        print()
    if tmp.stat().st_size < 1_000_000:
        tmp.unlink(missing_ok=True)
        raise RuntimeError(
            f"Downloaded file for {destination.name} is unexpectedly small."
        )
    os.replace(tmp, destination)
    print(f"Saved: {destination}")


def download_models(models_dir: Path) -> None:
    for info in MODEL_INFO.values():
        download_file(info["url"], models_dir / info["filename"])


def verify_models(models_dir: Path) -> None:
    try:
        from spandrel import ModelLoader
    except Exception as exc:
        print(f"Could not import Spandrel for verification: {exc}")
        return

    print("Verifying model architecture detection...")
    for name, info in MODEL_INFO.items():
        path = models_dir / info["filename"]
        desc = ModelLoader().load_from_file(str(path))
        arch_name = getattr(getattr(desc, "architecture", None), "name", None)
        if arch_name is None:
            arch_name = getattr(getattr(desc, "architecture", None), "id", None)
        if arch_name is None:
            arch_name = str(getattr(desc, "architecture", "unknown"))
        print(f"  {name:8s}: {arch_name}")
        del desc


def normalize_extensions(values: list[str]) -> set[str]:
    out = set()
    for ext in values:
        ext = ext.lower().strip()
        if not ext.startswith("."):
            ext = "." + ext
        out.add(ext)
    return out


def list_images(source: Path, recursive: bool, extensions: set[str]) -> list[Path]:
    iterator = source.rglob("*") if recursive else source.glob("*")
    files = [p for p in iterator if p.is_file() and p.suffix.lower() in extensions]
    files.sort(key=lambda p: str(p.relative_to(source)).lower())
    return files


def ensure_source_target_safe(source: Path, target: Path) -> None:
    s = source.resolve()
    t = target.resolve()
    if s == t:
        raise ValueError("Source and target folders must be different.")
    try:
        t.relative_to(s)
    except ValueError:
        return
    raise ValueError(
        "Target folder may not be inside the source folder. This prevents old outputs "
        "from being picked up as new inputs on later runs."
    )


def choose_output_extension(source: Path, algorithm: str, processed_format: str) -> str:
    if algorithm == "blank":
        return source.suffix
    fmt = processed_format.lower()
    if fmt == "keep":
        return source.suffix
    if fmt == "jpeg":
        fmt = "jpg"
    return "." + fmt


def random_collision_path(path: Path, reserved: set[Path]) -> Path:
    candidate = path
    while candidate in reserved or candidate.exists():
        suffix = secrets.token_hex(4)
        candidate = path.with_name(f"{path.stem}_{suffix}{path.suffix}")
    return candidate


def plan_output_path(
    source_file: Path,
    source_root: Path,
    target_root: Path,
    algorithm: str,
    layout: str,
    processed_format: str,
    reserved: set[Path],
    overwrite: bool,
) -> tuple[Path, bool]:
    ext = choose_output_extension(source_file, algorithm, processed_format)
    if layout == "preserve":
        rel = source_file.relative_to(source_root)
        desired = (target_root / rel).with_suffix(ext)
    elif layout == "flat":
        desired = target_root / f"{source_file.stem}{ext}"
    else:
        raise ValueError("layout must be 'preserve' or 'flat'.")

    # A collision between two inputs in the same run must never overwrite one another.
    if desired in reserved:
        desired = random_collision_path(desired, reserved)
    elif desired.exists() and not overwrite:
        # In flat mode, name collisions are intentionally resolved with random suffixes.
        # In preserve mode, existing output is treated as resumable work and skipped.
        if layout == "flat":
            desired = random_collision_path(desired, reserved)
        else:
            return desired, True

    reserved.add(desired)
    return desired, False


def validate_config(cfg: dict[str, Any]) -> None:
    if cfg["layout"] not in ("preserve", "flat"):
        raise ValueError("layout must be 'preserve' or 'flat'.")

    g = cfg["gaussian"]
    if float(g["sigma"]) < 0:
        raise ValueError("gaussian.sigma must be >= 0.")
    ds = float(g["downsample_factor"])
    if not 0.1 <= ds <= 1.0:
        raise ValueError("gaussian.downsample_factor must be in 0.1..1.0.")
    for section, key in [
        ("gaussian", "blend"),
        ("scunet", "blend"),
        ("drunet", "blend"),
        ("fbcnn", "blend"),
    ]:
        v = float(cfg[section][key])
        if not 0.0 <= v <= 1.0:
            raise ValueError(f"{section}.{key} must be in 0.0..1.0.")

    sigma = float(cfg["drunet"]["sigma"])
    if not 0.0 <= sigma <= 255.0:
        raise ValueError("drunet.sigma must be in 0..255.")

    q = cfg["fbcnn"]["quality"]
    if isinstance(q, str) and q.lower() == "auto":
        pass
    else:
        q = int(q)
        if not 1 <= q <= 100:
            raise ValueError("fbcnn.quality must be 'auto' or an integer 1..100.")

    inf = cfg["inference"]
    tile = int(inf["tile_size"])
    overlap = int(inf["tile_overlap"])
    oom_tile = int(inf["oom_tile_size"])
    if tile < 0 or oom_tile < 0 or overlap < 0:
        raise ValueError("Tile sizes/overlap may not be negative.")
    for ts in (tile, oom_tile):
        if ts and overlap * 2 >= ts:
            raise ValueError("tile_overlap must be less than half the tile size.")
    if inf["precision"] not in ("fp32", "fp16", "bf16"):
        raise ValueError("inference.precision must be fp32, fp16, or bf16.")

    fmt = cfg["output"]["processed_format"].lower()
    if fmt not in ("png", "jpg", "jpeg", "webp", "keep"):
        raise ValueError("output.processed_format must be png/jpg/jpeg/webp/keep.")


def image_to_tensor(rgb):
    import numpy as np
    import torch

    arr = np.asarray(rgb, dtype=np.float32) / 255.0
    arr = np.ascontiguousarray(arr)
    return torch.from_numpy(arr).permute(2, 0, 1).unsqueeze(0)


def tensor_to_uint8(tensor):
    import numpy as np

    arr = (
        tensor.detach()
        .float()
        .clamp_(0.0, 1.0)
        .squeeze(0)
        .permute(1, 2, 0)
        .cpu()
        .numpy()
    )
    return np.clip(np.rint(arr * 255.0), 0, 255).astype(np.uint8)


def blend_tensors(original, processed, strength: float):
    if strength >= 1.0:
        return processed
    if strength <= 0.0:
        return original
    return original * (1.0 - strength) + processed * strength


def tile_starts(length: int, tile: int, overlap: int) -> list[int]:
    if tile <= 0 or length <= tile:
        return [0]
    stride = max(1, tile - overlap)
    starts = list(range(0, max(1, length - tile + 1), stride))
    last = length - tile
    if starts[-1] != last:
        starts.append(last)
    return starts


def feather_weight(h: int, w: int, overlap: int, device, dtype, top: bool, bottom: bool, left: bool, right: bool):
    import torch

    weight = torch.ones((1, 1, h, w), device=device, dtype=dtype)
    if overlap <= 0:
        return weight

    def ramp(n: int):
        # Starts above zero to avoid divide-by-zero at exact tile boundaries.
        return torch.linspace(1.0 / (n + 1), 1.0, n, device=device, dtype=dtype)

    n_h = min(overlap, h // 2)
    n_w = min(overlap, w // 2)

    if top and n_h:
        weight[:, :, :n_h, :] *= ramp(n_h).view(1, 1, n_h, 1)
    if bottom and n_h:
        weight[:, :, -n_h:, :] *= ramp(n_h).flip(0).view(1, 1, n_h, 1)
    if left and n_w:
        weight[:, :, :, :n_w] *= ramp(n_w).view(1, 1, 1, n_w)
    if right and n_w:
        weight[:, :, :, -n_w:] *= ramp(n_w).flip(0).view(1, 1, 1, n_w)
    return weight


def run_tiled(x, fn: Callable, tile_size: int, overlap: int):
    import torch

    _, _, h, w = x.shape
    if tile_size <= 0 or (h <= tile_size and w <= tile_size):
        return fn(x)

    ys = tile_starts(h, tile_size, overlap)
    xs = tile_starts(w, tile_size, overlap)
    accum = torch.zeros_like(x)
    norm = torch.zeros((1, 1, h, w), device=x.device, dtype=x.dtype)

    for y in ys:
        for x0 in xs:
            y1 = min(h, y + tile_size)
            x1 = min(w, x0 + tile_size)
            patch = x[:, :, y:y1, x0:x1]
            out = fn(patch)
            ph, pw = out.shape[-2:]
            weight = feather_weight(
                ph, pw, overlap, out.device, out.dtype,
                top=(y > 0),
                bottom=(y1 < h),
                left=(x0 > 0),
                right=(x1 < w),
            )
            accum[:, :, y:y1, x0:x1] += out * weight
            norm[:, :, y:y1, x0:x1] += weight

    return accum / norm.clamp_min(1e-8)


class ModelManager:
    def __init__(self, models_dir: Path, device: str, precision: str, inference_cfg: dict[str, Any]):
        import torch

        self.torch = torch
        self.models_dir = models_dir
        self.device = torch.device(device if device != "cuda" else ("cuda" if torch.cuda.is_available() else "cpu"))
        if device.startswith("cuda") and self.device.type != "cuda":
            raise RuntimeError(
                "CUDA was requested but torch.cuda.is_available() is False. "
                "Run with --device cpu or install a CUDA-enabled PyTorch build."
            )
        self.precision = precision
        self.inference_cfg = inference_cfg
        self.cache: dict[str, Any] = {}
        self.warned_drunet_fp16 = False

        if self.device.type == "cuda":
            torch.backends.cudnn.benchmark = True

    def model_path(self, name: str) -> Path:
        return self.models_dir / MODEL_INFO[name]["filename"]

    def _dtype_for(self, name: str):
        torch = self.torch
        if self.precision == "fp32":
            return torch.float32
        if self.precision == "bf16":
            return torch.bfloat16
        if self.precision == "fp16":
            if name == "drunet":
                if not self.warned_drunet_fp16:
                    print("DRUNet: fp16 requested, using fp32 for compatibility/stability.")
                    self.warned_drunet_fp16 = True
                return torch.float32
            return torch.float16
        raise ValueError(self.precision)

    def get(self, name: str):
        if name in self.cache:
            return self.cache[name]
        path = self.model_path(name)
        if not path.exists():
            raise FileNotFoundError(
                f"Missing model: {path}\nRun: {Path(__file__).name} --install"
            )

        from spandrel import ModelLoader

        print(f"Loading {name} model: {path.name}")
        desc = ModelLoader().load_from_file(str(path))
        desc.to(self.device)
        desc.eval()
        dtype = self._dtype_for(name)
        desc.model.to(dtype=dtype)
        self.cache[name] = (desc, dtype)
        return self.cache[name]

    def unload(self, name: str) -> None:
        """Release one cached model before the next algorithm is processed."""
        cached = self.cache.pop(name, None)
        if cached is None:
            return
        del cached
        gc.collect()
        if self.device.type == "cuda":
            self.torch.cuda.empty_cache()
        print(f"Released {name} model from {self.device.type.upper()} memory.")

    def _with_oom_fallback(self, x, fn: Callable):
        torch = self.torch
        tile = int(self.inference_cfg["tile_size"])
        overlap = int(self.inference_cfg["tile_overlap"])
        oom_tile = int(self.inference_cfg["oom_tile_size"])

        attempt_tile = tile
        while True:
            try:
                with torch.inference_mode():
                    return run_tiled(x, fn, attempt_tile, overlap)
            except RuntimeError as exc:
                is_oom = self.device.type == "cuda" and "out of memory" in str(exc).lower()
                if not is_oom:
                    raise
                torch.cuda.empty_cache()
                if attempt_tile <= 0:
                    attempt_tile = oom_tile or 512
                else:
                    attempt_tile = max(128, attempt_tile // 2)
                if overlap * 2 >= attempt_tile:
                    overlap = max(8, attempt_tile // 8)
                print(f"CUDA OOM: retrying with tile_size={attempt_tile}, overlap={overlap}")
                if attempt_tile <= 128:
                    # One final 128px attempt; if that also OOMs, propagate next time.
                    try:
                        with torch.inference_mode():
                            return run_tiled(x, fn, attempt_tile, overlap)
                    except RuntimeError:
                        torch.cuda.empty_cache()
                        raise

    def scunet(self, x, blend: float):
        desc, dtype = self.get("scunet")
        work = x.to(self.device, dtype=dtype)
        original = work
        out = self._with_oom_fallback(work, lambda p: desc(p))
        return blend_tensors(original, out, blend)

    def drunet(self, x, sigma: float, blend: float):
        import torch.nn.functional as F

        desc, dtype = self.get("drunet")
        work = x.to(self.device, dtype=dtype)
        original = work

        def infer(p):
            _, _, h, w = p.shape
            pad_h = (8 - h % 8) % 8
            pad_w = (8 - w % 8) % 8
            if pad_h or pad_w:
                mode = "reflect" if h > 1 and w > 1 else "replicate"
                pp = F.pad(p, (0, pad_w, 0, pad_h), mode=mode)
            else:
                pp = p
            _, _, hp, wp = pp.shape
            noise_level = float(sigma) / 255.0
            noise_map = self.torch.full(
                (pp.shape[0], 1, hp, wp),
                noise_level,
                device=pp.device,
                dtype=pp.dtype,
            )
            out = desc.model(self.torch.cat([pp, noise_map], dim=1))
            return out[:, :, :h, :w]

        out = self._with_oom_fallback(work, infer)
        return blend_tensors(original, out, blend)

    def fbcnn(self, x, quality: str | int, blend: float):
        desc, dtype = self.get("fbcnn")
        work = x.to(self.device, dtype=dtype)
        original = work

        def infer(p):
            if isinstance(quality, str) and quality.lower() == "auto":
                out, _pred = desc.model(p)
                return out
            q = int(quality)
            # Official FBCNN control convention: network input = 1 - JPEG_QF/100.
            qf_input = self.torch.tensor(
                [[1.0 - q / 100.0]],
                device=p.device,
                dtype=p.dtype,
            )
            out, _pred = desc.model(p, qf_input)
            return out

        out = self._with_oom_fallback(work, infer)
        return blend_tensors(original, out, blend)


def process_gaussian(rgb, cfg: dict[str, Any]):
    import cv2
    import numpy as np

    arr = np.asarray(rgb, dtype=np.float32) / 255.0
    original = arr.copy()
    sigma = float(cfg["sigma"])
    if sigma > 0:
        arr = cv2.GaussianBlur(
            arr,
            ksize=(0, 0),
            sigmaX=sigma,
            sigmaY=sigma,
            borderType=cv2.BORDER_REFLECT_101,
        )

    factor = float(cfg["downsample_factor"])
    if factor < 0.999999:
        h, w = arr.shape[:2]
        nw = max(1, round(w * factor))
        nh = max(1, round(h * factor))
        small = cv2.resize(arr, (nw, nh), interpolation=cv2.INTER_AREA)
        arr = cv2.resize(small, (w, h), interpolation=cv2.INTER_CUBIC)

    blend = float(cfg["blend"])
    arr = original * (1.0 - blend) + arr * blend
    return np.clip(np.rint(arr * 255.0), 0, 255).astype(np.uint8)


def open_image_rgb(path: Path):
    from PIL import Image, ImageOps

    img = Image.open(path)
    img = ImageOps.exif_transpose(img)
    icc = img.info.get("icc_profile")
    alpha = None
    if "A" in img.getbands():
        rgba = img.convert("RGBA")
        alpha = rgba.getchannel("A").copy()
        rgb = rgba.convert("RGB")
    else:
        rgb = img.convert("RGB")
    return rgb, alpha, icc


def save_processed(arr, alpha, icc, destination: Path, cfg: dict[str, Any]) -> None:
    from PIL import Image

    destination.parent.mkdir(parents=True, exist_ok=True)
    img = Image.fromarray(arr, mode="RGB")
    if alpha is not None:
        img.putalpha(alpha)

    suffix = destination.suffix.lower()
    save_kwargs: dict[str, Any] = {}
    if cfg["preserve_icc"] and icc:
        save_kwargs["icc_profile"] = icc

    if suffix == ".png":
        fmt = "PNG"
        save_kwargs["compress_level"] = int(cfg["png_compress_level"])
    elif suffix in (".jpg", ".jpeg"):
        fmt = "JPEG"
        if img.mode == "RGBA":
            img = img.convert("RGB")
        save_kwargs["quality"] = int(cfg["jpeg_quality"])
        save_kwargs["subsampling"] = 0
        save_kwargs["optimize"] = True
    elif suffix == ".webp":
        fmt = "WEBP"
        q = int(cfg["webp_quality"])
        if q >= 100:
            save_kwargs["lossless"] = True
            save_kwargs["quality"] = 100
        else:
            save_kwargs["quality"] = q
            save_kwargs["method"] = 4
    elif suffix in (".tif", ".tiff"):
        fmt = "TIFF"
        save_kwargs["compression"] = "tiff_deflate"
    elif suffix == ".bmp":
        fmt = "BMP"
    else:
        raise ValueError(f"Unsupported output extension: {suffix}")

    # Atomic write in the destination folder.
    tmp = destination.with_name(
        f".{destination.stem}.{secrets.token_hex(4)}.tmp{destination.suffix}"
    )
    img.save(tmp, format=fmt, **save_kwargs)
    os.replace(tmp, destination)


def exact_copy(source: Path, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    tmp = destination.with_name(
        f".{destination.stem}.{secrets.token_hex(4)}.tmp{destination.suffix}"
    )
    shutil.copy2(source, tmp)
    os.replace(tmp, destination)


def build_manifest_row(
    src: Path,
    dst: Path,
    algorithm: str,
    status: str,
    cfg: dict[str, Any],
    error: str = "",
) -> dict[str, str]:
    params: dict[str, Any]
    if algorithm == "gaussian":
        params = cfg["gaussian"]
    elif algorithm == "scunet":
        params = cfg["scunet"]
    elif algorithm == "drunet":
        params = cfg["drunet"]
    elif algorithm == "fbcnn":
        params = cfg["fbcnn"]
    else:
        params = {}

    return {
        "source": str(src),
        "target": str(dst),
        "algorithm": algorithm,
        "status": status,
        "parameters": json.dumps(params, sort_keys=True),
        "error": error,
    }


def write_manifest(path: Path, rows: list[dict[str, str]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fieldnames = ["source", "target", "algorithm", "status", "parameters", "error"]
    with path.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)


def apply_cli_overrides(cfg: dict[str, Any], args: argparse.Namespace) -> dict[str, Any]:
    cfg = deepcopy(cfg)

    simple = {
        "source": args.source,
        "target": args.target,
        "layout": args.layout,
        "seed": args.seed,
        "device": args.device,
        "models_dir": args.models_dir,
        "fail_fast": args.fail_fast,
    }
    for key, value in simple.items():
        if value is not None:
            cfg[key] = value

    if args.recursive is not None:
        cfg["recursive"] = args.recursive

    prob_overrides = parse_prob_arg(args.prob)
    dedicated = {
        "gaussian": args.gaussian_prob,
        "scunet": args.scunet_prob,
        "drunet": args.drunet_prob,
        "fbcnn": args.fbcnn_prob,
        "blank": args.blank_prob,
    }
    for name, value in dedicated.items():
        if value is not None:
            prob_overrides[name] = value
    for name, value in prob_overrides.items():
        cfg["probabilities"][name] = value

    nested_values = [
        ("gaussian", "sigma", args.gaussian_sigma),
        ("gaussian", "downsample_factor", args.mild_downsample_factor),
        ("gaussian", "blend", args.gaussian_blend),
        ("scunet", "blend", args.scunet_blend),
        ("drunet", "sigma", args.drunet_sigma),
        ("drunet", "blend", args.drunet_blend),
        ("fbcnn", "quality", args.fbcnn_quality),
        ("fbcnn", "blend", args.fbcnn_blend),
        ("inference", "tile_size", args.tile_size),
        ("inference", "tile_overlap", args.tile_overlap),
        ("inference", "oom_tile_size", args.oom_tile_size),
        ("inference", "precision", args.precision),
        ("output", "processed_format", args.processed_format),
        ("output", "png_compress_level", args.png_compress_level),
        ("output", "jpeg_quality", args.jpeg_quality),
        ("output", "webp_quality", args.webp_quality),
    ]
    for section, key, value in nested_values:
        if value is not None:
            cfg[section][key] = value

    if args.overwrite is not None:
        cfg["output"]["overwrite"] = args.overwrite
    if args.preserve_icc is not None:
        cfg["output"]["preserve_icc"] = args.preserve_icc
    if args.manifest is not None:
        cfg["manifest"]["enabled"] = args.manifest
    if args.manifest_filename is not None:
        cfg["manifest"]["filename"] = args.manifest_filename

    return cfg


def make_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
        description="Conservative photo cleanup for AI training datasets.",
    )
    p.add_argument("--config", help="JSON settings file. CLI values override it.")
    p.add_argument("--write-config", metavar="PATH", help="Write a complete example settings JSON and exit.")
    p.add_argument("--install", action="store_true", help="Install Python packages and download all neural model weights.")
    p.add_argument("--source", help="Source image folder.")
    p.add_argument("--target", help="Target image folder.")
    p.add_argument("--layout", choices=["preserve", "flat"], help="Preserve nested folders or flatten outputs.")
    p.add_argument("--recursive", action=argparse.BooleanOptionalAction, default=None)
    p.add_argument("--seed", type=int, help="Seed for reproducible algorithm selection.")
    p.add_argument("--device", help="torch device, e.g. cuda, cuda:0, cpu.")
    p.add_argument("--models-dir", help="Folder containing/downloading .pth model files.")
    p.add_argument("--fail-fast", action=argparse.BooleanOptionalAction, default=None)
    p.add_argument("--dry-run", action="store_true", help="Assign algorithms and show counts without processing images.")

    p.add_argument(
        "--prob",
        action="append",
        metavar="NAME=VALUE",
        help="Repeatable probability override: gaussian/scunet/drunet/fbcnn/blank=0.0..1.0",
    )
    p.add_argument("--gaussian-prob", type=float)
    p.add_argument("--scunet-prob", type=float)
    p.add_argument("--drunet-prob", type=float)
    p.add_argument("--fbcnn-prob", type=float)
    p.add_argument("--blank-prob", type=float)

    p.add_argument("--gaussian-sigma", type=float)
    p.add_argument("--mild-downsample-factor", type=float)
    p.add_argument("--gaussian-blend", type=float)
    p.add_argument("--scunet-blend", type=float)
    p.add_argument("--drunet-sigma", type=float)
    p.add_argument("--drunet-blend", type=float)
    p.add_argument("--fbcnn-quality", help="'auto' or JPEG quality integer 1..100.")
    p.add_argument("--fbcnn-blend", type=float)

    p.add_argument("--tile-size", type=int, help="0=full image; positive value enables tiling.")
    p.add_argument("--tile-overlap", type=int)
    p.add_argument("--oom-tile-size", type=int, help="Fallback tile size after CUDA OOM.")
    p.add_argument("--precision", choices=["fp32", "fp16", "bf16"])

    p.add_argument("--processed-format", choices=["png", "jpg", "jpeg", "webp", "keep"])
    p.add_argument("--png-compress-level", type=int)
    p.add_argument("--jpeg-quality", type=int)
    p.add_argument("--webp-quality", type=int)
    p.add_argument("--overwrite", action=argparse.BooleanOptionalAction, default=None)
    p.add_argument("--preserve-icc", action=argparse.BooleanOptionalAction, default=None)
    p.add_argument("--manifest", action=argparse.BooleanOptionalAction, default=None)
    p.add_argument("--manifest-filename")

    return p


def main() -> int:
    parser = make_parser()
    args = parser.parse_args()

    if args.write_config:
        path = Path(args.write_config)
        write_example_config(path)
        print(f"Wrote example config: {path}")
        return 0

    try:
        file_cfg = load_json_config(args.config)
        cfg = deep_merge(DEFAULTS, file_cfg)
        cfg = apply_cli_overrides(cfg, args)
        validate_config(cfg)
        probs = resolve_probabilities(cfg["probabilities"])
    except Exception as exc:
        eprint(f"Configuration error: {exc}")
        return 2

    models_dir = Path(cfg["models_dir"]).expanduser()

    if args.install:
        try:
            install_dependencies()
            download_models(models_dir)
            verify_models(models_dir)
            print("Installation complete.")
        except Exception as exc:
            eprint(f"Installation failed: {exc}")
            return 1
        if not cfg.get("source") or not cfg.get("target"):
            return 0

    if not cfg.get("source") or not cfg.get("target"):
        parser.error("--source and --target are required for processing (or provide them in --config).")

    source = Path(cfg["source"]).expanduser()
    target = Path(cfg["target"]).expanduser()
    if not source.is_dir():
        eprint(f"Source folder does not exist: {source}")
        return 2

    try:
        ensure_source_target_safe(source, target)
    except Exception as exc:
        eprint(f"Path error: {exc}")
        return 2

    extensions = normalize_extensions(cfg["extensions"])
    files = list_images(source, bool(cfg["recursive"]), extensions)
    if not files:
        print("No matching images found.")
        return 0

    rng = random.Random(int(cfg["seed"]))
    assignments = [(p, weighted_choice(rng, probs)) for p in files]

    print(f"Images found: {len(files)}")
    print("Resolved probabilities:")
    for name in ALL_CHOICES:
        print(f"  {name:8s}: {probs[name]:.6f}")

    counts = {name: 0 for name in ALL_CHOICES}
    for _, name in assignments:
        counts[name] += 1
    print("Assigned counts:")
    for name in ALL_CHOICES:
        print(f"  {name:8s}: {counts[name]}")

    if args.dry_run:
        print("Dry run complete; no files were written.")
        return 0

    target.mkdir(parents=True, exist_ok=True)

    # Runtime imports happen only after --install and --dry-run are handled.
    try:
        from tqdm import tqdm
    except Exception as exc:
        eprint(f"Missing dependency: {exc}. Run --install first.")
        return 1

    manager = None
    if any(counts[name] for name in ("scunet", "drunet", "fbcnn")):
        try:
            manager = ModelManager(
                models_dir=models_dir,
                device=str(cfg["device"]),
                precision=str(cfg["inference"]["precision"]),
                inference_cfg=cfg["inference"],
            )
        except Exception as exc:
            eprint(f"Could not initialize neural inference: {exc}")
            return 1

    # Plan destinations in the original source-file order. This preserves existing
    # collision/resume behavior even though actual processing is grouped below.
    reserved: set[Path] = set()
    planned_jobs: list[tuple[int, Path, str, Path, bool]] = []
    for index, (src, algorithm) in enumerate(assignments):
        dst, skip = plan_output_path(
            source_file=src,
            source_root=source,
            target_root=target,
            algorithm=algorithm,
            layout=str(cfg["layout"]),
            processed_format=str(cfg["output"]["processed_format"]),
            reserved=reserved,
            overwrite=bool(cfg["output"]["overwrite"]),
        )
        planned_jobs.append((index, src, algorithm, dst, skip))

    batches = {name: [] for name in ALL_CHOICES}
    for job in planned_jobs:
        batches[job[2]].append(job)

    manifest_rows: list[dict[str, str] | None] = [None] * len(assignments)
    stats = {"ok": 0, "copied": 0, "skipped": 0, "error": 0}
    start = time.time()

    with tqdm(total=len(planned_jobs), desc="Processing", unit="img") as progress:
        for algorithm in PROCESSING_ORDER:
            batch = batches[algorithm]
            if not batch:
                continue

            progress.set_description(f"Processing {algorithm}")
            try:
                for index, src, _algorithm, dst, skip in batch:
                    try:
                        if skip:
                            stats["skipped"] += 1
                            manifest_rows[index] = build_manifest_row(
                                src, dst, algorithm, "skipped_existing", cfg
                            )
                            continue

                        if algorithm == "blank":
                            exact_copy(src, dst)
                            stats["copied"] += 1
                            manifest_rows[index] = build_manifest_row(
                                src, dst, algorithm, "copied_exact", cfg
                            )
                            continue

                        rgb, alpha, icc = open_image_rgb(src)

                        if algorithm == "gaussian":
                            arr = process_gaussian(rgb, cfg["gaussian"])
                        else:
                            x = image_to_tensor(rgb)
                            if algorithm == "scunet":
                                out = manager.scunet(x, float(cfg["scunet"]["blend"]))
                            elif algorithm == "drunet":
                                out = manager.drunet(
                                    x,
                                    float(cfg["drunet"]["sigma"]),
                                    float(cfg["drunet"]["blend"]),
                                )
                            elif algorithm == "fbcnn":
                                q = cfg["fbcnn"]["quality"]
                                if not (isinstance(q, str) and q.lower() == "auto"):
                                    q = int(q)
                                out = manager.fbcnn(x, q, float(cfg["fbcnn"]["blend"]))
                            else:
                                raise RuntimeError(f"Unknown algorithm: {algorithm}")
                            arr = tensor_to_uint8(out)
                            del out, x

                        save_processed(arr, alpha, icc, dst, cfg["output"])
                        stats["ok"] += 1
                        manifest_rows[index] = build_manifest_row(
                            src, dst, algorithm, "processed", cfg
                        )

                    except Exception as exc:
                        stats["error"] += 1
                        eprint(f"\nERROR processing {src}: {exc}")
                        manifest_rows[index] = build_manifest_row(
                            src, Path(""), algorithm, "error", cfg, error=str(exc)
                        )
                        if cfg["fail_fast"]:
                            raise
                    finally:
                        progress.update(1)
            finally:
                if manager is not None and algorithm in ("scunet", "drunet", "fbcnn"):
                    manager.unload(algorithm)

    if cfg["manifest"]["enabled"]:
        manifest_path = target / str(cfg["manifest"]["filename"])
        write_manifest(manifest_path, [row for row in manifest_rows if row is not None])
        print(f"Manifest: {manifest_path}")

    elapsed = time.time() - start
    print(
        f"Done. processed={stats['ok']}, exact_copies={stats['copied']}, "
        f"skipped={stats['skipped']}, errors={stats['error']}, "
        f"elapsed={elapsed:.1f}s"
    )
    return 0 if stats["error"] == 0 else 3


if __name__ == "__main__":
    raise SystemExit(main())
