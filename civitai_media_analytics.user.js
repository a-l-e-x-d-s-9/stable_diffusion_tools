// ==UserScript==
// @name         Civitai Media Analytics Overlay
// @namespace    https://civitai.com/
// @version      1.3.0
// @description  Hover a bottom-center button to toggle three stacked daily analytics graphs on images and videos.
// @match        https://civitai.com/*
// @match        https://civitai.red/*
// @match        https://civitai.green/*
// @run-at       document-idle
// @noframes
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addValueChangeListener
// @connect      creator-studio.civitai.com
// ==/UserScript==

(() => {
    'use strict';

    const STUDIO = 'https://creator-studio.civitai.com';
    const HOST = 'civ-media-analytics';
    const CACHE_MS = 120_000;
    const CACHE_LIMIT = 100;
    const MONTH_KEY = 'civitai-media-analytics-month';
    const METRICS = [
        { key: 'series', label: 'Views over time', color: '#60a5fa' },
        { key: 'reactionSeries', label: 'Reactions over time', color: '#fb7185' },
        { key: 'impressionSeries', label: 'Feed impressions over time', color: '#fbbf24' },
    ];
    const states = new Map();
    const parentPositions = new WeakMap();
    const cache = new Map();
    let scheduled = false;
    let lastURL = location.href;
    let selectedMonth = savedMonth();

    function thisMonth() {
        const now = new Date();
        return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    }

    function validMonth(value) {
        return typeof value === 'string' && /^(?!0000)\d{4}-(?:0[1-9]|1[0-2])$/.test(value);
    }

    function savedMonth() {
        try {
            const saved = GM_getValue(MONTH_KEY, null);
            if (validMonth(saved)) return saved;
        } catch (error) { console.warn('Civitai Media Analytics: could not read the saved month.', error); }
        return thisMonth();
    }

    function selectMonth(month, persist = true) {
        if (!validMonth(month) || month === selectedMonth) return;
        selectedMonth = month;
        if (persist) {
            try { GM_setValue(MONTH_KEY, month); }
            catch (error) { console.warn('Civitai Media Analytics: could not save the selected month.', error); }
        }
        for (const state of states.values()) {
            state.month = month;
            state.ui.querySelector('.month').value = month;
            state.ui.querySelector('.studio').href = studioURL(state.id, month);
            // Invalidate pending requests even for closed panels. Fetch only open panels.
            state.token++;
            state.data = null;
            state.ui.querySelector('.graphs').replaceChildren();
            state.ui.querySelector('.status').textContent = '';
            if (state.open) void showData(state);
        }
    }

    function mediaId(href) {
        try {
            const url = new URL(href, location.href);
            if (!/^civitai\.(com|red|green)$/i.test(url.hostname)) return null;
            return url.pathname.match(/^\/(?:images|videos)\/(\d+)\/?$/)?.[1]
                || (/^\d+$/.test(url.searchParams.get('imageId') || '') ? url.searchParams.get('imageId') : null);
        } catch { return null; }
    }

    function studioURL(id, month) {
        const url = new URL(`/analytics/content/image/${id}`, STUDIO);
        url.searchParams.set('month', month);
        return url.href;
    }

    function requestHTML(url) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'GET', url, timeout: 20_000, anonymous: false, withCredentials: true,
                headers: { Accept: 'text/html' },
                onload(response) {
                    if (response.status === 401 || response.status === 403) {
                        reject(new Error('Sign in to Creator Studio. Analytics may be limited to your own media.'));
                    } else if (response.status === 404) {
                        reject(new Error('Creator Studio has no accessible analytics for this media.'));
                    } else if (response.status < 200 || response.status >= 300) {
                        reject(new Error(`Creator Studio returned HTTP ${response.status}. Try again shortly.`));
                    } else resolve(response.responseText);
                },
                onerror() { reject(new Error('Could not reach Creator Studio. Check your connection and userscript permissions.')); },
                ontimeout() { reject(new Error('Creator Studio timed out. Try again.')); },
            });
        });
    }

    // Saved Studio pages contain Svelte hydration data as a JavaScript literal.
    // Read only literal values; never execute scripts from a downloaded page.
    function readLiteral(source, start) {
        let i = start;
        const space = () => { while (/\s/.test(source[i] || '') && i < source.length) i++; };
        function value(depth = 0) {
            if (depth > 20) throw new Error('Analytics data is too deeply nested.');
            space();
            const c = source[i];
            if (c === '"') {
                const begin = i++;
                while (i < source.length) {
                    if (source[i] === '\\') { i += 2; continue; }
                    if (source[i++] === '"') return JSON.parse(source.slice(begin, i));
                }
                throw new Error('Unterminated analytics string.');
            }
            if (c === '{' || c === '[') {
                const object = c === '{', result = object ? Object.create(null) : [];
                const close = object ? '}' : ']';
                i++;
                space();
                while (source[i] !== close) {
                    if (i >= source.length) throw new Error('Incomplete analytics data.');
                    let key;
                    if (object) {
                        if (source[i] === '"') key = value(depth + 1);
                        else {
                            const match = source.slice(i).match(/^[A-Za-z_$][\w$]*/);
                            if (!match) throw new Error('Invalid analytics key.');
                            key = match[0]; i += key.length;
                        }
                        space();
                        if (source[i++] !== ':') throw new Error('Invalid analytics object.');
                    }
                    const item = value(depth + 1);
                    if (object) result[key] = item; else result.push(item);
                    space();
                    if (source[i] === close) break;
                    if (source[i++] !== ',') throw new Error('Invalid analytics separator.');
                    space();
                }
                i++;
                return result;
            }
            const token = source.slice(i).match(/^(?:-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true\b|false\b|null\b|undefined\b)/)?.[0];
            if (!token) throw new Error('Unsupported analytics value.');
            i += token.length;
            return token === 'undefined' ? null : JSON.parse(token);
        }
        return value();
    }

    function parseAnalytics(html, id) {
        const doc = new DOMParser().parseFromString(html, 'text/html');
        for (const script of doc.querySelectorAll('script:not([src])')) {
            const source = script.textContent;
            const pattern = /\bimage\s*:\s*(\{\s*(?:"imageId"|imageId)\s*:)/g;
            for (const match of source.matchAll(pattern)) {
                const image = readLiteral(source, match.index + match[0].indexOf('{'));
                if (String(image.imageId) !== id) continue;
                const series = {};
                for (const metric of METRICS) {
                    const points = image[metric.key];
                    // Missing fields are unavailable, never a fabricated flat zero chart.
                    series[metric.key] = Array.isArray(points) ? points.map(point => {
                        if (!/^\d{4}-\d{2}-\d{2}$/.test(point?.date) || typeof point.value !== 'number'
                            || !Number.isFinite(point.value) || point.value < 0) {
                            throw new Error('Creator Studio returned an invalid daily data point.');
                        }
                        return { date: point.date, value: point.value };
                    }).sort((a, b) => a.date.localeCompare(b.date)) : null;
                }
                return series;
            }
        }
        throw new Error('Analytics unavailable. Open Creator Studio to sign in and check access to this media.');
    }

    function loadAnalytics(id, month, refresh = false) {
        const key = `${id}:${month}`;
        const found = cache.get(key);
        if (found?.promise || (!refresh && found && Date.now() - found.time < CACHE_MS)) {
            return found.promise || Promise.resolve(found.data);
        }
        const entry = { time: 0, data: null, promise: null };
        entry.promise = requestHTML(studioURL(id, month)).then(html => {
            entry.data = parseAnalytics(html, id);
            entry.time = Date.now(); entry.promise = null;
            return entry.data;
        }).catch(error => { cache.delete(key); throw error; });
        cache.delete(key);
        cache.set(key, entry);
        if (cache.size > CACHE_LIMIT) {
            const oldest = [...cache].find(([, item]) => !item.promise);
            if (oldest) cache.delete(oldest[0]);
        }
        return entry.promise;
    }

    function svgNode(name, attrs = {}, text = '') {
        const node = document.createElementNS('http://www.w3.org/2000/svg', name);
        for (const [key, val] of Object.entries(attrs)) node.setAttribute(key, String(val));
        if (text) node.textContent = text;
        return node;
    }

    function drawCharts(state) {
        const graphs = state.ui.querySelector('.graphs');
        graphs.replaceChildren();
        const dates = [...new Set(METRICS.flatMap(spec => (state.data?.[spec.key] || []).map(point => point.date)))].sort();
        const time = date => Date.parse(`${date}T00:00:00Z`);
        const first = time(dates[0]), last = time(dates.at(-1));
        const dayX = date => last > first ? 43 + (time(date) - first) / (last - first) * 290 : 188;
        const charts = [];
        let hoveredDate = null;
        const highlight = date => {
            if (hoveredDate === date) return;
            hoveredDate = date;
            for (const chart of charts) {
                const point = chart.points.get(date);
                chart.readout.hidden = !date;
                chart.readout.textContent = date ? `${date} · ${point ? point.value.toLocaleString() : 'No data'}` : '';
                if (!chart.svg) continue;
                chart.line.setAttribute('visibility', date ? 'visible' : 'hidden');
                chart.dot.setAttribute('visibility', date && point ? 'visible' : 'hidden');
                if (date) {
                    const x = dayX(date);
                    chart.line.setAttribute('x1', x);
                    chart.line.setAttribute('x2', x);
                    if (point) {
                        chart.dot.setAttribute('cx', x);
                        chart.dot.setAttribute('cy', chart.y(point.value));
                    }
                }
            }
        };
        for (const spec of METRICS) {
            const graph = document.createElement('section');
            graph.className = 'graph';
            graph.dataset.metric = spec.key;
            graph.setAttribute('aria-label', spec.label);
            graph.innerHTML = '<div class="heading"><span class="metric"></span><span class="total"></span></div><div class="chart"><output class="readout" hidden></output></div>';
            graph.querySelector('.metric').textContent = spec.label;
            graphs.append(graph);
            const chart = drawChart(graph, spec, state.data, dates, dayX);
            charts.push(chart);
            if (!chart.svg) continue;
            const move = event => {
                const matrix = chart.svg.getScreenCTM();
                if (!matrix || !dates.length) return;
                // SVG's matrix accounts for letterboxing, resized charts, and scaled carousels.
                const pointer = chart.svg.createSVGPoint();
                pointer.x = event.clientX; pointer.y = event.clientY;
                const x = pointer.matrixTransform(matrix.inverse()).x;
                const fraction = Math.max(0, Math.min(1, (x - 43) / 290));
                const target = first + fraction * (last - first);
                const date = dates.reduce((nearest, candidate) => Math.abs(time(candidate) - target)
                    < Math.abs(time(nearest) - target) ? candidate : nearest, dates[0]);
                highlight(date);
            };
            chart.svg.addEventListener('pointerenter', move);
            chart.svg.addEventListener('pointermove', move);
            chart.svg.addEventListener('pointerdown', move);
        }
        graphs.onpointerleave = () => highlight(null);
    }

    function drawChart(graph, spec, data, dates, dayX) {
        const chart = graph.querySelector('.chart');
        const points = data?.[spec.key];
        const result = { readout: graph.querySelector('.readout'), points: new Map((points || []).map(point => [point.date, point])) };
        if (!points?.length) {
            chart.append(document.createTextNode(points ? 'No daily data for this month.' : 'This metric is unavailable for this media.'));
            return result;
        }
        const total = points.reduce((sum, point) => sum + point.value, 0);
        graph.querySelector('.total').textContent = `${total.toLocaleString()} this month`;
        const svg = svgNode('svg', { viewBox: '0 0 360 100', preserveAspectRatio: 'none', role: 'img', 'aria-label': `${spec.label}: ${total.toLocaleString()} this month` });
        const max = Math.max(1, ...points.map(point => point.value));
        const y = count => 75 - count / max * 65;
        for (const fraction of [0, 0.5, 1]) {
            const level = y(max * fraction);
            svg.append(svgNode('line', { x1: 43, y1: level, x2: 333, y2: level, stroke: '#ffffff25' }));
            svg.append(svgNode('text', { x: 38, y: level + 4, 'text-anchor': 'end', fill: '#cbd5e1', 'font-size': 10 },
                Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(max * fraction)));
        }
        svg.append(svgNode('polyline', {
            points: points.map(point => `${dayX(point.date)},${y(point.value)}`).join(' '),
            fill: 'none', stroke: spec.color, 'stroke-width': 2, 'stroke-linejoin': 'round',
        }));
        for (const point of points) {
            const dot = svgNode('circle', { class: 'data-point', cx: dayX(point.date), cy: y(point.value), r: 3, fill: spec.color });
            dot.append(svgNode('title', {}, `${point.date}: ${point.value.toLocaleString()}`));
            svg.append(dot);
        }
        const dateLabel = date => new Date(`${date}T00:00:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
        svg.append(svgNode('text', { x: 43, y: 94, fill: '#cbd5e1', 'font-size': 10 }, dateLabel(dates[0])));
        svg.append(svgNode('text', { x: 333, y: 94, fill: '#cbd5e1', 'font-size': 10, 'text-anchor': 'end' }, dateLabel(dates.at(-1))));
        const line = svgNode('line', { class: 'focus-line', x1: 43, x2: 43, y1: 8, y2: 78,
            stroke: '#f8fafc', 'stroke-width': 1, 'stroke-dasharray': '3 3', visibility: 'hidden', 'pointer-events': 'none' });
        const dot = svgNode('circle', { class: 'focus-dot', r: 5, fill: spec.color, stroke: '#fff',
            'stroke-width': 1.5, visibility: 'hidden', 'pointer-events': 'none' });
        svg.append(line, dot);
        chart.append(svg);
        return Object.assign(result, { svg, y, line, dot });
    }

    async function showData(state, refresh = false) {
        const token = ++state.token;
        const { ui, id, month } = state;
        ui.querySelector('.studio').href = studioURL(id, month);
        ui.querySelector('.status').textContent = 'Loading analytics…';
        ui.querySelector('.graphs').replaceChildren();
        state.data = null;
        try {
            const data = await loadAnalytics(id, month, refresh);
            if (state.token !== token || !state.host.isConnected) return;
            state.data = data;
            ui.querySelector('.status').textContent = '';
            drawCharts(state);
        } catch (error) {
            if (state.token === token && state.host.isConnected) ui.querySelector('.status').textContent = error.message;
        }
    }

    function setOpen(state, open) {
        const currentId = identify(state.media) || mediaId(location.href);
        if (currentId && currentId !== state.id) {
            state.id = currentId;
            state.token++;
            state.data = null;
        }
        state.open = open;
        state.ui.querySelector('.panel').hidden = !open;
        state.ui.querySelector('.toggle').setAttribute('aria-expanded', String(open));
        state.ui.querySelector('.toggle').title = open ? 'Leave and hover here again to hide analytics' : 'Hover to show analytics';
        if (open) void showData(state);
    }

    function createState(media, id, parent) {
        const host = document.createElement('div');
        host.className = HOST;
        host.style.cssText = 'position:absolute;z-index:110;pointer-events:none;display:block;';
        let positioning = parentPositions.get(parent);
        if (!positioning) {
            positioning = { count: 0, previous: parent.style.position,
                changed: getComputedStyle(parent).position === 'static' };
            if (positioning.changed) parent.style.position = 'relative';
            parentPositions.set(parent, positioning);
        }
        positioning.count++;
        const ui = host.attachShadow({ mode: 'open' });
        ui.innerHTML = `
            <style>
                :host { color-scheme: dark; font: 12px/1.4 system-ui,sans-serif; color:#f8fafc; }
                * { box-sizing:border-box; }
                [hidden] { display:none !important; }
                button,input,a { pointer-events:auto; font:inherit; }
                button { border:1px solid #64748b; border-radius:6px; color:#fff; background:#172033; cursor:pointer; }
                button:focus-visible,a:focus-visible,input:focus-visible { outline:2px solid #93c5fd; outline-offset:2px; }
                .toggle { position:absolute; left:50%; transform:translateX(-50%); bottom:8px; width:30px; height:30px; padding:5px;
                    background:#101827e8; box-shadow:0 2px 8px #0008; z-index:2; }
                .toggle[aria-expanded="true"] { color:#93c5fd; border-color:#93c5fd; }
                .toggle svg { width:18px; height:18px; }
                .panel { position:absolute; left:6px; right:6px; bottom:44px; height:calc(100% - 50px);
                    display:flex; flex-direction:column; gap:8px;
                    overflow:auto; pointer-events:auto; padding:9px; background:#0f172aee;
                    border:1px solid #64748b; border-radius:8px; box-shadow:0 4px 18px #0009; }
                .graphs { display:flex; flex-direction:column; flex:1; min-height:232px; gap:8px; }
                .graphs:empty { display:none; }
                .graph { display:flex; flex-direction:column; flex:1; min-height:0; }
                .graph + .graph { border-top:1px solid #ffffff25; padding-top:5px; }
                .heading { display:flex; flex-wrap:wrap; align-items:baseline; justify-content:space-between; gap:2px 6px; }
                .metric { font-weight:700; font-size:11px; }
                .total { color:#e2e8f0; font-size:10px; }
                .chart { position:relative; flex:1; min-height:0; }
                .chart svg { display:block; width:100%; height:100%; max-height:180px; }
                .readout { position:absolute; top:0; right:0; z-index:1; pointer-events:none;
                    padding:1px 4px; border-radius:3px; background:#020617ed; color:#fff;
                    font-size:11px; line-height:16px; font-variant-numeric:tabular-nums; white-space:nowrap; }
                .chart:empty,.status:empty,.total:empty { display:none; }
                .status { color:#fcd34d; padding:9px 0; overflow-wrap:anywhere; }
                .footer { display:flex; flex-shrink:0; flex-wrap:wrap; align-items:center; gap:6px; color:#cbd5e1; font-size:11px; }
                input { min-width:0; width:118px; border:1px solid #64748b; border-radius:4px; background:#172033; color:white; padding:2px; }
                .studio { color:#93c5fd; }
                .refresh { padding:2px 5px; }
            </style>
            <button class="toggle" type="button" aria-label="Toggle media analytics" aria-expanded="false" aria-controls="analytics-panel" title="Hover to show analytics">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M3 3v18h18M7 15l4-6 4 3 5-7"/></svg>
            </button>
            <section class="panel" id="analytics-panel" aria-label="Media analytics" hidden>
                <div class="status" role="status" aria-live="polite"></div><div class="graphs"></div>
                <div class="footer"><input class="month" type="month" aria-label="Analytics month" title="Month shared across all images, videos, and tabs"><button class="refresh" type="button" title="Reload analytics" aria-label="Refresh analytics">↻</button><a class="studio" target="_blank" rel="noopener noreferrer">Studio ↗</a></div>
            </section>`;
        const state = { media, id, parent, host, ui,
            month: selectedMonth, open: false, token: 0, data: null, enteredByMouse: false };
        ui.querySelector('.month').value = state.month;
        ui.querySelector('.studio').href = studioURL(id, state.month);
        const toggle = ui.querySelector('.toggle');
        toggle.addEventListener('pointerenter', event => {
            if (event.pointerType !== 'mouse' && event.pointerType !== 'pen') return;
            state.enteredByMouse = true;
            setOpen(state, !state.open);
        });
        toggle.addEventListener('pointerleave', () => { state.enteredByMouse = false; });
        toggle.addEventListener('click', event => {
            // A mouse click immediately after hover must not undo the hover toggle.
            if (event.detail === 0 || !state.enteredByMouse) setOpen(state, !state.open);
        });
        ui.querySelector('.month').addEventListener('change', event => {
            if (!validMonth(event.target.value)) {
                event.target.value = selectedMonth;
                return;
            }
            selectMonth(event.target.value);
        });
        ui.querySelector('.refresh').addEventListener('click', () => void showData(state, true));
        host.addEventListener('keydown', event => {
            if (event.key === 'Escape') { setOpen(state, false); toggle.focus(); }
            event.stopPropagation();
        });
        for (const name of ['click', 'dblclick', 'pointerdown', 'pointerup', 'mousedown', 'mouseup', 'touchstart', 'touchend']) {
            host.addEventListener(name, event => {
                event.stopPropagation();
            });
        }
        parent.append(host);
        states.set(media, state);
        resizeObserver.observe(media);
        return state;
    }

    function removeState(state) {
        state.token++;
        state.host.remove();
        resizeObserver.unobserve(state.media);
        states.delete(state.media);
        const positioning = parentPositions.get(state.parent);
        if (positioning && --positioning.count === 0) {
            if (positioning.changed && state.parent.style.position === 'relative') {
                state.parent.style.position = positioning.previous;
            }
            parentPositions.delete(state.parent);
        }
    }

    function identify(media) {
        const link = media.closest('a[href]');
        if (link) return mediaId(link.href);
        // Explicit IDs are useful on unlinked post items and future layouts.
        const marked = media.closest('[data-image-id]');
        if (/^\d+$/.test(marked?.getAttribute('data-image-id') || '')) return marked.getAttribute('data-image-id');
        return null;
    }

    function isContent(media) {
        if (media.closest(`.${HOST}, [class*="Avatar"], [class*="avatar"]`)) return false;
        if (!identify(media) && media.closest('[class*="Comment"], [class*="comment"]')) return false;
        const source = media.currentSrc || media.getAttribute('src') || media.getAttribute('poster')
            || media.querySelector('source')?.src || '';
        try { return /^(?:image|video)\.civitai\.(com|red|green)$/i.test(new URL(source, location.href).hostname); }
        catch { return false; }
    }

    function update() {
        scheduled = false;
        const mediaList = [...document.querySelectorAll('img,video')].filter(isContent);
        const rectangles = new Map(mediaList.map(media => [media, media.getBoundingClientRect()]));
        const pageId = mediaId(location.href);
        const dialog = [...document.querySelectorAll('[role="dialog"],dialog[open]')].filter(item => item.getClientRects().length).at(-1);
        // The URL identifies only the active unlinked viewer image. Never apply
        // it to avatars, background cards, or every mounted carousel slide.
        const viewer = pageId ? mediaList.filter(media => !identify(media) && !media.closest('a[href]')
            && (!dialog || dialog.contains(media))).filter(media => {
            const rect = rectangles.get(media);
            return rect.width >= 120 && rect.height >= 120 && rect.right > 0 && rect.left < innerWidth
                && rect.bottom > 0 && rect.top < innerHeight;
        }).sort((a, b) => {
            const area = media => {
                const r = rectangles.get(media);
                return (Math.min(innerWidth, r.right) - Math.max(0, r.left))
                    * (Math.min(innerHeight, r.bottom) - Math.max(0, r.top));
            };
            return area(b) - area(a);
        })[0] : null;
        const keep = new Set();
        for (const media of mediaList) {
            const id = identify(media) || (media === viewer ? pageId : null);
            const rect = rectangles.get(media);
            if (!id || rect.width < 60 || rect.height < 60) continue;
            const link = media.closest('a[href]');
            const parent = link?.parentElement || media.parentElement;
            if (!parent) continue;
            let state = states.get(media);
            if (state && (state.parent !== parent || !state.host.isConnected)) { removeState(state); state = null; }
            if (!state) state = createState(media, id, parent);
            if (state.id !== id) {
                state.id = id; state.data = null; state.token++;
                setOpen(state, false);
            }
            // Account for scaled carousels and borders without changing the media.
            const bounds = parent.getBoundingClientRect();
            const sx = parent.offsetWidth ? bounds.width / parent.offsetWidth : 1;
            const sy = parent.offsetHeight ? bounds.height / parent.offsetHeight : 1;
            const css = `left:${(rect.left - bounds.left) / (sx || 1) - parent.clientLeft + parent.scrollLeft}px;top:${(rect.top - bounds.top) / (sy || 1) - parent.clientTop + parent.scrollTop}px;width:${rect.width / (sx || 1)}px;height:${rect.height / (sy || 1)}px;`;
            if (state.geometry !== css) {
                state.host.style.cssText = 'position:absolute;z-index:110;pointer-events:none;display:block;' + css;
                state.geometry = css;
            }
            keep.add(media);
        }
        for (const [media, state] of states) if (!keep.has(media)) removeState(state);
    }

    function schedule() {
        if (!scheduled) { scheduled = true; requestAnimationFrame(update); }
    }
    const resizeObserver = new ResizeObserver(schedule);
    new MutationObserver(records => {
        if (records.some(record => !record.target.closest?.(`.${HOST}`))) schedule();
    }).observe(document.body, { subtree: true, childList: true, attributes: true,
        attributeFilter: ['src', 'srcset', 'poster', 'href', 'data-image-id', 'class', 'style'] });
    window.addEventListener('resize', schedule);
    window.addEventListener('scroll', schedule, { passive: true, capture: true });
    document.addEventListener('load', schedule, true);
    document.addEventListener('loadedmetadata', schedule, true);
    window.addEventListener('popstate', schedule);
    // React navigation can change the URL without a DOM mutation or popstate.
    setInterval(() => {
        if (lastURL !== location.href) { lastURL = location.href; schedule(); }
    }, 350);
    try {
        GM_addValueChangeListener(MONTH_KEY, (_name, _old, month, remote) => {
            if (remote) selectMonth(month, false);
        });
    } catch (error) { console.warn('Civitai Media Analytics: live month sync between tabs is unavailable.', error); }
    schedule();
})();
