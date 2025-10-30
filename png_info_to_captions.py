
#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
png_info_to_captions.py - rewritten to rely on read_write_metadata.py for all metadata I/O.

Key changes:
- Removed ad-hoc metadata parsing with Pillow. All metadata access now goes through read_write_metadata.read_metadata().
- Kept prompt parsing and simplification logic, but applied only to the 'parameters' field returned by read_metadata().
- Threaded processing preserved, with an explicit lock passed to worker to avoid globals.
- Safer handling of missing/invalid metadata; invisible characters stripped before parsing.
- CLI flags kept compatible with the previous script.
"""
import argparse
import os
import re
import string
import sys
import threading
from pathlib import Path
from typing import List

from tqdm import tqdm

# Local import of the unified metadata helper
# Make sure read_write_metadata.py is in the same folder or on PYTHONPATH.
import read_write_metadata as rwm


# ---------------- Utilities ----------------

_allowed_chars = set(string.printable + "\t\n\r")

def remove_invisible_characters(s: str) -> str:
    return "".join(ch for ch in s if ch in _allowed_chars)

def flat_prompt(text: str) -> str:
    return text.replace("\n", ", ")


def parse_parameters(value: str) -> dict:
    """
    Parse Stable Diffusion style 'parameters' text into a dict.
    Expects a 'Negative prompt:' section and a 'Steps:' section.
    """
    value = remove_invisible_characters(value)
    steps_index = value.rfind("Steps:")
    if steps_index < 0:
        raise ValueError("Invalid format: 'Steps:' keyword not found.")
    prompt_and_neg_prompt = value[:steps_index].strip()
    other_params = value[steps_index:]
    neg_prompt_index = prompt_and_neg_prompt.rfind("Negative prompt:")
    if neg_prompt_index == -1:
        raise ValueError("Invalid format: 'Negative prompt:' keyword not found.")
    prompt = (
        prompt_and_neg_prompt[:neg_prompt_index]
        .strip()
        .replace("parameters:", "")
        .strip()
    )
    negative_prompt = (
        prompt_and_neg_prompt[neg_prompt_index:]
        .replace("Negative prompt:", "")
        .strip()
    )
    kv_pairs = [kv.strip() for kv in other_params.split(",") if kv]
    kv_dict = {}
    for kv in kv_pairs:
        k, *rest = kv.split(":")
        v = ":".join(rest).strip()
        kv_dict[k.strip()] = v
    result = {"prompt": prompt, "Negative prompt": negative_prompt}
    result.update(kv_dict)
    return result


def simplify_prompt(prompt: str, exclude_patterns: List[str], is_flat_prompt: bool) -> str:
    # Remove unwanted text first
    for pattern in exclude_patterns:
        prompt = re.sub(pattern, "", prompt)

    if is_flat_prompt:
        prompt = flat_prompt(prompt)

    prompt = re.sub(r"\(:0\)", "", prompt)
    prompt = re.sub(r"\( :0\)", " ", prompt)

    prompt = re.sub(r"\\\(", "bracket_open", prompt)
    prompt = re.sub(r"\\\)", "bracket_close", prompt)

    # Insert comma after brackets if needed
    prompt = re.sub(r"(?<=\))([^,\s\]])", r",\1", prompt)
    prompt = re.sub(r"(?<=\])([^,\s\]])", r",\1", prompt)

    # Remove lora tags like <lora:name:1.0>
    prompt = re.sub(r"<[^>]+>", "", prompt)

    # (A:B:1.21) -> A, B
    prompt = re.sub(r"\(([^:]+):([^:]+):\d+(\.\d+)?\)", r"\1, \2", prompt)

    # (A:1.21) -> A
    prompt = re.sub(r"\(([^:]+):\d+(\.\d+)?\)", r"\1", prompt)

    # [A|B|C] -> A, B, C
    prompt = re.sub(r"\[([^\]]+)\]", lambda m: ", ".join(m.group(1).split("|")), prompt)

    # (A) -> A
    prompt = re.sub(r"\(([^()]+)\)", r"\1", prompt)

    # A: 1.21 -> A
    prompt = re.sub(r"([^:]+):\s*\d+(\.\d+)?", r"\1", prompt)

    # Cleanup: Remove occurrences of ', ,'
    prompt = re.sub(r",[ ]+,", ", ", prompt)

    # Free '|' -> removed
    prompt = prompt.replace("|", "")

    # Remove remaining brackets
    prompt = prompt.replace("(", "").replace(")", "")
    prompt = prompt.replace("[", "").replace("]", "")

    # ':' not followed by digit or space-digit -> removed
    prompt = re.sub(r":(?![ \d])", "", prompt)

    # Remove BREAK
    prompt = prompt.replace("BREAK", "")

    # Normalize commas spacing
    prompt = re.sub(r"\s*,\s*", ", ", prompt)

    prompt = re.sub("bracket_open", r"(", prompt)
    prompt = re.sub("bracket_close", r")", prompt)

    # Cleanup odd patterns and numbers
    prompt = re.sub(r",\s*:\d+(\.\d+)?,", ", ", prompt)  # ', :0.2, '
    prompt = re.sub(r",\s*\d+(\.\d+)?,", ", ", prompt)   # ', 0.7, '
    prompt = re.sub(r"^,|,$", "", prompt)                # leading/trailing comma
    prompt = re.sub(r"^ *, *", "", prompt)
    prompt = re.sub(r" *, *$", "", prompt)

    prompt = re.sub(r"[\n\r]", " ", prompt)
    prompt = re.sub(r", ,", ", ", prompt)
    prompt = re.sub(r"\d+\.\d+", "", prompt)             # remove decimals remaining
    prompt = re.sub(r" +", " ", prompt)                  # collapse spaces
    prompt = re.sub(r",[ ]+,", ",", prompt)

    return prompt.strip()


def extract_prompt_from_parameters_text(parameters_text: str,
                                        exclude_patterns: List[str],
                                        use_original_prompt: bool,
                                        include_all_metadata: bool,
                                        is_flat_prompt: bool) -> str:
    """
    Given the full 'parameters' text, return the caption to write.
    - include_all_metadata: return the whole parameters text as-is.
    - use_original_prompt: return the original 'prompt' section only (no simplification).
    - else: parse and simplify the prompt section.
    """
    if not parameters_text:
        return ""

    # Sanitize any headers or nulls possibly present in EXIF-encoded strings.
    parameters_text = rwm._strip_uc_header_and_nulls_str(parameters_text)

    if include_all_metadata:
        result = parameters_text
        return flat_prompt(result) if is_flat_prompt else result

    # Try to parse with our SD-parameters parser
    try:
        parsed = parse_parameters(parameters_text)
    except Exception:
        # Fallback: treat everything as a raw prompt if parsing fails.
        raw = parameters_text
        return flat_prompt(raw) if is_flat_prompt else raw

    prompt = (parsed.get("prompt") or "").strip()
    if not prompt:
        # If no explicit 'prompt', return entire parameters text
        raw = parameters_text
        return flat_prompt(raw) if is_flat_prompt else raw

    if use_original_prompt:
        result = prompt
    else:
        result = simplify_prompt(prompt, exclude_patterns, is_flat_prompt)

    return result


def get_caption_for_image(image_path: Path,
                          exclude_patterns: List[str],
                          use_original_prompt: bool,
                          include_all_metadata: bool,
                          is_flat_prompt: bool,
                          use_existing_txt: bool) -> str:
    txt_path = image_path.with_suffix(".txt")
    if use_existing_txt and txt_path.exists():
        try:
            return txt_path.read_text(encoding="utf-8")
        except Exception:
            pass

    # Use the unified metadata reader
    meta = rwm.read_metadata(image_path)
    parameters_text = meta.get("parameters") or ""
    if not parameters_text:
        return ""

    return extract_prompt_from_parameters_text(
        parameters_text=parameters_text,
        exclude_patterns=exclude_patterns,
        use_original_prompt=use_original_prompt,
        include_all_metadata=include_all_metadata,
        is_flat_prompt=is_flat_prompt,
    )


def process_image(image_path: Path,
                  progress_bar,
                  lock: threading.Lock,
                  exclude_patterns: List[str],
                  use_original_prompt: bool,
                  include_all_metadata: bool,
                  is_flat_prompt: bool,
                  use_existing_txt: bool) -> None:
    try:
        caption = get_caption_for_image(
            image_path=image_path,
            exclude_patterns=exclude_patterns,
            use_original_prompt=use_original_prompt,
            include_all_metadata=include_all_metadata,
            is_flat_prompt=is_flat_prompt,
            use_existing_txt=use_existing_txt,
        )
        if caption:
            image_path.with_suffix(".txt").write_text(caption, encoding="utf-8")
    except Exception as e:
        print(f"Error processing {image_path}: {e}")
    finally:
        with lock:
            progress_bar.update(1)


def gather_images(root: Path) -> List[Path]:
    exts = {".png", ".jpg", ".jpeg", ".webp"}
    out: List[Path] = []
    for dirpath, _, filenames in os.walk(root):
        d = Path(dirpath)
        for f in filenames:
            if f.lower().endswith(tuple(exts)):
                out.append(d / f)
    return out


def main() -> int:
    parser = argparse.ArgumentParser(description="Extract captions from image metadata using read_write_metadata.py")
    parser.add_argument("directory", type=str, help="Directory containing images to process")
    parser.add_argument("--use_original_prompt", action="store_true", default=False, help="Use original 'prompt' section verbatim")
    parser.add_argument("--include_all_metadata", action="store_true", default=False, help="Write full 'parameters' text to the caption")
    parser.add_argument("--flat_prompt", action="store_true", default=False, help="Flatten newlines into commas")
    parser.add_argument("--exclude_patterns", type=str, nargs="*", default=[], help="Regex patterns to remove from prompts before simplification")
    parser.add_argument("--use_existing_txt", action="store_true", default=False, help="If a .txt exists next to the image, reuse it")

    args = parser.parse_args()

    root = Path(args.directory)
    if not root.is_dir():
        print(f"Error: {root} is not a valid directory.")
        return 1

    images = gather_images(root)
    lock = threading.Lock()

    with tqdm(total=len(images), desc="Processing images") as progress_bar:
        threads: List[threading.Thread] = []
        for image_path in images:
            t = threading.Thread(
                target=process_image,
                name="process_image",
                args=(
                    image_path,
                    progress_bar,
                    lock,
                    args.exclude_patterns,
                    args.use_original_prompt,
                    args.include_all_metadata,
                    args.flat_prompt,
                    args.use_existing_txt,
                ),
            )
            threads.append(t)
            t.start()

            # Limit concurrency
            if len(threads) >= 5:
                for tt in threads:
                    tt.join()
                threads = []

        for tt in threads:
            tt.join()

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
