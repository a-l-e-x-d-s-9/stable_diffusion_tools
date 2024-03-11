// ==UserScript==
// @name         Extract files to clipboard
// @namespace    http://tampermonkey.net/
// @version      2024-03-11
// @description  try to take over the world!
// @author       You
// @match        https://civitai.com/models/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=civitai.com
// @grant        GM_registerMenuCommand
// @grant        GM_setClipboard
// @grant        GM_getClipboard
// @grant        GM_setValue
// @grant        GM_getValue
// ==/UserScript==

(function() {
    'use strict';

    // Function to extract model title
    function getModelTitle() {
        const titleElement = document.querySelector('.mantine-Stack-root h1.mantine-Text-root.mantine-Title-root');
        return titleElement ? titleElement.innerText.trim() : '';
    }

    // Function to extract download links and return them as an array
    function getDownloadLinks() {

        const civitai_download_token = GM_getValue("civitai_download_token", null);
        if (!civitai_download_token){
            alert("Civitai download token missing, go to menu and click to add it.");
            createSplash('red', 'Civitai download token missing.');
            return;
        }

        const links = [];
        document.querySelectorAll('.mantine-Accordion-item a.mantine-UnstyledButton-root.mantine-Button-root[type="button"][data-button="true"]').forEach(link => {
            const href = link.getAttribute('href');
            if (href) {
                links.push(`https://civitai.com${href.replace('&amp;', '&')}&token=` + civitai_download_token);
            }
        });
        return links;
    }

    // Main function to format and copy the data
    async function formatAndCopyData() {
        const title = getModelTitle();
        const downloadLinks = getDownloadLinks();
        const currentPageUrl = window.location.href;

        // Generating the final string for each download link
        const finalStrings = downloadLinks.map(link => `wget --content-disposition "${link}" # ${title} # ${currentPageUrl}`).join('\n');

        try {
            let clipboardContent = await navigator.clipboard.readText(); // Wait for the clipboard content
            if (clipboardContent.length > 0) { // Corrected property name from 'lenght' to 'length'
                clipboardContent += "\n"; // Add a new line if there's existing content
            }
            // Copying the result to clipboard
            GM_setClipboard(clipboardContent + finalStrings);
            createSplash('green', 'Links have been extracted, converted, and sorted.');
            console.log('Links have been extracted, converted, and sorted.');
        } catch (error) {
            console.error('Error accessing the clipboard', error);
            createSplash('red', 'Failed to access clipboard.');
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
        }, 200);
    }

    const clearClipboard = () => {
        GM_setClipboard('');
        createSplash('yellow', 'Clipboard cleared.');
        console('Clipboard cleared.');
    };

    // Function to prompt user for sensitive information and save it
    function setCivitaiToken() {
        const civitai_download_token = prompt("Please enter your Civitai download token:", "");
        if (civitai_download_token != null) {
            GM_setValue("civitai_download_token", civitai_download_token);
            alert("Civitai download token saved securely.");
        }
    }

    // Add menu command to set credentials
    GM_registerMenuCommand("Set Civitai download token", setCivitaiToken);
    GM_registerMenuCommand('Extract and Convert Links [CTRL+SHIFT+X]', formatAndCopyData);
    GM_registerMenuCommand('Clear Clipboard [CTRL+SHIFT+Z]', clearClipboard);
})();