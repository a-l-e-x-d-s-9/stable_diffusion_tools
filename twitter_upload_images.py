import tweepy
import os
import sys
import json
import time
import tempfile
import random
from tweepy import TweepyException
from PIL import Image
import argparse

def resize_image(image_path, output_path, scale_factor):
    with Image.open(image_path) as img:
        # Check if image has alpha channel (transparency)
        if img.mode == 'RGBA':
            # Convert to RGB
            img = img.convert('RGB')

        new_size = tuple(int(dim * scale_factor) for dim in img.size)
        img = img.resize(new_size, Image.LANCZOS)
        img.save(output_path, quality=95)


def prepare_image(image_path):
    max_size = 700 * 1024  # 700 KB
    scale_factor = 0.9

    # Initialize temp_file to None
    temp_file = None

    # Open the image to check its format and size
    with Image.open(image_path) as img:
        if img.format not in ['JPEG', 'JPG']:
            # Convert non-JPG images to JPG
            temp_file = tempfile.NamedTemporaryFile(delete=False, suffix='.jpg')
            temp_file.close()

            # Convert to RGB if necessary (for images with alpha channel)
            if img.mode == 'RGBA':
                img = img.convert('RGB')

            img.save(temp_file.name, format='JPEG', quality=95)
            image_path = temp_file.name

        # Check if temp_file was created; if not, create a new temp file for resizing
        if not temp_file:
            temp_file = tempfile.NamedTemporaryFile(delete=False, suffix='.jpg')
            temp_file.close()

        current_size = os.path.getsize(image_path)

        # If the image is already small enough, return the converted path or original path
        if current_size <= max_size:
            return image_path

        # Resize if still too large
        while current_size > max_size:
            resize_image(image_path, temp_file.name, scale_factor)
            current_size = os.path.getsize(temp_file.name)
            scale_factor *= 0.9

        return temp_file.name

def load_json_file(filename):
    try:
        with open(filename, 'r') as file:
            return json.load(file)
    except FileNotFoundError:
        sys.exit(f"Error: The file '{filename}' was not found.")
    except json.JSONDecodeError:
        sys.exit("Error: Invalid JSON file format.")

def make_message_for_tweet(common_message, specific_message, tags_probability):
    # tags_probability is 0 to 1.0
    # tags_probability controlling the words that would be used from common_message
    # Rules:
    # 1. First word in common_message always used
    # 2. Words can be separated by spaces or new line, the character before word need to be included when added to combined_message
    # 3. The probability 0 means that only first word from common_message included
    # 4. The probability 1 means that all words from common_message included
    # 5. The probability (0,1.0) means the independent probability of each word to be included.
    # 6. combined_message starting with words from common_message, then specific_message always included
    # Example:
    # common_message="#door gate /here/path/ sit pipe", specific_message=" always here", tags_probability=0.5
    # selected_words_from_common_message: By the rules, "#door" must be added as first word.
    # selected_words_from_common_message: 0.5 probability for " gate" - not selected
    # selected_words_from_common_message: 0.5 probability for " /here/path/" - selected
    # selected_words_from_common_message: 0.5 probability for " sit" - selected
    # selected_words_from_common_message: 0.5 probability for " pipe" - not selected
    # Therefore: selected_words_from_common_message="#door /here/path/ sit"

    # Split common_message into words while keeping separators
    words = []
    current_word = ""
    for char in common_message:
        if char in " \n":
            if current_word:
                words.append(current_word)  # Add the word before the separator
                current_word = ""

        current_word += char

    if current_word:  # Add any remaining word
        words.append(current_word)

    # Always include the first word or separator in the combined message
    combined_message = words[0]

    # Include other words based on tags_probability
    for word in words[1:]:
        if random.random() < tags_probability:
            combined_message += word

    # Always include specific_message
    combined_message += specific_message

    return combined_message

def post_tweet_with_image(api, client, image_path, common_message, specific_message, tags_probability):
    is_published = False
    try:
        prepared_image_path = prepare_image(image_path)
        media = api.media_upload(prepared_image_path)
        message = make_message_for_tweet(common_message, specific_message, tags_probability)
        client.create_tweet(text=message, media_ids=[media.media_id_string])
        print(f"Uploaded: {image_path}")
        is_published = True
        if prepared_image_path != image_path:
            os.remove(prepared_image_path)
    except TweepyException as e:
        print(f"Error posting tweet: {e}")
    return is_published

def read_message_from_file(file_path):
    try:
        with open(file_path, 'r') as file:
            return file.read()
    except IOError:
        return None

