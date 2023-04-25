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
##  

# Scripts:

##  [Caption Helper:](captions_helper.py)
### Features:
1. Visual preview of images.
2. Show caption file content for each image.
3. Edit caption text.
4. Add new text after specific comma to all files.
![Caption Helper Preview](readme_files/caption_helper_preview_01.png)

## [Pattern Replacer](pattern_replacer.py)
### Features:
1. Replace multiple patterns at text.
2. Add/remove couples of regex and replacement string.
3. Save/load automatically state to file.
![Pattern Replacer Preview](readme_files/pattern_replacer_preview_01.png)

## [Civitai Dashboard](civitai_dashboard.py)
### Warning:
* The script not fully debugged. It needs further work. 
### Features:
1. Pull models of user with Civitai API.
2. Plot all models on graph with corresponding downloads per model.
3. Data pulled periodically and save to local database.
![Civitai Dashboard Preview](readme_files/civitai_dasboard_preview_01.png)

## [File Downloader](file_downloader.py)
### Features:
1. Download files from a list of URLs.

## [Files split to directories](files_split_to_directories.py)
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

## [Images flip horizontal](images_flip_horizontal.py)
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

