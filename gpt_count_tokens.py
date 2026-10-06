"""Count tokens locally in a UTF-8 text file using a tiktoken encoding."""

import argparse
from pathlib import Path
import sys


def count_tokens_in_file(file_path, encoding_name="cl100k_base"):
    # Read before loading the tokenizer so a bad path never triggers a download.
    # utf-8-sig also accepts ordinary UTF-8 and strips an optional byte-order mark.
    text = Path(file_path).read_text(encoding="utf-8-sig")

    try:
        import tiktoken
    except ModuleNotFoundError as error:
        raise RuntimeError(
            f"Missing dependency: {error.name}. "
            "Install tiktoken in this Python environment with "
            "'python -m pip install tiktoken'."
        ) from error

    available = tiktoken.list_encoding_names()
    if encoding_name not in available:
        raise ValueError(
            f"Unknown encoding '{encoding_name}'. Available encodings: "
            + ", ".join(available)
        )

    try:
        tokenizer = tiktoken.get_encoding(encoding_name)
    except Exception as error:
        raise RuntimeError(
            f"Could not load encoding '{encoding_name}': {error}. "
            "The first use needs internet access to download its vocabulary. "
            "For offline use, set TIKTOKEN_CACHE_DIR to a directory containing "
            "the previously downloaded vocabulary."
        ) from error

    # Treat special-token-looking strings as ordinary file content.
    return len(tokenizer.encode(text, disallowed_special=()))


def main(argv=None):
    parser = argparse.ArgumentParser(description="Count tokens in a UTF-8 text file.")
    parser.add_argument("-f", "--file", required=True, help="Path to the text file.")
    parser.add_argument(
        "-e", "--encoding", default="cl100k_base",
        help="The tiktoken encoding name (default: cl100k_base).",
    )
    args = parser.parse_args(argv)

    try:
        num_tokens = count_tokens_in_file(args.file, args.encoding)
    except (OSError, UnicodeError, ValueError, RuntimeError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 1

    print(f"The file {args.file} contains {num_tokens} tokens.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
