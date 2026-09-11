// ==UserScript==
// @name         Grok Liked Images to Video (Post Navigation)
// @namespace    https://grok.com/
// @version      1.3.0
// @description  Queue liked images bottom-to-top, visit each post, and choose Make Video > Quick Animate with configurable concurrency.
// @author       alexds9
// @match        https://grok.com/*
// @run-at       document-idle
// @noframes
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    const KEY = 'grok-liked-post-video-v1';
    const PANEL_KEY = `${KEY}-panel`;
    const LIKED = '/imagine/saved/liked';
    const CARD = '[class~="group/compact-card"]';
    const LINK = 'a[aria-label="Open post"][href^="/imagine/post/"]';
    const POLL = 250;
    const LOAD_WAIT = 1400;
    const TIMEOUT = 30000;
    const GENERATION_TIMEOUT = 12 * 60 * 1000;
    const EDGE_PASSES = 5;
    const blank = () => ({
        running: false, phase: 'idle', queue: [], index: 0, attempted: [], skipped: [],
        pending: [], observedVideos: [], knownVideos: [], delay: 15, limit: 0, concurrency: 5, skipVideos: true,
        picked: null, pickedPreview: '', scan: null,
        submittedAt: 0, status: 'Choose Start or Pick start.',
        navigation: null, backFor: null,
    });
    let state;
    try { state = { ...blank(), ...JSON.parse(sessionStorage.getItem(KEY) || 'null') }; }
    catch (_) { state = blank(); }
    if (!Array.isArray(state.pending)) state.pending = [];
    if (!Array.isArray(state.observedVideos)) state.observedVideos = [];
    if (!Array.isArray(state.knownVideos)) state.knownVideos = [];
    state.concurrency = Math.min(10, Math.max(1, Math.round(Number(state.concurrency) || 5)));
    let panel;
    let ui;
    let picking = false;
    let busy = false;
    let epoch = 0;
    let navigating = false;
    let waitingForSlot = false;
    let expectedPath = null;
    let selectedMarker;
    const pendingElements = new Map();
    let panelPrefs = {};
    try { panelPrefs = JSON.parse(localStorage.getItem(PANEL_KEY) || '{}') || {}; } catch (_) { /* defaults */ }

    const path = () => location.pathname.replace(/\/$/, '');
    const current = () => state.queue[state.index];
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    const postPath = id => `/imagine/post/${id}`;
    function postId(href) {
        try {
            const url = new URL(href, location.origin);
            return url.origin === location.origin
                ? url.pathname.match(/^\/imagine\/post\/([a-zA-Z0-9-]+)\/?$/)?.[1] || null : null;
        } catch (_) { return null; }
    }
    function visible(element) {
        return Boolean(element?.isConnected && element.getClientRects().length
            && getComputedStyle(element).visibility !== 'hidden'
            && getComputedStyle(element).display !== 'none');
    }
    function enabled(element) {
        return visible(element) && !element.disabled && element.getAttribute('aria-disabled') !== 'true'
            && !element.hasAttribute('data-disabled');
    }
    function save() {
        // Write before any generation click or navigation. A storage failure must
        // stop the run rather than risk repeating a submission after a reload.
        sessionStorage.setItem(KEY, JSON.stringify(state));
        render();
    }
    function status(message) { state.status = message; save(); }
    function guard(token) {
        if (!state.running || token !== epoch || navigating) throw new Error('Run interrupted');
    }
    async function waitFor(get, token, label, timeout = TIMEOUT) {
        const deadline = Date.now() + timeout;
        while (Date.now() < deadline) {
            guard(token);
            const result = get();
            if (result) return result;
            await sleep(POLL);
        }
        throw new Error(`Timed out waiting for ${label}. Check the page, then Resume.`);
    }
    function scroller() {
        let node = document.querySelector(LINK)?.parentElement;
        while (node && node !== document.body && node !== document.documentElement) {
            if (/(auto|scroll)/.test(getComputedStyle(node).overflowY)
                && node.scrollHeight > node.clientHeight + 20) return node;
            node = node.parentElement;
        }
        return document.scrollingElement || document.documentElement;
    }
    function cards() {
        const scroll = scroller();
        return [...document.querySelectorAll(LINK)].map(link => {
            const card = link.closest(CARD) || link.parentElement;
            const id = postId(link.href);
            if (!id || !card?.querySelector('img, video') || !visible(card)) return null;
            const rect = card.getBoundingClientRect();
            return { id, x: rect.left + scroll.scrollLeft, y: rect.top + scroll.scrollTop,
                video: Boolean(card.querySelector('video')), link, card };
        }).filter(Boolean);
    }
    function completedVideo(card) {
        const video = card?.querySelector('video');
        return Boolean(video && (video.currentSrc || video.src || video.querySelector('source[src]')));
    }
    function pendingCard(id) {
        const remembered = pendingElements.get(id);
        return remembered?.isConnected ? remembered : cards().find(item => item.id === id)?.card || null;
    }
    function cardIsGenerating(card) {
        if (!card || completedVideo(card)) return false;
        return [...card.querySelectorAll('[role="progressbar"], [aria-busy="true"]')].some(visible)
            || [...card.querySelectorAll('button[aria-label="Make video"]')].some(button => !enabled(button))
            || /(?:generating|creating|making|processing)\s+(?:the\s+)?video/i.test(card.textContent || '');
    }
    function settlePending() {
        if (!state.pending.length || path() !== LIKED) return false;
        const now = Date.now();
        let changed = false;
        const matchedCompletedCards = new Set();
        state.pending = state.pending.filter(job => {
            const card = pendingCard(job.id);
            if (card && completedVideo(card)) {
                matchedCompletedCards.add(card);
                const resultId = postId(card.querySelector(LINK)?.href) || job.id;
                if (!state.observedVideos.includes(resultId)) state.observedVideos.push(resultId);
                pendingElements.delete(job.id);
                changed = true;
                return false;
            }
            const generating = cardIsGenerating(card);
            if (generating && !job.sawBusy) { job.sawBusy = true; changed = true; }
            const makeVideoReturned = card && job.sawBusy && now - job.submittedAt >= 2000
                && [...card.querySelectorAll('button[aria-label]')].some(button =>
                    /^make video$/i.test(button.getAttribute('aria-label')) && enabled(button));
            if (!generating && makeVideoReturned) {
                pendingElements.delete(job.id);
                changed = true;
                return false;
            }
            // A stale job must not block the queue forever if Grok removes or
            // replaces its card without exposing a final video in this grid.
            if (now - job.submittedAt >= GENERATION_TIMEOUT) {
                pendingElements.delete(job.id);
                changed = true;
                return false;
            }
            return true;
        });
        // Depending on Grok's current UI, a finished animation either replaces
        // its source card or appears as a new video card at the top. The latter
        // has a new post ID, so use each newly observed result to settle the
        // oldest request that could not be matched to its original card.
        const knownVideos = new Set(state.knownVideos);
        const observed = new Set(state.observedVideos);
        for (const item of cards()) {
            if (!state.pending.length) break;
            if (matchedCompletedCards.has(item.card) || !completedVideo(item.card)
                || knownVideos.has(item.id) || observed.has(item.id)) continue;
            const job = state.pending.shift();
            pendingElements.delete(job.id);
            state.observedVideos.push(item.id);
            observed.add(item.id);
            changed = true;
        }
        if (changed) save();
        return changed;
    }
    async function waitForGenerationSlot(token) {
        if (path() === LIKED) settlePending();
        if (state.pending.length < state.concurrency) return;
        if (path() !== LIKED) throw new Error('Concurrency waiting requires the Liked grid. Return there and Resume.');
        waitingForSlot = true;
        try {
            status(`At the ${state.concurrency}-video concurrency limit; watching the main grid…`);
            scroller().scrollTo({ top: 0, behavior: 'instant' });
            await sleep(LOAD_WAIT);
            guard(token);
            while (state.pending.length >= state.concurrency) {
                if (path() !== LIKED) throw new Error('Left Liked while waiting for a video to finish.');
                settlePending();
                if (state.pending.length < state.concurrency) break;
                const oldest = Math.min(...state.pending.map(job => job.submittedAt));
                const minutes = Math.max(0, Math.floor((Date.now() - oldest) / 60000));
                state.status = `Waiting in the main grid: ${state.pending.length}/${state.concurrency} videos active${minutes ? ` · oldest ${minutes}m` : ''}…`;
                save();
                await sleep(LOAD_WAIT);
                guard(token);
            }
            status(`A generation slot is available (${state.pending.length}/${state.concurrency} active).`);
        } finally {
            waitingForSlot = false;
            render();
        }
    }
    function ordered(entries) {
        // Group rows before sorting columns: a pairwise row tolerance is not a
        // transitive comparator and can scramble tightly spaced masonry cards.
        const rows = [];
        for (const item of [...entries].sort((a, b) => a.y - b.y || a.x - b.x)) {
            let row = rows[rows.length - 1];
            if (!row || item.y - row.y > 12) rows.push(row = { y: item.y, items: [] });
            row.items.push(item);
        }
        return rows.flatMap(row => row.items.sort((a, b) => a.x - b.x)).reverse();
    }
    function collect() {
        const entries = state.scan.entries;
        const known = new Set(entries.map(item => item.id));
        for (const { id, x, y, video } of cards()) {
            if (!known.has(id)) { entries.push({ id, x, y, video }); known.add(id); }
        }
        return entries.length;
    }
    async function scan(token) {
        if (path() !== LIKED) throw new Error('Collection requires the Liked page. Return there and Resume.');
        await waitFor(() => cards().length, token, 'liked image cards');
        if (!state.scan) {
            state.scan = { entries: [], direction: state.picked ? 'up' : 'down', stable: 0,
                restoreTop: state.picked ? scroller().scrollTop : 0 };
            save();
        }
        // Restore collection position after Pause or a document navigation.
        scroller().scrollTo({ top: state.scan.restoreTop, behavior: 'instant' });
        await sleep(LOAD_WAIT);
        guard(token);
        while (state.running) {
            guard(token);
            if (path() !== LIKED) throw new Error('Left Liked while collecting. Return there and Resume.');
            const scroll = scroller();
            const count = collect();
            const before = scroll.scrollTop;
            const height = scroll.scrollHeight;
            const down = state.scan.direction === 'down';
            const edge = down ? before + scroll.clientHeight >= height - 5 : before <= 5;
            const loading = [...document.querySelectorAll('[role="progressbar"], [aria-busy="true"]')].some(visible);
            state.scan.stable = edge && !loading ? state.scan.stable + 1 : 0;
            state.scan.restoreTop = before;
            status(`Collecting ${count} posts; ${down ? 'finding the bottom' : 'moving toward the top'}…`);
            if (state.scan.stable >= EDGE_PASSES) break;
            const step = Math.max(100, Math.floor(scroll.clientHeight * 0.65));
            scroll.scrollTo({ top: down ? before + step : Math.max(0, before - step), behavior: 'instant' });
            await sleep(LOAD_WAIT);
            guard(token);
            if (path() !== LIKED) throw new Error('Left Liked while collecting. Return there and Resume.');
            if (collect() !== count || scroller().scrollHeight !== height) state.scan.stable = 0;
        }
        let queue = ordered(state.scan.entries);
        state.knownVideos = queue.filter(item => item.video).map(item => item.id);
        if (state.picked) {
            const start = queue.findIndex(item => item.id === state.picked);
            if (start < 0) throw new Error('Picked image was not found. Reset and pick it again.');
            queue = queue.slice(start);
        }
        state.queue = queue;
        state.scan = null;
        state.phase = 'open';
        status(`Queued ${queue.length} posts, bottom-to-top (right-to-left within each row).`);
    }
    const onSaved = () => path() === '/imagine/saved' || path() === LIKED;
    function checkImagineRoute() {
        if (!onSaved() && !path().startsWith('/imagine/post/')) {
            throw new Error('Navigation left Saved/posts. Paused without clicking again.');
        }
    }
    async function revealPost(target, token) {
        if (!onSaved() || !target.startsWith('/imagine/post/')) return;
        const find = () => cards().find(item => postPath(item.id) === target)?.link;
        if (find()) return;
        status('Finding the next queued image in the gallery…');
        scroller().scrollTo({ top: 0, behavior: 'instant' });
        let stable = 0;
        const deadline = Date.now() + 10 * 60 * 1000;
        while (Date.now() < deadline) {
            await sleep(LOAD_WAIT);
            guard(token);
            if (!onSaved()) throw new Error('Left the gallery while locating the next image.');
            if (find()) return;
            const scroll = scroller();
            const atEnd = scroll.scrollTop + scroll.clientHeight >= scroll.scrollHeight - 5;
            stable = atEnd ? stable + 1 : 0;
            if (stable >= EDGE_PASSES) break;
            scroll.scrollTo({ top: scroll.scrollTop + Math.max(100, scroll.clientHeight * 0.65), behavior: 'instant' });
        }
        throw new Error('Next image is not available in the gallery. Paused without reloading.');
    }
    async function navigate(target, token) {
        guard(token);
        checkImagineRoute();
        if (path() === target) { state.navigation = null; return; }
        expectedPath = target;
        // Never fall back to location.assign: reloading can cancel active jobs.
        // Persist clicks so a timeout, Pause, or bfcache restore cannot repeat them.
        if (!state.navigation) {
            await revealPost(target, token);
            const link = await waitFor(() => {
                checkImagineRoute();
                return [...document.querySelectorAll('a[href]')].find(a => {
                    try { return visible(a) && a.getAttribute('aria-label') !== 'Back'
                        && new URL(a.href).origin === location.origin && new URL(a.href).pathname === target; }
                    catch (_) { return false; }
                });
            }, token, 'the gallery link (no reload will be attempted)');
            guard(token);
            state.navigation = { target };
            const id = postId(target);
            const card = link.closest(CARD);
            if (id && card) pendingElements.set(id, card);
            save();
            link.click();
        }
        if (state.navigation.target !== target) throw new Error('An earlier navigation is still pending. No additional link was clicked.');
        await waitFor(() => { checkImagineRoute(); return path() === target; }, token,
            'navigation to finish (the link will not be clicked again)');
        state.navigation = null;
        expectedPath = null;
        save();
    }
    function makeVideoButton() {
        return [...document.querySelectorAll('button[aria-label]')].find(button =>
            /^make video$/i.test(button.getAttribute('aria-label')) && enabled(button));
    }
    function quickAnimate(button) {
        // Radix renders the menu in a portal. Match its trigger, never a dynamic
        // radix ID or a document-wide "second menu item".
        const menus = [...document.querySelectorAll('[role="menu"][data-state="open"]')]
            .filter(menu => visible(menu) && button.id
                && (menu.getAttribute('aria-labelledby') || '').split(/\s+/).includes(button.id));
        return menus.flatMap(menu => [...menu.querySelectorAll('[role="menuitem"]')])
            .find(item => /^quick animate$/i.test(item.textContent.trim()) && enabled(item));
    }
    function postHasVideo() {
        return [...document.querySelectorAll('main video, [role="main"] video')].some(video =>
            visible(video) && !video.closest(`${CARD}, a[href^="/imagine/post/"]`)
                && Boolean(video.currentSrc || video.src || video.querySelector('source[src]')));
    }
    function errors() {
        return [...document.querySelectorAll('[role="alert"], [data-sonner-toast], [role="status"]')]
            .filter(visible).map(el => el.textContent.trim()).filter(text =>
                /(?:rate.?limit|quota|too many (?:requests|videos)|try again|failed|unable|something went wrong|limit reached|out of (?:credits|generations)|not enough (?:credits|generations))/i.test(text));
    }
    async function submit(token) {
        const id = current().id;
        if (path() !== postPath(id)) throw new Error('The current page is not the queued post. Resume to reopen it.');
        status(`Opening Make Video for post ${state.index + 1} of ${state.queue.length}…`);
        await sleep(900); // Let the post route replace the previous post's DOM.
        const control = await waitFor(() => (state.skipVideos && postHasVideo()) || makeVideoButton(),
            token, 'the Make Video button or an existing video');
        guard(token);
        if (path() !== postPath(id)) throw new Error('Post changed before generation.');
        if (state.skipVideos && postHasVideo()) {
            pendingElements.delete(id);
            state.skipped.push(id);
            state.phase = 'return';
            status('Skipped a post displaying a video.');
            return;
        }
        const button = control === true ? makeVideoButton() : control;
        if (!button) throw new Error('Post controls changed. Resume to try opening the menu again.');
        const existingErrors = errors();
        if (existingErrors.length) throw new Error(`Grok reports: ${existingErrors[0]}`);
        if (!quickAnimate(button)) {
            // Radix DropdownMenu opens on pointerdown, not just click.
            button.dispatchEvent(new PointerEvent('pointerdown', {
                bubbles: true, cancelable: true, pointerType: 'mouse', button: 0, buttons: 1,
            }));
            button.dispatchEvent(new PointerEvent('pointerup', {
                bubbles: true, cancelable: true, pointerType: 'mouse', button: 0,
            }));
            await sleep(300);
            guard(token);
            if (!quickAnimate(button) && button.getAttribute('aria-expanded') !== 'true') button.click();
        }
        const item = await waitFor(() => quickAnimate(button), token, 'Quick Animate in the Make Video menu');
        guard(token);
        if (path() !== postPath(id)) throw new Error('Post changed before Quick Animate.');
        // Persist the attempt BEFORE clicking. An interrupted or failed click is
        // deliberately not retried automatically: it might already have charged.
        state.attempted.push(id);
        state.submittedAt = Date.now();
        state.pending.push({ id, submittedAt: state.submittedAt, sawBusy: false });
        state.phase = 'submitted';
        status(`Quick Animate submitted for post ${state.index + 1}; waiting ${state.delay}s…`);
        item.click();
        // Menu animation/closure is not submission confirmation. Grok can also
        // switch to a newly generated post here. Neither should prevent Back.
    }
    async function afterSubmit(token) {
        while (true) {
            guard(token);
            if (!path().startsWith('/imagine/post/') && !path().startsWith('/imagine/saved')) {
                throw new Error('Left Imagine. Resume to return to Liked without submitting again.');
            }
            const error = errors()[0];
            if (error) {
                state.pending = state.pending.filter(job => job.id !== current().id);
                pendingElements.delete(current().id);
                state.phase = 'return';
                throw new Error(`Grok reports: ${error}. Submission was recorded and will not be retried.`);
            }
            if (Date.now() - state.submittedAt >= state.delay * 1000) break;
            await sleep(POLL);
        }
        guard(token);
        if (finishOnLastPost()) return;
        state.phase = 'return';
        status('Returning to Liked…');
    }
    function isLastSubmission() {
        return current() && state.attempted.includes(current().id)
            && (state.index + 1 >= state.queue.length || (state.limit > 0 && state.attempted.length >= state.limit));
    }
    function finishOnLastPost() {
        if (isLastSubmission()) {
            state.index += 1;
            state.running = false;
            state.phase = 'done';
            status('Submissions finished. Leaving this post open while videos generate.');
            return true;
        }
        return false;
    }
    async function returnToLiked(token) {
        if (finishOnLastPost()) return;
        checkImagineRoute();
        if (!onSaved()) {
            if (state.backFor !== current().id) {
                // No Escape or browser-history navigation: either can close the
                // post before this click and turn it into an extra Back action.
                const back = await waitFor(() => {
                    checkImagineRoute();
                    if (onSaved()) return true;
                    return [...document.querySelectorAll('a[aria-label="Back"][href]')].find(link => {
                        const target = new URL(link.href, location.origin);
                        return visible(link) && target.origin === location.origin
                            && [LIKED, '/imagine/saved'].includes(target.pathname);
                    });
                }, token, 'the post Back link');
                guard(token);
                if (back !== true && !onSaved()) {
                    state.backFor = current().id;
                    status('Back clicked once. Waiting for Saved…');
                    back.click();
                }
            }
            await waitFor(() => { checkImagineRoute(); return onSaved(); }, token,
                'Saved to open (Back will not be clicked again)');
        }
        // Wait for the actual gallery, not just a changed URL. This also avoids
        // clicking controls from the previous post during a slow SPA transition.
        await waitFor(() => { checkImagineRoute(); return onSaved() && cards().length && !makeVideoButton(); },
            token, 'the Saved gallery');
        await navigate(LIKED, token);
        if (navigating) return;
        await waitFor(() => { checkImagineRoute(); return path() === LIKED && cards().length && !makeVideoButton(); },
            token, 'the Liked gallery');
        state.backFor = null;
        state.index += 1;
        state.phase = 'open';
        save();
    }
    async function run() {
        if (busy || !state.running || navigating) return;
        busy = true;
        const token = epoch;
        try {
            while (state.running && !navigating) {
                guard(token);
                if (state.phase === 'scan') await scan(token);
                else if (state.phase === 'open') {
                    if (!current() || (state.limit > 0 && state.attempted.length >= state.limit)) {
                        state.running = false;
                        state.phase = 'done';
                        status('Queue finished.');
                        break;
                    }
                    if (state.attempted.includes(current().id) || state.skipped.includes(current().id)) {
                        state.index += 1; save(); continue;
                    }
                    if (state.skipVideos && current().video) {
                        state.skipped.push(current().id); state.index += 1; save(); continue;
                    }
                    await waitForGenerationSlot(token);
                    status(`Visiting post ${state.index + 1} of ${state.queue.length}…`);
                    await navigate(postPath(current().id), token);
                    if (navigating) break;
                    await submit(token);
                } else if (state.phase === 'submitted') await afterSubmit(token);
                else if (state.phase === 'return') await returnToLiked(token);
                else throw new Error('Unknown run state. Use Reset to start again.');
            }
        } catch (error) {
            if (token === epoch && !navigating) {
                state.running = false;
                state.status = error.message;
                try { save(); } catch (_) { render(); }
                console.warn('[Grok Liked Images to Video]', error);
            }
        } finally { busy = false; expectedPath = null; render(); }
    }
    function pause() {
        state.running = false;
        epoch += 1;
        picking = false;
        status('Paused. Resume continues the queue.');
    }
    function start() {
        if (busy || state.running) return;
        if (state.phase === 'idle' || state.phase === 'done') {
            if (path() !== LIKED) { status('Open /imagine/saved/liked before starting a new run.'); return; }
            const { delay, limit, concurrency, skipVideos, picked, pickedPreview } = state;
            state = { ...blank(), delay, limit, concurrency, skipVideos, picked, pickedPreview, phase: 'scan' };
            pendingElements.clear();
        }
        state.running = true;
        epoch += 1;
        picking = false;
        status('Starting…');
        run();
    }
    function resetCompletedRun() {
        if (state.phase !== 'done') return;
        const { delay, limit, concurrency, skipVideos } = state;
        state = { ...blank(), delay, limit, concurrency, skipVideos };
        pendingElements.clear();
    }
    function pick(event) {
        if (!picking || panel.contains(event.target)) return;
        const card = event.target.closest(CARD);
        const link = event.target.closest(LINK) || card?.querySelector(LINK);
        const id = postId(link?.href);
        if (!id) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        resetCompletedRun();
        state.picked = id;
        const image = (card || link.parentElement)?.querySelector('img');
        state.pickedPreview = image?.currentSrc || image?.src || '';
        picking = false;
        status('Start image selected. Press Start.');
    }
    function updateSelectedMarker() {
        const link = state.picked && path() === LIKED
            ? [...document.querySelectorAll(LINK)].find(el => postId(el.href) === state.picked && visible(el)) : null;
        const card = link?.closest(CARD) || link?.parentElement;
        if (selectedMarker?.parentElement !== card || !selectedMarker?.isConnected) {
            selectedMarker?.remove();
            selectedMarker = null;
            if (card) {
                selectedMarker = document.createElement('div');
                selectedMarker.dataset.grokLikedStart = state.picked;
                selectedMarker.textContent = 'START';
                selectedMarker.style.cssText = 'position:absolute;inset:0;z-index:100;pointer-events:none;border:4px solid #8b5cf6;border-radius:5px;box-sizing:border-box;color:#fff;font:700 12px/1 system-ui;padding:8px;text-shadow:0 1px 3px #000;box-shadow:inset 0 0 0 1px #ffffffb3';
                card.append(selectedMarker);
            }
        }
        document.documentElement.toggleAttribute('data-grok-liked-picking', picking);
    }
    function storePanelPrefs() {
        try { localStorage.setItem(PANEL_KEY, JSON.stringify(panelPrefs)); } catch (_) { /* still draggable */ }
    }
    function positionPanel(left, top) {
        panel.style.left = `${Math.max(0, Math.min(left, innerWidth - panel.offsetWidth))}px`;
        panel.style.top = `${Math.max(0, Math.min(top, innerHeight - panel.offsetHeight))}px`;
        panel.style.right = 'auto';
        panel.style.bottom = 'auto';
    }
    function minimizePanel(value) {
        panelPrefs.minimized = Boolean(value);
        panel.dataset.minimized = value ? '1' : '0';
        panel.style.width = value ? '190px' : '310px';
        ui.minimize.textContent = value ? '□' : '−';
        ui.minimize.title = value ? 'Restore panel' : 'Minimize panel';
        ui.minimize.setAttribute('aria-label', ui.minimize.title);
        const rect = panel.getBoundingClientRect();
        positionPanel(rect.left, rect.top);
        storePanelPrefs();
    }
    function installDragging() {
        let drag;
        ui.head.onpointerdown = event => {
            if (event.button !== 0 || event.target.closest('button')) return;
            const rect = panel.getBoundingClientRect();
            drag = { dx: event.clientX - rect.left, dy: event.clientY - rect.top };
            ui.head.setPointerCapture(event.pointerId);
            event.preventDefault();
        };
        ui.head.onpointermove = event => {
            if (drag) positionPanel(event.clientX - drag.dx, event.clientY - drag.dy);
        };
        const finish = event => {
            if (!drag) return;
            drag = null;
            if (ui.head.hasPointerCapture(event.pointerId)) ui.head.releasePointerCapture(event.pointerId);
            const rect = panel.getBoundingClientRect();
            panelPrefs.left = rect.left;
            panelPrefs.top = rect.top;
            storePanelPrefs();
        };
        ui.head.onpointerup = finish;
        ui.head.onpointercancel = finish;
        ui.head.onlostpointercapture = finish;
        window.addEventListener('resize', () => {
            const rect = panel.getBoundingClientRect();
            positionPanel(rect.left, rect.top);
        });
    }
    function render() {
        if (!ui) return;
        panel.hidden = !path().startsWith('/imagine') && !state.running;
        panel.dataset.state = state.running ? 'running' : state.phase === 'done' ? 'finished' : 'idle';
        const phaseNames = { scan: 'Collecting', open: 'Opening post', submitted: 'Submitted', return: 'Going back' };
        ui.heading.textContent = picking ? 'Pick a start image' : waitingForSlot ? 'Waiting for a video'
            : state.running ? phaseNames[state.phase] || 'Starting'
            : state.phase === 'done' ? 'Finished' : state.phase === 'idle' ? 'Ready' : 'Paused';
        ui.status.textContent = state.running && state.phase === 'submitted'
            ? isLastSubmission() ? 'Final submission · staying on this post'
                : `Back in ${Math.max(0, Math.ceil(state.delay - (Date.now() - state.submittedAt) / 1000))}s`
            : state.status;
        ui.submitted.textContent = state.attempted.length;
        ui.active.textContent = state.pending.length;
        ui.skipped.textContent = state.skipped.length;
        ui.queued.textContent = Math.max(0, state.queue.length - state.index);
        ui.start.textContent = state.phase === 'done' ? 'Finished' : state.phase === 'idle' ? 'Start' : 'Resume';
        ui.start.disabled = state.running || busy || picking || state.phase === 'done';
        ui.pause.disabled = !state.running && !picking;
        const canPick = !state.running && !busy && ['idle', 'done'].includes(state.phase);
        ui.pick.disabled = !canPick || path() !== LIKED;
        ui.clear.disabled = !canPick || (!state.picked && !picking);
        ui.reset.disabled = state.running || busy;
        for (const key of ['delay', 'limit', 'concurrency', 'skipVideos']) ui[key].disabled = state.running || busy;
        ui.pick.textContent = picking ? 'Cancel pick' : 'Pick start';
        ui.mode.textContent = state.picked ? 'Picked image' : 'Automatic bottom';
        ui.preview.hidden = !state.pickedPreview;
        if (state.pickedPreview && ui.preview.getAttribute('src') !== state.pickedPreview) ui.preview.src = state.pickedPreview;
        updateSelectedMarker();
    }
    function installPanel() {
        panel = document.createElement('div');
        panel.id = 'grok-liked-video-panel';
        panel.style.cssText = 'position:fixed;top:90px;right:20px;width:310px;max-width:100vw;z-index:2147483647';
        const root = panel.attachShadow({ mode: 'open' });
        root.innerHTML = `
            <style>
                :host { color-scheme:dark; font:12px/1.4 Inter,system-ui,sans-serif; }
                * { box-sizing:border-box; } [hidden] { display:none !important; }
                .panel { color:#f8fafc; background:rgba(15,23,42,.96); border:1px solid #94a3b859; border-radius:14px; box-shadow:0 15px 45px #0007; overflow:hidden; backdrop-filter:blur(12px); }
                #head { display:flex; align-items:center; justify-content:space-between; padding:11px 13px; background:#1e293be6; cursor:move; user-select:none; touch-action:none; border-bottom:1px solid #94a3b838; }
                .title { font-size:13px; font-weight:750; } .head-actions { display:flex; align-items:center; gap:10px; }
                .dot { width:9px; height:9px; border-radius:50%; background:#64748b; }
                :host([data-state=running]) .dot { background:#22c55e; box-shadow:0 0 0 3px #22c55e2e; }
                :host([data-state=finished]) .dot { background:#a78bfa; }
                :host([data-minimized="1"]) .body { display:none; }
                .body { padding:13px; max-height:calc(100vh - 50px); overflow:auto; }
                #heading { font-size:14px; font-weight:700; margin-bottom:4px; }
                #status { color:#cbd5e1; font-size:11px; min-height:30px; margin-bottom:10px; overflow-wrap:anywhere; }
                .buttons { display:grid; grid-template-columns:1fr 1fr; gap:7px; margin-bottom:11px; }
                button { border:1px solid #94a3b852; border-radius:9px; padding:8px 9px; background:#334155; color:#fff; font:650 12px/1 system-ui; cursor:pointer; }
                button:hover:not(:disabled) { background:#475569; } button:disabled { opacity:.42; cursor:default; }
                #start { background:#6d28d9; border-color:#8b5cf6; } #pause { background:#991b1b; border-color:#dc2626; }
                #minimize { width:24px; height:24px; padding:0; border-radius:7px; font-size:16px; background:#0f172ac0; }
                .control { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:8px 0; border-top:1px solid #94a3b82e; }
                label { color:#cbd5e1; } input[type=number] { width:65px; border:1px solid #94a3b861; border-radius:8px; padding:6px 7px; color:#fff; background:#0f172a; font:600 12px system-ui; }
                input[type=checkbox] { accent-color:#8b5cf6; } .mode { display:flex; align-items:center; gap:10px; margin:9px 0; color:#94a3b8; font-size:11px; }
                #mode { display:block; color:#e2e8f0; } #preview { width:42px; height:42px; object-fit:cover; border:2px solid #8b5cf6; border-radius:6px; }
                .stats { display:grid; grid-template-columns:repeat(4,1fr); gap:5px; }
                .stat { text-align:center; border-radius:8px; background:#1e293bd1; padding:7px 3px; }
                .stat b { display:block; font-size:14px; } .stat span { color:#94a3b8; font-size:9px; text-transform:uppercase; letter-spacing:.04em; }
                #reset { padding:0; border:0; background:none; color:#94a3b8; font-size:11px; } .footer { text-align:right; margin-top:9px; }
            </style>
            <div class="panel">
                <div id="head" title="Drag to move"><span class="title">Liked Video Generator</span><span class="head-actions"><span class="dot"></span><button id="minimize" aria-label="Minimize panel">−</button></span></div>
                <div class="body">
                    <div id="heading">Ready</div><div id="status" role="status"></div>
                    <div class="buttons"><button id="start">Start</button><button id="pause">Pause</button><button id="pick">Pick start</button><button id="clear">Clear pick</button></div>
                    <div class="control"><label for="delay">Back after (seconds)</label><input id="delay" type="number" min="3" max="600" title="Wait after Quick Animate before clicking Back"></div>
                    <div class="control"><label for="limit">Limit · 0 = all</label><input id="limit" type="number" min="0" max="100000"></div>
                    <div class="control"><label for="concurrency">Videos at once</label><input id="concurrency" type="number" min="1" max="10" title="Wait in the Liked grid when this many videos are still generating"></div>
                    <div class="control"><label for="skipVideos">Skip existing videos</label><input id="skipVideos" type="checkbox"></div>
                    <div class="mode"><img id="preview" alt="Selected start image" hidden><div>Bottom → Top<b id="mode"></b></div></div>
                    <div class="stats"><div class="stat" title="Submission attempts, not completed videos"><b id="submitted">0</b><span>Submitted</span></div><div class="stat" title="Submitted videos not yet observed as complete"><b id="active">0</b><span>Active</span></div><div class="stat"><b id="skipped">0</b><span>Skipped</span></div><div class="stat"><b id="queued">0</b><span>Queued</span></div></div>
                    <div class="footer"><button id="reset" title="Clear queue and submission history">Reset queue</button></div>
                </div>
            </div>`;
        ui = Object.fromEntries(['delay', 'limit', 'concurrency', 'skipVideos', 'start', 'pause', 'pick', 'clear', 'reset', 'heading', 'status',
            'head', 'minimize', 'preview', 'mode', 'submitted', 'active', 'skipped', 'queued'].map(id => [id, root.getElementById(id)]));
        ui.delay.value = state.delay;
        ui.limit.value = state.limit;
        ui.concurrency.value = state.concurrency;
        ui.skipVideos.checked = state.skipVideos;
        ui.start.onclick = start;
        ui.pause.onclick = pause;
        ui.pick.onclick = () => { picking = !picking; status(picking ? 'Click a gallery image.' : 'Selection cancelled.'); };
        ui.clear.onclick = () => {
            resetCompletedRun();
            state.picked = null; state.pickedPreview = ''; picking = false;
            status('Automatic start from the bottom.');
        };
        ui.reset.onclick = () => {
            const { delay, limit, concurrency, skipVideos } = state;
            epoch += 1; picking = false;
            state = { ...blank(), delay, limit, concurrency, skipVideos };
            pendingElements.clear();
            save();
        };
        for (const [key, min, max] of [['delay', 3, 600], ['limit', 0, 100000], ['concurrency', 1, 10]]) {
            ui[key].onchange = () => {
                state[key] = Math.min(max, Math.max(min, Math.round(Number(ui[key].value) || min)));
                ui[key].value = state[key]; save();
            };
        }
        ui.skipVideos.onchange = () => { state.skipVideos = ui.skipVideos.checked; save(); };
        ui.minimize.onclick = () => minimizePanel(!panelPrefs.minimized);
        document.body.append(panel);
        const pickerStyle = document.createElement('style');
        pickerStyle.textContent = '[data-grok-liked-picking] [class~="group/compact-card"], [data-grok-liked-picking] [class~="group/compact-card"] * {cursor:crosshair !important}';
        document.head.append(pickerStyle);
        document.addEventListener('click', pick, true);
        document.addEventListener('keydown', event => {
            if (event.key === 'Escape' && picking) { picking = false; status('Selection cancelled.'); }
        });
        installDragging();
        if (Number.isFinite(panelPrefs.left) && Number.isFinite(panelPrefs.top)) positionPanel(panelPrefs.left, panelPrefs.top);
        minimizePanel(panelPrefs.minimized);
        render();
    }
    // Match the whole site so entering Imagine through SPA navigation works too.
    installPanel();
    window.addEventListener('pagehide', () => { navigating = true; });
    window.addEventListener('pageshow', event => {
        if (event.persisted) {
            // A Back navigation may revive an old document from the bfcache.
            // Read the latest checkpoint rather than using that document's queue.
            try { state = { ...blank(), ...JSON.parse(sessionStorage.getItem(KEY) || 'null') }; }
            catch (_) { state = blank(); }
            if (!Array.isArray(state.pending)) state.pending = [];
            if (!Array.isArray(state.observedVideos)) state.observedVideos = [];
            if (!Array.isArray(state.knownVideos)) state.knownVideos = [];
            state.concurrency = Math.min(10, Math.max(1, Math.round(Number(state.concurrency) || 5)));
            navigating = false;
            epoch += 1;
        }
    });
    setInterval(() => {
        if (navigating) return;
        if (state.running && !expectedPath && state.phase === 'scan' && path() !== LIKED) pause();
        render();
        run();
    }, POLL);
})();
