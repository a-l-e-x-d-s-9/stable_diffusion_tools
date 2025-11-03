// ==UserScript==
// @name         YouTube Link Collector Panel
// @namespace    yt_link_collector
// @version      0.3.0
// @description  Add, remove, copy, and clear a list of YouTube links while browsing. Draggable mini-panel with menu toggle.
// @match        https://www.youtube.com/*
// @match        https://m.youtube.com/*
// @match        https://youtu.be/*
// @run-at       document-idle
// @grant        GM_registerMenuCommand
// @grant        GM_unregisterMenuCommand
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addStyle
// ==/UserScript==

(function () {
  "use strict";

  // Storage keys
  const KEY_LIST = "ytlc.links";
  const KEY_UI = "ytlc.ui";
  const KEY_HIDDEN = "ytlc.hidden";

  // State
  let links = loadLinks();
  let ui = loadUI();
  let isHidden = GM_getValue(KEY_HIDDEN, false);
  let menuIds = [];

  // Styles
  GM_addStyle(`
    .ytlc-panel {
      position: fixed;
      top: ${cssInt(ui.top, 80)}px;
      left: ${cssInt(ui.left, 24)}px;
      min-width: 220px;
      background: rgba(20,20,20,0.92);
      color: #eaeaea;
      border: 1px solid rgba(255,255,255,0.15);
      border-radius: 10px;
      box-shadow: 0 6px 22px rgba(0,0,0,0.45);
      font: 13px/1.35 system-ui, -apple-system, Segoe UI, Roboto, Ubuntu, Cantarell, Noto Sans, Arial, sans-serif;
      z-index: 999999999;
      user-select: none;
    }
    .ytlc-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 6px 8px;
      cursor: move;
      border-bottom: 1px solid rgba(255,255,255,0.1);
      font-weight: 600;
    }
    .ytlc-title {
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .ytlc-close {
      cursor: pointer;
      border: 1px solid rgba(255,255,255,0.15);
      padding: 0 6px;
      border-radius: 6px;
      background: rgba(255,255,255,0.06);
    }
    .ytlc-body {
      padding: 8px;
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 6px;
    }
    .ytlc-footer {
      padding: 6px 8px 8px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      color: #bdbdbd;
    }
    .ytlc-btn {
      padding: 6px 8px;
      background: rgba(255,255,255,0.06);
      color: #fff;
      border: 1px solid rgba(255,255,255,0.15);
      border-radius: 8px;
      cursor: pointer;
      text-align: center;
    }
    .ytlc-btn:hover { background: rgba(255,255,255,0.12); }
    .ytlc-badge {
      border: 1px solid rgba(255,255,255,0.15);
      padding: 2px 6px;
      border-radius: 999px;
      font-size: 12px;
      background: rgba(255,255,255,0.06);
      color: #fff;
    }
    .ytlc-status {
      font-size: 12px;
      opacity: 0.9;
      max-width: 60%;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
  `);

  // Panel
  let panel = null;
  if (!isHidden) {
    panel = createPanel();
    document.documentElement.appendChild(panel);
  }
  registerMenu();

  // React to SPA navigation on YouTube
  window.addEventListener("yt-navigate-finish", updateStatus, true);
  window.addEventListener("popstate", updateStatus, true);
  window.addEventListener("hashchange", updateStatus, true);

  // Functions

  function createPanel() {
    const wrap = document.createElement("div");
    wrap.className = "ytlc-panel";
    wrap.style.top = cssInt(ui.top, 80) + "px";
    wrap.style.left = cssInt(ui.left, 24) + "px";

    // Header
    const header = document.createElement("div");
    header.className = "ytlc-header";
    const title = document.createElement("div");
    title.className = "ytlc-title";
    title.textContent = "YT Link Collector";
    const close = document.createElement("button");
    close.type = "button";
    close.className = "ytlc-close";
    close.textContent = "Hide";
    close.addEventListener("click", () => hidePanel());

    header.appendChild(title);
    header.appendChild(close);
    wrap.appendChild(header);

    // Body buttons
    const body = document.createElement("div");
    body.className = "ytlc-body";

    const btnAdd = mkBtn("Add current", () => {
      const u = normalizeCurrentUrl();
      if (!u) return setStatus("No video id on page");
      if (!links.includes(u)) {
        links.push(u);
        saveLinks();
        updateFooter();
        setStatus("Added");
      } else {
        setStatus("Already in list");
      }
    });

    const btnRemove = mkBtn("Remove current", () => {
      const u = normalizeCurrentUrl();
      if (!u) return setStatus("No video id on page");
      const before = links.length;
      links = links.filter(x => x !== u);
      saveLinks();
      updateFooter();
      setStatus(before !== links.length ? "Removed" : "Not found");
    });

    const btnCopy = mkBtn("Copy list", async () => {
      const text = links.join("\n");
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(text);
        } else {
          legacyCopy(text);
        }
        setStatus("Copied " + links.length + " link(s)");
      } catch (e) {
        setStatus("Copy failed");
      }
    });

    const btnClear = mkBtn("Clear list", () => {
      if (!links.length) return setStatus("List already empty");
      if (confirm("Clear all saved links?")) {
        links = [];
        saveLinks();
        updateFooter();
        setStatus("Cleared");
      }
    });

    body.appendChild(btnAdd);
    body.appendChild(btnRemove);
    body.appendChild(btnCopy);
    body.appendChild(btnClear);
    wrap.appendChild(body);

    // Footer
    const footer = document.createElement("div");
    footer.className = "ytlc-footer";
    const status = document.createElement("div");
    status.className = "ytlc-status";
    status.textContent = statusLine();
    const badge = document.createElement("div");
    badge.className = "ytlc-badge";
    badge.textContent = String(links.length);
    footer.appendChild(status);
    footer.appendChild(badge);
    wrap.appendChild(footer);

    // Dragging
    makeDraggable(wrap, header, (pos) => {
      ui = { top: pos.top, left: pos.left };
      GM_setValue(KEY_UI, ui);
    });

    // Helpers exposed on element for updates
    wrap._statusEl = status;
    wrap._badgeEl = badge;

    // Initial status
    updateStatus();

    return wrap;
  }

  function mkBtn(text, onClick) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "ytlc-btn";
    b.textContent = text;
    b.addEventListener("click", onClick);
    return b;
  }

  function updateFooter() {
    if (!panel) return;
    panel._badgeEl.textContent = String(links.length);
  }

  function setStatus(msg) {
    if (!panel) return;
    panel._statusEl.textContent = msg;
  }

  function statusLine() {
    const u = normalizeCurrentUrl();
    if (!u) return "No video detected";
    return inList(u) ? "In list" : "Not in list";
  }

  function updateStatus() {
    if (!panel) return;
    panel._statusEl.textContent = statusLine();
    panel._badgeEl.textContent = String(links.length);
  }

  function inList(url) {
    return links.includes(url);
  }

  function legacyCopy(text) {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.top = "-2000px";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
  }

  // URL normalization
  function normalizeCurrentUrl() {
    try {
      const href = location.href;
      // Shorts to watch
      // Examples:
      // https://www.youtube.com/shorts/VIDEOID -> https://www.youtube.com/watch?v=VIDEOID
      // https://youtu.be/VIDEOID -> https://www.youtube.com/watch?v=VIDEOID
      const u = new URL(href);

      // If it is a watch page with v param, keep only v and optional list if you want
      if (u.hostname.includes("youtube.com") && u.pathname === "/watch" && u.searchParams.get("v")) {
        const id = u.searchParams.get("v");
        return "https://www.youtube.com/watch?v=" + id;
      }

      // Shorts
      const shorts = href.match(/youtube\.com\/shorts\/([a-zA-Z0-9_-]{6,})/);
      if (shorts) {
        return "https://www.youtube.com/watch?v=" + shorts[1];
      }

      // youtu.be short links
      const yb = href.match(/youtu\.be\/([a-zA-Z0-9_-]{6,})/);
      if (yb) {
        return "https://www.youtube.com/watch?v=" + yb[1];
      }

      // Music and embed variations
      const vFromAny = u.searchParams.get("v");
      if (vFromAny) {
        return "https://www.youtube.com/watch?v=" + vFromAny;
      }

      return null;
    } catch {
      return null;
    }
  }

  // Drag logic
  function makeDraggable(panelEl, handleEl, onStop) {
    let dragging = false;
    let startX = 0, startY = 0, origLeft = 0, origTop = 0;

    handleEl.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      dragging = true;
      startX = e.clientX;
      startY = e.clientY;
      const rect = panelEl.getBoundingClientRect();
      origLeft = rect.left;
      origTop = rect.top;
      e.preventDefault();
    });

    window.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      panelEl.style.left = Math.max(0, origLeft + dx) + "px";
      panelEl.style.top = Math.max(0, origTop + dy) + "px";
    });

    window.addEventListener("mouseup", () => {
      if (!dragging) return;
      dragging = false;
      const rect = panelEl.getBoundingClientRect();
      onStop && onStop({ left: Math.round(rect.left), top: Math.round(rect.top) });
    });
  }

  // Persistence
  function loadLinks() {
    const v = GM_getValue(KEY_LIST, "[]");
    try {
      const arr = JSON.parse(v);
      if (Array.isArray(arr)) return unique(arr);
      return [];
    } catch {
      return [];
    }
  }
  function saveLinks() {
    GM_setValue(KEY_LIST, JSON.stringify(unique(links)));
  }
  function loadUI() {
    const v = GM_getValue(KEY_UI, "{}");
    try {
      const obj = JSON.parse(v) || {};
      return {
        top: typeof obj.top === "number" ? obj.top : 80,
        left: typeof obj.left === "number" ? obj.left : 24
      };
    } catch {
      return { top: 80, left: 24 };
    }
  }

  // Menu
  function registerMenu() {
    // Clean old
    for (const id of menuIds) {
      try { GM_unregisterMenuCommand(id); } catch {}
    }
    menuIds = [];

    // Show or hide
    if (isHidden) {
      menuIds.push(GM_registerMenuCommand("Show Link Collector", () => {
        isHidden = false;
        GM_setValue(KEY_HIDDEN, false);
        if (!panel) {
          panel = createPanel();
          document.documentElement.appendChild(panel);
        } else {
          panel.style.display = "";
        }
        registerMenu();
      }));
    } else {
      menuIds.push(GM_registerMenuCommand("Hide Link Collector", hidePanel));
    }

    // Quick actions
    menuIds.push(GM_registerMenuCommand("Copy list to clipboard", () => {
      const text = links.join("\n");
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text);
      } else {
        legacyCopy(text);
      }
      toast("Copied " + links.length + " link(s)");
    }));

    menuIds.push(GM_registerMenuCommand("Clear list", () => {
      if (!links.length) return toast("List already empty");
      if (confirm("Clear all saved links?")) {
        links = [];
        saveLinks();
        if (panel) updateFooter();
        toast("Cleared");
      }
    }));
  }

  function hidePanel() {
    isHidden = true;
    GM_setValue(KEY_HIDDEN, true);
    if (panel) panel.style.display = "none";
    registerMenu();
  }

  // Small toast
  function toast(msg) {
    setStatus(msg);
    // Optional: could add a transient overlay if desired
  }

  // Utils
  function unique(arr) {
    return Array.from(new Set(arr));
  }
  function cssInt(v, dflt) {
    return Number.isFinite(v) ? v : dflt;
  }
})();
