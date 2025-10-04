// ==UserScript==
// @name         Grok Imagine - Auto Image & Video Downloader
// @namespace    alexds9.scripts
// @version      2.0
// @description  Auto-download finals (images & videos); skip previews via Grok signature; bind nearest prompt chip; write prompt to JPEG EXIF; sidecar for MP4; dedupe; Ctrl+Shift+S toggle
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

  // ---------- Config ----------
  // Prompt chips (generator + viewer)
  const PROMPT_SELECTOR_GEN  = "div.border.border-border-l2.bg-surface-l1.rounded-3xl";
  const PROMPT_SELECTOR_VIEW = "div.border.border-border-l2.bg-surface-l1.truncate.rounded-full";
  const PROMPT_SELECTOR = `${PROMPT_SELECTOR_GEN}, ${PROMPT_SELECTOR_VIEW}`;

  // Behavior
  const STATE_KEY           = "grok_auto_on";
  const SEEN_IMG_BYTES_KEY  = "grok_seen_sha1_v1";
  const SEEN_VID_BYTES_KEY  = "grok_seen_vid_sha1_v1";
  const SEEN_VID_URL_KEY    = "grok_seen_vid_urls_v1";
  const MAX_WAIT_MS         = 20000;
  const SCAN_INTERVAL_MS    = 1500;

  // Filenames
  const INCLUDE_PROMPT_IN_NAME = true;
  const PROMPT_SLUG_MAX        = 50;

  // Heuristics
  const QUICK_SKIP_IMG_B64LEN  = 80000;  // tiny data-URL images => skip
  const QUICK_SKIP_VID_B64LEN  = 120000; // tiny data-URL videos => skip
  const TRUST_HTTPS_VIDEO       = true;   // assume https videos from grok.com are finals

  // ---------- State ----------
  let autoOn = GM_getValue(STATE_KEY, false);
  let seenImgArr = GM_getValue(SEEN_IMG_BYTES_KEY, []);
  let seenVidArr = GM_getValue(SEEN_VID_BYTES_KEY, []);
  let seenVidUrlArr = GM_getValue(SEEN_VID_URL_KEY, []);
  let seenImg = new Set(seenImgArr);
  let seenVid = new Set(seenVidArr);     // SHA-1 of video bytes
  let seenVidUrls = new Set(seenVidUrlArr); // URL-based dedupe fallback
  let lastSeenPrompt = "";

  // ---------- UI ----------
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
    if (autoOn) { scanImages(); scanVideos(); }
  });
  mo.observe(document.documentElement, { childList: true, subtree: true, attributes: true });

  setInterval(() => { if (autoOn) { scanImages(); scanVideos(); } }, SCAN_INTERVAL_MS);
  if (autoOn) { scanImages(); scanVideos(); }

  function toggleAuto() {
    autoOn = !autoOn;
    GM_setValue(STATE_KEY, autoOn);
    try { GM_notification({ title: "Grok downloader", text: `Auto-download ${autoOn ? "ON" : "OFF"}`, timeout: 1200 }); } catch {}
    updateIndicator();
    if (autoOn) { scanImages(); scanVideos(); }
  }
  function updateIndicator() { indicator.textContent = `Grok auto-download: ${autoOn ? "ON" : "OFF"}`; }

  // ---------- IMAGES (unchanged from your v1.9 behavior) ----------
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
          try { await tryDownloadImageIfFinal(imgEl); } catch (e) { console.warn("check final failed:", e); }
        }
      }
    });
    obs.observe(imgEl, { attributes: true, attributeFilter: ["src"] });
    await tryDownloadImageIfFinal(imgEl);
    const timer = setInterval(async () => {
      if (imgEl.dataset.grokDone === "1" || Date.now() - start > MAX_WAIT_MS) {
        obs.disconnect(); clearInterval(timer); delete imgEl.dataset.grokWatching;
      } else if (autoOn) {
        await tryDownloadImageIfFinal(imgEl);
      }
    }, 600);
  }

  async function tryDownloadImageIfFinal(imgEl) {
    if (!autoOn || imgEl.dataset.grokDone === "1") return;
    const src = imgEl.getAttribute("src") || "";
    const m = src.match(/^data:image\/(jpeg|jpg|png);base64,(.*)$/i);
    if (!m) return;
    const mime = m[1].toLowerCase();
    const b64  = m[2];
    if (b64.length < QUICK_SKIP_IMG_B64LEN) return;

    const bytes = b64ToUint8Array(b64);

    // Require Grok EXIF (skip previews)
    let meta = {};
    try { meta = await exifr.parse(bytes.buffer, { userComment: true }); } catch {}
    if (!isGrokFinal(meta)) return;

    const sha1 = await sha1Hex(bytes);
    if (seenImg.has(sha1)) { imgEl.dataset.grokDone = "1"; return; }

    const prompt = getPromptNearestToNode(imgEl) || lastSeenPrompt || "";
    const sig = extractSignature(meta);
    const artist = typeof meta?.Artist === "string" ? meta.Artist.trim() : "";
    const stamp = isoStamp(new Date());
    const dims  = dimStringFromImage(imgEl, meta);
    const short = sig ? "sig" + sig.slice(0, 10) : "h" + sha1.slice(0, 10);
    const slug  = INCLUDE_PROMPT_IN_NAME && prompt ? "p_" + safeSlug(prompt, PROMPT_SLUG_MAX) : null;
    const filename = ["grok", stamp, short, dims, slug].filter(Boolean).join("_") + ".jpg";

    seenImg.add(sha1); persistSeen();

    // Inject EXIF (XPComment = Signature; UserComment = Prompt + info)
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
        console.warn("JPEG EXIF inject failed; downloading original:", e);
      }
    }

    await new Promise((resolve, reject) => {
      GM_download({ url: outUrl, name: filename, saveAs: false, onload: resolve, onerror: e => reject(e?.error || "download error"), ontimeout: () => reject("timeout") });
    });
    imgEl.dataset.grokDone = "1";
    console.log("[Grok downloader][IMG] saved", filename);
  }

  // ---------- VIDEOS (new) ----------
  function scanVideos() {
    // Watch both <video> and nested <source>
    document.querySelectorAll("video").forEach(v => {
      if (v.dataset.grokWatching === "1" || v.dataset.grokDone === "1") return;
      v.dataset.grokWatching = "1";
      watchVideo(v).catch(err => { console.warn("watchVideo error:", err); delete v.dataset.grokWatching; });
    });
  }

  async function watchVideo(videoEl) {
    const start = Date.now();

    const obsVideo = new MutationObserver(async (muts) => {
      for (const m of muts) {
        if (m.type === "attributes" && (m.attributeName === "src" || m.attributeName === "poster")) {
          try { await tryDownloadVideoIfFinal(videoEl); } catch (e) { console.warn("video final check failed:", e); }
        }
      }
    });
    obsVideo.observe(videoEl, { attributes: true, attributeFilter: ["src", "poster"] });

    // Also track <source> children
    const obsSources = new MutationObserver(async (muts) => {
      for (const m of muts) {
        if (m.type === "attributes" && m.attributeName === "src" && m.target.tagName === "SOURCE") {
          try { await tryDownloadVideoIfFinal(videoEl); } catch (e) { console.warn("video<source> final check failed:", e); }
        }
        if (m.type === "childList") {
          try { await tryDownloadVideoIfFinal(videoEl); } catch {}
        }
      }
    });
    videoEl.querySelectorAll("source").forEach(s => obsSources.observe(s, { attributes: true, attributeFilter: ["src"] }));
    const obsChildren = new MutationObserver(() => {
      obsSources.disconnect();
      videoEl.querySelectorAll("source").forEach(s => obsSources.observe(s, { attributes: true, attributeFilter: ["src"] }));
      try { tryDownloadVideoIfFinal(videoEl); } catch {}
    });
    obsChildren.observe(videoEl, { childList: true, subtree: true });

    // Initial attempt
    await tryDownloadVideoIfFinal(videoEl);

    const timer = setInterval(async () => {
      if (videoEl.dataset.grokDone === "1" || Date.now() - start > MAX_WAIT_MS) {
        obsVideo.disconnect(); obsSources.disconnect(); obsChildren.disconnect();
        clearInterval(timer); delete videoEl.dataset.grokWatching;
      } else if (autoOn) {
        await tryDownloadVideoIfFinal(videoEl);
      }
    }, 800);
  }

  async function tryDownloadVideoIfFinal(videoEl) {
    if (!autoOn || videoEl.dataset.grokDone === "1") return;

    const url = getVideoUrl(videoEl);
    if (!url) return;

    // Dedupe by URL for blob/https fallback
    if (url.startsWith("blob:")) {
      if (seenVidUrls.has(url)) { videoEl.dataset.grokDone = "1"; return; }
      // We cannot read blob: bytes here; best effort: mark once and let user click if needed.
      // We'll trigger a safe anchor download fallback (filename still applied).
      const dims = await videoDims(videoEl);
      const prompt = getPromptNearestToNode(videoEl) || lastSeenPrompt || "";
      const stamp = isoStamp(new Date());
      const short = "u" + hashOfString(url).slice(0, 10);
      const slug  = INCLUDE_PROMPT_IN_NAME && prompt ? "p_" + safeSlug(prompt, PROMPT_SLUG_MAX) : null;
      const filename = ["grokvid", stamp, short, dims.w && dims.h ? `${dims.w}x${dims.h}` : null, slug].filter(Boolean).join("_") + ".mp4";
      anchorDownload(url, filename);
      seenVidUrls.add(url); persistSeen();
      videoEl.dataset.grokDone = "1";
      console.log("[Grok downloader][VID] saved (blob URL via anchor)", filename);
      return;
    }

    if (url.startsWith("data:")) {
      const m = url.match(/^data:video\/mp4;base64,(.*)$/i);
      if (!m) return; // other codecs not handled yet
      const b64 = m[1];
      if (b64.length < QUICK_SKIP_VID_B64LEN) return;

      const bytes = b64ToUint8Array(b64);

      // Require visible "Signature:" text somewhere in the MP4 (Comment atom)
      const signature = findSignatureAscii(bytes); // returns base64 string or null
      if (!signature) return;

      const sha1 = await sha1Hex(bytes);
      if (seenVid.has(sha1)) { videoEl.dataset.grokDone = "1"; return; }

      const dims = await videoDims(videoEl);
      const prompt = getPromptNearestToNode(videoEl) || lastSeenPrompt || "";
      const stamp = isoStamp(new Date());
      const short = "sig" + signature.slice(0, 10);
      const slug  = INCLUDE_PROMPT_IN_NAME && prompt ? "p_" + safeSlug(prompt, PROMPT_SLUG_MAX) : null;
      const sizeStr = dims.w && dims.h ? `${dims.w}x${dims.h}` : null;
      const filename = ["grokvid", stamp, short, sizeStr, slug].filter(Boolean).join("_") + ".mp4";

      seenVid.add(sha1); persistSeen();

      // Download original bytes; also write a sidecar .txt with prompt + identifiers
      await new Promise((resolve, reject) => {
        GM_download({ url, name: filename, saveAs: false, onload: resolve, onerror: e => reject(e?.error || "download error"), ontimeout: () => reject("timeout") });
      });
      await saveVideoSidecar(filename, {
        signature_b64: signature,
        page_url: location.href,
        dims: sizeStr || "",
        sha1: sha1,
        prompt: prompt
      });

      videoEl.dataset.grokDone = "1";
      console.log("[Grok downloader][VID] saved (data URL)", filename);
      return;
    }

    if (url.startsWith("https://")) {
      // If it’s coming from grok.com, we treat it as final (configurable)
      if (!TRUST_HTTPS_VIDEO) return;

      if (seenVidUrls.has(url)) { videoEl.dataset.grokDone = "1"; return; }

      const dims = await videoDims(videoEl);
      const prompt = getPromptNearestToNode(videoEl) || lastSeenPrompt || "";
      const stamp = isoStamp(new Date());
      const short = "u" + hashOfString(url).slice(0, 10);
      const slug  = INCLUDE_PROMPT_IN_NAME && prompt ? "p_" + safeSlug(prompt, PROMPT_SLUG_MAX) : null;
      const sizeStr = dims.w && dims.h ? `${dims.w}x${dims.h}` : null;
      const filename = ["grokvid", stamp, short, sizeStr, slug].filter(Boolean).join("_") + ".mp4";

      // We can try to content-hash by fetching; but cross-origin/cookies may fail.
      // Keep URL-based dedupe for reliability.
      await new Promise((resolve, reject) => {
        GM_download({ url, name: filename, saveAs: false, onload: resolve, onerror: e => reject(e?.error || "download error"), ontimeout: () => reject("timeout") });
      });
      await saveVideoSidecar(filename, {
        signature_b64: "", // unknown without reading bytes
        page_url: location.href,
        dims: sizeStr || "",
        sha1: short.slice(1), // url-hash fragment
        prompt: prompt
      });

      seenVidUrls.add(url); persistSeen();
      videoEl.dataset.grokDone = "1";
      console.log("[Grok downloader][VID] saved (https)", filename);
      return;
    }
  }

  function getVideoUrl(videoEl) {
    // Prefer <video src>, else first <source src>
    const vs = videoEl.getAttribute("src");
    if (vs) return vs;
    const s = videoEl.querySelector("source[src]");
    if (s) return s.getAttribute("src");
    return "";
  }

  async function videoDims(videoEl) {
    if (videoEl.videoWidth && videoEl.videoHeight) return { w: videoEl.videoWidth, h: videoEl.videoHeight };
    await new Promise(res => {
      const on = () => { videoEl.removeEventListener("loadedmetadata", on); res(); };
      videoEl.addEventListener("loadedmetadata", on, { once: true });
      // in case it already loaded
      if (videoEl.readyState >= 1) on();
    });
    return { w: videoEl.videoWidth || 0, h: videoEl.videoHeight || 0 };
  }

  // Returns base64 signature if found in MP4 bytes (Comment atom holds "Signature: ...")
  function findSignatureAscii(uint8) {
    // Decode to string safely in chunks
    const td = new TextDecoder("utf-8");
    const step = 1 << 20; // 1MB chunk (videos are typically a few MB)
    let partial = "";
    for (let i = 0; i < uint8.length; i += step) {
      const slice = uint8.subarray(i, Math.min(uint8.length, i + step));
      partial += td.decode(slice, { stream: i + step < uint8.length });
      const m = partial.match(/Signature:\s*([A-Za-z0-9+/=]+)/);
      if (m && m[1]) return m[1];
      // keep last 100 chars to handle boundary splits
      partial = partial.slice(-100);
    }
    // final flush
    const m = partial.match(/Signature:\s*([A-Za-z0-9+/=]+)/);
    return (m && m[1]) ? m[1] : null;
  }

  // ---------- Prompt chip resolver (shared) ----------
  function getPromptNearestToNode(el) {
    const chips = collectNearbyChips(el, 6);
    if (!chips.length) return "";
    const irect = safeRect(el);
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

  // ---------- JPEG EXIF inject (unchanged) ----------
  function injectMetaIntoJpeg(dataUrl, info) {
    if (!window.piexif) throw new Error("piexifjs not loaded");
    const exifObj = piexif.load(dataUrl);
    exifObj["0th"] = exifObj["0th"] || {};
    exifObj["Exif"] = exifObj["Exif"] || {};

    // XP Comment (Signature)
    if (info.signature) {
      const XPComment = 0x9C9C; // 40092
      exifObj["0th"][XPComment] = toUcs2Bytes(`Signature: ${info.signature}`);
    }

    // User Comment (Prompt + Size + Artist + Page + SHA1)
    const parts = [];
    if (info.prompt) parts.push(`${info.prompt}`);
    // Add any extra lines you like here:
    // parts.push(`Negative prompt: bad quality, ...`);
    if (info.dims)   parts.push(`Size: ${info.dims}`);
    if (info.artist) parts.push(`Artist: ${info.artist}`);
    if (info.pageUrl)parts.push(`Page: ${info.pageUrl}`);
    if (info.sha1)   parts.push(`SHA1: ${String(info.sha1).slice(0, 16)}`);

    const ucText = parts.join(", ");
    if (ucText) {
      const tag = piexif.ExifIFD.UserComment; // 0x9286
      exifObj["Exif"][tag] = "ASCII\0\0\0" + ucText; // EXIF ASCII header + text
    }

    const exifBytes = piexif.dump(exifObj);
    return piexif.insert(exifBytes, dataUrl);
  }

  // ---------- Sidecars ----------
  async function saveVideoSidecar(mp4Name, extra) {
    const base = mp4Name.replace(/\.mp4$/i, "");
    const sidecar = base + ".txt";
    const content =
`file: ${mp4Name}
signature_b64: ${extra.signature_b64 || ""}
sha1: ${extra.sha1 || ""}
dims: ${extra.dims || ""}
page_url: ${extra.page_url || ""}
prompt:
${extra.prompt || ""}
`;
    const url = "data:text/plain;charset=utf-8," + encodeURIComponent(content);
    await new Promise((res, rej) => GM_download({ url, name: sidecar, saveAs: false, onload: res, onerror: e => rej(e?.error || "dl error") }));
  }

  // ---------- Utils ----------
  function dimStringFromImage(imgEl, meta) {
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
  function normText(s) { return String(s).replace(/\s+/g, " ").trim(); }
  function safeSlug(s, max = 50) {
    const norm = normText(s).slice(0, max);
    return norm.replace(/[^a-zA-Z0-9 _.-]/g, "").trim().replace(/\s+/g, "_");
  }
  function persistSeen() {
    // keep roughly bounded
    const trim = (set, keep) => {
      if (set.size > keep) {
        const trimmed = Array.from(set).slice(-keep);
        set.clear(); trimmed.forEach(v => set.add(v));
      }
    };
    trim(seenImg, 2000);
    trim(seenVid, 1000);
    trim(seenVidUrls, 1000);
    GM_setValue(SEEN_IMG_BYTES_KEY, Array.from(seenImg));
    GM_setValue(SEEN_VID_BYTES_KEY, Array.from(seenVid));
    GM_setValue(SEEN_VID_URL_KEY, Array.from(seenVidUrls));
  }
  function hashOfString(s) {
    let h = 0; for (let i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) >>> 0; }
    return ("00000000" + h.toString(16)).slice(-8);
  }
  function anchorDownload(url, name) {
    const a = document.createElement("a");
    a.href = url; a.download = name; document.body.appendChild(a);
    a.click(); a.remove();
  }
})();
