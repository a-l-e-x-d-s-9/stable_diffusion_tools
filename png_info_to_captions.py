import argparse
import re
import string
import os
import sys
import threading
from tqdm import tqdm
from PIL import Image
from PIL.ExifTags import TAGS
from PIL.PngImagePlugin import PngImageFile

def read_image_metadata(image_path):
    with Image.open(image_path) as img:
        metadata = {}
        if img.format in ["PNG"]:
            if not isinstance(img, PngImageFile):
                raise ValueError("Not a valid PNG image")
            pnginfo = img.info
            for k, v in pnginfo.items():
                metadata[k] = v
        elif img.format in ["JPEG", "JPG", "WEBP"]:
            exif_data = img._getexif()
            if exif_data is None:
                raise ValueError("No EXIF data found in the JPEG image")
            for tag, value in exif_data.items():
                tag_name = TAGS.get(tag, tag)
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

allowed_chars = set(string.printable + '\t\n\r')

def remove_invisible_characters(s):
    return ''.join(ch for ch in s if ch in allowed_chars)

def parse_parameters(value):
    value = remove_invisible_characters(value)
    steps_index = value.rfind("Steps:")
    if steps_index < 0:
        raise ValueError("Invalid format: 'Steps:' keyword not found.")
    prompt_and_neg_prompt = value[:steps_index].strip()
    other_params = value[steps_index:]
    neg_prompt_index = prompt_and_neg_prompt.rfind("Negative prompt:")
    if neg_prompt_index == -1:
        raise ValueError("Invalid format: 'Negative prompt:' keyword not found.")
    prompt = prompt_and_neg_prompt[:neg_prompt_index].strip().replace("parameters:", "").strip()
    negative_prompt = prompt_and_neg_prompt[neg_prompt_index:].replace("Negative prompt:", "").strip()
    kv_pairs = [kv.strip() for kv in other_params.split(",") if kv]
    kv_dict = {}
    for kv in kv_pairs:
        k, *rest = kv.split(":")
        v = ":".join(rest).strip()
        kv_dict[k.strip()] = v
    result = {
        "prompt": prompt,
        "Negative prompt": negative_prompt
    }
    result.update(kv_dict)
    return result

def simplify_prompt(prompt, exclude_patterns, is_flat_prompt):
    # First, apply exclude_patterns to remove unwanted text
    for pattern in exclude_patterns:
        prompt = re.sub(pattern, '', prompt)

    if is_flat_prompt:
        prompt = flat_prompt(prompt)

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
    prompt = re.sub(r'^ *, *', '', prompt)  # Remove leading
    prompt = re.sub(r' *, *$', '', prompt)  # Remove trailing

    # Remove new lines
    prompt = re.sub(r'[\n\r]', ' ', prompt)

    prompt = re.sub(r', ,', ', ', prompt)  # Remove occurrences of ", ,"

    # Remove remaining numbers
    prompt = re.sub(r'\d+\.\d+', '', prompt)

    # Case 13: Double spaces removed
    prompt = re.sub(r' +', ' ', prompt)

    prompt = re.sub(r',[ ]+,', ',', prompt)

    return prompt.strip()

def get_prompt(image_path, exclude_patterns, use_original_prompt, include_all_metadata):
    try:
        metadata = read_image_metadata(image_path)
        value = metadata.get('parameters') or metadata.get('UserComment') or metadata.get('User Comment')
        if not value:
            return ""
        generation_settings = parse_parameters(value)
        extracted_prompt = generation_settings.get('prompt', '')
        prompt_to_use = extracted_prompt

        if include_all_metadata:
            prompt_to_use = value

        return prompt_to_use
    except Exception as e:
        print(f"Error processing {image_path}: {e}")
        return ""

def flat_prompt(text):
    return text.replace('\n', ', ')

def process_image(image_path, progress_bar, exclude_patterns, use_original_prompt, include_all_metadata, is_flat_prompt, use_existing_txt):
    try:
        txt_path = os.path.splitext(image_path)[0] + '.txt'
        if use_existing_txt and os.path.exists(txt_path):
            with open(txt_path, 'r') as txt_file:
                prompt = txt_file.read()
        else:
            prompt = get_prompt(image_path, exclude_patterns, use_original_prompt, include_all_metadata)

        if prompt:
            if not include_all_metadata and not use_original_prompt:
                prompt = simplify_prompt(prompt, exclude_patterns, is_flat_prompt)

            if is_flat_prompt:
                prompt = flat_prompt(prompt)
            with open(txt_path, 'w') as txt_file:
                txt_file.write(prompt)
    except Exception as e:
        print(f"Error processing {image_path}: {e}")
    finally:
        with progress_bar_lock:
            progress_bar.update(1)

def main(directory, exclude_patterns, use_original_prompt, include_all_metadata, flat_prompt, use_existing_txt):
    image_files = []
    for dirpath, dirnames, filenames in os.walk(directory):
        for f in filenames:
            if f.lower().endswith(('.png', '.jpg', '.jpeg', '.webp')):
                image_files.append(os.path.join(dirpath, f))
    with tqdm(total=len(image_files), desc="Processing images") as progress_bar:
        threads = []
        for image_path in image_files:
            thread = threading.Thread(target=process_image, name="process_image", args=(image_path, progress_bar, exclude_patterns, use_original_prompt, include_all_metadata, flat_prompt, use_existing_txt))
            threads.append(thread)
            thread.start()
            if len(threads) >= 5:
                for thread in threads:
                    thread.join()
                threads = []
        for thread in threads:
            thread.join()

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Process some images.")
    parser.add_argument("directory", type=str, help="Directory containing images to process")
    parser.add_argument('--use_original_prompt', action='store_true', default=False, help='use_original_prompt')
    parser.add_argument('--include_all_metadata', action='store_true', default=False, help='include_all_metadata')
    parser.add_argument('--flat_prompt', action='store_true', default=False, help='flat_prompt')
    parser.add_argument("--exclude_patterns", type=str, nargs='*', default=[], help="Regex patterns to exclude in files")
    parser.add_argument('--use_existing_txt', action='store_true', default=False, help='Use existing TXT files if available')

    args = parser.parse_args()
    if not os.path.isdir(args.directory):
        print(f"Error: {args.directory} is not a valid directory.")
        sys.exit(1)
    progress_bar_lock = threading.Lock()
    main(args.directory, args.exclude_patterns, args.use_original_prompt, args.include_all_metadata, args.flat_prompt, args.use_existing_txt)

# python3 png_info_to_captions.py dataset/
