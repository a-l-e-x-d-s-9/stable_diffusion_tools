import os
import json
import argparse
from datetime import datetime


# List of fields to be extracted and processed in the text file
FIELDS_TO_EXTRACT = ["name", "description", "tags", "watermark", "user", "camera", "lens", "location", "taken_at"]


def extract_field_values_from_json(json_data):
    """
    Extracts the values of specified fields from the JSON data.
    Returns a list of non-empty field values.
    """
    extracted_values = []

    author_name = ""

    for field in FIELDS_TO_EXTRACT:
        if field in json_data:
            field_value = json_data[field]

            # Check for "tags" specifically being a list of strings
            if field == 'user':
                user_data = field_value
                if "fullname" in user_data and isinstance(user_data["fullname"], str):
                    author_name = user_data["fullname"].strip()
                elif "displayName" in user_data and isinstance(user_data["displayName"], str):
                    author_name = user_data["displayName"].strip()
            elif field == "taken_at" and "taken_at" in json_data:
                taken_at_value = json_data["taken_at"]
                try:
                    if isinstance(taken_at_value, str):
                        # Parse the date string and format it as "photography taken on YYYY.MM.DD"
                        date_obj = datetime.strptime(taken_at_value, "%Y-%m-%dT%H:%M:%S%z")
                        formatted_date = date_obj.strftime("%Y.%m.%d")
                        extracted_values.append(f"photography taken on {formatted_date}")
                    else:
                        print(f"Invalid date format or missing value for 'taken_at' in {field_value}")
                except (ValueError, TypeError) as e:
                    print(f"Error parsing date for 'taken_at' in {field_value}: {e}")
            elif field == 'camera' or field == 'lens' or field == 'location':
                if isinstance(field_value, str) and field_value.strip():
                    extracted_values.append(f"{field} {field_value.strip()}")
            elif field == 'watermark':
                if isinstance(field_value, bool):
                    if field_value:  # If True, add 'watermark'
                        extracted_values.append('watermark')
            elif isinstance(field_value, list):
                if all(isinstance(tag, str) for tag in field_value):
                    extracted_values.append(", ".join(field_value))
            # Check other fields if they are strings and not empty
            elif isinstance(field_value, str) and field_value.strip():
                extracted_values.append(field_value.strip())

    if author_name:
        extracted_values.insert(0, f"photography by {author_name}")

    return extracted_values



def process_json_file(json_file_path):
    """
    Processes a single JSON file to extract the required fields.
    If valid fields are found, it writes them to a corresponding text file.
    """
    try:
        with open(json_file_path, 'r', encoding='utf-8') as json_file:
            data = json.load(json_file)
            extracted_values = extract_field_values_from_json(data)
            if extracted_values:
                save_extracted_values_to_text_file(json_file_path, extracted_values)
    except Exception as e:
        # Ignore any errors such as file reading or JSON parsing errors
        print(f"Error processing file {json_file_path}: {e}")


def save_extracted_values_to_text_file(json_file_path, extracted_values):
    """
    Saves the extracted values to a text file, removing image extensions and the .json suffix.
    """
    # Remove the image extension and .json extension
    base_name = json_file_path
    for ext in ['.jpeg', '.jpg', '.png', '.gif', '.bmp', '.webp']:  # Add more image extensions if needed
        if base_name.lower().endswith(ext + '.json'):
            base_name = base_name[:-len(ext + '.json')]
            break
    if base_name.endswith('.json'):
        base_name = base_name[:-5]  # Remove the ".json" part if no image extension found

    text_file_path = base_name + '.txt'

    try:
        with open(text_file_path, 'w', encoding='utf-8') as text_file:
            text_file.write(", ".join(extracted_values))
        #print(f"Extracted values saved to {text_file_path}")
    except Exception as e:
        print(f"Error saving file {text_file_path}: {e}")


def process_directory(directory):
    """
    Recursively processes all JSON files in a directory.
    """
    for root, _, files in os.walk(directory):
        for file in files:
            if file.endswith('.json'):
                json_file_path = os.path.join(root, file)
                process_json_file(json_file_path)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Extract fields from JSON files and save as text.")
    parser.add_argument("--path", required=True, help="Path to the directory to scan for JSON files.")

    args = parser.parse_args()

    if os.path.isdir(args.path):
        process_directory(args.path)
    else:
        print(f"The path {args.path} is not a valid directory.")
