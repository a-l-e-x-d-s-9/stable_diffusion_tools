// ==UserScript==
// @name         Civitai Auto-React Helper
// @description  Adds shortcuts to react to posts. Ctrl+Shift+S for the post under the cursor, Ctrl+Shift+A for all visible posts.
// @icon         https://civitai.com/favicon.ico
// @version      1.0
// @author       You (revised by Gemini)
// @match        https://civitai.com/*
// @grant        GM_addStyle
// ==/UserScript==

(() => {
    'use strict';

    /* ───── config ───── */
    const SLIDE_DELAY = 30; // ms between right-arrow clicks

    /* ───── utilities ───── */

    const sleep = ms => new Promise(r => setTimeout(r, ms));

    /* “Has reactions” = node contains a button whose visible text is 👍 or ❤️ */
    const hasReactions = node =>
        !![...node.querySelectorAll('button')].find(b => /👍|❤️/.test(b.textContent));

    /**
     * Finds the main post container the cursor is in.
     * Civitai's feed uses virtualization, wrapping each post in a div with a `transformY` style.
     * This is now the most reliable way to identify a post's boundary.
     */
    function getCard(node) {
        return node.closest('div[style*="transform: translateY"]');
    }

    /* gallery root = element that owns ➡️ ; fallback = first ancestor with reactions */
    function getGallery(node, card) {
        let withReacts = null;
        while (node && node !== card.parentElement) {
            if (!withReacts && hasReactions(node)) withReacts = node;
            // The right chevron icon is the best indicator of a multi-image gallery container
            if (node.querySelector('svg.tabler-icon-chevron-right')) return node;
            node = node.parentElement;
        }
        return withReacts; // Fallback for single-image cards
    }

    const getNextBtn = g =>
        g?.querySelector('svg.tabler-icon-chevron-right')?.closest('button') || null;

    const slideCount = g => {
        const strip = g?.querySelector('div.flex.w-full.gap-px');
        return strip ? strip.querySelectorAll('button').length || 1 : 1;
    };

    const getReactionButtons = g =>
        [...g.querySelectorAll('button')].filter(b => /👍|❤️/.test(b.textContent));

    const isPressed = b =>
        // A "pressed" button has a background color other than transparent
        window.getComputedStyle(b).backgroundColor !== 'rgba(0, 0, 0, 0)';

    /* ───── core: react on ONE gallery ───── */

    async function reactOnGallery(g) {
        if (!g) return;

        const press = () => getReactionButtons(g).forEach(b => {
            if (!isPressed(b)) b.click();
        });

        press(); // React to the current frame first

        const next = getNextBtn(g);
        if (!next) return; // This is a single-image post

        // Cycle through and react to all other images in the gallery
        for (let i = 1; i < slideCount(g); i++) {
            next.click();
            await sleep(SLIDE_DELAY);
            press();
        }
    }

    /* ───── action functions ───── */

    // Keep track of cursor position
    let cx = 0, cy = 0;
    document.addEventListener('mousemove', e => {
        cx = e.clientX;
        cy = e.clientY;
    });

    /**
     * Finds the post under the cursor and reacts to all its image galleries.
     */
    async function reactToHoveredPost() {
        const elem = document.elementsFromPoint(cx, cy)[0];
        const card = getCard(elem);
        if (!card) {
            console.log('Auto-React: Move cursor over a post first.');
            return;
        }

        const galleries = new Set(
            [...card.querySelectorAll('button')]
            .filter(b => /👍|❤️/.test(b.textContent))
            .map(b => getGallery(b, card))
            .filter(Boolean)
        );

        for (const g of galleries) {
            await reactOnGallery(g);
            await sleep(50);
        }
    }

    /**
     * Finds all currently visible posts and reacts to them.
     */
    async function reactToAllVisiblePosts() {
        console.log('Auto-React: Reacting to all visible posts...');
        const cards = document.querySelectorAll('div[style*="transform: translateY"]');
        if (cards.length === 0) {
            console.log('Auto-React: No posts found on the page.');
            return;
        }

        for (const card of cards) {
            const galleries = new Set(
                [...card.querySelectorAll('button')]
                .filter(b => /👍|❤️/.test(b.textContent))
                .map(b => getGallery(b, card))
                .filter(Boolean)
            );

            for (const g of galleries) {
                await reactOnGallery(g);
                await sleep(50); // A small delay between galleries
            }
        }
        console.log(`Auto-React: Finished reacting to ${cards.length} posts.`);
    }


    /* ───── UI and hot-key binding ───── */

    function createShortcutButton() {
        // Inject CSS for the button using GM_addStyle
        GM_addStyle(`
            #civitai-emoji-button {
                position: fixed;
                bottom: 20px;
                right: 20px;
                z-index: 9999;
                background-color: #1a1b1e;
                color: #c1c2c5;
                border: 1px solid #373a40;
                border-radius: 50%;
                width: 40px;
                height: 40px;
                font-size: 20px;
                cursor: pointer;
                display: flex;
                align-items: center;
                justify-content: center;
                box-shadow: 0 4px 8px rgba(0,0,0,0.2);
                transition: transform 0.2s ease, background-color 0.2s ease;
            }
            #civitai-emoji-button:hover {
                transform: scale(1.1);
                background-color: #2c2e33;
            }
        `);

        const button = document.createElement('button');
        button.id = 'civitai-emoji-button';
        button.textContent = '👍';
        button.title = 'Civitai Auto-React Shortcuts';

        button.addEventListener('click', () => {
            alert(
                'Civitai Auto-React Shortcuts:\n\n' +
                '► React to Hovered Post\n' +
                '   Shortcut: Ctrl + Shift + S\n\n' +
                '► React to All Visible Posts\n' +
                '   Shortcut: Ctrl + Shift + A'
            );
        });

        document.body.appendChild(button);
    }

    // Listen for the hotkeys
    window.addEventListener('keydown', e => {
        // We only care about Ctrl+Shift combinations
        if (!e.ctrlKey || !e.shiftKey || e.altKey || e.metaKey) return;

        switch (e.key.toUpperCase()) {
            case 'S':
                e.preventDefault();
                reactToHoveredPost();
                break;
            case 'A':
                e.preventDefault();
                reactToAllVisiblePosts();
                break;
        }
    });

    // Initialize the UI button and log a success message
    createShortcutButton();
    console.log('✅ Civitai Auto-React Helper 1.0 loaded.');
})();