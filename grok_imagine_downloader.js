// ==UserScript==
// @name         Grok Imagine - Auto Image Downloader
// @namespace    alexds9.scripts
// @version      1.2
// @description  Auto-download new generated images on grok.com/imagine; dedupe; toggle with Ctrl+Shift+S; avoid blurred placeholders
// @author       Alex
// @match        https://grok.com/imagine*
// @grant        GM_download
// @grant        GM_registerMenuCommand
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_notification
// @grant        GM_addStyle
// @require      https://cdn.jsdelivr.net/npm/exifr@7.1.3/dist/lite.umd.js
// ==/UserScript==

(function () {
  "use strict";

  // Tunables
  const STABLE_MS = 2200;        // require this much time with no data-length change
  const MAX_WAIT_MS = 20000;     // stop waiting after this and take best seen
  const MIN_BYTES = 220000;      // treat smaller data-urls as likely blurred placeholders
  const SCAN_INTERVAL_MS = 1500; // light periodic sweep
  const ANCESTOR_BLUR_DEPTH = 6; // how many parents to check for blur filters

  const STATE_KEY = "grok_auto_on";
  const SEEN_KEY = "grok_seen_hashes_v1";
  const MAX_SEEN = 2000;

  let autoOn = GM_getValue(STATE_KEY, false);
  let seenArr = GM_getValue(SEEN_KEY, []);
  let seen = new Set(seenArr);

  GM_addStyle(`
    #grok-auto-indicator{
      position:fixed;top:10px;right:10px;z-index:999999;background:rgba(20,20,24,.9);
      color:#fff;padding:6px 10px;border-radius:8px;font:12px/1.2 system-ui,Segoe UI,Roboto,Ubuntu,Arial;
      box-shadow:0 2px 10px rgba(0,0,0,.25);pointer-events:none;user-select:none
    }`);
  const indicator = document.createElement("div");
  indicator.id = "grok-auto-indicator";
  document.documentElement.appendChild(indicator);
  updateIndicator();

  GM_registerMenuCommand("Toggle auto-download (Ctrl+Shift+S)", toggleAuto);
  document.addEventListener("keydown", (e) => {
    if (e.ctrlKey && e.shiftKey && e.code === "KeyS") {
      e.preventDefault(); toggleAuto();
    }
  });

  const mo = new MutationObserver(() => { if (autoOn) scanImages(); });
  mo.observe(document.documentElement, { childList: true, subtree: true });
  setInterval(() => autoOn && scanImages(), SCAN_INTERVAL_MS);

  function toggleAuto() {
    autoOn = !autoOn;
    GM_setValue(STATE_KEY, autoOn);
    notify(`Grok auto-download ${autoOn ? "ON" : "OFF"}`);
    updateIndicator();
    if (autoOn) scanImages();
  }
  function updateIndicator() {
    indicator.textContent = `Grok auto-download: ${autoOn ? "ON" : "OFF"}`;
  }
  function notify(text) {
    try { GM_notification({ title: "Grok downloader", text, timeout: 1500 }); } catch {}
    console.log("[Grok downloader]", text);
  }

  function scanImages() {
    const q = 'img[alt="Generated image"][src^="data:image/"], img[src^="data:image/"]';
    document.querySelectorAll(q).forEach(img => {
      if (img.dataset.grokWatching === "1") return;
      img.dataset.grokWatching = "1";
      waitForFinal(img).catch(err => {
        console.warn("waitForFinal error:", err);
        delete img.dataset.grokWatching;
      });
    });
  }

  async function waitForFinal(imgEl) {
    // We watch both src and class changes; Grok may drop blur via classes on ancestors
    const record = {
      lastLen: -1,
      lastStableAt: 0,
      bestSrc: null,
      bestLen: 0
    };

    const attrObs = new MutationObserver(() => {
      // any attribute change resets stability timer if data length changed
      const src = imgEl.getAttribute("src") || "";
      if (!/^data:image\/(jpeg|jpg|png);base64,/.test(src)) return;
      const len = estimateBytesFromB64(src.slice(src.indexOf("base64,") + 7));
      if (len !== record.lastLen) {
        record.lastLen = len;
        record.lastStableAt = Date.now();
      }
      if (len > record.bestLen) { record.bestLen = len; record.bestSrc = src; }
    });
    attrObs.observe(imgEl, { attributes: true, attributeFilter: ["src", "class", "style"] });

    // seed values
    const initSrc = imgEl.getAttribute("src") || "";
    if (/^data:image\/(jpeg|jpg|png);base64,/.test(initSrc)) {
      record.lastLen = estimateBytesFromB64(initSrc.slice(initSrc.indexOf("base64,") + 7));
      record.bestLen = record.lastLen; record.bestSrc = initSrc; record.lastStableAt = Date.now();
    }

    const start = Date.now();
    while (Date.now() - start < MAX_WAIT_MS) {
      if (!autoOn) { await sleep(250); continue; }

      const src = imgEl.getAttribute("src") || "";
      if (!/^data:image\/(jpeg|jpg|png);base64,/.test(src)) { await sleep(120); continue; }

      // if ancestor blur exists, keep waiting
      if (hasAncestorBlur(imgEl, ANCESTOR_BLUR_DEPTH)) { await sleep(120); continue; }

      // stable enough and large enough
      const stableFor = Date.now() - record.lastStableAt;
      const currentLen = estimateBytesFromB64(src.slice(src.indexOf("base64,") + 7));
      const bigEnough = currentLen >= MIN_BYTES;

      if (stableFor >= STABLE_MS && bigEnough) {
        attrObs.disconnect();
        await handleImage(src, imgEl);
        return;
      }

      // track best seen src in case we timeout
      if (currentLen > record.bestLen) { record.bestLen = currentLen; record.bestSrc = src; }
      await sleep(120);
    }

    // timeout - use the best we saw that clears blur, but still respect dedupe
    try { attrObs.disconnect(); } catch {}
    const finalSrc = !hasAncestorBlur(imgEl, ANCESTOR_BLUR_DEPTH) && record.bestSrc ? record.bestSrc : imgEl.getAttribute("src");
    if (finalSrc && /^data:image\//.test(finalSrc)) {
      await handleImage(finalSrc, imgEl);
    }
  }

  function hasAncestorBlur(el, depth) {
    let n = 0, cur = el;
    while (cur && n < depth) {
      const cs = getComputedStyle(cur);
      if ((cs.filter && cs.filter.includes("blur(")) || (cs.backdropFilter && cs.backdropFilter.includes("blur("))) return true;
      cur = cur.parentElement; n++;
    }
    return false;
  }

  async function handleImage(dataUrl, imgEl) {
    if (imgEl.dataset.grokDownloaded === "1") return;
    imgEl.dataset.grokDownloaded = "1";

    const b64 = dataUrl.slice(dataUrl.indexOf("base64,") + 7);
    const bytes = b64ToUint8Array(b64);
    const hash = await sha1Hex(bytes);
    if (seen.has(hash)) return;

    // Parse EXIF for signature if present
    let meta = {};
    try { meta = await exifr.parse(bytes.buffer, { userComment: true }); } catch {}
    const sig = extractSignature(meta);

    const stamp = isoStamp(new Date());
    const dims = dimString(imgEl, meta);
    const short = (sig ? "sig" + sig.slice(0, 10) : "h" + hash.slice(0, 10));
    const filename = ["grok", stamp, short, dims].filter(Boolean).join("_") + ".jpg";

    seen.add(hash);
    if (seen.size > MAX_SEEN) {
      const trimmed = Array.from(seen).slice(-MAX_SEEN);
      seen = new Set(trimmed);
      GM_setValue(SEEN_KEY, trimmed);
    } else {
      GM_setValue(SEEN_KEY, Array.from(seen));
    }

    await new Promise((resolve, reject) => {
      GM_download({
        url: dataUrl,
        name: filename,
        saveAs: false,
        onload: resolve,
        onerror: (e) => reject(e && (e.error || "unknown error")),
        ontimeout: () => reject("timeout")
      });
    });
    console.log("[Grok downloader] saved", filename);
  }

  function extractSignature(meta) {
    if (!meta) return null;
    for (const key of ["ImageDescription", "UserComment", "Artist"]) {
      const val = meta[key];
      if (typeof val === "string" && val) {
        const m = val.match(/Signature:\s*([A-Za-z0-9+/=]+)/);
        if (m && m[1]) return m[1];
      }
    }
    return null;
  }

  function dimString(imgEl, meta) {
    const w = imgEl?.naturalWidth || meta?.ExifImageWidth || meta?.ImageWidth;
    const h = imgEl?.naturalHeight || meta?.ExifImageHeight || meta?.ImageHeight;
    return (w && h) ? `${w}x${h}` : null;
  }

  function isoStamp(d) {
    const pad = n => String(n).padStart(2, "0");
    return `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}T${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  }

  function estimateBytesFromB64(b64) {
    const pad = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
    return Math.floor(b64.length * 3 / 4) - pad;
  }
  function b64ToUint8Array(b64) {
    const bin = atob(b64), len = bin.length, out = new Uint8Array(len);
    for (let i = 0; i < len; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  async function sha1Hex(uint8) {
    const buf = await crypto.subtle.digest("SHA-1", uint8);
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
  }
  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
})();
