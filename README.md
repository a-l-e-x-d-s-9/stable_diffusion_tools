# Setup
## Create requirements:
``` python
pipreqs .
```

## Install  requirements:
``` python
pip install -r requirements.txt
```

# My articles:
* [Can we identify most Stable Diffusion Model issues with just a few circles?](https://www.reddit.com/r/StableDiffusion/comments/12u6c76/can_we_identify_most_stable_diffusion_model/?utm_source=share&utm_medium=web2x&context=3)
* [Stable Diffusion 2.1 - What is a woman? NSFW Models comparison, no. 1.](https://www.reddit.com/r/unstable_diffusion/comments/zg27jv/stable_diffusion_21_what_is_a_woman_nsfw_models/?utm_source=share&utm_medium=web2x&context=3)
* [Stable Diffusion 2.1 - What is a woman? NSFW Models comparison, no. 2.](https://www.reddit.com/r/unstable_diffusion/comments/zg73ba/stable_diffusion_21_what_is_a_woman_nsfw_models/?utm_source=share&utm_medium=web2x&context=3)
* [Stable Diffusion 2.1 - What is a woman? NSFW Models comparison, no. 3.](https://www.reddit.com/r/unstable_diffusion/comments/zg8cd7/stable_diffusion_21_what_is_a_woman_nsfw_models/?utm_source=share&utm_medium=web2x&context=3)
* [Stable Diffusion 2.1 - What is a woman? NSFW Models comparison, no. 4.](https://www.reddit.com/r/unstable_diffusion/comments/zg971f/stable_diffusion_21_what_is_a_woman_nsfw_models/?utm_source=share&utm_medium=web2x&context=3)
* [SD 2.1 Hands - are they better?](https://www.reddit.com/r/StableDiffusion/comments/zfel6y/sd_21_hands_are_they_better/?utm_source=share&utm_medium=web2x&context=3)
* [Only Hands, comparison of 23 models](https://www.reddit.com/r/StableDiffusion/comments/ze2ooc/stable_hands_hands_comparison_in_23_models/?utm_source=share&utm_medium=web2x&context=3)
* [Only Hands, comparison of 23 models, no. 2](https://www.reddit.com/r/StableDiffusion/comments/zez6y3/only_hands_comparison_of_23_models_no_2/?utm_source=share&utm_medium=web2x&context=3)
* [What is your favorite model?](https://www.reddit.com/r/StableDiffusion/comments/za1bj2/what_is_your_favorite_model/?utm_source=share&utm_medium=web2x&context=3)

# My Stable Diffusion Models:
* [Babes](https://civitai.com/models/2220/babes)
* [Babes Kissable Lips
](https://civitai.com/models/26566/babes-kissable-lips)
* [Sexy Toons feat. Pipa](https://civitai.com/models/35549/sexy-toons-feat-pipa)

# Scripts:

##  [Caption Helper:](captions_helper.py)
### Features:
1. Visual preview of images.
2. Show caption file content for each image.
3. Edit caption text.
4. Add new text after specific comma to all files.
![Caption Helper Preview](readme_files/caption_helper_preview_02.png)

## [Pattern Replacer](pattern_replacer.py)
### Features:
1. Replace multiple patterns at text.
2. Add/remove couples of regex and replacement string.
3. Save/load automatically the state to file.
![Pattern Replacer Preview](readme_files/pattern_replacer_preview_01.png)

## [Civitai Dashboard](civitai_dashboard.py)
### Warning:
* The script not fully debugged. It needs further work. 
### Features:
1. Pull models of user with Civitai API.
2. Plot all models on graph with corresponding downloads per model.
3. Data pulled periodically and saved to local database.
![Civitai Dashboard Preview](readme_files/civitai_dasboard_preview_01.png)

## [File Downloader](file_downloader.py)
### Features:
1. Download files from a list of URLs.

## [Files split to directories](files_split_to_directories_by_date.py)
### Features:
1.  files in a directory by their creation date.

## [Images auto crop](images_auto_crop.py)
### Features:
1.  Crop images by size from each side by pixels.

## [Images auto crop percent](images_auto_crop_percent.py)
### Features:
1.  Crop images from each side by percentage

## [Images downsize and filter small](images_downsize_and_filter_small.py)
### Features:
1.  Resize images in a directory.
2.  Delete images smaller than certain size.

## [Images find bad exif](images_find_bad_exif.py)
### Features:
1.  Check exif data can be read.
2.  Allow to remove exif from images with problematic exif.

## [Images flip horizontal](images_flip.py)
### Features:
1.  Flip images horizontally.
2.  Option to flip randomly with 50% chance.

## [Images rename](images_rename.py)
### Features:
1.  Rename files in folder, use a pattern.

## [Images sort by ratio](images_sort_by_ratio.py)
### TODO:
1. Need a way to concentrate images with similar aspect ratio to common folders.
### Features:
1. Images sort into folders by aspect ratio of the image.

## [Civitai Download](civitai_download.py)
### TODO:
1. Download by model URL or model name.
### Features:
1. Download model from Civitai using list and configuration in the file: [download_config.json](download_config.json).
2. Can download multiple models at same time.

## [Exif Extract](exif_png_read.py)
### TODO:
1. Fix export to file wrong encoding.
### Features:
1. Print Exif info to screen.
## [Auto Upload](auto_upload.py)
### Features:
1. Batch upload files to Hugging Face or Civitai (generic structure).
2. Supports multi-destination uploads.
3. Configurable via JSON settings.

## [Captions Based On File Name](captions_based_on_file_name.py)
### Features:
1. Generate caption files based on image filenames.
2. Replaces underscores with spaces.

## [Captions Based On Folder Name](captions_based_on_folder_name.py)
### Features:
1. Generate caption files based on the parent folder name.

## [Captions Commands](captions_commands.py)
### Features:
1. Batch process caption files.
2. Add, replace, or remove tags/text.

## [Captions Copy From Reference Path](captions_copy_from_reference_path.py)
### Features:
1. Copy caption files from a reference directory to a destination if filenames match.

## [Check Images](check_images.py)
### Features:
1. Scan directory for corrupted images.
2. Identifies images that cannot be opened.

## [Civitai Add Reactions (User Script)](civitai_add_reactions.user.js)
### Features:
1. Add reactions to images on Civitai.

## [Civitai Download Model Images](civitai_download_model_images.py)
### Features:
1. Download images associated with a specific Civitai model.

## [Civitai Download Top Images](civitai_download_top_images.py)
### Features:
1. Download top-rated images from Civitai.

## [Civitai Download User Images](civitai_download_user_images.py)
### Features:
1. Download all images from a specific Civitai user.

## [Civitai Fill Metadata Video (User Script)](civitai_fill_metadata_video.js)
### Features:
1. Automate filling of metadata for video uploads on Civitai.

## [Civitai Scan Models](civitai_scan_models.py)
### Features:
1. Scan local files and match them against Civitai models.

## [Civitai User Browser Script Get Links](civitai_user_browser_script_get_links_as_download_script.js)
### Features:
1. Extract download links from Civitai user page as a shell script.

## [Count Files In Sub Folder](count_files_in_sub_folder.py)
### Features:
1. Count files in subdirectories recursively.

## [Count Resolutions](count_resolutions.py)
### Features:
1. Count images by their resolution.

## [Crop Jitter Unittest](crop_jitter_unitest.py)
### Features:
1. Unit tests for crop jitter functionality.

## [Crop To Face](crop_to_face.py)
### Features:
1. Detect faces in images and crop to them.

## [Crop To Face Improved](crop_to_face_improved.py)
### Features:
1. Improved version of face cropping.

## [Delete Training Files](delete_training_files.py)
### Features:
1. Delete files used for training (e.g., converted images, captions) based on criteria.

## [Faces To Names](faces_to_names.py)
### Features:
1. Rename or tag images based on recognized faces.

## [Files Average Sizes](files_average_sizes.py)
### Features:
1. Calculate average file sizes in a directory.

## [Folders Add Repeats](folders_add_repeats.py)
### Features:
1. Rename folders to include repeat count (used for LoRA training).

## [Folders To Dataset TOML](folders_to_dataset_toml.py)
### Features:
1. Generate TOML dataset configuration from folder structure.

## [Git Patch Control](git_patch_control.py)
### Features:
1. Manage git patches.

## [Grok Imagine Downloader](grok_imagine_downloader.js)
### Features:
1. Download images from Grok.

## [HuggingFace Download](huggingface_download.py)
### Features:
1. Download files from HuggingFace repositories.

## [HuggingFace Fix Files Path](huggingface_fix_files_path.py)
### Features:
1. Fix file paths for HuggingFace operations.

## [HuggingFace Pull Requests Merge](huggingface_pull_requests_merge.py)
### Features:
1. Merge pull requests on HuggingFace.

## [HuggingFace Scan And Locate](huggingface_scan_and_locate.py)
### Features:
1. Scan and locate files in HuggingFace repositories.

## [HuggingFace Upload](huggingface_upload.py)
### Features:
1. Batch upload files to Hugging Face repositories.

## [HuggingFace User Browser Script Get Links](huggingface_user_browser_script_get_links_as_download_script.js)
### Features:
1. Extract download links from HuggingFace as a script.

## [Image Apply Exif Transpose](image_apply_exif_transpose.py)
### Features:
1. Rotate images based on EXIF orientation tag.

## [Image Histogram](image_histogram.py)
### Features:
1. Generate histograms for images.

## [Image Palette Recolor](image_palette_recolor.py)
### Features:
1. Recolor images based on a palette.

## [Image Quick Sorter](image_quick_sorter.py)
### Features:
1. Tool to quickly sort images.

## [Images Add Backgrounds](images_add_backgrounds.py)
### Features:
1. Add backgrounds to transparent images.

## [Images Add Overlay](images_add_overlay.py)
### Features:
1. Add an overlay image to base images.

## [Images Add Overlay Multiple](images_add_overlay_multiple.py)
### Features:
1. Add multiple overlay images.

## [Images Auto Adjust Exposure And Contrast](images_auto_adjust_exposure_and_contrast.py)
### Features:
1. Automatically adjust exposure and contrast of images.

## [Images Convert](images_convert.py)
### Features:
1. Convert images between different formats.

## [Images Edit Curves](images_edit_curves.py)
### Features:
1. Apply curve adjustments to images.

## [Images Edit Monochrome Blender](images_edit_monochrome_blender.py)
### Features:
1. Blend images to monochrome.

## [Images Filter Blurry](images_filter_blurry.py)
### Features:
1. Detect and filter blurry images.

## [Images Filter By Text](images_filter_by_text.py)
### Features:
1. Filter images based on text content.

## [Images Filter Small](images_filter_small.py)
### Features:
1. Filter out images smaller than a specific size.

## [Images Remove Postfix](images_remove_postfix.py)
### Features:
1. Remove postfixes (e.g., -0001) from filenames.

## [Images Replace Inside Metadata](images_replace_inside_metadata.py)
### Features:
1. Replace text inside image metadata (UserComment).

## [Images Split Exact Number](images_split_exact_number.py)
### Features:
1. Split a specific number of images from a folder to another.

## [Metadata To Captions](metadata_to_captions.py)
### Features:
1. Extract metadata from images and save as caption files.

## [Move Random Files](move_random_files.py)
### Features:
1. Move random files from one folder to another.

## [Output Images Purge](output_images_purge.py)
### Features:
1. Purge images from output directory.

## [PNG Info Copy](png_info_copy.py)
### Features:
1. Copy PNG metadata from one file to another.

## [PNG Info Print](png_info_print.py)
### Features:
1. Print PNG metadata to console.

## [PNG Info Replace](png_info_replace.py)
### Features:
1. Replace PNG metadata info.

## [PNG Info To Captions](png_info_to_captions.py)
### Features:
1. Extract PNG info to caption files.

## [Read Write Metadata](read_write_metadata.py)
### Features:
1. Read and write metadata for PNG/JPEG/WEBP.
2. Clean and robust utility.

## [Safetensors Metadata](safetensors_metadata.py)
### Features:
1. Read metadata from Safetensors model files.

## [Search And Replace Multiple](search_and_replace_multiple.py)
### Features:
1. Batch search and replace text in files.

## [Sort Images By Faces](sort_images_by_faces.py)
### Features:
1. Sort images into folders based on recognized faces.

## [Split Files](split_files.py)
### Features:
1. Split files into multiple folders.

## [Tags Count](tags_count.py)
### Features:
1. Count frequency of tags in caption files.

## [Text Encode](text_encode.py)
### Features:
1. Encode text files.

## [Text Extract Regexs](text_extract_regexs.py)
### Features:
1. Extract text using regular expressions.

## [Text Split](text_split.py)
### Features:
1. Split text files.

## [Twitter Upload Images](twitter_upload_images.py)
### Features:
1. Upload images to Twitter.

## [Videos Extract Images](videos_extract_images.py)
### Features:
1. Extract frames from videos.

## [Visual Multi Crop](visual_multi_crop.py)
### Features:
1. GUI tool for cropping multiple images.

## [Visual Sticker](visual_sticker.py)
### Features:
1. GUI tool for adding stickers/overlays to images.
