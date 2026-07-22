#!/usr/bin/env python3
"""Quickly find images containing prominent text.

Unlike ``images_filter_by_text.py``, this script does not classify text by its
position. It downscales large images, runs several Tesseract instances in
parallel, and only accepts sufficiently large, high-confidence OCR words.
"""

from __future__ import annotations

import argparse
import csv
import os
import re
import shutil
import sys
from concurrent.futures import ProcessPoolExecutor, as_completed
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

import cv2
import pytesseract
from pytesseract import Output


IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tif", ".tiff"}
ALPHANUMERIC_RE = re.compile(r"[^A-Za-z0-9]+")


@dataclass(frozen=True)
class DetectionSettings:
    max_dimension: int
    min_confidence: float
    min_height_ratio: float
    min_word_length: int
    min_words: int
    min_total_characters: int
    single_word_characters: int
    single_word_confidence: float
    language: str
    timeout: float


@dataclass(frozen=True)
class DetectionResult:
    path: str
    has_large_text: bool
    words: tuple[str, ...] = ()
    confidences: tuple[float, ...] = ()
    error: str = ""


def positive_int(value: str) -> int:
    parsed = int(value)
    if parsed < 1:
        raise argparse.ArgumentTypeError("must be at least 1")
    return parsed


def ratio(value: str) -> float:
    parsed = float(value)
    if not 0.0 < parsed <= 1.0:
        raise argparse.ArgumentTypeError("must be greater than 0 and at most 1")
    return parsed


def confidence(value: str) -> float:
    parsed = float(value)
    if not 0.0 <= parsed <= 100.0:
        raise argparse.ArgumentTypeError("must be between 0 and 100")
    return parsed


def resize_for_ocr(image, max_dimension: int):
    height, width = image.shape[:2]
    largest_dimension = max(height, width)
    if largest_dimension <= max_dimension:
        return image

    scale = max_dimension / largest_dimension
    return cv2.resize(
        image,
        (max(1, round(width * scale)), max(1, round(height * scale))),
        interpolation=cv2.INTER_AREA,
    )


def normalized_word(text: str) -> str:
    return ALPHANUMERIC_RE.sub("", text)


def detect_large_text(path: str, settings: DetectionSettings) -> DetectionResult:
    try:
        image = cv2.imread(path, cv2.IMREAD_COLOR)
        if image is None:
            return DetectionResult(path, False, error="OpenCV could not read the image")

        image = resize_for_ocr(image, settings.max_dimension)
        image_height = image.shape[0]
        rgb_image = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)

        data = pytesseract.image_to_data(
            rgb_image,
            lang=settings.language,
            config="--oem 1 --psm 11",
            output_type=Output.DICT,
            timeout=settings.timeout,
        )

        accepted_words: list[str] = []
        accepted_confidences: list[float] = []

        for text, raw_confidence, box_height in zip(
            data["text"], data["conf"], data["height"]
        ):
            word = normalized_word(text)
            try:
                word_confidence = float(raw_confidence)
            except (TypeError, ValueError):
                continue

            if (
                word_confidence < settings.min_confidence
                or len(word) < settings.min_word_length
                or box_height / image_height < settings.min_height_ratio
            ):
                continue

            # OCR hallucinations on textures often contain mostly digits or one
            # isolated symbol. Require at least two letters in every word.
            if sum(character.isalpha() for character in word) < 2:
                continue

            accepted_words.append(word)
            accepted_confidences.append(word_confidence)

        total_characters = sum(len(word) for word in accepted_words)
        normal_match = (
            len(accepted_words) >= settings.min_words
            and total_characters >= settings.min_total_characters
        )
        strong_single_word_match = any(
            len(word) >= settings.single_word_characters
            and word_confidence >= settings.single_word_confidence
            for word, word_confidence in zip(accepted_words, accepted_confidences)
        )

        return DetectionResult(
            path,
            normal_match or strong_single_word_match,
            tuple(accepted_words),
            tuple(accepted_confidences),
        )
    except RuntimeError as exc:
        return DetectionResult(path, False, error=f"OCR timeout: {exc}")
    except Exception as exc:  # Keep one bad image from stopping a large batch.
        return DetectionResult(path, False, error=f"{type(exc).__name__}: {exc}")


