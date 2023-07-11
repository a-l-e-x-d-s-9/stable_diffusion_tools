// ==UserScript==
// @name         Insta Scan
// @namespace    http://tampermonkey.net/
// @version      0.1
// @description  try to take over the world!
// @author       You
// @match        https://www.instagram.com/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=instagram.com
// @grant        GM_setValue
// @grant        GM_getValue
// ==/UserScript==


(function() {
    'use strict';

    // Load downloaded images list from GM storage
    let downloadedImages = JSON.parse(GM_getValue('downloadedImages', '{}'));


    let startSlideshow = false;

    const clickNextImage = () => {
        let images = document.querySelectorAll('img[style="object-fit: cover;"]');

        for(let i = 0; i < images.length; i++) {
            if(images[i].style.objectFit === 'cover' && !downloadedImages[images[i].src]) {
                downloadImage(images[i].src);
                downloadedImages[images[i].src] = true; // Mark image as downloaded
                // Save downloaded images list to GM storage
                GM_setValue('downloadedImages', JSON.stringify(downloadedImages));
            }
        }

        const nextImageBtn = document.querySelector('button[aria-label="Next"]');
        if(nextImageBtn) {
            nextImageBtn.click();
        } else {
            clickNextPost(); // If no next image button found, go to next post
        }
    }

    const clickNextPost = () => {
        //console.log("GO TO NEXT POST")
        const nextPostSvg = document.querySelector('svg[aria-label="Next"]');
        if(nextPostSvg && nextPostSvg.parentNode) {
            nextPostSvg.parentNode.click();
        }
    }

    window.addEventListener('keydown', (event) => {
        // Ctrl + Shift + S to start
        if (event.ctrlKey && event.shiftKey && event.code === 'KeyS') {
            startSlideshow = true;
        }
        // Ctrl + Shift + Z to stop
        else if (event.ctrlKey && event.shiftKey && event.code === 'KeyZ') {
            startSlideshow = false;
        }
    });

    setInterval(() => {
        if (startSlideshow) {
            clickNextImage();
        }
    }, 100);

    const downloadImage = async (url, imageName) => {
        const response = await fetch(url);
        const blob = await response.blob();
        const blobUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.style.display = 'none';
        a.href = blobUrl;
        a.download = imageName || 'download.jpg';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
    }


})();
