import os
import subprocess
import argparse


def call_overlay_script(input_folder, overlay_folder, base_output_folder, num_images, threads, prefix):
    overlay_images = [f for f in os.listdir(overlay_folder) if f.lower().endswith(('png', 'jpg', 'jpeg'))]

    for overlay_image in overlay_images:
        overlay_image_path = os.path.join(overlay_folder, overlay_image)
        output_folder = os.path.join(base_output_folder, os.path.splitext(overlay_image)[0])

        if not os.path.exists(output_folder):
            os.makedirs(output_folder)

        # Construct the command to call overlay_images.py
        command = [
            'python', 'images_add_overlay.py',
            '--input_folder', input_folder,
            '--output_folder', output_folder,
            '--overlay_image', overlay_image_path,
            '--threads', str(threads),
            '--num_images', str(num_images)
            #,'--prefix', prefix
        ]

        print(f"Executing command: {' '.join(command)}")
        subprocess.run(command)


def main():
    parser = argparse.ArgumentParser(description="Call overlay_images.py script for each overlay image in a folder.")
    parser.add_argument('--input_folder', required=True, help="Folder with images to edit.")
    parser.add_argument('--overlay_folder', required=True, help="Folder with overlay images.")
    parser.add_argument('--base_output_folder', required=True, help="Base folder to save edited images.")
    parser.add_argument('--num_images', type=int, default=0,
                        help="Number of random images to process (0 means all images).")
    parser.add_argument('--threads', type=int, default=4, help="Number of threads to use.")
    parser.add_argument('--prefix', type=str, default="", help="Prefix to add to output images and associated files.")

    args = parser.parse_args()

    call_overlay_script(
        input_folder=args.input_folder,
        overlay_folder=args.overlay_folder,
        base_output_folder=args.base_output_folder,
        num_images=args.num_images,
        threads=args.threads,
        prefix=args.prefix
    )


if __name__ == "__main__":
    main()
