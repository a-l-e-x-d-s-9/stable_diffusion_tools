// ==UserScript==
// @name         Grok Imagine - Auto Image Downloader
// @namespace    alexds9.scripts
// @version      1.4
// @description  Auto-download final images on grok.com/imagine; skip blurred previews by requiring Grok EXIF metadata; toggle with Ctrl+Shift+S
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

  // Settings
  const STATE_KEY = "grok_auto_on";
  const SEEN_BYTES_KEY = "grok_seen_sha1_v1";
  const MAX_WAIT_MS = 20000;    // stop watching an <img> after this
  const SCAN_INTERVAL_MS = 1500;

  let autoOn = GM_getValue(STATE_KEY, false);
  let seenArr = GM_getValue(SEEN_BYTES_KEY, []);
  let seen = new Set(seenArr);

  // UI badge
  GM_addStyle(`#grok-auto-indicator{position:fixed;top:10px;right:10px;z-index:999999;background:rgba(20,20,24,.9);color:#fff;padding:6px 10px;border-radius:8px;font:12px/1.2 system-ui,Segoe UI,Roboto,Ubuntu,Arial;box-shadow:0 2px 10px rgba(0,0,0,.25);pointer-events:none;user-select:none}`);
  const indicator = document.createElement("div");
  indicator.id = "grok-auto-indicator";
  document.documentElement.appendChild(indicator);
  updateIndicator();

  GM_registerMenuCommand("Toggle auto-download (Ctrl+Shift+S)", toggleAuto);
  document.addEventListener("keydown", (e) => {
    if (e.ctrlKey && e.shiftKey && e.code === "KeyS") { e.preventDefault(); toggleAuto(); }
  });

  const mo = new MutationObserver(() => { if (autoOn) scanImages(); });
  mo.observe(document.documentElement, { childList: true, subtree: true });
  setInterval(() => autoOn && scanImages(), SCAN_INTERVAL_MS);
  if (autoOn) scanImages();

  function toggleAuto() {
    autoOn = !autoOn;
    GM_setValue(STATE_KEY, autoOn);
    try { GM_notification({ title: "Grok downloader", text: `Auto-download ${autoOn ? "ON" : "OFF"}`, timeout: 1200 }); } catch {}
    updateIndicator();
    if (autoOn) scanImages();
  }
  function updateIndicator() { indicator.textContent = `Grok auto-download: ${autoOn ? "ON" : "OFF"}`; }

  function scanImages() {
    const q = 'img[alt="Generated image"], img[src^="data:image/"]';
    document.querySelectorAll(q).forEach(img => {
      if (img.dataset.grokWatching === "1" || img.dataset.grokDone === "1") return;
      img.dataset.grokWatching = "1";
      watchImg(img).catch(err => { console.warn("watchImg error:", err); delete img.dataset.grokWatching; });
    });
  }

  async function watchImg(imgEl) {
    const start = Date.now();
    // Observe src changes so we can re-check when preview swaps to final
    const obs = new MutationObserver(async (muts) => {
      for (const m of muts) {
        if (m.type === "attributes" && m.attributeName === "src") {
          try { await tryDownloadIfFinal(imgEl); } catch (e) { console.warn("check final failed:", e); }
        }
      }
    });
    obs.observe(imgEl, { attributes: true, attributeFilter: ["src"] });

    // Immediate check in case final is already present
    await tryDownloadIfFinal(imgEl);

    // Stop watching after timeout or after success
    const timer = setInterval(async () => {
      if (imgEl.dataset.grokDone === "1" || Date.now() - start > MAX_WAIT_MS) {
        obs.disconnect();
        clearInterval(timer);
        delete imgEl.dataset.grokWatching;
      } else if (autoOn) {
        await tryDownloadIfFinal(imgEl);
      }
    }, 600);
  }

  async function tryDownloadIfFinal(imgEl) {
    if (!autoOn || imgEl.dataset.grokDone === "1") return;

    const src = imgEl.getAttribute("src") || "";
    if (!/^data:image\/(jpeg|jpg|png);base64,/.test(src)) return;

    const b64 = src.slice(src.indexOf("base64,") + 7);
    // Quick reject of tiny placeholders without parsing EXIF
    if (b64.length < 80000) return;

    const bytes = b64ToUint8Array(b64);

    // Parse EXIF and accept only if Grok metadata is present
    let meta = {};
    try { meta = await exifr.parse(bytes.buffer, { userComment: true }); } catch {}
    if (!isGrokFinal(meta)) return;   // hard filter: skip blurred previews

    // Deduplicate by content hash
    const sha1 = await sha1Hex(bytes);
    if (seen.has(sha1)) { imgEl.dataset.grokDone = "1"; return; }

    const sig = extractSignature(meta);
    const stamp = isoStamp(new Date());
    const dims = dimString(imgEl, meta);
    const short = sig ? "sig" + sig.slice(0, 10) : "h" + sha1.slice(0, 10);
    const filename = ["grok", stamp, short, dims].filter(Boolean).join("_") + ".jpg";

    seen.add(sha1);
    persistSeen();

    await new Promise((resolve, reject) => {
      GM_download({ url: src, name: filename, saveAs: false, onload: resolve, onerror: e => reject(e?.error || "download error"), ontimeout: () => reject("timeout") });
    });

    imgEl.dataset.grokDone = "1";
    console.log("[Grok downloader] saved", filename);
  }

  // Final vs preview decision: require Grok metadata fields
  function isGrokFinal(meta) {
    if (!meta || typeof meta !== "object") return false;
    const id = meta.ImageDescription || "";
    const uc = meta.UserComment || "";
    const art = meta.Artist || "";
    const hasSig = /Signature:\s*[A-Za-z0-9+/=]+/.test(id) || /Signature:\s*[A-Za-z0-9+/=]+/.test(uc);
    const hasArtist = typeof art === "string" && art.trim().length > 0;
    // You said finals always have these, previews have none
    return hasSig || hasArtist;
  }

  function extractSignature(meta) {
    const id = meta?.ImageDescription;
    const uc = meta?.UserComment;
    const match = (typeof id === "string" && id.match(/Signature:\s*([A-Za-z0-9+/=]+)/)) ||
                  (typeof uc === "string" && uc.match(/Signature:\s*([A-Za-z0-9+/=]+)/));
    return match ? match[1] : null;
  }

  function dimString(imgEl, meta) {
    const w = imgEl?.naturalWidth || meta?.ExifImageWidth || meta?.ImageWidth;
    const h = imgEl?.naturalHeight || meta?.ExifImageHeight || meta?.ImageHeight;
    return (w && h) ? `${w}x${h}` : null;
  }

  function isoStamp(d) {
    const p = n => String(n).padStart(2, "0");
    return `${d.getFullYear()}${p(d.getMonth()+1)}${p(d.getDate())}T${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
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

  function persistSeen() {
    if (seen.size > 2000) {
      const trimmed = Array.from(seen).slice(-2000);
      seen = new Set(trimmed);
      GM_setValue(SEEN_BYTES_KEY, trimmed);
    } else {
      GM_setValue(SEEN_BYTES_KEY, Array.from(seen));
    }
  }
})();
