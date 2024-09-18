import os
import random
from PIL import Image, ImageDraw, ImageColor
from tqdm import tqdm
import numpy as np
import argparse

# Create directories if they do not exist
os.makedirs("solid_colors", exist_ok=True)
os.makedirs("shapes", exist_ok=True)
os.makedirs("combined_images", exist_ok=True)

# List of resolutions
resolutions = [(1440, 1440)]

# List of solid colors with their names, hex values, and amounts
colors = [
    {"name": "white", "aliases": ["white"], "hex": "#FFFFFF", "amount": 10},
    {"name": "black", "aliases": ["black"], "hex": "#000000", "amount": 10},

    {"name": "red", "aliases": ["red"], "hex": "#FF0000", "amount": 2},
    {"name": "crimson", "aliases": ["crimson"], "hex": "#DC143C", "amount": 2},
    {"name": "dark red", "aliases": ["dark red"], "hex": "#8B0000", "amount": 2},
    {"name": "light red", "aliases": ["light red"], "hex": "#FF6347", "amount": 2},
    {"name": "coral color", "aliases": ["coral color"], "hex": "#FF7F50", "amount": 2},

    {"name": "orange color", "aliases": ["orange color"], "hex": "#FFA500", "amount": 2},
    {"name": "amber color", "aliases": ["amber color"], "hex": "#FFBF00", "amount": 2},
    {"name": "yellow", "aliases": ["yellow"], "hex": "#FFFF00", "amount": 2},
    {"name": "gold color", "aliases": ["gold color"], "hex": "#FFD700", "amount": 2},
    {"name": "peach color", "aliases": ["peach color"], "hex": "#FFDAB9", "amount": 2},
    {"name": "khaki color", "aliases": ["khaki color"], "hex": "#F0E68C", "amount": 2},

    {"name": "green", "aliases": ["green"], "hex": "#00FF00", "amount": 2},
    {"name": "lime color", "aliases": ["lime color"], "hex": "#32CD32", "amount": 2},
    {"name": "dark green", "aliases": ["dark green"], "hex": "#006400", "amount": 2},
    {"name": "emerald color", "aliases": ["emerald color"], "hex": "#50C878", "amount": 2},
    {"name": "mint color", "aliases": ["mint color"], "hex": "#98FF98", "amount": 2},
    {"name": "sea green color", "aliases": ["sea green color"], "hex": "#2E8B57", "amount": 2},

    {"name": "aqua", "aliases": ["aqua"], "hex": "#00FFFF", "amount": 2},
    {"name": "cyan", "aliases": ["cyan"], "hex": "#00FFFF", "amount": 2},
    {"name": "turquoise", "aliases": ["turquoise"], "hex": "#40E0D0", "amount": 2},
    {"name": "sky blue color", "aliases": ["sky blue color"], "hex": "#87CEEB", "amount": 2},
    {"name": "light blue", "aliases": ["light blue"], "hex": "#ADD8E6", "amount": 2},
    {"name": "blue", "aliases": ["blue"], "hex": "#0000FF", "amount": 2},
    {"name": "cerulean", "aliases": ["cerulean"], "hex": "#007BA7", "amount": 2},
    {"name": "dark blue", "aliases": ["dark blue"], "hex": "#00008B", "amount": 2},
    {"name": "navy", "aliases": ["navy"], "hex": "#000080", "amount": 2},
    {"name": "sapphire color", "aliases": ["sapphire color"], "hex": "#0F52BA", "amount": 2},
    {"name": "indigo", "aliases": ["indigo"], "hex": "#4B0082", "amount": 2},

    {"name": "violet", "aliases": ["violet"], "hex": "#EE82EE", "amount": 2},
    {"name": "lavender color", "aliases": ["lavender color"], "hex": "#E6E6FA", "amount": 2},
    {"name": "periwinkle", "aliases": ["periwinkle"], "hex": "#CCCCFF", "amount": 2},
    {"name": "purple", "aliases": ["purple"], "hex": "#800080", "amount": 2},
    {"name": "magenta", "aliases": ["magenta"], "hex": "#FF00FF", "amount": 2},
    {"name": "hot pink", "aliases": ["hot pink"], "hex": "#FF69B4", "amount": 2},
    {"name": "pink", "aliases": ["pink"], "hex": "#FFC0CB", "amount": 2},

    {"name": "brown", "aliases": ["brown"], "hex": "#A52A2A", "amount": 2},
    {"name": "maroon", "aliases": ["maroon"], "hex": "#800000", "amount": 2},
    {"name": "olive color", "aliases": ["olive color"], "hex": "#808000", "amount": 2},
    {"name": "teal", "aliases": ["teal"], "hex": "#008080", "amount": 2},

    {"name": "gray", "aliases": ["gray"], "hex": "#808080", "amount": 2},
    {"name": "dark gray", "aliases": ["dark gray"], "hex": "#A9A9A9", "amount": 2},
    {"name": "dim gray", "aliases": ["dim gray"], "hex": "#696969", "amount": 2},
    {"name": "light gray", "aliases": ["light gray"], "hex": "#D3D3D3", "amount": 2},
    {"name": "gainsboro", "aliases": ["gainsboro"], "hex": "#DCDCDC", "amount": 2},
    {"name": "slate gray", "aliases": ["slate gray"], "hex": "#708090", "amount": 2},
    {"name": "silver", "aliases": ["silver"], "hex": "#C0C0C0", "amount": 2},
    {"name": "ivory color", "aliases": ["ivory color"], "hex": "#FFFFF0", "amount": 2},

    {"name": "chartreuse", "aliases": ["chartreuse"], "hex": "#7FFF00", "amount": 2},
    {"name": "royal blue", "aliases": ["royal blue"], "hex": "#4169E1", "amount": 2},
    {"name": "beige", "aliases": ["beige"], "hex": "#F5F5DC", "amount": 2}

]

