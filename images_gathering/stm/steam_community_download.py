import os
import argparse
import time
from urllib.request import urlretrieve
from selenium import webdriver
from selenium.webdriver.chrome.service import Service
from selenium.webdriver.chrome.options import Options
import tempfile, subprocess, os, shutil, atexit

def create_chromium_driver():
    # 1️⃣ unique throw-away profile dir
    profile_dir = tempfile.mkdtemp(prefix="steam_scr_")

    # make sure it is removed on exit
    atexit.register(lambda: shutil.rmtree(profile_dir, ignore_errors=True))

    # 2️⃣ optional: kill any stray Chromium that is still running
    subprocess.run(["pkill", "-f", "chromium"], check=False)

    options = Options()
    options.add_argument("--headless=new")
    options.add_argument("--disable-gpu")
    options.add_argument("--no-sandbox")
    options.add_argument("--disable-dev-shm-usage")
    options.add_argument("--user-data-dir=" + profile_dir)   # ★ key line ★
    options.add_argument("--no-first-run")
    options.add_argument("--no-default-browser-check")
    options.binary_location = "/snap/bin/chromium"           # Snap path

    service = Service("/usr/bin/chromedriver")               # chromedriver path

    return webdriver.Chrome(service=service, options=options)


def download_screenshots(app_id, download_dir, sort_by='mostpopular', time_range='7days'):
    os.makedirs(download_dir, exist_ok=True)

    url = f"https://steamcommunity.com/app/{app_id}/screenshots/?browsefilter={sort_by}&days={time_range}"

    driver = create_chromium_driver()

    print(f"Loading: {url}")
    driver.get(url)

    # Wait for JS content to load
    time.sleep(5)

    # Scroll to bottom to trigger lazy loading
    driver.execute_script("window.scrollTo(0, document.body.scrollHeight);")
    time.sleep(3)

    # Grab image elements
    images = driver.find_elements("css selector", ".screenshot_holder img")
    print(f"Found {len(images)} images.")

    for idx, img in enumerate(images):
        src = img.get_attribute("src")
        if src:
            src = src.replace("116x65", "1920x1080")
            filename = os.path.join(download_dir, f"screenshot_{idx+1}.jpg")
            try:
                urlretrieve(src, filename)
                print(f"✔ Downloaded: {filename}")
            except Exception as e:
                print(f"✘ Failed: {src} ({e})")

    driver.quit()

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument('--app_id', required=True, help='Steam App ID')
    parser.add_argument('--download_dir', required=True, help='Target folder for downloaded images')
    args = parser.parse_args()

    download_screenshots(args.app_id, args.download_dir)
