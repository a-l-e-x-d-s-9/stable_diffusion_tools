// ==UserScript==
// @name         Grok Imagine Usage Tracker
// @namespace    alexds9.scripts
// @version      2.0.4
// @description  Draggable Grok Imagine usage tracker with readable counters, notifications, multi-account usage tracking with per-account history, limits, notes, imports/exports, and usage history.
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
  const K_COMPACT = LS_PREFIX + "compact";
  const K_USAGE = LS_PREFIX + "localUsage";
  const K_HISTORY = LS_PREFIX + "history";
  const K_HISTORY_DAYS = LS_PREFIX + "historyDays";
  const K_DEFAULT_LIMITS = LS_PREFIX + "defaultQuotaLimits";
  const K_EXACT_LIMIT_OVERRIDES = LS_PREFIX + "exactLimitOverrides";
  const K_NOTIFY_ENABLED = LS_PREFIX + "notifyEnabled";
  const K_NOTIFY_THRESHOLD = LS_PREFIX + "notifyThreshold";
  const K_NOTIFY_SERVICES = LS_PREFIX + "notifyServices";
  const K_BACKUP_INTERVAL_DAYS = LS_PREFIX + "backupIntervalDays";
  const K_LAST_BACKUP_EXPORT = LS_PREFIX + "lastBackupExportAt";
  const K_LAST_BACKUP_REMINDER = LS_PREFIX + "lastBackupReminderAt";
  const K_LIMIT_LOCKS = LS_PREFIX + "limitLocks";
  const K_MANUAL_REFRESH_HOURS = LS_PREFIX + "manualRefreshHours";
  const K_ACTIVE_ACCOUNT_ID = LS_PREFIX + "activeAccountId";
  const K_KNOWN_ACCOUNTS = LS_PREFIX + "knownAccounts";
  const K_ACCOUNT_NAMES = LS_PREFIX + "accountNames";

  const UNKNOWN_ACCOUNT_ID = "unknown";
  const ACCOUNT_USER_URL_RE = /(?:https?:)?\/\/(?:assets\.)?grok\.com\/users\/([0-9a-fA-F-]{20,})\//i;

  const API_URL = "https://grok.com/rest/media/imagine/quota_info";
  const GENERATION_URL_PART = "/rest/app-chat/conversations/new";
  const IMAGINE_LISTEN_WS_PART = "/ws/imagine/listen";

  const DEFAULT_INTERVAL_SECONDS = 180;
  const MIN_INTERVAL_SECONDS = 30;
  const MAX_INTERVAL_SECONDS = 3600;
  const IMAGE_PENDING_GRACE_MS = 2 * 60 * 1000;
  const PENDING_SWEEP_INTERVAL_MS = 15 * 1000;
  const VIDEO_FAILURE_WATCH_MS = 45 * 1000;
  const MAX_RECENT_ITEMS = 600;
  const DEFAULT_HISTORY_DAYS = 90;
  const MIN_HISTORY_DAYS = 1;
  const MAX_HISTORY_DAYS = 3650;
  const DEFAULT_BACKUP_REMINDER_DAYS = 14;
  const DEFAULT_NOTIFY_THRESHOLD = 5;
  const DEFAULT_QUOTA_LIMITS = { image: 600, imagePro: 72, imageEdit: 36, video: 30, video720p: 20 };

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
    compact: lsGet(K_COMPACT, "0") === "1",
    usage: null,
    lastImageRequest: null,
    pendingSweepTimer: null,
    pendingVideoAttempts: [],
    lastNotifyAt: {},
    currentAccountId: null,
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

  function sanitizeAccountId(value) {
    const raw = String(value || "").trim();
    if (!raw) return UNKNOWN_ACCOUNT_ID;
    return raw.replace(/[^0-9a-zA-Z._:-]/g, "_");
  }

  function getCurrentAccountId() {
    if (S.currentAccountId) return S.currentAccountId;
    const stored = sanitizeAccountId(lsGet(K_ACTIVE_ACCOUNT_ID, UNKNOWN_ACCOUNT_ID));
    S.currentAccountId = stored || UNKNOWN_ACCOUNT_ID;
    return S.currentAccountId;
  }

  function setCurrentAccountId(accountId) {
    const id = sanitizeAccountId(accountId);
    S.currentAccountId = id;
    lsSet(K_ACTIVE_ACCOUNT_ID, id);
    return id;
  }

  function accountStorageKey(baseKey, accountId) {
    return baseKey + ".account." + sanitizeAccountId(accountId || getCurrentAccountId());
  }

  function loadAccountJson(baseKey, fallback, accountId) {
    return loadJson(accountStorageKey(baseKey, accountId), fallback);
  }

  function saveAccountJson(baseKey, value, accountId) {
    saveJson(accountStorageKey(baseKey, accountId), value);
  }

  function accountLsGet(baseKey, fallback, accountId) {
    return lsGet(accountStorageKey(baseKey, accountId), fallback);
  }

  function accountLsSet(baseKey, value, accountId) {
    lsSet(accountStorageKey(baseKey, accountId), value);
  }

  function getKnownAccounts() {
    const raw = loadJson(K_KNOWN_ACCOUNTS, []);
    const list = Array.isArray(raw) ? raw.map(sanitizeAccountId).filter(Boolean) : [];
    const unique = Array.from(new Set(list.filter((x) => x && x !== UNKNOWN_ACCOUNT_ID)));
    const current = getCurrentAccountId();
    if (current && current !== UNKNOWN_ACCOUNT_ID && !unique.includes(current)) unique.unshift(current);
    return unique;
  }

  function saveKnownAccounts(list) {
    const unique = Array.from(new Set((Array.isArray(list) ? list : []).map(sanitizeAccountId).filter((x) => x && x !== UNKNOWN_ACCOUNT_ID)));
    saveJson(K_KNOWN_ACCOUNTS, unique);
  }

  function rememberKnownAccount(accountId) {
    const id = sanitizeAccountId(accountId);
    if (!id || id === UNKNOWN_ACCOUNT_ID) return;
    const list = getKnownAccounts();
    if (!list.includes(id)) {
      list.unshift(id);
      saveKnownAccounts(list);
    }
  }

  function getAccountNames() {
    const raw = loadJson(K_ACCOUNT_NAMES, {});
    return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  }

  function saveAccountNames(obj) {
    saveJson(K_ACCOUNT_NAMES, obj && typeof obj === "object" && !Array.isArray(obj) ? obj : {});
  }

  function getAccountName(accountId) {
    const id = sanitizeAccountId(accountId || getCurrentAccountId());
    const names = getAccountNames();
    const value = names[id];
    return String(value || "").trim();
  }

  function setAccountName(accountId, value) {
    const id = sanitizeAccountId(accountId || getCurrentAccountId());
    const names = getAccountNames();
    const clean = String(value || "").trim();
    if (clean) names[id] = clean;
    else delete names[id];
    saveAccountNames(names);
  }

  function getAccountDisplayLabel(accountId) {
    const id = sanitizeAccountId(accountId || getCurrentAccountId());
    const name = getAccountName(id);
    if (name) return name;
    if (id === UNKNOWN_ACCOUNT_ID) return "unknown";
    if (id.length <= 16) return id;
    return id.slice(0, 4) + "..." + id.slice(-4);
  }

  function getAccountFullLabel(accountId) {
    const id = sanitizeAccountId(accountId || getCurrentAccountId());
    const name = getAccountName(id);
    return name ? name + " (" + id + ")" : id;
  }

  function detectAccountIdFromCookie() {
    try {
      const match = document.cookie.match(/(?:^|;\s*)x-userid=([^;]+)/i);
      return match ? sanitizeAccountId(decodeURIComponent(match[1])) : null;
    } catch (_) {
      return null;
    }
  }

  function detectAccountIdFromText(textValue) {
    const s = String(textValue || "");
    const match = s.match(ACCOUNT_USER_URL_RE);
    return match ? sanitizeAccountId(match[1]) : null;
  }

  function updateAccountTitle() {
    const title = document.getElementById("gqp-main-title");
    if (title) {
      title.textContent = "Grok Usage - " + getAccountDisplayLabel();
      title.title = "Current account: " + getAccountFullLabel();
    }
  }

  function refreshAllAccountScopedUi() {
    S.usage = null;
    S.lastData = null;
    S.lastError = null;
    S.lastNotifyAt = {};
    updateAccountTitle();
    refreshUsageOnly();
    setTimeout(() => {
      try { loadQuota(); } catch (_) {}
    }, 50);
  }

  function noteDetectedAccountId(accountId, source, options) {
    const id = sanitizeAccountId(accountId);
    if (!id || id === UNKNOWN_ACCOUNT_ID) return false;
    const prev = getCurrentAccountId();
    rememberKnownAccount(id);
    if (prev === id) {
      updateAccountTitle();
      return false;
    }
    setCurrentAccountId(id);
    if (!(options && options.silent)) {
      setStatus("Detected account: " + getAccountDisplayLabel(id) + (source ? " from " + source : "") + ".");
    }
    refreshAllAccountScopedUi();
    return true;
  }

  function refreshDetectedAccountFromPage() {
    noteDetectedAccountId(detectAccountIdFromCookie(), "cookie", { silent: true });
    try {
      noteDetectedAccountId(
        detectAccountIdFromText(document.documentElement ? document.documentElement.outerHTML : ""),
        "page html",
        { silent: true }
      );
    } catch (_) {}
  }

  function collectKnownAndCurrentAccounts() {
    const list = getKnownAccounts().slice();
    const current = getCurrentAccountId();
    if (current && current !== UNKNOWN_ACCOUNT_ID && !list.includes(current)) list.unshift(current);
    return list;
  }

  setCurrentAccountId(detectAccountIdFromCookie() || lsGet(K_ACTIVE_ACCOUNT_ID, UNKNOWN_ACCOUNT_ID));

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
        width: 560px;
        z-index: 999999;
        background: rgba(18, 18, 20, 0.96);
        color: #fff;
        border: 1px solid rgba(255,255,255,0.12);
        border-radius: 12px;
        padding: 9px;
        font: 14px/1.25 system-ui, -apple-system, Segoe UI, Roboto, Ubuntu, Cantarell, Arial, sans-serif;
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
        font-size: 16px;
        letter-spacing: 0.2px;
      }
      #grok-quota-panel .gqp-btn {
        border: 1px solid rgba(255,255,255,0.14);
        background: rgba(255,255,255,0.08);
        color: #fff;
        border-radius: 9px;
        padding: 6px 9px;
        cursor: pointer;
        font-weight: 800;
        font-size: 13px;
      }
      #grok-quota-panel .gqp-btn:hover {
        background: rgba(255,255,255,0.14);
      }
      #grok-quota-panel .gqp-btn:disabled {
        opacity: 0.55;
        cursor: not-allowed;
      }
      #grok-quota-panel .gqp-content {
        margin-top: 7px;
      }
      #grok-quota-panel.gqp-folded .gqp-content {
        display: none;
      }
      #grok-quota-panel .gqp-controls {
        display: flex;
        gap: 7px;
        align-items: center;
        flex-wrap: wrap;
        margin-bottom: 7px;
      }
      #grok-quota-panel label {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        color: rgba(255,255,255,0.78);
        user-select: none;
      }
      #grok-quota-panel input[type="number"] {
        width: 66px;
        height: 31px;
        padding: 4px 7px;
        background: #2b2b2b;
        color: #fff;
        border: 1px solid rgba(255,255,255,0.18);
        border-radius: 8px;
        font: inherit;
      }
      #grok-quota-panel .gqp-grid {
        display: grid;
        grid-template-columns: 1fr;
        gap: 5px;
      }
      #grok-quota-panel .gqp-card {
        background: rgba(255,255,255,0.045);
        border: 1px solid rgba(255,255,255,0.08);
        border-radius: 10px;
        display: grid;
        grid-template-columns: minmax(88px, 0.82fr) 96px 116px;
        align-items: center;
        gap: 6px;
        padding: 6px 7px;
      }
      #grok-quota-panel .gqp-card-head {
        display: contents;
      }
      #grok-quota-panel .gqp-service-title {
        font-weight: 900;
        font-size: 15px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      #grok-quota-panel .gqp-badge {
        border-radius: 999px;
        padding: 3px 7px;
        font-size: 10px;
        font-weight: 900;
        letter-spacing: 0.3px;
        border: 1px solid rgba(255,255,255,0.12);
        text-align: center;
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
        display: contents;
      }
      #grok-quota-panel .gqp-stat {
        background: transparent;
        border: 0;
        border-radius: 0;
        padding: 0;
        min-width: 0;
      }
      #grok-quota-panel .gqp-label {
        display: none;
        font-size: 10px;
        color: rgba(255,255,255,0.55);
        text-transform: uppercase;
        letter-spacing: 0.5px;
        margin-bottom: 3px;
      }
      #grok-quota-panel .gqp-value {
        font-weight: 900;
        font-size: 14px;
        text-align: right;
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
        max-height: 68px;
        overflow: auto;
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        white-space: pre-wrap;
        font-size: 12px;
      }

      ^0px;
        padding: 6px;
        border-radius: 10px;
        font-size: 13px;
        line-height: 1.15;
      }
      #grok-quota-panel.gqp-compact .gqp-header {
        gap: 4px;
      }
      #grok-quota-panel.gqp-compact .gqp-title {
        font-size: 14px;
      }
      #grok-quota-panel.gqp-compact .gqp-btn {
        padding: 3px 5px;
        border-radius: 7px;
        font-size: 10px;
        line-height: 1.1;
      }
      #grok-quota-panel.gqp-compact .gqp-content {
        margin-top: 5px;
      }
      #grok-quota-panel.gqp-compact .gqp-controls {
        gap: 5px;
        margin-bottom: 5px;
      }
      #grok-quota-panel.gqp-compact input[type="number"] {
        width: 46px;
        height: 22px;
        padding: 2px 4px;
        border-radius: 6px;
        font-size: 10px;
      }
      #grok-quota-panel.gqp-compact .gqp-note {
        display: none;
      }
      #grok-quota-panel.gqp-compact .gqp-grid {
        gap: 3px;
      }
      #grok-quota-panel.gqp-compact .gqp-card {
        display: grid;
        grid-template-columns: minmax(82px, 0.9fr) 80px 96px;
        align-items: center;
        gap: 4px;
        padding: 4px 5px;
        border-radius: 7px;
      }
      #grok-quota-panel.gqp-compact .gqp-card-head {
        display: contents;
        margin-bottom: 0;
      }
      #grok-quota-panel.gqp-compact .gqp-service-title {
        font-size: 13px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      #grok-quota-panel.gqp-compact .gqp-badge {
        padding: 2px 4px;
        font-size: 8px;
        text-align: center;
      }
      #grok-quota-panel.gqp-compact .gqp-stats {
        display: contents;
      }
      #grok-quota-panel.gqp-compact .gqp-stat {
        padding: 0;
        border: 0;
        background: transparent;
        border-radius: 0;
      }
      #grok-quota-panel.gqp-compact .gqp-label {
        display: none;
      }
      #grok-quota-panel.gqp-compact .gqp-value {
        font-size: 13px;
        font-weight: 800;
        text-align: right;
      }
      #grok-quota-panel.gqp-compact .gqp-status {
        margin-top: 4px;
        padding: 4px 5px;
        border-radius: 7px;
        max-height: 38px;
        font-size: 10px;
      }
      #grok-quota-panel.gqp-folded {
        width: 345px;
        max-width: calc(100vw - 24px);
        padding: 7px;
      }
      #grok-quota-panel.gqp-folded .gqp-header {
        display: grid;
        grid-template-columns: minmax(82px, 1fr) repeat(5, 32px);
        gap: 6px;
        align-items: center;
      }
      #grok-quota-panel.gqp-folded .gqp-title {
        min-width: 0;
        flex: none;
        font-size: 13px;
        line-height: 1.05;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      #grok-quota-panel.gqp-folded .gqp-btn {
        min-width: 0;
        width: 32px;
        height: 32px;
        flex: none;
        white-space: nowrap;
        padding: 0;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        font-size: 14px;
      }
      #grok-quota-panel.gqp-compact.gqp-folded {
        width: 345px;
        max-width: calc(100vw - 24px);
        padding: 7px;
      }
      #grok-quota-panel.gqp-compact.gqp-folded .gqp-header {
        display: grid;
        grid-template-columns: minmax(82px, 1fr) repeat(5, 32px);
        gap: 6px;
        align-items: center;
      }
      #grok-quota-panel.gqp-compact.gqp-folded .gqp-title {
        min-width: 0;
        flex: none;
        font-size: 13px;
        line-height: 1.05;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      #grok-quota-panel.gqp-compact.gqp-folded .gqp-btn {
        min-width: 0;
        width: 32px;
        height: 32px;
        flex: none;
        white-space: nowrap;
        padding: 0;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        font-size: 14px;
      }
      #grok-quota-panel.gqp-compact .gqp-status {
        max-height: 20px;
        height: 20px;
        overflow: hidden;
        white-space: nowrap;
        text-overflow: ellipsis;
      }
      #grok-quota-panel.gqp-compact .gqp-legend {
        display: grid;
      }
      #grok-quota-panel .gqp-legend {
        display: grid;
        grid-template-columns: minmax(88px, 0.82fr) 96px 116px;
        gap: 4px;
        padding: 0 5px 2px 5px;
        color: rgba(255,255,255,0.48);
        font-size: 13px;
        font-weight: 800;
        text-transform: uppercase;
        letter-spacing: 0.3px;
      }
      #grok-quota-panel .gqp-legend span:not(:first-child) { text-align: right; }
      #grok-quota-panel .gqp-counter-row {
        display: flex;
        gap: 6px;
        align-items: center;
        flex-wrap: wrap;
        margin: 0 0 8px 0;
      }
      #grok-quota-panel .gqp-counter-note {
        color: rgba(255,255,255,0.72);
        font-size: 13px;
        font-weight: 700;
      }
      #grok-quota-panel.gqp-compact .gqp-counter-row {
        gap: 4px;
        margin-bottom: 4px;
      }
      #grok-quota-panel.gqp-compact .gqp-counter-note {
        display: none;
      }

      #grok-quota-panel .gqp-warn { color: #ffcc66; font-weight: 800; }

      #grok-quota-panel .gqp-icon-btn {
        min-width: 30px;
        padding-left: 6px;
        padding-right: 6px;
        font-size: 14px;
        line-height: 1;
      }
      .gqp-modal-backdrop {
        position: fixed;
        inset: 0;
        background: rgba(0,0,0,0.45);
        z-index: 1000000;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 18px;
      }
      .gqp-modal {
        width: min(980px, calc(100vw - 36px));
        max-height: min(780px, calc(100vh - 36px));
        overflow: hidden;
        background: rgba(20,20,22,0.98);
        color: #fff;
        border: 1px solid rgba(255,255,255,0.14);
        border-radius: 12px;
        box-shadow: 0 12px 40px rgba(0,0,0,0.55);
        font: 12px/1.35 system-ui, -apple-system, Segoe UI, Roboto, Ubuntu, Cantarell, Arial, sans-serif;
        display: flex;
        flex-direction: column;
      }
      .gqp-modal * { box-sizing: border-box; }
      .gqp-modal-head {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 10px 12px;
        border-bottom: 1px solid rgba(255,255,255,0.10);
      }
      .gqp-modal-title {
        flex: 1 1 auto;
        font-weight: 900;
        color: #4ade80;
        font-size: 14px;
      }
      .gqp-modal-body {
        padding: 10px 12px 12px;
        overflow: auto;
      }
      .gqp-modal-row {
        display: flex;
        gap: 7px;
        align-items: center;
        flex-wrap: wrap;
        margin-bottom: 7px;
      }
      .gqp-modal label {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        color: rgba(255,255,255,0.78);
      }
      .gqp-modal input[type="number"],
      .gqp-modal select {
        height: 28px;
        padding: 4px 6px;
        background: #2b2b2b;
        color: #fff;
        border: 1px solid rgba(255,255,255,0.18);
        border-radius: 8px;
        font: inherit;
      }
      .gqp-modal button {
        border: 1px solid rgba(255,255,255,0.14);
        background: rgba(255,255,255,0.08);
        color: #fff;
        border-radius: 9px;
        padding: 6px 9px;
        cursor: pointer;
        font-weight: 800;
        font-size: 13px;
      }
      .gqp-modal button:hover {
        background: rgba(255,255,255,0.14);
      }
      .gqp-history-table {
        width: 100%;
        border-collapse: collapse;
        table-layout: fixed;
      }
      .gqp-history-table th,
      .gqp-history-table td {
        border-bottom: 1px solid rgba(255,255,255,0.08);
        padding: 5px 6px;
        text-align: right;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .gqp-history-table th:first-child,
      .gqp-history-table td:first-child {
        text-align: left;
      }
      .gqp-history-table th {
        position: sticky;
        top: 0;
        background: #202024;
        z-index: 1;
        color: rgba(255,255,255,0.72);
        font-size: 10px;
        text-transform: uppercase;
        letter-spacing: 0.3px;
      }
      .gqp-limit-hit {
        color: #ffcc66;
        font-weight: 900;
      }
      .gqp-muted {
        color: rgba(255,255,255,0.55);
      }


      #grok-quota-panel .gqp-badges {
        display: grid;
        grid-template-columns: repeat(5, minmax(0, 1fr));
        gap: 5px;
        margin: 0 0 7px 0;
      }
      #grok-quota-panel .gqp-qbadge {
        border: 1px solid rgba(255,255,255,0.12);
        border-radius: 9px;
        padding: 5px 6px;
        background: rgba(255,255,255,0.06);
        min-width: 0;
        text-align: center;
        font-weight: 900;
        line-height: 1.12;
      }
      #grok-quota-panel .gqp-qbadge .gqp-qb-title {
        font-size: 12px;
        opacity: 0.85;
      }
      #grok-quota-panel .gqp-qbadge .gqp-qb-main {
        font-size: 15px;
        margin-top: 2px;
      }
      #grok-quota-panel .gqp-qbadge.safe {
        color: #9fffcf;
        background: rgba(0,255,140,0.10);
        border-color: rgba(0,255,140,0.25);
      }
      #grok-quota-panel .gqp-qbadge.warn {
        color: #ffdf7e;
        background: rgba(255,200,30,0.12);
        border-color: rgba(255,200,30,0.28);
      }
      #grok-quota-panel .gqp-qbadge.danger {
        color: #ff9b9b;
        background: rgba(255,60,60,0.12);
        border-color: rgba(255,60,60,0.30);
      }
      #grok-quota-panel.gqp-compact .gqp-badges {
        grid-template-columns: repeat(5, minmax(0, 1fr));
        gap: 3px;
        margin-bottom: 4px;
      }
      #grok-quota-panel.gqp-compact .gqp-qbadge {
        padding: 3px 2px;
        border-radius: 7px;
      }
      #grok-quota-panel.gqp-compact .gqp-qbadge .gqp-qb-title { font-size: 9px; }
      #grok-quota-panel.gqp-compact .gqp-qbadge .gqp-qb-main { font-size: 11px; }
      .gqp-floating-notice {
        position: fixed;
        left: 14px;
        top: 14px;
        z-index: 1000001;
        max-width: min(520px, calc(100vw - 28px));
        background: rgba(20,20,20,0.78);
        color: #ffdf7e;
        border: 1px solid rgba(255,220,80,0.35);
        border-radius: 12px;
        padding: 10px 12px;
        box-shadow: 0 10px 30px rgba(0,0,0,0.45);
        font: 16px/1.25 system-ui, -apple-system, Segoe UI, Roboto, Ubuntu, Cantarell, Arial, sans-serif;
        font-weight: 900;
        pointer-events: none;
      }
      .gqp-history-table tbody tr:nth-child(odd) { background: rgba(255,255,255,0.025); }
      .gqp-history-table tbody tr:hover { background: rgba(74,222,128,0.08); }
      .gqp-history-table tfoot td {
        position: sticky;
        bottom: 0;
        background: #202024;
        color: #fff;
        font-weight: 900;
        border-top: 1px solid rgba(255,255,255,0.15);
      }
      .gqp-history-table th:first-child,
      .gqp-history-table td:first-child {
        position: sticky;
        left: 0;
        z-index: 2;
        background: #202024;
      }
      .gqp-history-table tbody td:first-child { background: #1c1c20; }
      .gqp-note-cell {
        text-align: center !important;
        cursor: pointer;
        font-size: 15px;
      }


      /* v1.7.6: final minimized toolbar override - keep folded view tight and compact-sized */
      #grok-quota-panel.gqp-folded {
        width: 350px !important;
        max-width: calc(100vw - 24px) !important;
        padding: 6px !important;
      }
      #grok-quota-panel.gqp-folded .gqp-header {
        display: grid !important;
        grid-template-columns: minmax(58px, 1fr) repeat(6, 28px) !important;
        gap: 4px !important;
        align-items: center !important;
      }
      #grok-quota-panel.gqp-folded .gqp-title {
        font-size: 13px !important;
        line-height: 1.05 !important;
        min-width: 0 !important;
        white-space: nowrap !important;
        overflow: hidden !important;
        text-overflow: ellipsis !important;
        letter-spacing: 0 !important;
      }
      #grok-quota-panel.gqp-folded .gqp-btn {
        width: 28px !important;
        height: 28px !important;
        min-width: 0 !important;
        padding: 0 !important;
        margin: 0 !important;
        display: inline-flex !important;
        align-items: center !important;
        justify-content: center !important;
        font-size: 13px !important;
        border-radius: 8px !important;
        line-height: 1 !important;
      }
      #grok-quota-panel.gqp-compact.gqp-folded {
        width: 350px !important;
        max-width: calc(100vw - 24px) !important;
        padding: 6px !important;
      }
      #grok-quota-panel.gqp-compact.gqp-folded .gqp-header {
        display: grid !important;
        grid-template-columns: minmax(58px, 1fr) repeat(6, 28px) !important;
        gap: 4px !important;
        align-items: center !important;
      }
      #grok-quota-panel.gqp-compact.gqp-folded .gqp-title {
        font-size: 13px !important;
        line-height: 1.05 !important;
        min-width: 0 !important;
        white-space: nowrap !important;
        overflow: hidden !important;
        text-overflow: ellipsis !important;
        letter-spacing: 0 !important;
      }
      #grok-quota-panel.gqp-compact.gqp-folded .gqp-btn {
        width: 28px !important;
        height: 28px !important;
        min-width: 0 !important;
        padding: 0 !important;
        margin: 0 !important;
        display: inline-flex !important;
        align-items: center !important;
        justify-content: center !important;
        font-size: 13px !important;
        border-radius: 8px !important;
        line-height: 1 !important;
      }


      /* v1.8.0: 3-column readable layout with exact renewal time visible */
      #grok-quota-panel .gqp-card {
        grid-template-columns: minmax(88px, 0.82fr) 96px 116px !important;
      }
      #grok-quota-panel .gqp-legend {
        grid-template-columns: minmax(88px, 0.82fr) 96px 116px !important;
      }
      #grok-quota-panel .gqp-value {
        text-overflow: clip;
      }
      #grok-quota-panel .gqp-stat:last-child .gqp-value {
        font-size: 13px;
        letter-spacing: -0.2px;
      }
      #grok-quota-panel.gqp-compact {
        width: 360px !important;
      }
      #grok-quota-panel.gqp-compact .gqp-card {
        grid-template-columns: minmax(82px, 0.9fr) 80px 96px !important;
      }
      #grok-quota-panel.gqp-compact .gqp-legend {
        grid-template-columns: minmax(82px, 0.9fr) 80px 96px !important;
      }
      #grok-quota-panel.gqp-compact .gqp-stat:last-child .gqp-value {
        font-size: 11px;
        letter-spacing: -0.3px;
      }


      #grok-quota-panel .gqp-controls {
        display: none !important;
      }
      .gqp-history-table th:nth-child(1), .gqp-history-table td:nth-child(1) { width: 92px; }
      .gqp-history-table th:nth-child(2), .gqp-history-table td:nth-child(2) { width: 46px; text-align: center; }
      .gqp-history-table th:nth-child(n+3):nth-child(-n+7),
      .gqp-history-table td:nth-child(n+3):nth-child(-n+7) { width: 72px; }
      .gqp-history-table th:nth-child(8), .gqp-history-table td:nth-child(8) { text-align: left; }


      .gqp-refresh-actions {
        display: grid;
        grid-template-columns: 1fr;
        gap: 8px;
      }
      .gqp-refresh-action-row {
        display: grid;
        grid-template-columns: minmax(180px, 1fr) auto;
        gap: 8px;
        align-items: center;
        padding: 7px;
        border: 1px solid rgba(255,255,255,0.08);
        border-radius: 9px;
        background: rgba(255,255,255,0.035);
      }
      .gqp-refresh-action-row.full {
        grid-template-columns: 1fr;
      }
      .gqp-refresh-action-row .gqp-row-title {
        font-weight: 800;
        color: rgba(255,255,255,0.88);
      }
      .gqp-refresh-action-row .gqp-row-note {
        margin-top: 2px;
        font-size: 11px;
        color: rgba(255,255,255,0.55);
      }
      .gqp-refresh-action-row input {
        width: 150px;
      }
      .gqp-refresh-action-row button.primary {
        background: rgba(74,222,128,0.14);
        border-color: rgba(74,222,128,0.32);
      }
      .gqp-refresh-action-row button.warn {
        background: rgba(255,204,102,0.14);
        border-color: rgba(255,204,102,0.32);
      }
      .gqp-refresh-action-row button.danger {
        background: rgba(255,90,90,0.14);
        border-color: rgba(255,90,90,0.35);
        color: #ffb4b4;
      }


      /* v1.9.5 compact refresh control window */
      .gqp-modal.gqp-refresh-modal {
        width: min(560px, calc(100vw - 28px));
        max-height: min(640px, calc(100vh - 28px));
      }
      .gqp-modal.gqp-refresh-modal .gqp-modal-head {
        padding: 8px 10px;
      }
      .gqp-modal.gqp-refresh-modal .gqp-modal-body {
        padding: 8px 10px 10px;
      }
      .gqp-refresh-help {
        margin: 0 0 8px 0;
        color: rgba(255,255,255,0.65);
        font-size: 12px;
        line-height: 1.25;
      }
      .gqp-refresh-actions {
        gap: 6px;
      }
      .gqp-refresh-action-row {
        grid-template-columns: minmax(130px, 1fr) auto;
        gap: 6px;
        padding: 6px 7px;
        border-radius: 8px;
      }
      .gqp-refresh-action-row .gqp-row-title {
        font-size: 12px;
      }
      .gqp-refresh-action-row .gqp-row-note {
        display: none;
      }
      .gqp-refresh-action-row input {
        width: 150px;
        height: 28px;
      }
      .gqp-refresh-action-row button {
        padding: 5px 8px;
        min-width: 52px;
      }
      .gqp-refresh-inline-buttons {
        display: flex;
        gap: 6px;
        justify-content: flex-end;
        align-items: center;
        flex-wrap: nowrap;
      }
      .gqp-refresh-inline-buttons button {
        min-width: 42px;
      }


      .gqp-limit-modal {
        width: min(480px, calc(100vw - 28px));
      }
      .gqp-note-modal {
        width: min(640px, calc(100vw - 28px));
      }
      .gqp-note-textarea {
        width: 100%;
        min-height: 120px;
        resize: vertical;
        padding: 8px;
        background: #202020;
        color: #fff;
        border: 1px solid rgba(255,255,255,0.18);
        border-radius: 8px;
        font: 13px/1.35 system-ui, -apple-system, Segoe UI, Roboto, Ubuntu, Cantarell, Arial, sans-serif;
      }
      .gqp-auto-note-box {
        margin-top: 8px;
        padding: 8px;
        white-space: pre-wrap;
        background: rgba(255,255,255,0.045);
        border: 1px solid rgba(255,255,255,0.08);
        border-radius: 8px;
        color: rgba(255,255,255,0.72);
        font: 12px/1.35 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      }
      .gqp-history-table th {
        font-size: 9px !important;
        letter-spacing: 0.1px !important;
      }
      .gqp-history-table th:nth-child(3),
      .gqp-history-table th:nth-child(4),
      .gqp-history-table th:nth-child(5),
      .gqp-history-table th:nth-child(6),
      .gqp-history-table th:nth-child(7) {
        white-space: normal;
        line-height: 1.1;
      }
      .gqp-limit-actions {
        display: grid;
        gap: 7px;
      }
      .gqp-limit-action-row {
        display: grid;
        grid-template-columns: minmax(130px, 1fr) auto;
        gap: 6px;
        align-items: center;
        padding: 6px 7px;
        border: 1px solid rgba(255,255,255,0.08);
        border-radius: 8px;
        background: rgba(255,255,255,0.035);
      }
      .gqp-limit-action-row input {
        width: 100px;
        height: 28px;
      }


      /* v1.9.8: history note/details column combined with note emoji */
      .gqp-history-table th:nth-child(1), .gqp-history-table td:nth-child(1) { width: 92px !important; }
      .gqp-history-table th:nth-child(n+2):nth-child(-n+6),
      .gqp-history-table td:nth-child(n+2):nth-child(-n+6) { width: 88px !important; }
      .gqp-history-table th:nth-child(7), .gqp-history-table td:nth-child(7) {
        text-align: left !important;
        width: auto !important;
      }
      .gqp-note-details-cell {
        cursor: pointer;
      }


      .gqp-limits-row label {
        min-width: 178px;
        justify-content: space-between;
      }
      .gqp-limits-row input[type="number"] {
        width: 76px !important;
      }

      #grok-quota-panel .gqp-err { color: #ff8b8b; font-weight: 800; }

      /* v1.7.2 layout cleanup */
      #grok-quota-panel {
        width: 470px;
      }
      #grok-quota-panel .gqp-title {
        font-size: 17px;
        min-width: 92px;
      }
      #grok-quota-panel .gqp-card,
      #grok-quota-panel.gqp-compact .gqp-card {
        grid-template-columns: minmax(170px, 1fr) 108px 72px;
      }
      #grok-quota-panel .gqp-legend,
      #grok-quota-panel.gqp-compact .gqp-legend {
        grid-template-columns: minmax(170px, 1fr) 108px 72px;
      }
      #grok-quota-panel .gqp-service-title,
      #grok-quota-panel.gqp-compact .gqp-service-title {
        font-size: 14px;
        min-width: 0;
      }
      #grok-quota-panel .gqp-value.safe { color: #9fffcf; }
      #grok-quota-panel .gqp-value.warn { color: #ffdf7e; }
      #grok-quota-panel .gqp-value.danger { color: #ff9b9b; }
      ^0px;
      }
      #grok-quota-panel.gqp-folded,
      #grok-quota-panel.gqp-compact.gqp-folded {
        width: 450px;
        max-width: calc(100vw - 24px);
        padding: 8px;
      }
      #grok-quota-panel.gqp-folded .gqp-header,
      #grok-quota-panel.gqp-compact.gqp-folded .gqp-header {
        display: grid;
        grid-template-columns: minmax(100px, 1fr) auto auto auto auto auto;
        gap: 6px;
      }
      #grok-quota-panel.gqp-folded .gqp-title,
      #grok-quota-panel.gqp-compact.gqp-folded .gqp-title {
        font-size: 16px;
        white-space: nowrap;
      }
      #grok-quota-panel.gqp-folded .gqp-btn,
      #grok-quota-panel.gqp-compact.gqp-folded .gqp-btn {
        padding: 5px 8px;
        font-size: 12px;
      }
      #grok-quota-panel.gqp-folded .gqp-icon-btn,
      #grok-quota-panel.gqp-compact.gqp-folded .gqp-icon-btn {
        min-width: 30px;
        padding-left: 6px;
        padding-right: 6px;
      }
      #grok-quota-panel .gqp-counter-row {
        margin-bottom: 6px;
      }
      #grok-quota-panel .gqp-counter-note {
        font-size: 12px;
      }
      #grok-quota-panel.gqp-compact .gqp-counter-note {
        display: inline;
        font-size: 11px;
      }
      #grok-quota-panel .gqp-badges {
        display: none !important;
      }


      /* v1.7.3 usability/layout fixes */
      #grok-quota-panel {
        width: 500px;
        font-size: 15px;
      }
      #grok-quota-panel .gqp-title {
        font-size: 19px;
        min-width: 112px;
      }
      #grok-quota-panel .gqp-header {
        gap: 7px;
      }
      #grok-quota-panel .gqp-btn {
        min-width: 34px;
        min-height: 32px;
        padding: 6px 8px;
        font-size: 15px;
        line-height: 1;
      }
      #grok-quota-panel .gqp-icon-btn {
        min-width: 34px;
        padding-left: 8px;
        padding-right: 8px;
      }
      #grok-quota-panel .gqp-counter-note {
        font-size: 13px;
      }
      #grok-quota-panel .gqp-card,
      #grok-quota-panel .gqp-legend {
        grid-template-columns: minmax(190px, 1fr) 120px 76px;
      }
      #grok-quota-panel .gqp-service-title {
        font-size: 16px;
      }
      #grok-quota-panel .gqp-value {
        font-size: 16px;
      }
      #grok-quota-panel .gqp-legend {
        font-size: 13px;
      }
      ^0px;
        font-size: 12px;
      }
      #grok-quota-panel.gqp-compact .gqp-title {
        font-size: 15px;
        min-width: 92px;
      }
      #grok-quota-panel.gqp-compact .gqp-header {
        gap: 5px;
      }
      #grok-quota-panel.gqp-compact .gqp-btn {
        min-width: 28px;
        min-height: 26px;
        padding: 4px 6px;
        font-size: 12px;
      }
      #grok-quota-panel.gqp-compact .gqp-card,
      #grok-quota-panel.gqp-compact .gqp-legend {
        grid-template-columns: minmax(134px, 1fr) 88px 56px;
        gap: 4px;
      }
      #grok-quota-panel.gqp-compact .gqp-service-title {
        font-size: 12px;
      }
      #grok-quota-panel.gqp-compact .gqp-value {
        font-size: 12px;
      }
      #grok-quota-panel.gqp-compact .gqp-legend {
        font-size: 10px;
      }
      #grok-quota-panel.gqp-folded,
      #grok-quota-panel.gqp-compact.gqp-folded {
        width: 390px;
        max-width: calc(100vw - 24px);
        padding: 8px;
      }
      #grok-quota-panel.gqp-folded .gqp-header,
      #grok-quota-panel.gqp-compact.gqp-folded .gqp-header {
        display: grid;
        grid-template-columns: minmax(112px, 1fr) 34px 34px 34px 34px 34px;
        gap: 6px;
        align-items: center;
      }
      #grok-quota-panel.gqp-folded .gqp-title,
      #grok-quota-panel.gqp-compact.gqp-folded .gqp-title {
        font-size: 17px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      #grok-quota-panel.gqp-folded .gqp-btn,
      #grok-quota-panel.gqp-compact.gqp-folded .gqp-btn {
        min-width: 32px;
        width: 32px;
        height: 30px;
        padding: 4px 0;
        font-size: 14px;
        text-align: center;
      }
      .gqp-modal-head {
        cursor: move;
        user-select: none;
      }
      .gqp-modal-close-x {
        min-width: 30px;
        width: 30px;
        height: 28px;
        padding: 0 !important;
        font-size: 16px !important;
        line-height: 1 !important;
      }
      .gqp-modal-actions {
        position: sticky;
        bottom: 0;
        display: flex;
        justify-content: flex-end;
        gap: 8px;
        padding: 10px 0 0;
        margin-top: 10px;
        background: rgba(20,20,22,0.98);
        border-top: 1px solid rgba(255,255,255,0.10);
      }
      .gqp-save-btn {
        color: #9fffcf !important;
        background: rgba(0,255,140,0.12) !important;
        border-color: rgba(0,255,140,0.30) !important;
      }
      .gqp-close-btn {
        color: #ddd !important;
      }
      .gqp-danger-toggle,
      .gqp-danger-zone button {
        color: #ff9b9b !important;
        background: rgba(255,60,60,0.10) !important;
        border-color: rgba(255,60,60,0.30) !important;
      }
      .gqp-danger-zone {
        display: none;
        border: 1px solid rgba(255,60,60,0.35);
        background: rgba(255,60,60,0.07);
        border-radius: 10px;
        padding: 8px;
        margin-top: 8px;
        color: #ff9b9b;
      }
      .gqp-danger-zone.open {
        display: flex;
      }

    `;
    document.head.appendChild(st);
  }


  function defaultUsage() {
    return {
      schema: 2,
      day: getLocalDayKey(),
      total: { image: 0, imagePro: 0, imageEdit: 0, video: 0, video720p: 0 },
      today: { image: 0, imagePro: 0, imageEdit: 0, video: 0, video720p: 0 },
      windowSeconds: { image: 86400, imagePro: 7200, imageEdit: 86400, video: 7200, video720p: 7200 },
      recent: [],
      events: [],
    };
  }

  function getLocalDayKey() {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return y + "-" + m + "-" + day;
  }

  function normalizeUsage(raw) {
    const base = defaultUsage();
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return base;

    const out = Object.assign({}, base, raw);
    out.total = Object.assign({}, base.total, raw.total || {});
    out.today = Object.assign({}, base.today, raw.today || {});
    out.windowSeconds = Object.assign({}, base.windowSeconds, raw.windowSeconds || {});
    out.recent = Array.isArray(raw.recent) ? raw.recent.slice(-MAX_RECENT_ITEMS) : [];
    out.events = Array.isArray(raw.events) ? raw.events.slice(-200) : [];

    const todayKey = getLocalDayKey();
    if (out.day !== todayKey) {
      out.day = todayKey;
      out.today = Object.assign({}, base.today);
    }

    for (const service of SERVICES) {
      out.total[service.key] = Math.max(0, Number(out.total[service.key]) || 0);
      out.today[service.key] = Math.max(0, Number(out.today[service.key]) || 0);
      out.windowSeconds[service.key] = Math.max(60, Number(out.windowSeconds[service.key]) || Number(base.windowSeconds[service.key]) || 3600);
    }

    out.recent = out.recent
      .filter((item) => item && typeof item === "object" && item.serviceKey && item.key)
      .map((item) => ({
        key: String(item.key),
        serviceKey: String(item.serviceKey),
        kind: String(item.kind || "image"),
        detail: String(item.detail || ""),
        firstSeenAt: Number(item.firstSeenAt) || Date.now(),
        lastSeenAt: Number(item.lastSeenAt) || Number(item.firstSeenAt) || Date.now(),
        maxPercentage: Math.max(0, Math.min(100, Number(item.maxPercentage) || 0)),
        counted: !!item.counted,
        countedAt: item.countedAt != null ? Number(item.countedAt) || null : null,
        expiresAt: item.expiresAt != null ? Number(item.expiresAt) || null : null,
      }))
      .slice(-MAX_RECENT_ITEMS);

    return out;
  }

  function loadUsage() {
    S.usage = normalizeUsage(loadAccountJson(K_USAGE, null));
    saveUsage();
    return S.usage;
  }

  function saveUsage() {
    if (!S.usage) S.usage = normalizeUsage(null);
    saveAccountJson(K_USAGE, S.usage);
  }

  function resetTodayUsage() {
    const u = loadUsage();
    u.day = getLocalDayKey();
    u.today = defaultUsage().today;
    u.events.unshift({ at: new Date().toISOString(), type: "reset_today" });
    u.events = u.events.slice(0, 200);
    saveUsage();
    refreshUsageOnly();
    setStatus("Local today counters reset.", "warn");
  }

  function resetAllUsage() {
    S.usage = defaultUsage();
    saveUsage();
    refreshUsageOnly();
    setStatus("All local counters reset.", "warn");
  }

  function getWindowSeconds(serviceKey, usageObj) {
    const liveSec = S.lastData && S.lastData[serviceKey] && Number(S.lastData[serviceKey].windowSizeSeconds);
    if (Number.isFinite(liveSec) && liveSec > 0) return liveSec;
    const u = usageObj || S.usage || loadUsage();
    const stored = u && u.windowSeconds ? Number(u.windowSeconds[serviceKey]) : 0;
    if (Number.isFinite(stored) && stored > 0) return stored;
    return Number(defaultUsage().windowSeconds[serviceKey]) || 3600;
  }

  function updateWindowSizesFromQuota(data) {
    if (!data || typeof data !== "object") return;
    const u = loadUsage();
    let changed = false;
    for (const service of SERVICES) {
      const sec = Number(data[service.key] && data[service.key].windowSizeSeconds);
      if (Number.isFinite(sec) && sec > 0 && Number(u.windowSeconds[service.key]) !== sec) {
        u.windowSeconds[service.key] = sec;
        changed = true;
      }
    }
    if (changed) saveUsage();
  }

  function getWindowCount(serviceKey, usageObj) {
    const u = usageObj || S.usage || loadUsage();
    const now = Date.now();
    let total = 0;
    for (const item of (u.recent || [])) {
      if (item.serviceKey !== serviceKey) continue;
      if (!item.counted) continue;
      if (!Number.isFinite(item.expiresAt) || item.expiresAt <= now) continue;
      total += 1;
    }
    return total;
  }

  function getDisplayWindowCount(serviceKey, usageObj) {
    const used = getWindowCount(serviceKey, usageObj);
    const lock = getActiveLimitLock(serviceKey);
    if (!lock) return used;

    // While a server-confirmed/manual lockout is active, the service is effectively at
    // the reached limit even if older recent items expire from the rolling local list.
    // This keeps the UI stable instead of showing misleading values like 1/34 while red.
    return Math.max(used, getEffectiveLimitForService(serviceKey));
  }

  function localUsageLabel(serviceKey) {
    const used = getDisplayWindowCount(serviceKey);
    const limit = getEffectiveLimitForService(serviceKey);
    return String(used) + "/" + String(limit);
  }

  function refreshUsageOnly() {
    updateAccountTitle();
    // Touch locks so expired lockouts are removed before rendering.
    for (const service of SERVICES) getActiveLimitLock(service.key);
    const u = loadUsage();
    pruneRecentUsage(u);
    const grid = document.getElementById("gqp-grid");
    if (grid) renderCards(grid, S.lastData);
    const summary = document.getElementById("gqp-counter-summary");
    if (summary) summary.textContent = getUsageSummary();
  }

  function getUsageSummary() {
    const u = S.usage || loadUsage();
    const wi = getDisplayWindowCount("image", u) + getDisplayWindowCount("imagePro", u) + getDisplayWindowCount("imageEdit", u);
    const wv = getDisplayWindowCount("video", u) + getDisplayWindowCount("video720p", u);
    const ti = Number(u.today.image || 0) + Number(u.today.imagePro || 0) + Number(u.today.imageEdit || 0);
    const tv = Number(u.today.video || 0) + Number(u.today.video720p || 0);
    const ai = Number(u.total.image || 0) + Number(u.total.imagePro || 0) + Number(u.total.imageEdit || 0);
    const av = Number(u.total.video || 0) + Number(u.total.video720p || 0);
    return "Window: " + wi + " images, " + wv + " videos | Today: " + ti + ", " + tv + " | All: " + ai + ", " + av;
  }

  function incrementUsageCounters(u, serviceKey, amount, reason, detail) {
    const n = Math.max(1, Number(amount) || 1);
    u.today[serviceKey] = (Number(u.today[serviceKey]) || 0) + n;
    u.total[serviceKey] = (Number(u.total[serviceKey]) || 0) + n;
    u.events.unshift({
      at: new Date().toISOString(),
      serviceKey,
      amount: n,
      reason: reason || "detected_request",
      detail: detail || "",
    });
    u.events = u.events.slice(0, 200);
    recordHistoryUsage(serviceKey, n, detail || reason || "");
  }

  function decrementUsageCounters(u, serviceKey, amount, reason, detail) {
    const n = Math.max(1, Number(amount) || 1);
    u.today[serviceKey] = Math.max(0, (Number(u.today[serviceKey]) || 0) - n);
    u.total[serviceKey] = Math.max(0, (Number(u.total[serviceKey]) || 0) - n);

    const idx = (u.events || []).findIndex((event) =>
      event &&
      event.serviceKey === serviceKey &&
      (!reason || event.reason === reason) &&
      (!detail || event.detail === detail)
    );
    if (idx >= 0) u.events.splice(idx, 1);

    const h = loadHistory();
    const d = ensureHistoryDay(h, getLocalDayKey());
    d.used[serviceKey] = Math.max(0, (Number(d.used[serviceKey]) || 0) - n);
    if (Array.isArray(d.notes)) {
      const noteIdx = d.notes.findIndex((note) =>
        note &&
        note.type === "usage" &&
        note.serviceKey === serviceKey &&
        (!detail || note.detail === detail)
      );
      if (noteIdx >= 0) d.notes.splice(noteIdx, 1);
    }
    saveHistory(h);
  }

  function rollbackCountedUsage(serviceKey, amount, reason, detail, recentKey) {
    if (!recentKey) {
      setStatus("Skipped rollback: missing exact request key.", "warn");
      return;
    }

    const u = loadUsage();
    const n = Math.max(1, Number(amount) || 1);

    let removed = 0;
    u.recent = (u.recent || []).filter((item) => {
      if (
        removed < n &&
        item &&
        item.serviceKey === serviceKey &&
        item.counted &&
        item.key === recentKey
      ) {
        removed += 1;
        return false;
      }
      return true;
    });

    if (removed > 0) {
      decrementUsageCounters(u, serviceKey, removed, reason, detail);
      saveUsage();
      refreshUsageOnly();
      setStatus("Rolled back " + removed + " " + serviceTitle(serviceKey) + " after confirmed quota rejection.", "warn");
    } else {
      setStatus("No exact matching count found to roll back.", "warn");
    }
  }


  function pruneRecentUsage(u, nowArg) {
    const now = Number(nowArg) || Date.now();
    let changed = false;
    u.recent = (u.recent || []).filter((item) => {
      if (!item || !item.key || !item.serviceKey) {
        changed = true;
        return false;
      }

      if (!item.counted) {
        if (item.kind === "image" && now - Number(item.firstSeenAt || now) >= IMAGE_PENDING_GRACE_MS) {
          finalizeRecentItem(u, item, "pending_image_timeout", item.detail || "pending image timeout", now);
          changed = true;
          return true;
        }
        if (now - Number(item.lastSeenAt || item.firstSeenAt || now) > Math.max(IMAGE_PENDING_GRACE_MS * 3, getWindowSeconds(item.serviceKey, u) * 1000)) {
          changed = true;
          return false;
        }
        return true;
      }

      if (Number.isFinite(item.expiresAt) && item.expiresAt > now) return true;
      changed = true;
      return false;
    }).slice(-MAX_RECENT_ITEMS);

    if (changed) saveUsage();
    return changed;
  }

  function finalizeRecentItem(u, item, reason, detail, nowArg) {
    if (!item || item.counted) return false;
    const now = Number(nowArg) || Date.now();
    item.counted = true;
    item.countedAt = now;
    item.expiresAt = now + getWindowSeconds(item.serviceKey, u) * 1000;
    clearLimitLock(item.serviceKey, "Successful generation detected before estimated refresh");
    incrementUsageCounters(u, item.serviceKey, 1, reason, detail || item.detail || "");
    return true;
  }

  function recordCountedUsage(serviceKey, amount, reason, detail, recentKey, kind) {
    const service = SERVICES.find((x) => x.key === serviceKey);
    if (!service) return;

    const n = Math.max(1, Number(amount) || 1);
    const u = loadUsage();
    pruneRecentUsage(u);
    const now = Date.now();

    for (let i = 0; i < n; i++) {
      const key = String(recentKey || (kind || "event") + ":" + serviceKey + ":" + now + ":" + i + ":" + Math.random().toString(36).slice(2, 8));
      const item = {
        key,
        serviceKey,
        kind: kind || "event",
        detail: detail || "",
        firstSeenAt: now,
        lastSeenAt: now,
        maxPercentage: 100,
        counted: true,
        countedAt: now,
        expiresAt: now + getWindowSeconds(serviceKey, u) * 1000,
      };
      u.recent.push(item);
    }

    clearLimitLock(serviceKey, "Successful generation detected before estimated refresh");
    incrementUsageCounters(u, serviceKey, n, reason || "detected_request", detail || "");
    u.recent = u.recent.slice(-MAX_RECENT_ITEMS);
    saveUsage();
    refreshUsageOnly();
    setStatus("Counted " + n + " " + service.title + " locally.");
  }

  function rememberLastImageRequest(hit) {
    if (!hit || !hit.serviceKey) return;
    S.lastImageRequest = {
      serviceKey: hit.serviceKey,
      detail: hit.detail || "image request",
      at: Date.now(),
    };
  }

  function currentImageServiceFromLastRequest() {
    const last = S.lastImageRequest;
    if (!last || !last.serviceKey) return { serviceKey: "image", detail: "websocket image result" };
    if (Date.now() - Number(last.at || 0) > 5 * 60 * 1000) return { serviceKey: "image", detail: "websocket image result" };
    return { serviceKey: last.serviceKey, detail: last.detail || "websocket image result" };
  }

  function getImagePayloadKey(obj) {
    if (!obj || typeof obj !== "object") return "";
    return String(
      obj.id ||
      obj.job_id ||
      obj.url ||
      ((obj.request_id || "") + ":" + (obj.order != null ? obj.order : "") + ":" + (obj.grid_index != null ? obj.grid_index : ""))
    ).trim();
  }

  function getImageServiceFromPayload(obj) {
    const model = String(
      (obj && (obj.imageModel || obj.model_name || obj.modelName || obj.model || "")) || ""
    ).toLowerCase();

    if (
      obj &&
      (
        obj.is_alteration ||
        obj.is_image_edit ||
        obj.isImageEdit ||
        model.includes("image-edit") ||
        model.includes("image_edit") ||
        model.includes("edit")
      )
    ) return { serviceKey: "imageEdit", detail: "image edit" };

    if (obj && obj.is_pro === true) return { serviceKey: "imagePro", detail: "quality image" };
    if (obj && obj.is_pro === false) return { serviceKey: "image", detail: "speed image" };
    if (model.includes("quality") || model.includes("pro")) return { serviceKey: "imagePro", detail: "quality image" };
    return currentImageServiceFromLastRequest();
  }

  function rememberImagePayload(obj) {
    if (!obj || typeof obj !== "object") return;
    const key = getImagePayloadKey(obj);
    if (!key) return;

    const pct = Math.max(0, Math.min(100, Number(obj.percentage_complete) || 0));
    const inferred = getImageServiceFromPayload(obj);
    const serviceKey = inferred.serviceKey || "image";
    const detail = [
      inferred.detail || "image",
      obj.prompt ? String(obj.prompt).slice(0, 80) : "",
      obj.id || obj.job_id || "",
    ].filter(Boolean).join(" | ");

    const u = loadUsage();
    pruneRecentUsage(u);
    const now = Date.now();

    let item = (u.recent || []).find((x) => x.key === key);
    if (!item) {
      item = {
        key,
        serviceKey,
        kind: "image",
        detail,
        firstSeenAt: now,
        lastSeenAt: now,
        maxPercentage: pct,
        counted: false,
        countedAt: null,
        expiresAt: null,
      };
      u.recent.push(item);
    } else {
      item.lastSeenAt = now;
      item.maxPercentage = Math.max(Number(item.maxPercentage) || 0, pct);
      item.serviceKey = serviceKey || item.serviceKey;
      if (detail) item.detail = detail;
    }

    let countedNow = false;
    if (!item.counted && pct >= 100) {
      countedNow = finalizeRecentItem(u, item, "image_completed", detail, now);
    }

    u.recent = u.recent.slice(-MAX_RECENT_ITEMS);
    saveUsage();
    refreshUsageOnly();

    if (countedNow) {
      const service = SERVICES.find((x) => x.key === item.serviceKey);
      setStatus("Counted 1 " + (service ? service.title : "image") + " from imagine WebSocket.");
    } else if (!item.counted) {
      setStatus("Pending image detected at " + pct + "% - waiting for final image or timeout.");
    }
  }

  function normalizeStreamingImagePayload(item) {
    if (!item || typeof item !== "object") return null;

    const image = item.streamingImageGenerationResponse || item.imageGenerationResponse || item.generatedImage || null;
    if (!image || typeof image !== "object") return null;

    const imageId = image.assetId || image.imageId || image.id || "";
    const url = image.imageUrl || image.url || "";

    return {
      type: "image",
      id: imageId || url,
      job_id: imageId || url,
      url,
      prompt: item.prompt || "",
      full_prompt: item.full_prompt || "",
      percentage_complete: Number(image.progress != null ? image.progress : image.percentage_complete),
      width: image.width || item.width,
      height: image.height || item.height,
      moderated: image.moderated,
      r_rated: image.rRated,
      is_alteration: String(image.imageModel || "").toLowerCase().includes("edit"),
      is_image_edit: String(image.imageModel || "").toLowerCase().includes("edit"),
      imageModel: image.imageModel,
      model_name: image.imageModel,
      order: image.imageIndex,
      grid_index: image.imageIndex,
      request_id: item.responseId || image.responseId || "",
    };
  }

  function handleStreamingImagePayload(obj) {
    if (!obj || typeof obj !== "object") return false;

    let handled = false;

    const direct = normalizeStreamingImagePayload(obj);
    if (direct && direct.percentage_complete >= 0) {
      rememberImagePayload(direct);
      handled = true;
    }

    const response = obj.result && obj.result.response ? obj.result.response : null;
    if (response && typeof response === "object") {
      const nested = normalizeStreamingImagePayload(response);
      if (nested && nested.percentage_complete >= 0) {
        rememberImagePayload(nested);
        handled = true;
      }
    }

    return handled;
  }

  function handleGenerationResponsePayload(payload) {
    if (!payload) return;

    if (typeof payload === "string") {
      const lines = payload
        .split(/\r?\n+/)
        .map((line) => line.trim())
        .filter(Boolean);

      for (const line of lines) {
        const parsed = safeParseJson(line);
        if (parsed) handleGenerationResponsePayload(parsed);
      }
      return;
    }

    if (Array.isArray(payload)) {
      payload.forEach(handleGenerationResponsePayload);
      return;
    }

    if (!payload || typeof payload !== "object") return;

    handleStreamingImagePayload(payload);
  }

  async function inspectImageGenerationResponse(response, hit) {
    if (!response || !hit || isVideoServiceKey(hit.serviceKey)) return;

    try {
      const text = await response.clone().text();
      if (!text) return;
      handleGenerationResponsePayload(text);
    } catch (e) {
      console.warn("[GrokUsage] Could not inspect image generation response:", e);
    }
  }

  function handleImagineWsPayload(payload) {
    if (!payload) return;

    let obj = payload;
    if (typeof payload === "string") {
      obj = safeParseJson(payload);
      if (!obj) return;
    }

    if (Array.isArray(obj)) {
      obj.forEach(handleImagineWsPayload);
      return;
    }

    if (!obj || typeof obj !== "object") return;

    if (payloadLooksLikeQuotaLimit(obj)) {
      markRecentPendingVideoFailures("quota/limit message from imagine WebSocket");
    }

    if (obj.type === "image" && obj.blob) {
      rememberImagePayload(obj);
      return;
    }

    handleStreamingImagePayload(obj);
  }

  function safeParseJson(text) {
    try {
      if (typeof text !== "string") return null;
      return JSON.parse(text);
    } catch (_) {
      return null;
    }
  }

  function bodyLooksLikeImageRequest(body, bodyText) {
    const lower = String(bodyText || "").toLowerCase();
    const modelName = String(body && body.modelName || "").toLowerCase();
    const modelMap = body?.responseMetadata?.modelConfigOverride?.modelMap || {};

    return !!(
      modelMap.imageGenModelConfig ||
      modelMap.imageEditModelConfig ||
      body?.toolOverrides?.imageGen ||
      body?.toolOverrides?.imageEdit ||
      modelName.includes("image") ||
      modelName.includes("imagine") ||
      lower.includes("imagegenmodelconfig") ||
      lower.includes("imageeditmodelconfig") ||
      lower.includes("image_gen") ||
      lower.includes("imagen")
    );
  }

  function classifyGenerationRequest(url, method, bodyText) {
    if (!url || !String(url).includes(GENERATION_URL_PART)) return null;
    if (String(method || "GET").toUpperCase() !== "POST") return null;

    const body = safeParseJson(bodyText);
    if (!body || typeof body !== "object") return null;

    const modelName = String(body.modelName || "").toLowerCase();
    const modelMap = body?.responseMetadata?.modelConfigOverride?.modelMap || {};
    const videoConfig = modelMap.videoGenModelConfig || body?.toolOverrides?.videoGen || null;
    const isVideo = !!videoConfig || modelName === "imagine-video-gen" || modelName.includes("video");

    if (isVideo) {
      const res = String(videoConfig?.resolutionName || videoConfig?.resolution || "").toLowerCase();
      const serviceKey = res.includes("720") ? "video720p" : "video";
      return { serviceKey, amount: 1, detail: modelName || "video" };
    }

    if (!bodyLooksLikeImageRequest(body, bodyText)) return null;

    const lower = String(bodyText || "").toLowerCase();
    const imageConfig = modelMap.imageGenModelConfig || modelMap.imageEditModelConfig || body?.toolOverrides?.imageGen || body?.toolOverrides?.imageEdit || {};
    const candidateCount = Number(
      imageConfig?.numImages ||
      imageConfig?.numberOfImages ||
      imageConfig?.imageCount ||
      imageConfig?.n ||
      body?.responseMetadata?.imageCount ||
      body?.imageGenerationCount ||
      body?.imageCount ||
      0
    );

    const hasAttachment = Array.isArray(body.fileAttachments) && body.fileAttachments.length > 0;
    const isEdit = !!body?.toolOverrides?.imageEdit || lower.includes("imageedit") || lower.includes("image_edit") || (hasAttachment && lower.includes("edit"));
    const isQuality =
      modelName.includes("pro") ||
      modelName.includes("quality") ||
      lower.includes("imagepro") ||
      lower.includes("quality") ||
      lower.includes("high_quality") ||
      lower.includes("imagine-image-gen-pro");

    if (isEdit) return { serviceKey: "imageEdit", amount: Math.max(1, candidateCount || 1), detail: modelName || "image edit" };
    if (isQuality) return { serviceKey: "imagePro", amount: Math.max(1, candidateCount || 4), detail: modelName || "quality image" };

    return { serviceKey: "image", amount: Math.max(1, candidateCount || 1), detail: modelName || "speed image" };
  }


  function isVideoServiceKey(serviceKey) {
    return serviceKey === "video" || serviceKey === "video720p";
  }

  function textLooksLikeLimitOrFailure(text) {
    const lower = String(text || "").toLowerCase();
    if (!lower) return false;

    // Broad, but only applied to generation responses and imagine WebSocket messages.
    // This prevents quota-refused video attempts from being counted as generated videos.
    const badNeedles = [
      "quota",
      "limit",
      "rate limit",
      "too many",
      "try again",
      "not available",
      "insufficient",
      "exceeded",
      "exhausted",
      "blocked",
      "denied",
      "failed",
      "failure",
      "error",
      "cannot",
      "can't",
      "refused",
      "rejected",
      "429",
      "403",
    ];

    return badNeedles.some((needle) => lower.includes(needle));
  }


  function textLooksLikeQuotaLimit(text) {
    const lower = String(text || "").toLowerCase();
    if (!lower) return false;

    // Keep this strict. Moderation/server failure messages may contain generic
    // words like "limit", "blocked", "failed", or "error" while still consuming
    // quota. The only text-only signal we trust here is the exact quota rejection
    // wording Grok currently returns.
    return lower.includes("too many requests");
  }

  function payloadLooksLikeQuotaLimit(obj) {
    if (!obj || typeof obj !== "object") return false;
    try {
      const err = obj.error && typeof obj.error === "object" ? obj.error : null;
      const code = err && err.code != null ? Number(err.code) : (obj.code != null ? Number(obj.code) : null);
      const msg = String((err && err.message) || obj.message || "");

      // Primary confirmed limit response:
      // {"error":{"code":8,"message":"Too many requests","details":[]}}
      if (code === 8 && textLooksLikeQuotaLimit(msg)) return true;

      // Some transports may expose status instead of HTTP status.
      const status = Number(obj.status || obj.statusCode || obj.httpStatus || 0);
      if (status === 429) return true;

      return false;
    } catch (_) {
      return false;
    }
  }

  function payloadLooksLikeFailure(obj) {
    if (!obj || typeof obj !== "object") return false;

    const fields = [
      obj.type,
      obj.status,
      obj.current_status,
      obj.error,
      obj.error_code,
      obj.code,
      obj.message,
      obj.reason,
      obj.detail,
      obj.title,
    ];

    if (fields.some((x) => textLooksLikeLimitOrFailure(x))) return true;

    try {
      return textLooksLikeLimitOrFailure(JSON.stringify(obj));
    } catch (_) {
      return false;
    }
  }


  function loadLimitLocks() {
    const raw = loadAccountJson(K_LIMIT_LOCKS, {});
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    return raw;
  }

  function saveLimitLocks(obj) {
    saveAccountJson(K_LIMIT_LOCKS, obj && typeof obj === "object" && !Array.isArray(obj) ? obj : {});
  }

  function getManualRefreshHours() {
    const raw = parseFloat(accountLsGet(K_MANUAL_REFRESH_HOURS, ""));
    if (Number.isFinite(raw) && raw > 0) return raw;
    return null;
  }

  function getDefaultRefreshSeconds(serviceKey) {
    const manualHours = getManualRefreshHours();
    if (manualHours != null) return Math.max(60, Math.round(manualHours * 3600));
    return Math.max(60, Number(getWindowSeconds(serviceKey)) || 3600);
  }

  function clearLimitLock(serviceKey, reason) {
    const locks = loadLimitLocks();
    if (!locks[serviceKey]) return false;
    delete locks[serviceKey];
    saveLimitLocks(locks);
    refreshUsageOnly();
    setStatus((reason || "Limit lock cleared") + ".");
    return true;
  }

  function setLimitLock(serviceKey, renewAt, reason, options) {
    const service = SERVICES.find((x) => x.key === serviceKey);
    if (!service || !renewAt) return;

    const renewAtMs = new Date(renewAt).getTime();
    if (!Number.isFinite(renewAtMs) || renewAtMs <= Date.now()) {
      clearLimitLock(serviceKey, "Invalid or expired refresh time cleared");
      return;
    }

    const locks = loadLimitLocks();
    const windowSec = Math.max(60, Math.round((renewAtMs - Date.now()) / 1000));
    locks[serviceKey] = {
      serviceKey,
      reachedAt: (options && options.reachedAt) || new Date().toISOString(),
      renewAt: new Date(renewAtMs).toISOString(),
      windowSizeSeconds: windowSec,
      reason: reason || "manual refresh lock",
    };
    saveLimitLocks(locks);

    if (!(options && options.skipHistory)) {
      const h = loadHistory();
      const d = ensureHistoryDay(h, getLocalDayKey());
      const rec = d.quota[serviceKey];
      rec.samples = Math.max(1, Number(rec.samples) || 0);
      rec.lastObservedAt = new Date().toISOString();
      rec.lastAvailable = false;
      rec.quotaReached = true;
      rec.windowSizeSeconds = Math.max(Number(rec.windowSizeSeconds) || 0, windowSec);
      rec.maxWaitSeconds = Math.max(Number(rec.maxWaitSeconds) || 0, windowSec);
      rec.lastNextAvailableAt = new Date(renewAtMs).toISOString();
      saveHistory(h);
    }

    refreshUsageOnly();
    setStatus(service.title + " refresh set to " + formatRenewAt(renewAtMs) + ".", "warn");
  }

  function getActiveLimitLock(serviceKey) {
    const locks = loadLimitLocks();
    const lock = locks[serviceKey];
    if (!lock || typeof lock !== "object") return null;

    const renewAtMs = new Date(lock.renewAt || 0).getTime();
    if (!Number.isFinite(renewAtMs) || renewAtMs <= Date.now()) {
      delete locks[serviceKey];
      saveLimitLocks(locks);
      return null;
    }

    return lock;
  }

  function secondsUntilTimestamp(value) {
    const t = new Date(value || 0).getTime();
    if (!Number.isFinite(t)) return 0;
    return Math.max(0, Math.round((t - Date.now()) / 1000));
  }

  function validFutureIso(value) {
    if (!value) return null;
    const t = new Date(value).getTime();
    if (!Number.isFinite(t) || t <= Date.now()) return null;
    return new Date(t).toISOString();
  }

  function quotaInfoSaysLimited(q) {
    if (!q || typeof q !== "object") return false;
    const remaining = q.remainingQueries == null ? null : Number(q.remainingQueries);
    return Number.isFinite(remaining) && remaining <= 0;
  }

  function formatRenewAt(value) {
    if (!value) return "-";
    try {
      const d = new Date(value);
      if (Number.isNaN(d.getTime())) return String(value);
      const hh = String(d.getHours()).padStart(2, "0");
      const mm = String(d.getMinutes()).padStart(2, "0");
      const day = String(d.getDate()).padStart(2, "0");
      const month = String(d.getMonth() + 1).padStart(2, "0");
      return hh + ":" + mm + " " + day + "/" + month;
    } catch (_) {
      return String(value);
    }
  }

  function getRefreshLabel(serviceKey, fallbackWindowSeconds) {
    const lock = getActiveLimitLock(serviceKey);
    if (lock) {
      return formatRenewAt(lock.renewAt);
    }
    return formatReset(fallbackWindowSeconds);
  }

  function recordLimitReachedForService(serviceKey, reason, options) {
    const service = SERVICES.find((x) => x.key === serviceKey);
    if (!service) return;

    const exactRenewAt = validFutureIso(options && options.nextAvailableAt);
    const existing = getActiveLimitLock(serviceKey);
    if (existing && !exactRenewAt) {
      setStatus(service.title + " is still limited until " + formatRenewAt(existing.renewAt) + ". Failed retry ignored.", "warn");
      showFloatingNotice(service.title + " still limited until " + formatRenewAt(existing.renewAt));
      return;
    }

    const now = Date.now();
    const renewAt = exactRenewAt || new Date(now + getDefaultRefreshSeconds(serviceKey) * 1000).toISOString();
    const renewMs = new Date(renewAt).getTime();
    const windowSec = Math.max(60, Math.round((renewMs - now) / 1000));

    const locks = loadLimitLocks();
    locks[serviceKey] = {
      serviceKey,
      reachedAt: existing && existing.reachedAt ? existing.reachedAt : new Date(now).toISOString(),
      renewAt,
      windowSizeSeconds: windowSec,
      reason: reason || (exactRenewAt ? "quota_info nextAvailableAt" : "quota limit reached"),
    };
    saveLimitLocks(locks);

    const h = loadHistory();
    const d = ensureHistoryDay(h, getLocalDayKey());
    const rec = d.quota[serviceKey];

    rec.samples = Math.max(1, Number(rec.samples) || 0);
    rec.lastObservedAt = new Date(now).toISOString();
    rec.lastAvailable = false;

    // Do not increase hit count repeatedly when the service is already in an active lockout.
    if (!existing || exactRenewAt) {
      rec.limitHits = Math.max(1, Number(rec.limitHits) || 0);
    }

    rec.quotaReached = true;
    rec.windowSizeSeconds = Math.max(Number(rec.windowSizeSeconds) || 0, windowSec);
    rec.maxWaitSeconds = Math.max(Number(rec.maxWaitSeconds) || 0, windowSec);
    rec.lastNextAvailableAt = renewAt;

    const windowUsed = getWindowCount(serviceKey);
    rec.maxWindowUsed = Math.max(Number(rec.maxWindowUsed) || 0, Number(windowUsed) || 0);

    // When the server confirms the limit is reached, today's observed limit is
    // the amount successfully generated in the current rolling window. This can
    // be lower than older learned/default limits when Grok reduces quota.
    if (windowUsed > 0) {
      rec.quotaEstimate = Math.max(1, Math.round(Number(windowUsed) || 0));
      rec.effectiveLimit = rec.quotaEstimate;
    }

    d.notes = Array.isArray(d.notes) ? d.notes : [];
    const lastNote = d.notes[0];
    if (!lastNote || lastNote.type !== "limit_reached" || lastNote.serviceKey !== serviceKey || lastNote.renewAt !== renewAt) {
      d.notes.unshift({
        at: new Date(now).toISOString(),
        type: "limit_reached",
        serviceKey,
        detail: reason || (exactRenewAt ? "quota_info nextAvailableAt" : "quota limit reached"),
        renewAt,
      });
      d.notes = d.notes.slice(0, 60);
    }
    saveHistory(h);

    const detectedLimit = getTodaysReachedLimitForService(serviceKey);

    refreshUsageOnly();
    setStatus(service.title + " limit reached" + (detectedLimit != null ? " at " + detectedLimit : "") + ". Renewal: " + formatRenewAt(renewAt) + ".", "warn");
    showFloatingNotice(service.title + " limit reached" + (detectedLimit != null ? " at " + detectedLimit : "") + " - renews at " + formatRenewAt(renewAt));
  }

  async function responseLooksAcceptedForGeneration(response) {
    if (!response) {
      return { accepted: false, reason: "missing response", quotaLimited: false };
    }

    if (!response.ok) {
      return {
        accepted: false,
        reason: "HTTP " + response.status,
        quotaLimited: response.status === 429,
      };
    }

    let bodyText = "";
    try {
      bodyText = await response.clone().text();
    } catch (_) {
      return { accepted: true, reason: "HTTP OK, response body unreadable", quotaLimited: false };
    }

    let obj = null;
    try {
      obj = bodyText ? JSON.parse(bodyText) : null;
    } catch (_) {}

    // Only the specific quota/limit response should block counting. Other OK
    // responses, including moderation/failure objects, can still consume quota.
    if (payloadLooksLikeQuotaLimit(obj) || textLooksLikeQuotaLimit(bodyText)) {
      return { accepted: false, reason: "quota/limit reached", quotaLimited: true };
    }

    return { accepted: true, reason: "request accepted", quotaLimited: false };
  }

  function createPendingVideoAttempt(hit) {
    const now = Date.now();
    const attempt = {
      id: "video_request:" + (hit.serviceKey || "video") + ":" + now + ":" + Math.random().toString(36).slice(2, 10),
      serviceKey: hit.serviceKey,
      amount: Math.max(1, Number(hit.amount) || 1),
      detail: hit.detail || "video",
      createdAt: now,
      acceptedAt: null,
      failedAt: null,
      counted: false,
      countReason: "video_request_sent",
      countTimer: null,
      cleanupTimer: null,
    };

    // Count video attempts immediately when the request is sent. If the server
    // replies with a true quota rejection, the count is rolled back below.
    recordCountedUsage(attempt.serviceKey, attempt.amount, attempt.countReason, attempt.detail, attempt.id, "video");
    attempt.counted = true;
    attempt.countedRecentKey = attempt.id;

    S.pendingVideoAttempts.push(attempt);
    S.pendingVideoAttempts = S.pendingVideoAttempts.slice(-20);
    setStatus("Counted video request immediately; waiting only to detect quota rejection.");
    return attempt;
  }

  function markVideoAttemptFailed(attempt, reason, options) {
    if (!attempt || attempt.failedAt) return;
    attempt.failedAt = Date.now();

    if (attempt.countTimer) clearTimeout(attempt.countTimer);
    if (attempt.cleanupTimer) clearTimeout(attempt.cleanupTimer);

    const quotaLimited = !!(options && options.quotaLimited) || textLooksLikeQuotaLimit(reason);
    const shouldRollback = !!attempt.counted && (quotaLimited || String(reason || "").includes("network error"));
    if (shouldRollback) {
      rollbackCountedUsage(attempt.serviceKey, attempt.amount, "video_request_sent", attempt.detail, attempt.countedRecentKey || attempt.id);
      attempt.counted = false;
    }

    if (quotaLimited) {
      recordLimitReachedForService(attempt.serviceKey, reason || "quota limit reached");
      fetchQuotaInfoAfterLimit(attempt.serviceKey);
    }

    setStatus(quotaLimited ? "Quota rejection detected. Video request count rolled back." : "Video request failed before acceptance: " + (reason || "failure detected"), "warn");

    setTimeout(() => {
      S.pendingVideoAttempts = S.pendingVideoAttempts.filter((x) => x !== attempt);
    }, 5000);
  }

  function markRecentPendingVideoFailures(reason) {
    const now = Date.now();
    for (const attempt of S.pendingVideoAttempts.slice()) {
      if (!attempt || attempt.counted || attempt.failedAt) continue;
      if (now - Number(attempt.createdAt || 0) > VIDEO_FAILURE_WATCH_MS) continue;
      markVideoAttemptFailed(attempt, reason || "failure message detected", { quotaLimited: textLooksLikeQuotaLimit(reason) });
    }
  }

  function markVideoAttemptAccepted(attempt, reason) {
    if (!attempt || attempt.failedAt) return;
    attempt.acceptedAt = Date.now();

    if (attempt.countTimer) clearTimeout(attempt.countTimer);
    if (attempt.cleanupTimer) clearTimeout(attempt.cleanupTimer);

    if (!attempt.counted) {
      recordCountedUsage(attempt.serviceKey, attempt.amount, "video_request_accepted", attempt.detail, attempt.id, "video");
      attempt.counted = true;
      setStatus("Counted accepted video request locally.");
    } else {
      setStatus("Video request accepted; already counted on request.");
    }

    setTimeout(() => {
      S.pendingVideoAttempts = S.pendingVideoAttempts.filter((x) => x !== attempt);
    }, 2000);
  }

  function installGenerationCounterInterceptor() {
    if (window.__grokQuotaLocalCounterInstalled) return;
    window.__grokQuotaLocalCounterInstalled = true;

    const originalFetch = window.fetch;
    window.fetch = async function (input, init) {
      let url = input;
      if (input instanceof Request) url = input.url;

      const method = String(init?.method || (input instanceof Request ? input.method : "GET")).toUpperCase();
      let bodyText = null;
      let hit = null;
      let pendingVideoAttempt = null;

      try {
        if (init && typeof init.body === "string") {
          bodyText = init.body;
        } else if (input instanceof Request && !init?.body && method === "POST") {
          bodyText = await input.clone().text();
        }

        noteDetectedAccountId(detectAccountIdFromText(String(url || "")), "fetch url", { silent: true });
        noteDetectedAccountId(detectAccountIdFromText(bodyText), "fetch body", { silent: true });

        hit = classifyGenerationRequest(url, method, bodyText);
        if (hit) {
          if (isVideoServiceKey(hit.serviceKey)) {
            pendingVideoAttempt = createPendingVideoAttempt(hit);
          } else {
            // Images are counted from the imagine WebSocket result stream to avoid assuming 1 vs 4.
            rememberLastImageRequest(hit);
            setStatus("Image request detected; waiting for WebSocket image results.");
          }
        }
      } catch (e) {
        console.warn("[GrokUsage] Local counter pre-fetch interceptor error:", e);
      }

      let response;
      try {
        response = await originalFetch.apply(this, arguments);
      } catch (e) {
        if (pendingVideoAttempt) markVideoAttemptFailed(pendingVideoAttempt, "network error", { quotaLimited: false });
        throw e;
      }

      try {
        if (response && response.clone) {
          const txt = await response.clone().text().catch(() => "");
          noteDetectedAccountId(detectAccountIdFromText(txt), "fetch response", { silent: true });
        }
      } catch (_) {}

      if (pendingVideoAttempt) {
        try {
          const result = await responseLooksAcceptedForGeneration(response.clone ? response.clone() : response);
          if (result.accepted) {
            markVideoAttemptAccepted(pendingVideoAttempt, result.reason);
          } else {
            markVideoAttemptFailed(pendingVideoAttempt, result.reason, { quotaLimited: !!result.quotaLimited });
          }
        } catch (e) {
          console.warn("[GrokUsage] Local counter post-fetch interceptor error:", e);
          // Fail closed for videos: if we cannot inspect acceptance, do not count immediately.
          markVideoAttemptFailed(pendingVideoAttempt, "could not verify request acceptance", { quotaLimited: false });
        }
      } else if (hit && !isVideoServiceKey(hit.serviceKey)) {
        inspectImageGenerationResponse(response, hit);
      }

      return response;
    };
  }

  function installImagineWebSocketInterceptor() {
    if (window.__grokQuotaImagineWsInstalled) return;
    window.__grokQuotaImagineWsInstalled = true;

    const OriginalWebSocket = window.WebSocket;
    if (!OriginalWebSocket) return;

    function WrappedWebSocket(url, protocols) {
      const ws = protocols !== undefined ? new OriginalWebSocket(url, protocols) : new OriginalWebSocket(url);
      try {
        const wsUrl = String(url && url.url ? url.url : url || "");
        noteDetectedAccountId(detectAccountIdFromText(wsUrl), "websocket url", { silent: true });
        if (wsUrl.includes(IMAGINE_LISTEN_WS_PART)) {
          setStatus("Watching imagine WebSocket for image results.");
          ws.addEventListener("message", (event) => {
            try {
              noteDetectedAccountId(detectAccountIdFromText(event && event.data), "websocket message", { silent: true });
              handleImagineWsPayload(event && event.data);
            } catch (e) {
              console.warn("[GrokUsage] WebSocket image counter error:", e);
            }
          });
        }
      } catch (e) {
        console.warn("[GrokUsage] WebSocket wrapper error:", e);
      }
      return ws;
    }

    try {
      Object.setPrototypeOf(WrappedWebSocket, OriginalWebSocket);
      WrappedWebSocket.prototype = OriginalWebSocket.prototype;
      Object.defineProperty(WrappedWebSocket, "name", { value: "WebSocket" });
    } catch (_) {}

    window.WebSocket = WrappedWebSocket;
  }


  function getHistoryDays() {
    return clamp(parseInt(lsGet(K_HISTORY_DAYS, String(DEFAULT_HISTORY_DAYS)), 10), MIN_HISTORY_DAYS, MAX_HISTORY_DAYS);
  }


  function defaultNotifyServices() {
    return { image: true, imagePro: true, imageEdit: true, video: true, video720p: true };
  }

  function getDefaultLimits() {
    const raw = loadAccountJson(K_DEFAULT_LIMITS, null);
    const out = Object.assign({}, DEFAULT_QUOTA_LIMITS, raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {});
    for (const service of SERVICES) {
      out[service.key] = Math.max(0, Number.isFinite(Number(out[service.key])) ? Number(out[service.key]) : Number(DEFAULT_QUOTA_LIMITS[service.key]) || 0);
    }
    return out;
  }

  function saveDefaultLimits(obj) {
    const out = Object.assign({}, getDefaultLimits(), obj || {});
    for (const service of SERVICES) out[service.key] = Math.max(0, Number.isFinite(Number(out[service.key])) ? Number(out[service.key]) : 0);
    saveAccountJson(K_DEFAULT_LIMITS, out);
  }

  function getExactLimitOverrides() {
    const raw = loadAccountJson(K_EXACT_LIMIT_OVERRIDES, null);
    return Object.assign({ image: false, imagePro: false, imageEdit: false, video: false, video720p: false }, raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {});
  }

  function setExactLimitOverride(serviceKey, enabled) {
    const flags = getExactLimitOverrides();
    flags[serviceKey] = !!enabled;
    saveAccountJson(K_EXACT_LIMIT_OVERRIDES, flags);
  }

  function isExactLimitOverride(serviceKey) {
    const flags = getExactLimitOverrides();
    return !!flags[serviceKey];
  }

  function builtinDefaultLimitForService(serviceKey) {
    return Math.max(0, Number.isFinite(Number(DEFAULT_QUOTA_LIMITS[serviceKey])) ? Number(DEFAULT_QUOTA_LIMITS[serviceKey]) : 0);
  }

  function setDefaultLimitForService(serviceKey, value) {
    const raw = Number(value);
    if (!Number.isFinite(raw) || raw < 0) return false;
    const n = Math.max(0, Math.round(raw));
    const limits = getDefaultLimits();
    limits[serviceKey] = n;
    saveDefaultLimits(limits);
    setExactLimitOverride(serviceKey, true);
    refreshUsageOnly();
    setStatus("Default limit for " + serviceTitle(serviceKey) + " set to " + n + ".");
    return true;
  }

  function serviceTitle(serviceKey) {
    const service = SERVICES.find((x) => x.key === serviceKey);
    return service ? service.title : serviceKey;
  }

  function getNotifyServices() {
    const raw = loadJson(K_NOTIFY_SERVICES, null);
    return Object.assign(defaultNotifyServices(), raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {});
  }

  function saveNotifyServices(obj) {
    saveJson(K_NOTIFY_SERVICES, Object.assign(defaultNotifyServices(), obj || {}));
  }

  function getBackupIntervalDays() {
    return clamp(parseInt(lsGet(K_BACKUP_INTERVAL_DAYS, String(DEFAULT_BACKUP_REMINDER_DAYS)), 10), 1, 3650);
  }

  function getTodaysReachedLimitForService(serviceKey) {
    const h = loadHistory();
    const day = h.days && h.days[getLocalDayKey()] ? h.days[getLocalDayKey()] : null;
    const q = day && day.quota && day.quota[serviceKey] ? day.quota[serviceKey] : null;
    if (!q || !q.quotaReached) return null;

    const observed = Number(q.quotaEstimate != null ? q.quotaEstimate : q.effectiveLimit);
    if (Number.isFinite(observed) && observed > 0) return Math.max(1, Math.round(observed));

    const maxUsed = Number(q.maxWindowUsed);
    if (Number.isFinite(maxUsed) && maxUsed > 0) return Math.max(1, Math.round(maxUsed));

    return null;
  }

  function getEffectiveLimitForService(serviceKey) {
    const defaults = getDefaultLimits();
    let limit = Number.isFinite(Number(defaults[serviceKey])) ? Number(defaults[serviceKey]) : 0;

    // If the site confirmed today's reached limit, prefer the observed count
    // even if the user/default setting is higher. Example: setting is 30, but
    // Grok stops after 26 accepted video requests, so the active display should
    // become 26/26 instead of jumping to 30/30.
    const todaysReached = getTodaysReachedLimitForService(serviceKey);
    if (todaysReached != null) return todaysReached;

    // If the user explicitly edited this service limit, use that value exactly
    // until the site confirms a different reached limit for the current day.
    if (isExactLimitOverride(serviceKey)) {
      return Math.max(0, Math.round(limit));
    }

    const h = loadHistory();
    for (const dayKey of Object.keys(h.days || {})) {
      const q = h.days[dayKey] && h.days[dayKey].quota && h.days[dayKey].quota[serviceKey];
      if (!q) continue;
      if (q.quotaReached && q.quotaEstimate != null) limit = Math.max(limit, Number(q.quotaEstimate) || 0);
      if (q.maxWindowUsed != null) limit = Math.max(limit, Number(q.maxWindowUsed) || 0);
      if (q.effectiveLimit != null) limit = Math.max(limit, Number(q.effectiveLimit) || 0);
    }
    return Math.max(0, Math.round(limit));
  }

  function getRecentLimitForDay(day, serviceKey) {
    const defaults = getDefaultLimits();
    const q = day && day.quota && day.quota[serviceKey] ? day.quota[serviceKey] : null;
    const defaultLimit = Number.isFinite(Number(defaults[serviceKey])) ? Number(defaults[serviceKey]) : 0;
    if (!q) return defaultLimit;

    if (q.quotaReached) {
      const observed = Number(q.quotaEstimate != null ? q.quotaEstimate : q.effectiveLimit);
      if (Number.isFinite(observed) && observed > 0) return Math.max(1, Math.round(observed));
      const maxUsed = Number(q.maxWindowUsed);
      if (Number.isFinite(maxUsed) && maxUsed > 0) return Math.max(1, Math.round(maxUsed));
    }

    return Math.max(
      defaultLimit,
      Number(q.effectiveLimit) || 0,
      Number(q.maxWindowUsed) || 0,
      q.quotaReached ? Number(q.quotaEstimate) || 0 : 0
    );
  }

  function defaultHistory() {
    return {
      schema: 1,
      exportedAt: null,
      days: {},
    };
  }

  function normalizeHistory(raw) {
    const base = defaultHistory();
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return base;
    const out = Object.assign({}, base, raw);
    out.days = raw.days && typeof raw.days === "object" && !Array.isArray(raw.days) ? raw.days : {};
    return out;
  }

  function loadHistory() {
    return normalizeHistory(loadAccountJson(K_HISTORY, null));
  }

  function saveHistory(history) {
    const h = normalizeHistory(history);
    h.exportedAt = new Date().toISOString();
    saveAccountJson(K_HISTORY, h);
  }

  function ensureHistoryDay(history, dayKey) {
    const h = history || loadHistory();
    const key = dayKey || getLocalDayKey();
    if (!h.days[key]) {
      h.days[key] = {
        date: key,
        used: { image: 0, imagePro: 0, imageEdit: 0, video: 0, video720p: 0 },
        quota: {},
        notes: [],
        note: "",
      };
    }
    const d = h.days[key];
    d.used = Object.assign({ image: 0, imagePro: 0, imageEdit: 0, video: 0, video720p: 0 }, d.used || {});
    d.note = String(d.note || "");
    d.quota = d.quota && typeof d.quota === "object" && !Array.isArray(d.quota) ? d.quota : {};
    for (const service of SERVICES) {
      if (!d.quota[service.key]) {
        d.quota[service.key] = {
          samples: 0,
          minRemaining: null,
          maxRemaining: null,
          lastRemaining: null,
          windowSizeSeconds: null,
          limitHits: 0,
          quotaReached: false,
          quotaEstimate: null,
          maxWaitSeconds: 0,
          lastNextAvailableAt: null,
          lastAvailable: null,
          lastObservedAt: null,
          maxWindowUsed: 0,
          effectiveLimit: null,
        };
      }
    }
    return d;
  }

  function recordHistoryUsage(serviceKey, amount, detail) {
    const service = SERVICES.find((x) => x.key === serviceKey);
    if (!service) return;
    const n = Math.max(1, Number(amount) || 1);
    const h = loadHistory();
    const d = ensureHistoryDay(h, getLocalDayKey());
    d.used[serviceKey] = (Number(d.used[serviceKey]) || 0) + n;
    d.notes = Array.isArray(d.notes) ? d.notes : [];
    d.notes.unshift({
      at: new Date().toISOString(),
      type: "usage",
      serviceKey,
      amount: n,
      detail: detail || "",
    });
    d.notes = d.notes.slice(0, 60);
    saveHistory(h);
  }

  function secondsUntil(value) {
    if (!value) return 0;
    const t = new Date(value).getTime();
    if (!Number.isFinite(t)) return 0;
    return Math.max(0, Math.round((t - Date.now()) / 1000));
  }

  function recordQuotaHistory(data) {
    if (!data || typeof data !== "object") return;
    const h = loadHistory();
    const d = ensureHistoryDay(h, getLocalDayKey());
    let changed = false;

    for (const service of SERVICES) {
      const q = data[service.key];
      if (!q || typeof q !== "object") continue;

      const rec = d.quota[service.key];
      const remainingRaw = q.remainingQueries;
      const remaining = remainingRaw == null ? null : Number(remainingRaw);
      const available = !!q.available;
      const windowSec = Number(q.windowSizeSeconds);
      const waitSec = q.nextAvailableAt ? secondsUntil(q.nextAvailableAt) : 0;
      const windowUsed = getWindowCount(service.key);
      const defaultLimit = getDefaultLimits()[service.key] || 1;

      rec.samples = (Number(rec.samples) || 0) + 1;
      rec.lastObservedAt = new Date().toISOString();
      rec.lastAvailable = available;
      rec.maxWindowUsed = Math.max(Number(rec.maxWindowUsed) || 0, Number(windowUsed) || 0);
      rec.effectiveLimit = Math.max(Number(rec.effectiveLimit) || 0, Number(defaultLimit) || 0, Number(rec.maxWindowUsed) || 0);

      if (Number.isFinite(remaining)) {
        rec.lastRemaining = remaining;
        rec.minRemaining = rec.minRemaining == null ? remaining : Math.min(Number(rec.minRemaining), remaining);
        rec.maxRemaining = rec.maxRemaining == null ? remaining : Math.max(Number(rec.maxRemaining), remaining);

        const estimated = windowUsed + remaining;
        if (estimated > 0) {
          rec.quotaEstimate = rec.quotaEstimate == null ? estimated : Math.max(Number(rec.quotaEstimate) || 0, estimated);
          rec.effectiveLimit = Math.max(Number(rec.effectiveLimit) || 0, Number(rec.quotaEstimate) || 0);
        }
      }

      if (Number.isFinite(windowSec) && windowSec > 0) rec.windowSizeSeconds = windowSec;
      if (q.nextAvailableAt) rec.lastNextAvailableAt = q.nextAvailableAt;
      if (waitSec > Number(rec.maxWaitSeconds || 0)) rec.maxWaitSeconds = waitSec;

      if (!available || (Number.isFinite(remaining) && remaining <= 0)) {
        if (!rec.quotaReached) rec.limitHits = (Number(rec.limitHits) || 0) + 1;
        rec.quotaReached = true;
        if (windowUsed > 0) {
          rec.quotaEstimate = Math.max(1, Math.round(Number(windowUsed) || 0));
          rec.effectiveLimit = rec.quotaEstimate;
        }
        if (!rec.maxWaitSeconds && Number.isFinite(windowSec) && windowSec > 0) rec.maxWaitSeconds = windowSec;
      }

      changed = true;
    }

    if (changed) saveHistory(h);
  }

  function serviceShort(serviceKey) {
    if (serviceKey === "image") return "S";
    if (serviceKey === "imagePro") return "Q";
    if (serviceKey === "imageEdit") return "E";
    if (serviceKey === "video") return "V";
    if (serviceKey === "video720p") return "720";
    return serviceKey;
  }

  function fmtDuration(seconds) {
    const n = Number(seconds);
    if (!Number.isFinite(n) || n <= 0) return "-";
    if (n < 60) return Math.round(n) + "s";
    if (n < 3600) return Math.round(n / 60) + "m";
    if (n < 86400) return (n / 3600).toFixed(n % 3600 === 0 ? 0 : 1) + "h";
    return (n / 86400).toFixed(1) + "d";
  }

  function sumUsed(day, keys) {
    return keys.reduce((acc, key) => acc + (Number(day.used && day.used[key]) || 0), 0);
  }

  function quotaCell(day, key) {
    const q = day.quota && day.quota[key] ? day.quota[key] : null;
    if (!q || !q.samples) return "limit " + getRecentLimitForDay(day, key);
    const parts = [];
    if (q.quotaReached) parts.push("hit");
    else parts.push("not hit");
    parts.push("limit " + getRecentLimitForDay(day, key));
    if (q.lastNextAvailableAt) parts.push("renew " + formatRenewAt(q.lastNextAvailableAt));
    else if (q.maxWaitSeconds) parts.push("wait " + fmtDuration(q.maxWaitSeconds));
    if (q.windowSizeSeconds) parts.push("win " + fmtDuration(q.windowSizeSeconds));
    return parts.join(", ");
  }

  function historyRows(daysBack) {
    const h = loadHistory();
    const n = clamp(Number(daysBack) || DEFAULT_HISTORY_DAYS, MIN_HISTORY_DAYS, MAX_HISTORY_DAYS);
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - n + 1);
    const startMs = start.getTime();

    return Object.keys(h.days || {})
      .filter((key) => {
        const t = new Date(key + "T00:00:00").getTime();
        return Number.isFinite(t) && t >= startMs;
      })
      .sort((a, b) => b.localeCompare(a))
      .map((key) => {
        const day = h.days[key] || { date: key, used: {}, quota: {}, note: "" };
        day.date = day.date || key;
        day.used = day.used || {};
        day.quota = day.quota || {};
        day.note = String(day.note || "");
        return day;
      });
  }

  function closeGqpModal() {
    const old = document.getElementById("gqp-modal-backdrop");
    if (old) old.remove();
  }

  function createModal(titleText) {
    closeGqpModal();

    const backdrop = el("div");
    backdrop.id = "gqp-modal-backdrop";
    backdrop.className = "gqp-modal-backdrop";

    const modal = el("div");
    modal.className = "gqp-modal";

    const head = el("div");
    head.className = "gqp-modal-head";

    const title = el("div", { textContent: titleText });
    title.className = "gqp-modal-title";

    const closeBtn = el("button", { textContent: "×" });
    closeBtn.className = "gqp-modal-close-x";
    closeBtn.title = "Close";
    closeBtn.addEventListener("click", closeGqpModal);

    head.appendChild(title);
    head.appendChild(closeBtn);

    const body = el("div");
    body.className = "gqp-modal-body";

    modal.appendChild(head);
    modal.appendChild(body);
    backdrop.appendChild(modal);
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) closeGqpModal();
    });
    document.documentElement.appendChild(backdrop);

    let dragging = false;
    let startX = 0;
    let startY = 0;
    let startLeft = 0;
    let startTop = 0;

    head.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      if (e.target && e.target.closest && e.target.closest("button,input,label,select")) return;
      const r = modal.getBoundingClientRect();
      dragging = true;
      startX = e.clientX;
      startY = e.clientY;
      startLeft = r.left;
      startTop = r.top;
      backdrop.style.alignItems = "flex-start";
      backdrop.style.justifyContent = "flex-start";
      modal.style.position = "fixed";
      modal.style.left = startLeft + "px";
      modal.style.top = startTop + "px";
      e.preventDefault();
    });

    window.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      const maxLeft = Math.max(0, window.innerWidth - modal.offsetWidth - 8);
      const maxTop = Math.max(0, window.innerHeight - modal.offsetHeight - 8);
      const left = clamp(startLeft + e.clientX - startX, 8, maxLeft);
      const top = clamp(startTop + e.clientY - startY, 8, maxTop);
      modal.style.left = left + "px";
      modal.style.top = top + "px";
    });

    window.addEventListener("mouseup", () => {
      dragging = false;
    });

    return { backdrop, modal, head, body, closeBtn };
  }

  function downloadTextFile(filename, text, mime) {
    const blob = new Blob([String(text || "")], { type: mime || "application/json" });
    const url = URL.createObjectURL(blob);
    const a = el("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(url);
      a.remove();
    }, 0);
  }

  function getAccountBundle(accountId) {
    const id = sanitizeAccountId(accountId || getCurrentAccountId());
    return {
      usage: normalizeUsage(loadAccountJson(K_USAGE, null, id)),
      history: normalizeHistory(loadAccountJson(K_HISTORY, null, id)),
      defaultLimits: Object.assign({}, DEFAULT_QUOTA_LIMITS, loadAccountJson(K_DEFAULT_LIMITS, null, id) || {}),
      exactLimitOverrides: Object.assign({ image: false, imagePro: false, imageEdit: false, video: false, video720p: false }, loadAccountJson(K_EXACT_LIMIT_OVERRIDES, null, id) || {}),
      limitLocks: loadAccountJson(K_LIMIT_LOCKS, {}, id) || {},
      manualRefreshHours: (() => { const x = parseFloat(accountLsGet(K_MANUAL_REFRESH_HOURS, "", id)); return Number.isFinite(x) && x > 0 ? x : null; })(),
      lastBackupExportAt: accountLsGet(K_LAST_BACKUP_EXPORT, "", id) || null,
      lastBackupReminderAt: accountLsGet(K_LAST_BACKUP_REMINDER, "", id) || null,
    };
  }

  function applyAccountBundle(accountId, bundle, options) {
    const id = sanitizeAccountId(accountId || getCurrentAccountId());
    const merge = !!(options && options.merge);
    const data = bundle && typeof bundle === "object" ? bundle : {};

    if (data.history) {
      const nextHistory = merge ? mergeHistoryObjects(normalizeHistory(loadAccountJson(K_HISTORY, null, id)), data.history) : normalizeHistory(data.history);
      saveAccountJson(K_HISTORY, nextHistory, id);
    }
    if (data.usage) {
      const nextUsage = normalizeUsage(data.usage);
      saveAccountJson(K_USAGE, nextUsage, id);
      if (id === getCurrentAccountId()) S.usage = nextUsage;
    }
    if (data.defaultLimits && typeof data.defaultLimits === "object") {
      const limits = Object.assign({}, DEFAULT_QUOTA_LIMITS, data.defaultLimits);
      for (const service of SERVICES) limits[service.key] = Math.max(0, Number.isFinite(Number(limits[service.key])) ? Number(limits[service.key]) : Number(DEFAULT_QUOTA_LIMITS[service.key]) || 0);
      saveAccountJson(K_DEFAULT_LIMITS, limits, id);
    }
    if (data.exactLimitOverrides && typeof data.exactLimitOverrides === "object") {
      const flags = Object.assign({ image: false, imagePro: false, imageEdit: false, video: false, video720p: false }, data.exactLimitOverrides);
      saveAccountJson(K_EXACT_LIMIT_OVERRIDES, flags, id);
    }
    if (data.limitLocks && typeof data.limitLocks === "object") {
      saveAccountJson(K_LIMIT_LOCKS, data.limitLocks, id);
    }
    if (data.manualRefreshHours != null && Number.isFinite(Number(data.manualRefreshHours)) && Number(data.manualRefreshHours) > 0) {
      accountLsSet(K_MANUAL_REFRESH_HOURS, String(Number(data.manualRefreshHours)), id);
    } else if (!merge && data.manualRefreshHours == null) {
      try { localStorage.removeItem(accountStorageKey(K_MANUAL_REFRESH_HOURS, id)); } catch (_) {}
    }
    if (data.lastBackupExportAt) accountLsSet(K_LAST_BACKUP_EXPORT, String(data.lastBackupExportAt), id);
    if (data.lastBackupReminderAt) accountLsSet(K_LAST_BACKUP_REMINDER, String(data.lastBackupReminderAt), id);
  }

  function exportCurrentAccountJson() {
    const accountId = getCurrentAccountId();
    const payload = {
      schema: "grok_usage_tracker.account_export",
      version: 2,
      exportedAt: new Date().toISOString(),
      accountId,
      accountName: getAccountName(accountId) || "",
      historyDays: getHistoryDays(),
      data: getAccountBundle(accountId),
    };
    downloadTextFile("grok_usage_" + getAccountDisplayLabel(accountId).replace(/[^0-9a-zA-Z._-]/g, "_") + "_" + getLocalDayKey() + ".json", JSON.stringify(payload, null, 2), "application/json");
    accountLsSet(K_LAST_BACKUP_EXPORT, new Date().toISOString(), accountId);
  }

  function exportAllAccountsJson() {
    const accounts = {};
    for (const id of collectKnownAndCurrentAccounts()) {
      accounts[id] = {
        accountName: getAccountName(id) || "",
        data: getAccountBundle(id),
      };
    }
    const payload = {
      schema: "grok_usage_tracker.all_accounts_export",
      version: 2,
      exportedAt: new Date().toISOString(),
      activeAccountId: getCurrentAccountId(),
      knownAccounts: collectKnownAndCurrentAccounts(),
      accountNames: getAccountNames(),
      sharedSettings: {
        historyDays: getHistoryDays(),
        autoRefresh: lsGet(K_AUTO, "0"),
        intervalSeconds: getIntervalSeconds(),
        notifyEnabled: lsGet(K_NOTIFY_ENABLED, "0"),
        notifyThreshold: lsGet(K_NOTIFY_THRESHOLD, String(DEFAULT_NOTIFY_THRESHOLD)),
        notifyServices: getNotifyServices(),
        backupIntervalDays: getBackupIntervalDays(),
      },
      accounts,
    };
    downloadTextFile("grok_usage_all_accounts_" + getLocalDayKey() + ".json", JSON.stringify(payload, null, 2), "application/json");
    accountLsSet(K_LAST_BACKUP_EXPORT, new Date().toISOString(), getCurrentAccountId());
  }

  function importCurrentAccountJson(file, onDone) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result || "{}"));
        const merge = window.confirm("Import mode\n\nOK = Merge with current account\nCancel = Override current account");
        if (parsed.schema === "grok_usage_tracker.account_export") {
          applyAccountBundle(getCurrentAccountId(), parsed.data || {}, { merge });
          if (parsed.accountName && window.confirm("Apply exported account name to current account?")) {
            setAccountName(getCurrentAccountId(), parsed.accountName);
          }
        } else if (parsed.history && parsed.history.days) {
          const incomingHistory = parsed.history;
          if (merge) saveHistory(mergeHistoryObjects(loadHistory(), incomingHistory));
          else {
            if (!window.confirm("Override existing current-account quota history?")) return;
            saveHistory(normalizeHistory(incomingHistory));
          }
          if (parsed.usage && window.confirm("Also import local usage counters to current account?")) {
            S.usage = normalizeUsage(parsed.usage);
            saveUsage();
          }
        } else {
          throw new Error("Unsupported current-account import file.");
        }
        refreshAllAccountScopedUi();
        setStatus("Current account data imported.");
        if (typeof onDone === "function") onDone();
      } catch (e) {
        window.alert("Import failed: " + (e && e.message ? e.message : String(e)));
      }
    };
    reader.readAsText(file);
  }

  function importAllAccountsJson(file, onDone) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result || "{}"));
        if (parsed.schema !== "grok_usage_tracker.all_accounts_export" || !parsed.accounts || typeof parsed.accounts !== "object") {
          throw new Error("Unsupported all-accounts import file.");
        }
        const merge = window.confirm("Import mode\n\nOK = Merge all accounts\nCancel = Override imported account storage");
        const importedNames = parsed.accountNames && typeof parsed.accountNames === "object" ? parsed.accountNames : {};
        if (!merge) {
          saveKnownAccounts([]);
          saveAccountNames({});
        }
        const known = new Set(collectKnownAndCurrentAccounts());
        const names = getAccountNames();
        for (const [accountIdRaw, rec] of Object.entries(parsed.accounts || {})) {
          const accountId = sanitizeAccountId(accountIdRaw);
          if (!accountId || accountId === UNKNOWN_ACCOUNT_ID) continue;
          known.add(accountId);
          applyAccountBundle(accountId, rec && rec.data ? rec.data : {}, { merge });
          const incomingName = String((rec && rec.accountName) || importedNames[accountId] || "").trim();
          if (incomingName) names[accountId] = incomingName;
        }
        saveKnownAccounts(Array.from(known));
        saveAccountNames(Object.assign({}, names));
        if (parsed.sharedSettings && typeof parsed.sharedSettings === "object") {
          const shared = parsed.sharedSettings;
          if (shared.historyDays != null) lsSet(K_HISTORY_DAYS, String(clamp(parseInt(shared.historyDays, 10), MIN_HISTORY_DAYS, MAX_HISTORY_DAYS)));
          if (shared.autoRefresh != null) lsSet(K_AUTO, String(shared.autoRefresh) === "1" ? "1" : "0");
          if (shared.intervalSeconds != null) lsSet(K_INTERVAL, String(clamp(parseInt(shared.intervalSeconds, 10), MIN_INTERVAL_SECONDS, MAX_INTERVAL_SECONDS)));
          if (shared.notifyEnabled != null) lsSet(K_NOTIFY_ENABLED, String(shared.notifyEnabled) === "1" ? "1" : "0");
          if (shared.notifyThreshold != null) lsSet(K_NOTIFY_THRESHOLD, String(Math.max(0, parseInt(shared.notifyThreshold, 10) || 0)));
          if (shared.notifyServices) saveNotifyServices(shared.notifyServices);
          if (shared.backupIntervalDays != null) lsSet(K_BACKUP_INTERVAL_DAYS, String(clamp(parseInt(shared.backupIntervalDays, 10), 1, 3650)));
          applyAutoRefresh();
      setAccountName(getCurrentAccountId(), accountNameInput.value);
      updateAccountTitle();
        }
        refreshAllAccountScopedUi();
        setStatus("All accounts data imported.");
        if (typeof onDone === "function") onDone();
      } catch (e) {
        window.alert("Import failed: " + (e && e.message ? e.message : String(e)));
      }
    };
    reader.readAsText(file);
  }


  function mergeHistoryObjects(base, incoming) {
    const out = normalizeHistory(base);
    const inc = normalizeHistory(incoming);
    for (const dayKey of Object.keys(inc.days || {})) {
      if (!out.days[dayKey]) {
        out.days[dayKey] = inc.days[dayKey];
        continue;
      }

      const dst = ensureHistoryDay(out, dayKey);
      const srcDay = inc.days[dayKey] || {};
      const srcUsed = srcDay.used || {};
      if (srcDay.note && !dst.note) dst.note = String(srcDay.note || "");
      for (const service of SERVICES) {
        dst.used[service.key] = Math.max(Number(dst.used[service.key]) || 0, Number(srcUsed[service.key]) || 0);
        const srcQ = srcDay.quota && srcDay.quota[service.key] ? srcDay.quota[service.key] : null;
        const dstQ = dst.quota[service.key];
        if (!srcQ) continue;

        dstQ.samples = Math.max(Number(dstQ.samples) || 0, Number(srcQ.samples) || 0);
        dstQ.minRemaining = dstQ.minRemaining == null ? srcQ.minRemaining : (srcQ.minRemaining == null ? dstQ.minRemaining : Math.min(Number(dstQ.minRemaining), Number(srcQ.minRemaining)));
        dstQ.maxRemaining = dstQ.maxRemaining == null ? srcQ.maxRemaining : (srcQ.maxRemaining == null ? dstQ.maxRemaining : Math.max(Number(dstQ.maxRemaining), Number(srcQ.maxRemaining)));
        dstQ.lastRemaining = srcQ.lastRemaining != null ? srcQ.lastRemaining : dstQ.lastRemaining;
        dstQ.windowSizeSeconds = srcQ.windowSizeSeconds || dstQ.windowSizeSeconds;
        dstQ.limitHits = Math.max(Number(dstQ.limitHits) || 0, Number(srcQ.limitHits) || 0);
        dstQ.quotaReached = !!(dstQ.quotaReached || srcQ.quotaReached);
        dstQ.quotaEstimate = dstQ.quotaEstimate == null ? srcQ.quotaEstimate : (srcQ.quotaEstimate == null ? dstQ.quotaEstimate : Math.max(Number(dstQ.quotaEstimate), Number(srcQ.quotaEstimate)));
        dstQ.maxWaitSeconds = Math.max(Number(dstQ.maxWaitSeconds) || 0, Number(srcQ.maxWaitSeconds) || 0);
        dstQ.lastNextAvailableAt = srcQ.lastNextAvailableAt || dstQ.lastNextAvailableAt;
        dstQ.lastAvailable = srcQ.lastAvailable != null ? srcQ.lastAvailable : dstQ.lastAvailable;
        dstQ.lastObservedAt = srcQ.lastObservedAt || dstQ.lastObservedAt;
        dstQ.maxWindowUsed = Math.max(Number(dstQ.maxWindowUsed) || 0, Number(srcQ.maxWindowUsed) || 0);
        dstQ.effectiveLimit = Math.max(Number(dstQ.effectiveLimit) || 0, Number(srcQ.effectiveLimit) || 0);
      }
    }
    return out;
  }

  function importHistoryJson(file, onDone) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result || "{}"));
        const incomingHistory = parsed.history && parsed.history.days ? parsed.history : parsed;
        if (!incomingHistory || !incomingHistory.days) throw new Error("No history.days found.");

        const merge = window.confirm("Import mode:\\n\\nOK = Merge with existing history\\nCancel = Override existing history");
        if (merge) {
          saveHistory(mergeHistoryObjects(loadHistory(), incomingHistory));
        } else {
          if (!window.confirm("Override existing quota history?")) return;
          saveHistory(normalizeHistory(incomingHistory));
        }

        if (parsed.usage && window.confirm("Also import local usage counters from this file?")) {
          S.usage = normalizeUsage(parsed.usage);
          saveUsage();
          refreshUsageOnly();
        }

        setStatus("Quota history imported.");
        if (typeof onDone === "function") onDone();
      } catch (e) {
        window.alert("Import failed: " + (e && e.message ? e.message : String(e)));
      }
    };
    reader.readAsText(file);
  }


  function showFloatingNotice(text) {
    const old = document.getElementById("gqp-floating-notice");
    if (old) old.remove();
    const box = el("div", { textContent: text });
    box.id = "gqp-floating-notice";
    box.className = "gqp-floating-notice";
    document.documentElement.appendChild(box);
    setTimeout(() => {
      if (box && box.isConnected) box.remove();
    }, 3000);
  }

  function checkQuotaNotifications(data) {
    if (lsGet(K_NOTIFY_ENABLED, "0") !== "1") return;
    if (!data || typeof data !== "object") return;
    const threshold = Math.max(0, Number(lsGet(K_NOTIFY_THRESHOLD, String(DEFAULT_NOTIFY_THRESHOLD))) || 0);
    const enabled = getNotifyServices();
    const now = Date.now();

    for (const service of SERVICES) {
      if (!enabled[service.key]) continue;
      const q = data[service.key];
      if (!q || typeof q !== "object") continue;
      const remaining = q.remainingQueries == null ? null : Number(q.remainingQueries);
      const shouldWarn = q.available === false || (Number.isFinite(remaining) && remaining <= threshold);
      if (!shouldWarn) continue;
      const last = Number(S.lastNotifyAt[service.key] || 0);
      if (now - last < 60 * 1000) continue;
      S.lastNotifyAt[service.key] = now;
      const wait = q.nextAvailableAt ? secondsUntil(q.nextAvailableAt) : 0;
      const leftText = Number.isFinite(remaining) ? remaining + " left" : "limited";
      const waitText = wait ? " | next in " + fmtDuration(wait) : "";
      showFloatingNotice(service.title + ": " + leftText + waitText);
      break;
    }
  }

  function checkBackupReminder() {
    const intervalDays = getBackupIntervalDays();
    const lastExport = new Date(accountLsGet(K_LAST_BACKUP_EXPORT, "") || 0).getTime();
    const lastReminder = new Date(accountLsGet(K_LAST_BACKUP_REMINDER, "") || 0).getTime();
    const now = Date.now();
    const dueMs = intervalDays * 86400 * 1000;
    if (Number.isFinite(lastExport) && lastExport > 0 && now - lastExport < dueMs) return;
    if (Number.isFinite(lastReminder) && lastReminder > 0 && now - lastReminder < 86400 * 1000) return;
    accountLsSet(K_LAST_BACKUP_REMINDER, new Date().toISOString());
    setStatus("Backup reminder: export quota history JSON.", "warn");
    showFloatingNotice("Backup reminder: export quota history JSON");
  }

  function composeAutomaticNote(day) {
    if (!day) return "";
    const parts = [];

    for (const service of SERVICES) {
      const q = day.quota && day.quota[service.key] ? day.quota[service.key] : null;
      if (!q) continue;

      const bits = [];
      if (q.quotaReached) bits.push("hit");
      if (q.quotaEstimate != null || q.effectiveLimit != null) bits.push("limit " + getRecentLimitForDay(day, service.key));
      if (q.lastNextAvailableAt) bits.push("renew " + formatRenewAt(q.lastNextAvailableAt));
      else if (q.maxWaitSeconds) bits.push("wait " + fmtDuration(q.maxWaitSeconds));
      if (q.windowSizeSeconds) bits.push("win " + fmtDuration(q.windowSizeSeconds));

      if (bits.length && (q.quotaReached || q.lastNextAvailableAt || q.maxWaitSeconds)) {
        parts.push(service.title + ": " + bits.join(", "));
      }
    }

    return parts.join("\\n");
  }

  function composeHistoryNoteCell(day) {
    const userNote = String(day && day.note || "").trim();
    const autoNote = composeAutomaticNote(day);
    if (userNote && autoNote) return userNote + " | Automatic Note: " + autoNote.replace(/\\n/g, " | ");
    if (userNote) return userNote;
    if (autoNote) return "Automatic Note: " + autoNote.replace(/\\n/g, " | ");
    return "-";
  }

  function editDayNote(dayKey, onDone) {
    const h = loadHistory();
    const d = ensureHistoryDay(h, dayKey);
    const autoNote = composeAutomaticNote(d);

    const m = createModal("Day Note - " + dayKey);
    m.modal.classList.add("gqp-note-modal");
    const body = m.body;

    const label = el("div", { textContent: "User note:" });
    label.className = "gqp-row-title";
    label.style.marginBottom = "5px";

    const textarea = el("textarea");
    textarea.className = "gqp-note-textarea";
    textarea.value = String(d.note || "");
    textarea.placeholder = "Write a note for this day...";

    const autoBox = el("div");
    autoBox.className = "gqp-auto-note-box";
    autoBox.textContent = "Automatic Note:\\n" + (autoNote || "-");

    const buttons = el("div");
    buttons.className = "gqp-modal-actions";

    const saveBtn = el("button", { textContent: "Save Note" });
    saveBtn.className = "gqp-save-btn";
    saveBtn.addEventListener("click", () => {
      d.note = String(textarea.value || "").trim();
      saveHistory(h);
      closeGqpModal();
      if (typeof onDone === "function") onDone();
      setStatus("Day note saved.");
    });

    const clearBtn = el("button", { textContent: "Clear" });
    clearBtn.className = "gqp-danger-btn";
    clearBtn.addEventListener("click", () => {
      textarea.value = "";
    });

    const closeBtn = el("button", { textContent: "Close" });
    closeBtn.addEventListener("click", closeGqpModal);

    buttons.appendChild(closeBtn);
    buttons.appendChild(clearBtn);
    buttons.appendChild(saveBtn);

    body.appendChild(label);
    body.appendChild(textarea);
    body.appendChild(autoBox);
    body.appendChild(buttons);

    setTimeout(() => textarea.focus(), 0);
  }

  function editTodayNote() {
    editDayNote(getLocalDayKey(), () => refreshUsageOnly());
  }

  function openSettingsWindow() {
    refreshDetectedAccountFromPage();
    const m = createModal("Usage Settings - " + getAccountDisplayLabel());
    const body = m.body;

    const accountInfo = el("div");
    accountInfo.className = "gqp-muted";
    accountInfo.style.marginBottom = "8px";
    accountInfo.textContent = "Current account: " + getAccountFullLabel();

    const accountNameRow = el("div");
    accountNameRow.className = "gqp-modal-row";
    const accountNameLabel = el("label");
    accountNameLabel.appendChild(el("span", { textContent: "Account name" }));
    const accountNameInput = el("input");
    accountNameInput.type = "text";
    accountNameInput.placeholder = "Optional display name";
    accountNameInput.value = getAccountName(getCurrentAccountId());
    accountNameInput.style.minWidth = "220px";
    accountNameLabel.appendChild(accountNameInput);
    accountNameRow.appendChild(accountNameLabel);

    const row = el("div");
    row.className = "gqp-modal-row";

    const daysLabel = el("label");
    daysLabel.appendChild(el("span", { textContent: "History days" }));
    const daysInput = el("input");
    daysInput.type = "number";
    daysInput.min = String(MIN_HISTORY_DAYS);
    daysInput.max = String(MAX_HISTORY_DAYS);
    daysInput.step = "1";
    daysInput.value = String(getHistoryDays());
    daysLabel.appendChild(daysInput);

    const notifyLabel = el("label");
    const notifyCheck = el("input");
    notifyCheck.type = "checkbox";
    notifyCheck.checked = lsGet(K_NOTIFY_ENABLED, "0") === "1";
    notifyLabel.appendChild(notifyCheck);
    notifyLabel.appendChild(el("span", { textContent: "Low quota popup" }));

    const thresholdLabel = el("label");
    thresholdLabel.appendChild(el("span", { textContent: "when left <=" }));
    const thresholdInput = el("input");
    thresholdInput.type = "number";
    thresholdInput.min = "0";
    thresholdInput.max = "9999";
    thresholdInput.step = "1";
    thresholdInput.value = lsGet(K_NOTIFY_THRESHOLD, String(DEFAULT_NOTIFY_THRESHOLD));
    thresholdLabel.appendChild(thresholdInput);

    const backupLabel = el("label");
    backupLabel.appendChild(el("span", { textContent: "Backup reminder days" }));
    const backupInput = el("input");
    backupInput.type = "number";
    backupInput.min = "1";
    backupInput.max = "3650";
    backupInput.step = "1";
    backupInput.value = String(getBackupIntervalDays());
    backupLabel.appendChild(backupInput);

    row.appendChild(daysLabel);
    row.appendChild(notifyLabel);
    row.appendChild(thresholdLabel);
    row.appendChild(backupLabel);

    const autoLabel = el("label");
    const autoCheckSettings = el("input");
    autoCheckSettings.type = "checkbox";
    autoCheckSettings.checked = lsGet(K_AUTO, "0") === "1";
    autoLabel.appendChild(autoCheckSettings);
    autoLabel.appendChild(el("span", { textContent: "Auto refresh" }));

    const autoEveryLabel = el("label");
    autoEveryLabel.appendChild(el("span", { textContent: "every" }));
    const autoEveryInput = el("input");
    autoEveryInput.type = "number";
    autoEveryInput.min = String(MIN_INTERVAL_SECONDS);
    autoEveryInput.max = String(MAX_INTERVAL_SECONDS);
    autoEveryInput.step = "30";
    autoEveryInput.value = String(getIntervalSeconds());
    autoEveryLabel.appendChild(autoEveryInput);
    autoEveryLabel.appendChild(el("span", { textContent: "sec" }));

    row.appendChild(autoLabel);
    row.appendChild(autoEveryLabel);

    const servicesRow = el("div");
    servicesRow.className = "gqp-modal-row";
    servicesRow.appendChild(el("span", { textContent: "Notify types:" }));
    const notifyServices = getNotifyServices();
    const serviceChecks = {};
    for (const service of SERVICES) {
      const lab = el("label");
      const cb = el("input");
      cb.type = "checkbox";
      cb.checked = !!notifyServices[service.key];
      serviceChecks[service.key] = cb;
      lab.appendChild(cb);
      lab.appendChild(el("span", { textContent: service.title }));
      servicesRow.appendChild(lab);
    }

    const limitsRow = el("div");
    limitsRow.className = "gqp-modal-row gqp-limits-row";
    limitsRow.appendChild(el("span", { textContent: "Default limits:" }));
    const defaultLimits = getDefaultLimits();
    const limitInputs = {};
    for (const service of SERVICES) {
      const lab = el("label");
      lab.appendChild(el("span", { textContent: service.title }));
      const inp = el("input");
      inp.type = "number";
      inp.min = "0";
      inp.max = "999999";
      inp.step = "1";
      inp.value = String(defaultLimits[service.key]);
      limitInputs[service.key] = inp;
      lab.appendChild(inp);
      limitsRow.appendChild(lab);
    }

    const info = el("div");
    info.className = "gqp-muted";
    info.textContent = "Default limits are per account and apply immediately after saving. Use 0 for tiers/types with no quota. Low quota popup appears in the upper-left for 3 seconds.";

    const dangerToggleRow = el("div");
    dangerToggleRow.className = "gqp-modal-row";
    const dangerToggleBtn = el("button", { textContent: "Show danger zone" });
    dangerToggleBtn.className = "gqp-danger-toggle";
    dangerToggleRow.appendChild(dangerToggleBtn);

    const dangerRow = el("div");
    dangerRow.className = "gqp-modal-row gqp-danger-zone";
    dangerRow.appendChild(el("span", { textContent: "Danger zone:" }));

    function confirmDangerReset(label) {
      if (!window.confirm(label + "? This cannot be undone.")) return false;
      const typed = window.prompt("Type RESET to confirm:", "");
      return String(typed || "").trim() === "RESET";
    }

    const resetTodayBtn = el("button", { textContent: "Reset Today" });
    resetTodayBtn.addEventListener("click", () => {
      if (confirmDangerReset("Reset today's local usage counters")) resetTodayUsage();
    });

    const resetAllBtn = el("button", { textContent: "Reset All" });
    resetAllBtn.addEventListener("click", () => {
      if (confirmDangerReset("Reset ALL local usage counters")) resetAllUsage();
    });

    dangerRow.appendChild(resetTodayBtn);
    dangerRow.appendChild(resetAllBtn);

    dangerToggleBtn.addEventListener("click", () => {
      const open = !dangerRow.classList.contains("open");
      dangerRow.classList.toggle("open", open);
      dangerToggleBtn.textContent = open ? "Hide danger zone" : "Show danger zone";
    });

    const actions = el("div");
    actions.className = "gqp-modal-actions";
    const closeBtn = el("button", { textContent: "Close" });
    closeBtn.className = "gqp-close-btn";
    closeBtn.addEventListener("click", closeGqpModal);

    const saveBtn = el("button", { textContent: "Save Settings" });
    saveBtn.className = "gqp-save-btn";
    saveBtn.addEventListener("click", () => {
      const n = clamp(parseInt(daysInput.value, 10), MIN_HISTORY_DAYS, MAX_HISTORY_DAYS);
      lsSet(K_HISTORY_DAYS, String(n));
      lsSet(K_NOTIFY_ENABLED, notifyCheck.checked ? "1" : "0");
      lsSet(K_NOTIFY_THRESHOLD, String(Math.max(0, parseInt(thresholdInput.value, 10) || 0)));
      lsSet(K_BACKUP_INTERVAL_DAYS, String(clamp(parseInt(backupInput.value, 10), 1, 3650)));
      lsSet(K_AUTO, autoCheckSettings.checked ? "1" : "0");
      lsSet(K_INTERVAL, String(clamp(parseInt(autoEveryInput.value, 10), MIN_INTERVAL_SECONDS, MAX_INTERVAL_SECONDS)));
      applyAutoRefresh();

      setAccountName(getCurrentAccountId(), accountNameInput.value);
      updateAccountTitle();

      const ns = {};
      for (const service of SERVICES) ns[service.key] = !!serviceChecks[service.key].checked;
      saveNotifyServices(ns);

      const limits = {};
      for (const service of SERVICES) {
        const rawLimit = Number(limitInputs[service.key].value);
        limits[service.key] = Math.max(0, Number.isFinite(rawLimit) ? Math.round(rawLimit) : 0);
      }
      saveDefaultLimits(limits);

      // Limits edited in Settings are intentional user overrides, so apply them
      // exactly in the main view instead of letting older learned quota values win.
      for (const service of SERVICES) setExactLimitOverride(service.key, true);

      refreshUsageOnly();
      setStatus("Usage settings saved for " + getAccountDisplayLabel() + ".");
      closeGqpModal();
    });

    actions.appendChild(closeBtn);
    actions.appendChild(saveBtn);

    body.appendChild(accountInfo);
    body.appendChild(accountNameRow);
    body.appendChild(row);
    body.appendChild(servicesRow);
    body.appendChild(limitsRow);
    body.appendChild(info);
    body.appendChild(dangerToggleRow);
    body.appendChild(dangerRow);
    body.appendChild(actions);
  }

  function openHistoryWindow() {
    const m = createModal("Usage and Quota History - " + getAccountDisplayLabel());
    const body = m.body;

    const top = el("div");
    top.className = "gqp-modal-row";

    const daysLabel = el("label");
    daysLabel.appendChild(el("span", { textContent: "Days" }));
    const daysInput = el("input");
    daysInput.type = "number";
    daysInput.min = String(MIN_HISTORY_DAYS);
    daysInput.max = String(MAX_HISTORY_DAYS);
    daysInput.step = "1";
    daysInput.value = String(getHistoryDays());
    daysLabel.appendChild(daysInput);

    const refreshBtn = el("button", { textContent: "Refresh Table" });
    const exportCurrentBtn = el("button", { textContent: "Export Current" });
    const importCurrentBtn = el("button", { textContent: "Import Current" });
    const exportAllBtn = el("button", { textContent: "Export All" });
    const importAllBtn = el("button", { textContent: "Import All" });
    const fileInput = el("input");
    fileInput.type = "file";
    fileInput.accept = "application/json,.json";
    fileInput.style.display = "none";
    let importMode = "current";

    top.appendChild(daysLabel);
    top.appendChild(refreshBtn);
    top.appendChild(exportCurrentBtn);
    top.appendChild(importCurrentBtn);
    top.appendChild(exportAllBtn);
    top.appendChild(importAllBtn);
    top.appendChild(fileInput);

    const activeOnlyLabel = el("label");
    const activeOnly = el("input");
    activeOnly.type = "checkbox";
    activeOnlyLabel.appendChild(activeOnly);
    activeOnlyLabel.appendChild(el("span", { textContent: "active only" }));

    const hitsOnlyLabel = el("label");
    const hitsOnly = el("input");
    hitsOnly.type = "checkbox";
    hitsOnlyLabel.appendChild(hitsOnly);
    hitsOnlyLabel.appendChild(el("span", { textContent: "limit hits only" }));

    top.appendChild(activeOnlyLabel);
    top.appendChild(hitsOnlyLabel);

    const accountInfo = el("div");
    accountInfo.className = "gqp-muted";
    accountInfo.style.marginBottom = "6px";
    accountInfo.textContent = "Current account: " + getAccountFullLabel();

    const info = el("div");
    info.className = "gqp-muted";
    info.style.marginBottom = "8px";
    info.textContent = "Usage cells show generated/limit; red text means the limit was reached. The final note/details cell is clickable and starts with the user note, then automatic refresh/limit details.";

    const tableWrap = el("div");
    tableWrap.style.maxHeight = "560px";
    tableWrap.style.overflow = "auto";

    function render() {
      const n = clamp(parseInt(daysInput.value, 10), MIN_HISTORY_DAYS, MAX_HISTORY_DAYS);
      lsSet(K_HISTORY_DAYS, String(n));
      tableWrap.textContent = "";

      const table = el("table");
      table.className = "gqp-history-table";

      const thead = el("thead");
      const hr = el("tr");
      ["Date", "Speed Image", "Quality Image", "Edit Image", "480p Video", "720p Video", "Note / automatic details"].forEach((name) => {
        hr.appendChild(el("th", { textContent: name }));
      });
      thead.appendChild(hr);
      table.appendChild(thead);

      const tbody = el("tbody");
      const totals = { image: 0, imagePro: 0, imageEdit: 0, video: 0, video720p: 0 };
      let shownRows = 0;
      for (const day of historyRows(n)) {
        const usedTotal = sumUsed(day, ["image", "imagePro", "imageEdit", "video", "video720p"]);
        const hit = SERVICES.some((service) => day.quota && day.quota[service.key] && day.quota[service.key].quotaReached);
        if (activeOnly.checked && usedTotal <= 0 && !hit && !day.note) continue;
        if (hitsOnly.checked && !hit) continue;

        const tr = el("tr");
        const dateCell = el("td", { textContent: day.date });
        tr.appendChild(dateCell);

        const usedCells = ["image", "imagePro", "imageEdit", "video", "video720p"];
        for (const key of usedCells) {
          const value = Number(day.used && day.used[key]) || 0;
          totals[key] += value;
          const td = el("td", { textContent: String(value) + "/" + getRecentLimitForDay(day, key) });
          const q = day.quota && day.quota[key] ? day.quota[key] : null;
          if (q && q.quotaReached) td.className = "gqp-limit-hit";
          tr.appendChild(td);
        }

        const notes = composeHistoryNoteCell(day);
        const noteDisplay = "📝 " + notes;
        const notesTd = el("td", { textContent: noteDisplay });
        notesTd.title = notes === "-" ? "Click to add note" : notes;
        notesTd.classList.add("gqp-note-details-cell");
        notesTd.addEventListener("click", () => editDayNote(day.date, render));
        if (notes.includes("hit")) notesTd.classList.add("gqp-limit-hit");
        tr.appendChild(notesTd);
        tbody.appendChild(tr);
        shownRows += 1;
      }
      table.appendChild(tbody);

      const tfoot = el("tfoot");
      const totalRow = el("tr");
      ["Totals", String(totals.image), String(totals.imagePro), String(totals.imageEdit), String(totals.video), String(totals.video720p), ""].forEach((value) => {
        totalRow.appendChild(el("td", { textContent: value }));
      });
      tfoot.appendChild(totalRow);
      table.appendChild(tfoot);

      if (!shownRows) {
        const empty = el("div", { textContent: "No matching history rows." });
        empty.className = "gqp-muted";
        tableWrap.appendChild(empty);
      } else {
        tableWrap.appendChild(table);
      }
    }

    refreshBtn.addEventListener("click", render);
    activeOnly.addEventListener("change", render);
    hitsOnly.addEventListener("change", render);
    exportCurrentBtn.addEventListener("click", exportCurrentAccountJson);
    exportAllBtn.addEventListener("click", exportAllAccountsJson);
    importCurrentBtn.addEventListener("click", () => {
      importMode = "current";
      fileInput.click();
    });
    importAllBtn.addEventListener("click", () => {
      importMode = "all";
      fileInput.click();
    });
    fileInput.addEventListener("change", () => {
      const file = fileInput.files && fileInput.files[0];
      if (importMode === "all") importAllAccountsJson(file, render);
      else importCurrentAccountJson(file, render);
      fileInput.value = "";
      importMode = "current";
    });

    body.appendChild(top);
    body.appendChild(accountInfo);
    body.appendChild(info);
    body.appendChild(tableWrap);
    render();
  }


  function badgeClassForService(serviceKey, data) {
    if (getActiveLimitLock(serviceKey)) return "danger";
    const q = data && data[serviceKey] ? data[serviceKey] : null;
    const threshold = Math.max(0, Number(lsGet(K_NOTIFY_THRESHOLD, String(DEFAULT_NOTIFY_THRESHOLD))) || 0);
    if (q && q.available === false) return "danger";
    const remaining = q && q.remainingQueries != null ? Number(q.remainingQueries) : null;
    if (Number.isFinite(remaining) && remaining <= 0) return "danger";
    if (Number.isFinite(remaining) && remaining <= threshold) return "warn";
    const used = getDisplayWindowCount(serviceKey);
    const limit = getEffectiveLimitForService(serviceKey);
    if (limit <= 0) return "danger";
    if (used >= limit) return "danger";
    if (used >= Math.max(1, Math.floor(limit * 0.8))) return "warn";
    return "safe";
  }

  function renderQuotaBadges() {
    const box = document.getElementById("gqp-quota-badges");
    if (!box) return;
    box.textContent = "";
    const data = S.lastData || null;
    for (const service of SERVICES) {
      const q = data && data[service.key] ? data[service.key] : null;
      const used = getDisplayWindowCount(service.key);
      const limit = getEffectiveLimitForService(service.key);
      const lock = getActiveLimitLock(service.key);
      const remaining = q && q.remainingQueries != null ? String(q.remainingQueries) : (lock ? "0" : "-");
      const badge = el("div");
      badge.className = "gqp-qbadge " + badgeClassForService(service.key, data);
      const title = el("div", { textContent: serviceShort(service.key) });
      title.className = "gqp-qb-title";
      const main = el("div", { textContent: used + "/" + limit + (lock ? " | " + getRefreshLabel(service.key, getWindowSeconds(service.key)) : " | L" + remaining) });
      main.className = "gqp-qb-main";
      badge.title = service.title + " | window used/effective limit: " + used + "/" + limit + (lock ? " | estimated renewal: " + formatLocalTime(lock.renewAt) : " | site left: " + remaining);
      badge.appendChild(title);
      badge.appendChild(main);
      box.appendChild(badge);
    }
  }

  function localDateTimeInputValue(dateValue) {
    const d = dateValue ? new Date(dateValue) : new Date();
    if (Number.isNaN(d.getTime())) return "";
    return d.getFullYear() + "-" +
      String(d.getMonth() + 1).padStart(2, "0") + "-" +
      String(d.getDate()).padStart(2, "0") + "T" +
      String(d.getHours()).padStart(2, "0") + ":" +
      String(d.getMinutes()).padStart(2, "0");
  }

  function setRefreshAfterHours(serviceKey, hours, reason) {
    const n = Number(hours);
    if (!Number.isFinite(n) || n <= 0) {
      window.alert("Invalid number of hours.");
      return false;
    }
    setLimitLock(serviceKey, new Date(Date.now() + n * 3600 * 1000).toISOString(), reason || ("manual " + n + "h refresh lock"), { skipHistory: true });
    return true;
  }

  function showRefreshContextMenu(serviceKey) {
    const service = SERVICES.find((x) => x.key === serviceKey);
    const serviceName = service ? service.title : serviceKey;
    const defaultHours = (getDefaultRefreshSeconds(serviceKey) / 3600).toFixed(1).replace(/\.0$/, "");
    const activeLock = getActiveLimitLock(serviceKey);

    const m = createModal("Refresh Control - " + serviceName);
    m.modal.classList.add("gqp-refresh-modal");
    const body = m.body;

    const help = el("div");
    help.className = "gqp-refresh-help";
    help.textContent = "Correct the estimated refresh time for this usage type. Current: " + (activeLock ? formatRenewAt(activeLock.renewAt) : "not limited");
    body.appendChild(help);

    const actions = el("div");
    actions.className = "gqp-refresh-actions";

    function closeAndRun(fn) {
      return () => {
        const ok = fn();
        if (ok !== false) closeGqpModal();
      };
    }

    function addButtonRow(titleText, buttonText, className, fn) {
      const row = el("div");
      row.className = "gqp-refresh-action-row";

      const title = el("div", { textContent: titleText });
      title.className = "gqp-row-title";

      const btn = el("button", { textContent: buttonText });
      if (className) btn.className = className;
      btn.addEventListener("click", closeAndRun(fn));

      row.appendChild(title);
      row.appendChild(btn);
      actions.appendChild(row);
    }

    function addMultiButtonRow(titleText, buttons) {
      const row = el("div");
      row.className = "gqp-refresh-action-row";

      const title = el("div", { textContent: titleText });
      title.className = "gqp-row-title";

      const btnWrap = el("div");
      btnWrap.className = "gqp-refresh-inline-buttons";

      buttons.forEach((item) => {
        const btn = el("button", { textContent: item.text });
        if (item.className) btn.className = item.className;
        btn.addEventListener("click", closeAndRun(item.fn));
        btnWrap.appendChild(btn);
      });

      row.appendChild(title);
      row.appendChild(btnWrap);
      actions.appendChild(row);
    }

    function addInputRow(titleText, inputType, inputValue, buttonText, className, fn) {
      const row = el("div");
      row.className = "gqp-refresh-action-row";

      const title = el("div", { textContent: titleText });
      title.className = "gqp-row-title";

      const right = el("div");
      right.style.display = "flex";
      right.style.gap = "6px";
      right.style.alignItems = "center";

      const input = el("input");
      input.type = inputType;
      input.value = inputValue || "";
      if (inputType === "number") {
        input.min = "0.1";
        input.step = "0.5";
      }

      const btn = el("button", { textContent: buttonText });
      if (className) btn.className = className;
      btn.addEventListener("click", closeAndRun(() => fn(input.value)));

      right.appendChild(input);
      right.appendChild(btn);

      row.appendChild(title);
      row.appendChild(right);
      actions.appendChild(row);
    }

    addButtonRow(
      "Clear refresh lock",
      "Clear",
      "danger",
      () => {
        clearLimitLock(serviceKey, serviceName + " refresh lock cleared");
        return true;
      }
    );

    addButtonRow(
      "Set default refresh",
      "Set in " + defaultHours + "h",
      "primary",
      () => setRefreshAfterHours(serviceKey, getDefaultRefreshSeconds(serviceKey) / 3600, "manual default refresh lock")
    );

    addMultiButtonRow("Set refresh in", [
      { text: "4h", fn: () => setRefreshAfterHours(serviceKey, 4, "manual 4h refresh lock") },
      { text: "8h", fn: () => setRefreshAfterHours(serviceKey, 8, "manual 8h refresh lock") },
      { text: "12h", fn: () => setRefreshAfterHours(serviceKey, 12, "manual 12h refresh lock") },
    ]);

    addInputRow(
      "Specific time",
      "datetime-local",
      localDateTimeInputValue(activeLock ? activeLock.renewAt : new Date(Date.now() + getDefaultRefreshSeconds(serviceKey) * 1000)),
      "Set",
      "primary",
      (value) => {
        const t = new Date(value).getTime();
        if (!Number.isFinite(t)) {
          window.alert("Invalid date/time.");
          return false;
        }
        setLimitLock(serviceKey, new Date(t).toISOString(), "manual specific refresh time", { skipHistory: true });
        return true;
      }
    );

    addInputRow(
      "Default hours for all",
      "number",
      String(getManualRefreshHours() || defaultHours),
      "Save",
      "warn",
      (value) => {
        const hours = parseFloat(String(value).trim());
        if (!Number.isFinite(hours) || hours <= 0) {
          window.alert("Invalid hours.");
          return false;
        }
        accountLsSet(K_MANUAL_REFRESH_HOURS, String(hours));
        setStatus("Default refresh hours for all services set to " + hours + "h.");
        refreshUsageOnly();
        return true;
      }
    );

    body.appendChild(actions);
  }

  function showLimitControlMenu(serviceKey) {
    const serviceName = serviceTitle(serviceKey);
    const currentLimit = getDefaultLimits()[serviceKey] || builtinDefaultLimitForService(serviceKey);
    const builtinLimit = builtinDefaultLimitForService(serviceKey);

    const m = createModal("Limit Control - " + serviceName);
    m.modal.classList.add("gqp-limit-modal");
    const body = m.body;

    const info = el("div");
    info.className = "gqp-refresh-help";
    info.textContent = "Change the displayed quota limit for " + serviceName + ". Current limit: " + currentLimit + ".";
    body.appendChild(info);

    const actions = el("div");
    actions.className = "gqp-limit-actions";

    function closeAndRun(fn) {
      return () => {
        const ok = fn();
        if (ok !== false) closeGqpModal();
      };
    }

    const rowDefault = el("div");
    rowDefault.className = "gqp-limit-action-row";
    rowDefault.appendChild(el("div", { textContent: "Use built-in limit" }));
    const defaultBtn = el("button", { textContent: "Set " + builtinLimit });
    defaultBtn.className = "primary";
    defaultBtn.addEventListener("click", closeAndRun(() => setDefaultLimitForService(serviceKey, builtinLimit)));
    rowDefault.appendChild(defaultBtn);
    actions.appendChild(rowDefault);

    const rowCustom = el("div");
    rowCustom.className = "gqp-limit-action-row";
    rowCustom.appendChild(el("div", { textContent: "Set custom limit" }));

    const right = el("div");
    right.style.display = "flex";
    right.style.gap = "6px";
    right.style.alignItems = "center";

    const input = el("input");
    input.type = "number";
    input.min = "0";
    input.step = "1";
    input.value = String(currentLimit);

    const setBtn = el("button", { textContent: "Set" });
    setBtn.className = "primary";
    setBtn.addEventListener("click", closeAndRun(() => {
      const n = Math.round(Number(input.value));
      if (!Number.isFinite(n) || n < 0) {
        window.alert("Invalid limit.");
        return false;
      }
      return setDefaultLimitForService(serviceKey, n);
    }));

    right.appendChild(input);
    right.appendChild(setBtn);
    rowCustom.appendChild(right);
    actions.appendChild(rowCustom);

    body.appendChild(actions);
    setTimeout(() => input.focus(), 0);
  }

  function makeCard(service, data) {
    const cls = badgeClassForService(service.key, S.lastData || null);
    const used = localUsageLabel(service.key);
    const windowSeconds = data && data.windowSizeSeconds ? Number(data.windowSizeSeconds) : getWindowSeconds(service.key);
    const refreshLabel = getRefreshLabel(service.key, windowSeconds);
    const lock = getActiveLimitLock(service.key);

    const card = el("div");
    card.className = "gqp-card " + cls;

    const title = el("div", { textContent: service.title });
    title.className = "gqp-service-title";

    const stats = el("div");
    stats.className = "gqp-stats";

    const limitStat = addStat(stats, "Used/Limit", used, cls);
    if (limitStat && limitStat.box) {
      const limitHelp = "Click to edit default limit.";
      limitStat.box.title = limitHelp;
      limitStat.value.title = limitHelp;
      limitStat.label.title = limitHelp;
      limitStat.box.style.cursor = "pointer";
      limitStat.value.style.cursor = "pointer";
      limitStat.box.addEventListener("click", (e) => {
        e.preventDefault();
        showLimitControlMenu(service.key);
      });
      limitStat.box.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        showLimitControlMenu(service.key);
      });
    }
    const refreshStat = addStat(stats, "Refresh", refreshLabel, lock ? "danger" : "");
    if (refreshStat && refreshStat.box) {
      const refreshHelp = "Click to edit refresh time.";
      refreshStat.box.title = refreshHelp;
      refreshStat.value.title = refreshHelp;
      refreshStat.label.title = refreshHelp;
      refreshStat.box.style.cursor = "pointer";
      refreshStat.value.style.cursor = "pointer";
      refreshStat.box.addEventListener("click", (e) => {
        e.preventDefault();
        showRefreshContextMenu(service.key);
      });
      refreshStat.box.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        showRefreshContextMenu(service.key);
      });
    }

    card.appendChild(title);
    card.appendChild(stats);
    card.title = service.title + " | current window used/effective limit: " + used + " | refresh: " + refreshLabel + " | click refresh time to edit" + (lock ? " | estimated renewal: " + formatLocalTime(lock.renewAt) : "");
    return card;
  }

  function addStat(parent, label, value, extraClass) {
    const box = el("div");
    box.className = "gqp-stat";

    const lab = el("div", { textContent: label });
    lab.className = "gqp-label";

    const val = el("div", { textContent: value });
    val.className = "gqp-value" + (extraClass ? " " + extraClass : "");
    val.title = label + ": " + value;

    box.appendChild(lab);
    box.appendChild(val);
    parent.appendChild(box);
    return { box, label: lab, value: val };
  }

  function renderCards(grid, data) {
    grid.textContent = "";

    let added = 0;
    for (const service of SERVICES) {
      const serviceData = data && data[service.key] ? data[service.key] : null;
      grid.appendChild(makeCard(service, serviceData));
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

    const panel = document.getElementById("grok-quota-panel");
    if (panel && panel.classList.contains("gqp-compact")) {
      status.textContent = "";
      status.appendChild(div);
      return;
    }

    status.prepend(div);
  }

  function applyQuotaInfoLimitLocks(data, sourceLabel) {
    if (!data || typeof data !== "object") return;

    for (const service of SERVICES) {
      const q = data[service.key];
      if (!quotaInfoSaysLimited(q)) continue;

      // If the site gives an exact nextAvailableAt, use it as source of truth.
      // Fall back to existing/default estimate only when it is missing.
      recordLimitReachedForService(service.key, sourceLabel || "quota_info remainingQueries 0", {
        nextAvailableAt: validFutureIso(q.nextAvailableAt) || null,
      });
    }
  }

  async function fetchQuotaInfoAfterLimit(serviceKey) {
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
      if (!response.ok) throw new Error("HTTP " + response.status);
      const data = await response.json();

      S.lastData = data;
      updateWindowSizesFromQuota(data);
      recordQuotaHistory(data);
      applyQuotaInfoLimitLocks(data, "quota_info after limit");
      checkQuotaNotifications(data);

      const grid = document.getElementById("gqp-grid");
      if (grid) renderCards(grid, data);

      const q = data && data[serviceKey] ? data[serviceKey] : null;
      if (q && q.nextAvailableAt) {
        setStatus(serviceTitle(serviceKey) + " renewal from quota_info: " + formatRenewAt(q.nextAvailableAt) + ".", "warn");
      }
    } catch (e) {
      console.warn("[GrokUsage] quota_info after limit failed:", e);
      setStatus("Could not fetch quota_info after limit; using estimated refresh.", "warn");
    }
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
      updateWindowSizesFromQuota(data);
      recordQuotaHistory(data);
      applyQuotaInfoLimitLocks(data, "quota_info");
      checkQuotaNotifications(data);

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

  function keepPanelOnScreen(panel) {
    if (!panel) return;
    const r = panel.getBoundingClientRect();
    const margin = 8;
    let left = r.left;
    let top = r.top;

    if (r.right > window.innerWidth - margin) left = window.innerWidth - r.width - margin;
    if (r.bottom > window.innerHeight - margin) top = window.innerHeight - r.height - margin;
    if (left < margin) left = margin;
    if (top < margin) top = margin;

    panel.style.left = Math.round(left) + "px";
    panel.style.top = Math.round(top) + "px";
    panel.style.right = "auto";
    saveJson(K_POS, { x: Math.round(left), y: Math.round(top) });
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
    if (S.compact) panel.classList.add("gqp-compact");

    const header = el("div");
    header.className = "gqp-header";

    const title = el("div", { textContent: "Grok Usage - " + getAccountDisplayLabel() });
    title.id = "gqp-main-title";
    title.className = "gqp-title";
    title.title = "Current account: " + getAccountFullLabel();

    const settingsBtn = el("button", { textContent: "⚙️" });
    settingsBtn.className = "gqp-btn gqp-icon-btn";
    settingsBtn.title = "Usage settings";

    const historyBtn = el("button", { textContent: "📊" });
    historyBtn.className = "gqp-btn gqp-icon-btn";
    historyBtn.title = "Usage and quota history";

    const noteBtn = el("button", { textContent: "📝" });
    noteBtn.className = "gqp-btn gqp-icon-btn";
    noteBtn.title = "Add/edit note for today";

    const refreshBtn = el("button", { textContent: "🔄" });
    refreshBtn.id = "gqp-refresh";
    refreshBtn.className = "gqp-btn gqp-icon-btn";
    refreshBtn.title = "Refresh";

    const compactBtn = el("button", { textContent: S.compact ? "🔎" : "📏" });
    compactBtn.id = "gqp-compact-toggle";
    compactBtn.className = "gqp-btn gqp-icon-btn";
    compactBtn.title = S.compact ? "Normal view" : "Compact view";

    const foldBtn = el("button", { textContent: S.folded ? "📂" : "➖" });
    foldBtn.id = "gqp-fold";
    foldBtn.className = "gqp-btn gqp-icon-btn";
    foldBtn.title = S.folded ? "Open" : "Minimize";

    header.appendChild(title);
    header.appendChild(settingsBtn);
    header.appendChild(historyBtn);
    header.appendChild(noteBtn);
    header.appendChild(refreshBtn);
    header.appendChild(compactBtn);
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
    note.className = "gqp-warn gqp-note";

    controls.appendChild(autoLabel);
    controls.appendChild(intervalLabel);
    controls.appendChild(note);

    const counterRow = el("div");
    counterRow.className = "gqp-counter-row";

    const counterSummary = el("span", { textContent: getUsageSummary() });
    counterSummary.id = "gqp-counter-summary";
    counterSummary.className = "gqp-counter-note";

    counterRow.appendChild(counterSummary);

    const legend = el("div");
    legend.className = "gqp-legend";
    ["Type", "Used/Limit", "Refresh"].forEach((x) => legend.appendChild(el("span", { textContent: x })));

    const grid = el("div");
    grid.id = "gqp-grid";
    grid.className = "gqp-grid";

    renderCards(grid, S.lastData);

    const status = el("div", { textContent: "" });
    status.id = "gqp-status";
    status.className = "gqp-status";

    content.appendChild(controls);
    content.appendChild(counterRow);
    content.appendChild(legend);
    content.appendChild(grid);
    content.appendChild(status);

    panel.appendChild(header);
    panel.appendChild(content);
    document.documentElement.appendChild(panel);
    updateAccountTitle();

    applySavedPos(panel);
    enableDrag(panel, header);
    requestAnimationFrame(() => keepPanelOnScreen(panel));
    window.addEventListener("resize", () => keepPanelOnScreen(panel));

    settingsBtn.addEventListener("click", openSettingsWindow);
    historyBtn.addEventListener("click", openHistoryWindow);
    noteBtn.addEventListener("click", editTodayNote);

    refreshBtn.addEventListener("click", () => {
      // If the panel is minimized, Refresh should also open it so the result is visible.
      if (S.folded) {
        S.folded = false;
        panel.classList.remove("gqp-folded");
        foldBtn.textContent = "➖";
        foldBtn.title = "Minimize";
        lsSet(K_FOLDED, "0");
        requestAnimationFrame(() => keepPanelOnScreen(panel));
      }

      loadQuota();
    });

    compactBtn.addEventListener("click", () => {
      S.compact = !S.compact;
      panel.classList.toggle("gqp-compact", S.compact);
      compactBtn.textContent = S.compact ? "🔎" : "📏";
      compactBtn.title = S.compact ? "Normal view" : "Compact view";
      lsSet(K_COMPACT, S.compact ? "1" : "0");

      // When minimized, switching mode should also open the quota info area,
      // both Compact -> Normal and Normal -> Compact.
      if (S.folded) {
        S.folded = false;
        panel.classList.remove("gqp-folded");
        foldBtn.textContent = "➖";
        foldBtn.title = "Minimize";
        lsSet(K_FOLDED, "0");
      }

      requestAnimationFrame(() => keepPanelOnScreen(panel));
    });

    foldBtn.addEventListener("click", () => {
      S.folded = !S.folded;
      panel.classList.toggle("gqp-folded", S.folded);
      foldBtn.textContent = S.folded ? "📂" : "➖";
      foldBtn.title = S.folded ? "Open" : "Minimize";
      lsSet(K_FOLDED, S.folded ? "1" : "0");
      requestAnimationFrame(() => keepPanelOnScreen(panel));
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

  function startPendingSweep() {
    if (S.pendingSweepTimer) return;
    S.pendingSweepTimer = setInterval(() => {
      try {
        const u = loadUsage();
        const changed = pruneRecentUsage(u);
        if (changed) refreshUsageOnly();
      } catch (e) {
        console.warn("[GrokUsage] Pending sweep error:", e);
      }
    }, PENDING_SWEEP_INTERVAL_MS);
  }

  function boot() {
    loadUsage();
    installGenerationCounterInterceptor();
    installImagineWebSocketInterceptor();
    startPendingSweep();
    setTimeout(checkBackupReminder, 2500);

    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", createUI, { once: true });
    } else {
      createUI();
    }
  }

  boot();
})();

