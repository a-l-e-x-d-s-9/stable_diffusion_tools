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
// @run-at       document-idle
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

    function extract_valid_link()
    {
        const links = document.querySelectorAll('li.thumbwook a.rel-link');
        //let hrefs = Array.from(links).slice(0, desired_pages).map(a => a.href); // Get up to 55 links
        let hrefs = Array.from(links)
            .filter(a => a.href.includes("www.pornpics.com/galleries/")) // Filter links containing "www.coolpics.com"
            .map(a => a.href); // Extract hrefs

//        for (let i = 0; i < hrefs.length - 1; i++) {
//            console.log("HREF [" + i + "]: " + hrefs[i])
//        }

        return hrefs;
    }

    function open_all_links(){
        let desired_pages = 55;

        // Function to scroll and load more elements
        function scrollToLoadMore(finalCount, callback) {
            let lastCount = 0;
            let intervalId = setInterval(() => {
                window.scrollTo(0, document.body.scrollHeight); // Scroll to the bottom of the page
                //let currentCount = document.querySelectorAll('li.thumbwook a.rel-link').length;
                let currentCount = extract_valid_link().length;



                if (currentCount >= finalCount || lastCount === currentCount) {
                    clearInterval(intervalId); // Stop scrolling
                    callback(); // Proceed after scrolling
                } else {
                    lastCount = currentCount; // Update last count for the next iteration
                }
            }, 1000); // Adjust time as needed for your site's loading behavior
        }

        scrollToLoadMore(desired_pages, () => {
            // After scrolling and loading, proceed to open links
            let hrefs = extract_valid_link().slice(0, desired_pages); // Get up to desired_pages links

            console.log('scrollToLoadMore: ' + hrefs.length);
            console.log('scrollToLoadMore: ' + hrefs.length);

            if (hrefs.length > 0) {

//                // Modify all hrefs except the last to add "?extra=autoclose"
//                for (let i = 0; i < hrefs.length - 1; i++) {
//                    let url = new URL(hrefs[i]);
//                    url.searchParams.append("extra", "autoclose"); // Add the query parameter for auto-closing
//                    hrefs[i] = url.toString(); // Update the href with the modified URL
//                }

                // Modify only the last href to add "?extra=copy"
                let lastUrl = new URL(hrefs[hrefs.length - 1]);
                lastUrl.searchParams.append("extra", "copy"); // Add the query parameter
                hrefs[hrefs.length - 1] = lastUrl.toString(); // Update the last href with the modified URL
            }

            function openLink(index) {
                if (index >= hrefs.length) return; // No more links

                let wait_milliseconds = 250;
                let timeout_counter_maximum = 15000 / wait_milliseconds;
                const win = window.open(hrefs[index], '_blank');
                if (win) {
                    //win.focus();
                    let timeout_counter = 0;
                    const checkLoad = setInterval(() => {
                        let is_done = false;
                        if (win.document.readyState === 'complete') {
                            console.log("waiting for childMutationObserver")
                            if (win.document && win.document.body.getAttribute('data-child-ready') === 'true') {
                                clearInterval(checkLoad);
                                if (index + 1 < hrefs.length) {
                                    win.close(); // Close the tab if you're done with it
                                    openLink(index + 1); // Open the next link
                                }
                            }
                            timeout_counter += 1;
                            if (is_done === false){
                                if (timeout_counter_maximum < timeout_counter){
                                    win.close();
                                    openLink(index);
                                }
                            }
                        }
                    }, wait_milliseconds);
                } else {
                    console.log('Popup blocked or window could not be opened');
                }
            }

            openLink(0); // Start opening links after all desired elements are loaded
        });
    }

    GM_registerMenuCommand('Copy data to Clipboard', copyToClipboard);
    GM_registerMenuCommand('Clear data', clearList);
    GM_registerMenuCommand('Remove current page data', removeCurrentPageData);
    GM_registerMenuCommand('Open all links', open_all_links);
    GM_registerMenuCommand('Find most popular model name', findMostPopularModelNameShow);

    const observer = new MutationObserver((mutations) => {
        // React to mutations here
        console.log("MutationObserver");
//        if (window.opener) {
//            // Send a message to the parent window
//            // Replace "http://example.com" with the actual origin of the parent window
//            window.opener.postMessage('MutationObserver', 'http://pornpics.com');
//        }

        //window.childMutationObserver = true;
        document.body.setAttribute('data-child-ready', 'true');
    });
    observer.observe(document.body, { childList: true, subtree: true });

    window.onload = () => {
    //function run_on_load(){
        const urlParams = new URLSearchParams(window.location.search);
        const extra = urlParams.get('extra');
        console.log("window.onload")
        if (extra === 'copy') {
            copyToClipboard();
            makePageBlink();
            //window.close();
        }

        if (extra === 'autoclose') {
//            window.close();
        }


    };

    document.addEventListener('DOMContentLoaded', (event) => {
        console.log('DOM fully loaded and parsed');
        // Your code here
    });

    function waitForElement(selector, callback) {
        const element = document.querySelector(selector);

        if (element) {
            callback(element);
        } else {
            setTimeout(() => waitForElement(selector, callback), 500);
        }
    }

    waitForElement("body", function() {
        console.log("Loaded!");
        const urlParams = new URLSearchParams(window.location.search);
        const extra = urlParams.get('extra');

//        run_on_load();
        if (extra === 'auto_download_all') {
            clearList();
            open_all_links();
        }
    });


    function findMostPopularModelNameShow() {
        alert(findMostPopularModelName());
    }

    function findMostPopularModelName() {
        const nameCount = {}; // Object to hold name counts

        // Iterate over each entry in storedData
        Object.values(storedData).forEach(entry => {
            // Iterate over each name in the modelName array
            entry.modelName.forEach(name => {
                // If the name doesn't exist in nameCount, initialize it with 0
                if (!nameCount[name]) {
                    nameCount[name] = 0;
                }
                // Increment the count for this name
                nameCount[name]++;
            });
        });

        // Find the name with the highest count
        let mostPopularName = "";
        let maxCount = 0;
        Object.entries(nameCount).forEach(([name, count]) => {
            if (count > maxCount) {
                maxCount = count;
                mostPopularName = name;
            }
        });

        return mostPopularName;
    }

    // Inject CSS for blinking animation
    const style = document.createElement('style');
    style.type = 'text/css';
    style.innerHTML = `
        @keyframes blink {
            0% { background-color: initial; }
            50% { background-color: green; }
            100% { background-color: initial; }
        }

        .blinking {
            animation: blink 0.5s infinite;
        }
    `;

    document.head.appendChild(style);

    let imageLinks = [];
    let channelName = [];
    let modelName = [];
    let tags = [];

    // Collect all href from li elements with class 'thumbwook'
    let thumbwookElems = document.querySelectorAll("li.thumbwook a.rel-link");
    thumbwookElems.forEach(function (elem) {
        imageLinks.push(elem.href);
    });

    // Check for Channels title and Extract model name from div with class 'gallery-info__content'
    let channelTitleElems = document.querySelectorAll(".gallery-info__item span.gallery-info__title");
    channelTitleElems.forEach(function(channelTitleElem) {
        console.log(channelTitleElem.innerText.trim())
        if (channelTitleElem.innerText.trim().startsWith("Channel:")) {
            let channelLinks = channelTitleElem.parentElement.querySelectorAll("a");
            channelLinks.forEach(function (channelLink) {
                // Assuming you want to push the text content of each <a> tag
                channelName.push(channelLink.innerText);
            });
        }
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
        "channelName": channelName,
        "modelName": modelName,
        "tags": tags,
        "imageLinks": imageLinks
    };

    function makePageBlink() {
        const body = document.body;
        body.classList.add('blinking');

        setTimeout(() => {
            body.classList.remove('blinking');
        }, 3000);
    }

    console.log(data);
    addDataToList(currentUrl, data);
})();
