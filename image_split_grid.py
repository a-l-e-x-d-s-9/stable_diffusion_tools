#!/usr/bin/env python3
"""
Split an image into an x-by-y grid, with optional outer offsets and inner spacing.

Example:
  python image_split_grid.py /path/to/image.png 4 3 --offset-left 10 --offset-top 10 --spacing 4
"""

import argparse
from pathlib import Path

from PIL import Image


def _distribute_sizes(total_pixels: int, parts: int) -> list[int]:
    # Distribute remainder so the sum matches total_pixels exactly.
    base = total_pixels // parts
    rem = total_pixels % parts
    return [base + (1 if i < rem else 0) for i in range(parts)]


def split_image(
    image_path: Path,
    x: int,
    y: int,
    offset_left: int = 0,
    offset_right: int = 0,
    offset_top: int = 0,
    offset_bottom: int = 0,
    spacing: int = 0,
) -> list[Path]:
    if x <= 0 or y <= 0:
        raise ValueError("x and y must be positive integers.")
    for name, v in [
        ("offset_left", offset_left),
        ("offset_right", offset_right),
        ("offset_top", offset_top),
        ("offset_bottom", offset_bottom),
        ("spacing", spacing),
    ]:
        if v < 0:
            raise ValueError(f"{name} must be >= 0.")

    image_path = image_path.expanduser().resolve()
    if not image_path.exists():
        raise FileNotFoundError(f"Image not found: {image_path}")

    with Image.open(image_path) as im:
        im.load()
        W, H = im.size

        usable_w = W - offset_left - offset_right
        usable_h = H - offset_top - offset_bottom
        if usable_w <= 0 or usable_h <= 0:
            raise ValueError(
                f"Offsets are too large. Image is {W}x{H}, usable area is {usable_w}x{usable_h}."
            )

        grid_w = usable_w - (x - 1) * spacing
        grid_h = usable_h - (y - 1) * spacing
        if grid_w <= 0 or grid_h <= 0:
            raise ValueError(
                f"Spacing is too large for the usable area. Grid area is {grid_w}x{grid_h}."
            )
        if grid_w < x or grid_h < y:
            raise ValueError(
                f"Grid area too small to split into {x}x{y} parts. Grid area is {grid_w}x{grid_h}."
            )

        col_widths = _distribute_sizes(grid_w, x)
        row_heights = _distribute_sizes(grid_h, y)

        out_dir = image_path.parent
        stem = image_path.stem
        ext = image_path.suffix  # keep original extension
        total = x * y
        pad = max(2, len(str(total)))

        outputs: list[Path] = []
        idx = 1

        y_cursor = offset_top
        for r in range(y):
            x_cursor = offset_left
            for c in range(x):
                w = col_widths[c]
                h = row_heights[r]
                left = x_cursor
                top = y_cursor
                right = left + w
                bottom = top + h

                tile = im.crop((left, top, right, bottom))

                out_name = f"{stem}_{idx:0{pad}d}{ext}"
                out_path = out_dir / out_name

                # Preserve mode as-is; Pillow selects encoder based on extension.
                tile.save(out_path)
                outputs.append(out_path)

                idx += 1
                x_cursor = right + spacing
            y_cursor = (y_cursor + row_heights[r]) + spacing

        return outputs


def main() -> int:
    p = argparse.ArgumentParser(description="Split an image into an x-by-y grid with optional offsets and spacing.")
    p.add_argument("image", type=Path, help="Path to the input image")
    p.add_argument("x", type=int, help="Number of tiles horizontally")
    p.add_argument("y", type=int, help="Number of tiles vertically")
    p.add_argument("--offset-left", type=int, default=0, help="Pixels to skip from the left edge (default: 0)")
    p.add_argument("--offset-right", type=int, default=0, help="Pixels to skip from the right edge (default: 0)")
    p.add_argument("--offset-top", type=int, default=0, help="Pixels to skip from the top edge (default: 0)")
    p.add_argument("--offset-bottom", type=int, default=0, help="Pixels to skip from the bottom edge (default: 0)")
    p.add_argument("--spacing", type=int, default=0, help="Pixels to skip between tiles (both axes) (default: 0)")
    args = p.parse_args()

    outputs = split_image(
        image_path=args.image,
        x=args.x,
        y=args.y,
        offset_left=args.offset_left,
        offset_right=args.offset_right,
        offset_top=args.offset_top,
        offset_bottom=args.offset_bottom,
        spacing=args.spacing,
    )

    print(f"Wrote {len(outputs)} tiles next to the original image:")
    for op in outputs:
        print(f"- {op}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
