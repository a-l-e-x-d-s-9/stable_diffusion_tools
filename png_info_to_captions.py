import argparse
import re
import string
import os
import argparse
import sys
import threading
from tqdm import tqdm
# from PIL import Image

from PIL import Image
from PIL.ExifTags import TAGS
from PIL.PngImagePlugin import PngImageFile


def read_image_metadata(image_path):
    with Image.open(image_path) as img:
        metadata = {}
        if img.format == "PNG":
            if not isinstance(img, PngImageFile):
                raise ValueError("Not a valid PNG image")
            pnginfo = img.info
            for k, v in pnginfo.items():
                metadata[k] = v
        elif img.format in ["JPEG", "JPG"]:
            exif_data = img._getexif()
            if exif_data is None:
                raise ValueError("No EXIF data found in the JPEG image")
            for tag, value in exif_data.items():
                tag_name = TAGS.get(tag, tag)

                # Handle the UserComment tag
                if tag_name == "UserComment" and isinstance(value, bytes):
                    prefix = value[:8]
                    if b'UNICODE' in prefix:
                        try:
                            value = value[8:].decode('utf-8', errors='ignore')
                        except UnicodeDecodeError:
                            value = value[8:].decode('utf-16', errors='ignore')

                metadata[tag_name] = value
        else:
            raise ValueError(f"Unsupported image format: {img.format}")

    return metadata


def diagnose_value(value):
    # Print type of value
    print(f"Type of value: {type(value)}")

    # If the value is bytes, attempt to detect encoding
    if isinstance(value, bytes):
        for encoding in ['utf-8', 'utf-16', 'latin-1', 'ascii']:
            try:
                decoded = value.decode(encoding)
                print(f"Decoded successfully with {encoding}.")
                value = decoded  # Update value to the decoded string for further diagnostics
                break
            except UnicodeDecodeError:
                print(f"Failed to decode with {encoding}")

    # Print first and last 50 characters
    print(f"First 50 characters: {value[:50]}")
    print(f"Last 50 characters: {value[-50:]}")

    # Look for any invisible or control characters
    invis_chars = [char for char in value if char < ' ' and char not in ('\n', '\t', '\r')]
    if invis_chars:
        print(f"Found invisible/control characters: {invis_chars}")
    else:
        print("No invisible or control characters found.")


allowed_chars = set(string.printable + '\t\n\r')


def remove_invisible_characters(s):
    # Retain characters that are in the allowed set
    return ''.join(ch for ch in s if ch in allowed_chars)


def parse_parameters(value):
    # Split by the "Steps:" keyword to separate the prompt and negative prompt from other parameters
    # print(f"rfind: {value}")

    # value = value.replace("\x00", "")
    value = remove_invisible_characters(value)
    # diagnose_value(value)
    steps_index = value.rfind("Steps:")

    if steps_index < 0:
        raise ValueError("Invalid format: 'Steps:' keyword not found.")

    prompt_and_neg_prompt = value[:steps_index].strip()
    other_params = value[steps_index:]

    # Find the last occurrence of "Negative prompt:" to separate prompt and negative prompt
    neg_prompt_index = prompt_and_neg_prompt.rfind("Negative prompt:")
    if neg_prompt_index == -1:
        raise ValueError("Invalid format: 'Negative prompt:' keyword not found.")

    prompt = prompt_and_neg_prompt[:neg_prompt_index].strip().replace("parameters:", "").strip()
    negative_prompt = prompt_and_neg_prompt[neg_prompt_index:].replace("Negative prompt:", "").strip()

    # Process other key-value pairs
    kv_pairs = [kv.strip() for kv in other_params.split(",") if kv]
    kv_dict = {}
    for kv in kv_pairs:
        k, *rest = kv.split(":")
        v = ":".join(rest).strip()
        kv_dict[k.strip()] = v

    # Combine all in a dictionary
    result = {
        "prompt": prompt,
        "Negative prompt": negative_prompt
    }
    result.update(kv_dict)

    return result


import re


# TODO: 1. remove new lines. 2. Remove everything within <> - loras. 3. handle numbers left as part of tags.

