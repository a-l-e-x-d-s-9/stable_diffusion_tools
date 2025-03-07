// ==UserScript==
// @name         Insta Scan with Full Caption
// @namespace    http://tampermonkey.net/
// @version      0.3
// @description  Downloads Instagram images with their full caption (including hashtags)
// @author       You
// @match        https://www.instagram.com/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=instagram.com
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// ==/UserScript==

(function() {
    'use strict';

    /********************************************************
     *                 Persistent Data & Flags              *
     ********************************************************/
    let downloadedImages = JSON.parse(GM_getValue('downloadedImages', '{}'));
    let startSlideshow = false;     // Controls main loop
    let stopSlideshow = false;      // Flag to break loop

    /********************************************************
     *                Main Async Slideshow                  *
     ********************************************************/
    async function startAsyncSlideshow() {
        stopSlideshow = false;
        while (startSlideshow && !stopSlideshow) {
            // 1) Download images on current slide
            await downloadCurrentImages();

            // 2) Click "Next Image" or "Next Post"
            const nextImageBtn = document.querySelector('button[aria-label="Next"]');
            if (nextImageBtn) {
                nextImageBtn.click();
            } else {
                clickNextPost();
            }

            // 3) Wait for the new slide to load
            await sleep(3000);
        }
    }

    async function downloadCurrentImages() {
        let images = document.querySelectorAll('img[style="object-fit: cover;"]');
        for (let img of images) {
            // If already downloaded, skip
            if (downloadedImages[img.src]) continue;

            // Ensure image is loaded
            await waitForImageLoad(img);

            // Download image
            const imageName = getFileName(img.src);
            await downloadImage(img.src, imageName);

            // Extract & save caption
            const caption = extractPostCaption();
            if (caption) {
                downloadTextFile(imageName.replace(/\.[^/.]+$/, ".txt"), caption);
            }

            // Mark image as downloaded
            downloadedImages[img.src] = true;
            GM_setValue('downloadedImages', JSON.stringify(downloadedImages));
        }
    }

    function clickNextPost() {
        const nextPostSvg = document.querySelector('svg[aria-label="Next"]');
        if (nextPostSvg && nextPostSvg.parentNode) {
            nextPostSvg.parentNode.click();
        }
    }

    /********************************************************
     *               Event Handlers & Flow                  *
     ********************************************************/
    window.addEventListener('keydown', (event) => {
        if (event.ctrlKey && event.shiftKey && event.code === 'KeyS') {
            // Start slideshow
            startSlideshow = true;
            startAsyncSlideshow();
        } else if (event.ctrlKey && event.shiftKey && event.code === 'KeyZ') {
            // Stop slideshow
            startSlideshow = false;
            stopSlideshow = true;  // break from loop
        }
    });

    /********************************************************
     *                 Helper Functions                     *
     ********************************************************/
    async function waitForImageLoad(img) {
        if (img.complete && img.naturalWidth > 0) return;
        await new Promise(resolve => {
            img.addEventListener('load', resolve, { once: true });
        });
    }

    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    async function downloadImage(url, imageName) {
        const response = await fetch(url);
        const blob = await response.blob();
        const blobUrl = URL.createObjectURL(blob);

        const a = document.createElement('a');
        a.style.display = 'none';
        a.href = blobUrl;
        a.download = imageName;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
    }

    function getFileName(url) {
        let urlParts = url.split("/");
        let fileName = urlParts[urlParts.length - 1].split("?")[0];
        return fileName;
    }

    // Extract the first comment's text + hashtags
    function extractPostCaption() {
        // Find all potential caption blocks by dir="auto"
        let maybeCaptions = document.querySelectorAll('h1[dir="auto"], div[dir="auto"]');
        let foundCaption = "";

        for (let el of maybeCaptions) {
            let text = el.innerText.trim();
            // Filter out known non-caption text
            if (
                text.includes("See translation") ||
                text.includes("likes") ||
                text.includes("comment") ||
                text.includes("More posts from") ||
                text.includes("No comments yet") ||
                text.includes("Start the conversation") ||
                text.length < 10
            ) {
                continue;
            }

            // We consider this our main caption
            foundCaption = text;

            // Also extract hashtags from links inside this element
            let hashtagLinks = el.querySelectorAll('a[href^="/explore/tags/"]');
            let hashtags = [...hashtagLinks].map(a => a.innerText.trim()).filter(Boolean).join(" ");
            if (hashtags) {
                foundCaption += `\n\n${hashtags}`;
            }
            break; // Stop after first valid caption
        }

        return foundCaption || "Caption not found";
    }

    function downloadTextFile(fileName, content) {
        const blob = new Blob([content], { type: "text/plain" });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = fileName;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
    }

    function clearList() {
        downloadedImages = {};
        GM_setValue('downloadedImages', JSON.stringify(downloadedImages));
    }

    // Additional GM menu items if needed
    GM_registerMenuCommand('Start Downloading [CTRL+SHIFT+S]', () => {
        startSlideshow = true;
        startAsyncSlideshow();
    });
    GM_registerMenuCommand('Stop Downloading [CTRL+SHIFT+Z]', () => {
        startSlideshow = false;
        stopSlideshow = true;
    });
    GM_registerMenuCommand('Clear Image List', clearList);

})();