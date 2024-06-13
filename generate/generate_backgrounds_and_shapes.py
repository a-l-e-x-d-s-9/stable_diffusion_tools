import os
import random
from PIL import Image, ImageDraw
from tqdm import tqdm
import numpy as np
# Create directories if they do not exist
os.makedirs("solid_colors", exist_ok=True)
os.makedirs("shapes", exist_ok=True)
os.makedirs("combined_images", exist_ok=True)

# List of resolutions
resolutions = [(1440, 1440)]

# List of solid colors with their names, hex values, and amounts
colors = [
    {"name": "white", "aliases": ["white"], "hex": "#FFFFFF", "amount": 5},
    {"name": "black", "aliases": ["black"], "hex": "#000000", "amount": 5},
    
    {"name": "red", "aliases": ["red"], "hex": "#FF0000", "amount": 1},
    {"name": "crimson", "aliases": ["crimson"], "hex": "#DC143C", "amount": 1},
    {"name": "dark red", "aliases": ["dark red"], "hex": "#8B0000", "amount": 1},
    {"name": "light red", "aliases": ["light red"], "hex": "#FF6347", "amount": 1},
    {"name": "coral color", "aliases": ["coral color"], "hex": "#FF7F50", "amount": 1},
    
    {"name": "orange color", "aliases": ["orange color"], "hex": "#FFA500", "amount": 1},
    {"name": "amber color", "aliases": ["amber color"], "hex": "#FFBF00", "amount": 1},
    {"name": "yellow", "aliases": ["yellow"], "hex": "#FFFF00", "amount": 1},
    {"name": "gold color", "aliases": ["gold color"], "hex": "#FFD700", "amount": 1},
    {"name": "peach color", "aliases": ["peach color"], "hex": "#FFDAB9", "amount": 1},
    {"name": "khaki color", "aliases": ["khaki color"], "hex": "#F0E68C", "amount": 1},

    {"name": "green", "aliases": ["green"], "hex": "#00FF00", "amount": 1},
    {"name": "lime color", "aliases": ["lime color"], "hex": "#32CD32", "amount": 1},
    {"name": "dark green", "aliases": ["dark green"], "hex": "#006400", "amount": 1},
    {"name": "emerald color", "aliases": ["emerald color"], "hex": "#50C878", "amount": 1},
    {"name": "mint color", "aliases": ["mint color"], "hex": "#98FF98", "amount": 1},
    {"name": "sea green color", "aliases": ["sea green color"], "hex": "#2E8B57", "amount": 1},
    
    {"name": "aqua", "aliases": ["aqua"], "hex": "#00FFFF", "amount": 1},
    {"name": "cyan", "aliases": ["cyan"], "hex": "#00FFFF", "amount": 1},
    {"name": "turquoise", "aliases": ["turquoise"], "hex": "#40E0D0", "amount": 1},
    {"name": "sky blue color", "aliases": ["sky blue color"], "hex": "#87CEEB", "amount": 1},
    {"name": "light blue", "aliases": ["light blue"], "hex": "#ADD8E6", "amount": 1},
    {"name": "blue", "aliases": ["blue"], "hex": "#0000FF", "amount": 1},
    {"name": "cerulean", "aliases": ["cerulean"], "hex": "#007BA7", "amount": 1},
    {"name": "dark blue", "aliases": ["dark blue"], "hex": "#00008B", "amount": 1},
    {"name": "navy", "aliases": ["navy"], "hex": "#000080", "amount": 1},
    {"name": "sapphire color", "aliases": ["sapphire color"], "hex": "#0F52BA", "amount": 1},
    {"name": "indigo", "aliases": ["indigo"], "hex": "#4B0082", "amount": 1},

    {"name": "violet", "aliases": ["violet"], "hex": "#EE82EE", "amount": 1},
    {"name": "lavender color", "aliases": ["lavender color"], "hex": "#E6E6FA", "amount": 1},
    {"name": "periwinkle", "aliases": ["periwinkle"], "hex": "#CCCCFF", "amount": 1},
    {"name": "purple", "aliases": ["purple"], "hex": "#800080", "amount": 1},
    {"name": "magenta", "aliases": ["magenta"], "hex": "#FF00FF", "amount": 1},
    {"name": "hot pink", "aliases": ["hot pink"], "hex": "#FF69B4", "amount": 1},
    {"name": "pink", "aliases": ["pink"], "hex": "#FFC0CB", "amount": 1},

    {"name": "brown", "aliases": ["brown"], "hex": "#A52A2A", "amount": 1},
    {"name": "maroon", "aliases": ["maroon"], "hex": "#800000", "amount": 1},
    {"name": "olive color", "aliases": ["olive color"], "hex": "#808000", "amount": 1},
    {"name": "teal", "aliases": ["teal"], "hex": "#008080", "amount": 1},

    {"name": "gray", "aliases": ["gray"], "hex": "#808080", "amount": 1},
    {"name": "dark gray", "aliases": ["dark gray"], "hex": "#A9A9A9", "amount": 1},
    {"name": "dim gray", "aliases": ["dim gray"], "hex": "#696969", "amount": 1},
    {"name": "light gray", "aliases": ["light gray"], "hex": "#D3D3D3", "amount": 1},
    {"name": "gainsboro", "aliases": ["gainsboro"], "hex": "#DCDCDC", "amount": 1},
    {"name": "slate gray", "aliases": ["slate gray"], "hex": "#708090", "amount": 1},
    {"name": "silver", "aliases": ["silver"], "hex": "#C0C0C0", "amount": 1},
    {"name": "ivory color", "aliases": ["ivory color"], "hex": "#FFFFF0", "amount": 1},
    
    {"name": "chartreuse", "aliases": ["chartreuse"], "hex": "#7FFF00", "amount": 1},
    {"name": "royal blue", "aliases": ["royal blue"], "hex": "#4169E1", "amount": 1},
    {"name": "beige", "aliases": ["beige"], "hex": "#F5F5DC", "amount": 1}

]