def simplify_prompt(prompt, exclude_patterns):
    # First, apply exclude_patterns to remove unwanted text
    for pattern in exclude_patterns:
        prompt = re.sub(pattern, '', prompt)

    prompt = re.sub(r'\(:0\)', '', prompt)
    prompt = re.sub(r'\( :0\)', ' ', prompt)

    prompt = re.sub(r'\\\(', 'bracket_open', prompt)
    prompt = re.sub(r'\\\)', 'bracket_close', prompt)

    # Case 8: Insert comma after closing brackets if not followed by a comma and followed by non-closing bracket text
    prompt = re.sub(r'(?<=\))([^,\s\])])', r',\1', prompt)
    prompt = re.sub(r'(?<=\])([^,\s\])])', r',\1', prompt)

    # Case Remove lora:
    prompt = re.sub(r'<[^>]+>', '', prompt)

    # Case 1: (A:B:1.21) -> A, B
    prompt = re.sub(r'\(([^:]+):([^:]+):\d+(\.\d+)?\)', r'\1, \2', prompt)

    # Case 2: (A:1.21) -> A
    prompt = re.sub(r'\(([^:]+):\d+(\.\d+)?\)', r'\1', prompt)

    # Case 3 and 4: [A|B] or [A|B|C] -> A, B or A, B, C
    prompt = re.sub(r'\[([^]]+)\]', lambda m: ', '.join(m.group(1).split('|')), prompt)

    # Case 5: (A) -> A
    prompt = re.sub(r'\(([^()]+)\)', r'\1', prompt)

    # Case 6: A: 1.21 -> A
    prompt = re.sub(r'([^:]+):\s*\d+(\.\d+)?', r'\1', prompt)
    # prompt = re.sub(r'(?<!\()([^:]+):\s*\d+(\.\d+)?', r'\1', prompt)

    # Case 7: \( and \) are left untouched
    # No action needed since regular expressions won't match escaped characters by default

    # Cleanup: Remove occurrences of ", ,"
    prompt = re.sub(r',[ ]+,', ', ', prompt)

    # Case 9: Free | -> removed
    prompt = prompt.replace('|', '')

    # Case 10 and 11: Remove "(" or ")" and "[" or "]" removed
    prompt = prompt.replace('(', '').replace(')', '')

    prompt = prompt.replace('[', '').replace(']', '')

    # Case 12: ":" without a following number - removed
    prompt = re.sub(r':(?![ \d])', '', prompt)

    # Case 14: BREAK - removed
    prompt = prompt.replace('BREAK', '')

    # Cleanup: Remove spaces around commas
    prompt = re.sub(r'\s*,\s*', ', ', prompt)

    prompt = re.sub('bracket_open', r'\(', prompt)
    prompt = re.sub('bracket_close', r'\)', prompt)

    # Cleanup:
    prompt = re.sub(r',\s*:\d+(\.\d+)?,', ', ', prompt)  # Remove ", :0.2, " patterns
    prompt = re.sub(r',\s*\d+(\.\d+)?,', ', ', prompt)  # Remove ", 0.7, " patterns
    prompt = re.sub(r'^,|,$', '', prompt)  # Remove leading or trailing commas

    # Remove new lines
    prompt = re.sub(r'[\n\r]', ' ', prompt)

    prompt = re.sub(r', ,', ', ', prompt)  # Remove occurrences of ", ,"

    # Remove remaining numbers
    prompt = re.sub(r'\d+\.\d+', '', prompt)

    # Case 13: Double spaces removed
    prompt = re.sub(r' +', ' ', prompt)

    prompt = re.sub(r',[ ]+,', ',', prompt)

    return prompt.strip()


# Test
# prompt = "(photorealistic:1.21), [A|B], test: 1.21, \(escaped\), extra ( spaces ) here, BREAK, unbalanced)bracket"
# print(simplify_prompt(prompt))

def get_simplified_prompt(image_path, exclude_patterns, use_original_prompt):
    try:
        metadata = read_image_metadata(image_path)
        value = metadata.get('parameters') or metadata.get('UserComment')
        if not value:
            return ""
        generation_settings = parse_parameters(value)
        extracted_prompt = generation_settings.get('prompt', '')
        prompt_to_use = extracted_prompt
        if not use_original_prompt:
            prompt_to_use = simplify_prompt(extracted_prompt, exclude_patterns)

        return prompt_to_use
    except Exception as e:
        print(f"Error processing {image_path}: {e}")
        return ""


def process_image(image_path, progress_bar, exclude_patterns, use_original_prompt):
    try:
        prompt = get_simplified_prompt(image_path, exclude_patterns, use_original_prompt)
        if prompt:
            txt_path = os.path.splitext(image_path)[0] + '.txt'
            with open(txt_path, 'w') as txt_file:
                txt_file.write(prompt)
    except Exception as e:
        print(f"Error processing {image_path}: {e}")
    finally:
        with progress_bar_lock:
            progress_bar.update(1)


def main(directory, exclude_patterns, use_original_prompt):
    image_files = []

    # Using os.walk to get all image files from subfolders
    for dirpath, dirnames, filenames in os.walk(directory):
        for f in filenames:
            if f.lower().endswith(('.png', '.jpg', '.jpeg')):
                image_files.append(os.path.join(dirpath, f))

    with tqdm(total=len(image_files), desc="Processing images") as progress_bar:
        threads = []
        for image_path in image_files:
            thread = threading.Thread(target=process_image, name="process_image", args=(image_path, progress_bar, exclude_patterns, use_original_prompt))
            threads.append(thread)
            thread.start()

            # Join threads in case the number goes beyond a threshold (e.g., 5) to manage memory
            if len(threads) >= 5:
                for thread in threads:
                    thread.join()
                threads = []

        # Join any remaining threads
        for thread in threads:
            thread.join()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Process some images.")
    parser.add_argument("directory", type=str, help="Directory containing images to process")
    parser.add_argument('--use_original_prompt', action='store_true', help='Store whole prompt as is.')
    parser.add_argument("--exclude_patterns", type=str, nargs='*', default=[], help="Regex patterns to exclude files")

    args = parser.parse_args()

    if not os.path.isdir(args.directory):
        print(f"Error: {args.directory} is not a valid directory.")
        sys.exit(1)

    progress_bar_lock = threading.Lock()
    main(args.directory, args.exclude_patterns, args.use_original_prompt)

# python3 png_info_to_captions.py dataset/
