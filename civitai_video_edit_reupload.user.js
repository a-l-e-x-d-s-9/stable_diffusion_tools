// ==UserScript==
// @name         Civitai Video Rating Re-upload Helper
// @namespace    https://civitai.com/
// @version      0.2.2
// @icon         https://civitai.com/favicon.ico
// @description  Re-upload Civitai post videos missing scanner rating while preserving metadata. Safe no-delete version with reload-safe auto mode, robust rating detection, synced numbering, virtual index correction, and resilient chunked media downloading.
// @match        https://civitai.com/posts/*/edit*
// @match        https://www.civitai.com/posts/*/edit*
// @match        https://civitai.green/posts/*/edit*
// @match        https://www.civitai.green/posts/*/edit*
// @match        https://civitai.red/posts/*/edit*
// @match        https://www.civitai.red/posts/*/edit*
// @run-at       document-start
// @grant        GM_addStyle
// @grant        GM_xmlhttpRequest
// @connect      image.civitai.com
// @connect      *.civitai.com
// @connect      *
// @connect      civitai.com
// @connect      civitai.red
// @connect      civitai.green
// ==/UserScript==

(() => {
    'use strict';

    const SCRIPT = 'CVR';
    const API_ORIGIN = location.origin;
    const INIT_UPLOAD_ENDPOINT = `${API_ORIGIN}/api/v1/image-upload/multipart`;
    const COMPLETE_UPLOAD_ENDPOINT = `${API_ORIGIN}/api/upload/complete`;
    const POST_ADD_IMAGE_ENDPOINT = `${API_ORIGIN}/api/trpc/post.addImage`;
    const AUTO_DELAY_MS = 2500;
    const AUTO_RELOAD_DELAY_MS = 2500;
    const AUTO_STATE_PREFIX = 'cvr_auto_reload_v1_';

    const state = {
        captured: [],
        media: [],
        panel: null,
        body: null,
        status: null,
        showOnlyMissing: true,
        autoRunning: false,
        handled: {},
        deleteAfterUpload: false,
        highlightedRoot: null,
        highlightedRowKey: null,
        virtualInsertions: [],
    };

    function log(...args) {
        console.log(`[${SCRIPT}]`, ...args);
    }

    function warn(...args) {
        console.warn(`[${SCRIPT}]`, ...args);
    }

    function postIdFromUrl() {
        const m = location.pathname.match(/^\/posts\/(\d+)\/edit/);
        return m ? Number(m[1]) : null;
    }

    function isPlainObject(v) {
        return v && typeof v === 'object' && !Array.isArray(v);
    }

    function safeJsonParse(text) {
        try { return JSON.parse(text); } catch { return null; }
    }

    function objectLooksLikeVideoMedia(o, postId) {
        if (!isPlainObject(o)) return false;
        const mime = String(o.mimeType || o.mime || '').toLowerCase();
        const type = String(o.type || o.mediaType || '').toLowerCase();
        const name = String(o.name || o.filename || o.fileName || '').toLowerCase();
        const url = String(o.url || o.imageUrl || o.videoUrl || '').toLowerCase();
        const hasVideoMarker = type === 'video' || mime.startsWith('video/') || /\.(mp4|webm|mov|mkv)(?:\?|$)/i.test(name) || /\.(mp4|webm|mov|mkv)(?:\?|$)/i.test(url);
        if (!hasVideoMarker) return false;
        if (postId && o.postId != null && Number(o.postId) !== Number(postId)) return false;
        return Boolean(o.id || o.url || o.name || o.metadata || o.meta);
    }

    function normalizeMedia(o, fallbackIndex, postId) {
        const meta = isPlainObject(o.meta) ? o.meta : (isPlainObject(o.metadata?.meta) ? o.metadata.meta : null);
        const metadata = isPlainObject(o.metadata) ? o.metadata : {};
        const width = numberOrNull(o.width ?? metadata.width ?? meta?.Size?.width);
        const height = numberOrNull(o.height ?? metadata.height ?? meta?.Size?.height);
        const index = numberOrNull(o.index ?? o.position ?? fallbackIndex) ?? fallbackIndex;
        const modelVersionId = numberOrNull(o.modelVersionId ?? o.modelVersion?.id ?? o.modelVersion?.modelVersionId);
        const id = o.id ?? o.imageId ?? o.postImageId ?? null;
        const name = String(o.name || o.filename || o.fileName || `video_${index}`);
        const url = String(o.url || o.imageUrl || o.videoUrl || '');
        const mimeType = String(o.mimeType || o.mime || guessMime(name) || 'video/mp4');
        const ratingText = String(o.browsingLevel?.label || o.browsingLevel || o.nsfwLevel || o.rating || o.ingestionStatus || '').trim();

        return {
            raw: o,
            sourceCandidates: [url].filter(Boolean).map(src => ({ src, type: mimeType })),
            id,
            name,
            url,
            postId: numberOrNull(o.postId) ?? postId,
            baseIndex: index,
            index,
            serverIndex: index,
            displayNumber: index + 1,
            mimeType,
            width,
            height,
            modelVersionId,
            modelId: numberOrNull(o.modelId ?? o.model?.id),
            meta,
            metadata,
            ratingText,
            missingRating: !hasRatingObject(o),
        };
    }

    function hasRatingObject(o) {
        if (!isPlainObject(o)) return false;
        if (o.browsingLevel || o.nsfwLevel || o.rating) return true;
        const s = JSON.stringify({
            browsingLevel: o.browsingLevel,
            nsfwLevel: o.nsfwLevel,
            rating: o.rating,
            minor: o.minor,
        });
        return /PG-13|PG|R|X|XXX|browsingLevel|nsfw/i.test(s);
    }

    function numberOrNull(v) {
        if (v === null || v === undefined || v === '') return null;
        const n = Number(v);
        return Number.isFinite(n) ? n : null;
    }

    function guessMime(name) {
        const n = String(name || '').toLowerCase();
        if (n.endsWith('.webm')) return 'video/webm';
        if (n.endsWith('.mov')) return 'video/quicktime';
        if (n.endsWith('.mkv')) return 'video/x-matroska';
        if (n.endsWith('.mp4')) return 'video/mp4';
        return '';
    }


    function storageKey() {
        return `${SCRIPT}:handled:${location.origin}:post:${postIdFromUrl() || 'unknown'}`;
    }

    function loadHandledState() {
        try {
            const raw = localStorage.getItem(storageKey());
            state.handled = raw ? JSON.parse(raw) : {};
        } catch {
            state.handled = {};
        }
    }

    function saveHandledState() {
        try {
            localStorage.setItem(storageKey(), JSON.stringify(state.handled || {}));
        } catch (e) {
            warn('could not save handled state', e);
        }
    }

    function simpleHash(text) {
        let h = 2166136261;
        const s = String(text || '');
        for (let i = 0; i < s.length; i++) {
            h ^= s.charCodeAt(i);
            h = Math.imul(h, 16777619);
        }
        return (h >>> 0).toString(16).padStart(8, '0');
    }

    function mediaFingerprint(media) {
        const meta = media?.meta || {};
        const prompt = String(meta.prompt || media?.raw?.prompt || '').replace(/\s+/g, ' ').trim();
        const neg = String(meta.negativePrompt || '').replace(/\s+/g, ' ').trim();
        const seed = meta.seed ?? media?.raw?.seed ?? '';
        const steps = meta.steps ?? '';
        const cfg = meta.cfgScale ?? '';
        const sampler = meta.sampler ?? '';
        const size = `${media?.width || ''}x${media?.height || ''}`;
        const mv = media?.modelVersionId || '';
        return simpleHash([postIdFromUrl() || '', mv, seed, steps, cfg, sampler, size, prompt, neg].join('|'));
    }

    function mediaHandledKey(media) {
        // Use metadata fingerprint instead of only media UUID. Replacement uploads get a new UUID,
        // but they keep the same prompt/seed/settings, so this prevents re-upload loops while the site scans.
        return mediaFingerprint(media);
    }

    function isHandled(media) {
        const key = mediaHandledKey(media);
        return Boolean(key && state.handled && state.handled[key]);
    }

    function markHandled(media, extra = {}) {
        const key = mediaHandledKey(media);
        if (!key) return;
        state.handled[key] = {
            at: new Date().toISOString(),
            originalId: media.id || uuidFromUrl(media.url || '') || null,
            originalUrl: media.url || null,
            promptHash: simpleHash(media?.meta?.prompt || ''),
            ...extra,
        };
        saveHandledState();
    }

    function clearHandledFor(media) {
        const key = mediaHandledKey(media);
        if (key && state.handled && state.handled[key]) {
            delete state.handled[key];
            saveHandledState();
        }
    }

    function clearAllHandledState() {
        state.handled = {};
        saveHandledState();
        renderList();
        setStatus('Handled-state cache cleared for this post.');
    }


    function autoStateKey() {
        return `${AUTO_STATE_PREFIX}${postIdFromUrl() || 'unknown'}`;
    }

    function loadAutoState() {
        try {
            return JSON.parse(localStorage.getItem(autoStateKey()) || '{}') || {};
        } catch {
            return {};
        }
    }

    function saveAutoState(v) {
        localStorage.setItem(autoStateKey(), JSON.stringify(v || {}));
    }

    function clearAutoState() {
        localStorage.removeItem(autoStateKey());
    }

    function startReloadSafeAuto() {
        saveAutoState({ active: true, startedAt: new Date().toISOString(), completed: 0 });
        autoReuploadNextWithReload().catch(e => {
            console.error(e);
            clearAutoState();
            state.autoRunning = false;
            setStatus(`Auto error: ${e.message || e}`, true);
        });
    }

    function stopReloadSafeAuto() {
        clearAutoState();
        state.autoRunning = false;
        setStatus('Auto mode stopped.');
    }

    function walkJson(root, visitor, maxNodes = 120000) {
        const stack = [root];
        const seen = new WeakSet();
        let count = 0;
        while (stack.length) {
            const node = stack.pop();
            if (!node || typeof node !== 'object') continue;
            if (seen.has(node)) continue;
            seen.add(node);
            if (++count > maxNodes) return;
            visitor(node);
            if (Array.isArray(node)) {
                for (let i = node.length - 1; i >= 0; i--) stack.push(node[i]);
            } else {
                for (const v of Object.values(node)) {
                    if (v && typeof v === 'object') stack.push(v);
                }
            }
        }
    }

    function captureJson(data, source) {
        if (!data || typeof data !== 'object') return;
        state.captured.push({ source, data, ts: Date.now() });
        if (state.captured.length > 80) state.captured.shift();
    }

    function installFetchCapture() {
        const originalFetch = window.fetch;
        if (!originalFetch || originalFetch.__cvrWrapped) return;
        const wrapped = async function(input, init) {
            const response = await originalFetch.apply(this, arguments);
            try {
                const url = typeof input === 'string' ? input : input?.url || '';
                if (/post|image|media|trpc|modelVersion/i.test(url)) {
                    const clone = response.clone();
                    const ct = clone.headers.get('content-type') || '';
                    if (ct.includes('application/json')) {
                        clone.json().then(j => captureJson(j, `fetch:${url}`)).catch(() => {});
                    } else {
                        clone.text().then(t => {
                            if (t && (t.includes('postImages') || t.includes('mimeType') || t.includes('modelVersionId'))) {
                                const j = safeJsonParse(t);
                                if (j) captureJson(j, `fetch-text:${url}`);
                            }
                        }).catch(() => {});
                    }
                }
            } catch (e) {
                warn('fetch capture failed', e);
            }
            return response;
        };
        wrapped.__cvrWrapped = true;
        window.fetch = wrapped;
    }

    function collectEmbeddedJson() {
        const out = [];
        if (window.__NEXT_DATA__) out.push({ source: '__NEXT_DATA__', data: window.__NEXT_DATA__ });
        for (const script of document.querySelectorAll('script[type="application/json"], script:not([src])')) {
            const text = script.textContent || '';
            if (!text || text.length < 50) continue;
            if (!/postImages|mimeType|modelVersionId|video|\.mp4|\.webm/i.test(text)) continue;
            const j = safeJsonParse(text.trim());
            if (j) out.push({ source: 'script-json', data: j });
        }
        for (const item of out) captureJson(item.data, item.source);
    }


    function filenameFromUrl(url, fallback) {
        try {
            const clean = String(url || '').split('?')[0];
            const name = clean.split('/').filter(Boolean).pop() || fallback || '';
            return decodeURIComponent(name) || fallback || 'video';
        } catch {
            return fallback || 'video';
        }
    }

    function uuidFromUrl(url) {
        const m = String(url || '').match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
        return m ? m[0] : null;
    }

    function allVideoSources(video) {
        const out = [];
        const seen = new Set();
        function add(src, type) {
            src = String(src || '').trim();
            if (!src || seen.has(src)) return;
            seen.add(src);
            out.push({ src, type: String(type || '') });
        }
        // Prefer explicit <source> entries over currentSrc. currentSrc may point at the
        // browser-selected source, while the alternate source can still work if one CDN
        // request fails. Prefer MP4 first because it is usually what Civitai accepts best.
        for (const source of video.querySelectorAll('source')) {
            add(source.src || source.getAttribute('src') || '', source.type || source.getAttribute('type') || '');
        }
        add(video.currentSrc || video.src || video.getAttribute('src') || '', video.getAttribute('type') || '');

        out.sort((a, b) => {
            const as = /mp4/i.test(a.type) || /\.mp4(?:\?|$)/i.test(a.src) ? 0 : (/webm/i.test(a.type) || /\.webm(?:\?|$)/i.test(a.src) ? 1 : 2);
            const bs = /mp4/i.test(b.type) || /\.mp4(?:\?|$)/i.test(b.src) ? 0 : (/webm/i.test(b.type) || /\.webm(?:\?|$)/i.test(b.src) ? 1 : 2);
            return as - bs;
        });
        return out;
    }

    function bestVideoSource(video) {
        return allVideoSources(video)[0] || { src: '', type: '' };
    }

    function countVideosInside(el) {
        try { return el ? el.querySelectorAll('video').length : 0; } catch { return 0; }
    }

    function classText(el) {
        return String(el?.className || '');
    }

    function exactRatingText(text) {
        const t = String(text || '').replace(/\s+/g, ' ').trim().toUpperCase();
        if (/^(PG-13|PG|R|X|XXX)$/.test(t)) return t;
        return '';
    }

    function isInsideVotableTag(el) {
        let n = el;
        for (let i = 0; n && i < 5; i++, n = n.parentElement) {
            const cls = classText(n);
            if (/VotableTag|tag-click:image/i.test(cls + ' ' + String(n.getAttribute?.('data-activity') || ''))) return true;
        }
        return false;
    }

    function ratingInfoFromRoot(root) {
        if (!root) return { hasRating: false, text: '' };
        const browsingBadges = [...root.querySelectorAll('[class*="BrowsingLevelBadge"]')]
            .filter(el => !state.panel?.contains(el));
        for (const badge of browsingBadges) {
            const txt = exactRatingText(badge.textContent || '');
            if (txt) return { hasRating: true, text: txt };
            const raw = (badge.textContent || '').replace(/\s+/g, ' ').trim();
            if (raw) return { hasRating: true, text: raw };
        }
        const badgeLabels = [...root.querySelectorAll('.mantine-Badge-root .mantine-Badge-label, .mantine-Badge-root')]
            .filter(el => !state.panel?.contains(el))
            .filter(el => !isInsideVotableTag(el));
        for (const el of badgeLabels) {
            const txt = exactRatingText(el.textContent || '');
            if (txt) return { hasRating: true, text: txt };
        }
        return { hasRating: false, text: '' };
    }

    function looksLikeOneMediaCard(el) {
        if (!el || countVideosInside(el) !== 1) return false;
        const txt = (el.innerText || '').replace(/\s+/g, ' ').trim();
        const html = el.outerHTML || '';
        const cls = classText(el);
        const hasPrompt = /\bPrompt\b/i.test(txt);
        const hasNeg = /\bNegative Prompt\b/i.test(txt);
        const hasMediaFields = /\b(Guidance|Steps|Sampler|Seed|Resources|Thumbnail)\b/i.test(txt);
        const hasTagArea = /VotableTag_mainBadge|data-activity="tag-click:image"|>\s*Tag\s*</i.test(html);
        const cardLike = /overflow-hidden|rounded-lg|@container|border-gray|dark:border-dark/i.test(cls + ' ' + html.slice(0, 500));
        return cardLike && (hasPrompt || hasNeg || hasMediaFields || hasTagArea);
    }

    function findVideoCardRoot(video) {
        // Important: do not climb into the whole post/media list. If the root contains
        // multiple videos, a rated neighbor can make an unrated video look rated.
        let fallback = video.parentElement || video;
        let best = null;
        let node = video.parentElement;
        for (let depth = 0; node && depth < 18; depth++, node = node.parentElement) {
            const videoCount = countVideosInside(node);
            if (videoCount > 1) break;
            if (looksLikeOneMediaCard(node)) best = node;
            fallback = node;
        }
        return best || fallback || video;
    }

    function textAfterHeading(root, label) {
        const wanted = String(label || '').toLowerCase();
        const headings = [...root.querySelectorAll('h1,h2,h3,h4,h5,h6')];
        const h = headings.find(x => (x.textContent || '').trim().toLowerCase() === wanted);
        if (!h) return '';
        const container = h.closest('div') || h.parentElement || root;

        // First try siblings after the heading container. This matches the current Civitai edit layout.
        const start = container.contains(h) && container !== h ? container : h;
        let sib = start.nextElementSibling;
        for (let i = 0; sib && i < 8; i++, sib = sib.nextElementSibling) {
            if (/^(H1|H2|H3|H4|H5|H6)$/i.test(sib.tagName)) break;
            const p = sib.matches?.('p') ? sib : sib.querySelector?.('p');
            const t = (p?.textContent || '').trim();
            if (t) return t;
        }

        // Then search inside the same section, excluding button text.
        let n = h.nextElementSibling;
        for (let i = 0; n && i < 10; i++, n = n.nextElementSibling) {
            if (/^(H1|H2|H3|H4|H5|H6)$/i.test(n.tagName)) break;
            const t = (n.textContent || '').trim();
            if (t && !/^(EDIT|HIDE PROMPT|SHOW PROMPT)$/i.test(t)) return t;
        }
        return '';
    }

    function labeledValue(root, label) {
        const wanted = String(label || '').toLowerCase();
        for (const row of root.querySelectorAll('div')) {
            const ps = [...row.querySelectorAll(':scope > p')];
            if (ps.length < 2) continue;
            const key = (ps[0].textContent || '').trim().toLowerCase();
            if (key === wanted) return (ps[1].textContent || '').trim();
        }
        return '';
    }

    function aspectSizeFromCard(root) {
        const el = root.querySelector('[style*="aspect-ratio"]');
        const style = el?.getAttribute('style') || '';
        const m = style.match(/aspect-ratio:\s*(\d+)\s*\/\s*(\d+)/i);
        return m ? { width: Number(m[1]), height: Number(m[2]) } : { width: null, height: null };
    }

    function modelVersionFromDom(root) {
        const links = [...root.querySelectorAll('a[href*="modelVersionId="]')];
        // Prefer LoRA/user-added resource if present, otherwise first modelVersionId.
        const preferred = links.find(a => /LoRA/i.test(a.parentElement?.innerText || a.innerText || '')) || links[0];
        if (!preferred) return null;
        try {
            const u = new URL(preferred.getAttribute('href'), location.origin);
            return numberOrNull(u.searchParams.get('modelVersionId'));
        } catch {
            const m = String(preferred.getAttribute('href') || '').match(/modelVersionId=(\d+)/);
            return m ? Number(m[1]) : null;
        }
    }

    function domMetaFromCard(root, size) {
        const prompt = textAfterHeading(root, 'Prompt');
        const negativePrompt = textAfterHeading(root, 'Negative Prompt');
        const steps = numberOrNull(labeledValue(root, 'Steps'));
        const cfg = numberOrNull(labeledValue(root, 'Guidance') || labeledValue(root, 'CFG scale'));
        const sampler = labeledValue(root, 'Sampler');
        const seed = numberOrNull(labeledValue(root, 'Seed'));

        const meta = {};
        if (prompt) meta.prompt = prompt;
        if (negativePrompt) meta.negativePrompt = negativePrompt;
        if (steps !== null) meta.steps = steps;
        if (cfg !== null) meta.cfgScale = cfg;
        if (sampler) meta.sampler = sampler;
        if (seed !== null) meta.seed = seed;
        if (size.width && size.height) meta.Size = { width: size.width, height: size.height };
        return Object.keys(meta).length ? meta : null;
    }

    function collectDomVideoCandidates(postId, startIndex = 0, existingSeen = new Set()) {
        const out = [];
        const videos = [...document.querySelectorAll('video')];
        let idx = startIndex;
        for (const video of videos) {
            const sourceCandidates = allVideoSources(video);
            const best = sourceCandidates[0] || { src: '', type: '' };
            const src = best.src || '';
            if (!src) continue;
            const id = uuidFromUrl(src);
            const key = id || src;
            if (existingSeen.has(key)) continue;
            existingSeen.add(key);

            const root = findVideoCardRoot(video);
            const html = root?.outerHTML || '';
            const text = (root?.innerText || '').replace(/\s+/g, ' ').trim();
            const ratingInfo = ratingInfoFromRoot(root);
            const ratingText = ratingInfo.text;
            const hasRating = ratingInfo.hasRating;
            const size = aspectSizeFromCard(root);
            const meta = domMetaFromCard(root, size);
            const mime = best.type || guessMime(src) || 'video/mp4';
            const name = filenameFromUrl(src, id ? `${id}.mp4` : `dom_video_${idx}.mp4`);

            out.push({
                raw: { domOnly: true, src, sourceCandidates },
                sourceCandidates,
                id,
                name,
                url: src,
                postId,
                baseIndex: idx,
                index: idx,
                serverIndex: idx,
                displayNumber: idx + 1,
                mimeType: mime,
                width: size.width,
                height: size.height,
                modelVersionId: modelVersionFromDom(root),
                modelId: null,
                meta,
                metadata: { width: size.width, height: size.height },
                ratingText: hasRating ? (ratingText || 'rated') : '',
                missingRating: !hasRating,
                domHasRating: hasRating,
                debugRootVideoCount: countVideosInside(root),
                domRoot: root,
            });
            idx++;
        }
        return out;
    }

    function collectDomRatingHints() {
        const hints = [];
        const videos = [...document.querySelectorAll('video')];
        for (const video of videos) {
            const root = findVideoCardRoot(video);
            const info = ratingInfoFromRoot(root);
            hints.push({
                src: bestVideoSource(video).src || video.currentSrc || video.src || video.getAttribute('src') || '',
                hasRating: info.hasRating,
                ratingText: info.text,
                text: (root?.innerText || '').replace(/\s+/g, ' ').trim(),
            });
        }
        return hints;
    }


    function virtualIndexDeltaForBaseIndex(baseIndex) {
        const base = numberOrNull(baseIndex) ?? 0;
        return (state.virtualInsertions || []).filter(x => (numberOrNull(x.baseIndex) ?? -1) <= base).length;
    }

    function applyVirtualServerIndexes(mediaList) {
        for (const m of mediaList) {
            const base = numberOrNull(m.baseIndex ?? m.index) ?? 0;
            m.baseIndex = base;
            m.displayNumber = numberOrNull(m.displayNumber) ?? (base + 1);
            m.serverIndex = base + virtualIndexDeltaForBaseIndex(base);
        }
    }

    function recordVirtualInsertion(media, sentIndex) {
        const base = numberOrNull(media?.baseIndex ?? media?.index) ?? 0;
        state.virtualInsertions.push({
            baseIndex: base,
            sentIndex: numberOrNull(sentIndex),
            mediaKey: mediaHandledKey(media),
            at: new Date().toISOString(),
        });
        applyVirtualServerIndexes(state.media || []);
        renderVideoNumberBadges();
        renderList();
    }

    function rebuildMediaList() {
        const postId = postIdFromUrl();
        loadHandledState();
        collectEmbeddedJson();

        const found = [];
        const seen = new Set();
        let fallbackIndex = 0;
        for (const cap of state.captured) {
            walkJson(cap.data, (node) => {
                if (!objectLooksLikeVideoMedia(node, postId)) return;
                const media = normalizeMedia(node, fallbackIndex++, postId);
                const key = media.id || media.url || `${media.name}:${media.index}`;
                if (seen.has(key)) return;
                seen.add(key);
                found.push(media);
            });
        }

        const domHints = collectDomRatingHints();
        for (let i = 0; i < found.length && i < domHints.length; i++) {
            found[i].domHasRating = domHints[i].hasRating;
            if (domHints[i].hasRating) { found[i].missingRating = false; found[i].ratingText = domHints[i].ratingText || found[i].ratingText || 'rated'; }
            else if (!found[i].ratingText) found[i].missingRating = true;
        }

        // Fallback for the current Civitai edit UI: some video cards are only visible
        // as DOM markup and never appear in the JSON captured by fetch/script parsing.
        const seenDom = new Set(found.map(m => m.id || m.url).filter(Boolean));
        const domFound = collectDomVideoCandidates(postId, found.length, seenDom);
        if (domFound.length) {
            log(`DOM fallback found ${domFound.length} video candidate(s).`);
            found.push(...domFound);
        }

        found.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
        applyVirtualServerIndexes(found);
        for (const media of found) {
            if (!media.missingRating && isHandled(media)) clearHandledFor(media);
        }
        state.media = found;
        renderVideoNumberBadges();
        renderList();
        const missing = found.filter(m => m.missingRating).length;
        const handled = found.filter(m => m.missingRating && isHandled(m)).length;
        const actionable = found.filter(m => m.missingRating && !isHandled(m)).length;
        const rated = found.length - missing;
        setStatus(`Found ${found.length} video candidate(s): ${missing} missing rating (${actionable} actionable, ${handled} already handled), ${rated} already rated. Virtual inserted this page: ${state.virtualInsertions.length}.`);
    }

    function setStatus(msg, isError = false) {
        if (!state.status) return;
        state.status.textContent = msg;
        state.status.style.color = isError ? '#ff9a9a' : '#cfcfcf';
        log(msg);
    }

    function initPanel() {
        if (state.panel) return;
        if (typeof GM_addStyle === 'function') {
            GM_addStyle(`
#cvrPanel{position:fixed;right:14px;bottom:14px;z-index:999999;width:430px;max-height:72vh;background:#18181b;color:#eee;border:1px solid #444;border-radius:10px;box-shadow:0 8px 30px rgba(0,0,0,.45);font:13px/1.35 Arial,sans-serif;overflow:hidden}
#cvrPanel button{background:#2f4f80;color:#fff;border:1px solid #4b6fa5;border-radius:6px;padding:5px 8px;cursor:pointer;font:inherit}
#cvrPanel button:hover{background:#3b6097}
#cvrPanel button.cvrStop{background:#6b3434;border-color:#9a4e4e}
#cvrPanel button.cvrDanger{background:#6b3434;border-color:#9a4e4e}
#cvrHead{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 10px;background:#242428;border-bottom:1px solid #444}
#cvrBody{padding:8px 10px;overflow:auto;max-height:55vh}
#cvrStatus{padding:7px 10px;border-top:1px solid #444;color:#cfcfcf;font-size:12px}
.cvrRow{border:1px solid #3b3b42;border-radius:8px;margin:7px 0;padding:7px;background:#202024}
.cvrRowMissing{border-color:#9b6b2f;background:#29231b}
.cvrRow:hover{outline:1px solid #79a8ff;background:#253044}
.cvrMediaHighlight{outline:5px solid #4da3ff !important;outline-offset:4px !important;box-shadow:0 0 0 4px rgba(77,163,255,.22),0 0 26px rgba(77,163,255,.9) !important;border-radius:10px !important}
.cvrNumberRoot{position:relative !important;overflow:visible !important}
.cvrVideoNumberBadge{position:absolute;left:-13px;top:-13px;z-index:999998;background:#ffd400;color:#111;border:2px solid #111;border-radius:999px;min-width:26px;height:26px;padding:0 7px;display:flex;align-items:center;justify-content:center;font:bold 15px/1 Arial,sans-serif;box-shadow:0 2px 10px rgba(0,0,0,.55);cursor:pointer;pointer-events:auto}
.cvrRowFocused{outline:2px solid #ffd400 !important;background:#3a3317 !important}
.cvrMeta{font-size:12px;color:#aaa;margin:3px 0;word-break:break-word}
.cvrPrompt{font-size:12px;color:#c9c9c9;max-height:38px;overflow:hidden;margin:3px 0}
.cvrActions{display:flex;gap:6px;margin-top:6px;flex-wrap:wrap}
.cvrSmall{font-size:11px;color:#aaa}
`);
        }

        const panel = document.createElement('div');
        panel.id = 'cvrPanel';
        panel.innerHTML = `
<div id="cvrHead">
  <b>Video rating re-upload</b>
  <div style="display:flex;gap:6px;align-items:center">
    <label class="cvrSmall"><input id="cvrOnlyMissing" type="checkbox" checked> missing only</label>
    <button id="cvrAutoAll">Auto all safe</button>
    <button id="cvrStopAuto" class="cvrStop">Stop</button>
    <button id="cvrRefresh">Refresh</button>
    <button id="cvrClearHandled" title="Clear handled cache for this post">Clear state</button>
    <button id="cvrMin">_</button>
  </div>
</div>
<div id="cvrBody"></div>
<div id="cvrStatus">Ready. Refresh after the edit page fully loads.</div>`;
        document.documentElement.appendChild(panel);
        state.panel = panel;
        state.body = panel.querySelector('#cvrBody');
        state.status = panel.querySelector('#cvrStatus');
        panel.querySelector('#cvrRefresh').addEventListener('click', rebuildMediaList);
        panel.querySelector('#cvrAutoAll').addEventListener('click', startReloadSafeAuto);
        panel.querySelector('#cvrStopAuto').addEventListener('click', stopReloadSafeAuto);
        panel.querySelector('#cvrClearHandled').addEventListener('click', clearAllHandledState);
        panel.querySelector('#cvrOnlyMissing').addEventListener('change', (e) => {
            state.showOnlyMissing = e.target.checked;
            renderList();
        });
        panel.querySelector('#cvrMin').addEventListener('click', () => {
            const b = state.body;
            b.style.display = b.style.display === 'none' ? '' : 'none';
        });
    }


    function clearVideoNumberBadges() {
        for (const badge of document.querySelectorAll('.cvrVideoNumberBadge')) {
            try { badge.remove(); } catch {}
        }
        for (const root of document.querySelectorAll('.cvrNumberRoot')) {
            try { root.classList.remove('cvrNumberRoot'); } catch {}
        }
    }

    function displayNumberForMedia(media, fallbackZeroBased = 0) {
        const n = numberOrNull(media?.displayNumber);
        if (n !== null) return n;
        const base = numberOrNull(media?.baseIndex ?? media?.index);
        return base !== null ? base + 1 : fallbackZeroBased + 1;
    }

    function rowKeyForMedia(media) {
        return `cvr-row-${mediaFingerprint(media)}`;
    }

    function focusPanelEntryForMedia(media) {
        if (!state.body) return;
        state.showOnlyMissing = false;
        const cb = state.panel?.querySelector('#cvrOnlyMissing');
        if (cb) cb.checked = false;
        renderList();
        const key = rowKeyForMedia(media);
        const row = state.body.querySelector(`[data-cvr-row-key="${CSS.escape(key)}"]`);
        if (row) {
            state.body.querySelectorAll('.cvrRowFocused').forEach(x => x.classList.remove('cvrRowFocused'));
            row.classList.add('cvrRowFocused');
            row.scrollIntoView({ behavior: 'smooth', block: 'center' });
            const n = displayNumberForMedia(media);
            setStatus(`Focused panel entry for video #${n}.`);
            setTimeout(() => row.classList.remove('cvrRowFocused'), 4500);
        } else {
            setStatus('Panel entry was not found. Try Refresh.', true);
        }
    }

    function renderVideoNumberBadges() {
        clearVideoNumberBadges();
        const media = [...state.media]
            .filter(m => m?.domRoot && m.domRoot.isConnected)
            .sort((a, b) => (a.index ?? 0) - (b.index ?? 0));

        for (const m of media) {
            const root = m.domRoot;
            const label = displayNumberForMedia(m, media.indexOf(m));
            const badge = document.createElement('div');
            badge.className = 'cvrVideoNumberBadge';
            badge.textContent = String(label);
            badge.title = `Video #${label} (DOM index ${m.baseIndex ?? m.index ?? '?'}, upload index ${m.serverIndex ?? m.index ?? '?'})`;
            badge.addEventListener('click', (ev) => {
                ev.preventDefault();
                ev.stopPropagation();
                focusPanelEntryForMedia(m);
            });
            root.classList.add('cvrNumberRoot');
            root.appendChild(badge);
        }
    }

    function renderList() {
        if (!state.body) return;
        const rows = state.media.filter(m => !state.showOnlyMissing || (m.missingRating && !isHandled(m)));
        if (!rows.length) {
            const total = state.media.length;
            const missing = state.media.filter(m => m.missingRating).length;
            const handled = state.media.filter(m => m.missingRating && isHandled(m)).length;
            const actionable = state.media.filter(m => m.missingRating && !isHandled(m)).length;
            state.body.innerHTML = `<div class="cvrSmall">No matching actionable videos found. Total: ${total}, missing rating: ${missing}, actionable: ${actionable}, already handled: ${handled}. Debug data was saved to <code>window.__CVR_MEDIA__</code>.</div>`;
            window.__CVR_MEDIA__ = state.media;
            return;
        }
        window.__CVR_MEDIA__ = state.media;
        state.body.innerHTML = '';
        rows.forEach((m, i) => {
            const row = document.createElement('div');
            row.className = `cvrRow ${m.missingRating ? 'cvrRowMissing' : ''}`;
            const rowKey = rowKeyForMedia(m);
            row.setAttribute('data-cvr-row-key', rowKey);
            const prompt = String(m.meta?.prompt || m.raw?.prompt || '').slice(0, 240);
            const handledText = isHandled(m) ? ' | handled: yes' : '';
            const rating = m.missingRating ? 'missing/unknown' : (m.ratingText || 'rated');
            const displayNo = displayNumberForMedia(m, i);
            row.innerHTML = `
<div><b>#${displayNo} — ${escapeHtml(m.name)}</b></div>
<div class="cvrMeta">video #: ${displayNo} | DOM index: ${m.baseIndex ?? m.index ?? '?'} | upload index: ${m.serverIndex ?? m.index ?? '?'} | id: ${escapeHtml(String(m.id ?? '?'))} | rating: ${escapeHtml(rating)}${handledText}</div>
<div class="cvrMeta">mime: ${escapeHtml(m.mimeType)} | ${m.width || '?'}x${m.height || '?'} | modelVersionId: ${m.modelVersionId ?? '?'}</div>
<div class="cvrPrompt">${escapeHtml(prompt || '(no prompt found in captured metadata)')}</div>
<div class="cvrActions">
  <button data-act="show">Show</button>
  <button data-act="autoUpload">Re-upload from site</button>
  <button data-act="upload">Choose local fallback</button>
  <button data-act="dump">Dump metadata</button>
</div>`;
            row.addEventListener('mouseenter', () => highlightMedia(m, false));
            row.addEventListener('mouseleave', () => clearHighlight());
            row.querySelector('[data-act="show"]').addEventListener('click', () => highlightMedia(m, true));
            row.querySelector('[data-act="autoUpload"]').addEventListener('click', () => reuploadFromExistingUrl(m).catch(e => { console.error(e); setStatus(`Error: ${e.message || e}`, true); }));
            row.querySelector('[data-act="upload"]').addEventListener('click', () => chooseAndReupload(m));
            row.querySelector('[data-act="dump"]').addEventListener('click', () => {
                window.__CVR_LAST_MEDIA__ = m;
                console.log('[CVR] selected media metadata:', m);
                setStatus('Metadata dumped to console as window.__CVR_LAST_MEDIA__.');
            });
            state.body.appendChild(row);
        });
    }


    function clearHighlight() {
        if (state.highlightedRoot) {
            try { state.highlightedRoot.classList.remove('cvrMediaHighlight'); } catch {}
            state.highlightedRoot = null;
        }
    }

    function highlightMedia(media, scroll = false) {
        clearHighlight();
        const root = media?.domRoot;
        if (!root || !root.isConnected) {
            setStatus('Could not find the visible DOM card for this entry. Try Refresh after scrolling the post list.');
            return;
        }
        root.classList.add('cvrMediaHighlight');
        state.highlightedRoot = root;
        if (scroll) {
            root.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
            setStatus(`Highlighted video #${displayNumberForMedia(media)} (upload index ${media.serverIndex ?? media.index ?? '?'}) - ${media.name}`);
        }
    }

    function escapeHtml(s) {
        return String(s).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
    }


    function headerFromString(headers, name) {
        const escaped = String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const re = new RegExp('^' + escaped + ':\\s*(.*)$', 'im');
        const m = String(headers || '').match(re);
        return m ? m[1].trim() : '';
    }

    const DOWNLOAD_STALL_TIMEOUT_MS = 45000;
    const DOWNLOAD_HARD_TIMEOUT_MS = 8 * 60 * 1000;
    const DOWNLOAD_RANGE_CHUNK_SIZE = 4 * 1024 * 1024;
    const DOWNLOAD_RANGE_RETRIES = 3;

    function mb(n) {
        return Math.round((Number(n) || 0) / 1024 / 1024);
    }

    function gmRequestBinary(url, opts = {}) {
        return new Promise((resolve, reject) => {
            if (typeof GM_xmlhttpRequest !== 'function') {
                reject(new Error('GM_xmlhttpRequest is not available. Reinstall the script and confirm the @grant permission.'));
                return;
            }

            const method = opts.method || 'GET';
            const responseType = opts.responseType || 'arraybuffer';
            const anonymous = opts.anonymous !== false;
            const headers = Object.assign({
                Accept: 'video/mp4,video/webm,video/*,*/*',
            }, opts.headers || {});
            const onProgress = opts.onProgress;
            const stallMs = opts.stallMs || DOWNLOAD_STALL_TIMEOUT_MS;
            const hardMs = opts.hardMs || DOWNLOAD_HARD_TIMEOUT_MS;

            let done = false;
            let lastActivity = Date.now();
            let request = null;
            let hardTimer = null;
            let stallTimer = null;

            function cleanup() {
                if (hardTimer) clearTimeout(hardTimer);
                if (stallTimer) clearInterval(stallTimer);
                hardTimer = null;
                stallTimer = null;
            }

            function finish(fn, value) {
                if (done) return;
                done = true;
                cleanup();
                fn(value);
            }

            hardTimer = setTimeout(() => {
                try { request?.abort?.(); } catch {}
                finish(reject, new Error(`Download hard-timeout after ${Math.round(hardMs / 1000)}s (${method}, ${responseType}, anonymous=${anonymous}).`));
            }, hardMs);

            stallTimer = setInterval(() => {
                if (Date.now() - lastActivity > stallMs) {
                    try { request?.abort?.(); } catch {}
                    finish(reject, new Error(`Download stalled for ${Math.round(stallMs / 1000)}s (${method}, ${responseType}, anonymous=${anonymous}).`));
                }
            }, 5000);

            request = GM_xmlhttpRequest({
                method,
                url,
                responseType,
                anonymous,
                timeout: hardMs,
                headers,
                onprogress: (ev) => {
                    lastActivity = Date.now();
                    if (typeof onProgress === 'function') {
                        onProgress(Number(ev.loaded || 0), Number(ev.total || 0), !!ev.lengthComputable);
                    }
                },
                onload: (res) => {
                    lastActivity = Date.now();
                    finish(resolve, res);
                },
                onerror: (err) => finish(reject, new Error(`Download network error (${method}, ${responseType}, anonymous=${anonymous}): ${err?.error || err?.message || 'unknown'}`)),
                ontimeout: () => finish(reject, new Error(`Download timed out (${method}, ${responseType}, anonymous=${anonymous}).`)),
                onabort: () => finish(reject, new Error(`Download aborted (${method}, ${responseType}, anonymous=${anonymous}).`)),
            });
        });
    }

    function blobFromGmResponse(res, url, responseType) {
        const contentType = headerFromString(res.responseHeaders, 'content-type') || guessMime(url) || 'video/mp4';
        if (responseType === 'blob') {
            if (res.response instanceof Blob) return res.response;
            throw new Error('Downloaded response is not usable as blob.');
        }
        if (responseType === 'arraybuffer') {
            if (res.response instanceof ArrayBuffer) return new Blob([res.response], { type: contentType });
            throw new Error('Downloaded response is not usable as arraybuffer.');
        }
        throw new Error(`Unsupported responseType: ${responseType}`);
    }

    async function gmFetchBlobOnce(url, onProgress, opts = {}) {
        const responseType = opts.responseType || 'blob';
        const res = await gmRequestBinary(url, {
            method: 'GET',
            responseType,
            anonymous: opts.anonymous !== false,
            onProgress,
        });
        if (res.status < 200 || res.status >= 300) {
            throw new Error(`Download failed [${res.status}]: ${String(res.responseText || '').slice(0, 200)}`);
        }
        return blobFromGmResponse(res, url, responseType);
    }

    function parseContentRange(headers) {
        const cr = headerFromString(headers, 'content-range');
        const m = cr.match(/bytes\s+(\d+)\s*-\s*(\d+)\s*\/\s*(\d+|\*)/i);
        if (!m) return null;
        return {
            start: Number(m[1]),
            end: Number(m[2]),
            total: m[3] === '*' ? null : Number(m[3]),
            raw: cr,
        };
    }

    async function gmFetchRangeOnce(url, start, end, onProgress, opts = {}) {
        const res = await gmRequestBinary(url, {
            method: 'GET',
            responseType: 'arraybuffer',
            anonymous: opts.anonymous !== false,
            headers: { Range: `bytes=${start}-${end}` },
            onProgress,
            stallMs: opts.stallMs || DOWNLOAD_STALL_TIMEOUT_MS,
            hardMs: opts.hardMs || DOWNLOAD_HARD_TIMEOUT_MS,
        });
        if (res.status !== 206 && res.status !== 200) {
            throw new Error(`Range download failed [${res.status}]: ${String(res.responseText || '').slice(0, 200)}`);
        }
        if (!(res.response instanceof ArrayBuffer)) {
            throw new Error('Range response is not an ArrayBuffer.');
        }
        return res;
    }

    async function gmFetchBlobRangeChunks(url, onProgress, opts = {}) {
        const anonymous = opts.anonymous !== false;
        const contentType = guessMime(url) || 'video/mp4';

        setStatus(`Probing video size for chunked download...`);
        const probe = await gmFetchRangeOnce(url, 0, 0, (loaded, total, computable) => {
            if (typeof onProgress === 'function') onProgress(loaded, total, computable);
        }, { anonymous, stallMs: 30000, hardMs: 90000 });

        // If the CDN ignored Range and returned the whole file, use it.
        if (probe.status === 200) {
            const blob = new Blob([probe.response], { type: headerFromString(probe.responseHeaders, 'content-type') || contentType });
            if (typeof onProgress === 'function') onProgress(blob.size, blob.size, true);
            return blob;
        }

        const rangeInfo = parseContentRange(probe.responseHeaders);
        const total = rangeInfo?.total || Number(headerFromString(probe.responseHeaders, 'content-length') || 0);
        if (!total || total <= 1) {
            throw new Error(`Chunked download could not determine total size. Content-Range: ${rangeInfo?.raw || 'missing'}`);
        }

        const chunks = [];
        let completed = 0;
        for (let start = 0, chunkIndex = 1; start < total; start += DOWNLOAD_RANGE_CHUNK_SIZE, chunkIndex++) {
            const end = Math.min(start + DOWNLOAD_RANGE_CHUNK_SIZE - 1, total - 1);
            let lastErr = null;
            for (let attempt = 1; attempt <= DOWNLOAD_RANGE_RETRIES; attempt++) {
                try {
                    setStatus(`Downloading original video chunk ${chunkIndex}/${Math.ceil(total / DOWNLOAD_RANGE_CHUNK_SIZE)} (${mb(completed)} / ${mb(total)} MB)...`);
                    const res = await gmFetchRangeOnce(url, start, end, (loaded) => {
                        if (typeof onProgress === 'function') onProgress(completed + loaded, total, true);
                    }, { anonymous, stallMs: 30000, hardMs: 120000 });

                    if (res.status === 200 && start === 0) {
                        const blob = new Blob([res.response], { type: headerFromString(res.responseHeaders, 'content-type') || contentType });
                        if (typeof onProgress === 'function') onProgress(blob.size, blob.size, true);
                        return blob;
                    }

                    chunks.push(res.response);
                    completed += res.response.byteLength;
                    if (typeof onProgress === 'function') onProgress(completed, total, true);
                    lastErr = null;
                    break;
                } catch (e) {
                    lastErr = e;
                    warn('chunk download attempt failed', { url, start, end, attempt, error: e });
                    if (attempt < DOWNLOAD_RANGE_RETRIES) await sleep(800 * attempt);
                }
            }
            if (lastErr) throw lastErr;
        }

        const blob = new Blob(chunks, { type: contentType });
        if (!blob.size) throw new Error('Chunked download produced an empty blob.');
        return blob;
    }

    async function fetchBlobFallback(url, onProgress) {
        // Works only when the CDN sends CORS headers, but it is useful as a fallback
        // when Tampermonkey/GM_xmlhttpRequest fails on a redirect or large blob.
        const controller = new AbortController();
        let lastActivity = Date.now();
        const watchdog = setInterval(() => {
            if (Date.now() - lastActivity > DOWNLOAD_STALL_TIMEOUT_MS) {
                try { controller.abort(); } catch {}
            }
        }, 5000);
        try {
            const r = await fetch(url, { method: 'GET', credentials: 'omit', cache: 'no-store', signal: controller.signal });
            if (!r.ok) throw new Error(`fetch() download failed [${r.status}]`);
            const contentLength = Number(r.headers.get('content-length') || 0);
            if (!r.body || !contentLength) return await r.blob();

            const reader = r.body.getReader();
            const chunks = [];
            let loaded = 0;
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                lastActivity = Date.now();
                chunks.push(value);
                loaded += value.byteLength;
                if (typeof onProgress === 'function') onProgress(loaded, contentLength, true);
            }
            return new Blob(chunks, { type: r.headers.get('content-type') || guessMime(url) || 'video/mp4' });
        } finally {
            clearInterval(watchdog);
        }
    }

    function buildDownloadUrlCandidates(media) {
        const raw = media?.raw || {};
        const sources = [];
        function add(src) {
            src = String(src || '').trim();
            if (!src) return;
            sources.push(src);
        }

        for (const item of media?.sourceCandidates || raw.sourceCandidates || []) {
            add(typeof item === 'string' ? item : item?.src);
        }
        add(media?.url);
        add(raw.src);
        add(raw.url);

        const out = [];
        const seen = new Set();
        for (const src of sources) {
            const variants = [forceOriginalVideoUrl(src), src];
            for (const v of variants) {
                if (!v || seen.has(v)) continue;
                seen.add(v);
                out.push(v);
            }
        }
        out.sort((a, b) => {
            const as = /\.mp4(?:\?|$)/i.test(a) ? 0 : (/\.webm(?:\?|$)/i.test(a) ? 1 : 2);
            const bs = /\.mp4(?:\?|$)/i.test(b) ? 0 : (/\.webm(?:\?|$)/i.test(b) ? 1 : 2);
            return as - bs;
        });
        return out;
    }

    async function gmFetchBlob(urlOrUrls, onProgress) {
        const urls = Array.isArray(urlOrUrls) ? urlOrUrls : [urlOrUrls];
        const attempts = [];
        let lastError = null;

        for (const url of urls) {
            const short = filenameFromUrl(url, url).slice(0, 80);
            const methods = [
                ['GM chunked anonymous', () => gmFetchBlobRangeChunks(url, onProgress, { anonymous: true })],
                ['GM chunked with cookies', () => gmFetchBlobRangeChunks(url, onProgress, { anonymous: false })],
                ['fetch streaming fallback', () => fetchBlobFallback(url, onProgress)],
                ['GM arraybuffer anonymous', () => gmFetchBlobOnce(url, onProgress, { responseType: 'arraybuffer', anonymous: true })],
                ['GM blob anonymous', () => gmFetchBlobOnce(url, onProgress, { responseType: 'blob', anonymous: true })],
                ['GM arraybuffer with cookies', () => gmFetchBlobOnce(url, onProgress, { responseType: 'arraybuffer', anonymous: false })],
                ['GM blob with cookies', () => gmFetchBlobOnce(url, onProgress, { responseType: 'blob', anonymous: false })],
            ];
            for (const [label, fn] of methods) {
                try {
                    setStatus(`Downloading original video via ${label}: ${short}`);
                    const blob = await fn();
                    if (blob && blob.size > 0) {
                        log('download succeeded', { label, url, size: blob.size, type: blob.type });
                        return { blob, url, method: label };
                    }
                    throw new Error('Downloaded video is empty.');
                } catch (e) {
                    lastError = e;
                    attempts.push(`${label} ${short}: ${e.message || e}`);
                    warn('download attempt failed', { label, url, error: e });
                    await sleep(400);
                }
            }
        }

        const msg = attempts.slice(-8).join(' | ');
        throw new Error(`All download attempts failed. Last error: ${lastError?.message || lastError || 'unknown'}. Attempts: ${msg}`);
    }

    function forceOriginalVideoUrl(url) {
        // The DOM source usually already has transcode=true,original=true.
        // Keep it intact, but make a best effort to request the original/transcoded full video.
        try {
            const u = new URL(url, location.href);
            const parts = u.pathname.split('/');
            // Civitai media URLs often encode transform params as a path segment.
            // Do not rewrite aggressively because both working examples use this path style.
            if (!/original=true/i.test(u.href)) {
                u.searchParams.set('original', 'true');
            }
            return u.href;
        } catch {
            return url;
        }
    }

    async function reuploadFromExistingUrl(media) {
        const urls = buildDownloadUrlCandidates(media);
        if (!urls.length) throw new Error('This video candidate has no source URL. Use local fallback.');

        const firstUrl = urls[0];
        const originalName = filenameFromUrl(firstUrl, media.name || `video_${media.index || 0}.mp4`);
        const mime = guessMime(originalName) || media.mimeType || 'video/mp4';
        setStatus(`Downloading original video from Civitai: ${originalName}`);
        log('download candidates', urls);

        const result = await gmFetchBlob(urls, (loaded, total) => {
            if (total) {
                const pct = Math.round((loaded / total) * 100);
                setStatus(`Downloading original video: ${pct}% (${mb(loaded)} / ${mb(total)} MB)`);
            } else {
                setStatus(`Downloading original video: ${mb(loaded)} MB downloaded...`);
            }
        });
        const blob = result.blob || result;
        const usedUrl = result.url || firstUrl;

        if (!blob.size) throw new Error('Downloaded video is empty.');
        const usedName = filenameFromUrl(usedUrl, originalName);
        const file = new File([blob], usedName, { type: blob.type || guessMime(usedName) || mime });
        log('downloaded original video', { name: file.name, size: file.size, type: file.type, usedUrl, method: result.method });
        await reupload(media, file, { deleteOriginal: false });
    }

    function chooseAndReupload(media) {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'video/mp4,video/webm,video/quicktime,video/*';
        input.addEventListener('change', async () => {
            const file = input.files && input.files[0];
            if (!file) return;
            try {
                await reupload(media, file, { deleteOriginal: false });
            } catch (e) {
                console.error(e);
                setStatus(`Error: ${e.message || e}`, true);
            }
        });
        input.click();
    }

    async function postJson(url, body, label) {
        const r = await fetch(url, {
            method: 'POST',
            credentials: 'include',
            headers: makeHeaders(),
            body: JSON.stringify(body),
        });
        const text = await r.text();
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch {}
        if (!r.ok) {
            throw new Error(`${label} failed [${r.status}]: ${text.slice(0, 400)}`);
        }
        return json;
    }

    function makeHeaders() {
        return {
            'Accept': '*/*',
            'Content-Type': 'application/json',
            'Origin': API_ORIGIN,
            'Referer': location.href,
            'x-client': 'web',
            'x-client-date': String(Date.now()),
        };
    }

    async function initMultipart(file) {
        const mime = file.type || guessMime(file.name) || 'video/mp4';
        const body = { filename: file.name, type: 'image', size: file.size, mimeType: mime };
        const info = await postJson(INIT_UPLOAD_ENDPOINT, body, 'multipart init');
        info.kind = 'video';
        info.type = 'image';
        return info;
    }

    async function uploadParts(file, initInfo) {
        let urls = initInfo.urls || [];
        if (!urls.length && initInfo.url) urls = [{ url: initInfo.url, partNumber: 1 }];
        if (!urls.length) throw new Error('Upload init response did not contain part URLs.');

        const partSize = Math.ceil(file.size / urls.length);
        const parts = [];
        for (let i = 0; i < urls.length; i++) {
            const part = urls[i];
            const url = typeof part === 'string' ? part : part.url;
            const partNumber = Number(part.partNumber || i + 1);
            const start = i * partSize;
            const end = Math.min(start + partSize, file.size);
            setStatus(`Uploading part ${i + 1}/${urls.length}...`);
            const r = await fetch(url, { method: 'PUT', body: file.slice(start, end) });
            if (!r.ok) throw new Error(`PUT part ${i + 1} failed [${r.status}]`);
            let etag = r.headers.get('ETag') || r.headers.get('Etag') || r.headers.get('etag');
            if (!etag) throw new Error('Upload part succeeded but ETag header was not readable.');
            if (!(etag.startsWith('"') && etag.endsWith('"'))) etag = `"${etag}"`;
            parts.push({ PartNumber: partNumber, ETag: etag });
        }
        parts.sort((a, b) => a.PartNumber - b.PartNumber);
        return parts;
    }

    async function completeUpload(initInfo, parts) {
        if (!initInfo.uploadId) return;
        const body = {
            bucket: initInfo.bucket,
            key: initInfo.key,
            type: 'image',
            uploadId: initInfo.uploadId,
            parts,
            backend: initInfo.backend || 'backblaze',
        };
        await postJson(COMPLETE_UPLOAD_ENDPOINT, body, 'upload complete');
    }

    async function addVideoToPost(media, initInfo, file) {
        const postId = postIdFromUrl();
        if (!postId) throw new Error('Could not read post id from URL.');
        const mime = file.type || guessMime(file.name) || media.mimeType || 'video/mp4';
        const meta = cloneSerializable(media.meta || media.raw?.meta || null);
        const modelVersionId = numberOrNull(media.modelVersionId ?? media.raw?.modelVersionId);
        const width = numberOrNull(media.width ?? media.metadata?.width);
        const height = numberOrNull(media.height ?? media.metadata?.height);
        // Use a virtual server index. Civitai updates indexes server-side immediately after addImage,
        // but the visible edit page does not insert the new video until refresh. This offset prevents
        // later manual uploads on the stale page from being inserted in the wrong position.
        const index = numberOrNull(media.serverIndex ?? media.index) ?? 0;
        log('addVideoToPost index placement', { domIndex: media.baseIndex ?? media.index, serverIndex: media.serverIndex, sentIndex: index, name: file.name, virtualInsertions: state.virtualInsertions });

        const jsonPayload = {
            name: file.name,
            url: initInfo.key,
            hash: null,
            height,
            width,
            postId,
            ...(modelVersionId !== null ? { modelVersionId } : {}),
            index,
            mimeType: mime,
            meta,
            type: 'video',
            metadata: { size: file.size, width, height },
            externalDetailsUrl: null,
            authed: true,
        };

        const body = {
            json: jsonPayload,
            meta: {
                values: {
                    modelVersionId: modelVersionId === null ? ['undefined'] : [],
                    externalDetailsUrl: ['undefined'],
                },
            },
        };
        return postJson(POST_ADD_IMAGE_ENDPOINT, body, 'post.addImage');
    }

    function cloneSerializable(v) {
        if (v == null) return null;
        try { return JSON.parse(JSON.stringify(v)); } catch { return null; }
    }

    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    function isVisibleElement(el) {
        if (!el || !(el instanceof Element)) return false;
        const r = el.getBoundingClientRect();
        const st = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none';
    }

    function topMediaMenuButton(media) {
        const root = media.domRoot;
        if (!root) return null;
        const video = root.querySelector('video');
        const videoRect = video?.getBoundingClientRect?.();
        const buttons = [...root.querySelectorAll('button')]
            .filter(btn => /tabler-icon-dots-vertical|dots-vertical/i.test(btn.innerHTML || ''))
            .filter(isVisibleElement);
        if (!buttons.length) return null;
        if (!videoRect) return buttons[0];
        buttons.sort((a, b) => {
            const ar = a.getBoundingClientRect();
            const br = b.getBoundingClientRect();
            const ad = Math.abs(ar.top - videoRect.top) + Math.abs(ar.right - videoRect.right);
            const bd = Math.abs(br.top - videoRect.top) + Math.abs(br.right - videoRect.right);
            return ad - bd;
        });
        return buttons[0];
    }

    function findVisibleMenuDeleteItem() {
        const candidates = [...document.querySelectorAll('[role="menuitem"], [role="option"], button, div, span')]
            .filter(isVisibleElement)
            .filter(el => !state.panel?.contains(el));
        const exact = candidates.find(el => /^(remove from post|remove|delete)$/i.test((el.textContent || '').trim()));
        if (exact) return exact.closest('button,[role="menuitem"],[role="option"]') || exact;
        const loose = candidates.find(el => /\b(remove|delete)\b/i.test((el.textContent || '').trim()) && (el.textContent || '').trim().length < 80);
        return loose ? (loose.closest('button,[role="menuitem"],[role="option"]') || loose) : null;
    }

    function findVisibleConfirmButton() {
        const dialogs = [...document.querySelectorAll('[role="dialog"], .mantine-Modal-root, .mantine-Modal-content')]
            .filter(isVisibleElement);
        const roots = dialogs.length ? dialogs : [document];
        const candidates = roots.flatMap(root => [...root.querySelectorAll('button, [role="button"]')])
            .filter(isVisibleElement)
            .filter(btn => !state.panel?.contains(btn));

        const normalized = (el) => (el.textContent || '').replace(/\s+/g, ' ').trim();

        // Civitai currently asks: "Yes, I am sure". Prefer this exact destructive confirmation.
        return candidates.find(btn => /^yes[, ]+i am sure$/i.test(normalized(btn)))
            || candidates.find(btn => /^(yes|delete|remove|confirm)$/i.test(normalized(btn)))
            || candidates.find(btn => /\b(i am sure|sure|delete|remove|confirm)\b/i.test(normalized(btn)) && normalized(btn).length <= 40)
            || null;
    }

    async function waitForVisibleConfirmButton(timeoutMs = 5000) {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
            const btn = findVisibleConfirmButton();
            if (btn) return btn;
            await sleep(200);
        }
        return null;
    }

    async function deleteOriginalViaDom(media) {
        return { ok: false, reason: 'automatic deletion is disabled in v0.1.6 safety build' };
        const root = media.domRoot;
        if (!root || !document.contains(root)) {
            return { ok: false, reason: 'original DOM card is no longer available' };
        }
        const menuBtn = topMediaMenuButton(media);
        if (!menuBtn) {
            return { ok: false, reason: 'could not find the original media menu button' };
        }

        setStatus('Opening original video menu for deletion...');
        menuBtn.click();
        await sleep(450);

        const deleteItem = findVisibleMenuDeleteItem();
        if (!deleteItem) {
            return { ok: false, reason: 'could not find Delete/Remove in the original media menu' };
        }

        setStatus('Clicking Delete/Remove for original video...');
        deleteItem.click();
        await sleep(650);

        const confirm = await waitForVisibleConfirmButton(6000);
        if (confirm) {
            setStatus('Confirming original video deletion...');
            confirm.click();
            await sleep(1500);
            return { ok: true };
        }

        return { ok: false, reason: 'delete confirmation dialog appeared, but the confirmation button was not found' };
    }

    async function reupload(media, file, options = {}) {
        if (!file.type.startsWith('video/') && !/\.(mp4|webm|mov|mkv)$/i.test(file.name)) {
            throw new Error('Selected file does not look like a video.');
        }
        if (isHandled(media)) {
            setStatus('Skipped: this media/settings fingerprint was already handled for this post. Clear state to force it again.');
            return;
        }
        setStatus(`Starting upload: ${file.name}`);
        const initInfo = await initMultipart(file);
        log('init', initInfo);
        const parts = await uploadParts(file, initInfo);
        setStatus('Completing upload...');
        await completeUpload(initInfo, parts);
        setStatus('Adding replacement video to post...');
        const sentIndex = numberOrNull(media.serverIndex ?? media.index) ?? 0;
        const res = await addVideoToPost(media, initInfo, file);
        log('post.addImage response', res);
        markHandled(media, { replacementKey: initInfo.key || null, replacementFile: file.name, deletedOriginal: false, sentIndex });
        recordVirtualInsertion(media, sentIndex);

        if (false && options.deleteOriginal) {
            const del = await deleteOriginalViaDom(media);
            if (del.ok) {
                markHandled(media, { replacementKey: initInfo.key || null, replacementFile: file.name, deletedOriginal: true });
                setStatus('Done. Replacement added. Automatic deletion is disabled in this safe version.');
                try { media.domRoot?.remove(); } catch {}
                setTimeout(rebuildMediaList, 1500);
            } else {
                setStatus(`Replacement added, but original was not deleted automatically: ${del.reason}.`, true);
            }
        } else {
            setStatus('Done. Replacement video was added with copied metadata. Original deletion is disabled.');
        }
        return res;
    }

    async function autoReuploadNextWithReload() {
        if (state.autoRunning) {
            setStatus('Auto mode is already running.');
            return;
        }
        state.autoRunning = true;
        try {
            rebuildMediaList();
            await sleep(500);
            const autoState = loadAutoState();
            if (!autoState.active) {
                state.autoRunning = false;
                return;
            }

            const queue = state.media
                .filter(m => m.missingRating && !isHandled(m))
                .sort((a, b) => (numberOrNull(a.index) ?? 0) - (numberOrNull(b.index) ?? 0));

            if (!queue.length) {
                clearAutoState();
                setStatus('Auto all safe completed. No actionable missing-rating videos remain.');
                renderList();
                return;
            }

            const media = queue[0];
            const currentDone = Number(autoState.completed || 0);
            setStatus(`Auto all safe: processing one entry, then reloading for fresh server indexes. Done so far: ${currentDone}. Current video #${displayNumberForMedia(media)} / upload index: ${media.serverIndex ?? media.index ?? '?'} - ${media.name}`);
            highlightMedia(media, true);
            await sleep(600);
            await reuploadFromExistingUrl(media);

            saveAutoState({
                ...autoState,
                active: true,
                completed: currentDone + 1,
                lastMediaId: media.id || null,
                lastIndex: media.index ?? null,
                lastAt: new Date().toISOString(),
            });

            setStatus(`Auto all safe: uploaded one replacement. Reloading in ${Math.round(AUTO_RELOAD_DELAY_MS / 1000)}s so the next index is based on server state.`);
            await sleep(AUTO_RELOAD_DELAY_MS);
            location.reload();
        } finally {
            state.autoRunning = false;
        }
    }

    async function autoReuploadAllMissing() {
        startReloadSafeAuto();
    }

    function continueAutoAfterLoadIfNeeded() {
        const autoState = loadAutoState();
        if (!autoState.active) return;
        setStatus(`Auto all safe is active. Continuing after page reload. Completed so far: ${Number(autoState.completed || 0)}.`);
        setTimeout(() => {
            autoReuploadNextWithReload().catch(e => {
                console.error(e);
                clearAutoState();
                state.autoRunning = false;
                setStatus(`Auto error after reload: ${e.message || e}`, true);
            });
        }, 2200);
    }

    installFetchCapture();

    function onReady() {
        loadHandledState();
        initPanel();
        setTimeout(rebuildMediaList, 1200);
        setTimeout(rebuildMediaList, 3500);
        setTimeout(continueAutoAfterLoadIfNeeded, 4300);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', onReady, { once: true });
    } else {
        onReady();
    }

    let lastUrl = location.href;
    new MutationObserver(() => {
        if (location.href !== lastUrl) {
            lastUrl = location.href;
            setTimeout(rebuildMediaList, 1000);
        }
    }).observe(document.documentElement, { childList: true, subtree: true });
})();
