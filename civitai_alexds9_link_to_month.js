// ==UserScript==
// @name         Civitai Alexds9 HF Collection Link
// @namespace    http://tampermonkey.net/
// @version      1.01
// @description  On Civitai model pages by alexds9, convert Month Year text in the model description into a Hugging Face collection link.
// @author       OpenAI
// @match        https://civitai.com/models/*
// @match        https://civitai.green/models/*
// @match        https://civitai.red/models/*
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

    const MONTH_RE = new RegExp(
        '\\b(' + MONTHS.join('|') + ')\\s+(2025|2026)\\b',
        'gi'
    );

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

            const username = (m[1] || '').trim();
            if (!username) continue;

            const text = normalizeText(a.textContent || '');
            if (text.toLowerCase().includes(username.toLowerCase())) {
                return username;
            }

            const img = a.querySelector('img[alt]');
            if (img) {
                const alt = img.getAttribute('alt') || '';
                if (alt.toLowerCase().includes(username.toLowerCase())) {
                    return username;
                }
            }

            return username;
        }
        return null;
    }

    function findDescriptionRoot() {
        const preferredSelectors = [
            '.mantine-Spoiler-content',
            '[role="region"]',
            '.RenderHtml_htmlRenderer__z8vxT',
            '.mantine-TypographyStylesProvider-root'
        ];

        for (const sel of preferredSelectors) {
            const nodes = Array.from(document.querySelectorAll(sel));
            for (const el of nodes) {
                const text = normalizeText(el.textContent);
                if (!text) continue;
                if (MONTH_RE.test(text)) {
                    MONTH_RE.lastIndex = 0;
                    return el;
                }
                MONTH_RE.lastIndex = 0;
            }
        }

        const allDivs = Array.from(document.querySelectorAll('div, section, article'));
        for (const el of allDivs) {
            const text = normalizeText(el.textContent);
            if (!text) continue;

            if (MONTH_RE.test(text)) {
                MONTH_RE.lastIndex = 0;
                return el;
            }
            MONTH_RE.lastIndex = 0;
        }

        return null;
    }

    function buildHfUrl(month, year) {
        return `https://huggingface.co/${HF_ORG}/${year}_${month}/tree/main`;
    }

    function createLink(label, month, year) {
        const a = document.createElement('a');
        a.href = buildHfUrl(month, year);
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.textContent = label;
        a.style.textDecoration = 'underline';
        return a;
    }

    function replaceMonthYearInTextNode(textNode) {
        const text = textNode.nodeValue;
        if (!text) return false;
        if (!MONTH_RE.test(text)) {
            MONTH_RE.lastIndex = 0;
            return false;
        }
        MONTH_RE.lastIndex = 0;

        const parent = textNode.parentElement;
        if (!parent) return false;
        if (parent.closest('a[href]')) return false;

        const frag = document.createDocumentFragment();
        let lastIndex = 0;
        let changed = false;

        let match;
        while ((match = MONTH_RE.exec(text)) !== null) {
            const full = match[0];
            const monthRaw = match[1];
            const year = match[2];

            const month = MONTHS.find(m => m.toLowerCase() === monthRaw.toLowerCase());
            if (!month) continue;

            const start = match.index;
            const end = start + full.length;

            if (start > lastIndex) {
                frag.appendChild(document.createTextNode(text.slice(lastIndex, start)));
            }

            frag.appendChild(createLink(`${month} ${year}`, month, year));
            lastIndex = end;
            changed = true;
        }

        MONTH_RE.lastIndex = 0;

        if (!changed) return false;

        if (lastIndex < text.length) {
            frag.appendChild(document.createTextNode(text.slice(lastIndex)));
        }

        textNode.parentNode.replaceChild(frag, textNode);
        return true;
    }

    function processDescription(root) {
        if (!root) return false;

        const walker = document.createTreeWalker(
            root,
            NodeFilter.SHOW_TEXT,
            {
                acceptNode(node) {
                    if (!node.nodeValue) return NodeFilter.FILTER_SKIP;
                    if (!MONTH_RE.test(node.nodeValue)) {
                        MONTH_RE.lastIndex = 0;
                        return NodeFilter.FILTER_SKIP;
                    }
                    MONTH_RE.lastIndex = 0;

                    const parent = node.parentElement;
                    if (!parent) return NodeFilter.FILTER_SKIP;
                    if (parent.closest('a[href]')) return NodeFilter.FILTER_SKIP;

                    return NodeFilter.FILTER_ACCEPT;
                }
            }
        );

        const nodes = [];
        let node;
        while ((node = walker.nextNode())) {
            nodes.push(node);
        }

        let changed = false;
        for (const textNode of nodes) {
            if (replaceMonthYearInTextNode(textNode)) {
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

        const changed = processDescription(descRoot);
        if (changed) {
            log('Inserted Hugging Face collection links');
        }
    }

    let scheduled = false;
    let observer = null;

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