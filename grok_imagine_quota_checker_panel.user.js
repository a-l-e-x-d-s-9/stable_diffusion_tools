// ==UserScript==
// @name         Grok Imagine Quota Checker Panel
// @namespace    alexds9.scripts
// @version      1.0.0
// @description  Compact draggable Grok Imagine quota checker using Grok's own quota_info endpoint.
// @match        https://grok.com/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=grok.com
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  "use strict";

  /*
    Converted from:
    https://github.com/mashiourcse/grok_quota_check_extension

    Safety notes:
    - No third-party requests.
    - No cookies permission.
    - Uses fetch(..., { credentials: "include" }) only to grok.com.
    - No GM_xmlhttpRequest.
    - No page scraping.
  */

  const LS_PREFIX = "grok_quota_panel.";
  const K_POS = LS_PREFIX + "pos";
  const K_FOLDED = LS_PREFIX + "folded";
  const K_AUTO = LS_PREFIX + "autoRefresh";
  const K_INTERVAL = LS_PREFIX + "intervalSeconds";

  const API_URL = "https://grok.com/rest/media/imagine/quota_info";

  const DEFAULT_INTERVAL_SECONDS = 180;
  const MIN_INTERVAL_SECONDS = 30;
  const MAX_INTERVAL_SECONDS = 3600;

  const SERVICES = [
    { key: "image", title: "Speed Image" },
    { key: "imagePro", title: "Quality Image" },
    { key: "imageEdit", title: "Edit Image" },
    { key: "video", title: "480p Video" },
    { key: "video720p", title: "720p Video" },
  ];

  const S = {
    loading: false,
    timer: null,
    lastData: null,
    lastError: null,
    folded: lsGet(K_FOLDED, "0") === "1",
  };

  function lsGet(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v == null ? fallback : v;
    } catch (_) {
      return fallback;
    }
  }

  function lsSet(key, value) {
    try {
      localStorage.setItem(key, String(value));
    } catch (_) {}
  }

  function loadJson(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v ? JSON.parse(v) : fallback;
    } catch (_) {
      return fallback;
    }
  }

  function saveJson(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (_) {}
  }

  function clamp(n, lo, hi) {
    n = Number(n);
    if (!Number.isFinite(n)) return lo;
    return Math.max(lo, Math.min(hi, n));
  }

  function el(tag, props) {
    const x = document.createElement(tag);
    if (props) Object.assign(x, props);
    return x;
  }

  function css(node, text) {
    node.style.cssText = text;
    return node;
  }

  function formatLocalTime(value) {
    if (!value) return "-";
    try {
      const d = new Date(value);
      if (Number.isNaN(d.getTime())) return String(value);
      return d.toLocaleString([], {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      });
    } catch (_) {
      return String(value);
    }
  }

  function formatReset(seconds) {
    const n = Number(seconds);
    if (!Number.isFinite(n) || n <= 0) return "-";
    if (n < 3600) return Math.round(n / 60) + "m";
    if (n % 3600 === 0) return Math.round(n / 3600) + "h";
    return (n / 3600).toFixed(1) + "h";
  }

  function isActiveQuota(data) {
    if (!data || !data.available) return false;
    return data.remainingQueries == null || Number(data.remainingQueries) > 0;
  }

  function addStyle() {
    if (document.getElementById("grok-quota-panel-style")) return;

    const st = el("style");
    st.id = "grok-quota-panel-style";
    st.textContent = `
      #grok-quota-panel {
        position: fixed;
        top: 82px;
        right: 16px;
        width: 430px;
        z-index: 999999;
        background: rgba(18, 18, 20, 0.96);
        color: #fff;
        border: 1px solid rgba(255,255,255,0.12);
        border-radius: 12px;
        padding: 10px;
        font: 12px/1.3 system-ui, -apple-system, Segoe UI, Roboto, Ubuntu, Cantarell, Arial, sans-serif;
        box-shadow: 0 10px 30px rgba(0,0,0,0.45);
        box-sizing: border-box;
      }
      #grok-quota-panel * { box-sizing: border-box; }
      #grok-quota-panel.gqp-folded {
        width: 228px;
        padding-bottom: 8px;
      }
      #grok-quota-panel .gqp-header {
        display: flex;
        align-items: center;
        gap: 8px;
        cursor: move;
        user-select: none;
      }
      #grok-quota-panel .gqp-title {
        flex: 1 1 auto;
        color: #4ade80;
        font-weight: 800;
        font-size: 13px;
        letter-spacing: 0.2px;
      }
      #grok-quota-panel .gqp-btn {
        border: 1px solid rgba(255,255,255,0.14);
        background: rgba(255,255,255,0.08);
        color: #fff;
        border-radius: 9px;
        padding: 5px 8px;
        cursor: pointer;
        font-weight: 700;
        font-size: 11px;
      }
      #grok-quota-panel .gqp-btn:hover {
        background: rgba(255,255,255,0.14);
      }
      #grok-quota-panel .gqp-btn:disabled {
        opacity: 0.55;
        cursor: not-allowed;
      }
      #grok-quota-panel .gqp-content {
        margin-top: 10px;
      }
      #grok-quota-panel.gqp-folded .gqp-content {
        display: none;
      }
      #grok-quota-panel .gqp-controls {
        display: flex;
        gap: 8px;
        align-items: center;
        flex-wrap: wrap;
        margin-bottom: 8px;
      }
      #grok-quota-panel label {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        color: rgba(255,255,255,0.78);
        user-select: none;
      }
      #grok-quota-panel input[type="number"] {
        width: 62px;
        height: 28px;
        padding: 4px 6px;
        background: #2b2b2b;
        color: #fff;
        border: 1px solid rgba(255,255,255,0.18);
        border-radius: 8px;
        font: inherit;
      }
      #grok-quota-panel .gqp-grid {
        display: grid;
        grid-template-columns: 1fr;
        gap: 7px;
      }
      #grok-quota-panel .gqp-card {
        background: rgba(255,255,255,0.045);
        border: 1px solid rgba(255,255,255,0.08);
        border-radius: 10px;
        padding: 8px;
      }
      #grok-quota-panel .gqp-card-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        margin-bottom: 7px;
      }
      #grok-quota-panel .gqp-service-title {
        font-weight: 800;
        font-size: 12px;
      }
      #grok-quota-panel .gqp-badge {
        border-radius: 999px;
        padding: 3px 8px;
        font-size: 10px;
        font-weight: 900;
        letter-spacing: 0.3px;
        border: 1px solid rgba(255,255,255,0.12);
      }
      #grok-quota-panel .gqp-badge.active {
        color: #9fffcf;
        background: rgba(0,255,140,0.10);
        border-color: rgba(0,255,140,0.25);
      }
      #grok-quota-panel .gqp-badge.limited {
        color: #ffb4b4;
        background: rgba(255,60,60,0.10);
        border-color: rgba(255,60,60,0.25);
      }
      #grok-quota-panel .gqp-stats {
        display: grid;
        grid-template-columns: 1fr 1fr 1.25fr;
        gap: 6px;
      }
      #grok-quota-panel .gqp-stat {
        background: rgba(0,0,0,0.22);
        border: 1px solid rgba(255,255,255,0.06);
        border-radius: 8px;
        padding: 6px;
        min-width: 0;
      }
      #grok-quota-panel .gqp-label {
        font-size: 10px;
        color: rgba(255,255,255,0.55);
        text-transform: uppercase;
        letter-spacing: 0.5px;
        margin-bottom: 3px;
      }
      #grok-quota-panel .gqp-value {
        font-weight: 800;
        font-size: 13px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      #grok-quota-panel .gqp-status {
        margin-top: 8px;
        padding: 7px;
        background: rgba(0,0,0,0.28);
        border: 1px solid rgba(255,255,255,0.08);
        border-radius: 9px;
        color: rgba(255,255,255,0.72);
        max-height: 82px;
        overflow: auto;
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        white-space: pre-wrap;
      }
      #grok-quota-panel .gqp-warn { color: #ffcc66; font-weight: 800; }
      #grok-quota-panel .gqp-err { color: #ff8b8b; font-weight: 800; }
    `;
    document.head.appendChild(st);
  }

  function makeCard(service, data) {
    const active = isActiveQuota(data);

    const card = el("div");
    card.className = "gqp-card";

    const head = el("div");
    head.className = "gqp-card-head";

    const title = el("div", { textContent: service.title });
    title.className = "gqp-service-title";

    const badge = el("div", { textContent: active ? "ACTIVE" : "LIMITED" });
    badge.className = "gqp-badge " + (active ? "active" : "limited");

    head.appendChild(title);
    head.appendChild(badge);

    const stats = el("div");
    stats.className = "gqp-stats";

    addStat(stats, "Quota", data && data.remainingQueries != null ? String(data.remainingQueries) : "-");
    addStat(stats, "Reset", formatReset(data && data.windowSizeSeconds));
    addStat(stats, "Next", data && data.nextAvailableAt ? formatLocalTime(data.nextAvailableAt) : "Not set");

    card.appendChild(head);
    card.appendChild(stats);
    return card;
  }

  function addStat(parent, label, value) {
    const box = el("div");
    box.className = "gqp-stat";

    const lab = el("div", { textContent: label });
    lab.className = "gqp-label";

    const val = el("div", { textContent: value });
    val.className = "gqp-value";
    val.title = value;

    box.appendChild(lab);
    box.appendChild(val);
    parent.appendChild(box);
  }

  function renderCards(grid, data) {
    grid.textContent = "";

    let added = 0;
    for (const service of SERVICES) {
      if (!data || !data[service.key]) continue;
      grid.appendChild(makeCard(service, data[service.key]));
      added += 1;
    }

    if (!added) {
      const empty = el("div", { textContent: "No known quota fields found in response." });
      empty.className = "gqp-card gqp-warn";
      grid.appendChild(empty);
    }
  }

  function setStatus(msg, kind) {
    const status = document.getElementById("gqp-status");
    if (!status) return;

    const time = new Date().toLocaleTimeString();
    const line = "[" + time + "] " + msg;

    const div = el("div", { textContent: line });
    if (kind === "error") div.className = "gqp-err";
    if (kind === "warn") div.className = "gqp-warn";

    status.prepend(div);
  }

  async function loadQuota() {
    if (S.loading) return;
    S.loading = true;

    const refreshBtn = document.getElementById("gqp-refresh");
    const grid = document.getElementById("gqp-grid");
    if (refreshBtn) refreshBtn.disabled = true;

    setStatus("Loading quota...");

    try {
      const response = await fetch(API_URL, {
        method: "POST",
        credentials: "include",
        headers: {
          "accept": "*/*",
          "content-type": "application/json",
        },
        body: "{}",
      });

      if (!response.ok) {
        throw new Error("HTTP " + response.status);
      }

      const data = await response.json();
      S.lastData = data;
      S.lastError = null;

      if (grid) renderCards(grid, data);
      setStatus("Quota updated.");
    } catch (err) {
      S.lastError = err;
      if (grid) {
        grid.textContent = "";
        const box = el("div", { textContent: "Error: " + (err && err.message ? err.message : String(err)) });
        box.className = "gqp-card gqp-err";
        grid.appendChild(box);
      }
      setStatus("Error: " + (err && err.message ? err.message : String(err)), "error");
    } finally {
      S.loading = false;
      if (refreshBtn) refreshBtn.disabled = false;
    }
  }

  function clearTimer() {
    if (S.timer) {
      clearInterval(S.timer);
      S.timer = null;
    }
  }

  function getIntervalSeconds() {
    const raw = parseInt(lsGet(K_INTERVAL, String(DEFAULT_INTERVAL_SECONDS)), 10);
    return clamp(raw, MIN_INTERVAL_SECONDS, MAX_INTERVAL_SECONDS);
  }

  function applyAutoRefresh() {
    clearTimer();

    const enabled = lsGet(K_AUTO, "0") === "1";
    if (!enabled) return;

    const sec = getIntervalSeconds();
    S.timer = setInterval(loadQuota, sec * 1000);
  }

  function normalizePos(pos) {
    if (!pos || typeof pos !== "object") return null;
    const x = Number(pos.x);
    const y = Number(pos.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    return { x, y };
  }

  function applySavedPos(panel) {
    const pos = normalizePos(loadJson(K_POS, null));
    if (!pos) return;

    panel.style.left = clamp(pos.x, 0, Math.max(0, window.innerWidth - 80)) + "px";
    panel.style.top = clamp(pos.y, 0, Math.max(0, window.innerHeight - 40)) + "px";
    panel.style.right = "auto";
  }

  function enableDrag(panel, handle) {
    let dragging = false;
    let startX = 0;
    let startY = 0;
    let startLeft = 0;
    let startTop = 0;

    handle.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      if (e.target && e.target.closest && e.target.closest("button,input,label")) return;

      const r = panel.getBoundingClientRect();
      dragging = true;
      startX = e.clientX;
      startY = e.clientY;
      startLeft = r.left;
      startTop = r.top;

      panel.style.left = r.left + "px";
      panel.style.top = r.top + "px";
      panel.style.right = "auto";

      e.preventDefault();
    });

    window.addEventListener("mousemove", (e) => {
      if (!dragging) return;

      const nextLeft = clamp(startLeft + e.clientX - startX, 0, Math.max(0, window.innerWidth - 80));
      const nextTop = clamp(startTop + e.clientY - startY, 0, Math.max(0, window.innerHeight - 40));

      panel.style.left = nextLeft + "px";
      panel.style.top = nextTop + "px";
    });

    window.addEventListener("mouseup", () => {
      if (!dragging) return;
      dragging = false;

      const r = panel.getBoundingClientRect();
      saveJson(K_POS, { x: Math.round(r.left), y: Math.round(r.top) });
    });
  }

  function createUI() {
    if (document.getElementById("grok-quota-panel")) return;

    addStyle();

    const panel = el("div");
    panel.id = "grok-quota-panel";
    if (S.folded) panel.classList.add("gqp-folded");

    const header = el("div");
    header.className = "gqp-header";

    const title = el("div", { textContent: "Grok Quota" });
    title.className = "gqp-title";

    const refreshBtn = el("button", { textContent: "Refresh" });
    refreshBtn.id = "gqp-refresh";
    refreshBtn.className = "gqp-btn";

    const foldBtn = el("button", { textContent: S.folded ? "Open" : "Minimize" });
    foldBtn.id = "gqp-fold";
    foldBtn.className = "gqp-btn";

    header.appendChild(title);
    header.appendChild(refreshBtn);
    header.appendChild(foldBtn);

    const content = el("div");
    content.className = "gqp-content";

    const controls = el("div");
    controls.className = "gqp-controls";

    const autoLabel = el("label");
    const autoCheck = el("input");
    autoCheck.type = "checkbox";
    autoCheck.checked = lsGet(K_AUTO, "0") === "1";
    autoLabel.appendChild(autoCheck);
    autoLabel.appendChild(el("span", { textContent: "Auto" }));

    const intervalLabel = el("label");
    intervalLabel.appendChild(el("span", { textContent: "Every" }));
    const intervalInput = el("input");
    intervalInput.type = "number";
    intervalInput.min = String(MIN_INTERVAL_SECONDS);
    intervalInput.max = String(MAX_INTERVAL_SECONDS);
    intervalInput.step = "30";
    intervalInput.value = String(getIntervalSeconds());
    intervalLabel.appendChild(intervalInput);
    intervalLabel.appendChild(el("span", { textContent: "sec" }));

    const note = el("span", { textContent: "Private Grok endpoint. Manual refresh is safest." });
    note.className = "gqp-warn";

    controls.appendChild(autoLabel);
    controls.appendChild(intervalLabel);
    controls.appendChild(note);

    const grid = el("div");
    grid.id = "gqp-grid";
    grid.className = "gqp-grid";

    const initial = el("div", { textContent: "Click Refresh to check quota." });
    initial.className = "gqp-card";
    grid.appendChild(initial);

    const status = el("div", { textContent: "" });
    status.id = "gqp-status";
    status.className = "gqp-status";

    content.appendChild(controls);
    content.appendChild(grid);
    content.appendChild(status);

    panel.appendChild(header);
    panel.appendChild(content);
    document.documentElement.appendChild(panel);

    applySavedPos(panel);
    enableDrag(panel, header);

    refreshBtn.addEventListener("click", loadQuota);

    foldBtn.addEventListener("click", () => {
      S.folded = !S.folded;
      panel.classList.toggle("gqp-folded", S.folded);
      foldBtn.textContent = S.folded ? "Open" : "Minimize";
      lsSet(K_FOLDED, S.folded ? "1" : "0");
    });

    autoCheck.addEventListener("change", () => {
      lsSet(K_AUTO, autoCheck.checked ? "1" : "0");
      applyAutoRefresh();
      setStatus(autoCheck.checked ? "Auto refresh enabled." : "Auto refresh disabled.");
    });

    intervalInput.addEventListener("change", () => {
      const sec = getIntervalSecondsFromInput(intervalInput);
      intervalInput.value = String(sec);
      lsSet(K_INTERVAL, String(sec));
      applyAutoRefresh();
      setStatus("Refresh interval set to " + sec + " seconds.");
    });

    function getIntervalSecondsFromInput(input) {
      return clamp(parseInt(input.value, 10), MIN_INTERVAL_SECONDS, MAX_INTERVAL_SECONDS);
    }

    applyAutoRefresh();

    // One initial fetch is convenient, but not too aggressive because there is no 30s loop by default.
    loadQuota();
  }

  function boot() {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", createUI, { once: true });
    } else {
      createUI();
    }
  }

  boot();
})();
