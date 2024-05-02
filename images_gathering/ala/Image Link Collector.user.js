// ==UserScript==
// @name         Alamy Image Link Collector
// @namespace    http://tampermonkey.net/
// @version      0.3
// @description  Collect image URLs by clicking on them
// @author       You
// @match        https://www.alamy.com/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=gettyimages.com/
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// ==/UserScript==

(function() {
    'use strict';

    var clickedImages = GM_getValue("clickedImages", []);
    var autoAddImages = GM_getValue("autoAddImages", false);

    // Create a fixed counter element
    var counter = document.createElement('div');
    counter.style.position = 'fixed';
    counter.style.background = 'black';
    counter.style.top = '24px'; // Align to the vertical center
    counter.style.left = '50%'; // Align to the horizontal center
    counter.style.transform = 'translate(-50%, -50%)'; // Center the div
    counter.style.padding = '2px'; // Reduce the padding
    counter.style.margin = '2px';
    counter.style.fontSize = '55px';
    counter.style.color = 'yellow';
    counter.style.zIndex = '9999'; // ensures counter is always on top
    counter.innerHTML = clickedImages.length;
    document.body.appendChild(counter);

    function updateCounter() {
        counter.innerHTML = clickedImages.length;
    }

    function removeImageFromList(imageUrl) {
        clickedImages = clickedImages.filter(function(item) {
            return item.url !== imageUrl;
        });
        GM_setValue("clickedImages", clickedImages);
        updateCounter();
    }

    function addImageToList(imageSrc, imageUrl, imageAlt) {
        var imageObject = { src: imageSrc, url: imageUrl, alt: imageAlt };
        if (!clickedImages.some(item => item.url === imageUrl)) {
            clickedImages.push(imageObject);
            GM_setValue("clickedImages", clickedImages);
            updateCounter();
        }
    }

    function addClickListenerToImage(divElement) {
        //var linkElement = article.getElementsByTagName('div')[0];
        //var imageUrl = linkElement.href;
        //var imageTag = linkElement.querySelector('img');
        //var imageSrc = imageTag ? imageTag.src : '';

        //var divElement = article.querySelector('div[data-testid^="search-tile"]');
        var imgElement = divElement ? divElement.querySelector('img') : null;
        var linkElement = divElement ? divElement.querySelector('a') : null;
        var imageUrl = linkElement ? linkElement.href : '';
        var imageSrc = imgElement ? imgElement.src : '';




        // Check if button already exists
        if (divElement.querySelector('.add-to-list-button')) {
            return;
        }

        var altText = linkElement?.title ?? "";

        //console.log("imageUrl add: " + imageUrl);
        console.log("altText: " + altText);
        //console.log("linkElement.alt: " + linkElement.alt);

        if (autoAddImages) {
            addImageToList(imageSrc, imageUrl, altText); // Automatically add image with source if auto-add feature is enabled
        }


        var button = document.createElement('button');
        button.innerHTML = clickedImages.some(item => item.url === imageUrl) ? 'Added' : 'Add to list';
        button.style.backgroundColor = clickedImages.some(item => item.url === imageUrl) ? 'lightgreen' : 'gray';
        button.style.position = 'absolute';
        button.style.zIndex = '1000';
        button.style.bottom = '0';
        button.style.left = '50%';
        button.style.transform = 'translateX(-50%)';
        button.style.width = '100%'; // Increase button width
        button.style.height = '50px'; // Increase button height
        button.style.fontSize = '20px'; // Increase font size
        button.style.opacity = '0.7'; // Make button half transparent
        button.className = 'add-to-list-button';

        linkElement.parentNode.insertBefore(button, linkElement.nextSibling);
        button.addEventListener('click', function(e) {
            e.preventDefault();
            if (!clickedImages.some(item => item.url === imageUrl)) {
                addImageToList(imageSrc, imageUrl, altText);
                button.innerHTML = 'Added';
                button.style.backgroundColor = 'lightgreen';
                updateCounter();
                addRemoveButton(divElement, imageUrl);
            }
        });

        // If image is already added, create remove button
        if (clickedImages.some(item => item.url === imageUrl)) {
            addRemoveButton(divElement, imageUrl);
        }
    }

    function addRemoveButton(article, imageUrl) {
        if (article.querySelector('.remove-from-list-button')) {
            return;
        }

        var removeButton = document.createElement('button');
        removeButton.innerHTML = 'X';
        removeButton.style.position = 'absolute';
        removeButton.style.zIndex = '1001';
        removeButton.style.bottom = '50px';
        removeButton.style.left = '0';
        removeButton.style.backgroundColor = 'red';
        removeButton.style.width = '50px'; // Button size
        removeButton.style.height = '50px'; // Button size
        removeButton.style.fontSize = '20px'; // Increase font size
        removeButton.style.opacity = '0.7'; // Make button half transparent
        removeButton.className = 'remove-from-list-button';

        var linkElement = article.getElementsByTagName('a')[0];
        linkElement.parentNode.insertBefore(removeButton, linkElement.nextSibling);
        removeButton.addEventListener('click', function(e) {
            e.preventDefault();
            removeImageFromList(imageUrl);
            e.target.remove(); // Remove the button itself
            var addToListButton = article.querySelector('.add-to-list-button');
            if (addToListButton) {
                addToListButton.innerHTML = 'Add to list';
                addToListButton.style.backgroundColor = 'gray';
            }
        });
    }

    async function copyToClipboard() {
        var textToCopy = clickedImages.map(item => {
            if (typeof item === 'object') {
                return item.src + ' ' + item.url + ' Alt: ' + item.alt;
            } else {
                return item;
            }
        }).join('\n');

        try {
            await navigator.clipboard.writeText(textToCopy);
        } catch (err) {
            console.error('Failed to copy image URLs to clipboard:', err);
        }
    }

    function clearList() {
        clickedImages = [];
        GM_setValue("clickedImages", clickedImages);
        updateCounter();
    }

    GM_registerMenuCommand('Copy Image List to Clipboard', copyToClipboard);
    GM_registerMenuCommand('Clear Image List', clearList);

    function addClickListenersToAllImages() {
        // Select all div elements with the specific data-testid attribute
        var divs = document.querySelectorAll('div[data-testid^="search-tile-"]');

        for (var i = 0; i < divs.length; i++) {
            //console.log("i: " + i);
            addClickListenerToImage(divs[i]);
        }
    }

    // Add click listeners to existing images
    addClickListenersToAllImages();

    // Periodically check for new images and add click listeners to them
    setInterval(addClickListenersToAllImages, 1000);

    // Listen for right arrow key press to click on "Next" button
    document.addEventListener('keydown', function(e) {
        if (e.key === 'ArrowRight') {
            var nextButton = document.querySelector('[data-testid="next"]');
            if (nextButton) {
                nextButton.click();
            }
        }
    });

    // Listen for left arrow key press to click on "Previous" button
    document.addEventListener('keydown', function(e) {
        if (e.key === 'ArrowLeft') {
            var prevButton = document.querySelector('[data-testid="previous"]');
            if (prevButton) {
                prevButton.click();
            }
        }
    });


    function toggleAutoAddImages() {
        autoAddImages = !autoAddImages; // Toggle the auto-add feature
        GM_setValue("autoAddImages", autoAddImages); // Persist the state of the auto-add feature
    }

    GM_registerMenuCommand('Toggle Auto-Add Images', toggleAutoAddImages);

})();