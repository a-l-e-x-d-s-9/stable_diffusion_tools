// ==UserScript==
// @name         Extract files to clipboard
// @namespace    http://tampermonkey.net/
// @version      2024-07-20
// @description  Extract download links from Civitai
// @author       You
// @match        https://civitai.com/models/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=civitai.com
// @grant        GM_registerMenuCommand
// @grant        GM_setClipboard
// @grant        GM_getValue
// @grant        GM_setValue
// ==/UserScript==

(function() {
    'use strict';

    // Function to extract model title
    function getModelTitle() {
        const titleElement = document.querySelector('.mantine-Stack-root h1.mantine-Text-root.mantine-Title-root');
        return titleElement ? titleElement.innerText.trim() : '';
    }

    // Function to extract model version ID from the download link
    function getModelVersionId() {
        const downloadButton = document.querySelector('.mantine-UnstyledButton-root.mantine-Button-root.mantine-14hm07m');
        if (downloadButton) {
            const href = downloadButton.getAttribute('href');
            const match = href.match(/\/api\/download\/models\/(\d+)\?/);
            return match ? match[1] : '';
        }
        return '';
    }



    // Function to fetch download links from API
    async function fetchDownloadLinks(versionId, token) {
        const response = await fetch(`https://civitai.com/api/v1/model-versions/${versionId}`, {
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            }
        });

        if (!response.ok) {
            throw new Error('Failed to fetch download links');
        }

        const data = await response.json();
        return data.files.map(file => file.downloadUrl);
    }

    // Main function to format and copy the data
    async function formatAndCopyData() {
        const title = getModelTitle();
        const versionId = getModelVersionId();
        const currentPageUrl = window.location.href;

        if (!versionId) {
            alert('Model version ID not found on the page.');
            return;
        }

        const civitaiDownloadToken = GM_getValue("civitai_download_token", null);
        if (!civitaiDownloadToken) {
            alert("Civitai download token missing, go to menu and click to add it.");
            createSplash('red', 'Civitai download token missing.');
            return;
        }

        try {
            const downloadLinks = await fetchDownloadLinks(versionId, civitaiDownloadToken);
            const finalStrings = downloadLinks.map(link => `wget --content-disposition "${link}?token=` + civitaiDownloadToken + `" # ${title} # ${currentPageUrl}`).join('\n');

            let clipboardContent = await navigator.clipboard.readText();
            if (clipboardContent.length > 0) {
                clipboardContent += "\n";
            }

            GM_setClipboard(clipboardContent + finalStrings);
            createSplash('green', 'Links have been extracted, converted, and sorted.');
            console.log('Links have been extracted, converted, and sorted.');
        } catch (error) {
            console.error('Error fetching download links', error);
            createSplash('red', 'Failed to fetch download links.');
        }
    }

    document.addEventListener('keydown', async function(e) {
        if (e.ctrlKey && e.shiftKey && e.code === 'KeyX') {
            await formatAndCopyData();
        }
        if (e.ctrlKey && e.shiftKey && e.code === 'KeyZ') {
            clearClipboard();
        }
    });

    function createSplash(color, message) {
        let splash = document.createElement('div');
        splash.style.position = 'fixed';
        splash.style.top = '0';
        splash.style.left = '0';
        splash.style.width = '100%';
        splash.style.height = '100%';
        splash.style.backgroundColor = color;
        splash.style.color = 'white';
        splash.style.display = 'flex';
        splash.style.justifyContent = 'center';
        splash.style.alignItems = 'center';
        splash.style.zIndex = '9999';
        splash.textContent = message;
        document.body.appendChild(splash);
        setTimeout(function() {
            splash.remove();
        }, 300);
    }

    const clearClipboard = () => {
        GM_setClipboard('');
        createSplash('yellow', 'Clipboard cleared.');
        console.log('Clipboard cleared.');
    };

    // Function to prompt user for sensitive information and save it
    function setCivitaiToken() {
        const civitaiDownloadToken = prompt("Please enter your Civitai download token:", "");
        if (civitaiDownloadToken != null) {
            GM_setValue("civitai_download_token", civitaiDownloadToken);
            alert("Civitai download token saved securely.");
        }
    }

    // Add menu command to set credentials
    GM_registerMenuCommand("Set Civitai download token", setCivitaiToken);
    GM_registerMenuCommand('Extract and Convert Links [CTRL+SHIFT+X]', formatAndCopyData);
    GM_registerMenuCommand('Clear Clipboard [CTRL+SHIFT+Z]', clearClipboard);
})();
