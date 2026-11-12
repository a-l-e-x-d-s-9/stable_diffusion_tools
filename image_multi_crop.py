#!/usr/bin/env python3
"""Create a dataset of crops from one image with configurable placement and size.

Example:
  python image_multi_crop.py photo.jpg --output crops --count 20 --min-scale .5

Check one or more aspect ratios with --aspect-ratios; --count is the total shared
evenly among them. In percent mode, scale is a fraction of the largest fitting
rectangle, applied to both sides. In pixel mode, --min-pixels/--max-pixels limit
the longest crop edge. Maximums are capped by source size; oversized minimums
are rejected. Crops retain native dimensions and are saved as lossless PNGs.
The source and existing outputs are preserved. Use --strategy to choose among
uniform, greedy maximum separation, grid, Halton, weighted, thirds, and spiral
placements. Identical settings and seeds reproduce the crop plan.
"""

from __future__ import annotations

import argparse
import math
import random
import sys
from pathlib import Path
from typing import NamedTuple, Sequence

from PIL import Image, ImageOps


ASPECT_RATIOS = ("source", "1:1", "2:3", "3:2", "3:4", "4:3", "9:16", "16:9")


STRATEGIES = {
    "uniform": ("Uniform", "Choose positions and sizes uniformly at random."),
    "maximum_separation": ("Maximum separation", "Greedily choose the most distant crop center from 48 candidates per crop; large crops may still overlap."),
    "stratified_grid": ("Stratified grid", "Spread positions across grid cells, with random jitter inside each cell."),
    "low_discrepancy": ("Low discrepancy", "Use a shifted Halton sequence for even coverage with fewer clusters."),
    "center_weighted": ("Center weighted", "Favor positions near the center while keeping some wider coverage."),
    "edge_weighted": ("Edge weighted", "Favor borders while distributing crops along all four edges."),
    "rule_of_thirds": ("Rule of thirds", "Cluster crop centers near the four rule-of-thirds intersections, where feasible."),
    "golden_spiral": ("Golden spiral", "Arrange positions in an outward spiral using the golden angle."),
}


class CropSpec(NamedTuple):
    box: tuple[int, int, int, int]
    aspect_ratio: str


def validate_options(count=20, min_scale=.5, max_scale=1., aspect_ratios=("source",),
                     size_unit="percent", min_pixels=256, max_pixels=1024,
                     strategy="uniform"):
    if not aspect_ratios or any(ratio not in ASPECT_RATIOS for ratio in aspect_ratios):
        raise ValueError("Select at least one supported aspect ratio.")
    if len(set(aspect_ratios)) != len(aspect_ratios):
        raise ValueError("Aspect ratios must not be repeated.")
    if count < len(aspect_ratios):
        raise ValueError("Crop count must be at least the number of selected aspect ratios.")
    if size_unit == "percent":
        if not (math.isfinite(min_scale) and math.isfinite(max_scale)
                and 0 < min_scale <= max_scale <= 1):
            raise ValueError("Crop scales must satisfy 0 < minimum <= maximum <= 1.")
    elif size_unit == "pixels":
        if not (math.isfinite(min_pixels) and math.isfinite(max_pixels)
                and 1 <= min_pixels <= max_pixels):
            raise ValueError("Pixel sizes must satisfy 1 <= minimum <= maximum.")
    else:
        raise ValueError("Size unit must be percent or pixels.")
    if strategy not in STRATEGIES:
        raise ValueError(f"Unknown crop distribution strategy: {strategy}")


def _fitted_size(size, aspect_ratio):
    width, height = size
    if width < 1 or height < 1:
        raise ValueError("Image dimensions must be positive.")
    if aspect_ratio not in ASPECT_RATIOS:
        raise ValueError(f"Unknown aspect ratio: {aspect_ratio}")
    ratio = width / height if aspect_ratio == "source" else (
        float(aspect_ratio.split(":")[0]) / float(aspect_ratio.split(":")[1]))
    return min(width, height * ratio), min(height, width / ratio)


