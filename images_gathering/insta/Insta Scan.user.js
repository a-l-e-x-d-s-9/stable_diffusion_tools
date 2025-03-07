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
// @grant        GM_notification
// @run-at       document-end  // Ensures script runs late enough
// ==/UserScript==

(function() {
    'use strict';

    // Persistent data
    let downloadedImages = JSON.parse(GM_getValue('downloadedImages', '{}'));
    let startSlideshow = false;
    let stopSlideshow = false;

    // Main slideshow loop
    async function startAsyncSlideshow() {
        stopSlideshow = false;
        while (startSlideshow && !stopSlideshow) {
            await downloadCurrentImages();
            await goToNextImageOrPost();
        }
    }

    async function goToNextImageOrPost() {
        const oldURL = window.location.href;
        const nextImageBtn = document.querySelector('button[aria-label="Next"]');
        if (nextImageBtn) {
            nextImageBtn.click();
        } else {
            clickNextPost();
        }

        let maxWait = Date.now() + 10000;
        while (window.location.href === oldURL && Date.now() < maxWait) {
            await sleep(300);
        }
        await sleep(1000);
    }

    async function downloadCurrentImages() {
        let images = document.querySelectorAll('img[style="object-fit: cover;"]');
        for (let img of images) {
            if (downloadedImages[img.src]) continue;
            await waitForImageLoad(img);

            const imageName = getFileName(img.src);
            await downloadImage(img.src, imageName);

            const caption = extractPostCaption();
            if (caption && caption !== "Caption not found") {
                downloadTextFile(imageName.replace(/\.[^/.]+$/, ".txt"), caption);

                // Show a GM notification
                GM_notification({
                    text: caption,
                    title: "Caption for " + imageName,
                    timeout: 5000
                });
            }

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

    // Re-check that we have a single keydown event
    // and there's no conflicting code
    window.addEventListener('keydown', (event) => {
        // Make sure the site or other scripts haven't captured keys first
        if (!event.ctrlKey || !event.shiftKey) return;

        // Keys
        if (event.code === 'KeyS') {
            // Ctrl+Shift+S => start
            startSlideshow = true;
            startAsyncSlideshow();
        } else if (event.code === 'KeyZ') {
            // Ctrl+Shift+Z => stop
            startSlideshow = false;
            stopSlideshow = true;
        }
    });

    // Helper
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
        return urlParts[urlParts.length - 1].split("?")[0];
    }

    function extractPostCaption() {
        let maybeCaptions = document.querySelectorAll('h1[dir="auto"], div[dir="auto"]');
        let foundCaption = "";

        for (let el of maybeCaptions) {
            let text = el.innerText.trim();
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

            foundCaption = text;
            let hashtagLinks = el.querySelectorAll('a[href^="/explore/tags/"]');
            let hashtags = [...hashtagLinks].map(a => a.innerText.trim()).filter(Boolean).join(" ");
            if (hashtags) {
                foundCaption += `\n\n${hashtags}`;
            }
            break;
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