def select_entry(entries):
    # Count total images including those in sub-folders
    total_images = sum(len(list(list_image_files(entry['source_folder']))) for entry in entries)
    if total_images == 0:
        return None

    weights = [len(list(list_image_files(entry['source_folder']))) / total_images for entry in entries]

    # Debug: Print weights for each entry
    # for entry, weight in zip(entries, weights):
    #     print(f"Entry: {entry['source_folder']}, Weight: {weight}")

    selected_entry = random.choices(entries, weights=weights, k=1)[0]

    # Debug: Print selected entry
    # print(f"Selected Entry: {selected_entry['source_folder']}")

    return selected_entry

def list_image_files(directory):
    for root, dirs, files in os.walk(directory):
        for file in files:
            if file.lower().endswith(('.png', '.jpg', '.jpeg', '.gif')):
                yield os.path.join(root, file)

def main(settings_file):
    settings = load_json_file(settings_file)
    credentials = load_json_file(settings['credentials_file'])

    auth = tweepy.OAuthHandler(credentials['api_key'], credentials['api_secret_key'])
    auth.set_access_token(credentials['access_token'], credentials['access_token_secret'])
    api = tweepy.API(auth)

    # Corrected initialization of tweepy.Client
    client = tweepy.Client(
        consumer_key=credentials['api_key'],
        consumer_secret=credentials['api_secret_key'],
        access_token=credentials['access_token'],
        access_token_secret=credentials['access_token_secret']
    )

    while True:
        settings = load_json_file(settings_file)  # Reload settings
        entry = select_entry(settings['entries'])
        if not entry:
            print("No images found in any source folders.")
            break

        image_folder = entry['source_folder']
        published_folder = entry['published_folder']
        common_message = read_message_from_file(entry['text_file']) or ""

        if not os.path.isdir(image_folder):
            sys.exit(f"Error: '{image_folder}' is not a directory.")

        image_files = sorted(list(list_image_files(image_folder)))
        if entry['random_order']:
            random.shuffle(image_files)

        if not os.path.exists(published_folder):
            os.makedirs(published_folder)

        is_found_image = False

        for image_path in image_files:
            specific_text_file = os.path.splitext(image_path)[0] + '.txt'
            specific_message = read_message_from_file(specific_text_file) or ""
            #message = common_message + specific_message
            tags_probability = entry['tags_probability']
            is_found_image = True

            if post_tweet_with_image(api, client, image_path, common_message, specific_message, tags_probability):
                # Handle sub-folder structure
                sub_folder_structure = os.path.relpath(os.path.dirname(image_path), image_folder)
                published_sub_folder = os.path.join(published_folder, sub_folder_structure)

                if not os.path.exists(published_sub_folder):
                    os.makedirs(published_sub_folder)

                published_image_path = os.path.join(published_sub_folder, os.path.basename(image_path))
                os.rename(image_path, published_image_path)

                if os.path.exists(specific_text_file):
                    published_text_file = os.path.join(published_sub_folder, os.path.basename(specific_text_file))
                    os.rename(specific_text_file, published_text_file)

            break  # Remove this if you want to process all images in one go

        if is_found_image:
            wait_seconds = settings['interval']
            # Countdown timer
            interval_minutes = wait_seconds // 60
            if interval_minutes > 0:
                for remaining in range(interval_minutes, 0, -1):
                    plural = "" if remaining == 0 else "s"
                    sys.stdout.write(
                        f"\rNext upload in: {remaining} minute{plural}    ")  # Extra spaces to clear the line
                    sys.stdout.flush()
                    time.sleep(60)
            else:
                sys.stdout.write(f"\nWaiting {wait_seconds} seconds.")
                time.sleep(wait_seconds)

            sys.stdout.write("\r" + " " * 50 + "\r")  # Clear the line
            sys.stdout.flush()

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description='Post tweets with images.')
    parser.add_argument('--settings', required=True, help='Path to the JSON settings file')
    args = parser.parse_args()
    main(args.settings)

# python3 twitter_upload_images.py --settings path/to/settings.json

# Example of json with credentials. It requires to have an app in twitter developer panel, with access to make tweets.
# {
#   "api_key": "???",
#   "api_secret_key": "???",
#   "access_token": "???",
#   "access_token_secret": "???"
# }

# Example of json with settings:
# {
#   "credentials_file": "path/to/credentials.json",
#   "interval": 60,
#   "entries": [
#     {
#       "source_folder": "path/to/images1",
#       "published_folder": "path/to/published_images1",
#       "text_file": "path/to/common_message1.txt",
#       "random_order": true,
#       "tags_probability": 0.5
#     },
#     // More entries...
#   ]
# }
