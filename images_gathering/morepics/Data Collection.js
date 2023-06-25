// ==UserScript==
// @name         pornpics
// @namespace    http://tampermonkey.net/
// @version      0.1
// @description  try to take over the world!
// @author       You
// @match        https://www.pornpics.com/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=pornpics.com
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// ==/UserScript==

(function() {
    'use strict';

    var currentUrl = window.location.href;
    var storedData = JSON.parse(GM_getValue("storedData", "{}"));
    var autoStoreData = GM_getValue("autoStoreData", false);

    // Create a fixed counter element
    var counter = document.createElement('div');
    counter.style.position = 'fixed';
    counter.style.top = '110px';
    counter.style.left = '10px';
    counter.style.fontSize = '55px';
    counter.style.color = 'red';
    counter.style.zIndex = '9999'; // ensures counter is always on top
    counter.innerHTML = Object.keys(storedData).length;
    document.body.appendChild(counter);

    function updateCounter() {
        counter.innerHTML = Object.keys(storedData).length;
    }

    function removeDataFromList(imageUrl) {
        delete storedData[imageUrl];
        GM_setValue("storedData", JSON.stringify(storedData));
        updateCounter();
    }

    function addDataToList(url, data) {
        if (!storedData[url]) {
            storedData[url] = data;
            GM_setValue("storedData", JSON.stringify(storedData));
            updateCounter();
        }
    }

    function removeCurrentPageData() {
        removeDataFromList(currentUrl);
    }


    async function copyToClipboard() {
        try {
            let dataStrings = JSON.stringify(storedData, null, 2);
            await navigator.clipboard.writeText(dataStrings);
        } catch (err) {
            console.error('Failed to copy data: ', err);
        }
    }

    function clearList() {
        storedData = {};
        GM_setValue("storedData", JSON.stringify(storedData));
        updateCounter();
    }

    GM_registerMenuCommand('Copy data to Clipboard', copyToClipboard);
    GM_registerMenuCommand('Clear data', clearList);
    GM_registerMenuCommand('Remove current page data', removeCurrentPageData);

    let imageLinks = [];
    let modelName = [];
    let tags = [];

    // Collect all href from li elements with class 'thumbwook'
    let thumbwookElems = document.querySelectorAll("li.thumbwook a.rel-link");
    thumbwookElems.forEach(function (elem) {
        imageLinks.push(elem.href);
    });

    // Check for Model title and Extract model name from div with class 'gallery-info__content'
    let modelTitleElems = document.querySelectorAll(".gallery-info__item span.gallery-info__title");
    modelTitleElems.forEach(function(modelTitleElem) {
        if (modelTitleElem.innerText.trim() === "Models:") {
            let modelNameElems = modelTitleElem.parentElement.querySelectorAll(".gallery-info__content a span");
            modelNameElems.forEach(function (modelNameElem) {
                modelName.push(modelNameElem.innerText);
            });
        }
    });

    // Check for Categories title and Extract tags from div with class 'gallery-info__item tags'
    let tagsTitleElem = document.querySelector(".gallery-info__item.tags span.gallery-info__title");
    if (tagsTitleElem && tagsTitleElem.innerText === "Categories:") {
        let tagsElems = document.querySelectorAll(".gallery-info__item.tags .gallery-info__content a");
        tagsElems.forEach(function (elem) {
            tags.push(elem.innerText);
        });
    }

    var data = {
        "url": currentUrl,
        "modelName": modelName,
        "tags": tags,
        "imageLinks": imageLinks
    };

    console.log(data);
    addDataToList(currentUrl, data);
})();
