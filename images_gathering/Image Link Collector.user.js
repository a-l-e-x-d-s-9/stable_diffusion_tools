// ==UserScript==
// @name         Image Link Collector
// @namespace    http://tampermonkey.net/
// @version      0.1
// @description  Collect image URLs by clicking on them
// @author       You
// @match        https://www.gettyimages.com/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// ==/UserScript==

(function() {
    'use strict';

    var clickedImages = GM_getValue("clickedImages", []);

    // Create a fixed counter element
    var counter = document.createElement('div');
    counter.style.position = 'fixed';
    counter.style.top = '110px';
    counter.style.left = '10px';
    counter.style.fontSize = '55px';
    counter.style.color = 'red';
    counter.style.zIndex = '9999'; // ensures counter is always on top
    counter.innerHTML = clickedImages.length;
    document.body.appendChild(counter);

    function updateCounter() {
        counter.innerHTML = clickedImages.length;
    }

    function removeImageFromList(imageUrl) {
        clickedImages = clickedImages.filter(function(item) {
            return item !== imageUrl;
        });
        GM_setValue("clickedImages", clickedImages);
        updateCounter();
    }

    function addClickListenerToImage(article) {
        var linkElement = article.getElementsByTagName('a')[0];
        var imageUrl = linkElement.href;

        // Check if button already exists
        if (article.querySelector('.add-to-list-button')) {
            return;
        }

        var button = document.createElement('button');
        button.innerHTML = clickedImages.includes(imageUrl) ? 'Added' : 'Add to list';
        button.style.position = 'absolute';
        button.style.zIndex = '1000';
        button.style.bottom = '0';
        button.style.left = '50%';
        button.style.transform = 'translateX(-50%)';
        button.style.backgroundColor = clickedImages.includes(imageUrl) ? 'lightgreen' : '';
        button.style.width = '100%'; // Increase button width
        button.style.height = '50px'; // Increase button height
        button.style.fontSize = '20px'; // Increase font size
        button.style.opacity = '0.7'; // Make button half transparent
        button.className = 'add-to-list-button';

        linkElement.parentNode.insertBefore(button, linkElement.nextSibling);
        button.addEventListener('click', function(e) {
            e.preventDefault();
            if (!clickedImages.includes(imageUrl)) {
                clickedImages.push(imageUrl);
                GM_setValue("clickedImages", clickedImages);
                e.target.innerHTML = 'Added';
                e.target.style.backgroundColor = 'lightgreen';
                updateCounter();
                addRemoveButton(article, imageUrl); // Add remove button when image is added
            }
        });

        // If image is already added, create remove button
        if (clickedImages.includes(imageUrl)) {
            addRemoveButton(article, imageUrl);
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
                addToListButton.style.backgroundColor = '';
            }
        });
    }

    async function copyToClipboard() {
        try {
            await navigator.clipboard.writeText(clickedImages.join('\n'));
        } catch (err) {
            console.error('Failed to copy image URLs: ', err);
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
        var articles = document.getElementsByTagName('article');
        for (var i = 0; i < articles.length; i++) {
            addClickListenerToImage(articles[i]);
        }
    }

    // Add click listeners to existing images
    addClickListenersToAllImages();

    // Periodically check for new images and add click listeners to them
    setInterval(addClickListenersToAllImages, 1000);

    // Listen for right arrow key press to click on "Next" button
    document.addEventListener('keydown', function(e) {
        if (e.key === 'ArrowRight') {
            var nextButton = document.querySelector('[data-testid="pagination-button-next"]');
            if (nextButton) {
                nextButton.click();
            }
        }
    });

    // Listen for right arrow key press to click on "PREVIOUS" button
    document.addEventListener('keydown', function(e) {
        if (e.key === 'ArrowLeft') {
            var nextButton = document.querySelector('[data-testid="pagination-button-prev"]');
            if (nextButton) {
                nextButton.click();
            }
        }
    });
})();
