// ==UserScript==
// @name         Civitai Image Reactors
// @namespace    https://civitai.com/
// @version      1.2.4
// @description  Show a paged list of people and their reactions on your own images.
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
    const MAX_PAGE_SIZE = 13;
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
            box-sizing: border-box; padding: 7px 9px;
            display: flex; flex-direction: column; overflow: hidden;
            border: 1px solid #707782; border-radius: 8px;
            background: #20232b; color: #f5f5f5;
            box-shadow: 0 4px 18px #0009;
            font: 12px/1.4 system-ui, sans-serif;
        }
        .civ-reactors-panel[hidden] { display: none !important; }
        .civ-reactors-heading {
            flex: none; display: flex; align-items: baseline; justify-content: space-between;
            gap: 8px; margin-bottom: 6px; white-space: nowrap; font-size: 11px;
        }
        .civ-reactors-total { font-weight: 700; }
        .civ-reactors-summary { color: #ccd1dc; text-align: right; }
        .civ-reactors-list { min-height: 0; overflow-y: auto; display: grid; gap: 2px; }
        .civ-reactors-user {
            display: grid; grid-template-columns: 50px minmax(0, 1fr) auto;
            align-items: center; gap: 5px; min-width: 0;
            padding: 3px 5px; border-radius: 5px; background: #363b47;
        }
        .civ-reactors-status { white-space: nowrap; }
        .civ-reactors-name {
            min-width: 0; overflow: hidden; text-overflow: ellipsis;
            white-space: nowrap; color: #e7efff; text-decoration: none;
        }
        a.civ-reactors-name:hover, a.civ-reactors-name:focus-visible {
            color: #fff; text-decoration: underline;
        }
        .civ-reactors-emojis {
            display: inline-flex; justify-self: end; gap: 3px;
            white-space: nowrap; font-size: 15px;
        }
        .civ-reactors-pagination {
            flex: none; display: flex; align-items: center; justify-content: center;
            gap: 9px; margin-top: 7px; padding-top: 5px;
            border-top: 1px solid #555b67;
        }
        .civ-reactors-pagination button {
            min-width: 28px; padding: 2px 6px; border: 1px solid #777;
            border-radius: 5px; background: #363b47; color: #fff; cursor: pointer;
        }
        .civ-reactors-pagination button:disabled { opacity: 0.4; cursor: default; }
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
            if (first.reactors.length || first.next != null) entry.groups.set('Like', {
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
                } else if (result.value.reactors.length || result.value.next != null) {
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
        panel.tabIndex = -1;
        row.parentElement.insertBefore(panel, row);
        state = { panel, row, key: null, status: null, page: 0, pageSize: MAX_PAGE_SIZE, loadingMore: false, moreError: '', serial: 0, hideTimer: null };
        panels.set(row, state);
        const cancelHide = () => clearTimeout(state.hideTimer);
        const scheduleHide = () => {
            cancelHide();
            state.hideTimer = setTimeout(() => {
                if (!panel.matches(':hover') && !row.matches(':hover')
                    && !panel.contains(document.activeElement)
                    && !row.contains(document.activeElement)) panel.hidden = true;
            }, 180);
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
            if (!state.loadingMore && !panel.contains(event.relatedTarget)
                && !row.contains(event.relatedTarget)) scheduleHide();
        });
        return state;
    }

    function positionPanel(state) {
        const { row, panel } = state;
        const parentBox = row.parentElement.getBoundingClientRect();
        const rowBox = row.getBoundingClientRect();
        const spaceAbove = Math.max(0, rowBox.top - parentBox.top);
        panel.style.bottom = `${Math.max(0, parentBox.bottom - rowBox.top + 3)}px`;
        const availableHeight = Math.max(40, Math.min(440, spaceAbove - 6));
        panel.style.maxHeight = `${availableHeight}px`;
        // Leave room for the title, pager, borders, and padding, then fit whole rows.
        state.pageSize = Math.max(1, Math.min(MAX_PAGE_SIZE, Math.floor((availableHeight - 82) / 25)));
    }

    function note(panel, message) {
        const div = document.createElement('div');
        div.className = 'civ-reactors-note';
        div.textContent = message;
        panel.append(div);
    }

    function peopleFor(entry) {
        const people = new Map();
        for (const reaction of Object.keys(REACTIONS)) {
            const group = entry.groups.get(reaction);
            if (!group) continue;
            group.reactors.forEach((person, index) => {
                const name = typeof person.username === 'string' ? person.username.trim() : '';
                const key = person.userId != null ? `id:${person.userId}`
                    : name ? `name:${name.toLowerCase()}` : `unknown:${reaction}:${index}`;
                let row = people.get(key);
                if (!row) {
                    row = { name, userId: person.userId, follows: false, banned: false,
                        deleted: false, reactions: new Map() };
                    people.set(key, row);
                }
                if (!row.name && name) row.name = name;
                row.follows ||= !!person.follows;
                row.banned ||= !!person.banned;
                row.deleted ||= !!person.deleted;
                if (!row.reactions.has(reaction)) row.reactions.set(reaction, person.reactedAt);
            });
        }
        return [...people.values()];
    }

    function hasMore(entry) {
        return [...entry.groups.values()].some(group => group.next != null);
    }

    function reactionTime(value) {
        const time = new Date(value);
        return Number.isNaN(time.getTime()) ? 'Reaction time unavailable' : time.toLocaleString();
    }

    async function loadNextBatch(entry, imageId) {
        const pending = Object.keys(REACTIONS)
            .filter(reaction => entry.groups.get(reaction)?.next != null);
        const pages = await Promise.allSettled(pending.map(reaction =>
            loadPage(imageId, reaction, entry.groups.get(reaction).next)));
        let loaded = false;
        pages.forEach((result, index) => {
            const reaction = pending[index];
            const group = entry.groups.get(reaction);
            if (result.status === 'rejected') {
                console.warn(`Civitai Image Reactors: ${reaction} page`, result.reason);
                return;
            }
            loaded = true;
            const cursor = group.next;
            group.reactors.push(...result.value.reactors);
            // A repeated cursor must not cause an endless pagination loop.
            group.next = result.value.next === cursor ? null : result.value.next;
        });
        if (loaded) entry.updated = Date.now();
        return loaded;
    }

    function focusPager(state, direction) {
        const preferred = state.panel.querySelector(`[data-page-${direction}]`);
        const target = preferred && !preferred.disabled ? preferred
            : state.panel.querySelector('.civ-reactors-pagination button:not(:disabled)') || state.panel;
        target.focus({ preventScroll: true });
        clearTimeout(state.hideTimer);
        state.panel.hidden = false;
    }

    async function nextPage(state, entry, imageId, key) {
        if (state.loadingMore || state.key !== key) return;
        const target = state.page + 1;
        if (target * state.pageSize < peopleFor(entry).length) {
            state.page = target;
            render(state, entry, imageId, key);
            focusPager(state, 'next');
            return;
        }
        if (!hasMore(entry)) return;
        state.loadingMore = true;
        state.moreError = '';
        render(state, entry, imageId, key);
        try {
            // Fetch only when the next visible page needs more unique people.
            while (target * state.pageSize >= peopleFor(entry).length && hasMore(entry)) {
                if (!await loadNextBatch(entry, imageId)) {
                    state.moreError = 'Could not load more reactors. Try the next arrow again.';
                    break;
                }
            }
            if (target * state.pageSize < peopleFor(entry).length) state.page = target;
        } finally {
            state.loadingMore = false;
            if (state.key === key) {
                render(state, entry, imageId, key);
                focusPager(state, 'next');
            }
        }
    }

    function render(state, entry, imageId, key) {
        const { panel } = state;
        panel.replaceChildren();
        const people = peopleFor(entry);
        const more = hasMore(entry);
        const pageCount = Math.max(1, Math.ceil(people.length / state.pageSize));
        state.page = Math.min(state.page, pageCount - 1);

        if (people.length) {
            const heading = document.createElement('div');
            heading.className = 'civ-reactors-heading';
            const total = document.createElement('span');
            total.className = 'civ-reactors-total';
            const partial = more || entry.errors.length > 0;
            total.textContent = `${people.length}${partial ? '+' : ''} reactors`;
            const followers = people.filter(person => person.follows).length;
            const nonfollowers = people.length - followers;
            const summary = document.createElement('span');
            summary.className = 'civ-reactors-summary';
            summary.textContent = `⭐ ${followers} follower${followers === 1 ? '' : 's'} · ${nonfollowers} nonfollower${nonfollowers === 1 ? '' : 's'}`;
            if (partial) heading.title = 'Counts are for loaded reactors; more may be available.';
            heading.append(total, summary);
            panel.append(heading);
            const list = document.createElement('div');
            list.className = 'civ-reactors-list';
            const visible = people.slice(state.page * state.pageSize, (state.page + 1) * state.pageSize);
            for (const person of visible) {
                const row = document.createElement('div');
                row.className = 'civ-reactors-user';
                const status = document.createElement('span');
                status.className = 'civ-reactors-status';
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
                    status.append(marker);
                }
                row.append(status);

                const name = document.createElement(person.name && !person.deleted ? 'a' : 'span');
                name.className = 'civ-reactors-name';
                if (person.name && !person.deleted) {
                    name.href = `https://civitai.red/user/${encodeURIComponent(person.name)}/`;
                }
                name.textContent = person.deleted ? 'Deleted account'
                    : person.name || `User #${person.userId || '?'}`;
                name.title = [...person.reactions].map(([reaction, date]) =>
                    `${REACTIONS[reaction]} ${reaction}: ${reactionTime(date)}`).join('\n');
                row.append(name);

                const emojis = document.createElement('span');
                emojis.className = 'civ-reactors-emojis';
                for (const reaction of Object.keys(REACTIONS)) {
                    if (!person.reactions.has(reaction)) continue;
                    const emoji = document.createElement('span');
                    emoji.textContent = REACTIONS[reaction];
                    emoji.title = `${reaction}: ${reactionTime(person.reactions.get(reaction))}`;
                    emoji.setAttribute('aria-label', reaction);
                    emojis.append(emoji);
                }
                row.append(emojis);
                list.append(row);
            }
            panel.append(list);
        } else if (!entry.errors.length) {
            note(panel, 'No reactors found.');
        }
        if (entry.errors.length) note(panel, `Could not load: ${entry.errors.join(', ')}.`);
        if (state.moreError) note(panel, state.moreError);

        if (pageCount > 1 || more) {
            const pager = document.createElement('div');
            pager.className = 'civ-reactors-pagination';
            const previous = document.createElement('button');
            previous.type = 'button';
            previous.textContent = '←';
            previous.title = 'Previous page';
            previous.setAttribute('aria-label', 'Previous page');
            previous.dataset.pagePrev = '';
            previous.disabled = state.page === 0 || state.loadingMore;
            previous.addEventListener('click', () => {
                state.page--;
                render(state, entry, imageId, key);
                focusPager(state, 'prev');
            });
            const number = document.createElement('span');
            number.textContent = `Page ${state.page + 1} / ${pageCount}${more ? '+' : ''}`;
            const next = document.createElement('button');
            next.type = 'button';
            next.textContent = '→';
            next.title = 'Next page';
            next.setAttribute('aria-label', 'Next page');
            next.dataset.pageNext = '';
            next.disabled = state.loadingMore || (state.page + 1 >= pageCount && !more);
            next.addEventListener('click', () => nextPage(state, entry, imageId, key));
            pager.append(previous, number, next);
            panel.append(pager);
        }
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
            const previousPageSize = state.pageSize;
            positionPanel(state);
            state.panel.hidden = false;
            const key = `${user.id}:${imageId}`;
            const cached = reactionCache.get(key);
            if (state.key === key && (state.status === 'loading'
                || (state.status === 'ready' && cached && Date.now() - cached.updated < CACHE_MS))) {
                if (state.status === 'ready' && previousPageSize !== state.pageSize) {
                    state.page = 0;
                    render(state, cached, imageId, key);
                }
                return;
            }
            state.key = key;
            state.page = 0;
            state.moreError = '';
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
