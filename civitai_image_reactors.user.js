// ==UserScript==
// @name         Civitai Image Reactors
// @namespace    https://civitai.com/
// @version      1.1.0
// @description  Show every reactor group on your own images when hovering over a reaction.
// @match        https://civitai.com/*
// @match        https://civitai.red/*
// @match        https://civitai.green/*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @connect      creator-studio.civitai.com
// ==/UserScript==

(() => {
    'use strict';

    const API_ORIGIN = 'https://creator-studio.civitai.com';
    const CACHE_MS = 60_000;
    const REACTIONS = { Like: '👍', Heart: '❤️', Laugh: '😂', Cry: '😢' };
    const reactionCache = new Map();
    const ownershipCache = new Map();
    const panels = new WeakMap();
    let sessionPromise = null;
    let sessionValue = null;
    let sessionUpdated = 0;

    const style = document.createElement('style');
    style.textContent = `
        .civ-reactors-panel {
            position: absolute; z-index: 50; left: 6px; right: 6px;
            box-sizing: border-box; padding: 7px 9px; overflow-y: auto;
            border: 1px solid #707782; border-radius: 8px;
            background: #20232b; color: #f5f5f5;
            box-shadow: 0 4px 18px #0009;
            font: 12px/1.4 system-ui, sans-serif;
        }
        .civ-reactors-panel[hidden] { display: none !important; }
        .civ-reactors-group + .civ-reactors-group { margin-top: 8px; }
        .civ-reactors-heading { margin-bottom: 5px; font-weight: 700; }
        .civ-reactors-list { display: flex; flex-wrap: wrap; gap: 4px 6px; }
        .civ-reactors-user {
            display: inline-flex; align-items: center; gap: 2px;
            padding: 2px 5px; border-radius: 5px;
            background: #363b47; color: #e7efff; text-decoration: none;
            overflow-wrap: anywhere;
        }
        a.civ-reactors-user:hover, a.civ-reactors-user:focus-visible {
            background: #465b83; text-decoration: underline;
        }
        .civ-reactors-more {
            display: block; margin-top: 6px; padding: 2px 6px;
            border: 1px solid #777; border-radius: 5px;
            background: #363b47; color: #fff; cursor: pointer;
        }
        .civ-reactors-note { color: #ccd1dc; }
    `;
    (document.head || document.documentElement).append(style);

    function reactionRow(target) {
        const button = target instanceof Element ? target.closest('button[aria-label$=" reaction"]') : null;
        const reaction = button?.getAttribute('aria-label')?.replace(/ reaction$/, '');
        if (!Object.hasOwn(REACTIONS, reaction)) return null;
        const row = button.closest('div[class*="__reactions"]');
        return row ? { button, row } : null;
    }

    function imageIdFor(row) {
        const parent = row.parentElement;
        const link = parent?.querySelector(':scope > a[href*="/images/"]')
            || parent?.querySelector('a[href*="/images/"]');
        const path = link?.getAttribute('href') || '';
        return path.match(/(?:^|\/)images\/(\d+)(?:[/?#]|$)/)?.[1] || null;
    }

    async function currentUser() {
        if (Date.now() - sessionUpdated < CACHE_MS) return sessionValue;
        if (sessionPromise) return sessionPromise;
        sessionPromise = (async () => {
            const response = await fetch('/api/auth/session', {
                credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' },
            });
            if (!response.ok) throw new Error(`Session lookup failed: HTTP ${response.status}`);
            const session = await response.json();
            const user = session?.user;
            sessionValue = user && Number.isSafeInteger(Number(user.id)) ? {
                id: String(user.id),
                username: typeof user.username === 'string' ? user.username.trim() : '',
                browsingLevel: Number(user.browsingLevel) || 0,
            } : null;
            sessionUpdated = Date.now();
            return sessionValue;
        })().finally(() => { sessionPromise = null; });
        return sessionPromise;
    }

    function cardOwner(row) {
        // The gallery's creator links are inside the card that contains the media and reaction row.
        // Carousel slides have no creator link, so they use the image API below.
        const card = row.parentElement?.parentElement;
        if (!card) return null;
        const names = new Set();
        for (const link of card.querySelectorAll('a[href*="/user/"]')) {
            if (link.closest('.civ-reactors-panel')) continue;
            try {
                const url = new URL(link.getAttribute('href'), location.origin);
                if (!/^civitai\.(com|red|green)$/i.test(url.hostname)) continue;
                const match = url.pathname.match(/^\/user\/([^/]+)\/?$/);
                if (match) names.add(decodeURIComponent(match[1]).toLowerCase());
            } catch { /* Ignore malformed links. */ }
        }
        return names.size === 1 ? [...names][0] : null;
    }

    function ownsImage(row, imageId, user) {
        const owner = cardOwner(row);
        if (owner && user.username) return Promise.resolve(owner === user.username.toLowerCase());

        const key = `${user.id}:${imageId}`;
        if (ownershipCache.has(key)) return ownershipCache.get(key);
        const url = new URL('/api/v1/images', location.origin);
        url.searchParams.set('imageId', imageId);
        url.searchParams.set('userId', user.id);
        url.searchParams.set('browsingLevel', String(user.browsingLevel));
        url.searchParams.set('limit', '1');
        const promise = fetch(url, {
            credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' },
        }).then(async response => {
            if (!response.ok) throw new Error(`Image ownership lookup failed: HTTP ${response.status}`);
            const data = await response.json();
            return Array.isArray(data.items) && data.items.some(item => String(item.id) === imageId
                && (!user.username || item.username?.toLowerCase() === user.username.toLowerCase()));
        }).catch(error => {
            ownershipCache.delete(key);
            throw error;
        });
        ownershipCache.set(key, promise);
        return promise;
    }

    function requestJson(url) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'GET', url, timeout: 15_000,
                anonymous: false, withCredentials: true,
                headers: { Accept: 'application/json' },
                onload(response) {
                    if (response.status < 200 || response.status >= 300) {
                        reject(new Error(`HTTP ${response.status}. Sign in to Civitai Creator Studio if needed.`));
                        return;
                    }
                    try { resolve(JSON.parse(response.responseText)); }
                    catch { reject(new Error('The reactors response was not JSON. Sign in to Civitai Creator Studio if needed.')); }
                },
                onerror() { reject(new Error('The reactors request failed.')); },
                ontimeout() { reject(new Error('The reactors request timed out.')); },
            });
        });
    }

    function reactorsUrl(imageId, reaction, next = null) {
        const url = new URL(`/analytics/content/image/${imageId}/reactors`, API_ORIGIN);
        url.searchParams.set('reaction', reaction);
        if (next != null) url.searchParams.set('after', String(next));
        return url.href;
    }

    async function loadPage(imageId, reaction, next = null) {
        const data = await requestJson(reactorsUrl(imageId, reaction, next));
        if (!data || data.reaction !== reaction || !Array.isArray(data.reactors)) {
            throw new Error('Unexpected reactors response for this reaction.');
        }
        return data;
    }

    function getAllReactors(imageId, userId) {
        const key = `${userId}:${imageId}`;
        const found = reactionCache.get(key);
        if (found && (found.promise || Date.now() - found.updated < CACHE_MS)) {
            return found.promise || Promise.resolve(found);
        }
        const entry = { groups: new Map(), errors: [], updated: 0, promise: null };
        entry.promise = (async () => {
            // The Like response includes counts for every reaction. Skip requests with zero count.
            const first = await loadPage(imageId, 'Like');
            const counts = first.counts || {};
            if (first.reactors.length) entry.groups.set('Like', {
                reactors: first.reactors, next: first.next,
                count: counts.Like ?? first.reactors.length,
            });
            const others = Object.keys(REACTIONS).slice(1)
                .filter(reaction => Number(counts[reaction]) > 0);
            const pages = await Promise.allSettled(others.map(reaction => loadPage(imageId, reaction)));
            pages.forEach((result, index) => {
                const reaction = others[index];
                if (result.status === 'rejected') {
                    entry.errors.push(reaction);
                    console.warn(`Civitai Image Reactors: ${reaction}`, result.reason);
                } else if (result.value.reactors.length) {
                    entry.groups.set(reaction, {
                        reactors: result.value.reactors,
                        next: result.value.next,
                        count: result.value.counts?.[reaction] ?? result.value.reactors.length,
                    });
                }
            });
            entry.updated = Date.now();
            entry.promise = null;
            return entry;
        })().catch(error => {
            reactionCache.delete(key);
            throw error;
        });
        reactionCache.set(key, entry);
        return entry.promise;
    }

    function panelFor(row) {
        let state = panels.get(row);
        if (state) return state;
        const panel = document.createElement('div');
        panel.className = 'civ-reactors-panel';
        panel.hidden = true;
        panel.setAttribute('role', 'region');
        row.parentElement.insertBefore(panel, row);
        state = { panel, row, key: null, status: null, serial: 0, hideTimer: null };
        panels.set(row, state);
        const cancelHide = () => clearTimeout(state.hideTimer);
        const scheduleHide = () => {
            cancelHide();
            state.hideTimer = setTimeout(() => { panel.hidden = true; }, 180);
        };
        row.addEventListener('pointerenter', cancelHide);
        row.addEventListener('pointerleave', scheduleHide);
        panel.addEventListener('pointerenter', cancelHide);
        panel.addEventListener('pointerleave', scheduleHide);
        row.addEventListener('focusout', event => {
            if (!row.contains(event.relatedTarget) && !panel.contains(event.relatedTarget)) scheduleHide();
        });
        panel.addEventListener('focusin', cancelHide);
        panel.addEventListener('focusout', event => {
            if (!panel.contains(event.relatedTarget) && !row.contains(event.relatedTarget)) scheduleHide();
        });
        return state;
    }

    function positionPanel(state) {
        const { row, panel } = state;
        const parentBox = row.parentElement.getBoundingClientRect();
        const rowBox = row.getBoundingClientRect();
        const spaceAbove = Math.max(0, rowBox.top - parentBox.top);
        panel.style.bottom = `${Math.max(0, parentBox.bottom - rowBox.top + 3)}px`;
        panel.style.maxHeight = `${Math.max(40, Math.min(230, spaceAbove - 6))}px`;
    }

    function note(panel, message) {
        const div = document.createElement('div');
        div.className = 'civ-reactors-note';
        div.textContent = message;
        panel.append(div);
    }

    function render(state, entry, imageId, key) {
        const { panel } = state;
        panel.replaceChildren();
        let displayed = 0;
        for (const reaction of Object.keys(REACTIONS)) {
            const group = entry.groups.get(reaction);
            if (!group?.reactors.length) continue;
            displayed++;
            const section = document.createElement('section');
            section.className = 'civ-reactors-group';
            const heading = document.createElement('div');
            heading.className = 'civ-reactors-heading';
            heading.textContent = `${REACTIONS[reaction]} ${reaction} · ${group.count}`;
            section.append(heading);
            const list = document.createElement('div');
            list.className = 'civ-reactors-list';
            for (const person of group.reactors) {
                const name = typeof person.username === 'string' ? person.username.trim() : '';
                const chip = document.createElement(name && !person.deleted ? 'a' : 'span');
                chip.className = 'civ-reactors-user';
                if (name && !person.deleted) chip.href = `https://civitai.red/user/${encodeURIComponent(name)}/`;
                const time = new Date(person.reactedAt);
                chip.title = Number.isNaN(time.getTime()) ? 'Reaction time unavailable' : time.toLocaleString();
                chip.textContent = person.deleted ? 'Deleted account' : name || `User #${person.userId || '?'}`;
                for (const [flag, emoji, label] of [
                    ['follows', '⭐', 'Follows you'],
                    ['banned', '💀', 'Banned'],
                    ['deleted', '🗑️', 'Deleted'],
                ]) {
                    if (!person[flag]) continue;
                    const marker = document.createElement('span');
                    marker.textContent = emoji;
                    marker.title = label;
                    marker.setAttribute('aria-label', label);
                    chip.append(marker);
                }
                list.append(chip);
            }
            section.append(list);
            if (group.next != null) {
                const more = document.createElement('button');
                more.type = 'button';
                more.className = 'civ-reactors-more';
                more.textContent = 'Load more';
                more.addEventListener('click', async () => {
                    more.disabled = true;
                    more.textContent = 'Loading…';
                    try {
                        const page = await loadPage(imageId, reaction, group.next);
                        group.reactors.push(...page.reactors);
                        group.next = page.next;
                        entry.updated = Date.now();
                        if (state.key === key) render(state, entry, imageId, key);
                    } catch (error) {
                        more.disabled = false;
                        more.textContent = 'Retry loading more';
                        console.warn('Civitai Image Reactors:', error);
                    }
                });
                section.append(more);
            }
            panel.append(section);
        }
        if (!displayed && !entry.errors.length) note(panel, 'No reactors found.');
        if (entry.errors.length) note(panel, `Could not load: ${entry.errors.join(', ')}.`);
    }

    async function show(row) {
        const imageId = imageIdFor(row);
        if (!imageId) return;
        try {
            const user = await currentUser();
            if (!user || !row.isConnected || !await ownsImage(row, imageId, user)) {
                const existing = panels.get(row);
                if (existing) existing.panel.hidden = true;
                return;
            }
            if (!row.isConnected || (!row.matches(':hover') && !row.contains(document.activeElement))) return;
            const state = panelFor(row);
            clearTimeout(state.hideTimer);
            positionPanel(state);
            state.panel.hidden = false;
            const key = `${user.id}:${imageId}`;
            const cached = reactionCache.get(key);
            if (state.key === key && (state.status === 'loading'
                || (state.status === 'ready' && cached && Date.now() - cached.updated < CACHE_MS))) return;
            state.key = key;
            state.status = 'loading';
            const serial = ++state.serial;
            state.panel.replaceChildren();
            note(state.panel, 'Loading reactors…');
            try {
                const entry = await getAllReactors(imageId, user.id);
                if (state.serial === serial) {
                    state.status = 'ready';
                    render(state, entry, imageId, key);
                }
            } catch (error) {
                if (state.serial === serial) {
                    state.status = 'error';
                    state.panel.replaceChildren();
                    note(state.panel, error.message);
                }
                console.warn('Civitai Image Reactors:', error);
            }
        } catch (error) {
            console.warn('Civitai Image Reactors: ownership check failed:', error);
        }
    }

    document.addEventListener('pointerover', event => {
        const match = reactionRow(event.target);
        if (match && !match.button.contains(event.relatedTarget)) show(match.row);
    });
    document.addEventListener('focusin', event => {
        const match = reactionRow(event.target);
        if (match) show(match.row);
    });
})();
