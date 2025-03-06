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
// @grant        GM_registerMenuCommand
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
            download_mode(true);
        }
        // Ctrl + Shift + Z to stop
        else if (event.ctrlKey && event.shiftKey && event.code === 'KeyZ') {
            download_mode(false);
        }
    });

    setInterval(() => {
        if (startSlideshow) {
            clickNextImage();
        }
    }, 80);

    const downloadImage = async (url, imageName) => {
        const response = await fetch(url);
        const blob = await response.blob();
        const blobUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');

        a.style.display = 'none';
        a.href = blobUrl;

        let urlParts = url.split("/");
        let fileName = urlParts[urlParts.length - 1].split("?")[0];

        a.download = imageName || fileName;

        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
    }

    function download_mode(is_download) {
        startSlideshow = is_download;
    }

    function getFileExtension(url) {
        // Split the URL by '.' and take the last element, which should be the file extension
        const splitUrl = url.split('.');
        let extension = splitUrl[splitUrl.length - 1];
        // If the extension includes a '?', remove the '?' and everything after it
        extension = extension.split('?')[0];
        // If the extension includes '&', remove the '&' and everything after it
        extension = extension.split('&')[0];
        return extension;
    }

    function clearList() {
        downloadedImages = [];
        GM_setValue('downloadedImages', JSON.stringify(downloadedImages));
    }

    function download_start(){
        download_mode(true)
    }

    function download_stop(){
        download_mode(false)
    }

    GM_registerMenuCommand('Start Downloading [CTRL+SHIFT+S]', download_start);
    GM_registerMenuCommand('Stop Downloading [CTRL+SHIFT+Z]', download_stop);
    GM_registerMenuCommand('Clear Image List', clearList);


})();