// ==UserScript==
// @name         Civitai Rating Highlighter
// @namespace    https://civitai.com/
// @version      1.1.2
// @description  Highlight and navigate unrated images/videos, with optional blinking, shortcuts, and traffic-light rating colors. Disabled by default.
// @match        https://civitai.com/*
// @match        https://civitai.red/*
// @run-at       document-idle
// @noframes
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// ==/UserScript==

(() => {
    'use strict';

    const KEY = 'civitai-rating-highlighter-v1';
    const PANEL_HIDDEN_KEY = `${KEY}-panel-hidden`;
    const FRAME = 'data-civitai-rating-unrated';
    const COLOR = 'data-civitai-rating-color';
    // Use stable class names/prefixes, not Mantine's generated hashes.
    const BADGE = '.mantine-Badge-root[class*="ImageGuard"]';
    const CHIP = '[class*="BrowsingLevelsGrouped"] .mantine-Chip-label';
    const LINK = 'a[href*="/images/"], a[href*="/posts/"]';
    const MEDIA = 'img, video, [class*="EdgeImage"], [class*="EdgeVideo"]';
    const PALETTE = {
        PG: ['#00e676', '#071c10'],
        'PG-13': ['#a1fd7c', '#182000'],
        R: ['#ffee00', '#211d00'],
        X: ['#ff641c', '#291500'],
        XXX: ['#ff1744', '#ffffff'],
    };
    const defaults = {
        enabled: false, markUnrated: true, colorRatings: true,
        blinkUnrated: false, shortcutsEnabled: false,
        previousShortcut: 'Alt+ArrowUp', nextShortcut: 'Alt+ArrowDown',
    };
    let saved;
    try { saved = GM_getValue(KEY, {}); } catch { saved = {}; }
    const settings = Object.fromEntries(Object.entries(defaults).map(([key, value]) =>
        [key, typeof saved?.[key] === typeof value ? saved[key] : value]));
    let timer = null;
    let observer = null;
    let framed = new Set();
    let colored = new Set();
    let unrated = [];
    let currentCard = null;
    let currentHref = null;
    let currentPage = location.href;

    const style = document.createElement('style');
    style.textContent = `
        [${FRAME}] { position: relative !important; isolation: isolate !important; }
        /* A foreground layer keeps positioned images from painting over the frame. */
        [${FRAME}]::after {
            content: "" !important; display: block !important; position: absolute !important;
            inset: 0 !important; z-index: 100 !important; pointer-events: none !important;
            box-sizing: border-box !important; border: 8px solid #ff1744 !important;
            border-radius: inherit !important; background: transparent !important;
        }
        [${FRAME}="blink"]::after { animation: crh-frame-blink 2.4s ease-in-out infinite !important; }
        @keyframes crh-frame-blink { 0%, 100% { opacity: 1; } 50% { opacity: 0.15; } }
        [${COLOR}] {
            background: var(--crh-bg) !important; color: var(--crh-fg) !important;
            border: 2px solid var(--crh-fg) !important; font-weight: 800 !important;
            text-shadow: none !important;
        }
        [${COLOR}] .mantine-Badge-label { color: inherit !important; }
        /* Keep the filter's checked/unchecked states visually distinct. */
        .mantine-Chip-label[${COLOR}]:not([data-checked]) { border-style: dashed !important; }
        .mantine-Chip-label[${COLOR}][data-checked] { box-shadow: 0 0 0 2px #fff, 0 0 0 3px #111 !important; }
        ${Object.entries(PALETTE).map(([rating, [bg, fg]]) =>
            `[${COLOR}="${rating}"] { --crh-bg: ${bg}; --crh-fg: ${fg}; }`).join('\n')}
    `;

    const host = document.createElement('div');
    host.id = 'civitai-rating-highlighter';
    host.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483646;';
    const ui = host.attachShadow({ mode: 'open' });
    ui.innerHTML = `
        <style>
            :host { all: initial; font: 13px/1.5 system-ui, sans-serif; color-scheme: dark; }
            * { box-sizing: border-box; }
            details { width: 290px; max-width: calc(100vw - 32px); color: #f8fafc; }
            summary { margin-left: auto; width: max-content; cursor: pointer; padding: 8px 12px;
                border: 1px solid #94a3b8; border-radius: 8px; background: #172033; font-weight: 700; }
            section { margin-top: 8px; padding: 14px; border: 1px solid #94a3b8; border-radius: 10px;
                max-height: calc(100vh - 90px); overflow-y: auto;
                background: #111827; box-shadow: 0 4px 24px #0008; }
            label { display: flex; align-items: center; gap: 8px; padding: 6px 0; cursor: pointer; }
            input[type="checkbox"] { width: 16px; height: 16px; margin: 0; accent-color: #22c55e; flex-shrink: 0; }
            input[type="text"] { width: 150px; min-width: 0; margin-left: auto; padding: 6px;
                border: 1px solid #94a3b8; border-radius: 5px; background: #1e293b; color: #fff; }
            button { padding: 7px 10px; border: 1px solid #94a3b8; border-radius: 6px;
                background: #1e293b; color: #fff; cursor: pointer; font: inherit; }
            button:disabled { opacity: 0.45; cursor: default; }
            .navigation { display: flex; gap: 8px; margin-top: 12px; }
            .navigation button { flex: 1; }
            p { margin: 10px 0 0; color: #cbd5e1; font-size: 12px; }
            .legend { display: flex; gap: 6px; margin-top: 10px; flex-wrap: wrap; }
            .legend span { padding: 2px 7px; border-radius: 5px; font-weight: 800; }
        </style>
        <details>
            <summary>Ratings: <span id="state">Off</span></summary>
            <section aria-label="Rating highlighter settings">
                <button id="hidePanel" type="button">Hide settings panel</button>
                <p>Reopen from the userscript manager menu → Rating highlighter settings. The script keeps running while hidden.</p>
                <label><input id="enabled" type="checkbox">Enable rating highlighter</label>
                <label><input id="markUnrated" type="checkbox">Red frame for unrated media</label>
                <label><input id="blinkUnrated" type="checkbox">Slow blinking red frame</label>
                <label><input id="colorRatings" type="checkbox">Color rating badges and filters</label>
                <div class="legend">${Object.entries(PALETTE).map(([rating, [bg, fg]]) =>
                    `<span style="background:${bg};color:${fg}">${rating}</span>`).join('')}</div>
                <p>Unrated means no rating badge is present on the card. Hidden site ratings cannot be verified.</p>
                <p id="status" role="status"></p>
                <div class="navigation">
                    <button id="previous" type="button">← Previous</button>
                    <button id="next" type="button">Next →</button>
                </div>
                <p id="navigationStatus" role="status">Jump between loaded unrated images and videos.</p>
                <label><input id="shortcutsEnabled" type="checkbox">Enable keyboard shortcuts</label>
                <label>Previous<input id="previousShortcut" type="text" readonly aria-label="Previous unrated shortcut"></label>
                <label>Next<input id="nextShortcut" type="text" readonly aria-label="Next unrated shortcut"></label>
                <p>Click a shortcut field and press your preferred key combination. Backspace clears it. Shortcuts are ignored while typing.</p>
            </section>
        </details>
    `;

    function readRating(element) {
        const text = element.textContent.replace(/\s+/g, '').toUpperCase();
        return Object.hasOwn(PALETTE, text) ? text : null;
    }

    function mediaLinks(root) {
        return [...root.querySelectorAll(LINK)].filter(link => {
            const url = new URL(link.href, location.href);
            return /^\/(images|posts)\/\d+\/?$/.test(url.pathname)
                && url.origin === location.origin && link.querySelector(MEDIA);
        });
    }

    function findCards() {
        const cards = new Set();
        for (const link of mediaLinks(document)) {
            // Both the virtual gallery and post-detail cards in the supplied HTML
            // have an overflow-hidden outer card, with the badge beside the media link.
            let card = link.closest('.relative.overflow-hidden, .mantine-Paper-root');
            // Do not let a grid/post container's rating cover several different images.
            if (!card || mediaLinks(card).length > 1) card = link.parentElement.closest('.relative');
            if (card && mediaLinks(card).length === 1) cards.add(card);
        }
        return cards;
    }

    function syncMarks(nextFrames, nextColors) {
        for (const card of framed) if (!nextFrames.has(card)) card.removeAttribute(FRAME);
        for (const badge of colored) if (!nextColors.has(badge)) badge.removeAttribute(COLOR);
        const frameMode = settings.blinkUnrated ? 'blink' : '';
        for (const card of nextFrames) {
            if (card.getAttribute(FRAME) !== frameMode) card.setAttribute(FRAME, frameMode);
        }
        for (const [badge, rating] of nextColors) {
            if (badge.getAttribute(COLOR) !== rating) badge.setAttribute(COLOR, rating);
        }
        framed = nextFrames;
        colored = new Set(nextColors.keys());
    }

    function scan() {
        if (timer !== null) window.clearTimeout(timer);
        timer = null;
        if (!settings.enabled) return;
        if (currentPage !== location.href) {
            currentPage = location.href;
            currentCard = null;
        }
        const cards = findCards();
        const nextFrames = new Set();
        const nextColors = new Map();
        let missing = 0;
        unrated = [];
        for (const card of cards) {
            const badges = [...card.querySelectorAll(BADGE)];
            if (!badges.some(badge => readRating(badge))) {
                missing++;
                unrated.push(card);
                if (settings.markUnrated) nextFrames.add(card);
            }
        }
        if (settings.colorRatings) {
            for (const badge of document.querySelectorAll(`${BADGE}, ${CHIP}`)) {
                const rating = readRating(badge);
                if (rating) nextColors.set(badge, rating);
            }
        }
        syncMarks(nextFrames, nextColors);
        const status = ui.getElementById('status');
        const message = `${missing} without a rating badge / ${cards.size} loaded media cards`;
        if (status.textContent !== message) status.textContent = message;
        for (const id of ['previous', 'next']) ui.getElementById(id).disabled = unrated.length === 0;
    }

    function navigate(direction) {
        if (!settings.enabled) return;
        scan(); // Recheck ratings and recycled cards before choosing a destination.
        const candidates = unrated.map(card => ({ card, rect: card.getBoundingClientRect() }))
            .filter(({ card, rect }) => rect.width > 0 && rect.height > 0
                && getComputedStyle(card).visibility !== 'hidden')
            .sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left);
        const currentIndex = candidates.findIndex(({ card, rect }) => card === currentCard
            && mediaLinks(card)[0]?.href === currentHref && rect.bottom > 0 && rect.top < innerHeight);
        let index;
        if (currentIndex >= 0) index = currentIndex + direction;
        else if (direction > 0) index = candidates.findIndex(({ rect }) => rect.bottom > 96);
        else index = candidates.findLastIndex(({ rect }) => rect.top < 96);
        const target = candidates[index]?.card;
        const message = ui.getElementById('navigationStatus');
        if (!target) {
            message.textContent = candidates.length
                ? `No ${direction > 0 ? 'next' : 'previous'} loaded unrated card. Scroll to load more.`
                : 'No loaded unrated cards found.';
            return;
        }
        currentCard = target;
        currentHref = mediaLinks(target)[0]?.href;
        // Instant scrolling avoids a second keypress racing an unfinished smooth scroll.
        target.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'nearest' });
        message.textContent = `Unrated card ${index + 1} of ${candidates.length} loaded`;
    }

    function shortcutFor(event) {
        if (['Control', 'Alt', 'Shift', 'Meta', 'Dead', 'Unidentified'].includes(event.key)) return '';
        const key = event.key.length === 1 ? event.key.toUpperCase() : event.key;
        return [event.ctrlKey && 'Ctrl', event.altKey && 'Alt', event.shiftKey && 'Shift',
            event.metaKey && 'Meta', key === ' ' ? 'Space' : key].filter(Boolean).join('+');
    }

    function onShortcut(event) {
        if (!settings.enabled || !settings.shortcutsEnabled || event.defaultPrevented
            || event.repeat || event.isComposing) return;
        if (event.composedPath().some(node => node instanceof HTMLElement &&
            (node.isContentEditable || node.matches('input, textarea, select, [role="textbox"]')))) return;
        const shortcut = shortcutFor(event);
        if (!shortcut) return;
        const direction = shortcut === settings.nextShortcut ? 1
            : shortcut === settings.previousShortcut ? -1 : 0;
        if (!direction) return;
        event.preventDefault();
        event.stopPropagation();
        navigate(direction);
    }

    function scheduleScan() {
        // A fixed delay batches updates without starving the scan during infinite scroll.
        if (timer === null) timer = window.setTimeout(scan, 180);
    }

    function applySettings() {
        observer?.disconnect();
        if (timer !== null) window.clearTimeout(timer);
        timer = null;
        for (const [key, value] of Object.entries(defaults)) {
            ui.getElementById(key)[typeof value === 'boolean' ? 'checked' : 'value'] = settings[key];
        }
        window.removeEventListener('keydown', onShortcut, true);
        for (const id of ['previous', 'next']) ui.getElementById(id).disabled = !settings.enabled;
        ui.getElementById('state').textContent = settings.enabled ? 'On' : 'Off';
        if (!settings.enabled) {
            syncMarks(new Set(), new Map());
            style.remove();
            unrated = [];
            currentCard = null;
            ui.getElementById('status').textContent = 'Disabled. No media highlighting is active.';
            ui.getElementById('navigationStatus').textContent = 'Enable the highlighter to jump between unrated cards.';
            return;
        }
        document.head.appendChild(style);
        ui.getElementById('navigationStatus').textContent = 'Jump between loaded unrated images and videos.';
        scan();
        if (settings.shortcutsEnabled) window.addEventListener('keydown', onShortcut, true);
        observer ??= new MutationObserver(mutations => {
            if (mutations.some(m => m.target !== host && !host.contains(m.target) && m.target !== style)) {
                scheduleScan();
            }
        });
        observer.observe(document.body, {
            childList: true, subtree: true, characterData: true, attributes: true,
            // Ignore our attributes and animation styles to avoid self-triggered scans.
            attributeFilter: ['class', 'href', 'src'],
        });
    }

    for (const key of Object.keys(defaults).filter(key => typeof defaults[key] === 'boolean')) {
        ui.getElementById(key).addEventListener('change', event => {
            settings[key] = event.target.checked;
            GM_setValue(KEY, settings);
            applySettings();
        });
    }
    for (const key of ['previousShortcut', 'nextShortcut']) {
        const input = ui.getElementById(key);
        input.addEventListener('keydown', event => {
            if (event.key === 'Tab') return;
            event.preventDefault();
            event.stopPropagation();
            if (event.isComposing || event.repeat) return;
            if (event.key === 'Escape') { input.blur(); return; }
            const shortcut = ['Backspace', 'Delete'].includes(event.key) ? '' : shortcutFor(event);
            if (!shortcut && !['Backspace', 'Delete'].includes(event.key)) return;
            const other = key === 'previousShortcut' ? 'nextShortcut' : 'previousShortcut';
            if (shortcut && settings[other] === shortcut) {
                ui.getElementById('navigationStatus').textContent = 'Choose a different shortcut for each direction.';
                return;
            }
            settings[key] = shortcut;
            input.value = shortcut;
            GM_setValue(KEY, settings);
            ui.getElementById('navigationStatus').textContent = shortcut ? 'Shortcut saved.' : 'Shortcut cleared.';
        });
    }
    ui.getElementById('previous').addEventListener('click', () => navigate(-1));
    ui.getElementById('next').addEventListener('click', () => navigate(1));

    function setPanelHidden(hidden, persist = true) {
        if (hidden) ui.activeElement?.blur();
        host.style.setProperty('display', hidden ? 'none' : 'block', 'important');
        if (persist) GM_setValue(PANEL_HIDDEN_KEY, hidden);
    }

    ui.getElementById('hidePanel').addEventListener('click', () => setPanelHidden(true));
    GM_registerMenuCommand('Rating highlighter settings', () => {
        setPanelHidden(false);
        ui.querySelector('details').open = true;
        ui.getElementById('enabled').focus();
    });
    try { setPanelHidden(GM_getValue(PANEL_HIDDEN_KEY, false) === true, false); } catch { /* Keep panel visible. */ }
    document.body.appendChild(host);
    applySettings();
})();
