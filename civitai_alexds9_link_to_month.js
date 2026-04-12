// ==UserScript==
// @name         Civitai Alexds9 HF Collection Link
// @namespace    http://tampermonkey.net/
// @version      1.00
// @description  On Civitai model pages by alexds9, convert collection month/year text in the description into a Hugging Face link.
// @author       OpenAI
// @match        https://civitai.com/models/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    const TARGET_USERNAME = 'alexds9';
    const HF_ORG = 'AIxFuneStudio';

    const MONTHS = [
        'January', 'February', 'March', 'April', 'May', 'June',
        'July', 'August', 'September', 'October', 'November', 'December'
    ];

    function log(...args) {
        console.log('[alexds9-hf-link]', ...args);
    }

    function normalizeText(s) {
        return (s || '').replace(/\s+/g, ' ').trim();
    }

    function isModelPage() {
        return /^https:\/\/civitai\.com\/models\/\d+/i.test(location.href);
    }

    function getCreatorUsername() {
        const userLinks = Array.from(document.querySelectorAll('a[href^="/user/"]'));
        for (const a of userLinks) {
            const href = a.getAttribute('href') || '';
            const m = href.match(/^\/user\/([^/?#]+)/i);
            if (!m) continue;

            const username = m[1].trim();
            const text = normalizeText(a.textContent);

            if (username && text.toLowerCase().includes(username.toLowerCase())) {
                return username;
            }

            const altImg = a.querySelector('img[alt]');
            if (altImg) {
                const alt = altImg.getAttribute('alt') || '';
                if (alt.toLowerCase().includes(username.toLowerCase())) {
                    return username;
                }
            }

            return username;
        }
        return null;
    }

    function findDescriptionRoot() {
        const candidates = Array.from(document.querySelectorAll('div, section'));

        for (const el of candidates) {
            const text = normalizeText(el.textContent);
            if (!text) continue;

            if (
                text.includes('This model is part of') &&
                text.includes('models collection') &&
                text.includes('AIxFun eStudio members')
            ) {
                return el;
            }
        }

        return null;
    }

    function extractMonthYearFromText(text) {
        const monthPattern = MONTHS.join('|');
        const re = new RegExp(`\\b(${monthPattern})\\s+(20\\d{2})\\b`, 'i');
        const m = text.match(re);
        if (!m) return null;

        const month = MONTHS.find(x => x.toLowerCase() === m[1].toLowerCase());
        const year = m[2];
        if (!month || !year) return null;

        return {
            month,
            year,
            label: `${month} ${year}`
        };
    }

    function buildHfUrl(month, year) {
        return `https://huggingface.co/${HF_ORG}/${year}_${month}/tree/main`;
    }

    function alreadyLinked(node, url) {
        if (!node) return false;
        const parentLink = node.parentElement && node.parentElement.closest('a[href]');
        if (!parentLink) return false;
        return parentLink.href === url;
    }

    function replaceTextNodeMatch(textNode, label, url) {
        if (!textNode || !textNode.nodeValue) return false;

        const text = textNode.nodeValue;
        const idx = text.indexOf(label);
        if (idx === -1) return false;

        if (alreadyLinked(textNode, url)) return false;

        const before = text.slice(0, idx);
        const match = text.slice(idx, idx + label.length);
        const after = text.slice(idx + label.length);

        const frag = document.createDocumentFragment();

        if (before) {
            frag.appendChild(document.createTextNode(before));
        }

        const a = document.createElement('a');
        a.href = url;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.textContent = match;
        a.style.textDecoration = 'underline';

        frag.appendChild(a);

        if (after) {
            frag.appendChild(document.createTextNode(after));
        }

        textNode.parentNode.replaceChild(frag, textNode);
        return true;
    }

    function walkAndReplace(root, label, url) {
        const walker = document.createTreeWalker(
            root,
            NodeFilter.SHOW_TEXT,
            {
                acceptNode(node) {
                    if (!node.nodeValue || !node.nodeValue.includes(label)) {
                        return NodeFilter.FILTER_SKIP;
                    }

                    const parent = node.parentElement;
                    if (!parent) return NodeFilter.FILTER_SKIP;

                    if (parent.closest('a[href]')) {
                        return NodeFilter.FILTER_SKIP;
                    }

                    return NodeFilter.FILTER_ACCEPT;
                }
            }
        );

        const matches = [];
        let node;
        while ((node = walker.nextNode())) {
            matches.push(node);
        }

        let changed = false;
        for (const textNode of matches) {
            if (replaceTextNodeMatch(textNode, label, url)) {
                changed = true;
            }
        }
        return changed;
    }

    function processPage() {
        if (!isModelPage()) return;

        const username = getCreatorUsername();
        if (!username || username.toLowerCase() !== TARGET_USERNAME.toLowerCase()) {
            return;
        }

        const descRoot = findDescriptionRoot();
        if (!descRoot) return;

        const text = normalizeText(descRoot.textContent);
        const info = extractMonthYearFromText(text);
        if (!info) return;

        const hfUrl = buildHfUrl(info.month, info.year);
        const changed = walkAndReplace(descRoot, info.label, hfUrl);

        if (changed) {
            log(`Linked "${info.label}" -> ${hfUrl}`);
        }
    }

    let observer = null;
    let scheduled = false;

    function scheduleProcess() {
        if (scheduled) return;
        scheduled = true;
        setTimeout(() => {
            scheduled = false;
            try {
                processPage();
            } catch (err) {
                console.error('[alexds9-hf-link] Error:', err);
            }
        }, 300);
    }

    function initObserver() {
        if (observer) observer.disconnect();

        observer = new MutationObserver(() => {
            scheduleProcess();
        });

        observer.observe(document.documentElement || document.body, {
            childList: true,
            subtree: true
        });
    }

    function init() {
        processPage();
        initObserver();

        let lastUrl = location.href;
        setInterval(() => {
            if (location.href !== lastUrl) {
                lastUrl = location.href;
                scheduleProcess();
            }
        }, 1000);
    }

    init();
})();