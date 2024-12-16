import requests
import argparse
import json
import os


def load_api_key(json_path):
    """
    Load the API key from the specified JSON file.

    Args:
        json_path (str): Path to the JSON file containing the API key.

    Returns:
        str: The API key.
    """
    if not os.path.exists(json_path):
        print(f"Error: File not found: {json_path}")
        exit(1)

    try:
        with open(json_path, "r") as file:
            data = json.load(file)
            api_key = data.get("api_key")
            if not api_key:
                print("Error: API key not found in the JSON file.")
                exit(1)
            return api_key
    except json.JSONDecodeError:
        print("Error: Invalid JSON file.")
        exit(1)


def get_model_by_id(model_id, api_key):
    """
    Fetch a model by its ID from the CivitAI API.

    Args:
        model_id (int): The ID of the model.
        api_key (str): The API key for authentication.

    Returns:
        dict: The model details if the request is successful.
    """
    url = f"https://civitai.com/api/v1/models/{model_id}"
    headers = {
        "Authorization": f"Bearer {api_key}"
    }

    try:
        response = requests.get(url, headers=headers)
        response.raise_for_status()
        return response.json()
    except requests.exceptions.RequestException as e:
        #print(f"Error fetching model {model_id}: {e}")
        return None


def display_model_info(model):
    """
    Display model details including versions.

    Args:
        model (dict): The model data.
    """
    model_id = model.get("id", "Unknown ID")
    model_name = model.get("name", "Unknown Model")
    owner = model.get("creator", {}).get("username", "Unknown Owner")
    #print(f"\nModel ID: {model_id} | Name: {model_name} | Owner: {owner}")

    if "Unknown Owner" == owner:
        print(f"Model ID: {model_id} | Name: {model_name} | Owner: {owner}")

    # Display versions
    if (False):
        versions = model.get("modelVersions", [])
        if versions:
            print("  Versions:")
            for version in versions:
                version_id = version.get("id", "Unknown Version ID")
                version_name = version.get("name", "Unnamed Version")
                print(f"    - Version ID: {version_id} | Version Name: {version_name}")
        else:
            print("  No versions found for this model.")


def main():
    # Set up argument parsing
    parser = argparse.ArgumentParser(description="Fetch models by ID range from CivitAI API.")
    parser.add_argument("--start", type=int, required=True, help="Starting model ID (inclusive).")
    parser.add_argument("--end", type=int, required=True, help="Ending model ID (inclusive).")
    parser.add_argument("--api_key_json", type=str, required=True, help="Path to the JSON file containing the API key.")

    args = parser.parse_args()

    # Load API key
    api_key = load_api_key(args.api_key_json)

    # Fetch and display models within the range
    for model_id in range(args.start, args.end + 1):
        #print(f"\nFetching model with ID: {model_id}")
        model = get_model_by_id(model_id, api_key)
        if model:
            display_model_info(model)
        else:
            pass
            #print(f"Model ID {model_id} not found or could not be fetched.")


if __name__ == "__main__":
    main()
