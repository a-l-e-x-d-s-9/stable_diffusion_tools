// ==UserScript==
// @name         Civitai - Remove Red Line
// @namespace    https://civitai.red/
// @version      1.0
// @description  Removes the red top border line from the Civitai footer
// @match        https://civitai.red/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    const STYLE_ID = 'civitai-remove-footer-red-line';

    function installStyle() {
        if (document.getElementById(STYLE_ID)) return;

        const style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent = `
            /* Exact footer border class from current site */
            .border-red-8 {
                border-top-color: transparent !important;
            }

            /* More specific: current footer element */
            div.border-red-8.border-t-\\[3px\\] {
                border-top-width: 0 !important;
                border-top-color: transparent !important;
                box-shadow: none !important;
            }
        `;
        (document.head || document.documentElement).appendChild(style);
    }

    function patchFooter(root = document) {
        const nodes = root.querySelectorAll
            ? root.querySelectorAll('div.border-red-8, div.border-t-\\[3px\\]')
            : [];

        for (const el of nodes) {
            if (!(el instanceof HTMLElement)) continue;

            const text = (el.textContent || '');
            if (text.includes('© Civitai') || text.includes('Terms of Service')) {
                el.style.setProperty('border-top-width', '0', 'important');
                el.style.setProperty('border-top-color', 'transparent', 'important');
                el.style.setProperty('box-shadow', 'none', 'important');
            }
        }
    }

    function init() {
        installStyle();
        patchFooter();

        const mo = new MutationObserver((mutations) => {
            for (const m of mutations) {
                for (const node of m.addedNodes) {
                    if (node instanceof HTMLElement) {
                        patchFooter(node);
                        if (node.matches && node.matches('div.border-red-8, div.border-t-\\[3px\\]')) {
                            patchFooter(node.parentNode || document);
                        }
                    }
                }
            }
        });

        mo.observe(document.documentElement, {
            childList: true,
            subtree: true
        });

        window.addEventListener('load', () => patchFooter(), { once: true });
    }

    init();
})();