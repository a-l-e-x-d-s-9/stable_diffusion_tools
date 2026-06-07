// ==UserScript==
// @name         Civitai Meta-Fill Video
// @namespace    https://civitai.com/
// @version      0.6.4
// @icon         https://civitai.com/favicon.ico
// @description  Drag a PNG / JPEG / WEBP into the “Image details” modal → auto-fill Prompt etc.
// @match        https://civitai.com/*
// @match        https://www.civitai.com/*
// @match        https://civitai.green/*
// @match        https://www.civitai.green/*
// @match        https://civitai.red/*
// @match        https://www.civitai.red/*
// @run-at       document-idle
// @grant        GM_addStyle
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @require      https://cdn.jsdelivr.net/npm/exifreader@4.15.0/dist/exif-reader.js
// ==/UserScript==
/* global DecompressionStream */

// --- Utility: check if on edit page
function isOnCivitaiEditPage() {
    const hostMatch = /^(?:www\.)?civitai\.(?:com|green|red)$/.test(location.hostname);
    if (!hostMatch) return false;

    const isPostEdit = /^\/posts\/[^/]+\/edit(?:\/.*)?$/.test(location.pathname);
    if (isPostEdit) return true;

    const isModelVersionWizard = /^\/models\/[^/]+\/model-versions\/[^/]+\/wizard$/.test(location.pathname);
    if (isModelVersionWizard) {
        const step = new URLSearchParams(location.search).get('step');
        return step === '3';
    }

    return false;
}

