import argparse
import concurrent.futures
import json
import os
import re
import sys
from urllib.parse import parse_qs, urlparse

import requests

TIMEOUT = 30
MAX_LIMIT = 200
DEFAULT_WORKERS = 10


class CivitaiError(Exception):
    pass


def load_api_key(json_path):
    if not os.path.exists(json_path):
        raise CivitaiError(f"File not found: {json_path}")

    try:
        with open(json_path, "r", encoding="utf-8") as file:
            data = json.load(file)
    except json.JSONDecodeError as e:
        raise CivitaiError(f"Invalid JSON file: {e}") from e

    api_key = data.get("api_key")
    if not api_key:
        raise CivitaiError("API key not found in the JSON file.")
    return api_key


def parse_model_id(value):
    if value is None:
        return None

    raw = str(value).strip()
    if not raw:
        return None

    if raw.isdigit():
        return int(raw)

    # Supports urls such as:
    # https://civitai.com/models/12345/foo
    # https://civitai.com/models/12345
    m = re.search(r"/models/(\d+)(?:[/?#]|$)", raw)
    if m:
        return int(m.group(1))

    # Fallback: if the entire string contains a single integer token, use it.
    m = re.fullmatch(r".*?(\d+).*", raw)
    if m and raw.count("/") == 0:
        return int(m.group(1))

    raise CivitaiError(
        "Could not parse model id. Pass either a numeric model id or a model URL like https://civitai.com/models/12345/..."
    )


def build_headers(api_key):
    return {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "User-Agent": "civitai-download-user-images/2.0",
    }


def safe_get_json(session, endpoint, params, headers):
    try:
        response = session.get(endpoint, params=params, headers=headers, timeout=TIMEOUT)
    except requests.Timeout as e:
        raise CivitaiError(f"Timeout while fetching data from server after {TIMEOUT} seconds.") from e
    except requests.RequestException as e:
        raise CivitaiError(f"Failed to fetch data due to a request exception: {e}") from e

    if response.status_code != 200:
        try:
            payload = response.json()
        except Exception:
            payload = None

        error_message = None
        if isinstance(payload, dict):
            error_message = (
                payload.get("error", {})
                .get("issues", [{}])[0]
                .get("message")
                or payload.get("message")
            )
        if not error_message:
            error_message = f"HTTP {response.status_code}"

        raise CivitaiError(f"Failed to fetch data. Server error: {error_message}")

    try:
        return response.json()
    except json.JSONDecodeError as e:
        raise CivitaiError("Server response was not valid JSON.") from e


def extract_next_page_from_url(next_page_url):
    if not next_page_url:
        return None
    query = urlparse(next_page_url).query
    page_values = parse_qs(query).get("page")
    if not page_values:
        return None
    try:
        return int(page_values[0])
    except (TypeError, ValueError):
        return None


def fetch_image_data(username, api_key, model_id=None, sort="Newest", nsfw="X"):
    endpoint = "https://civitai.com/api/v1/images"
    image_data = []
    headers = build_headers(api_key)

    page = 1
    cursor = None
    request_index = 0

    with requests.Session() as session:
        while True:
            params = {
                "limit": MAX_LIMIT,
                "username": username,
                "sort": sort,
                "nsfw": nsfw,
            }
            if model_id is not None:
                params["modelId"] = model_id

            # Support both documented page-based pagination and older cursor-based behavior.
            if cursor is not None:
                params["cursor"] = cursor
            else:
                params["page"] = page

            data = safe_get_json(session, endpoint, params, headers)
            items = data.get("items", [])
            metadata = data.get("metadata", {})

            image_data.extend(items)
            print(f"Fetching[{request_index}]: {len(items)} items")
            request_index += 1

            next_cursor = metadata.get("nextCursor")
            if next_cursor:
                cursor = next_cursor
                continue

            next_page = extract_next_page_from_url(metadata.get("nextPage"))
            if next_page:
                page = next_page
                continue

            # Fallback if metadata provides totalPages/currentPage.
            current_page = metadata.get("currentPage")
            total_pages = metadata.get("totalPages")
            if isinstance(current_page, int) and isinstance(total_pages, int) and current_page < total_pages:
                page = current_page + 1
                continue

            break

    # Defensive client-side filter only when the payload actually surfaces model ids.
    if model_id is not None:
        surfaced_any_model_id = False
        filtered = []
        for item in image_data:
            meta = item.get("meta") or {}
            resources = meta.get("resources") or []
            item_model_ids = {
                r.get("modelId")
                for r in resources
                if isinstance(r, dict) and r.get("modelId") is not None
            }
            direct_model_id = item.get("modelId")
            if direct_model_id is not None or item_model_ids:
                surfaced_any_model_id = True
            if direct_model_id == model_id or model_id in item_model_ids:
                filtered.append(item)

        if surfaced_any_model_id:
            image_data = filtered

    return image_data


EXT_BY_CONTENT_TYPE = {
    "image/jpeg": ".jpeg",
    "image/jpg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/gif": ".gif",
    "video/mp4": ".mp4",
}


def guess_extension(item, response):
    url = item.get("url", "")
    parsed_path = urlparse(url).path
    _, ext = os.path.splitext(parsed_path)
    if ext:
        return ext

    content_type = response.headers.get("Content-Type", "").split(";")[0].strip().lower()
    return EXT_BY_CONTENT_TYPE.get(content_type, ".bin")


