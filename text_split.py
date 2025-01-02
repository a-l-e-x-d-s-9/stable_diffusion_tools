import os
import argparse


def split_file(input_file, lines=None, size=None, parts=None):
    def human_readable_to_bytes(size_str):
        units = {"kb": 1024, "mb": 1024 * 1024}
        size_str = size_str.lower()
        if any(unit in size_str for unit in units):
            for unit, factor in units.items():
                if unit in size_str:
                    return int(size_str.replace(unit, "")) * factor
        raise ValueError("Invalid size format. Use 'kb' or 'mb'.")

    def write_chunk(lines_buffer, file_number):
        output_file = f"{base_name}_{file_number:02d}{ext}"
        with open(output_file, 'w', encoding='utf-8') as out_f:
            out_f.writelines(lines_buffer)

    if not os.path.exists(input_file):
        raise FileNotFoundError(f"The file {input_file} does not exist.")

    base_name, ext = os.path.splitext(input_file)
    max_size = human_readable_to_bytes(size) if size else None

    if parts:
        total_size = os.path.getsize(input_file)
        max_size = total_size // parts

    file_number = 0
    lines_buffer = []
    current_size = 0

    with open(input_file, 'r', encoding='utf-8') as in_f:
        while True:
            chunk = in_f.read(1024 * 1024)  # Read in 1MB chunks
            if not chunk:
                break

            lines_in_chunk = chunk.splitlines(keepends=True)

            for line in lines_in_chunk:
                lines_buffer.append(line)
                current_size += len(line.encode('utf-8'))

                if (lines and len(lines_buffer) >= lines) or (max_size and current_size >= max_size):
                    write_chunk(lines_buffer, file_number)
                    file_number += 1
                    lines_buffer = []
                    current_size = 0

        if lines_buffer:
            write_chunk(lines_buffer, file_number)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Split a large text file into smaller files.")
    parser.add_argument("input_file", type=str, help="Path to the input text file.")
    parser.add_argument("--lines", type=int, help="Number of lines per split.")
    parser.add_argument("--size", type=str, help="Size per split (e.g., '100kb', '5mb').")
    parser.add_argument("--parts", type=int, help="Number of parts to split the file into.")

    args = parser.parse_args()

    if not args.lines and not args.size and not args.parts:
        parser.error("You must specify either --lines, --size, or --parts.")

    split_file(args.input_file, args.lines, args.size, args.parts)