def _scale_limits(size, aspect_ratio, min_scale, max_scale, size_unit, min_pixels, max_pixels):
    fitted = _fitted_size(size, aspect_ratio)
    if size_unit == "pixels":
        longest = max(fitted)
        if min_pixels > longest:
            raise ValueError(f"{aspect_ratio}: minimum {min_pixels} px exceeds the largest fitting crop "
                             f"({round(fitted[0])} × {round(fitted[1])} px).")
        return min_pixels / longest, min(1., max_pixels / longest)
    return min_scale, max_scale


def crop_dimensions_range(size, aspect_ratio="source", min_scale=.5, max_scale=1.,
                          size_unit="percent", min_pixels=256, max_pixels=1024):
    """Return endpoint (width, height) pairs using the exporter's rounding."""
    validate_options(1, min_scale, max_scale, (aspect_ratio,), size_unit, min_pixels, max_pixels)
    fitted_w, fitted_h = _fitted_size(size, aspect_ratio)
    lo, hi = _scale_limits(size, aspect_ratio, min_scale, max_scale, size_unit, min_pixels, max_pixels)
    return tuple((max(1, min(size[0], round(fitted_w * scale))),
                  max(1, min(size[1], round(fitted_h * scale)))) for scale in (lo, hi))


def _halton(index, base):
    result, fraction = 0., 1.
    while index:
        fraction /= base
        result += fraction * (index % base)
        index //= base
    return result


class _Centers:
    """Spatial bins for nearest-center queries without quadratic crop comparisons."""
    def __init__(self, count):
        self.resolution = max(1, math.ceil(math.sqrt(count)))
        self.bins = {}
        self.points = []

    def add(self, point):
        self.points.append(point)
        key = tuple(min(self.resolution - 1, int(value * self.resolution)) for value in point)
        self.bins.setdefault(key, []).append(point)

    def distance(self, point):
        x, y = point
        if len(self.points) < 32:
            return min(((x-a)**2 + (y-b)**2 for a, b in self.points), default=float("inf"))
        n = self.resolution
        gx, gy = min(n-1, int(x*n)), min(n-1, int(y*n))
        best = float("inf")
        for ring in range(n):
            for ix in range(max(0, gx-ring), min(n-1, gx+ring)+1):
                for iy in range(max(0, gy-ring), min(n-1, gy+ring)+1):
                    if max(abs(ix-gx), abs(iy-gy)) != ring:
                        continue
                    for a, b in self.bins.get((ix, iy), ()):
                        best = min(best, (x-a)**2 + (y-b)**2)
            outside = min(x-(gx-ring)/n, (gx+ring+1)/n-x,
                          y-(gy-ring)/n, (gy+ring+1)/n-y)
            if best <= outside**2:
                break
        return best


