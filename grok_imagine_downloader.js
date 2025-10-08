// ==UserScript==
// @name         Grok Imagine - Auto Image & Video Downloader
// @namespace    alexds9.scripts
// @version      2.2
// @description  Auto-download finals (images & videos); skip previews via Grok signature; bind nearest prompt chip; write prompt/info into JPEG EXIF and MP4 metadata; no sidecars; dedupe; Ctrl+Shift+S
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
  const QUICK_SKIP_IMG_B64LEN  = 80000;   // tiny data-URL images => skip
  const QUICK_SKIP_VID_B64LEN  = 120000;  // tiny data-URL videos => skip
  const TRUST_HTTPS_VIDEO       = true;    // treat https MP4 from grok as final

  // State
  let autoOn = GM_getValue(STATE_KEY, false);
  let seenImgArr   = GM_getValue(SEEN_IMG_BYTES_KEY, []);
  let seenVidArr   = GM_getValue(SEEN_VID_BYTES_KEY, []);
  let seenVidUrlArr= GM_getValue(SEEN_VID_URL_KEY, []);
  let seenImg      = new Set(seenImgArr);
  let seenVid      = new Set(seenVidArr);
  let seenVidUrls  = new Set(seenVidUrlArr);
  let lastSeenPrompt = "";

  // UI
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

  // ---------------- Images ----------------
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

    // Prompt
    const prompt = getPromptNearestToNode(imgEl) || lastSeenPrompt || "";

    // Filename
    const sig = extractSignature(meta);
    const artist = typeof meta?.Artist === "string" ? meta.Artist.trim() : "";
    const stamp = isoStamp(new Date());
    const dims  = dimStringFromImage(imgEl, meta);
    const short = sig ? "sig" + sig.slice(0, 10) : "h" + sha1.slice(0, 10);
    const slug  = INCLUDE_PROMPT_IN_NAME && prompt ? "p_" + safeSlug(prompt, PROMPT_SLUG_MAX) : null;
    const filename = ["grok", stamp, short, dims, slug].filter(Boolean).join("_") + ".jpg";

    // Persist dedupe
    seenImg.add(sha1); persistSeen();

    // Inject EXIF (XPComment = Signature; UserComment = Prompt + Size + Artist + Page + SHA1)
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

  // ---------------- Videos ----------------
  function scanVideos() {
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
    if (!autoOn || videoEl.dataset.grokDone === "1") return;

    const url = getVideoUrl(videoEl);
    if (!url) return;

    // Get raw bytes (ArrayBuffer) regardless of URL scheme
    let abuf;
    if (url.startsWith("data:")) {
      const m = url.match(/^data:video\/mp4;base64,(.*)$/i);
      if (!m) return; // only mp4 in this version
      const b64 = m[1];
      if (b64.length < QUICK_SKIP_VID_B64LEN) return;
      abuf = b64ToUint8Array(b64).buffer;
    } else if (url.startsWith("blob:")) {
      const resp = await fetch(url);
      abuf = await resp.arrayBuffer();
    } else if (url.startsWith("https://")) {
      if (!TRUST_HTTPS_VIDEO) return;
      abuf = await gmFetchArrayBuffer(url);
    } else {
      return;
    }

    // Detect signature (filter previews) and compute SHA1 for dedupe (pre-injection)
    const u8 = new Uint8Array(abuf);
    const sha1 = await sha1Hex(u8);
    if (seenVid.has(sha1) || seenVidUrls.has(url)) { videoEl.dataset.grokDone = "1"; return; }

    const signature = findSignatureAscii(u8); // base64 if present
    if (!signature && url.startsWith("data:")) return; // require signature for data: (previews)
    if (!signature && url.startsWith("https://") && !TRUST_HTTPS_VIDEO) return;

    // Prompt & dims
    const dims = await videoDims(videoEl);
    const sizeStr = dims.w && dims.h ? `${dims.w}x${dims.h}` : "";
    const prompt = getPromptNearestToNode(videoEl) || lastSeenPrompt || "";

    // Build comment payload
    const extraParts = [];
    if (prompt) extraParts.push(`Prompt: ${prompt}`);
    if (sizeStr) extraParts.push(`Size: ${sizeStr}`);
    // Artist comes from images' EXIF; for videos Grok often lacks it; leave empty if unknown
    const artist = ""; // fill from page if you later find a reliable source
    if (artist) extraParts.push(`Artist: ${artist}`);
    extraParts.push(`Page: ${location.href}`);
    extraParts.push(`SHA1: ${String(sha1).slice(0,16)}`);

    const commentText =
      (signature ? `Signature: ${signature}\n` : "") +
      extraParts.join(", ");

    // Inject/append '©cmt' into MP4 moov/udta/meta/ilst
    let newU8;
    try {
      newU8 = injectMp4Comment(u8, commentText);
    } catch (e) {
      console.warn("MP4 metadata inject failed, saving original:", e);
      newU8 = u8;
    }

    // Filename
    const stamp = isoStamp(new Date());
    const short = signature ? "sig" + signature.slice(0, 10) : "h" + sha1.slice(0, 10);
    const slug  = INCLUDE_PROMPT_IN_NAME && prompt ? "p_" + safeSlug(prompt, PROMPT_SLUG_MAX) : null;
    const filename = ["grokvid", stamp, short, sizeStr || null, slug].filter(Boolean).join("_") + ".mp4";

    // Persist dedupe and save
    seenVid.add(sha1); seenVidUrls.add(url); persistSeen();

    const blob = new Blob([newU8], { type: "video/mp4" });
    const objUrl = URL.createObjectURL(blob);
    await new Promise((resolve, reject) => {
      GM_download({ url: objUrl, name: filename, saveAs: false, onload: resolve, onerror: e => reject(e?.error || "download error"), ontimeout: () => reject("timeout") });
    });
    URL.revokeObjectURL(objUrl);

    videoEl.dataset.grokDone = "1";
    console.log("[Grok downloader][VID] saved", filename);
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

  // Find "Signature: <base64>" as ASCII anywhere in MP4 (e.g., comment atom or muxer tag)
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

  // JPEG EXIF injection (unchanged)
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

  // ---------- MP4 metadata injection: moov/udta/meta/ilst/©cmt ----------
  function injectMp4Comment(u8in, commentText) {
    const te = new TextEncoder();
    const commentBytes = te.encode(commentText);

    // Build 'data' (full box: version/flags + type(1) + locale(0) + payload)
    const dataPayload = concatBytes(u32be(1), u32be(0), commentBytes); // type=1 UTF-8, locale=0
    const dataBox = fullBox("data", 0, 0, dataPayload);

    // Build '©cmt' item containing one 'data'
    const cmtItem = box("\xA9cmt", dataBox); // \xA9 = ©

    // Build 'ilst'
    const ilst = box("ilst", cmtItem);

    // Build 'hdlr' (QuickTime/iTunes style)
    // version/flags + pre_defined(0) + handler_type('mdir') + reserved(12x00) + name("Apple Metadata\0")
    const name = new TextEncoder().encode("Apple Metadata\u0000");
    const hdlrPayload = concatBytes(
      u32be(0),               // pre_defined
      str4("mdir"),           // handler type
      new Uint8Array(12),     // reserved
      name
    );
    const hdlr = fullBox("hdlr", 0, 0, hdlrPayload);

    // Build 'meta' (full box + children hdlr + ilst)
    const meta = fullBox("meta", 0, 0, concatBytes(hdlr, ilst));

    // Build 'udta'
    const udta = box("udta", meta);

    // Insert or append 'udta' inside 'moov'
    const { moovStart, moovSize } = findBox(u8in, 0, u8in.length, "moov");
    if (moovStart < 0) throw new Error("moov box not found");

    // New moov = original moov bytes + our udta appended
    const oldMoov = u8in.subarray(moovStart, moovStart + moovSize);
    const newMoovSize = moovSize + udta.length;
    const newMoov = new Uint8Array(newMoovSize);
    newMoov.set(oldMoov, 0);
    newMoov.set(udta, moovSize);

    // Patch size at start of moov
    writeU32be(newMoov, 0, newMoovSize);

    // Assemble final file
    const out = new Uint8Array(u8in.length + udta.length);
    out.set(u8in.subarray(0, moovStart), 0);
    out.set(newMoov, moovStart);
    out.set(u8in.subarray(moovStart + moovSize), moovStart + newMoovSize);

    return out;
  }

  // ---------- Low-level MP4 helpers ----------
  function findBox(u8, start, end, fourcc) {
    let p = start;
    while (p + 8 <= end) {
      const size = readU32be(u8, p);
      const type = readStr4(u8, p + 4);
      if (!size || size < 8) break;
      if (type === fourcc) return { moovStart: p, moovSize: size };
      p += size;
    }
    return { moovStart: -1, moovSize: 0 };
  }
  function readU32be(u8, off) {
    return (u8[off] << 24) | (u8[off+1] << 16) | (u8[off+2] << 8) | (u8[off+3]);
  }
  function writeU32be(u8, off, v) {
    u8[off]   = (v >>> 24) & 0xFF;
    u8[off+1] = (v >>> 16) & 0xFF;
    u8[off+2] = (v >>>  8) & 0xFF;
    u8[off+3] = (v       ) & 0xFF;
  }
  function str4(s) {
    const u = new Uint8Array(4);
    for (let i = 0; i < 4; i++) u[i] = s.charCodeAt(i) & 0xFF;
    return u;
  }
  function u32be(v) {
    const u = new Uint8Array(4);
    writeU32be(u, 0, v >>> 0);
    return u;
  }
  function box(type4, payload) {
    const size = 8 + payload.length;
    const out = new Uint8Array(size);
    writeU32be(out, 0, size);
    for (let i = 0; i < 4; i++) out[4 + i] = type4.charCodeAt(i) & 0xFF;
    out.set(payload, 8);
    return out;
  }
  function fullBox(type4, version, flags, payload) {
    const vf = new Uint8Array(4);
    vf[0] = version & 0xFF;
    vf[1] = (flags >>> 16) & 0xFF;
    vf[2] = (flags >>>  8) & 0xFF;
    vf[3] = (flags       ) & 0xFF;
    return box(type4, concatBytes(vf, payload));
  }
  function concatBytes(...arrs) {
    const len = arrs.reduce((a, b) => a + b.length, 0);
    const out = new Uint8Array(len);
    let p = 0;
    for (const a of arrs) { out.set(a, p); p += a.length; }
    return out;
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
  function persistSeen() {
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
  function anchorDownload(url, name) {
    const a = document.createElement("a");
    a.href = url; a.download = name; document.body.appendChild(a);
    a.click(); a.remove();
  }
})();
