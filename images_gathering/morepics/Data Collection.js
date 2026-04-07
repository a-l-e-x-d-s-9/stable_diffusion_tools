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
// @grant        GM_deleteValue
// @grant        GM_listValues
// @grant        GM_registerMenuCommand
// @run-at       document-idle
// ==/UserScript==

(function() {
    'use strict';

    function normalizeGalleryUrl(url) {
        try {
            const u = new URL(url, window.location.origin);
            u.searchParams.delete("extra");
            u.hash = "";
            return u.toString();
        } catch (e) {
            return url;
        }
    }

    var currentUrl = normalizeGalleryUrl(window.location.href);
    var autoStoreData = GM_getValue("autoStoreData", false);

    const DATA_KEY_PREFIX = "catpics:data:";

    function pageDataKey(url) {
        return DATA_KEY_PREFIX + normalizeGalleryUrl(url);
    }

    function getAllStoredData() {
        const out = {};
        const keys = GM_listValues();

        for (const key of keys) {
            if (!key.startsWith(DATA_KEY_PREFIX)) continue;
            try {
                const entry = JSON.parse(GM_getValue(key, "null"));
                if (entry && entry.url) {
                    out[normalizeGalleryUrl(entry.url)] = entry;
                }
            } catch (e) {
                console.error("Failed to parse stored entry for key:", key, e);
            }
        }

        return out;
    }

    function getStoredCount() {
        let count = 0;
        const keys = GM_listValues();
        for (const key of keys) {
            if (key.startsWith(DATA_KEY_PREFIX)) count++;
        }
        return count;
    }

    const OPENED_LINKS_KEY = "openAllOpenedLinks";
    const openedLinks = new Set(JSON.parse(GM_getValue(OPENED_LINKS_KEY, "[]")));

    function saveOpenedLinks() {
        GM_setValue(OPENED_LINKS_KEY, JSON.stringify(Array.from(openedLinks)));
    }

    function markLinkOpened(url) {
        const normalized = normalizeGalleryUrl(url);
        if (!openedLinks.has(normalized)) {
            openedLinks.add(normalized);
            saveOpenedLinks();
        }
    }

    function hasLinkBeenOpened(url) {
        const normalized = normalizeGalleryUrl(url);
        return openedLinks.has(normalized) || !!GM_getValue(pageDataKey(normalized), null);
    }

    function clearOpenedLinks() {
        openedLinks.clear();
        saveOpenedLinks();
        console.log("Cleared opened links cache");
    }

    // Create a fixed counter element
    var counter = document.createElement('div');
    counter.style.position = 'fixed';
    counter.style.top = '110px';
    counter.style.left = '10px';
    counter.style.fontSize = '55px';
    counter.style.color = 'red';
    counter.style.zIndex = '9999'; // ensures counter is always on top
    counter.innerHTML = getStoredCount();
    function attachCounter() {
        if (document.body && !counter.isConnected) {
            document.body.appendChild(counter);
        }
    }

    attachCounter();
    document.addEventListener("DOMContentLoaded", attachCounter);

    function updateCounter() {
        counter.innerHTML = getStoredCount();
    }

    function removeDataFromList(imageUrl) {
        const normalized = normalizeGalleryUrl(imageUrl);
        GM_deleteValue(pageDataKey(normalized));
        updateCounter();
    }

    function addDataToList(url, data) {
        const normalized = normalizeGalleryUrl(url);
        const key = pageDataKey(normalized);

        const payload = {
            ...data,
            url: normalized
        };

        GM_setValue(key, JSON.stringify(payload));
        updateCounter();
    }

    function removeCurrentPageData() {
        removeDataFromList(currentUrl);
    }


    async function copyToClipboard() {
        try {
            const storedData = getAllStoredData();
            const dataStrings = JSON.stringify(storedData, null, 2);
            await navigator.clipboard.writeText(dataStrings);
        } catch (err) {
            console.error("Failed to copy data: ", err);
        }
    }

    function clearList() {
        const keys = GM_listValues();
        for (const key of keys) {
            if (key.startsWith(DATA_KEY_PREFIX)) {
                GM_deleteValue(key);
            }
        }
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


    function open_all_links() {
        const max_parallel_tabs = 5;
        const check_every_ms = 250;
        const page_timeout_ms = 15000;
        const retry_limit = 1;

        const queuedUrls = new Set();
        let activeCount = 0;
        let finishedCount = 0;
        let producerDone = false;
        let noNewLinksRounds = 0;

        const queue = [];

        function maybeNotifyProgress() {
            if (finishedCount > 0 && finishedCount % 44 === 1) {
                window.focus();
                if (Notification.permission === "granted") {
                    new Notification("Time to check back on your process!");
                }
            }
        }

        function isSameOriginAccessible(win) {
            try {
                return !!win && !!win.location && win.location.origin === window.location.origin;
            } catch (e) {
                return false;
            }
        }

        function isChromeErrorPage(win) {
            try {
                return !!win && !!win.location && String(win.location.href).startsWith("chrome-error://");
            } catch (e) {
                return false;
            }
        }

        function enqueueDiscoveredLinks() {
            const hrefs = extract_valid_link()
                .map(href => normalizeGalleryUrl(href))
                .filter((href, index, arr) => arr.indexOf(href) === index);

            let added = 0;

            for (const href of hrefs) {
                if (hasLinkBeenOpened(href)) continue;
                if (queuedUrls.has(href)) continue;

                queuedUrls.add(href);
                queue.push({
                    normalizedUrl: href,
                    openUrl: href,
                    retries: 0
                });
                added++;
            }

            console.log("Discovered total links on page:", hrefs.length, "newly queued:", added, "queue size:", queue.length);
            return added;
        }

        function maybeFinishParent() {
            if (producerDone && activeCount === 0 && queue.length === 0) {
                console.log("Open All Links finished");
                copyToClipboard().catch(err => console.error("Final clipboard copy failed:", err));
                window.close();
            }
        }

        function launchMore() {
            while (activeCount < max_parallel_tabs && queue.length > 0) {
                const item = queue.shift();
                openOne(item);
            }
            maybeFinishParent();
        }

        function openOne(item) {

            const win = window.open(item.openUrl, "_blank");
            if (!win) {
                console.log("Popup blocked or window could not be opened:", item.openUrl);
                finishedCount++;
                maybeNotifyProgress();
                launchMore();
                return;
            }

            activeCount++;

            const timeout_counter_maximum = Math.ceil(page_timeout_ms / check_every_ms);
            let timeout_counter = 0;

            const checkLoad = setInterval(() => {
                try {
                    if (win.closed) {
                        clearInterval(checkLoad);
                        activeCount--;
                        finishedCount++;
                        maybeNotifyProgress();
                        launchMore();
                        return;
                    }

                    if (isChromeErrorPage(win)) {
                        clearInterval(checkLoad);
                        try { win.close(); } catch (e) {}
                        activeCount--;

                        if (item.retries < retry_limit) {
                            item.retries += 1;
                            queue.push(item);
                        } else {
                            console.log("Skipping chrome-error page:", item.normalizedUrl);
                            finishedCount++;
                        }

                        maybeNotifyProgress();
                        launchMore();
                        return;
                    }

                    if (!isSameOriginAccessible(win)) {
                        timeout_counter++;
                        if (timeout_counter > timeout_counter_maximum) {
                            clearInterval(checkLoad);
                            try { win.close(); } catch (e) {}
                            activeCount--;

                            if (item.retries < retry_limit) {
                                item.retries += 1;
                                queue.push(item);
                            } else {
                                console.log("Skipping inaccessible page:", item.normalizedUrl);
                                finishedCount++;
                            }

                            maybeNotifyProgress();
                            launchMore();
                        }
                        return;
                    }

                    const doc = win.document;
                    const body = doc && doc.body;
                    const readyState = doc ? doc.readyState : "";
                    const title = doc && doc.title ? doc.title.toLowerCase() : "";
                    const bodyText = body && body.innerText ? body.innerText.slice(0, 1200).toLowerCase() : "";

                    const childReady = !!(body && body.getAttribute("data-child-ready") === "true");
                    const copyFinished = !!(body && body.getAttribute("data-copy-finished") === "true");
                    const is404 =
                        title.includes("404") ||
                        bodyText.includes("404") ||
                        bodyText.includes("page not found") ||
                        bodyText.includes("not found");

                    if (readyState === "complete" && (childReady || copyFinished || is404)) {
                        clearInterval(checkLoad);
                        markLinkOpened(item.normalizedUrl);
                        try { win.close(); } catch (e) {}

                        activeCount--;
                        finishedCount++;
                        maybeNotifyProgress();
                        launchMore();
                        return;
                    }

                    timeout_counter++;
                    if (timeout_counter > timeout_counter_maximum) {
                        clearInterval(checkLoad);
                        try { win.close(); } catch (e) {}

                        activeCount--;

                        if (item.retries < retry_limit) {
                            item.retries += 1;
                            queue.push(item);
                        } else {
                            console.log("Skipping timed out page:", item.normalizedUrl);
                            finishedCount++;
                        }

                        maybeNotifyProgress();
                        launchMore();
                    }
                } catch (err) {
                    clearInterval(checkLoad);
                    try { win.close(); } catch (e) {}
                    activeCount--;

                    if (item.retries < retry_limit) {
                        item.retries += 1;
                        queue.push(item);
                    } else {
                        console.log("Skipping failed page:", item.normalizedUrl, err);
                        finishedCount++;
                    }

                    maybeNotifyProgress();
                    launchMore();
                }
            }, check_every_ms);
        }

        function producerTick() {
            const beforeQueued = queue.length + activeCount;
            window.scrollTo(0, document.body.scrollHeight);

            setTimeout(() => {
                const added = enqueueDiscoveredLinks();

                if (added === 0) {
                    noNewLinksRounds++;
                } else {
                    noNewLinksRounds = 0;
                }

                launchMore();

                const afterQueued = queue.length + activeCount;
                console.log("Producer tick - active:", activeCount, "queue:", queue.length, "finished:", finishedCount);

                if (noNewLinksRounds >= 4) {
                    producerDone = true;

                    if (queue.length > 0) {
                        const lastQueued = queue[queue.length - 1];
                        const lastUrl = new URL(lastQueued.openUrl);
                        lastUrl.searchParams.set("extra", "copy");
                        lastQueued.openUrl = lastUrl.toString();
                    }

                    console.log("No new links after several scroll rounds, finishing producer");
                    maybeFinishParent();
                    return;
                }

                producerTick();
            }, 900);
        }

        enqueueDiscoveredLinks();
        launchMore();
        producerTick();
    }

    GM_registerMenuCommand('Copy data to Clipboard', copyToClipboard);
    GM_registerMenuCommand('Clear data', clearList);
    GM_registerMenuCommand('Remove current page data', removeCurrentPageData);
    GM_registerMenuCommand('Open all links', open_all_links);
    GM_registerMenuCommand('Find most popular model name', findMostPopularModelNameShow);
    GM_registerMenuCommand("Clear opened links cache", clearOpenedLinks);

    let is_ready = false;

    function markChildReady() {
        if (!is_ready && document.body) {
            is_ready = true;
            document.body.setAttribute("data-child-ready", "true");
        }
    }

    function markCopyFinished() {
        if (document.body) {
            document.body.setAttribute("data-copy-finished", "true");
        }
    }

    const observer = new MutationObserver(() => {
        console.log("MutationObserver");
        markChildReady();
    });

    if (document.body) {
        observer.observe(document.body, { childList: true, subtree: true });
    }

    window.onload = () => {
        const urlParams = new URLSearchParams(window.location.search);
        const extra = urlParams.get("extra");
        console.log("window.onload");

        markChildReady();

        if (extra === "autoclose") {
            window.close();
        }

        if (extra === "copy") {
            makePageBlink();

            fetch("http://localhost:5001/trigger?message=reached_last_for_actress")
                .then(response => response.text())
                .then(data => {
                    console.log(data);
                    markCopyFinished();
                    window.close();
                })
                .catch(error => {
                    console.error("Error:", error);
                    markCopyFinished();
                    window.close();
                });
        }
    };

    document.addEventListener("DOMContentLoaded", () => {
        console.log("DOM fully loaded and parsed");
        markChildReady();
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
        markChildReady();

        const urlParams = new URLSearchParams(window.location.search);
        const extra = urlParams.get("extra");

        if (extra === "auto_download_all") {
            clearList();
            open_all_links();
        }
    });


    function findMostPopularModelNameShow() {
        alert(findMostPopularModelName());
    }


    function findMostPopularModelName() {
        const nameCount = {};
        const storedData = getAllStoredData();

        Object.values(storedData).forEach(entry => {
            (entry.modelName || []).forEach(name => {
                if (!nameCount[name]) {
                    nameCount[name] = 0;
                }
                nameCount[name]++;
            });
        });

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
