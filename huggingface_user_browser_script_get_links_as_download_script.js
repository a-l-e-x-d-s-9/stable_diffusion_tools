// ==UserScript==
// @name         Huggingface extract files
// @namespace    http://tampermonkey.net/
// @version      0.1
// @description  try to take over the world!
// @author       You
// @match        https://huggingface.co/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=huggingface.co
// @grant        GM_registerMenuCommand
// @grant        GM_setClipboard
// ==/UserScript==


(function() {
    'use strict';

    const extractAndConvertLinks = () => {
        const links = Array.from(document.querySelectorAll('a[href]'))
            .map(a => a.href)
            .filter(href => href.includes('/blob/main/')) // Modify this condition if needed
            .map(href => ({
                command: `#wget --header="$HEADER" "${href.replace('/blob/main/', '/resolve/main/')}"`,
                episode: (href.match(/-ep(\d+)-/) || [, 0])[1]
            }))
            .sort((a, b) => b.episode - a.episode)
            .map(({command}) => command)
            .join('\n');
        GM_setClipboard("#!/usr/bin/env bash\nHF_TOKEN=`cat ~/stable-diffusion-webui/models/Stable-diffusion/hf_token`\nHEADER=\"Authorization: Bearer ${HF_TOKEN}\"\n" + links);
        createSplash('green', 'Links have been extracted, converted, and sorted.');
        console('Links have been extracted, converted, and sorted.');
    };

    const clearClipboard = () => {
        GM_setClipboard('');
        createSplash('yellow', 'Clipboard cleared.');
        console('Clipboard cleared.');
    };

    document.addEventListener('keydown', function(e) {
        if (e.ctrlKey && e.shiftKey && e.code === 'KeyX') {
            extractAndConvertLinks();
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

    GM_registerMenuCommand('Extract and Convert Links', extractAndConvertLinks);
    GM_registerMenuCommand('Clear Clipboard', clearClipboard);
})();