def sanitize_folder_name(name):
    safe = re.sub(r"[^A-Za-z0-9._-]+", "_", name.strip())
    return safe.strip("._") or "unnamed"


def build_output_dir(base_target, item, split_by_post=False):
    if not split_by_post:
        return base_target

    post_id = item.get("postId")
    folder = f"post_{post_id}" if post_id is not None else "post_unknown"
    return os.path.join(base_target, sanitize_folder_name(folder))


def write_json(path, payload):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2, sort_keys=True)


def download_images(image_data, target_folder, split_by_post=False, workers=DEFAULT_WORKERS):
    os.makedirs(target_folder, exist_ok=True)

    def download_image(item):
        image_id = item["id"]
        item_output_dir = build_output_dir(target_folder, item, split_by_post=split_by_post)
        os.makedirs(item_output_dir, exist_ok=True)

        metadata_filename = os.path.join(item_output_dir, f"{image_id}.metadata.json")
        prompt_filename = os.path.join(item_output_dir, f"{image_id}.txt")

        try:
            with requests.get(item["url"], stream=True, timeout=TIMEOUT) as image_response:
                if image_response.status_code != 200:
                    raise CivitaiError(
                        f"Failed to download item {image_id}. HTTP status: {image_response.status_code}"
                    )

                ext = guess_extension(item, image_response)
                item_filename = os.path.join(item_output_dir, f"{image_id}{ext}")

                if not os.path.isfile(item_filename):
                    with open(item_filename, "wb") as image_file:
                        for chunk in image_response.iter_content(chunk_size=1024 * 64):
                            if chunk:
                                image_file.write(chunk)

        except requests.Timeout as e:
            raise CivitaiError(f"Timeout while downloading item {image_id} after {TIMEOUT} seconds.") from e
        except requests.RequestException as e:
            raise CivitaiError(f"Request exception while downloading item {image_id}: {e}") from e

        write_json(metadata_filename, item)

        prompt_text = (item.get("meta") or {}).get("prompt")
        if prompt_text:
            with open(prompt_filename, "w", encoding="utf-8") as text_file:
                text_file.write(prompt_text)

    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as executor:
        futures = [executor.submit(download_image, item) for item in image_data]
        for future in concurrent.futures.as_completed(futures):
            future.result()


def write_file_lists(image_data, target_folder, username, split_by_post=False):
    if split_by_post:
        grouped = {}
        for item in image_data:
            post_id = item.get("postId")
            grouped.setdefault(post_id, []).append(item)

        for post_id, items in grouped.items():
            subdir = build_output_dir(target_folder, {"postId": post_id}, split_by_post=True)
            os.makedirs(subdir, exist_ok=True)
            filelist = os.path.join(subdir, f"post_{post_id if post_id is not None else 'unknown'}_filelist.txt")
            with open(filelist, "w", encoding="utf-8") as f:
                for item in items:
                    f.write(f"{item['id']}\n")
    else:
        filelist = os.path.join(target_folder, f"{username}_filelist.txt")
        with open(filelist, "w", encoding="utf-8") as f:
            for item in image_data:
                f.write(f"{item['id']}\n")


def build_parser():
    parser = argparse.ArgumentParser(
        description=(
            "Download images from Civitai for a user, or only that user's images for a specific model."
        )
    )
    parser.add_argument("--username", type=str, required=True, help="The Civitai username to fetch images for.")
    parser.add_argument("--target_path", type=str, required=True, help="The target folder to download items into.")
    parser.add_argument(
        "--api_key_json",
        type=str,
        required=True,
        help="Path to the JSON file containing the API key under the key 'api_key'.",
    )
    parser.add_argument(
        "--mode",
        type=str,
        default="user",
        choices=["user", "user-model"],
        help=(
            "user: download all images by the user into one folder. "
            "user-model: download only images by the user for a specific model and split output by post."
        ),
    )
    parser.add_argument(
        "--model",
        type=str,
        help="Required for --mode user-model. Accepts either a numeric model id or a model URL.",
    )
    parser.add_argument(
        "--workers",
        type=int,
        default=DEFAULT_WORKERS,
        help=f"Number of concurrent downloads. Default: {DEFAULT_WORKERS}",
    )
    parser.add_argument(
        "--nsfw",
        type=str,
        default="X",
        help="NSFW filter passed to the API. Examples seen in practice: None, Soft, Mature, X.",
    )
    parser.add_argument(
        "--sort",
        type=str,
        default="Newest",
        choices=["Newest", "Most Reactions", "Most Comments"],
        help="Sort order for the API request.",
    )
    return parser


def main():
    parser = build_parser()
    args = parser.parse_args()

    if args.workers < 1:
        raise CivitaiError("--workers must be at least 1.")

    split_by_post = args.mode == "user-model"
    model_id = None
    if split_by_post:
        if not args.model:
            raise CivitaiError("--model is required when --mode user-model is used.")
        model_id = parse_model_id(args.model)

    api_key = load_api_key(args.api_key_json)
    os.makedirs(args.target_path, exist_ok=True)

    image_data = fetch_image_data(
        username=args.username,
        api_key=api_key,
        model_id=model_id,
        sort=args.sort,
        nsfw=args.nsfw,
    )

    if not image_data:
        print("No items found.")
        return

    write_file_lists(image_data, args.target_path, args.username, split_by_post=split_by_post)
    download_images(
        image_data,
        args.target_path,
        split_by_post=split_by_post,
        workers=args.workers,
    )
    print(f"Done. Downloaded {len(image_data)} items.")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        sys.exit(str(e))