shapes = ["square", "triangle", "circle", "parallel+lines", "rectangle", "pentagon"]
basic_colors = ["#FFFFFF", "#000000", "#FFFFFF", "#000000", "#FF0000", "#00FF00", "#0000FF", "#808080"]


# Function to generate solid color images
def generate_solid_color_images():
    for color in colors:
        for i in range(color["amount"]):
            for resolution in resolutions:
                img = Image.new('RGB', resolution, color['hex'])
                concatenated_aliases_for_filename = (",".join([s + " background" for s in color['aliases']])).replace(
                    ' ', '_')
                index_string = ""
                if i != 0:
                    index_string = f"_{i + 1}"

                img_path_and_name = f"solid_colors/{concatenated_aliases_for_filename}{index_string}"
                img_name = f"{img_path_and_name}.png"
                img.save(img_name)

                # Create a TXT file with color name and hex value
                txt_name = f"{img_path_and_name}.txt"

                with open(txt_name, 'w') as txt_file:
                    text_content = ", ".join(
                        [s + " background" for s in color['aliases']]) + f", {color['hex']} background"
                    txt_file.write(text_content)


# Function to create shapes with transparent backgrounds
def create_shapes():
    for shape in shapes:
        for color in basic_colors:
            for resolution in resolutions:
                for variations in range(3):
                    line_width = random.randint(20, 150)  # Line width as a percentage of the resolution
                    img = Image.new('RGBA', resolution, (255, 255, 255, 0))
                    draw = ImageDraw.Draw(img)
                    margin = resolution[0] // 10

                    if shape == "square":
                        draw.rectangle([margin, margin, resolution[0] - margin, resolution[1] - margin], outline=color,
                                       width=line_width)
                    elif shape == "triangle":
                        draw.polygon(
                            [resolution[0] // 2, margin, resolution[0] - margin, resolution[1] - margin, margin,
                             resolution[1] - margin], outline=color, width=line_width)
                    elif shape == "circle":
                        draw.ellipse([margin, margin, resolution[0] - margin, resolution[1] - margin], outline=color,
                                     width=line_width)
                    elif shape == "parallel+lines":
                        draw.line([margin, resolution[1] // 3, resolution[0] - margin, resolution[1] // 3], fill=color,
                                  width=line_width)
                        draw.line([margin, 2 * resolution[1] // 3, resolution[0] - margin, 2 * resolution[1] // 3],
                                  fill=color, width=line_width)
                    elif shape == "rectangle":
                        draw.rectangle([margin, resolution[1] // 4, resolution[0] - margin, 3 * resolution[1] // 4],
                                       outline=color, width=line_width)
                    elif shape == "pentagon":
                        center_x, center_y = resolution[0] // 2, resolution[1] // 2
                        radius = min(resolution) // 2 - margin
                        points = []

                        for i in range(5):
                            angle = i * 72  # 72 degrees for 5 points
                            x = center_x + radius * np.cos(np.radians(angle - 90))
                            y = center_y + radius * np.sin(np.radians(angle - 90))
                            points.append((x, y))

                        draw.polygon(points, outline=color, width=line_width)
                    elif shape == "star":
                        center_x, center_y = resolution[0] // 2, resolution[1] // 2
                        outer_radius = min(resolution) // 2 - margin
                        inner_radius = outer_radius // 2.5
                        points = []

                        for i in range(10):
                            angle = i * 36  # 36 degrees for 10 points (5 outer, 5 inner)
                            radius = outer_radius if i % 2 == 0 else inner_radius
                            x = center_x + radius * np.cos(np.radians(angle - 90))
                            y = center_y + radius * np.sin(np.radians(angle - 90))
                            points.append((x, y))

                        draw.polygon(points, outline=color, width=line_width)

                    if line_width <= 55:
                        line_category = "thin"
                    elif line_width <= 90:
                        line_category = "normal"
                    else:
                        line_category = "thick"
                    img.save(f"shapes/{shape}_{color}_{line_category}_line_{line_width}px.png")


def get_color_name_by_hex(hex_value):
    for color in colors:
        if color['hex'].lower() == hex_value.lower():
            return color['name']
    return "unknown"


# Function to combine shapes with solid color backgrounds
def combine_images(total_combinations):
    combinations = set()
    pbar = tqdm(total=total_combinations, desc="Generating Combinations")

    while len(combinations) < total_combinations:
        color = random.choice(colors)
        shape_file = random.choice(os.listdir("shapes"))
        resolution = random.choice(resolutions)
        rotation = random.choice([0, 90, 180, 270])

        shape_parts = shape_file.split('_')
        shape_name = shape_parts[0].replace('parallel+lines', 'parallel lines')
        shape_color_hex = shape_parts[1]
        shape_thickness = shape_parts[2] if len(shape_parts) > 2 else "normal"

        # Correct thickness description
        if "thin" in shape_thickness:
            thickness_description = "thin"
        elif "normal" in shape_thickness:
            thickness_description = "normal"
        elif "thick" in shape_thickness:
            thickness_description = "thick"
        else:
            thickness_description = "normal"  # Default if not specified

        shape_color_name = get_color_name_by_hex(f"{shape_color_hex}")

        if color['hex'].upper() == shape_color_hex.upper():
            continue

        combination_key = (color['name'], shape_file, resolution, rotation)
        if combination_key in combinations:
            continue

        combinations.add(combination_key)
        pbar.update(1)

        bg_img = Image.new('RGB', resolution, color['hex'])
        shape_img = Image.open(os.path.join("shapes", shape_file)).resize(resolution, Image.ANTIALIAS).rotate(rotation,
                                                                                                              expand=True)

        combined_img = bg_img.copy()
        combined_img.paste(shape_img, (0, 0), shape_img)

        combined_name = f"{shape_file[:-4]}_{rotation}deg_{color['name']}_{color['hex']}_bg.png"
        combined_img.save(f"combined_images/{combined_name}")

        # Create a TXT file with combined image details
        txt_name = f"combined_images/{combined_name[:-4]}.txt"
        with open(txt_name, 'w') as txt_file:
            text_content = f"{shape_color_name} {shape_name}, {thickness_description} line, {color['name']} background, {color['hex']} background"
            txt_file.write(text_content)

    pbar.close()


# New function to process images in a folder
def process_images_in_folder(folder_path):
    # Recursively scan the folder for images
    for root, dirs, files in os.walk(folder_path):
        for file in files:
            # Check if file is an image
            if file.lower().endswith(('.png', '.jpg', '.jpeg', '.bmp', '.gif', '.tiff', '.webp')):
                image_path = os.path.join(root, file)
                try:
                    with Image.open(image_path) as img:
                        size = img.size
                        format = img.format
                        mode = img.mode
                        info = img.info

                        # Select a color
                        color = random.choice(colors)

                        # Handle different image modes
                        if mode in ('RGB', 'RGBA'):
                            new_img = Image.new(mode, size, color['hex'])
                        elif mode == 'L':
                            # Convert color to grayscale
                            r, g, b = ImageColor.getrgb(color['hex'])
                            gray = int(0.299 * r + 0.587 * g + 0.114 * b)
                            new_img = Image.new('L', size, gray)
                        elif mode == 'P':
                            # Convert to RGB and then to 'P' mode
                            temp_img = Image.new('RGB', size, color['hex'])
                            new_img = temp_img.convert('P', palette=Image.ADAPTIVE)
                        else:
                            # For other modes, convert to 'RGB'
                            new_img = Image.new('RGB', size, color['hex'])

                        # Preserve EXIF data if available
                        if 'exif' in info:
                            exif_data = info['exif']
                            new_img.save(image_path, format=format, exif=exif_data)
                        else:
                            new_img.save(image_path, format=format)

                    # Create or overwrite the TXT file with same name
                    txt_file_name = os.path.splitext(file)[0] + '.txt'
                    txt_file_path = os.path.join(root, txt_file_name)
                    with open(txt_file_path, 'w') as txt_file:
                        txt_file.write(color['name'])

                except Exception as e:
                    print(f"Error processing {image_path}: {e}")


# Main function to run all tasks
def main():
    parser = argparse.ArgumentParser(description='Generate images or process a folder.')
    parser.add_argument('--convert-folder', help='Folder to scan and process images recursively.')
    parser.add_argument('--generate-amount', type=int, default=400, help='How many images to generate.')
    args = parser.parse_args()

    if args.convert_folder:
        process_images_in_folder(args.convert_folder)
    else:
        generate_solid_color_images()
        create_shapes()
        combine_images(args.generate_amount)  # Set the desired number of combinations


if __name__ == "__main__":
    main()

# python3 generate_backgrounds_and_shapes.py