shapes = ["square", "triangle", "circle", "parallel_lines", "rectangle", "pentagon"]
basic_colors = ["#FFFFFF", "#000000", "#FFFFFF", "#000000", "#FF0000", "#00FF00", "#0000FF", "#808080"]

# Function to generate solid color images
def generate_solid_color_images():
    for color in colors:
        for i in range(color["amount"]):
            for resolution in resolutions:
                img = Image.new('RGB', resolution, color['hex'])
                concatenated_aliases_for_filename = (",".join([s + " background" for s in color['aliases']])).replace(' ', '_')
                index_string = ""
                if i != 0:
                    index_string = f"_{i+1}"
                    
                img_path_and_name = f"solid_colors/{concatenated_aliases_for_filename}{index_string}"
                img_name = f"{img_path_and_name}.png"
                img.save(img_name)
                
                # Create a TXT file with color name and hex value
                txt_name = f"{img_path_and_name}.txt"
                
                with open(txt_name, 'w') as txt_file:
                    text_content = ", ".join([s + " background" for s in color['aliases']]) + f", {color['hex']} background"
                    txt_file.write(text_content)


# Function to create shapes with transparent backgrounds
def create_shapes():
    for shape in shapes:
        for color in basic_colors:
            for resolution in resolutions:
                line_width = random.randint(20, 150)  # Line width as a percentage of the resolution
                img = Image.new('RGBA', resolution, (255, 255, 255, 0))
                draw = ImageDraw.Draw(img)
                margin = resolution[0] // 10

                if shape == "square":
                    draw.rectangle([margin, margin, resolution[0] - margin, resolution[1] - margin], outline=color, width=line_width)
                elif shape == "triangle":
                    draw.polygon([resolution[0] // 2, margin, resolution[0] - margin, resolution[1] - margin, margin, resolution[1] - margin], outline=color, width=line_width)
                elif shape == "circle":
                    draw.ellipse([margin, margin, resolution[0] - margin, resolution[1] - margin], outline=color, width=line_width)
                elif shape == "parallel_lines":
                    draw.line([margin, resolution[1] // 3, resolution[0] - margin, resolution[1] // 3], fill=color, width=line_width)
                    draw.line([margin, 2 * resolution[1] // 3, resolution[0] - margin, 2 * resolution[1] // 3], fill=color, width=line_width)
                elif shape == "rectangle":
                    draw.rectangle([margin, resolution[1] // 4, resolution[0] - margin, 3 * resolution[1] // 4], outline=color, width=line_width)
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

                    # Adjust the points slightly for better connections
                    #points = [(int(x), int(y)) for x, y in points]
                    draw.polygon(points, outline=color, width=line_width)

                if line_width <= 55:
                    line_category = "thin"
                elif line_width <= 90:
                    line_category = "normal"
                else:
                    line_category = "thick"
                ###color_name = color in colors where
                img.save(f"shapes/{shape}_{color}_{line_category}_line_{line_width}px.png") # img.save(f"shapes/{shape}_{color[1:]}_{line_width}px_{resolution[0]}x{resolution[1]}.png")

# Function to rotate shapes
def rotate_shapes():
    for shape_file in os.listdir("shapes"):
        shape_path = os.path.join("shapes", shape_file)
        img = Image.open(shape_path)

        for angle in [90, 180, 270]:
            rotated_img = img.rotate(angle, expand=True)
            rotated_img.save(f"shapes/{shape_file[:-4]}_{angle}deg.png")


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

        shape_color = shape_file.split('_')[1]
        shape_color_name = get_color_name_by_hex(f"{shape_color}")

        if color['hex'][1:].upper() == shape_color.upper():
            continue

        combination_key = (color['name'], shape_file, resolution, rotation)
        if combination_key in combinations:
            continue

        combinations.add(combination_key)
        pbar.update(1)

        bg_img = Image.new('RGB', resolution, color['hex'])
        shape_img = Image.open(os.path.join("shapes", shape_file)).resize(resolution, Image.ANTIALIAS).rotate(rotation, expand=True)

        combined_img = bg_img.copy()
        combined_img.paste(shape_img, (0, 0), shape_img)

        combined_name = f"{shape_file[:-4]}_{rotation}deg_{color['name']}_#{color['hex'][1:]}_bg.png"
        combined_img.save(f"combined_images/{combined_name}")

        # Create a TXT file with combined image details
        txt_name = f"combined_images/{combined_name[:-4]}.txt"
        with open(txt_name, 'w') as txt_file:
            shape_name = shape_file.split('_')[0]
            text_content = f"{shape_color_name} {shape_name}, {color['name']} background, {color['hex']} background"
            txt_file.write(text_content)

    pbar.close()



# Main function to run all tasks
def main():
    generate_solid_color_images()
    create_shapes()
    ##rotate_shapes()
    combine_images(10)  # Set the desired number of combinations

if __name__ == "__main__":
    main()

#python3 generate_backgrounds_and_shapes.py
