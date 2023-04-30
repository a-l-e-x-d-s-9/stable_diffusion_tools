import sys
import argparse
import PIL.Image
from PIL import Image
from PIL.ExifTags import TAGS
import io

PIL.Image.MAX_IMAGE_PIXELS = 1000000000
    
def remove_header(value):
    if value.startswith("UNICODE"):
        value = value[len("UNICODE"):]
    return value


def get_exif(image_path):
    try:
        with Image.open(image_path) as img:
            exif_data = img._getexif()
            if exif_data:
                exif = {}
                for tag_id, value in exif_data.items():
                    tag = TAGS.get(tag_id, tag_id)
                    #print(f"TAG: {tag}")
                    if isinstance(value, bytes):
                        try:
                            value = value.decode("utf-8")
                        except UnicodeDecodeError:
                            try:
                                value = value.decode("iso-8859-1")
                            except UnicodeDecodeError:
                                value = value.decode("windows-1252")
                    if tag == "UserComment":
                        value = remove_header(value)
                    
                    exif[tag] = value
                return exif
            else:
                return None
    except Exception as e:
        print(f"Error: {e}")
        return None


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Extract EXIF data from an image.")
    parser.add_argument("--image-path", required=True, help="Path to the image.")
    parser.add_argument("--save-to-file", action="store_true", help="NOT WORKING! Save EXIF data to a file.")
    args = parser.parse_args()

    exif_data = get_exif(args.image_path)

    if exif_data:
        for key, value in exif_data.items():
            if key != "ExifOffset":
                print(f"{value}")

        if args.save_to_file:
            exif_file = f"{args.image_path.split('.')[0]}_exif.txt"
            #with open(exif_file, "w", encoding="utf-8") as f:
                #for key, value in exif_data.items():
                #    if key != "ExifOffset":
                #        f.write(f"{value}")
            #exif_string = '\n'.join(value for key, value in exif_data.items() if key != "ExifOffset")
            #with io.open(exif_file, "w", encoding="utf-16") as f:
             #   f.write(exif_string)
            with io.open(exif_file, "w", encoding="utf-8") as f:
                 
                for key, value in exif_data.items():
                    #exif_string = '\n'.join(value for key, value in exif_data.items() if key != "ExifOffset")
                    if key != "ExifOffset":
                        print(f"KEY: {key}, {value}")
                        f.write(value)
             #with io.open(filename,'w',encoding='utf8') as f:
            #f.write(text)
                        #print(f"AAA: {value}")
            #print(f"Exif data saved to {exif_file}")
            #exif_string = '\n'.join(value for key, value in exif_data.items() if key != "ExifOffset")
            #with io.open(exif_file, "w", encoding="utf-8") as f:
            #    f.write(exif_string)
    else:
        print("No exif data found in image")