def crop_plan(size: tuple[int, int], count: int = 20, min_scale: float = .5,
              max_scale: float = 1., aspect_ratios: Sequence[str] = ("source",), seed: int = 0,
              size_unit: str = "percent", min_pixels: int = 256, max_pixels: int = 1024,
              strategy: str = "uniform") -> list[CropSpec]:
    """Plan distinct crops, balancing the total count across selected ratios."""
    ratios = tuple(aspect_ratios)
    validate_options(count, min_scale, max_scale, ratios, size_unit, min_pixels, max_pixels, strategy)
    width, height = size
    fitted = {ratio: _fitted_size(size, ratio) for ratio in ratios}
    limits = {ratio: _scale_limits(size, ratio, min_scale, max_scale, size_unit, min_pixels, max_pixels)
              for ratio in ratios}
    rng = random.Random(seed)
    # Independent offsets preserve deterministic seeds for the Halton/spiral modes.
    phase_rng = random.Random(seed)
    shift_x, shift_y = phase_rng.random(), phase_rng.random()
    cols = math.ceil(math.sqrt(count))
    rows = math.ceil(count / cols)
    centers = _Centers(count)
    seen, plan = set(), []

    def candidate(ratio, index, attempt):
        fw, fh = fitted[ratio]
        scale = rng.uniform(*limits[ratio])
        cw, ch = max(1, min(width, round(fw*scale))), max(1, min(height, round(fh*scale)))
        if strategy == "stratified_grid":
            cell = (index + attempt) % count
            u, v = (cell % cols + rng.random()) / cols, (cell // cols + rng.random()) / rows
        elif strategy == "low_discrepancy":
            item = index + attempt * count + 1
            u, v = (_halton(item, 2) + shift_x) % 1, (_halton(item, 3) + shift_y) % 1
        elif strategy == "center_weighted":
            u, v = rng.betavariate(4, 4), rng.betavariate(4, 4)
        elif strategy == "edge_weighted":
            edge = rng.randrange(4)
            distance, along = rng.betavariate(1, 5) * .5, rng.random()
            u, v = ((distance, along), (1-distance, along), (along, distance), (along, 1-distance))[edge]
        elif strategy == "rule_of_thirds":
            tx, ty = rng.choice((1/3, 2/3)), rng.choice((1/3, 2/3))
            # Place centers in source coordinates, then clamp to the valid crop area.
            cx, cy = rng.gauss(tx, .07) * width, rng.gauss(ty, .07) * height
            u = (cx-cw/2) / (width-cw) if width > cw else .5
            v = (cy-ch/2) / (height-ch) if height > ch else .5
        elif strategy == "golden_spiral":
            item = (index + attempt) % count
            radius = math.sqrt((item + .5) / count) * .5
            angle = item * math.pi * (3-math.sqrt(5)) + shift_x * 2 * math.pi
            u, v = .5 + radius*math.cos(angle), .5 + radius*math.sin(angle)
            if attempt:
                u, v = u + rng.uniform(-.03, .03), v + rng.uniform(-.03, .03)
        else:
            u, v = rng.random(), rng.random()
        left = round(min(1., max(0., u)) * (width-cw))
        top = round(min(1., max(0., v)) * (height-ch))
        return left, top, left+cw, top+ch

    for index in range(count):
        ratio = ratios[index % len(ratios)]
        chosen = None
        for attempt in range(1000):
            if strategy == "maximum_separation":
                candidates = {candidate(ratio, index, attempt) for _ in range(48)} - seen
                if candidates:
                    # Sort to keep tie-breaking stable across Python runs.
                    chosen = max(sorted(candidates), key=lambda box: centers.distance(
                        ((box[0]+box[2])/(2*width), (box[1]+box[3])/(2*height))))
            else:
                box = candidate(ratio, index, attempt)
                if box not in seen:
                    chosen = box
            if chosen is not None:
                break
        if chosen is None:
            raise ValueError(f"Could only plan {len(plan)} of {count} distinct crops. "
                             f"No more boxes found for {ratio}; choose fewer crops or a wider size range.")
        seen.add(chosen)
        centers.add(((chosen[0]+chosen[2])/(2*width), (chosen[1]+chosen[3])/(2*height)))
        plan.append(CropSpec(chosen, ratio))
    return plan


def crop_boxes(size: tuple[int, int], count: int = 20, min_scale: float = .5,
               max_scale: float = 1., aspect_ratio: str = "source", seed: int = 0,
               *, aspect_ratios: Sequence[str] | None = None, size_unit: str = "percent",
               min_pixels: int = 256, max_pixels: int = 1024, strategy: str = "uniform"
               ) -> list[tuple[int, int, int, int]]:
    """Compatibility helper for callers requiring only the planned boxes."""
    ratios = (aspect_ratio,) if aspect_ratios is None else aspect_ratios
    return [item.box for item in crop_plan(size, count, min_scale, max_scale, ratios, seed,
                                          size_unit, min_pixels, max_pixels, strategy)]


def create_crops(image_path: Path, output: Path, count: int = 20,
                 min_scale: float = .5, max_scale: float = 1.,
                 aspect_ratio: str = "source", seed: int = 0,
                 copy_captions: bool = False, *, aspect_ratios: Sequence[str] | None = None,
                 size_unit: str = "percent", min_pixels: int = 256, max_pixels: int = 1024,
                 strategy: str = "uniform") -> list[Path]:
    image_path = image_path.expanduser().resolve()
    output = output.expanduser().resolve()
    if not image_path.is_file():
        raise ValueError(f"Source image not found: {image_path}")
    if output == image_path.parent:
        raise ValueError("Choose an output folder different from the source image folder.")
    caption = image_path.with_suffix(".txt")
    caption_data = caption.read_bytes() if copy_captions and caption.is_file() else None
    with Image.open(image_path) as opened:
        image = ImageOps.exif_transpose(opened)
        image.load()
        plan = crop_plan(image.size, count, min_scale, max_scale,
                         (aspect_ratio,) if aspect_ratios is None else aspect_ratios,
                         seed, size_unit, min_pixels, max_pixels, strategy)
        output.mkdir(parents=True, exist_ok=True)
        paths = []
        index = 1
        for spec in plan:
            box = spec.box
            while True:
                path = output / f"{image_path.stem}__crop_{index:05d}.png"
                index += 1
                # Reserve the caption basename even when captions are disabled.
                if path.with_suffix(".txt").exists():
                    continue
                try:
                    target = path.open("xb")
                except FileExistsError:
                    continue
                break
            try:
                crop = image.crop(box)
                if crop.mode not in {"1", "L", "LA", "P", "RGB", "RGBA", "I", "I;16"}:
                    crop = crop.convert("RGB")
                save_options = {}
                if image.info.get("icc_profile"):
                    save_options["icc_profile"] = image.info["icc_profile"]
                # Orientation is already applied; discard EXIF dimensions/thumbnail.
                crop.info.pop("exif", None)
                with target:
                    crop.save(target, format="PNG", **save_options)
                if caption_data is not None:
                    with path.with_suffix(".txt").open("xb") as sidecar:
                        sidecar.write(caption_data)
            except Exception:
                target.close()
                path.unlink(missing_ok=True)
                raise
            paths.append(path)
            print(f"[{len(paths)}/{count}] {path.name} — {crop.width}x{crop.height}; box={box}; ratio={spec.aspect_ratio}", flush=True)
    return paths


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("image", type=Path, help="One source image")
    parser.add_argument("--output", type=Path, required=True, help="Separate output folder")
    parser.add_argument("--count", type=int, default=20, help="Number of new crops (default: 20)")
    parser.add_argument("--min-scale", type=float, default=.5, help="Minimum side-length fraction (default: .5)")
    parser.add_argument("--max-scale", type=float, default=1., help="Maximum side-length fraction (default: 1)")
    parser.add_argument("--aspect-ratio", choices=ASPECT_RATIOS, default="source",
                        help="Single ratio (legacy shorthand)")
    parser.add_argument("--aspect-ratios", nargs="+", choices=ASPECT_RATIOS,
                        help="One or more ratios; the total count is divided evenly among them")
    parser.add_argument("--size-unit", choices=("percent", "pixels"), default="percent")
    parser.add_argument("--min-pixels", type=int, default=256, help="Minimum longest edge in pixel mode")
    parser.add_argument("--max-pixels", type=int, default=1024, help="Maximum longest edge, capped by source size")
    parser.add_argument("--strategy", choices=tuple(STRATEGIES), default="uniform")
    parser.add_argument("--seed", type=int, default=0, help="Reproducible random seed (default: 0)")
    parser.add_argument("--copy-captions", action="store_true", help="Copy the source .txt sidecar to every crop")
    args = parser.parse_args(argv)
    try:
        paths = create_crops(args.image, args.output, args.count, args.min_scale,
                             args.max_scale, args.aspect_ratio, args.seed, args.copy_captions,
                             aspect_ratios=args.aspect_ratios, size_unit=args.size_unit,
                             min_pixels=args.min_pixels, max_pixels=args.max_pixels, strategy=args.strategy)
    except (OSError, ValueError) as error:
        print(f"Error: {error}", file=sys.stderr)
        return 1
    print(f"Saved {len(paths)} crops to {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
