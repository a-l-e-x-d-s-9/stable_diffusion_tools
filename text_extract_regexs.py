import argparse
import re

# Create the argument parser
parser = argparse.ArgumentParser(description='Extract instances of a regex pattern from a text file.')
parser.add_argument('--filepath', metavar='FILE', type=str, help='the path to the file to search')
parser.add_argument('--pattern', metavar='PATTERN', type=str, help='the regular expression pattern to search for')
parser.add_argument('--output', metavar='OUTPUT_FILE', type=str, help='the path to the file to save matches to')

# Parse the command line arguments
args = parser.parse_args()

try:
    with open(args.filepath, 'r') as file:
        contents = file.read()
        matches = re.findall(args.pattern, contents)
        if args.output:
            with open(args.output, 'w') as output_file:
                for match in matches:
                    output_file.write(f"{match}\n")
            print(f"Matches saved to {args.output}.")
        print(f"Found {len(matches)} matches.")
except FileNotFoundError:
    print(f"File {args.filepath} not found.")


# Ususage example: python3 text_extract_regexs.py --filepath test_links_extraction.html --pattern 'https://cdni.pornpics.com/[^"]+'  --output test_links_extracted.txt

# convert to links: search "([^\n]+)/([^\n]+)\.jpg" , output "<a href="$1/$2.jpg">$2.jpg</a>"