// --- Main runner
function runScriptIfMatch() {
    if (!isOnCivitaiEditPage()) return;
    if (window._metaFillInit) return;
    window._metaFillInit = true;

    // everything else now goes inside
    (async () => {
        /* ------------------------------------------------------------------ */
        /* 1. ensure ExifReader (load dynamically if @require failed)         */
        /* ------------------------------------------------------------------ */
        if (typeof ExifReader === 'undefined' &&
            typeof exports      === 'object'   &&      // the CJS branch
            exports.ExifReader) {
            window.ExifReader = exports.ExifReader;      // create the global
        }
        const XR = unsafeWindow.ExifReader || window.ExifReader ||
            (typeof ExifReader !== 'undefined' ? ExifReader : null);

        /* ------------------------------------------------------------------ */
        /* 2. block stray navigation when dropping files                      */
        /* ------------------------------------------------------------------ */
        ["dragover", "drop"].forEach(ev =>
                                     window.addEventListener(ev, e => e.preventDefault(), false));

        /* ------------------------------------------------------------------ */
        /* 3. styles                                                          */
        /* ------------------------------------------------------------------ */
        GM_addStyle(`#metaDropZone{
      border:2px dashed #888;border-radius:8px;padding:12px;margin-bottom:12px;
      text-align:center;cursor:pointer;user-select:none;color:#aaa}
     #metaDropZone.drag{background:#444;color:#fff}`);


        /* ------------------------------------------------------------------ */
        /* 4. inject drop-zone when the image/video details form appears       */
        /* ------------------------------------------------------------------ */
        const DETAIL_FIELD_SELECTORS = [
            '#input_prompt',
            '#input_negativePrompt',
            '#input_steps',
            '#input_cfgScale',
            '#input_sampler',
            '#input_seed',
            'textarea[name="prompt"]',
            'textarea[name="negativePrompt"]',
            'input[name="steps"]',
            'input[name="cfgScale"]',
            'input[name="seed"]'
        ];

        function findDetailsForm() {
            const modalRoots = [
                ...document.querySelectorAll('section[data-modal-content="true"], [role="dialog"], [data-portal="true"]')
            ];

            for (const root of modalRoots) {
                const form = root.querySelector?.('form');
                if (form && DETAIL_FIELD_SELECTORS.some(sel => form.querySelector(sel))) return form;
            }

            return [...document.querySelectorAll('form')].find(form =>
                DETAIL_FIELD_SELECTORS.some(sel => form.querySelector(sel))
            ) || null;
        }

        function tryInjectZone() {
            if (!isOnCivitaiEditPage()) return;
            const form = findDetailsForm();
            if (!form || form.querySelector('#metaDropZone')) return;
            injectZone(form);
        }

        const obs = new MutationObserver(() => tryInjectZone());
        obs.observe(document.body, { childList: true, subtree: true });
        tryInjectZone();

        // Civitai/Mantine sometimes mounts modal internals after the outer node.
        // Keep probing briefly after script start and after SPA navigation.
        let injectProbeCount = 0;
        const injectProbe = setInterval(() => {
            tryInjectZone();
            if (++injectProbeCount >= 80) clearInterval(injectProbe);
        }, 250);

        function injectZone(form){
            const dz = document.createElement("div");
            dz.id = "metaDropZone";
            dz.innerHTML = '<input type="file" hidden accept="image/png,image/jpeg,image/webp">' +
                '<p>Drop generation image here (or click)</p>';
            form.prepend(dz);

            const fi = dz.firstElementChild;
            dz.onclick = () => fi.click();

            ["dragenter","dragover"].forEach(ev =>
                                             dz.addEventListener(ev, e => { e.preventDefault(); e.stopPropagation(); dz.classList.add("drag"); }));
            ["dragleave","drop"].forEach(ev =>
                                         dz.addEventListener(ev, e => { e.preventDefault(); e.stopPropagation(); dz.classList.remove("drag"); }));

            dz.addEventListener("drop",  e => e.dataTransfer.files[0] && handleFile(e.dataTransfer.files[0], dz));
            fi.addEventListener("change",e => e.target.files[0]        && handleFile(e.target.files[0], dz));
        }

        /* ------------------------------------------------------------------ */
        /* 5. main handler                                                    */
        /* ------------------------------------------------------------------ */
        async function handleFile(file, dz){
            const label = dz.querySelector("p");
            label.textContent = "reading...";
            try {
                const buf  = await file.arrayBuffer();
                const meta = await extractMeta(file.type, buf);
                if (!meta){ label.textContent = "no metadata"; return; }
                fillForm(parseSD(meta));
                label.textContent = "filled!";
            } catch (err){
                console.error(err);
                label.textContent = "error";
            }
        }

        /* ------------------------------------------------------------------ */
        /* 6. metadata extraction                                             */
        /* ------------------------------------------------------------------ */
        async function extractMeta(mime, buf){
            if (mime === "image/png"){
                const p = await extractPNG(buf);
                if (p) return p;
            }
            const x = extractEXIF(buf);
            if (x) return x;
            return extractRAW(buf);
        }

        /* -- 6a PNG parameters chunk --------------------------------------- */
        async function extractPNG(buf){
            const dv = new DataView(buf);
            let p = 8;
            while (p < dv.byteLength){
                const len  = dv.getUint32(p); p += 4;
                const type = String.fromCharCode(...new Uint8Array(buf, p, 4)); p += 4;
                if (["tEXt","iTXt","zTXt"].includes(type)){
                    const body = new Uint8Array(buf, p, len);
                    const nul  = body.indexOf(0);
                    const key  = new TextDecoder().decode(body.slice(0, nul));
                    if (key === "parameters"){
                        let txtBytes = body.slice(nul+1);
                        if (type === "zTXt" && typeof DecompressionStream !== "undefined"){
                            txtBytes = await new Response(txtBytes.slice(1)).arrayBuffer().then(b =>
                                                                                                new Response(new Blob([b]).stream()
                                                                                                             .pipeThrough(new DecompressionStream("deflate"))).arrayBuffer());
                        }
                        return new TextDecoder().decode(txtBytes);
                    }
                }
                p += len + 4;
            }
            return null;
        }

        /* -- 6b EXIF / IPTC / XMP ----------------------------------------- */
        function decodeUser(raw){
            if (typeof raw === "string") return raw;
            if (raw instanceof Uint8Array){
                const hdr = new TextDecoder().decode(raw.slice(0,8));
                if (hdr.startsWith("UNICODE")) return new TextDecoder("utf-16be").decode(raw.slice(8));
                if (hdr.startsWith("ASCII"))   return new TextDecoder().decode(raw.slice(8));
                return new TextDecoder().decode(raw);
            }
            if (Array.isArray(raw)) return new TextDecoder().decode(new Uint8Array(raw));
            return "";
        }

        /* ------------------------------------------------------------------ */
        /* 6 b  EXIF / IPTC / XMP                                             */
        /* ------------------------------------------------------------------ */
        function extractEXIF(buf) {
            if (XR) {
                console.debug("[Meta-Fill] XR present – trying ExifReader…");
                try {
                    const tags = XR.load(buf);
                    console.debug("[Meta-Fill]   ExifReader returned", Object.keys(tags).length, "tags");
                    for (const t of Object.values(tags)) {
                        let str = (typeof t.description === "string") ? t.description : "";
                        if (!str) str = decodeUser(t.value);
                        if (str && str.length < 120) console.debug("[Meta-Fill]   tag:", str.replace(/\n/g,"↵"));
                        if (str.includes("Steps:")) {
                            console.debug("[Meta-Fill] ✓ found Steps: in ExifReader tag");
                            return str;
                        }
                    }
                    console.debug("[Meta-Fill]   ExifReader tags checked, none contained Steps:");
                } catch (e) {
                    console.warn("[Meta-Fill] ExifReader threw", e);
                }
            } else {
                console.debug("[Meta-Fill] XR is undefined – skipping ExifReader");
            }

            /* fall back to manual JPEG scan */
            const manual = readUserCommentManually(buf);
            if (manual) console.debug("[Meta-Fill] ✓ manual scanner succeeded");
            else        console.debug("[Meta-Fill] ✗ manual scanner found nothing");
            return manual;
        }

        /* ------------------------------------------------------------------ */
        /* manual JPEG UserComment extractor                                  */
        /* ------------------------------------------------------------------ */
        function readUserCommentManually(buf) {
            const dv = new DataView(buf);
            if (dv.getUint16(0) !== 0xffd8) {
                console.debug("[Meta-Fill] manual: not a JPEG");
                return null;
            }
            let p = 2;
            while (p < dv.byteLength) {
                if (dv.getUint8(p++) !== 0xff) {
                    console.debug("[Meta-Fill] manual: desync at", p);
                    break;
                }
                let marker = dv.getUint8(p++);
                while (marker === 0xff) marker = dv.getUint8(p++);
                const len   = dv.getUint16(p); p += 2;
                if (marker === 0xd9 || marker === 0xda) break;          // EOI / SOS
                if (marker === 0xe1 && dv.getUint32(p) === 0x45786966) { // "Exif"
                    console.debug("[Meta-Fill] manual: found APP1 Exif at", p-4);
                    const view   = new DataView(buf, p + 6);
                    const le     = view.getUint16(0) === 0x4949;          // II = LE
                    const ifd0   = view.getUint32(4, le);
                    const entries= view.getUint16(ifd0, le);
                    console.debug("[Meta-Fill] manual: TIFF endian", le?"LE":"BE",
                                  "IFD0 entries", entries);
                    for (let i = 0; i < entries; i++) {
                        const entry = ifd0 + 2 + i * 12;
                        const tag   = view.getUint16(entry, le);
                        if (tag === 0x8769) {                               // ExifOffset
                            const exifOff = view.getUint32(entry + 8, le);
                            const subCnt  = view.getUint16(exifOff, le);
                            console.debug("[Meta-Fill] manual: Exif IFD entries", subCnt);
                            for (let j = 0; j < subCnt; j++) {
                                const e2   = exifOff + 2 + j * 12;
                                const tag2 = view.getUint16(e2, le);
                                if (tag2 === 0x9286) {                          // UserComment
                                    const cnt = view.getUint32(e2 + 4, le);
                                    const off = view.getUint32(e2 + 8, le);
                                    const data = new Uint8Array(buf, p + 6 + off, cnt);
                                    const prefix = new TextDecoder("ascii").decode(data.slice(0, 8));
                                    let txt;
                                    if (prefix.startsWith("UNICODE")) {
                                        txt = new TextDecoder("utf-16be").decode(data.slice(8));
                                    } else if (prefix.startsWith("ASCII")) {
                                        txt = new TextDecoder().decode(data.slice(8));
                                    } else {
                                        txt = new TextDecoder().decode(data);
                                    }
                                    console.debug("[Meta-Fill] manual: UserComment prefix", prefix.trim());
                                    if (txt.includes("Steps:")) return txt;
                                }
                            }
                        }
                    }
                }
                p += len - 2;
            }
            return null;
        }


        /* -- 6c raw fallback ---------------------------------------------- */
        function extractRAW(buf){
            const s = new TextDecoder("latin1").decode(buf);
            const i = s.indexOf("Steps:");
            return i >= 0 ? s.slice(Math.max(0,i-2500), Math.min(s.length,i+2500)) : null;
        }

        /* ------------------------------------------------------------------ */
        /* 7. parse Stable-Diffusion block                                    */
        /* ------------------------------------------------------------------ */
        function parseSD(txt) {
            // normalise NULs and CR/LF
            const c = txt.replace(/\u0000/g, '').replace(/\r\n/g, '\n');

            // ---- prompt ------------------------------------------------------
            let prompt = '';
            const negIdx = c.indexOf('Negative prompt:');
            const stepIdx = c.indexOf('Steps:');

            if (negIdx !== -1) {
                prompt = c.slice(0, negIdx).trim();
            } else if (stepIdx !== -1) {
                prompt = c.slice(0, stepIdx).trim();         // no negative prompt tag
            }

            // clean leading commas / stray punctuation
            prompt = prompt.replace(/^[,\s]+/, '');

            // ---- negative prompt (may be absent) ----------------------------
            let neg = '';
            if (negIdx !== -1 && stepIdx !== -1 && stepIdx > negIdx) {
                neg = c.slice(negIdx + 16, stepIdx).trim();  // 16 = length of 'Negative prompt:'
            }

            // convenient helper
            const grab = n => {
                const m = c.match(new RegExp(`${n}:\\s*([^,\\n]+)`));
                return m ? m[1].trim() : '';
            };

            // ---- fields ------------------------------------------------------
            const steps   = grab('Steps');
            const cfg     = grab('CFG scale') || grab('Guidance scale');
            const sampler = grab('Sampler');              // ignore Schedule type completely
            const seed    = grab('Seed');

            return { prompt, neg, steps, cfg, sampler, seed };
        }

        /* ------------------------------------------------------------------ */
        /* 8. write into the form                                             */
        /* ------------------------------------------------------------------ */
        const setNativeValue = (el, val) => {
            const prototype = Object.getPrototypeOf(el);
            const setter = Object.getOwnPropertyDescriptor(
                prototype, 'value').set;
            setter.call(el, val);                 // ① native setter (triggers React)
        };

        function putSelect(selector, value) {
            if (!value) return;

            const input = document.querySelector(selector);
            if (!input) return;

            const hidden = document.querySelector('input[type="hidden"][name="sampler"]');
            if (hidden && hidden.value === value && input.value === value) return;

            input.focus();

            setNativeValue(input, '');
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));

            input.dispatchEvent(new KeyboardEvent('keydown', {
                key: 'ArrowDown',
                code: 'ArrowDown',
                which: 40,
                keyCode: 40,
                bubbles: true,
                cancelable: true,
            }));

            setTimeout(() => {
                setNativeValue(input, value);
                input.dispatchEvent(new Event('input', { bubbles: true }));

                let tries = 0;
                const max = 30;

                const tryClick = () => {
                    const opts = [...document.querySelectorAll('[role="option"]')];
                    const row = opts.find(o => o.textContent.trim() === value);

                    if (row) {
                        row.scrollIntoView({ block: 'nearest' });

                        row.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
                        row.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
                        row.click();
                        row.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
                        row.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

                        setTimeout(() => {
                            setNativeValue(input, value);
                            input.dispatchEvent(new Event('input', { bubbles: true }));
                            input.dispatchEvent(new Event('change', { bubbles: true }));

                            const hiddenNow = document.querySelector('input[type="hidden"][name="sampler"]');
                            if (hiddenNow) {
                                setNativeValue(hiddenNow, value);
                                hiddenNow.dispatchEvent(new Event('input', { bubbles: true }));
                                hiddenNow.dispatchEvent(new Event('change', { bubbles: true }));
                            }

                            input.blur();
                            console.debug('[Meta-Fill] Sampler committed:', value);
                        }, 80);

                    } else if (++tries < max) {
                        setTimeout(tryClick, 75);
                    } else {
                        console.warn('[Meta-Fill] Sampler option not found:', value);
                    }
                };

                tryClick();
            }, 120);
        }




        function put(selector, val) {
            if (!val) return;
            const el = document.querySelector(selector);
            if (!el)  return;

            setNativeValue(el, val);

            // ② fire both events – Mantine listens to one or the other
            el.dispatchEvent(new Event('input',  { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
        }
        function fillForm(o){
            put("#input_prompt",         o.prompt);
            put("#input_negativePrompt", o.neg);
            put("#input_steps",          o.steps);
            put("#input_cfgScale",       o.cfg);
            putSelect("#input_sampler",        o.sampler);
            put("#input_seed",           o.seed);
        }
    })();  // end IIFE
}

runScriptIfMatch();

let lastUrl = location.href;
new MutationObserver(() => {
    if (location.href !== lastUrl) {
        lastUrl = location.href;
        window._metaFillInit = false;
        runScriptIfMatch();
    }
}).observe(document.body, { childList: true, subtree: true });
