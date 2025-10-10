// ==UserScript==
// @name         Grok Imagine - Auto Image & Video Downloader
// @namespace    alexds9.scripts
// @version      2.3.7
// @description  Auto-download finals (images & videos); skip previews via Grok signature; bind nearest prompt chip; write prompt/info into JPEG EXIF; strong dedupe by Signature + URL(normalized) + SHA1; Force mode per-page; Ctrl+Shift+S toggle
// @author       Alex
// @match        https://grok.com/imagine*
// @grant        GM_download
// @grant        GM_registerMenuCommand
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_notification
// @grant        GM_addStyle
// @grant        GM_xmlhttpRequest
// @connect      *
// @connect      assets.grok.com
// @connect      imagine-public.x.ai
// @require      https://cdn.jsdelivr.net/npm/exifr@7.1.3/dist/lite.umd.js
// @require      https://cdn.jsdelivr.net/npm/piexifjs@1.0.6/piexif.js
// ==/UserScript==
(function () {
  "use strict";

  // Prompt chips (generator + viewer)
  const PROMPT_SELECTOR_GEN  = "div.border.border-border-l2.bg-surface-l1.rounded-3xl";
  const PROMPT_SELECTOR_VIEW = "div.border.border-border-l2.bg-surface-l1.truncate.rounded-full";
  const PROMPT_SELECTOR = `${PROMPT_SELECTOR_GEN}, ${PROMPT_SELECTOR_VIEW}`;

  // Behavior & storage keys
  const STATE_KEY              = "grok_auto_on";
  const SEEN_IMG_BYTES_KEY     = "grok_seen_sha1_v1";
  const SEEN_VID_BYTES_KEY     = "grok_seen_vid_sha1_v1";
  const SEEN_VID_URL_KEY       = "grok_seen_vid_urls_v1";
  const SEEN_VID_URL_NORM_KEY  = "grok_seen_vid_urls_norm_v1";
  const SEEN_SIGNATURE_KEY     = "grok_seen_signature_v1";
  const MAX_WAIT_MS            = 60000; // give Favorites more time
  const SCAN_INTERVAL_MS       = 400;   // scan more frequently


  // Filenames
  const INCLUDE_PROMPT_IN_NAME = true;
  const PROMPT_SLUG_MAX        = 50;

  // Heuristics
  const QUICK_SKIP_IMG_B64LEN  = 80000;
  const QUICK_SKIP_VID_B64LEN  = 120000;
  const TRUST_HTTPS_VIDEO      = true;

  // Safe selector for the masonry card / list item (escape the slash!)
  const CARD_SELECTOR = '.group\\/media-post-masonry-card, [role="listitem"], .relative';


  // Per-page force
  const FORCE_PAGE_DEFAULT = false;
  let forcePage = FORCE_PAGE_DEFAULT;

  // State
  let autoOn = GM_getValue(STATE_KEY, false);
  let seenImg        = new Set(GM_getValue(SEEN_IMG_BYTES_KEY, []));
  let seenVid        = new Set(GM_getValue(SEEN_VID_BYTES_KEY, []));
  let seenVidUrls    = new Set(GM_getValue(SEEN_VID_URL_KEY, []));
  let seenVidUrlsNorm= new Set(GM_getValue(SEEN_VID_URL_NORM_KEY, []));
  let seenSig        = new Set(GM_getValue(SEEN_SIGNATURE_KEY, []));
  let lastSeenPrompt = "";

    // ---- small async queues to avoid network overload ----
    const MAX_PARALLEL_FETCHES = 5;
    const MAX_PARALLEL_DOWNLOADS = 4;

    function makeQueue(limit) {
      let active = 0;
      const q = [];
      const pump = () => {
        while (active < limit && q.length) {
          const {fn, resolve, reject} = q.shift();
          active++;
          (async () => {
            try { resolve(await fn()); }
            catch (e) { reject(e); }
            finally { active--; pump(); }
          })();
        }
      };
      return (fn) => new Promise((resolve, reject) => { q.push({fn, resolve, reject}); pump(); });
    }

    const fetchQ = makeQueue(MAX_PARALLEL_FETCHES);
    const dlQ    = makeQueue(MAX_PARALLEL_DOWNLOADS);

    // small helper for 1 retry on transient errors
    async function withRetry(fn, attempts = 2) {
      let last;
      for (let i = 0; i < attempts; i++) {
        try { return await fn(); } catch (e) { last = e; }
      }
      throw last;
    }


  // UI
  GM_addStyle(`#grok-auto-indicator{position:fixed;top:10px;right:10px;z-index:999999;background:rgba(20,20,24,.9);color:#fff;padding:6px 10px;border-radius:8px;font:12px/1.2 system-ui,Segoe UI,Roboto,Ubuntu,Arial;box-shadow:0 2px 10px rgba(0,0,0,.25);pointer-events:none;user-select:none}`);
  const indicator = document.createElement("div");
  indicator.id = "grok-auto-indicator";
  document.documentElement.appendChild(indicator);
  updateIndicator();

  GM_registerMenuCommand("Toggle auto-download (Ctrl+Shift+S)", toggleAuto);
  GM_registerMenuCommand("Force downloads (this page) — toggle", toggleForcePage); // NEW
  GM_registerMenuCommand("Clear dedupe history", clearDedupe);
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
  function toggleForcePage() {
    forcePage = !forcePage;
    try { GM_notification({ title: "Grok downloader", text: `Force downloads ${forcePage ? "ENABLED" : "DISABLED"} (this page)`, timeout: 1200 }); } catch {}
    updateIndicator();
  }
  function updateIndicator() {
    indicator.textContent = `Grok auto-download: ${autoOn ? "ON" : "OFF"}${forcePage ? " · FORCE" : ""}`;
  }
  function clearDedupe() {
    seenImg.clear(); seenVid.clear(); seenVidUrls.clear(); seenVidUrlsNorm.clear(); seenSig.clear();
    persistSeen();
    alert("Cleared dedupe history. Reload the page to re-scan.");
  }

  // ---------------- Images ----------------
  function scanImages() {
    const q = 'img[alt="Generated image"], img[src^="data:image/"]';
    document.querySelectorAll(q).forEach(img => {
      if (img.dataset.grokWatching === "1") return;
      if (isVideoPosterImage(img)) return; // NEW: ignore video posters
      if (!forcePage && img.dataset.grokDone === "1") return;
      if (forcePage && img.dataset.grokDoneForce === "1") return;
      img.dataset.grokWatching = "1";
      watchImg(img).catch(err => { console.warn("watchImg error:", err); delete img.dataset.grokWatching; });
    });
  }

  async function watchImg(imgEl) {
    const start = Date.now();
    const obs = new MutationObserver(async (muts) => {
      for (const m of muts) {
        if (m.type === "attributes" && m.attributeName === "src") {
          try { await tryDownloadImageIfFinal(imgEl); } catch (e) { console.warn("img final check failed:", e); }
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
    if (!autoOn) return;
    if (!forcePage && imgEl.dataset.grokDone === "1") return;
    if (forcePage && imgEl.dataset.grokDoneForce === "1") return;
    if (isVideoPosterImage(imgEl)) return; // NEW: skip posters even if force is on

    const src = imgEl.getAttribute("src") || "";
    const onFavorites = location.pathname.includes("/imagine/favorites");

    let scheme = "";
    if (src.startsWith("data:")) scheme = "data";
    else if (src.startsWith("blob:")) scheme = "blob";
    else if (src.startsWith("https://")) scheme = "https";
    else return;

    // Acquire bytes + detect mime best-effort
    let bytes = null;
    let mime  = "jpeg"; // default; corrected below where possible

    if (scheme === "data") {
      const m = src.match(/^data:image\/(jpeg|jpg|png);base64,(.*)$/i);
      if (!m) return;
      mime = m[1].toLowerCase();
      const b64 = m[2];
      if (b64.length < QUICK_SKIP_IMG_B64LEN) return;
      bytes = b64ToUint8Array(b64);
    } else if (scheme === "blob") {
      const abuf = await withRetry(() => fetchQ(async () => (await fetch(src)).arrayBuffer()));
      bytes = new Uint8Array(abuf);
      // Try extension hint
      if (/\.jpe?g(\?|#|$)/i.test(src)) mime = "jpeg";
      else if (/\.png(\?|#|$)/i.test(src)) mime = "png";
    } else if (scheme === "https") {
     const abuf = await withRetry(() => fetchQ(() => gmFetchArrayBuffer(src)));
      bytes = new Uint8Array(abuf);
      // Try extension hint
      if (/\.jpe?g(\?|#|$)/i.test(src)) mime = "jpeg";
      else if (/\.png(\?|#|$)/i.test(src)) mime = "png";
    }


    // Decide if this is a final image
    let meta = {};
    try {
      // exifr works on JPEG; PNG often has no EXIF
      if (mime === "jpeg" || mime === "jpg") {
        meta = await exifr.parse(bytes.buffer, { userComment: true });
      }
    } catch {}

    const isFinalExif = isGrokFinal(meta);
    const isFinalEnough = isFinalExif || onFavorites || forcePage;

    // For inline data: keep the strict check to avoid blur previews.
    if (scheme === "data" && !isFinalExif) return;
    // For https/blob: allow favorites (and force) even if EXIF missing.
    if ((scheme === "https" || scheme === "blob") && !isFinalEnough) return;


    const sig = extractSignature(meta);
    let sha1;

    if (!forcePage) {
      if (sig && seenSig.has(sig)) { imgEl.dataset.grokDone = "1"; return; }
      sha1 = await sha1Hex(bytes);
      if (seenImg.has(sha1)) { imgEl.dataset.grokDone = "1"; return; }
    } else {
      sha1 = await sha1Hex(bytes); // still compute for naming
    }

    const prompt = getPromptNearestToNode(imgEl) || lastSeenPrompt || "";

    const artist = typeof meta?.Artist === "string" ? meta.Artist.trim() : "";
    const stamp  = isoStamp(new Date());
    const dims   = dimStringFromImage(imgEl, meta);
    const short  = sig ? "sig" + sig.slice(0, 10) : "h" + sha1.slice(0, 10);
    const slug   = INCLUDE_PROMPT_IN_NAME && prompt ? "p_" + safeSlug(prompt, PROMPT_SLUG_MAX) : null;
    const filename = ["grok", stamp, short, dims, slug].filter(Boolean).join("_") + ".jpg";

    // Persist dedupe
    if (sig) seenSig.add(sig);
    seenImg.add(sha1);
    persistSeen();

    // Write EXIF for JPEGs when we have bytes; PNGs saved as-is
    let outUrl = src;
    if (mime === "jpeg" || mime === "jpg") {
      try {
        // For https/blob we must build a data URL from the fetched bytes
        const dataUrl = scheme === "data" ? src : bytesToDataURL("image/jpeg", bytes);
        outUrl = injectMetaIntoJpeg(dataUrl, {
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

    // Save (data URL or original URL)
    await dlQ(() => new Promise((resolve, reject) => {
      GM_download({ url: outUrl, name: filename, saveAs: false, onload: resolve, onerror: e => reject(e?.error || "download error"), ontimeout: () => reject("timeout") });
    }));

    imgEl.dataset.grokDone = "1";
    if (forcePage) imgEl.dataset.grokDoneForce = "1";
    console.log("[Grok downloader][IMG] saved", filename);

  }

  // ---------------- Videos ----------------
  function scanVideos() {
    document.querySelectorAll("video").forEach(v => {
      if (v.dataset.grokWatching === "1") return;
      if (!forcePage && v.dataset.grokDone === "1") return;
      if (forcePage && v.dataset.grokDoneForce === "1") return;
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

    // Watch <source> changes
    const watchSources = () => {
      videoEl.querySelectorAll("source").forEach(s => {
        srcObs.observe(s, { attributes: true, attributeFilter: ["src"] });
      });
    };
    const srcObs = new MutationObserver(async (muts) => {
      for (const m of muts) {
        if (m.type === "attributes" && m.attributeName === "src" && m.target.tagName === "SOURCE") {
          try { await tryDownloadVideoIfFinal(videoEl); } catch {}
        }
      }
    });
    watchSources();
    const childObs = new MutationObserver(() => { srcObs.disconnect(); watchSources(); try { tryDownloadVideoIfFinal(videoEl); } catch {} });
    childObs.observe(videoEl, { childList: true, subtree: true });

    await tryDownloadVideoIfFinal(videoEl);

    const timer = setInterval(async () => {
      if (videoEl.dataset.grokDone === "1" || Date.now() - start > MAX_WAIT_MS) {
        obsVideo.disconnect(); srcObs.disconnect(); childObs.disconnect();
        clearInterval(timer); delete videoEl.dataset.grokWatching;
      } else if (autoOn) {
        await tryDownloadVideoIfFinal(videoEl);
      }
    }, 800);
  }

  async function tryDownloadVideoIfFinal(videoEl) {
    if (!autoOn) return;
    if (!forcePage && videoEl.dataset.grokDone === "1") return;
    if (forcePage && videoEl.dataset.grokDoneForce === "1") return;


    const url = getVideoUrl(videoEl);
    if (!url) return;
    const normUrl = normalizeUrl(url);

    // Decide if we will inspect bytes (to read signature/sha1)
    let abuf = null;
    let canInspect = true;

    if (url.startsWith("data:")) {
      const m = url.match(/^data:video\/mp4;base64,(.*)$/i);
      if (!m) return;
      const b64 = m[1];
      if (b64.length < QUICK_SKIP_VID_B64LEN) return;
      abuf = b64ToUint8Array(b64).buffer;
    } else if (url.startsWith("blob:")) {
      const resp = await fetch(url);
      abuf = await resp.arrayBuffer();
    } else if (url.startsWith("https://")) {
      if (forcePage) {
        canInspect = false; // avoid cross-origin fetch in forced mode
      } else {
        if (!TRUST_HTTPS_VIDEO) return;
        abuf = await withRetry(() => fetchQ(() => gmFetchArrayBuffer(url)));
      }
    } else {
      return;
    }

    let signature = null;
    let sha1 = null;

    if (canInspect && abuf) {
      const u8 = new Uint8Array(abuf);
      signature = findSignatureAscii(u8);

      sha1 = await sha1Hex(u8);
      if (!forcePage && (seenVid.has(sha1) || seenVidUrls.has(url) || seenVidUrlsNorm.has(normUrl))) {
        videoEl.dataset.grokDone = "1"; return;
      }

      // For data: require signature to avoid previews
      if (!signature && url.startsWith("data:")) return;
    } else {
      // Force mode + https URL path (no bytes read)
      if (!forcePage && (seenVidUrls.has(url) || seenVidUrlsNorm.has(normUrl))) {
        videoEl.dataset.grokDone = "1";
        return;
      }
    }

    // Filename parts (we may not have signature/sha1 in forced+https)
    const dims = await videoDims(videoEl);
    const sizeStr = dims.w && dims.h ? `${dims.w}x${dims.h}` : "";
    const prompt = getPromptNearestToNode(videoEl) || lastSeenPrompt || "";

    const stamp = isoStamp(new Date());
    const short =
      signature ? ("sig" + signature.slice(0, 10)) :
      sha1       ? ("h"   + sha1.slice(0, 10))    :
                   ("u"   + hashOfString(normUrl).slice(0, 10));
    const slug  = INCLUDE_PROMPT_IN_NAME && prompt ? "p_" + safeSlug(prompt, PROMPT_SLUG_MAX) : null;
    const filename = ["grokvid", stamp, short, sizeStr || null, slug].filter(Boolean).join("_") + ".mp4";

    // Persist dedupe
    if (sha1)      seenVid.add(sha1);
    seenVidUrls.add(url);
    seenVidUrlsNorm.add(normUrl);
    persistSeen();

    // Save originals only (no MP4 rewriting)
    if (url.startsWith("blob:")) {
      anchorDownload(url, filename);
    } else {
        await dlQ(() => new Promise((resolve, reject) => {
          GM_download({ url, name: filename, saveAs: false, onload: resolve, onerror: e => reject(e?.error || "download error"), ontimeout: () => reject("timeout") });
        }));
    }

    videoEl.dataset.grokDone = "1";
    if (forcePage) videoEl.dataset.grokDoneForce = "1";
    console.log("[Grok downloader][VID]", forcePage ? "saved (FORCED)" : "saved", filename);

  }

    function isVideoPosterImage(imgEl) {
      // guard: if anything about selector parsing fails, never break the scan loop
      let card = null;
      try {
        card = imgEl.closest(CARD_SELECTOR);
      } catch (e) {
        // Fallback: walk up a few ancestors if a future class change breaks the selector again
        let cur = imgEl;
        for (let i = 0; i < 4 && cur && !card; i++) {
          if (cur.matches && (cur.matches('[role="listitem"]') || cur.matches('.relative'))) card = cur;
          cur = cur.parentElement;
        }
      }
      if (!card) card = imgEl.parentElement || null;
      if (!card) return false;

      const src = imgEl.src || "";

      // 1) hard skip known poster host/patterns
      //    (these are not finals; they're video thumbnails)
      if (/imagine-public\.x\.ai\/imagine-public\/share-images\//.test(src)) return true;
      if (/\/content(\?|#|$)/.test(src)) return true;

      // 2) if a <video> exists in the same card and its poster equals this <img>, skip
      const vid = card.querySelector && card.querySelector('video');
      if (!vid) return false;

      const poster = vid.getAttribute('poster') || '';
      if (poster) {
        // normalize before comparing to avoid query/hash mismatches
        const p = normalizeUrl(poster);
        const s = normalizeUrl(src);
        if (p === s) return true;
      }

      return false;
    }




  function getVideoUrl(videoEl) {
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
      if (videoEl.readyState >= 1) on();
    });
    return { w: videoEl.videoWidth || 0, h: videoEl.videoHeight || 0 };
  }

  // Find "Signature: <base64>" as ASCII anywhere in MP4
  function findSignatureAscii(uint8) {
    const td = new TextDecoder("utf-8");
    const step = 1 << 20;
    let partial = "";
    for (let i = 0; i < uint8.length; i += step) {
      const slice = uint8.subarray(i, Math.min(uint8.length, i + step));
      partial += td.decode(slice, { stream: i + step < uint8.length });
      const m = partial.match(/Signature:\s*([A-Za-z0-9+/=]+)/);
      if (m && m[1]) return m[1];
      partial = partial.slice(-100);
    }
    const m = partial.match(/Signature:\s*([A-Za-z0-9+/=]+)/);
    return (m && m[1]) ? m[1] : null;
  }

  // ---------- Shared helpers ----------
  function normalizeUrl(u) {
    try {
      const x = new URL(u, location.href);
      x.search = ""; x.hash = "";
      return x.toString();
    } catch { return u; }
  }

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

  // JPEG EXIF injection
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
    if (info.dims)   parts.push(`Size: ${info.dims}`);
    if (info.artist) parts.push(`Artist: ${info.artist}`);
    if (info.pageUrl)parts.push(`Page: ${info.pageUrl}`);
    if (info.sha1)   parts.push(`SHA1: ${String(info.sha1).slice(0, 16)}`);

    const ucText = parts.join(", ");
    if (ucText) {
      const tag = piexif.ExifIFD.UserComment; // 0x9286
      exifObj["Exif"][tag] = "ASCII\0\0\0" + ucText;
    }

    const exifBytes = piexif.dump(exifObj);
    return piexif.insert(exifBytes, dataUrl);
  }

  // ---------- Net / misc helpers ----------
  async function gmFetchArrayBuffer(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: "GET",
        url,
        responseType: "arraybuffer",
        onload: (res) => resolve(res.response),
        onerror: (e) => reject(e?.error || "gm xhr error")
      });
    });
  }

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
  function anchorDownload(url, name) {
    const a = document.createElement("a");
    a.href = url; a.download = name; document.body.appendChild(a);
    a.click(); a.remove();
  }
  function hashOfString(s) {
    let h = 0; for (let i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) >>> 0; }
    return ("00000000" + h.toString(16)).slice(-8);
  }
  function persistSeen() {
    const trim = (set, keep) => {
      if (set.size > keep) {
        const arr = Array.from(set).slice(-keep);
        set.clear(); arr.forEach(v => set.add(v));
      }
    };
    trim(seenImg, 6000);
    trim(seenVid, 6000);
    trim(seenVidUrls, 6000);
    trim(seenVidUrlsNorm, 6000);
    trim(seenSig, 10000);

    GM_setValue(SEEN_IMG_BYTES_KEY, Array.from(seenImg));
    GM_setValue(SEEN_VID_BYTES_KEY, Array.from(seenVid));
    GM_setValue(SEEN_VID_URL_KEY, Array.from(seenVidUrls));
    GM_setValue(SEEN_VID_URL_NORM_KEY, Array.from(seenVidUrlsNorm));
    GM_setValue(SEEN_SIGNATURE_KEY, Array.from(seenSig));
  }

  // ---- geometry helpers
  function safeRect(el) { try { return el.getBoundingClientRect(); } catch { return { top: 0, bottom: 0 }; } }

    function u8ToBase64(u8) {
      // chunked encode to avoid call stack limits
      let out = "";
      const CHUNK = 0x8000;
      for (let i = 0; i < u8.length; i += CHUNK) {
        out += String.fromCharCode.apply(null, u8.subarray(i, i + CHUNK));
      }
      return btoa(out);
    }
    function bytesToDataURL(mime, u8) {
      return `data:${mime};base64,` + u8ToBase64(u8);
    }

})();
