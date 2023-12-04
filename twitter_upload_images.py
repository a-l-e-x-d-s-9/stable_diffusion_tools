import tweepy
import os
import sys
import json
import argparse
import time
from tweepy import TweepyException
from PIL import Image
import tempfile
import random

def resize_image(image_path, output_path, scale_factor):
    with Image.open(image_path) as img:
        # Resizing the image
        new_size = tuple(int(dim * scale_factor) for dim in img.size)
        img = img.resize(new_size, Image.LANCZOS)

        # Saving the resized image
        img.save(output_path, quality=95)  # Adjust the quality as needed

def prepare_image(image_path):
    max_size = 700 * 1024  # 700 KB
    current_size = os.path.getsize(image_path)
    scale_factor = 0.9  # Reduce size by 10% each iteration

    # If the image is already small enough, return the original path
    if current_size <= max_size:
        return image_path

    # Create a temporary file
    temp_file = tempfile.NamedTemporaryFile(delete=False, suffix='.jpg')
    temp_file.close()

    # Iteratively resize the image until it meets the size requirement
    while current_size > max_size:
        resize_image(image_path, temp_file.name, scale_factor)
        current_size = os.path.getsize(temp_file.name)
        scale_factor *= 0.9  # Reduce the scale factor for the next iteration

    return temp_file.name

def load_credentials(filename):
    try:
        with open(filename, 'r') as file:
            return json.load(file)
    except FileNotFoundError:
        sys.exit(f"Error: The file '{filename}' was not found.")
    except json.JSONDecodeError:
        sys.exit("Error: The file format is incorrect. Please provide a valid JSON file.")

def post_tweet_with_image(api, client, image_path, message):
    is_published = False
    try:
        prepared_image_path = prepare_image(image_path)
        media = api.media_upload(prepared_image_path)

        client.create_tweet(text=message, media_ids=[media.media_id_string])
        print(f"Uploaded: {image_path}")
        is_published = True
        # Clean up the temporary file if it was created
        if prepared_image_path != image_path:
            os.remove(prepared_image_path)
    except TweepyException as e:
        print(f"Error posting tweet with image {image_path}: {e}")

    return is_published

def read_message_from_file(file_path):
    try:
        with open(file_path, 'r') as file:
            return file.read()
    except IOError:
        return None

def main(credentials_file, image_folder, text_file, interval, random_order, published_folder):
    credentials = load_credentials(credentials_file)

    # Initialize Tweepy
    auth = tweepy.OAuthHandler(credentials['api_key'], credentials['api_secret_key'])
    auth.set_access_token(credentials['access_token'], credentials['access_token_secret'])
    api = tweepy.API(auth)

    client = tweepy.Client(
        consumer_key=credentials['api_key'],
        consumer_secret=credentials['api_secret_key'],
        access_token=credentials['access_token'],
        access_token_secret=credentials['access_token_secret']
    )

    # Read common tweet message from text file
    common_message = read_message_from_file(text_file)
    if common_message is None:
        sys.exit(f"Error: Could not read file '{text_file}'.")

    # Post tweets with each image in lexicographic order
    if not os.path.isdir(image_folder):
        sys.exit(f"Error: '{image_folder}' is not a directory.")

    check_for_images = True
    while check_for_images:
        image_files = sorted(os.listdir(image_folder))

        # Shuffle the order of the images if the random_order flag is set
        if random_order:
            random.shuffle(image_files)

        if not os.path.exists(published_folder):
            os.makedirs(published_folder)

        any_image_found = False
        file_index = 0
        is_found_image = False
        while (False == is_found_image) and (file_index < len(image_files)):
            image_file = image_files[file_index]

            is_found_image = image_file.lower().endswith(('.png', '.jpg', '.jpeg', '.gif'))
            if is_found_image:
                any_image_found = True
                image_path = os.path.join(image_folder, image_file)

                # Check for specific text file for the image
                specific_text_file = os.path.splitext(image_path)[0] + '.txt'
                specific_message = read_message_from_file(specific_text_file)

                # Construct the final message
                message = common_message + (specific_message if specific_message else "")

                # Post the tweet
                is_published = post_tweet_with_image(api, client, image_path, message)

                if is_published:
                    # Move the image and its corresponding text file
                    published_image_path = os.path.join(published_folder, image_file)
                    os.rename(image_path, published_image_path)

                    if os.path.exists(specific_text_file):
                        published_text_file = os.path.join(published_folder, os.path.basename(specific_text_file))
                        os.rename(specific_text_file, published_text_file)

                # Wait for the specified interval before posting the next image
                time.sleep(interval)

            file_index += 1

        check_for_images = any_image_found

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description='Post tweets with images.')
    parser.add_argument('--credentials', required=True, help='Path to the JSON file with Twitter API credentials')
    parser.add_argument('--image_folder', required=True, help='Path to the folder containing images')
    parser.add_argument('--text_file', required=True, help='Path to the text file containing the common tweet message')
    parser.add_argument('--interval', type=int, default=30, help='Interval in seconds between posting each image (default: 30)')
    parser.add_argument('--random_order', action='store_true', help='Shuffle the order of the images before posting')
    parser.add_argument('--published_folder', required=True,
                        help='Path to the folder where published images will be moved')

    args = parser.parse_args()

    main(args.credentials, args.image_folder, args.text_file, args.interval, args.random_order, args.published_folder)


# python3 twitter_upload_images.py --credentials path/to/credentials.json --image_folder path/to/images --text_file path/to/common_message.txt --interval 60 --published_folder path/to/published_images

# Example of json with credentials. It requires to have an app in twitter developer panel, with access to make tweets.
# {
#   "api_key": "???",
#   "api_secret_key": "???",
#   "access_token": "???",
#   "access_token_secret": "???"
# }