// ==UserScript==
// @name         Grok Image-to-Video Generator
// @namespace    https://grok.com/
// @version      1.2.0
// @description  Generate a limited or unlimited number of videos from images on Grok's Saved page in either direction.
// @author       alexds9
// @match        https://grok.com/imagine/saved*
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_setValue
// ==/UserScript==

(function () {
    'use strict';

    const SCRIPT = 'Grok Image-to-Video Generator';
    const STORAGE = {
        concurrency: 'grok-saved-video-generator-concurrency',
        panelPosition: 'grok-saved-video-generator-panel-position',
        panelMinimized: 'grok-saved-video-generator-panel-minimized',
        direction: 'grok-saved-video-generator-direction',
        generationLimit: 'grok-saved-video-generator-limit',
        lastFiniteLimit: 'grok-saved-video-generator-last-finite-limit',
    };
    const SELECTORS = {
        item: '[role="listitem"]',
        card: '.group\\/media-post-masonry-card',
        image: 'img[alt="Generated image"]',
        video: 'video',
        makeVideo: 'button[aria-label="Make video"]',
    };
    const SETTINGS = {
        pollMs: 1200,
        scrollDelayMs: 1300,
        scrollStepPx: 420,
        rowTolerancePx: 12,
        clickAcceptanceMs: 15000,
        pendingTimeoutMs: 12 * 60 * 1000,
        topStablePasses: 3,
    };

    const state = {
        running: false,
        paused: false,
        finished: false,
        picking: false,
        loopToken: 0,
        startAnchor: null,
        startMode: null,
        attempted: new Set(),
        attemptedSlots: new Set(),
        pending: new Map(),
        success: 0,
        failed: 0,
        topPasses: 0,
        status: 'Ready',
        lastAction: 'Choose Start, or Pick start first.',
    };

    let panelHost;
    let ui;
    let selectedMarker;

    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    function clamp(value, min, max) {
        return Math.min(max, Math.max(min, value));
    }

    function getConcurrency() {
        const value = Number(GM_getValue(STORAGE.concurrency, 2));
        return clamp(Number.isFinite(value) ? Math.round(value) : 2, 1, 10);
    }

    function setConcurrency(value) {
        const normalized = clamp(Math.round(Number(value) || 2), 1, 10);
        GM_setValue(STORAGE.concurrency, normalized);
        if (ui) ui.concurrency.value = String(normalized);
        render();
    }

    function getDirection() {
        return GM_getValue(STORAGE.direction, 'bottom-up') === 'top-down' ? 'top-down' : 'bottom-up';
    }

    function setDirection(value) {
        const normalized = value === 'top-down' ? 'top-down' : 'bottom-up';
        GM_setValue(STORAGE.direction, normalized);
        if (ui) ui.direction.value = normalized;
        if (state.paused) {
            state.paused = false;
            resetRunCounters();
            state.status = 'Ready';
            state.lastAction = 'Direction changed; press Start to begin a new run.';
        }
        state.startAnchor = state.startMode === 'picked' ? state.startAnchor : null;
        state.startMode = state.startMode === 'picked' ? 'picked' : null;
        state.finished = false;
        render();
    }

    function getGenerationLimit() {
        const value = Number(GM_getValue(STORAGE.generationLimit, 0));
        return Number.isFinite(value) && value >= 1 ? clamp(Math.round(value), 1, 100000) : Infinity;
    }

    function getLastFiniteLimit() {
        const value = Number(GM_getValue(STORAGE.lastFiniteLimit, 25));
        return clamp(Number.isFinite(value) ? Math.round(value) : 25, 1, 100000);
    }

    function syncLimitControls() {
        if (!ui) return;
        const limit = getGenerationLimit();
        const unlimited = limit === Infinity;
        ui.unlimited.checked = unlimited;
        ui.generationLimit.disabled = unlimited;
        ui.generationLimit.value = String(unlimited ? getLastFiniteLimit() : limit);
    }

    function setFiniteLimit(value) {
        const normalized = clamp(Math.round(Number(value) || getLastFiniteLimit()), 1, 100000);
        GM_setValue(STORAGE.lastFiniteLimit, normalized);
        GM_setValue(STORAGE.generationLimit, normalized);
        syncLimitControls();
        render();
    }

    function setUnlimited(enabled) {
        if (enabled) {
            const current = Number(ui?.generationLimit?.value);
            if (Number.isFinite(current) && current >= 1) {
                GM_setValue(STORAGE.lastFiniteLimit, clamp(Math.round(current), 1, 100000));
            }
            GM_setValue(STORAGE.generationLimit, 0);
        } else {
            GM_setValue(STORAGE.generationLimit, getLastFiniteLimit());
        }
        syncLimitControls();
        render();
    }

    function remainingGenerationQuota() {
        const limit = getGenerationLimit();
        return limit === Infinity ? Infinity : Math.max(0, limit - state.attempted.size);
    }

    function getItems() {
        return [...document.querySelectorAll(SELECTORS.item)].filter(item => item.querySelector(SELECTORS.image));
    }

    function getPosition(item) {
        const inlineTop = Number.parseFloat(item.style.top);
        const inlineLeft = Number.parseFloat(item.style.left);
        if (Number.isFinite(inlineTop) && Number.isFinite(inlineLeft)) {
            return { y: inlineTop, x: inlineLeft };
        }

        const rect = item.getBoundingClientRect();
        const scroller = getScroller(item);
        const scrollTop = isDocumentScroller(scroller) ? window.scrollY : scroller.scrollTop;
        const scrollLeft = isDocumentScroller(scroller) ? window.scrollX : scroller.scrollLeft;
        return { y: rect.top + scrollTop, x: rect.left + scrollLeft };
    }

    function mediaKey(item) {
        const media = item.querySelector(`${SELECTORS.image}, ${SELECTORS.video}`);
        const raw = media?.getAttribute('data-grok-cdn-src') || media?.currentSrc || media?.src || '';
        if (raw) {
            try {
                return new URL(raw, location.href).pathname;
            } catch (_) {
                return raw.split('?')[0];
            }
        }

        const pos = getPosition(item);
        return `position:${Math.round(pos.y)}:${Math.round(pos.x)}`;
    }

    function slotKey(itemOrPosition) {
        const pos = itemOrPosition instanceof Element ? getPosition(itemOrPosition) : itemOrPosition;
        return `${Math.round(pos.y)}:${Math.round(pos.x)}`;
    }

    function isCompletedVideo(item) {
        const video = item.querySelector(SELECTORS.video);
        if (!video) return false;
        const src = video.currentSrc || video.src || '';
        return Boolean(src || video.dataset.grokDone === '1');
    }

    function makeVideoButton(item) {
        return item.querySelector(SELECTORS.makeVideo);
    }

    function findItemByKey(key) {
        return getItems().find(item => mediaKey(item) === key) || null;
    }

    function findItemForJob(job) {
        const exact = findItemByKey(job.key);
        if (exact) return exact;

        // Grok can replace the original image URL with a new generated output
        // URL when the video finishes. The masonry slot remains stable.
        return getItems().find(item => {
            const pos = getPosition(item);
            return Math.abs(pos.y - job.y) <= SETTINGS.rowTolerancePx
                && Math.abs(pos.x - job.x) <= SETTINGS.rowTolerancePx;
        }) || null;
    }

    function isDocumentScroller(element) {
        return !element || element === document.documentElement || element === document.body || element === document.scrollingElement;
    }

    function getScroller(fromElement) {
        let node = fromElement?.parentElement || document.querySelector(SELECTORS.item)?.parentElement;
        while (node && node !== document.body && node !== document.documentElement) {
            const style = getComputedStyle(node);
            if (/(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight + 20) return node;
            node = node.parentElement;
        }
        return document.scrollingElement || document.documentElement;
    }

    function scrollerTop(scroller) {
        return isDocumentScroller(scroller) ? window.scrollY : scroller.scrollTop;
    }

    function scrollUp(scroller) {
        if (isDocumentScroller(scroller)) {
            window.scrollBy({ top: -SETTINGS.scrollStepPx, behavior: 'smooth' });
        } else {
            scroller.scrollBy({ top: -SETTINGS.scrollStepPx, behavior: 'smooth' });
        }
    }

    function scrollDown(scroller) {
        if (isDocumentScroller(scroller)) {
            window.scrollBy({ top: SETTINGS.scrollStepPx, behavior: 'smooth' });
        } else {
            scroller.scrollBy({ top: SETTINGS.scrollStepPx, behavior: 'smooth' });
        }
    }

    function scrollToTop(scroller) {
        if (isDocumentScroller(scroller)) {
            window.scrollTo({ top: 0, behavior: 'smooth' });
        } else {
            scroller.scrollTo({ top: 0, behavior: 'smooth' });
        }
    }

    function scrollerAtBottom(scroller) {
        if (isDocumentScroller(scroller)) {
            const root = document.scrollingElement || document.documentElement;
            return window.scrollY + window.innerHeight >= root.scrollHeight - 4;
        }
        return scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 4;
    }

    function visibleBoundsFor(item) {
        const scroller = getScroller(item);
        if (isDocumentScroller(scroller)) return { top: 0, bottom: window.innerHeight };
        const rect = scroller.getBoundingClientRect();
        return {
            top: Math.max(0, rect.top),
            bottom: Math.min(window.innerHeight, rect.bottom),
        };
    }

    function isComfortablyVisible(item) {
        const rect = item.getBoundingClientRect();
        const bounds = visibleBoundsFor(item);
        return rect.top >= bounds.top + 35 && rect.bottom <= bounds.bottom - 25;
    }

    function bringIntoView(item) {
        if (isComfortablyVisible(item)) return false;
        item.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
        const pos = getPosition(item);
        state.status = 'Scrolling to next item';
        state.lastAction = `Bringing row ${Math.round(pos.y)} into view before continuing.`;
        render();
        return true;
    }

    function lowestVisibleCompletedVideo() {
        const visible = getItems()
            .filter(isCompletedVideo)
            .filter(item => {
                const rect = item.getBoundingClientRect();
                return rect.bottom > 0 && rect.top < window.innerHeight;
            });

        visible.sort((a, b) => {
            const pa = getPosition(a);
            const pb = getPosition(b);
            return pb.y - pa.y || pb.x - pa.x;
        });
        return visible[0] || null;
    }

    function topLeftItem() {
        return getItems().sort((a, b) => compareItems(a, b, 'top-down'))[0] || null;
    }

    async function moveToTop(token) {
        state.status = 'Moving to top';
        state.lastAction = 'Preparing to generate from the top-left image.';
        render();

        for (let pass = 0; pass < 20 && state.running && token === state.loopToken; pass += 1) {
            const scroller = getScroller(document.querySelector(SELECTORS.item));
            if (scrollerTop(scroller) <= 4) {
                await sleep(SETTINGS.scrollDelayMs);
                return true;
            }
            scrollToTop(scroller);
            await sleep(SETTINGS.scrollDelayMs);
        }
        return state.running && token === state.loopToken
            && scrollerTop(getScroller(document.querySelector(SELECTORS.item))) <= 4;
    }

    function allowedByAnchor(item) {
        if (!state.startAnchor) return false;
        const pos = getPosition(item);
        const anchor = state.startAnchor;
        const sameRow = Math.abs(pos.y - anchor.y) <= SETTINGS.rowTolerancePx;

        if (getDirection() === 'top-down') {
            if (pos.y > anchor.y + SETTINGS.rowTolerancePx) return true;
            return sameRow && pos.x >= anchor.x - 1;
        }

        if (pos.y < anchor.y - SETTINGS.rowTolerancePx) return true;
        if (!sameRow) return false;

        // A picked image is included. An automatically detected video is only
        // a boundary, so the first eligible item must be to its left.
        return state.startMode === 'picked' ? pos.x <= anchor.x + 1 : pos.x < anchor.x - 1;
    }

    function compareItems(a, b, direction = getDirection()) {
        const pa = getPosition(a);
        const pb = getPosition(b);
        const sameRow = Math.abs(pa.y - pb.y) <= SETTINGS.rowTolerancePx;
        if (direction === 'top-down') return sameRow ? pa.x - pb.x : pa.y - pb.y;
        return sameRow ? pb.x - pa.x : pb.y - pa.y;
    }

    function traversalItems() {
        return getItems()
            .filter(allowedByAnchor)
            .filter(item => !state.attemptedSlots.has(slotKey(item)))
            .sort(compareItems);
    }

    function eligibleItems() {
        return traversalItems()
            .filter(item => !isCompletedVideo(item))
            .filter(item => Boolean(makeVideoButton(item)))
            .filter(item => {
                const key = mediaKey(item);
                return !state.attempted.has(key) && !state.pending.has(key);
            });
    }

    function clickCandidate(item) {
        const button = makeVideoButton(item);
        if (!button || button.disabled) return false;

        const key = mediaKey(item);
        const pos = getPosition(item);
        state.attempted.add(key);
        state.attemptedSlots.add(slotKey(pos));
        state.pending.set(key, {
            key,
            y: pos.y,
            x: pos.x,
            clickedAt: Date.now(),
            sawBusyState: false,
        });

        button.click();
        state.lastAction = `Clicked image at row ${Math.round(pos.y)}, column ${Math.round(pos.x)}.`;
        state.status = 'Generating';
        render();
        return true;
    }

    function settlePending() {
        const now = Date.now();
        for (const [key, job] of [...state.pending]) {
            const item = findItemForJob(job);
            if (item && isCompletedVideo(item)) {
                state.pending.delete(key);
                state.success += 1;
                state.lastAction = 'A video finished successfully.';
                continue;
            }

            const button = item ? makeVideoButton(item) : null;
            if (item && (!button || button.disabled || button.getAttribute('aria-busy') === 'true')) {
                job.sawBusyState = true;
            }

            const age = now - job.clickedAt;
            const returnedAfterBusy = Boolean(button && job.sawBusyState && age >= 2000);
            const neverAccepted = Boolean(button && !job.sawBusyState && age >= SETTINGS.clickAcceptanceMs);
            const timedOut = age >= SETTINGS.pendingTimeoutMs;

            if (returnedAfterBusy || neverAccepted || timedOut) {
                state.pending.delete(key);
                state.failed += 1;
                state.lastAction = timedOut
                    ? 'A generation timed out and was ignored.'
                    : 'A Make video button returned; that image is now ignored.';
            }
        }
        render();
    }

    async function waitForPending(token) {
        while (state.running && token === state.loopToken && state.pending.size > 0) {
            settlePending();
            if (state.pending.size > 0) await sleep(SETTINGS.pollMs);
        }
    }

    function resetRunCounters() {
        state.attempted.clear();
        state.attemptedSlots.clear();
        state.pending.clear();
        state.success = 0;
        state.failed = 0;
        state.topPasses = 0;
        state.finished = false;
    }

    function createAnchor(item, mode) {
        const pos = getPosition(item);
        return { key: mediaKey(item), y: pos.y, x: pos.x, mode };
    }

    async function start() {
        if (state.running) return;

        if (state.paused && state.startAnchor && !state.finished) {
            state.running = true;
            state.paused = false;
            state.status = 'Resuming';
            state.lastAction = 'Continuing the current run.';
            render();
            runLoop(++state.loopToken);
            return;
        }

        const direction = getDirection();
        const hasPickedStart = state.startAnchor && state.startMode === 'picked';

        if (direction === 'bottom-up' && !hasPickedStart) {
            const anchorItem = lowestVisibleCompletedVideo();
            if (!anchorItem) {
                state.status = 'No start video found';
                state.lastAction = 'No completed video is visible. Scroll to one, or use Pick start.';
                render();
                return;
            }
            state.startAnchor = createAnchor(anchorItem, 'automatic');
            state.startMode = 'automatic';
        }

        resetRunCounters();
        state.running = true;
        state.paused = false;
        const token = ++state.loopToken;

        if (direction === 'top-down' && !hasPickedStart) {
            state.startAnchor = null;
            state.startMode = 'automatic';
            const reachedTop = await moveToTop(token);
            if (!reachedTop) {
                if (state.running && token === state.loopToken) {
                    state.running = false;
                    state.status = 'Could not reach top';
                    state.lastAction = 'Use Pick start, or move to the top manually and try again.';
                    render();
                }
                return;
            }

            const anchorItem = topLeftItem();
            if (!anchorItem) {
                state.running = false;
                state.status = 'No images found';
                state.lastAction = 'No gallery image was available at the top of the page.';
                render();
                return;
            }
            state.startAnchor = createAnchor(anchorItem, 'automatic');
        }

        state.status = 'Starting';
        if (direction === 'top-down') {
            if (getGenerationLimit() === Infinity) {
                state.lastAction = state.startMode === 'picked'
                    ? 'Starting with the picked image and stopping at the first existing video.'
                    : 'Starting at the top-left and stopping at the first existing video.';
            } else {
                state.lastAction = `Moving right and downward, skipping existing videos until the limit of ${getGenerationLimit()}.`;
            }
        } else {
            state.lastAction = state.startMode === 'picked'
                ? 'Starting with the picked image, then moving left and upward.'
                : 'Starting left of the lowest visible completed video.';
        }
        render();
        runLoop(token);
    }

    function stop() {
        if (!state.running) return;
        state.running = false;
        state.paused = true;
        state.loopToken += 1;
        state.status = 'Stopped';
        state.lastAction = 'No new videos will be started. Existing Grok jobs were not cancelled.';
        render();
    }

    async function runLoop(token) {
        try {
            while (state.running && token === state.loopToken) {
                settlePending();

                // Keep each batch in view until it succeeds or fails, allowing
                // reliable detection of a returned Make video button.
                if (state.pending.size > 0) {
                    await waitForPending(token);
                    continue;
                }

                const direction = getDirection();
                const quota = remainingGenerationQuota();
                if (quota <= 0) {
                    state.running = false;
                    state.paused = false;
                    state.finished = true;
                    state.status = 'Limit reached';
                    state.lastAction = `Started the selected maximum of ${state.attempted.size} generation requests.`;
                    render();
                    return;
                }

                const stopAtExistingVideo = direction === 'top-down' && getGenerationLimit() === Infinity;
                let allCandidates;

                if (stopAtExistingVideo) {
                    const remaining = traversalItems()
                        .filter(item => isCompletedVideo(item) || Boolean(makeVideoButton(item)));
                    const boundaryIndex = remaining.findIndex(isCompletedVideo);

                    if (boundaryIndex === 0) {
                        if (bringIntoView(remaining[0])) {
                            await sleep(SETTINGS.scrollDelayMs);
                            continue;
                        }
                        state.running = false;
                        state.paused = false;
                        state.finished = true;
                        state.status = 'Finished';
                        state.lastAction = 'Reached the first existing generated video.';
                        render();
                        return;
                    }

                    allCandidates = boundaryIndex > 0 ? remaining.slice(0, boundaryIndex) : remaining;
                } else {
                    allCandidates = eligibleItems();
                }

                if (allCandidates.length > 0) {
                    // Virtualized masonry keeps some off-screen cards mounted.
                    // Always follow the next card before clicking it.
                    if (bringIntoView(allCandidates[0])) {
                        await sleep(SETTINGS.scrollDelayMs);
                        continue;
                    }

                    // Re-read after scrolling because Grok may recycle cards.
                    let refreshed;
                    if (stopAtExistingVideo) {
                        const remaining = traversalItems()
                            .filter(item => isCompletedVideo(item) || Boolean(makeVideoButton(item)));
                        const boundaryIndex = remaining.findIndex(isCompletedVideo);
                        refreshed = (boundaryIndex >= 0 ? remaining.slice(0, boundaryIndex) : remaining)
                            .filter(item => !isCompletedVideo(item) && Boolean(makeVideoButton(item)));
                    } else {
                        refreshed = eligibleItems();
                    }
                    const candidates = refreshed
                        .filter(isComfortablyVisible)
                        .slice(0, Math.min(getConcurrency(), quota));
                    for (const item of candidates) clickCandidate(item);
                    await waitForPending(token);
                    continue;
                }

                const scroller = getScroller(document.querySelector(SELECTORS.item));
                const before = scrollerTop(scroller);
                const reachedEdge = direction === 'top-down' ? scrollerAtBottom(scroller) : before <= 4;
                if (reachedEdge) {
                    state.topPasses += 1;
                    state.status = direction === 'top-down' ? 'Checking bottom' : 'Checking top';
                    state.lastAction = `${direction === 'top-down' ? 'Bottom' : 'Top'}-of-page check ${state.topPasses}/${SETTINGS.topStablePasses}.`;
                    render();

                    if (state.topPasses >= SETTINGS.topStablePasses) {
                        state.running = false;
                        state.paused = false;
                        state.finished = true;
                        state.status = 'Finished';
                        state.lastAction = direction === 'top-down'
                            ? (getGenerationLimit() === Infinity
                                ? 'Reached the bottom without finding another existing video.'
                                : `Reached the bottom after starting ${state.attempted.size} generation requests.`)
                            : 'Reached the top of the Saved page.';
                        render();
                        return;
                    }
                    await sleep(SETTINGS.scrollDelayMs);
                    continue;
                }

                state.topPasses = 0;
                state.status = direction === 'top-down' ? 'Scrolling downward' : 'Scrolling upward';
                state.lastAction = direction === 'top-down'
                    ? `Scrolling down ${SETTINGS.scrollStepPx}px to inspect later images.`
                    : `Scrolling up ${SETTINGS.scrollStepPx}px to inspect earlier images.`;
                render();
                if (direction === 'top-down') scrollDown(scroller);
                else scrollUp(scroller);
                await sleep(SETTINGS.scrollDelayMs);
            }
        } catch (error) {
            console.error(`[${SCRIPT}]`, error);
            state.running = false;
            state.paused = true;
            state.status = 'Error';
            state.lastAction = error?.message || String(error);
            render();
        }
    }

    function clearSelectedMarker() {
        selectedMarker?.remove();
        selectedMarker = null;
    }

    function markSelected(item) {
        clearSelectedMarker();
        const card = item.querySelector(SELECTORS.card) || item.firstElementChild || item;
        if (getComputedStyle(card).position === 'static') card.style.position = 'relative';
        selectedMarker = document.createElement('div');
        selectedMarker.textContent = 'START';
        Object.assign(selectedMarker.style, {
            position: 'absolute', inset: '0', zIndex: '2147483000', pointerEvents: 'none',
            border: '4px solid #8b5cf6', borderRadius: '5px', boxSizing: 'border-box',
            color: '#fff', font: '700 12px/1 system-ui', padding: '8px',
            textShadow: '0 1px 3px #000', boxShadow: 'inset 0 0 0 1px rgba(255,255,255,.7)',
        });
        card.appendChild(selectedMarker);
    }

    function armPicker() {
        if (state.running) return;
        state.picking = true;
        state.status = 'Pick a start image';
        state.lastAction = 'Click any gallery image. The click will only select it.';
        document.body.style.cursor = 'crosshair';
        render();
    }

    function disarmPicker() {
        state.picking = false;
        document.body.style.cursor = '';
        render();
    }

    function onPickClick(event) {
        if (!state.picking) return;
        if (event.composedPath().includes(panelHost)) return;
        const item = event.target.closest?.(SELECTORS.item);
        if (!item || !item.querySelector(SELECTORS.image)) return;

        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        state.startAnchor = createAnchor(item, 'picked');
        state.startMode = 'picked';
        state.paused = false;
        state.finished = false;
        state.status = 'Start image selected';
        state.lastAction = 'Press Start when ready.';
        markSelected(item);
        disarmPicker();
    }

    function clearPick() {
        if (state.running) return;
        clearSelectedMarker();
        state.startAnchor = null;
        state.startMode = null;
        state.paused = false;
        state.finished = false;
        state.status = 'Ready';
        state.lastAction = getDirection() === 'top-down'
            ? 'Automatic mode will begin at the top-left image.'
            : 'Automatic mode will use the lowest visible completed video.';
        render();
    }

    function render() {
        if (!ui) return;
        ui.status.textContent = state.status;
        ui.detail.textContent = state.lastAction;
        ui.active.textContent = String(state.pending.size);
        ui.attempted.textContent = String(state.attempted.size);
        ui.success.textContent = String(state.success);
        ui.failed.textContent = String(state.failed);
        ui.mode.textContent = state.startMode === 'picked'
            ? 'Picked image'
            : (getDirection() === 'top-down' ? 'Top-left image' : 'Lowest visible video');
        ui.start.disabled = state.running || state.picking;
        ui.start.textContent = state.paused && !state.finished ? 'Resume' : 'Start';
        ui.stop.disabled = !state.running;
        ui.pick.disabled = state.running || state.picking;
        ui.clear.disabled = state.running || (!state.startAnchor && !state.picking);
        ui.direction.disabled = state.running || state.picking;
        panelHost.dataset.state = state.running ? 'running' : (state.finished ? 'finished' : 'idle');
    }

    function applyPanelMinimized(minimized, persist = true) {
        const value = Boolean(minimized);
        panelHost.dataset.minimized = value ? '1' : '0';
        panelHost.style.width = value ? '174px' : '310px';
        ui.minimize.textContent = value ? '□' : '−';
        ui.minimize.title = value ? 'Restore panel' : 'Minimize panel';
        ui.minimize.setAttribute('aria-label', ui.minimize.title);

        // Keep a left-positioned panel inside the viewport when its size changes.
        if (panelHost.style.left) {
            const rect = panelHost.getBoundingClientRect();
            panelHost.style.left = `${clamp(rect.left, 0, Math.max(0, innerWidth - panelHost.offsetWidth))}px`;
        }
        if (persist) GM_setValue(STORAGE.panelMinimized, value);
    }

    function togglePanelMinimized() {
        applyPanelMinimized(panelHost.dataset.minimized !== '1');
    }

    function installPanel() {
        panelHost = document.createElement('div');
        panelHost.id = 'grok-saved-video-generator-panel';
        Object.assign(panelHost.style, {
            position: 'fixed', top: '90px', right: '20px', zIndex: '2147483647',
            width: '310px', colorScheme: 'dark', fontFamily: 'Inter, system-ui, sans-serif',
        });
        document.documentElement.appendChild(panelHost);

        const shadow = panelHost.attachShadow({ mode: 'open' });
        shadow.innerHTML = `
            <style>
                * { box-sizing: border-box; }
                .panel { color:#f8fafc; background:rgba(15,23,42,.96); border:1px solid rgba(148,163,184,.35); border-radius:14px; box-shadow:0 15px 45px rgba(0,0,0,.45); overflow:hidden; backdrop-filter:blur(12px); }
                .head { display:flex; align-items:center; justify-content:space-between; padding:11px 13px; background:rgba(30,41,59,.9); cursor:move; user-select:none; border-bottom:1px solid rgba(148,163,184,.22); }
                .title { font-size:13px; font-weight:750; letter-spacing:.01em; }
                .head-actions { display:flex; align-items:center; gap:10px; }
                .dot { width:9px; height:9px; border-radius:50%; background:#64748b; box-shadow:0 0 0 3px rgba(100,116,139,.16); }
                :host([data-state="running"]) .dot { background:#22c55e; box-shadow:0 0 0 3px rgba(34,197,94,.18); }
                :host([data-state="finished"]) .dot { background:#a78bfa; box-shadow:0 0 0 3px rgba(167,139,250,.18); }
                :host([data-minimized="1"]) .head { border-bottom-color:transparent; }
                :host([data-minimized="1"]) .body { display:none; }
                .body { padding:13px; }
                .status { font-size:14px; font-weight:700; margin-bottom:4px; }
                .detail { color:#cbd5e1; font-size:11px; line-height:1.4; min-height:31px; margin-bottom:11px; }
                .buttons { display:grid; grid-template-columns:1fr 1fr; gap:7px; margin-bottom:11px; }
                button { border:1px solid rgba(148,163,184,.32); border-radius:9px; padding:8px 9px; background:#334155; color:#fff; font:650 12px/1 system-ui; cursor:pointer; }
                button:hover:not(:disabled) { background:#475569; }
                button:disabled { opacity:.42; cursor:not-allowed; }
                .minimize { width:24px; height:24px; padding:0; border-radius:7px; font-size:16px; line-height:20px; background:rgba(15,23,42,.75); }
                .start { background:#6d28d9; border-color:#8b5cf6; }
                .start:hover:not(:disabled) { background:#7c3aed; }
                .stop { background:#991b1b; border-color:#dc2626; }
                .stop:hover:not(:disabled) { background:#b91c1c; }
                .control { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:9px 0; border-top:1px solid rgba(148,163,184,.18); border-bottom:1px solid rgba(148,163,184,.18); }
                label { color:#cbd5e1; font-size:12px; }
                input[type="number"], select { border:1px solid rgba(148,163,184,.38); border-radius:8px; padding:6px 7px; color:#fff; background:#0f172a; font:600 12px system-ui; }
                input[type="number"] { width:64px; }
                select { width:148px; }
                .limit-controls { display:flex; align-items:center; gap:7px; }
                .unlimited-label { display:flex; align-items:center; gap:4px; color:#e2e8f0; cursor:pointer; white-space:nowrap; }
                .unlimited-label input { margin:0; accent-color:#8b5cf6; }
                .mode { display:flex; justify-content:space-between; gap:10px; color:#94a3b8; font-size:11px; margin:9px 0; }
                .mode b { color:#e2e8f0; font-weight:650; text-align:right; }
                .stats { display:grid; grid-template-columns:repeat(4,1fr); gap:5px; }
                .stat { text-align:center; border-radius:8px; background:rgba(30,41,59,.82); padding:7px 3px; }
                .stat b { display:block; font-size:14px; margin-bottom:2px; }
                .stat span { color:#94a3b8; font-size:9px; text-transform:uppercase; letter-spacing:.04em; }
            </style>
            <div class="panel">
                <div class="head">
                    <span class="title">Video Generator</span>
                    <span class="head-actions"><span class="dot"></span><button type="button" class="minimize" title="Minimize panel" aria-label="Minimize panel">−</button></span>
                </div>
                <div class="body">
                    <div class="status">Ready</div>
                    <div class="detail"></div>
                    <div class="buttons">
                        <button class="start">Start</button><button class="stop">Stop</button>
                        <button class="pick">Pick start</button><button class="clear">Clear pick</button>
                    </div>
                    <div class="control"><label for="direction">Generation direction</label><select id="direction"><option value="bottom-up">Bottom → Top</option><option value="top-down">Top → Bottom</option></select></div>
                    <div class="control"><label for="concurrency">Simultaneous videos</label><input id="concurrency" type="number" min="1" max="10" step="1"></div>
                    <div class="control"><label for="generation-limit">Maximum to start</label><div class="limit-controls"><input id="generation-limit" type="number" min="1" max="100000" step="1"><label class="unlimited-label"><input id="unlimited" type="checkbox">Unlimited</label></div></div>
                    <div class="mode"><span>Start mode</span><b></b></div>
                    <div class="stats">
                        <div class="stat"><b class="active">0</b><span>Active</span></div>
                        <div class="stat"><b class="attempted">0</b><span>Tried</span></div>
                        <div class="stat"><b class="success">0</b><span>Done</span></div>
                        <div class="stat"><b class="failed">0</b><span>Ignored</span></div>
                    </div>
                </div>
            </div>`;

        ui = {
            head: shadow.querySelector('.head'), status: shadow.querySelector('.status'), detail: shadow.querySelector('.detail'),
            minimize: shadow.querySelector('.minimize'),
            start: shadow.querySelector('.start'), stop: shadow.querySelector('.stop'), pick: shadow.querySelector('.pick'),
            clear: shadow.querySelector('.clear'), direction: shadow.querySelector('#direction'),
            concurrency: shadow.querySelector('#concurrency'), generationLimit: shadow.querySelector('#generation-limit'),
            unlimited: shadow.querySelector('#unlimited'), mode: shadow.querySelector('.mode b'),
            active: shadow.querySelector('.active'), attempted: shadow.querySelector('.attempted'), success: shadow.querySelector('.success'),
            failed: shadow.querySelector('.failed'),
        };

        ui.concurrency.value = String(getConcurrency());
        ui.direction.value = getDirection();
        syncLimitControls();
        ui.start.addEventListener('click', start);
        ui.stop.addEventListener('click', stop);
        ui.pick.addEventListener('click', armPicker);
        ui.clear.addEventListener('click', clearPick);
        ui.direction.addEventListener('change', event => setDirection(event.target.value));
        ui.concurrency.addEventListener('change', event => setConcurrency(event.target.value));
        ui.generationLimit.addEventListener('change', event => setFiniteLimit(event.target.value));
        ui.unlimited.addEventListener('change', event => setUnlimited(event.target.checked));
        ui.minimize.addEventListener('pointerdown', event => event.stopPropagation());
        ui.minimize.addEventListener('click', togglePanelMinimized);
        installDragging();
        applyPanelMinimized(GM_getValue(STORAGE.panelMinimized, false), false);
        restorePanelPosition();
        render();
    }

    function restorePanelPosition() {
        const saved = GM_getValue(STORAGE.panelPosition, null);
        if (!saved || !Number.isFinite(saved.left) || !Number.isFinite(saved.top)) return;
        panelHost.style.left = `${clamp(saved.left, 0, Math.max(0, innerWidth - panelHost.offsetWidth))}px`;
        panelHost.style.top = `${clamp(saved.top, 0, Math.max(0, innerHeight - 80))}px`;
        panelHost.style.right = 'auto';
    }

    function installDragging() {
        let drag = null;
        ui.head.addEventListener('pointerdown', event => {
            if (event.button !== 0) return;
            const rect = panelHost.getBoundingClientRect();
            drag = { dx: event.clientX - rect.left, dy: event.clientY - rect.top };
            ui.head.setPointerCapture(event.pointerId);
            event.preventDefault();
        });
        ui.head.addEventListener('pointermove', event => {
            if (!drag) return;
            const left = clamp(event.clientX - drag.dx, 0, Math.max(0, innerWidth - panelHost.offsetWidth));
            const top = clamp(event.clientY - drag.dy, 0, Math.max(0, innerHeight - 50));
            panelHost.style.left = `${left}px`;
            panelHost.style.top = `${top}px`;
            panelHost.style.right = 'auto';
        });
        const finishDrag = event => {
            if (!drag) return;
            drag = null;
            try { ui.head.releasePointerCapture(event.pointerId); } catch (_) { /* already released */ }
            const rect = panelHost.getBoundingClientRect();
            GM_setValue(STORAGE.panelPosition, { left: Math.round(rect.left), top: Math.round(rect.top) });
        };
        ui.head.addEventListener('pointerup', finishDrag);
        ui.head.addEventListener('pointercancel', finishDrag);
    }

    document.addEventListener('click', onPickClick, true);
    window.addEventListener('beforeunload', () => { state.running = false; state.loopToken += 1; });
    installPanel();
})();
