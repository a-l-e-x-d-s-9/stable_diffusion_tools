// ==UserScript==
// @name         Civitai Alexds9 HF Collection Link
// @namespace    http://tampermonkey.net/
// @version      1.02
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
    const DEBUG = false;

    const MONTHS = [
        'January', 'February', 'March', 'April', 'May', 'June',
        'July', 'August', 'September', 'October', 'November', 'December'
    ];

    // Keep this reasonably future-proof. The script is harmless if no matching text exists.
    const MONTH_RE = new RegExp(
        '\\b(' + MONTHS.join('|') + ')\\s+(2025|2026|2027|2028|2029|2030)\\b',
        'gi'
    );

    function log(...args) {
        if (DEBUG) console.log('[alexds9-hf-link]', ...args);
    }

    function normalizeText(s) {
        return (s || '').replace(/\s+/g, ' ').trim();
    }

    function isAllowedCivitaiHost() {
        return /^civitai\.(com|green|red)$/i.test(location.hostname);
    }

    function isModelPage() {
        return isAllowedCivitaiHost() && /^\/models\/\d+/i.test(location.pathname);
    }

    function extractUsernameFromHref(href) {
        if (!href) return null;

        try {
            const url = new URL(href, location.origin);
            if (!/^civitai\.(com|green|red)$/i.test(url.hostname)) return null;

            const m = url.pathname.match(/^\/user\/([^/?#]+)/i);
            if (!m) return null;

            return decodeURIComponent(m[1] || '').trim() || null;
        } catch (_) {
            const m = href.match(/(?:^|\/+)user\/([^/?#]+)/i);
            return m ? decodeURIComponent(m[1] || '').trim() : null;
        }
    }

    function getCreatorUsername() {
        // Civitai has changed between relative and absolute user links on different domains.
        const userLinks = Array.from(document.querySelectorAll(
            'a[href^="/user/"], a[href*="/user/"]'
        ));

        const usernames = [];

        for (const a of userLinks) {
            const username = extractUsernameFromHref(a.getAttribute('href') || '');
            if (!username) continue;
            usernames.push(username);

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
        }

        // Fallback: if the target creator appears anywhere as a user link, accept it.
        // This avoids false negatives when Civitai renders avatars/user names differently.
        const target = usernames.find(u => u.toLowerCase() === TARGET_USERNAME.toLowerCase());
        if (target) return target;

        return usernames[0] || null;
    }

    function hasMonthYearText(el) {
        if (!el) return false;
        const text = normalizeText(el.textContent || '');
        if (!text) return false;

        const ok = MONTH_RE.test(text);
        MONTH_RE.lastIndex = 0;
        return ok;
    }

    function findDescriptionRoot() {
        const preferredSelectors = [
            // Civitai description/html renderer variants seen over time.
            '.RenderHtml_htmlRenderer__z8vxT',
            '[class*="RenderHtml_htmlRenderer"]',
            '.mantine-TypographyStylesProvider-root',
            '[class*="TypographyStylesProvider"]',
            '.mantine-Spoiler-content',
            '[class*="Spoiler-content"]',
            '[data-testid*="description" i]',
            '[class*="description" i]',
            'article'
        ];

        for (const sel of preferredSelectors) {
            const nodes = Array.from(document.querySelectorAll(sel));
            for (const el of nodes) {
                if (hasMonthYearText(el)) return el;
            }
        }

        // Fallback: choose the smallest useful container that contains Month Year text.
        // This avoids returning a huge top-level page wrapper when possible.
        const candidates = Array.from(document.querySelectorAll('p, li, div, section'))
            .filter(hasMonthYearText)
            .sort((a, b) => (a.textContent || '').length - (b.textContent || '').length);

        return candidates[0] || null;
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

        // Do not change existing links, buttons, scripts, or style blocks.
        if (parent.closest('a[href], button, script, style, textarea, input')) return false;

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

        if (textNode.parentNode) {
            textNode.parentNode.replaceChild(frag, textNode);
            return true;
        }

        return false;
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
                    if (parent.closest('a[href], button, script, style, textarea, input')) {
                        return NodeFilter.FILTER_SKIP;
                    }

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
            log('Not target creator:', username);
            return;
        }

        const descRoot = findDescriptionRoot();
        if (!descRoot) {
            log('Description root not found');
            return;
        }

        const changed = processDescription(descRoot);
        if (changed) {
            log('Inserted Hugging Face collection links');
        }
    }

    let scheduled = false;
    let observer = null;

    function scheduleProcess(delay = 300) {
        if (scheduled) return;
        scheduled = true;

        setTimeout(() => {
            scheduled = false;
            try {
                processPage();
            } catch (err) {
                console.error('[alexds9-hf-link] Error:', err);
            }
        }, delay);
    }

    function initObserver() {
        if (observer) observer.disconnect();

        observer = new MutationObserver(() => {
            scheduleProcess(300);
        });

        observer.observe(document.documentElement || document.body, {
            childList: true,
            subtree: true
        });
    }

    function init() {
        // Run a few times because Civitai is SPA-rendered and the creator/description can arrive late.
        scheduleProcess(100);
        scheduleProcess(700);
        setTimeout(() => scheduleProcess(0), 1500);
        setTimeout(() => scheduleProcess(0), 3000);

        initObserver();

        let lastUrl = location.href;
        setInterval(() => {
            if (location.href !== lastUrl) {
                lastUrl = location.href;
                scheduleProcess(500);
            }
        }, 1000);
    }

    init();
})();
