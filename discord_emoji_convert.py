#!/usr/bin/env python3
"""Convert emoji shortcodes and Unicode emoji in files, stdin, or a prompt."""

import argparse
from contextlib import ExitStack
import json
import re
import sys

try:
    import emoji
except ModuleNotFoundError:
    emoji = None

SHORTCODE_RE = re.compile(r":[A-Za-z0-9_+\-]+:")


def require_emoji():
    if emoji is None:
        raise RuntimeError(
            "The emoji package is required. Install it in this Python environment "
            "with 'python -m pip install emoji'."
        )

def load_custom_map(path):
    if not path:
        return {}
    with open(path, "r", encoding="utf-8-sig") as f:
        data = json.load(f)
    if not isinstance(data, dict):
        raise ValueError("Custom map must be a JSON object mapping shortcode names to strings.")
    fixed = {}
    for k, v in data.items():
        if not isinstance(v, str):
            raise ValueError(f"Custom map value for '{k}' must be a string.")
        key = f":{k.strip(':')}:"
        if not SHORTCODE_RE.fullmatch(key):
            raise ValueError(f"Invalid custom shortcode name: '{k}'.")
        if key in fixed:
            raise ValueError(f"Duplicate custom shortcode after normalization: '{key}'.")
        fixed[key] = v
    return fixed

def apply_custom_map(text, custom_map):
    if not custom_map:
        return text
    def repl(m):
        token = m.group(0)
        return custom_map.get(token, token)
    return SHORTCODE_RE.sub(repl, text)

def to_emoji(text, custom_map, strict):
    require_emoji()
    # apply custom overrides first
    text = apply_custom_map(text, custom_map)

    # pass 1 - GitHub/Slack-style aliases (handles :notes:, :dancer:, etc.)
    out = emoji.emojize(text, language="alias", delimiters=(":", ":"), variant=None)

    # pass 2 - CLDR English names (handles :people_with_bunny_ears_partying:, etc.)
    out = emoji.emojize(out, language="en", delimiters=(":", ":"), variant=None)

    if strict:
        out = SHORTCODE_RE.sub(lambda m: f"[UNRESOLVED{m.group(0)}]", out)

    return out



def to_shortcode(text):
    require_emoji()
    return emoji.demojize(text, language="en", delimiters=(":", ":"))

def convert(text, custom_map, reverse, strict):
    return to_shortcode(text) if reverse else to_emoji(text, custom_map, strict)

def interactive_loop(custom_map, reverse, strict, output=None):
    output = sys.stdout if output is None else output
    mode = "emoji <- :shortcodes:" if not reverse else ":shortcodes: <- emoji"
    print(f"[emoji_convert] Interactive mode ({mode}). Ctrl-C or Ctrl-D to exit.")
    while True:
        try:
            line = input("> ")
        except EOFError:
            print()
            break
        except KeyboardInterrupt:
            print()
            break
        if not line.strip():
            continue
        print(convert(line, custom_map, reverse, strict), file=output)
        output.flush()

def main(argv=None):
    p = argparse.ArgumentParser(description="Convert Discord-style shortcodes to emojis and back.")
    p.add_argument("-i", "--input", help="Input file path (default stdin or interactive if TTY)")
    p.add_argument("-o", "--output", help="Output file path, including interactive results (default stdout)")
    p.add_argument("--custom", help="Path to JSON mapping of ':name:' -> 'emoji char'")
    p.add_argument("--reverse", action="store_true", help="Convert emojis to :shortcodes: instead")
    p.add_argument("--strict", action="store_true", help="Mark unresolved shortcodes as [UNRESOLVED:name:]")
    p.add_argument("--once", action="store_true", help="Prompt once for a single line and print the result")
    args = p.parse_args(argv)

    try:
        require_emoji()
        custom_map = load_custom_map(args.custom)

        # Read and convert batch input before opening the output, so input and
        # output may safely name the same file and invalid input cannot erase it.
        if args.input:
            with open(args.input, "r", encoding="utf-8-sig") as source:
                text = source.read()
        elif not sys.stdin.isatty():
            text = sys.stdin.read()
        else:
            text = None
        converted = convert(text, custom_map, args.reverse, args.strict) if text is not None else None

        with ExitStack() as stack:
            output = stack.enter_context(open(args.output, "w", encoding="utf-8")) if args.output else sys.stdout
            if converted is not None:
                output.write(converted)
            elif args.once:
                try:
                    line = input("> ")
                except EOFError:
                    return 0
                print(convert(line, custom_map, args.reverse, args.strict), file=output)
            else:
                interactive_loop(custom_map, args.reverse, args.strict, output)
    except (OSError, UnicodeError, ValueError, RuntimeError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print(file=sys.stderr)
        return 130
    return 0

if __name__ == "__main__":
    sys.exit(main())