def is_inside(path: Path, parent: Path) -> bool:
    try:
        path.relative_to(parent)
        return True
    except ValueError:
        return False


def collect_images(
    source_folder: Path, output_folder: Path, recursive: bool
) -> list[Path]:
    paths: Iterable[Path]
    paths = source_folder.rglob("*") if recursive else source_folder.iterdir()
    return sorted(
        path
        for path in paths
        if path.is_file()
        and path.suffix.lower() in IMAGE_EXTENSIONS
        and not is_inside(path, output_folder)
    )


def available_destination(output_folder: Path, source_path: Path) -> Path:
    destination = output_folder / source_path.name
    if not destination.exists():
        return destination

    counter = 2
    while True:
        destination = output_folder / f"{source_path.stem}_{counter}{source_path.suffix}"
        if not destination.exists():
            return destination
        counter += 1


def write_report(report_path: Path, results: list[DetectionResult]) -> None:
    report_path.parent.mkdir(parents=True, exist_ok=True)
    with report_path.open("w", newline="", encoding="utf-8") as report_file:
        writer = csv.writer(report_file)
        writer.writerow(["path", "has_large_text", "words", "confidences", "error"])
        for result in results:
            writer.writerow(
                [
                    result.path,
                    result.has_large_text,
                    " ".join(result.words),
                    " ".join(f"{value:.1f}" for value in result.confidences),
                    result.error,
                ]
            )


def build_parser() -> argparse.ArgumentParser:
    default_workers = min(8, max(1, os.cpu_count() or 1))
    parser = argparse.ArgumentParser(
        description="Find prominent text in images quickly and with strict OCR checks."
    )
    parser.add_argument(
        "--source_folder", required=True, type=Path, help="Folder containing images."
    )
    parser.add_argument(
        "--output_folder",
        type=Path,
        help="Destination for matches (default: SOURCE/Large-Text).",
    )
    parser.add_argument(
        "--action",
        choices=("move", "copy", "report"),
        default="move",
        help="What to do with matches (default: move).",
    )
    parser.add_argument(
        "--recursive",
        action="store_true",
        help="Also scan subfolders, including folders made by the old script.",
    )
    parser.add_argument(
        "--dry-run", action="store_true", help="Detect and print matches without moving/copying."
    )
    parser.add_argument(
        "--workers",
        type=positive_int,
        default=default_workers,
        help=f"Parallel OCR processes (default: {default_workers}).",
    )
    parser.add_argument(
        "--max_dimension",
        type=positive_int,
        default=1200,
        help="Downscale larger images before OCR (default: 1200).",
    )
    parser.add_argument(
        "--min_confidence",
        type=confidence,
        default=75.0,
        help="Minimum Tesseract confidence for each word (default: 75).",
    )
    parser.add_argument(
        "--min_height_ratio",
        type=ratio,
        default=0.035,
        help="Minimum word-box height as a fraction of image height (default: 0.035).",
    )
    parser.add_argument(
        "--min_word_length",
        type=positive_int,
        default=3,
        help="Minimum alphanumeric characters per accepted word (default: 3).",
    )
    parser.add_argument(
        "--min_words",
        type=positive_int,
        default=2,
        help="Minimum accepted words for a normal match (default: 2).",
    )
    parser.add_argument(
        "--min_total_characters",
        type=positive_int,
        default=7,
        help="Minimum characters across accepted words (default: 7).",
    )
    parser.add_argument(
        "--single_word_characters",
        type=positive_int,
        default=7,
        help="Characters needed for a strong single-word match (default: 7).",
    )
    parser.add_argument(
        "--single_word_confidence",
        type=confidence,
        default=90.0,
        help="Confidence needed for a strong single-word match (default: 90).",
    )
    parser.add_argument("--language", default="eng", help="Tesseract language (default: eng).")
    parser.add_argument(
        "--timeout",
        type=float,
        default=15.0,
        help="Maximum OCR seconds per image (default: 15).",
    )
    parser.add_argument("--report", type=Path, help="Optional CSV results report.")
    parser.add_argument(
        "--limit", type=positive_int, help="Process only the first N images (useful for tests)."
    )
    return parser


