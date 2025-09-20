// ==UserScript==
// @name         Grok Imagine - Auto Image Downloader
// @namespace    alexds9.scripts
// @version      1.9
// @description  Auto-download finals; skip previews via Grok EXIF; bind nearest prompt chip; write Signature to XP Comment and Prompt+info to User Comment; dedupe; Ctrl+Shift+S toggle
// @author       Alex
// @match        https://grok.com/imagine*
// @grant        GM_download
// @grant        GM_registerMenuCommand
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_notification
// @grant        GM_addStyle
// @require      https://cdn.jsdelivr.net/npm/exifr@7.1.3/dist/lite.umd.js
// @require      https://cdn.jsdelivr.net/npm/piexifjs@1.0.6/piexif.js
// ==/UserScript==
(function () {
  "use strict";

  // Prompt chip selectors (generator and viewer chips)
  const PROMPT_SELECTOR_GEN  = "div.border.border-border-l2.bg-surface-l1.rounded-3xl";
  const PROMPT_SELECTOR_VIEW = "div.border.border-border-l2.bg-surface-l1.truncate.rounded-full";
  const PROMPT_SELECTOR = `${PROMPT_SELECTOR_GEN}, ${PROMPT_SELECTOR_VIEW}`;

  // Behavior
  const STATE_KEY = "grok_auto_on";
  const SEEN_BYTES_KEY = "grok_seen_sha1_v1";
  const MAX_WAIT_MS = 20000;
  const SCAN_INTERVAL_MS = 1500;

  // Filename prompt slug
  const INCLUDE_PROMPT_IN_NAME = true;
  const PROMPT_SLUG_MAX = 50;

  let autoOn = GM_getValue(STATE_KEY, false);
  let seenArr = GM_getValue(SEEN_BYTES_KEY, []);
  let seen = new Set(seenArr);
  let lastSeenPrompt = "";

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

  const mo = new MutationObserver(() => {
    const chips = document.querySelectorAll(PROMPT_SELECTOR);
    if (chips.length) lastSeenPrompt = normText(chips[chips.length - 1].textContent || "");
    if (autoOn) scanImages();
  });
  mo.observe(document.documentElement, { childList: true, subtree: true, attributes: true });

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
    const obs = new MutationObserver(async (muts) => {
      for (const m of muts) {
        if (m.type === "attributes" && m.attributeName === "src") {
          try { await tryDownloadIfFinal(imgEl); } catch (e) { console.warn("check final failed:", e); }
        }
      }
    });
    obs.observe(imgEl, { attributes: true, attributeFilter: ["src"] });

    await tryDownloadIfFinal(imgEl);

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
    const m = src.match(/^data:image\/(jpeg|jpg|png);base64,(.*)$/i);
    if (!m) return;

    const mime = m[1].toLowerCase();
    const b64 = m[2];
    if (b64.length < 80000) return; // quick skip tiny placeholders

    const bytes = b64ToUint8Array(b64);

    // Require Grok EXIF so we do not grab blurred previews
    let meta = {};
    try { meta = await exifr.parse(bytes.buffer, { userComment: true }); } catch {}
    if (!isGrokFinal(meta)) return;

    const sha1 = await sha1Hex(bytes);
    if (seen.has(sha1)) { imgEl.dataset.grokDone = "1"; return; }

    // Prompt: nearest visible chip around this image
    const prompt = getPromptNearestToImage(imgEl) || lastSeenPrompt || "";

    // Filename
    const sig = extractSignature(meta);
    const artist = typeof meta?.Artist === "string" ? meta.Artist.trim() : "";
    const stamp = isoStamp(new Date());
    const dims = dimString(imgEl, meta);
    const short = sig ? "sig" + sig.slice(0, 10) : "h" + sha1.slice(0, 10);
    const slug = INCLUDE_PROMPT_IN_NAME && prompt ? "p_" + safeSlug(prompt, PROMPT_SLUG_MAX) : null;
    const filename = ["grok", stamp, short, dims, slug].filter(Boolean).join("_") + ".jpg";

    seen.add(sha1); persistSeen();

    // Inject: XP Comment = Signature, User Comment = Prompt + Size + Artist + Page + SHA1
    let outUrl = src;
    if (mime === "jpeg" || mime === "jpg") {
      try {
        outUrl = injectMetaIntoJpeg(src, {
          signature: sig || "",
          prompt: prompt || "",
          dims: dims || "",
          artist: artist || "",
          pageUrl: location.href,
          sha1: sha1
        });
      } catch (e) {
        console.warn("EXIF inject failed, downloading original:", e);
      }
    }

    await new Promise((resolve, reject) => {
      GM_download({ url: outUrl, name: filename, saveAs: false, onload: resolve, onerror: e => reject(e?.error || "download error"), ontimeout: () => reject("timeout") });
    });
    imgEl.dataset.grokDone = "1";
    console.log("[Grok downloader] saved", filename);
  }

  // Prefer nearest chip by geometry, bias to chips above the image
  function getPromptNearestToImage(imgEl) {
    const chips = collectNearbyChips(imgEl, 6);
    if (!chips.length) return "";
    const irect = safeRect(imgEl);
    chips.sort((a, b) => {
      const ra = safeRect(a), rb = safeRect(b);
      const da = Math.abs((ra.top + ra.bottom) / 2 - (irect.top + irect.bottom) / 2);
      const db = Math.abs((rb.top + rb.bottom) / 2 - (irect.top + irect.bottom) / 2);
      const biasA = ra.bottom <= irect.top ? 0 : 20;
      const biasB = rb.bottom <= irect.top ? 0 : 20;
      return (da + biasA) - (db + biasB);
    });
    return normText(chips[0].textContent || "");
  }
  function collectNearbyChips(node, maxAncestorHops) {
    const arr = [];
    let cur = node, hops = 0;
    while (cur && hops < maxAncestorHops) {
      cur.querySelectorAll?.(PROMPT_SELECTOR)?.forEach(el => { if (isVisible(el)) arr.push(el); });
      let sib = cur.previousElementSibling;
      while (sib) {
        if (sib.matches?.(PROMPT_SELECTOR) && isVisible(sib)) arr.push(sib);
        sib.querySelectorAll?.(PROMPT_SELECTOR)?.forEach(el => { if (isVisible(el)) arr.push(el); });
        sib = sib.previousElementSibling;
      }
      sib = cur.nextElementSibling;
      while (sib) {
        if (sib.matches?.(PROMPT_SELECTOR) && isVisible(sib)) arr.push(sib);
        sib.querySelectorAll?.(PROMPT_SELECTOR)?.forEach(el => { if (isVisible(el)) arr.push(el); });
        sib = sib.nextElementSibling;
      }
      cur = cur.parentElement; hops++;
    }
    if (!arr.length) document.querySelectorAll(PROMPT_SELECTOR).forEach(el => { if (isVisible(el)) arr.push(el); });
    return Array.from(new Set(arr));
  }
  function isVisible(el) {
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || cs.opacity === "0") return false;
    const r = el.getBoundingClientRect();
    return r.width > 1 && r.height > 1;
  }
  function safeRect(el) { try { return el.getBoundingClientRect(); } catch { return { top: 0, bottom: 0 }; } }

  // Final vs preview: require Grok EXIF
  function isGrokFinal(meta) {
    if (!meta || typeof meta !== "object") return false;
    const id = meta.ImageDescription || "";
    const uc = meta.UserComment || "";
    const art = meta.Artist || "";
    const hasSig = /Signature:\s*[A-Za-z0-9+/=]+/.test(id) || /Signature:\s*[A-Za-z0-9+/=]+/.test(uc);
    const hasArtist = typeof art === "string" && art.trim().length > 0;
    return hasSig || hasArtist;
  }
  function extractSignature(meta) {
    const id = meta?.ImageDescription;
    const uc = meta?.UserComment;
    const m = (typeof id === "string" && id.match(/Signature:\s*([A-Za-z0-9+/=]+)/)) ||
              (typeof uc === "string" && uc.match(/Signature:\s*([A-Za-z0-9+/=]+)/));
    return m ? m[1] : null;
  }

  // Inject EXIF: XP Comment = Signature (UCS-2 LE), User Comment = Prompt + info (ASCII header)
  function injectMetaIntoJpeg(dataUrl, info) {
    if (!window.piexif) throw new Error("piexifjs not loaded");
    const exifObj = piexif.load(dataUrl);
    exifObj["0th"] = exifObj["0th"] || {};
    exifObj["Exif"] = exifObj["Exif"] || {};

    // 1) XP Comment holds the Signature
    if (info.signature) {
      const XPComment = 0x9C9C; // 40092
      exifObj["0th"][XPComment] = toUcs2Bytes(`Signature: ${info.signature}`);
    }

    // 2) User Comment holds Prompt + Size + Artist + Page + SHA1
    const parts = [];
    if (info.prompt) parts.push(`${info.prompt}`);
    parts.push(`\nNegative prompt: bad quality, poor quality, disfigured, jpg, toy, bad anatomy, missing limbs, missing fingers, ugly, scary, watermark\n`);
    if (info.dims) parts.push(`Size: ${info.dims}`);
    if (info.artist) parts.push(`Artist: ${info.artist}`);
    if (info.pageUrl) parts.push(`Page: ${info.pageUrl}`);
    if (info.sha1) parts.push(`SHA1: ${String(info.sha1).slice(0, 16)}`);

    const ucText = parts.join(", ");
    if (ucText) {
      const tag = piexif.ExifIFD.UserComment; // 0x9286
      // ASCII header as per EXIF spec: "ASCII\0\0\0" + text
      exifObj["Exif"][tag] = "ASCII\0\0\0" + ucText;
    }

    const exifBytes = piexif.dump(exifObj);
    return piexif.insert(exifBytes, dataUrl);
  }

  // Encode UCS-2 LE with NUL terminator for XP* fields
  function toUcs2Bytes(str) {
    const s = String(str || "");
    const arr = [];
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      arr.push(c & 0xFF, (c >> 8) & 0xFF);
    }
    arr.push(0x00, 0x00);
    return arr;
  }

  // Text and utils
  function normText(s) { return String(s).replace(/\s+/g, " ").trim(); }
  function safeSlug(s, max = 50) {
    const norm = normText(s).slice(0, max);
    return norm.replace(/[^a-zA-Z0-9 _.-]/g, "").trim().replace(/\s+/g, "_");
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
