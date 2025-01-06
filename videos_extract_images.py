import os
import subprocess
import argparse

# Function to check if a file is a video
VIDEO_EXTENSIONS = {'.mp4', '.mkv', '.avi', '.mov', '.flv', '.wmv'}
def is_video_file(filename):
    return any(filename.lower().endswith(ext) for ext in VIDEO_EXTENSIONS)

# Function to extract frames from a video
def extract_frames(video_path, output_dir, interval):
    # Get video filename without extension
    video_name = os.path.splitext(os.path.basename(video_path))[0]

    # Build the output file format
    output_format = os.path.join(output_dir, f"{video_name}_%04d.jpg")

    # FFmpeg command to extract frames
    ffmpeg_command = [
        "ffmpeg",
        "-i", video_path,
        "-vf", f"fps=1/{interval}",  # Extract one frame every `interval` seconds
        "-q:v", "2",  # Set JPEG quality (2 is highest quality, equivalent to 95%)
        output_format
    ]

    # Run the FFmpeg command
    print(f"Processing video: {video_path}")
    try:
        subprocess.run(ffmpeg_command, check=True)
        print(f"Frames extracted successfully for {video_path}")
    except subprocess.CalledProcessError as e:
        print(f"Error extracting frames for {video_path}: {e}")

# Main function
if __name__ == "__main__":
    # Parse arguments
    parser = argparse.ArgumentParser(description="Extract frames from videos in a folder at specified intervals.")
    parser.add_argument("--folder", type=str, required=True, help="Path to the folder containing video files.")
    parser.add_argument("--interval", type=float, required=True, help="Interval in seconds between extracted frames.")
    parser.add_argument("--output", type=str, required=True, help="Path to the folder where frames will be saved.")

    args = parser.parse_args()

    # Validate input folder
    if not os.path.isdir(args.folder):
        print(f"Error: The folder {args.folder} does not exist.")
        exit(1)

    # Validate output folder
    if not os.path.exists(args.output):
        os.makedirs(args.output)

    # Iterate through files in the folder
    for filename in os.listdir(args.folder):
        file_path = os.path.join(args.folder, filename)

        # Check if the file is a video
        if os.path.isfile(file_path) and is_video_file(filename):
            # Extract frames for the video
            extract_frames(file_path, args.output, args.interval)
        else:
            print(f"Skipping non-video file: {filename}")


# python videos_extract_images.py --folder /path/to/videos --interval 5 --output /path/to/output