def main() -> int:
    args = build_parser().parse_args()
    source_folder = args.source_folder.expanduser().resolve()
    output_folder = (
        args.output_folder.expanduser().resolve()
        if args.output_folder
        else source_folder / "Large-Text"
    )

    if not source_folder.is_dir():
        print(f"Error: source folder does not exist: {source_folder}", file=sys.stderr)
        return 2
    if output_folder == source_folder:
        print("Error: output folder cannot be the source folder.", file=sys.stderr)
        return 2
    if args.timeout <= 0:
        print("Error: --timeout must be greater than 0.", file=sys.stderr)
        return 2

    image_paths = collect_images(source_folder, output_folder, args.recursive)
    if args.limit:
        image_paths = image_paths[: args.limit]
    if not image_paths:
        print("No supported images found.")
        return 0

    settings = DetectionSettings(
        max_dimension=args.max_dimension,
        min_confidence=args.min_confidence,
        min_height_ratio=args.min_height_ratio,
        min_word_length=args.min_word_length,
        min_words=args.min_words,
        min_total_characters=args.min_total_characters,
        single_word_characters=args.single_word_characters,
        single_word_confidence=args.single_word_confidence,
        language=args.language,
        timeout=args.timeout,
    )

    # Prevent each Tesseract process from starting additional OpenMP workers.
    os.environ.setdefault("OMP_THREAD_LIMIT", "1")
    print(
        f"Scanning {len(image_paths)} images with {args.workers} workers "
        f"(action={args.action}{', dry run' if args.dry_run else ''})...",
        flush=True,
    )

    results: list[DetectionResult] = []
    matches = 0
    errors = 0

    with ProcessPoolExecutor(max_workers=args.workers) as executor:
        futures = {
            executor.submit(detect_large_text, str(path), settings): path
            for path in image_paths
        }
        for completed, future in enumerate(as_completed(futures), start=1):
            result = future.result()
            results.append(result)
            source_path = Path(result.path)

            if result.error:
                errors += 1
                print(f"ERROR {source_path}: {result.error}", file=sys.stderr, flush=True)
            elif result.has_large_text:
                matches += 1
                words = " ".join(result.words)
                print(f"MATCH {source_path} [{words}]", flush=True)

                if not args.dry_run and args.action != "report":
                    output_folder.mkdir(parents=True, exist_ok=True)
                    destination = available_destination(output_folder, source_path)
                    if args.action == "move":
                        shutil.move(str(source_path), str(destination))
                    else:
                        shutil.copy2(source_path, destination)

            if completed % 50 == 0 or completed == len(image_paths):
                print(
                    f"Progress: {completed}/{len(image_paths)}; matches={matches}; errors={errors}",
                    flush=True,
                )

    results.sort(key=lambda result: result.path)
    if args.report:
        write_report(args.report.expanduser().resolve(), results)
        print(f"Report: {args.report.expanduser().resolve()}")

    action_taken = "found"
    if not args.dry_run and args.action == "move":
        action_taken = "moved"
    elif not args.dry_run and args.action == "copy":
        action_taken = "copied"
    print(
        f"Done: {len(image_paths)} scanned, {matches} {action_taken}, {errors} errors.",
        flush=True,
    )
    return 1 if errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
