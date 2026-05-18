// ==UserScript==
// @name         Grok Prompt Manager Panel
// @namespace    alexds9.scripts
// @version      1.5.0
// @description  Draggable prompt panel with persistent seconds, titled prompt history, wildcard replacement, and backup/restore.
// @match        https://grok.com/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=grok.com
// @grant        none
// ==/UserScript==

(function () {
  "use strict";

  const LS_PREFIX = "grok_prompt_mgr.";
  const K_POS = LS_PREFIX + "pos";
  const K_SECONDS = LS_PREFIX + "seconds";
  const K_CURRENT_PROMPT = LS_PREFIX + "currentPrompt";
  const K_PROMPTS = LS_PREFIX + "prompts";
  const K_PROMPT_TITLES = LS_PREFIX + "promptTitles";
  const K_SELECTED = LS_PREFIX + "selectedIndex";
  const K_AR = LS_PREFIX + "aspectRatio";
  const K_MODE = LS_PREFIX + "mode";
  const K_IS_VIDEO_EDIT = LS_PREFIX + "isVideoEdit";
  const K_RESOLUTION = LS_PREFIX + "resolutionName";
  const K_SIDEBYSIDE = LS_PREFIX + "enableSideBySide";
  const K_FOLDED = LS_PREFIX + "folded";
  const K_WILDCARDS = LS_PREFIX + "wildcards";
  const K_WILDCARDS_ENABLED = LS_PREFIX + "wildcardsEnabled";

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
      localStorage.setItem(key, value);
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

  function saveJson(key, obj) {
    try {
      localStorage.setItem(key, JSON.stringify(obj));
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

  function css(x, s) {
    x.style.cssText = s;
    return x;
  }

  function truncateOneLine(s, maxLen) {
    const t = String(s || "").replace(/\s+/g, " ").trim();
    if (t.length <= maxLen) return t;
    return t.slice(0, maxLen - 3) + "...";
  }

  function escapeHtml(s) {
    return String(s || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function escapeRegExp(s) {
    return String(s || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  }

  function buildHighlightedHtml(text, query) {
    const src = String(text || "");
    const q = String(query || "").trim();
    if (!q) return escapeHtml(src);

    const re = new RegExp(escapeRegExp(q), "gi");
    let out = "";
    let last = 0;
    let m;
    while ((m = re.exec(src)) !== null) {
      const i = m.index;
      const j = i + m[0].length;
      out += escapeHtml(src.slice(last, i));
      out += '<span class="gpm-hl">' + escapeHtml(src.slice(i, j)) + "</span>";
      last = j;
      if (m[0].length === 0) re.lastIndex++;
    }
    out += escapeHtml(src.slice(last));
    return out;
  }

  function ensurePromptHighlightStyles() {
    const id = "grok-prompt-mgr-style";
    if (document.getElementById(id)) return;

    const st = el("style");
    st.id = id;
    st.textContent = [
      "#grok-prompt-mgr textarea.gpm-prompt::placeholder { color: #888; }",
      "#grok-prompt-mgr .gpm-hl { background: rgba(74, 222, 128, 0.45); color: #eaffea; border-radius: 3px; }",
      "#grok-prompt-mgr .gpm-highlighter { scrollbar-width: none; }",
      "#grok-prompt-mgr .gpm-highlighter::-webkit-scrollbar { width: 0; height: 0; }",
      "#grok-prompt-mgr .gpm-highlight-on .gpm-highlighter { display: block !important; }",
      "#grok-prompt-mgr .gpm-highlight-on textarea.gpm-prompt { color: transparent !important; caret-color: #fff; }"
    ].join("\n");
    document.head.appendChild(st);
  }



  function promptText(item) {
    if (item && typeof item === "object" && !Array.isArray(item)) return String(item.text || "");
    return String(item || "");
  }

  function promptTitle(item, idx) {
    if (item && typeof item === "object" && !Array.isArray(item)) return String(item.title || "").trim();
    return "";
  }

  function makePromptItem(title, text) {
    return { title: String(title || "").trim(), text: String(text || "").trim() };
  }

  function normalizePromptsStore(rawPrompts, rawTitles) {
    const arr = Array.isArray(rawPrompts) ? rawPrompts : [];
    const titles = Array.isArray(rawTitles) ? rawTitles : [];
    return arr.map((item, i) => {
      if (item && typeof item === "object" && !Array.isArray(item)) {
        return makePromptItem(item.title || titles[i] || "", item.text || item.prompt || "");
      }
      return makePromptItem(titles[i] || "", item);
    }).filter((item) => item.text);
  }

  function savePromptsStore(prompts) {
    saveJson(K_PROMPTS, (Array.isArray(prompts) ? prompts : []).map((x) => makePromptItem(promptTitle(x), promptText(x))));
  }

  function displayPromptName(item, idx) {
    const t = promptTitle(item, idx);
    if (t) return (idx + 1) + ". " + truncateOneLine(t, 72);
    return (idx + 1) + ". " + truncateOneLine(promptText(item), 72);
  }

  function refreshSelect(selectEl, prompts, indices) {
    const prev = parseInt(String(selectEl.value || "-1"), 10);
    selectEl.innerHTML = "";

    const opt0 = el("option");
    opt0.value = "-1";
    opt0.textContent = "-- select saved prompt --";
    selectEl.appendChild(opt0);

    const idxs = Array.isArray(indices) ? indices : prompts.map((_, i) => i);

    idxs.forEach((origIdx) => {
      const item = prompts[origIdx];
      const opt = el("option");
      opt.value = String(origIdx);
      opt.textContent = displayPromptName(item, origIdx);
      opt.title = promptTitle(item, origIdx) ? promptText(item) : "";
      selectEl.appendChild(opt);
    });

    if (Number.isFinite(prev) && prev >= 0 && prev < prompts.length && idxs.includes(prev)) {
      selectEl.value = String(prev);
    } else {
      selectEl.value = "-1";
    }
  }

  function findGrokInput() {
    // Heuristic: prefer visible textarea not inside our panel
    const panel = document.getElementById("grok-prompt-mgr");
    const isVisible = (el) => {
      if (!el || !el.isConnected) return false;
      const cs = getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden") return false;
      const r = el.getBoundingClientRect?.();
      if (!r || r.width < 5 || r.height < 5) return false;
      return true;
    };

    const candidates = Array.from(document.querySelectorAll("textarea, [contenteditable='true']"))
      .filter((n) => isVisible(n) && (!panel || !panel.contains(n)));

    // Prefer textareas
    const ta = candidates.find((n) => n.tagName === "TEXTAREA");
    if (ta) return { kind: "textarea", node: ta };

    // Fallback: contenteditable
    const ce = candidates.find((n) => n.getAttribute("contenteditable") === "true");
    if (ce) return { kind: "contenteditable", node: ce };

    return null;
  }

  function setInputValue(target, text) {
    if (!target) return false;
    const s = String(text || "");

    if (target.kind === "textarea") {
      target.node.value = s;
      target.node.dispatchEvent(new Event("input", { bubbles: true }));
      target.node.focus();
      return true;
    }

    if (target.kind === "contenteditable") {
      target.node.textContent = s;
      target.node.dispatchEvent(new Event("input", { bubbles: true }));
      target.node.focus();
      return true;
    }

    return false;
  }

  function copyToClipboard(text) {
    const s = String(text || "");
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(s).catch(() => {});
    }
    // Fallback
    const ta = el("textarea");
    ta.value = s;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand("copy"); } catch (_) {}
    ta.remove();
    return Promise.resolve();
  }


  function normalizeWildcardName(name) {
    return String(name || "").trim().replace(/^__+|__+$/g, "").trim();
  }

  function parseWildcardOptions(text) {
    return String(text || "")
      .split(/\r?\n/g)
      .map((x) => x.trim())
      .filter((x) => x.length > 0);
  }

  function loadWildcards() {
    const obj = loadJson(K_WILDCARDS, {});
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return {};

    const out = {};
    Object.keys(obj).forEach((k) => {
      const name = normalizeWildcardName(k);
      if (!name) return;
      const v = obj[k];
      if (Array.isArray(v)) out[name] = v.map((x) => String(x || "").trim()).filter(Boolean).join("\n");
      else out[name] = String(v || "").replace(/\r\n/g, "\n");
    });
    return out;
  }

  function saveWildcards(obj) {
    const out = {};
    Object.keys(obj || {}).sort((a, b) => a.localeCompare(b)).forEach((k) => {
      const name = normalizeWildcardName(k);
      if (!name) return;
      out[name] = String(obj[k] || "").replace(/\r\n/g, "\n").trim();
    });
    saveJson(K_WILDCARDS, out);
  }

  function extractWildcardNames(text) {
    const names = [];
    const seen = new Set();
    const re = /__([A-Za-z0-9_. -]+?)__/g;
    let m;
    while ((m = re.exec(String(text || ""))) !== null) {
      const name = normalizeWildcardName(m[1]);
      if (name && !seen.has(name)) {
        seen.add(name);
        names.push(name);
      }
      if (m[0].length === 0) re.lastIndex++;
    }
    return names;
  }

  function rollWildcardPrompt(prompt, options) {
    const opts = options || {};
    const wildcards = loadWildcards();
    const used = [];
    const missing = [];
    const empty = [];

    const text = String(prompt || "").replace(/__([A-Za-z0-9_. -]+?)__/g, (full, rawName) => {
      const name = normalizeWildcardName(rawName);
      if (!Object.prototype.hasOwnProperty.call(wildcards, name)) {
        missing.push(name);
        return full;
      }
      const values = parseWildcardOptions(wildcards[name]);
      if (!values.length) {
        empty.push(name);
        return full;
      }
      const choice = values[Math.floor(Math.random() * values.length)];
      used.push({ name, choice });
      return choice;
    });

    const uniq = (arr) => Array.from(new Set(arr));
    const missingU = uniq(missing);
    const emptyU = uniq(empty);

    if ((missingU.length || emptyU.length) && options.askOnProblem !== false) {
      const parts = [];
      if (missingU.length) parts.push("Missing wildcards: " + missingU.map((x) => "__" + x + "__").join(", "));
      if (emptyU.length) parts.push("Empty wildcards: " + emptyU.map((x) => "__" + x + "__").join(", "));
      parts.push("Continue and leave these placeholders unchanged?");
      const ok = window.confirm(parts.join("\n"));
      if (!ok) return { ok: false, text: prompt, used, missing: missingU, empty: emptyU };
    }

    return { ok: true, text, used, missing: missingU, empty: emptyU };
  }

  function downloadTextFile(filename, text, mime) {
    const blob = new Blob([String(text || "")], { type: mime || "text/plain" });
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


  function collectFullSettings(prompts) {
    return {
      schema: "grok_prompt_mgr.settings",
      version: 1,
      exportedAt: new Date().toISOString(),
      currentPrompt: lsGet(K_CURRENT_PROMPT, ""),
      selectedIndex: parseInt(lsGet(K_SELECTED, "-1"), 10),
      seconds: lsGet(K_SECONDS, ""),
      aspectRatio: lsGet(K_AR, ""),
      mode: lsGet(K_MODE, ""),
      isVideoEdit: lsGet(K_IS_VIDEO_EDIT, ""),
      resolutionName: lsGet(K_RESOLUTION, ""),
      enableSideBySide: lsGet(K_SIDEBYSIDE, ""),
      folded: lsGet(K_FOLDED, "0"),
      wildcardsEnabled: lsGet(K_WILDCARDS_ENABLED, "1"),
      prompts: (Array.isArray(prompts) ? prompts : normalizePromptsStore(loadJson(K_PROMPTS, []), loadJson(K_PROMPT_TITLES, []))).map((x) => makePromptItem(promptTitle(x), promptText(x))),
      wildcards: loadWildcards()
    };
  }

  function applyFullSettings(obj) {
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) throw new Error("JSON root must be an object.");

    const incomingPrompts = normalizePromptsStore(obj.prompts || [], obj.promptTitles || []);
    if (Array.isArray(obj.prompts)) savePromptsStore(incomingPrompts);

    if (obj.wildcards && typeof obj.wildcards === "object" && !Array.isArray(obj.wildcards)) saveWildcards(obj.wildcards);

    const maybeSet = (key, val) => {
      if (val !== undefined && val !== null) lsSet(key, String(val));
    };

    maybeSet(K_CURRENT_PROMPT, obj.currentPrompt);
    maybeSet(K_SELECTED, obj.selectedIndex);
    maybeSet(K_SECONDS, obj.seconds);
    maybeSet(K_AR, obj.aspectRatio);
    maybeSet(K_MODE, obj.mode);
    maybeSet(K_IS_VIDEO_EDIT, obj.isVideoEdit);
    maybeSet(K_RESOLUTION, obj.resolutionName);
    maybeSet(K_SIDEBYSIDE, obj.enableSideBySide);
    maybeSet(K_FOLDED, obj.folded);
    maybeSet(K_WILDCARDS_ENABLED, obj.wildcardsEnabled);

    return { prompts: incomingPrompts.length, wildcards: Object.keys(loadWildcards()).length };
  }

  function createUI() {
    if (document.getElementById("grok-prompt-mgr")) return;

    let prompts = normalizePromptsStore(loadJson(K_PROMPTS, []), loadJson(K_PROMPT_TITLES, []));
    savePromptsStore(prompts);

    const savedPos = loadJson(K_POS, null);
    const savedSeconds = lsGet(K_SECONDS, "");
    const savedPrompt = lsGet(K_CURRENT_PROMPT, "");
    const savedSelected = parseInt(lsGet(K_SELECTED, "-1"), 10);
    const savedAR = lsGet(K_AR, "");
    const savedMode = lsGet(K_MODE, "");
    const savedIsVideoEdit = lsGet(K_IS_VIDEO_EDIT, "");
    const savedResolution = lsGet(K_RESOLUTION, "");
    const savedSideBySide = lsGet(K_SIDEBYSIDE, "");
    const savedFolded = lsGet(K_FOLDED, "0") === "1";
    const savedWildcardsEnabled = lsGet(K_WILDCARDS_ENABLED, "1") !== "0";
    let wildcards = loadWildcards();

    const panel = css(el("div"), [
      "position: fixed",
      "top: 80px",
      "left: calc(100vw - 850px)",
      "width: 830px",
      "background: #1a1a1a",
      "border: 1px solid #333",
      "border-radius: 10px",
      "padding: 12px",
      "z-index: 999999",
      "color: #fff",
      "font-family: system-ui, Segoe UI, Roboto, Ubuntu, Arial, sans-serif",
      "box-shadow: 0 4px 15px rgba(0,0,0,0.5)"
    ].join(";"));

    panel.id = "grok-prompt-mgr";

    let lastPos = null;

    const header = css(el("div"), [
      "display: flex",
      "align-items: center",
      "justify-content: flex-start",
      "gap: 10px",
      "cursor: move",
      "user-select: none",
      "margin-bottom: 10px"
    ].join(";"));

    const title = css(el("div", { textContent: "Prompt Manager" }), "font-size: 14px; font-weight: 700; color: #4ade80;");
    title.style.flex = "1 1 auto";
    const btnRow = css(el("div"), "display: flex; gap: 8px; margin-left: auto;");

    const hideBtn = css(el("button", { textContent: "Minimize" }), "background: none; border: 1px solid #333; color: #bbb; padding: 3px 8px; border-radius: 7px; cursor: pointer; font-size: 12px;");
    const contentWrap = css(el("div"), "display: block;");

    let isFolded = false;

    const PANEL_W_EXPANDED = "830px";
    const PANEL_W_FOLDED = "210px";

    function applyFoldState(folded, persist) {
      isFolded = !!folded;

      contentWrap.style.display = isFolded ? "none" : "block";
      hideBtn.textContent = isFolded ? "Open" : "Minimize";

      // Resize panel when minimized to remove empty space
      panel.style.width = isFolded ? PANEL_W_FOLDED : PANEL_W_EXPANDED;
      // Slightly tighter padding when minimized
      panel.style.padding = isFolded ? "10px" : "12px";

      // When folded, avoid a big empty gap between title and button
      if (isFolded) {
        title.style.flex = "0 0 auto";
        btnRow.style.marginLeft = "8px";
      } else {
        title.style.flex = "1 1 auto";
        btnRow.style.marginLeft = "auto";
      }

      // Smaller when folded
      header.style.marginBottom = isFolded ? "0px" : "10px";
      panel.style.paddingBottom = isFolded ? "8px" : "12px";

      if (persist) {
        lsSet(K_FOLDED, isFolded ? "1" : "0");
        // Keep anchored after height change
        const pos = lastPos || normalizePos(loadJson(K_POS, null));
        if (pos) applyPosFromRatios(pos);
      }
    }

    hideBtn.onclick = () => {
      applyFoldState(!isFolded, true);
    };


    btnRow.appendChild(hideBtn);
    header.appendChild(title);
    header.appendChild(btnRow);
    panel.appendChild(header);

    const mainCols = css(el("div"), "display: grid; grid-template-columns: minmax(380px, 1fr) minmax(330px, 0.85fr); gap: 10px; align-items: start;");
    const leftCol = css(el("div"), "min-width: 0; display: flex; flex-direction: column; gap: 8px;");
    const rightCol = css(el("div"), "min-width: 0; display: flex; flex-direction: column; gap: 8px;");
    mainCols.appendChild(leftCol);
    mainCols.appendChild(rightCol);
    contentWrap.appendChild(mainCols);

    // Compact grid: 3 fields per row (consistent 2-line labels)
    function group2(line1, line2) {
      const g = css(el("div"), "display: flex; flex-direction: column; gap: 4px;");
      const lab = css(el("div"), "font-size: 11px; color: #ccc; line-height: 1.05; min-height: 26px;");
      const l1 = el("div"); l1.textContent = line1;
      const l2 = css(el("div"), "font-size: 10px; color: #888;");
      l2.textContent = line2 || " ";
      lab.appendChild(l1);
      lab.appendChild(l2);
      g.appendChild(lab);
      return { g, lab, l1, l2 };
    }

    function group(label) {
      const s = String(label || '').trim();
      if (!s) return group2('', '');
      // Split into two lines to keep the grid aligned
      const m = s.match(/^([^\s]+)\s*(.*)$/);
      const line1 = (m && m[1]) ? m[1] : s;
      const line2 = (m && m[2]) ? m[2].trim() : '';
      return group2(line1, line2);
    }


    const grid = css(el("div"), "display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 10px; margin-bottom: 10px;");

    const inputCss = "width: 100%; padding: 6px 8px; height: 34px; background: #333; color: #fff; border: 1px solid #555; border-radius: 7px; font-size: 12px;";

    // Row 1: Seconds, Resolution, Mode
    const secondsG = group2("Seconds", "0 = Default");
    const secondsInput = css(el("input"), inputCss);
    secondsInput.id = "exp-len";
    secondsInput.type = "number";
    secondsInput.min = "0";
    secondsInput.max = "15";
    secondsInput.placeholder = "0 = default";
    secondsInput.value = savedSeconds;
    secondsInput.addEventListener("input", () => lsSet(K_SECONDS, String(secondsInput.value || "")));
    secondsG.g.appendChild(secondsInput);

    const resG = group2("Resolution", "Default/Unchanged");
    const resSelect = css(el("select"), inputCss);
    resSelect.id = "exp-resolutionName";
    [
      { label: "Default (Unchanged)", value: "" },
      { label: "480p", value: "480p" },
      { label: "720p", value: "720p" },
    ].forEach(({ label, value }) => {
      const opt = el("option");
      opt.value = value;
      opt.textContent = label;
      resSelect.appendChild(opt);
    });
    resSelect.value = savedResolution;
    resSelect.addEventListener("change", () => lsSet(K_RESOLUTION, resSelect.value || ""));
    resG.g.appendChild(resSelect);

    const modeG = group2("Mode", "Default/Unchanged");
    const modeSelect = css(el("select"), inputCss);
    modeSelect.id = "exp-mode";
    [
      { label: "Default (Unchanged)", value: "" },
      { label: "custom", value: "custom" },
      { label: "fun", value: "fun" },
      { label: "normal", value: "normal" },
      { label: "spicy", value: "spicy" },
    ].forEach(({ label, value }) => {
      const opt = el("option");
      opt.value = value;
      opt.textContent = label;
      modeSelect.appendChild(opt);
    });
    modeSelect.value = savedMode;
    modeSelect.addEventListener("change", () => lsSet(K_MODE, modeSelect.value || ""));
    modeG.g.appendChild(modeSelect);

    // Row 2: Aspect ratio, isVideoEdit, enableSideBySide
    const arG = group2("Aspect ratio", "Default/Unchanged");
    const arSelect = css(el("select"), inputCss);
    arSelect.id = "exp-ar";
    [
      { label: "Default (Unchanged)", value: "" },
      { label: "1:1", value: "1:1" },
      { label: "16:9", value: "16:9" },
      { label: "9:16", value: "9:16" },
      { label: "4:3", value: "4:3" },
      { label: "3:4", value: "3:4" },
      { label: "2:3", value: "2:3" },
      { label: "3:2", value: "3:2" },
      { label: "2:1", value: "2:1" },
      { label: "1:2", value: "1:2" },
    ].forEach(({ label, value }) => {
      const opt = el("option");
      opt.value = value;
      opt.textContent = label;
      arSelect.appendChild(opt);
    });
    arSelect.value = savedAR;
    arSelect.addEventListener("change", () => lsSet(K_AR, arSelect.value || ""));
    arG.g.appendChild(arSelect);

    const iveG = group2("isVideoEdit", "Default/Unchanged");
    const iveSelect = css(el("select"), inputCss);
    iveSelect.id = "exp-isVideoEdit";
    [
      { label: "Default (Unchanged)", value: "" },
      { label: "true", value: "true" },
      { label: "false", value: "false" },
    ].forEach(({ label, value }) => {
      const opt = el("option");
      opt.value = value;
      opt.textContent = label;
      iveSelect.appendChild(opt);
    });
    iveSelect.value = savedIsVideoEdit;
    iveSelect.addEventListener("change", () => lsSet(K_IS_VIDEO_EDIT, iveSelect.value || ""));
    iveG.g.appendChild(iveSelect);

    const sbsG = group2("Side-by-side", "Default/Unchanged");
    const sbsSelect = css(el("select"), inputCss);
    sbsSelect.id = "exp-enableSideBySide";
    [
      { label: "Default (Unchanged)", value: "" },
      { label: "true", value: "true" },
      { label: "false", value: "false" },
    ].forEach(({ label, value }) => {
      const opt = el("option");
      opt.value = value;
      opt.textContent = label;
      sbsSelect.appendChild(opt);
    });
    sbsSelect.value = savedSideBySide;
    sbsSelect.addEventListener("change", () => lsSet(K_SIDEBYSIDE, sbsSelect.value || ""));
    sbsG.g.appendChild(sbsSelect);

    [secondsG, resG, modeG, arG, iveG, sbsG].forEach((x) => grid.appendChild(x.g));
    leftCol.appendChild(grid);

    // Prompt history select + search
    const histG = group("Prompt history");

    const searchRow = css(el("div"), "display: flex; gap: 6px; align-items: center; margin-bottom: 6px;");
    const searchInput = css(el("input"), "flex: 1 1 auto; padding: 6px; height: 34px; background: #333; color: #fff; border: 1px solid #555; border-radius: 6px; font-size: 12px;");
    searchInput.type = "text";
    searchInput.placeholder = "Search in saved prompts...";
    searchInput.autocomplete = "off";

    const clearSearchBtn = css(el("button", { textContent: "Clear" }), "flex: 0 0 auto; background: #222; border: 1px solid #444; color: #ddd; padding: 5px 8px; border-radius: 8px; cursor: pointer; font-size: 12px;");
    clearSearchBtn.title = "Clear search";

    searchRow.appendChild(searchInput);
    searchRow.appendChild(clearSearchBtn);

    const select = css(el("select"), "width: 100%; padding: 6px; background: #333; color: #fff; border: 1px solid #555; border-radius: 6px;");
    // Filled later by applySearchFilter()

    const promptTitleInput = css(el("input"), "width: 100%; margin-top: 6px; padding: 6px; height: 32px; background: #333; color: #fff; border: 1px solid #555; border-radius: 6px; font-size: 12px; box-sizing: border-box;");
    promptTitleInput.type = "text";
    promptTitleInput.placeholder = "Prompt title (optional, used in dropdown)";
    promptTitleInput.autocomplete = "off";

    const searchInfo = css(el("div"), "margin-top: 4px; font-size: 11px; color: #888;");

    if (Number.isFinite(savedSelected) && savedSelected >= 0 && savedSelected < prompts.length) {
      select.value = String(savedSelected);
    }

    select.addEventListener("change", () => {
      const idx = parseInt(select.value, 10);
      lsSet(K_SELECTED, String(Number.isFinite(idx) ? idx : -1));
      if (Number.isFinite(idx) && idx >= 0 && idx < prompts.length) {
        promptArea.value = promptText(prompts[idx]);
        promptTitleInput.value = promptTitle(prompts[idx], idx);
        lsSet(K_CURRENT_PROMPT, promptArea.value);
        updatePromptHighlighter();
      }
    });

    histG.g.appendChild(searchRow);
    histG.g.appendChild(select);
    histG.g.appendChild(promptTitleInput);
    histG.g.appendChild(searchInfo);
    leftCol.appendChild(histG.g);

    // Prompt textarea (persistent)
    ensurePromptHighlightStyles();

    const promptG = group("Prompt (editable)");

    const promptStack = css(el("div"), "position: relative; width: 100%; background: #333; border: 1px solid #555; border-radius: 6px; overflow: hidden;");
    promptStack.className = "gpm-prompt-stack";

    const highlighter = css(el("pre"), "position: absolute; inset: 0; margin: 0; padding: 6px; font-size: 12px; line-height: 1.25; font-family: inherit; white-space: pre-wrap; word-break: break-word; overflow: auto; pointer-events: none; color: #fff; display: none; box-sizing: border-box; z-index: 1;");
    highlighter.className = "gpm-highlighter";

    const promptArea = css(el("textarea"), "width: 100%; padding: 6px; background: transparent; color: #fff; border: none; resize: vertical; font-size: 12px; line-height: 1.25; font-family: inherit; min-height: 78px; outline: none; box-sizing: border-box; position: relative; z-index: 2;");
    promptArea.className = "gpm-prompt";
    promptArea.id = "exp-prompt";
    promptArea.placeholder = "Write or paste your prompt here. Newlines are kept.";
    promptArea.value = savedPrompt;

    function updatePromptHighlighter() {
      const q = String(searchInput.value || "").trim();
      if (!q) {
        promptStack.classList.remove("gpm-highlight-on");
        highlighter.innerHTML = "";
        return;
      }
      promptStack.classList.add("gpm-highlight-on");
      highlighter.innerHTML = buildHighlightedHtml(promptArea.value, q);
      highlighter.scrollTop = promptArea.scrollTop;
      highlighter.scrollLeft = promptArea.scrollLeft;
    }

    function applySearchFilter() {
      const qRaw = String(searchInput.value || "");
      const q = qRaw.trim().toLowerCase();

      let indices = null;
      if (q) {
        indices = [];
        for (let i = 0; i < prompts.length; i++) {
          const p = (promptTitle(prompts[i], i) + "\n" + promptText(prompts[i])).toLowerCase();
          if (p.includes(q)) indices.push(i);
        }
      }

      refreshSelect(select, prompts, indices);

      const shown = Array.isArray(indices) ? indices.length : prompts.length;
      if (q) searchInfo.textContent = "Showing " + shown + " of " + prompts.length + " prompts.";
      else searchInfo.textContent = "Showing all " + prompts.length + " prompts.";

      const disabled = !qRaw.trim();
      clearSearchBtn.disabled = disabled;
      clearSearchBtn.style.opacity = disabled ? "0.5" : "1";

      updatePromptHighlighter();
    }

    searchInput.addEventListener("input", applySearchFilter);
    clearSearchBtn.addEventListener("click", () => {
      searchInput.value = "";
      applySearchFilter();
      searchInput.focus();
    });

    promptArea.addEventListener("input", () => {
      lsSet(K_CURRENT_PROMPT, promptArea.value);
      updatePromptHighlighter();
    });

    promptArea.addEventListener("scroll", () => {
      highlighter.scrollTop = promptArea.scrollTop;
      highlighter.scrollLeft = promptArea.scrollLeft;
    });

    promptStack.appendChild(highlighter);
    promptStack.appendChild(promptArea);

    promptG.g.appendChild(promptStack);
    leftCol.appendChild(promptG.g);

    if (Number.isFinite(savedSelected) && savedSelected >= 0 && savedSelected < prompts.length) {
      promptTitleInput.value = promptTitle(prompts[savedSelected], savedSelected);
    }

    // Initial fill
    applySearchFilter();


    // Wildcards manager
    const wcG = group2("Wildcards", "__name__ random replacement");

    const wcTopRow = css(el("div"), "display: flex; gap: 6px; align-items: center; margin-bottom: 6px; flex-wrap: wrap;");
    const wcEnableLabel = css(el("label"), "display: flex; align-items: center; gap: 5px; font-size: 12px; color: #ddd; user-select: none;");
    const wcEnable = el("input");
    wcEnable.type = "checkbox";
    wcEnable.checked = savedWildcardsEnabled;
    wcEnable.addEventListener("change", () => lsSet(K_WILDCARDS_ENABLED, wcEnable.checked ? "1" : "0"));
    wcEnableLabel.appendChild(wcEnable);
    wcEnableLabel.appendChild(el("span", { textContent: "Enable" }));

    const wcSelect = css(el("select"), "flex: 1 1 160px; min-width: 0; padding: 6px; height: 34px; background: #333; color: #fff; border: 1px solid #555; border-radius: 6px; font-size: 12px;");
    const wcNameInput = css(el("input"), "width: 100%; padding: 6px; height: 34px; background: #333; color: #fff; border: 1px solid #555; border-radius: 6px; font-size: 12px; margin-bottom: 6px;");
    wcNameInput.placeholder = "Wildcard name, for example: color";
    wcNameInput.autocomplete = "off";

    const wcOptionsArea = css(el("textarea"), "width: 100%; min-height: 78px; padding: 6px; background: #333; color: #fff; border: 1px solid #555; border-radius: 6px; resize: vertical; font-size: 12px; line-height: 1.25; font-family: inherit; box-sizing: border-box;");
    wcOptionsArea.placeholder = "One option per line. Example:\nred\nblue\nyellow";

    const wcInfo = css(el("div"), "margin-top: 4px; font-size: 11px; color: #888;");

    function refreshWildcardSelect(selectName) {
      const names = Object.keys(wildcards).sort((a, b) => a.localeCompare(b));
      const prev = selectName || wcSelect.value;
      wcSelect.innerHTML = "";
      const opt0 = el("option");
      opt0.value = "";
      opt0.textContent = "-- select wildcard --";
      wcSelect.appendChild(opt0);
      names.forEach((name) => {
        const count = parseWildcardOptions(wildcards[name]).length;
        const opt = el("option");
        opt.value = name;
        opt.textContent = "__" + name + "__ (" + count + ")";
        wcSelect.appendChild(opt);
      });
      wcSelect.value = names.includes(prev) ? prev : "";
      wcInfo.textContent = names.length + " wildcards saved.";
    }

    function loadWildcardIntoEditor(name) {
      const n = normalizeWildcardName(name);
      wcNameInput.value = n;
      wcOptionsArea.value = n && Object.prototype.hasOwnProperty.call(wildcards, n) ? wildcards[n] : "";
    }

    wcSelect.addEventListener("change", () => loadWildcardIntoEditor(wcSelect.value));

    const wcBtnRow1 = css(el("div"), "display: flex; gap: 6px; margin-top: 6px; flex-wrap: wrap;");
    const wcNewBtn = css(el("button", { textContent: "New" }), "background: #222; border: 1px solid #444; color: #ddd; padding: 5px 8px; border-radius: 8px; cursor: pointer; font-size: 12px;");
    const wcSaveBtn = css(el("button", { textContent: "Save/Rename" }), "background: #1f2a1f; border: 1px solid #2b4; color: #e7ffe7; padding: 5px 8px; border-radius: 8px; cursor: pointer; font-size: 12px;");
    const wcDelBtn = css(el("button", { textContent: "Delete" }), "background: #2a1f1f; border: 1px solid #844; color: #ffe7e7; padding: 5px 8px; border-radius: 8px; cursor: pointer; font-size: 12px;");
    const wcClipBtn = css(el("button", { textContent: "Add from clipboard" }), "background: #222; border: 1px solid #444; color: #ddd; padding: 5px 8px; border-radius: 8px; cursor: pointer; font-size: 12px;");

    const wcBtnRow2 = css(el("div"), "display: flex; gap: 6px; margin-top: 6px; flex-wrap: wrap;");
    const wcImportBtn = css(el("button", { textContent: "Import JSON" }), "background: #222; border: 1px solid #444; color: #ddd; padding: 5px 8px; border-radius: 8px; cursor: pointer; font-size: 12px;");
    const wcExportBtn = css(el("button", { textContent: "Export JSON" }), "background: #222; border: 1px solid #444; color: #ddd; padding: 5px 8px; border-radius: 8px; cursor: pointer; font-size: 12px;");
    const wcRollBtn = css(el("button", { textContent: "Roll preview" }), "background: #1f2430; border: 1px solid #467; color: #e7f0ff; padding: 5px 8px; border-radius: 8px; cursor: pointer; font-size: 12px;");
    const wcCopyRollBtn = css(el("button", { textContent: "Copy rolled" }), "background: #1f2430; border: 1px solid #467; color: #e7f0ff; padding: 5px 8px; border-radius: 8px; cursor: pointer; font-size: 12px;");
    const wcApplyRollBtn = css(el("button", { textContent: "Apply roll" }), "background: #1f2430; border: 1px solid #467; color: #e7f0ff; padding: 5px 8px; border-radius: 8px; cursor: pointer; font-size: 12px;");
    const wcScanBtn = css(el("button", { textContent: "Scan prompt" }), "background: #222; border: 1px solid #444; color: #ddd; padding: 5px 8px; border-radius: 8px; cursor: pointer; font-size: 12px;");
    const wcFileInput = el("input");
    wcFileInput.type = "file";
    wcFileInput.accept = "application/json,.json";
    wcFileInput.style.display = "none";

    function saveWildcardFromEditor() {
      const oldName = normalizeWildcardName(wcSelect.value);
      const name = normalizeWildcardName(wcNameInput.value);
      if (!name) {
        log("Wildcard name is empty.");
        return;
      }
      const value = String(wcOptionsArea.value || "").replace(/\r\n/g, "\n").trim();
      if (!parseWildcardOptions(value).length) {
        if (!window.confirm("This wildcard has no options. Save it anyway?")) return;
      }
      if (oldName && oldName !== name && Object.prototype.hasOwnProperty.call(wildcards, oldName)) {
        delete wildcards[oldName];
      }
      wildcards[name] = value;
      saveWildcards(wildcards);
      wildcards = loadWildcards();
      refreshWildcardSelect(name);
      loadWildcardIntoEditor(name);
      log("Saved wildcard __" + name + "__ with " + parseWildcardOptions(value).length + " options.");
    }

    function getRolledPrompt(askOnProblem) {
      if (!wcEnable.checked) {
        return { ok: true, text: String(promptArea.value || ""), used: [], missing: [], empty: [] };
      }
      return rollWildcardPrompt(promptArea.value, { askOnProblem });
    }

    wcNewBtn.onclick = () => {
      wcSelect.value = "";
      wcNameInput.value = "";
      wcOptionsArea.value = "";
      wcNameInput.focus();
      log("Cleared wildcard editor.");
    };

    wcSaveBtn.onclick = saveWildcardFromEditor;

    wcDelBtn.onclick = () => {
      const name = normalizeWildcardName(wcSelect.value || wcNameInput.value);
      if (!name || !Object.prototype.hasOwnProperty.call(wildcards, name)) {
        log("Select a wildcard to delete.");
        return;
      }
      if (!window.confirm("Delete wildcard __" + name + "__?")) return;
      delete wildcards[name];
      saveWildcards(wildcards);
      wildcards = loadWildcards();
      refreshWildcardSelect("");
      loadWildcardIntoEditor("");
      log("Deleted wildcard __" + name + "__.");
    };

    wcClipBtn.onclick = async () => {
      let txt = "";
      try {
        txt = await navigator.clipboard.readText();
      } catch (e) {
        log("Clipboard read failed: " + e.message);
        return;
      }
      const options = parseWildcardOptions(txt);
      if (!options.length) {
        log("Clipboard does not contain any non-empty lines.");
        return;
      }
      const name = normalizeWildcardName(window.prompt("Wildcard name? Example: color", wcNameInput.value || ""));
      if (!name) {
        log("Clipboard import cancelled.");
        return;
      }
      wildcards[name] = options.join("\n");
      saveWildcards(wildcards);
      wildcards = loadWildcards();
      refreshWildcardSelect(name);
      loadWildcardIntoEditor(name);
      log("Imported __" + name + "__ from clipboard with " + options.length + " options.");
    };

    wcExportBtn.onclick = () => {
      downloadTextFile("grok_prompt_wildcards.json", JSON.stringify(loadWildcards(), null, 2), "application/json");
      log("Exported wildcard JSON.");
    };

    wcImportBtn.onclick = () => wcFileInput.click();
    wcFileInput.addEventListener("change", async () => {
      const file = wcFileInput.files && wcFileInput.files[0];
      wcFileInput.value = "";
      if (!file) return;
      try {
        const txt = await file.text();
        const obj = JSON.parse(txt);
        if (!obj || typeof obj !== "object" || Array.isArray(obj)) throw new Error("JSON root must be an object.");
        const mode = window.confirm("OK = merge into existing wildcards.\nCancel = replace all existing wildcards.");
        const merged = mode ? Object.assign({}, loadWildcards(), obj) : obj;
        saveWildcards(merged);
        wildcards = loadWildcards();
        refreshWildcardSelect("");
        loadWildcardIntoEditor("");
        log("Imported wildcard JSON. Total wildcards: " + Object.keys(wildcards).length + ".");
      } catch (e) {
        log("Import JSON failed: " + e.message);
      }
    });

    function reportRollResult(res, prefix) {
      if (!res.ok) {
        log(prefix + " cancelled because wildcard problem was not accepted.");
        return;
      }
      const changed = res.used.length;
      const details = changed ? res.used.map((x) => "__" + x.name + "__=" + x.choice).join(" | ") : "no wildcards replaced";
      log(prefix + ": " + details);
      if (res.missing.length) log("Missing kept unchanged: " + res.missing.map((x) => "__" + x + "__").join(", "));
      if (res.empty.length) log("Empty kept unchanged: " + res.empty.map((x) => "__" + x + "__").join(", "));
    }

    wcRollBtn.onclick = () => {
      const res = getRolledPrompt(true);
      reportRollResult(res, "Roll preview");
      if (res.ok) window.alert(res.text || "(empty prompt)");
    };

    wcCopyRollBtn.onclick = () => {
      const res = getRolledPrompt(true);
      reportRollResult(res, "Copy rolled");
      if (res.ok) copyToClipboard(res.text).then(() => log("Copied rolled prompt."));
    };

    wcApplyRollBtn.onclick = () => {
      const res = getRolledPrompt(true);
      reportRollResult(res, "Apply roll");
      if (!res.ok) return;
      promptArea.value = res.text;
      lsSet(K_CURRENT_PROMPT, promptArea.value);
      updatePromptHighlighter();
      log("Applied rolled prompt to editor.");
    };

    wcScanBtn.onclick = () => {
      const names = extractWildcardNames(promptArea.value);
      if (!names.length) {
        log("Prompt has no __wildcard__ placeholders.");
        return;
      }
      const missing = names.filter((name) => !Object.prototype.hasOwnProperty.call(wildcards, name));
      const found = names.filter((name) => Object.prototype.hasOwnProperty.call(wildcards, name));
      if (found.length) log("Found wildcards: " + found.map((x) => "__" + x + "__").join(", "));
      if (missing.length) log("Missing wildcards: " + missing.map((x) => "__" + x + "__").join(", "));
    };

    wcTopRow.appendChild(wcEnableLabel);
    wcTopRow.appendChild(wcSelect);
    wcG.g.appendChild(wcTopRow);
    wcG.g.appendChild(wcNameInput);
    wcG.g.appendChild(wcOptionsArea);
    wcBtnRow1.appendChild(wcNewBtn);
    wcBtnRow1.appendChild(wcSaveBtn);
    wcBtnRow1.appendChild(wcDelBtn);
    wcBtnRow1.appendChild(wcClipBtn);
    wcBtnRow2.appendChild(wcImportBtn);
    wcBtnRow2.appendChild(wcExportBtn);
    wcBtnRow2.appendChild(wcRollBtn);
    wcBtnRow2.appendChild(wcCopyRollBtn);
    wcBtnRow2.appendChild(wcApplyRollBtn);
    wcBtnRow2.appendChild(wcScanBtn);
    wcG.g.appendChild(wcBtnRow1);
    wcG.g.appendChild(wcBtnRow2);
    wcG.g.appendChild(wcInfo);
    wcG.g.appendChild(wcFileInput);
    rightCol.appendChild(wcG.g);
    refreshWildcardSelect("");

    // Actions
    const actions = css(el("div"), "display: flex; gap: 6px; margin-top: 2px; flex-wrap: wrap;");

    const newBtn = css(el("button", { textContent: "New" }), "background: #222; border: 1px solid #444; color: #ddd; padding: 5px 8px; border-radius: 8px; cursor: pointer; font-size: 12px;");
    const saveBtn = css(el("button", { textContent: "Save" }), "background: #1f2a1f; border: 1px solid #2b4; color: #e7ffe7; padding: 5px 8px; border-radius: 8px; cursor: pointer; font-size: 12px;");
    const delBtn = css(el("button", { textContent: "Delete" }), "background: #2a1f1f; border: 1px solid #844; color: #ffe7e7; padding: 5px 8px; border-radius: 8px; cursor: pointer; font-size: 12px;");
    const exportAllBtn = css(el("button", { textContent: "Export all" }), "background: #1f2430; border: 1px solid #467; color: #e7f0ff; padding: 5px 8px; border-radius: 8px; cursor: pointer; font-size: 12px;");
    const importAllBtn = css(el("button", { textContent: "Import all" }), "background: #1f2430; border: 1px solid #467; color: #e7f0ff; padding: 5px 8px; border-radius: 8px; cursor: pointer; font-size: 12px;");
    const importAllFileInput = el("input");
    importAllFileInput.type = "file";
    importAllFileInput.accept = "application/json,.json";
    importAllFileInput.style.display = "none";

    const status = css(el("div"), "margin-top: 10px; padding: 8px; background: #000; border-radius: 6px; font-size: 11px; color: #aaa; max-height: 75px; overflow-y: auto; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;");
    status.id = 'exp-status';
    status.textContent = "Ready.";

    function log(msg) {
      const line = el("div");
      line.textContent = "[" + new Date().toLocaleTimeString() + "] " + msg;
      line.style.borderBottom = "1px solid #222";
      status.prepend(line);
    }

    newBtn.onclick = () => {
      select.value = "-1";
      lsSet(K_SELECTED, "-1");
      promptArea.value = "";
      promptTitleInput.value = "";
      lsSet(K_CURRENT_PROMPT, "");
      log("Cleared prompt editor.");
    };

    saveBtn.onclick = () => {
      const text = String(promptArea.value || "").trim();
      const pTitle = String(promptTitleInput.value || "").trim();
      if (!text) {
        log("Nothing to save (prompt is empty).");
        return;
      }

      let idx = parseInt(select.value, 10);
      const item = makePromptItem(pTitle, text);
      // Update existing selection
      if (Number.isFinite(idx) && idx >= 0 && idx < prompts.length) {
        prompts[idx] = item;
        log("Updated saved prompt #" + (idx + 1) + (pTitle ? " (" + pTitle + ")" : "") + ".");
      } else {
        // Add new (avoid exact duplicates by prompt text)
        const dup = prompts.findIndex((p) => promptText(p) === text);
        if (dup >= 0) {
          idx = dup;
          prompts[idx] = item;
          log("Already saved as #" + (dup + 1) + "; updated title/text and selected it.");
        } else {
          prompts.push(item);
          idx = prompts.length - 1;
          log("Saved new prompt #" + (idx + 1) + (pTitle ? " (" + pTitle + ")" : "") + ".");
        }
      }

      savePromptsStore(prompts);
      applySearchFilter();
      select.value = String(idx);
      lsSet(K_SELECTED, String(idx));
    };

    delBtn.onclick = () => {
      const idx = parseInt(select.value, 10);
      if (!(Number.isFinite(idx) && idx >= 0 && idx < prompts.length)) {
        log("Select a saved prompt to delete.");
        return;
      }
      prompts.splice(idx, 1);
      savePromptsStore(prompts);
      applySearchFilter();
      select.value = "-1";
      promptTitleInput.value = "";
      lsSet(K_SELECTED, "-1");
      log("Deleted saved prompt.");
    };

    exportAllBtn.onclick = () => {
      downloadTextFile("grok_prompt_manager_full_backup.json", JSON.stringify(collectFullSettings(prompts), null, 2), "application/json");
      log("Exported full settings JSON.");
    };

    importAllBtn.onclick = () => importAllFileInput.click();
    importAllFileInput.addEventListener("change", async () => {
      const file = importAllFileInput.files && importAllFileInput.files[0];
      importAllFileInput.value = "";
      if (!file) return;
      try {
        const txt = await file.text();
        const obj = JSON.parse(txt);
        if (!window.confirm("Import full settings? This can replace prompts, titles, wildcards, and UI options.")) return;
        const summary = applyFullSettings(obj);
        prompts = normalizePromptsStore(loadJson(K_PROMPTS, []), loadJson(K_PROMPT_TITLES, []));
        wildcards = loadWildcards();
        promptArea.value = lsGet(K_CURRENT_PROMPT, "");
        promptTitleInput.value = "";
        secondsInput.value = lsGet(K_SECONDS, "");
        arSelect.value = lsGet(K_AR, "");
        modeSelect.value = lsGet(K_MODE, "");
        iveSelect.value = lsGet(K_IS_VIDEO_EDIT, "");
        resSelect.value = lsGet(K_RESOLUTION, "");
        sbsSelect.value = lsGet(K_SIDEBYSIDE, "");
        wcEnable.checked = lsGet(K_WILDCARDS_ENABLED, "1") !== "0";
        applySearchFilter();
        refreshWildcardSelect("");
        loadWildcardIntoEditor("");
        updatePromptHighlighter();
        log("Imported full settings JSON. Prompts: " + summary.prompts + ", wildcards: " + summary.wildcards + ".");
      } catch (e) {
        log("Import full settings failed: " + e.message);
      }
    });


    newBtn.style.flex = "0 0 auto";
    saveBtn.style.flex = "0 0 auto";
    delBtn.style.flex = "0 0 auto";
    exportAllBtn.style.flex = "0 0 auto";
    importAllBtn.style.flex = "0 0 auto";

    actions.appendChild(newBtn);
    actions.appendChild(saveBtn);
    actions.appendChild(delBtn);
    actions.appendChild(exportAllBtn);
    actions.appendChild(importAllBtn);
    actions.appendChild(importAllFileInput);
    leftCol.appendChild(actions);
    leftCol.appendChild(status);

    panel.appendChild(contentWrap);
    document.body.appendChild(panel);

    function maxLeft() {
      return Math.max(0, window.innerWidth - panel.offsetWidth);
    }

    function maxTop() {
      return Math.max(0, window.innerHeight - panel.offsetHeight);
    }

    function normalizePos(posObj) {
      if (posObj && typeof posObj.x === "number" && typeof posObj.y === "number") {
        return { x: clamp(posObj.x, 0, 1), y: clamp(posObj.y, 0, 1) };
      }

      // Legacy migration: { left, top } px -> { x, y } ratios
      if (posObj && typeof posObj.left === "number" && typeof posObj.top === "number") {
        const ml = maxLeft();
        const mt = maxTop();
        const x = ml ? clamp(posObj.left / ml, 0, 1) : 0;
        const y = mt ? clamp(posObj.top / mt, 0, 1) : 0;
        return { x, y };
      }

      return null;
    }

    function applyPosFromRatios(pos) {
      if (!pos) return;
      const ml = maxLeft();
      const mt = maxTop();
      const left = Math.round(clamp(pos.x, 0, 1) * ml);
      const top = Math.round(clamp(pos.y, 0, 1) * mt);

      panel.style.left = left + "px";
      panel.style.top = top + "px";
      panel.style.right = "auto";
    }

    function savePosFromCurrentRect() {
      const rect = panel.getBoundingClientRect();
      const ml = maxLeft();
      const mt = maxTop();

      const x = ml ? clamp(rect.left / ml, 0, 1) : 0;
      const y = mt ? clamp(rect.top / mt, 0, 1) : 0;

      lastPos = { x, y };
      saveJson(K_POS, lastPos);
      return lastPos;
    }

    function restorePos() {
      const raw = loadJson(K_POS, null);
      const pos = normalizePos(raw);

      if (pos) {
        lastPos = pos;
        saveJson(K_POS, pos); // ensures migration from legacy {left,top}
        applyPosFromRatios(pos);
        return;
      }

      // No saved pos yet: derive ratios from current computed position and start saving ratios
      savePosFromCurrentRect();
      applyPosFromRatios(lastPos);
    }

    // Init folded state + position (needs DOM for offsetWidth/offsetHeight)
    applyFoldState(savedFolded, false);
    restorePos();

    // Keep relative position when the viewport size changes
    let resizeRaf = 0;
    window.addEventListener("resize", () => {
      if (resizeRaf) cancelAnimationFrame(resizeRaf);
      resizeRaf = requestAnimationFrame(() => {
        const pos = lastPos || normalizePos(loadJson(K_POS, null));
        if (pos) applyPosFromRatios(pos);
      });
    });


    // Draggable behavior (header as handle), persist position
    let dragging = false;
    let startX = 0, startY = 0, startLeft = 0, startTop = 0;

    function onMove(e) {
      if (!dragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      const left = clamp(startLeft + dx, 0, window.innerWidth - panel.offsetWidth);
      const top = clamp(startTop + dy, 0, window.innerHeight - panel.offsetHeight);
      panel.style.left = left + "px";
      panel.style.top = top + "px";
      panel.style.right = "auto";
    }

    function onUp() {
      if (!dragging) return;
      dragging = false;
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);

      savePosFromCurrentRect();
    }

    header.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      dragging = true;

      const rect = panel.getBoundingClientRect();
      startX = e.clientX;
      startY = e.clientY;
      startLeft = rect.left;
      startTop = rect.top;

      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
      e.preventDefault();
    });

    log("Panel loaded. Prompts saved: " + prompts.length + ".");
  }


    const log = (msg) => {
        const el = document.getElementById('exp-status');
        if (el) {
            const line = document.createElement('div');
            line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
            line.style.borderBottom = '1px solid #222';
            el.prepend(line);
        }
        console.log('[GrokExp]', msg);
    };

    // --- Logic ---

    const extractUuid = (url) => {
        // Matches standard UUID pattern
        const match = url.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
        return match ? match[1] : null;
    };

    const modifyPayload = (originalBody) => {
        try {
            const body = JSON.parse(originalBody);

            // Only target video generation requests.
            // Grok changed the request shape: newer payloads may no longer include
            // body.toolOverrides.videoGen. The current image-to-video request is
            // identified by modelName "imagine-video-gen" and/or by the nested
            // videoGenModelConfig under responseMetadata.
            const hasOldVideoOverride = !!body.toolOverrides?.videoGen;
            const hasCurrentVideoModel = body.modelName === "imagine-video-gen";
            const hasVideoConfig = !!body.responseMetadata?.modelConfigOverride?.modelMap?.videoGenModelConfig;

            if (!hasOldVideoOverride && !hasCurrentVideoModel && !hasVideoConfig) {
                return originalBody;
            }

//            const enable = document.getElementById('exp-enable')?.checked;
//            if (!enable) return originalBody;

            log('Intercepted Video Gen Request!');

            let config = body.responseMetadata?.modelConfigOverride?.modelMap?.videoGenModelConfig;
            if (!config) {
                // Initialize structure if missing (unlikely for video gen but safe)
                if (!body.responseMetadata) body.responseMetadata = {};
                if (!body.responseMetadata.modelConfigOverride) body.responseMetadata.modelConfigOverride = {};
                if (!body.responseMetadata.modelConfigOverride.modelMap) body.responseMetadata.modelConfigOverride.modelMap = {};
                body.responseMetadata.modelConfigOverride.modelMap.videoGenModelConfig = {};
                config = body.responseMetadata.modelConfigOverride.modelMap.videoGenModelConfig;
            }

            // 1. Aspect Ratio
            const ar = document.getElementById('exp-ar')?.value;
            if (ar) {
                log(`Overriding AR: ${config.aspectRatio} -> ${ar}`);
                config.aspectRatio = ar;
            }

            // 2. Video Length
            const len = document.getElementById('exp-len')?.value;
            if (len !== undefined && len !== null && String(len).trim() !== "") {
                const val = parseInt(len, 10);

                // 0 means Default / Unchanged.
                // Any positive number overrides videoLength.
                if (!isNaN(val) && val > 0) {
                    log(`Overriding Length: ${config.videoLength} -> ${val}`);
                    config.videoLength = val;
                } else if (val === 0) {
                    log("Leaving Length unchanged because Seconds is 0.");
                }
            }


            // 3. Mode (message flag --mode=...)
            const uiMode = document.getElementById("exp-mode")?.value || "";
            if (uiMode) {
                const msg = String(body.message || "");
                if (/--mode=[^\s"]+/i.test(msg)) {
                    body.message = msg.replace(/--mode=[^\s"]+/i, `--mode=${uiMode}`);
                } else {
                    body.message = (msg + ` --mode=${uiMode}`).trim();
                }
            }

            // 3b. isVideoEdit
            const uiIsVideoEdit = document.getElementById("exp-isVideoEdit")?.value || "";
            if (uiIsVideoEdit === "true" || uiIsVideoEdit === "false") {
                const b = uiIsVideoEdit === "true";
                log(`Overriding isVideoEdit: ${config.isVideoEdit} -> ${b}`);
                config.isVideoEdit = b;
            }

            // 3c. resolutionName
            const uiRes = document.getElementById("exp-resolutionName")?.value || "";
            if (uiRes) {
                log(`Overriding resolutionName: ${config.resolutionName} -> ${uiRes}`);
                config.resolutionName = uiRes;
            }

            // 3d. enableSideBySide (top-level)
            const uiSbs = document.getElementById("exp-enableSideBySide")?.value || "";
            if (uiSbs === "true" || uiSbs === "false") {
                const b = uiSbs === "true";
                log(`Overriding enableSideBySide: ${body.enableSideBySide} -> ${b}`);
                body.enableSideBySide = b;
            }

            // 4. Prompt (apply whenever non-empty, regardless of mode)
            const rawPrompt = document.getElementById("exp-prompt")?.value ?? "";
            let promptForRequest = String(rawPrompt || "");
            const wildcardsEnabled = lsGet(K_WILDCARDS_ENABLED, "1") !== "0";
            if (wildcardsEnabled && /__([A-Za-z0-9_. -]+?)__/.test(promptForRequest)) {
                const rolled = rollWildcardPrompt(promptForRequest, { askOnProblem: true });
                if (!rolled.ok) {
                    log("Prompt override cancelled because missing/empty wildcard was not accepted.");
                    return originalBody;
                }
                promptForRequest = rolled.text;
                if (rolled.used && rolled.used.length) {
                    log("Applied wildcards: " + rolled.used.map((x) => "__" + x.name + "__=" + x.choice).join(" | "));
                }
            }
            const promptSanitized = String(promptForRequest || "").trim();

            if (promptSanitized) {
              const msg0 = String(body.message || "").trim();

              // Keep the leading URL (first token) if present
              let urlToken = "";
              let rest = msg0;
              const mUrl = msg0.match(/^(https?:\/\/\S+)\s*(.*)$/);
              if (mUrl) {
                urlToken = mUrl[1] || "";
                rest = (mUrl[2] || "").trim();
              }

              // Determine final mode: UI override wins, else keep existing --mode=..., else none
              const uiMode2 = document.getElementById("exp-mode")?.value || "";
              const mMode = msg0.match(/--mode=([^\s"]+)/i);
              const existingMode = mMode ? (mMode[1] || "") : "";
              const modeFinal = uiMode2 || existingMode || "";

              // Remove any existing --mode=... from the rest
              rest = rest.replace(/--mode=[^\s"]+/ig, "").trim();

              let newMsg = "";
              if (urlToken) newMsg = (urlToken + " " + promptSanitized).trim();
              else newMsg = promptSanitized;

              if (modeFinal) newMsg = (newMsg + " --mode=" + modeFinal).trim();

              body.message = newMsg;
              log("Applied prompt override.");
            }

            // 5. Image Swap - unused
            const swapUrl = false; //document.getElementById('exp-url')?.value?.trim();
            if (swapUrl) {
                const newUuid = extractUuid(swapUrl);
                if (newUuid) {
                    log(`Swapping Image ID: ${config.parentPostId} -> ${newUuid}`);

                    // Update parentPostId
                    config.parentPostId = newUuid;

                    // Update Message URL
                    // We need to be careful to replace just the URL part
                    // Strategy: Find the existing UUID in the message and replace the whole URL containing it?
                    // Or just prepend the new URL if we are constructing a fresh message?
                    // Existing message examples:
                    // "https://.../OLD_UUID.png --mode=normal"
                    // "https://.../OLD_UUID/content \"prompt\" ..."

                    // Let's try to find the URL in the message
                    // Regex to find http...UUID...
                    // It might end with space, quote, or end of string
                    const urlRegex = /https?:\/\/[^\s"]+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})[^\s"]*/i;



                    if (body.message && body.message.match(urlRegex)) {
                        body.message = body.message.replace(urlRegex, swapUrl);
                        log('Updated Message URL');
                    } else {
                        // Fallback if regex fails (maybe message format changed)
                        // Just prepend/replace? Let's warn.
                        log('Warning: Could not find URL in message to replace. Appending new URL.');
                        body.message = swapUrl + " " + body.message;
                    }

                    // Update fileAttachments if present (for user uploads)
                    if (body.fileAttachments && Array.isArray(body.fileAttachments)) {
                        // If we are swapping, we should probably replace the attachment ID
                        // Assuming single attachment for video gen
                        body.fileAttachments = [newUuid];
                        log('Updated fileAttachments');
                    }
                } else {
                    log('Error: Invalid UUID in swap URL');
                }
            }

            return JSON.stringify(body);

        } catch (e) {
            console.error('[GrokExp] Error modifying payload:', e);
            log('Error modifying payload: ' + e.message);
            return originalBody;
        }
    };

    // --- Interceptor ---
    const originalFetch = window.fetch;
    window.fetch = async function (input, init) {
        let url = input;
        if (input instanceof Request) {
            url = input.url;
        }

        const method = String(init?.method || (input instanceof Request ? input.method : "GET")).toUpperCase();
        const isTarget = !!url && String(url).includes('/rest/app-chat/conversations/new') && method === 'POST';

        if (isTarget) {
            try {
                // Common path: fetch(url, { method: "POST", body: "..." })
                if (init && init.body) {
                    const newBody = modifyPayload(init.body);
                    if (newBody !== init.body) {
                        init = Object.assign({}, init, { body: newBody });
                        return originalFetch.call(this, input, init);
                    }
                }

                // More robust path: fetch(new Request(...))
                if (input instanceof Request && !init?.body) {
                    const oldBody = await input.clone().text();
                    if (oldBody) {
                        const newBody = modifyPayload(oldBody);
                        if (newBody !== oldBody) {
                            const newRequest = new Request(input, { body: newBody });
                            return originalFetch.call(this, newRequest);
                        }
                    }
                }
            } catch (e) {
                console.error('[GrokExp] Interceptor error:', e);
                log('Interceptor error: ' + e.message);
            }
        }

        return originalFetch.apply(this, arguments);
    };

    // --- Init ---
    // Wait for body
    const waitInterval = setInterval(() => {
        if (document.body) {
            clearInterval(waitInterval);
            createUI();
            log('Interceptor Active');
        }
    }, 300);
})();
