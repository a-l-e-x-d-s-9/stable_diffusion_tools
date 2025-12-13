// ==UserScript==
// @name         Grok Prompt Manager Panel
// @namespace    alexds9.scripts
// @version      1.2.1
// @description  Draggable prompt panel with persistent seconds, prompt, and prompt history.
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
  const K_SELECTED = LS_PREFIX + "selectedIndex";
  const K_AR = LS_PREFIX + "aspectRatio";
  const K_FOLDED = LS_PREFIX + "folded";

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

  function refreshSelect(selectEl, prompts) {
    const prev = Number(selectEl.value);
    selectEl.innerHTML = "";

    const opt0 = el("option");
    opt0.value = "-1";
    opt0.textContent = "-- select saved prompt --";
    selectEl.appendChild(opt0);

    prompts.forEach((p, i) => {
      const opt = el("option");
      opt.value = String(i);
      opt.textContent = (i + 1) + ". " + truncateOneLine(p, 60);
      selectEl.appendChild(opt);
    });

    if (Number.isFinite(prev) && prev >= 0 && prev < prompts.length) {
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

  function createUI() {
    if (document.getElementById("grok-prompt-mgr")) return;

    let prompts = loadJson(K_PROMPTS, []);
    if (!Array.isArray(prompts)) prompts = [];

    const savedPos = loadJson(K_POS, null);
    const savedSeconds = lsGet(K_SECONDS, "");
    const savedPrompt = lsGet(K_CURRENT_PROMPT, "");
    const savedSelected = parseInt(lsGet(K_SELECTED, "-1"), 10);
    const savedAR = lsGet(K_AR, "");
    const savedFolded = lsGet(K_FOLDED, "0") === "1";

    const panel = css(el("div"), [
      "position: fixed",
      "top: 80px",
      "left: calc(100vw - 360px)",
      "width: 340px",
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
      "justify-content: space-between",
      "gap: 10px",
      "cursor: move",
      "user-select: none",
      "margin-bottom: 10px"
    ].join(";"));

    const title = css(el("div", { textContent: "Prompt Manager" }), "font-size: 14px; font-weight: 700; color: #4ade80;");
    const btnRow = css(el("div"), "display: flex; gap: 8px;");

    const hideBtn = css(el("button", { textContent: "Hide" }), "background: none; border: 1px solid #333; color: #bbb; padding: 3px 8px; border-radius: 7px; cursor: pointer; font-size: 12px;");
    const contentWrap = css(el("div"), "display: block;");

    let isFolded = false;

    function applyFoldState(folded, persist) {
      isFolded = !!folded;

      contentWrap.style.display = isFolded ? "none" : "block";
      hideBtn.textContent = isFolded ? "Show" : "Hide";

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

    function group(labelText) {
      const g = css(el("div"), "margin-bottom: 10px;");
      const lab = css(el("label", { textContent: labelText }), "display: block; margin-bottom: 5px; font-size: 12px; color: #ccc;");
      g.appendChild(lab);
      return { g, lab };
    }

    // Seconds (persistent)
    const secondsG = group("Seconds (note / preference)");
    const secondsInput = css(el("input"), "width: 100%; padding: 6px; background: #333; color: #fff; border: 1px solid #555; border-radius: 6px;");
    secondsInput.id = 'exp-len';
    secondsInput.type = "number";
    secondsInput.min = "1";
    secondsInput.max = "15";
    secondsInput.placeholder = "e.g. 15";
    secondsInput.value = savedSeconds;

    secondsInput.addEventListener("input", () => {
      lsSet(K_SECONDS, String(secondsInput.value || ""));
    });

    secondsG.g.appendChild(secondsInput);
    contentWrap.appendChild(secondsG.g);

    // Aspect ratio (persistent, default unchanged)
    const arG = group("Aspect ratio (default: unchanged)");
    const arSelect = css(el("select"), "width: 100%; padding: 6px; background: #333; color: #fff; border: 1px solid #555; border-radius: 6px;");
    arSelect.id = 'exp-ar';

    [
      { label: "Default (Unchanged)", value: "" },
      { label: "1:1", value: "1:1" },
      { label: "16:9", value: "16:9" },
      { label: "9:16", value: "9:16" },
      { label: "4:3", value: "4:3" },
      { label: "3:4", value: "3:4" },
      { label: "2:1", value: "2:1" },
      { label: "1:2", value: "1:2" },
    ].forEach(({ label, value }) => {
      const opt = el("option");
      opt.value = value;
      opt.textContent = label;
      arSelect.appendChild(opt);
    });

    arSelect.value = savedAR;
    arSelect.addEventListener("change", () => {
      lsSet(K_AR, arSelect.value || "");
    });

    arG.g.appendChild(arSelect);
    contentWrap.appendChild(arG.g);


    // Prompt history select
    const histG = group("Prompt history");
    const select = css(el("select"), "width: 100%; padding: 6px; background: #333; color: #fff; border: 1px solid #555; border-radius: 6px;");
    refreshSelect(select, prompts);

    if (Number.isFinite(savedSelected) && savedSelected >= 0 && savedSelected < prompts.length) {
      select.value = String(savedSelected);
    }

    select.addEventListener("change", () => {
      const idx = parseInt(select.value, 10);
      lsSet(K_SELECTED, String(Number.isFinite(idx) ? idx : -1));
      if (Number.isFinite(idx) && idx >= 0 && idx < prompts.length) {
        promptArea.value = prompts[idx];
        lsSet(K_CURRENT_PROMPT, promptArea.value);
      }
    });

    histG.g.appendChild(select);
    contentWrap.appendChild(histG.g);

    // Prompt textarea (persistent)
    const promptG = group("Prompt (editable)");
    const promptArea = css(el("textarea"), "width: 100%; padding: 6px; background: #333; color: #fff; border: 1px solid #555; border-radius: 6px; resize: vertical; font-size: 12px; min-height: 90px;");
    promptArea.id = 'exp-prompt';
    promptArea.placeholder = "Write or paste your prompt here. Newlines are kept.";
    promptArea.value = savedPrompt;

    promptArea.addEventListener("input", () => {
      lsSet(K_CURRENT_PROMPT, promptArea.value);
    });

    promptG.g.appendChild(promptArea);
    contentWrap.appendChild(promptG.g);

    // Actions
    const actions = css(el("div"), "display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 6px;");

    const newBtn = css(el("button", { textContent: "New" }), "background: #222; border: 1px solid #444; color: #ddd; padding: 7px; border-radius: 8px; cursor: pointer; font-size: 12px;");
    const saveBtn = css(el("button", { textContent: "Save" }), "background: #1f2a1f; border: 1px solid #2b4; color: #e7ffe7; padding: 7px; border-radius: 8px; cursor: pointer; font-size: 12px;");
    const delBtn = css(el("button", { textContent: "Delete" }), "background: #2a1f1f; border: 1px solid #844; color: #ffe7e7; padding: 7px; border-radius: 8px; cursor: pointer; font-size: 12px;");

    const status = css(el("div"), "margin-top: 10px; padding: 8px; background: #000; border-radius: 6px; font-size: 11px; color: #aaa; max-height: 90px; overflow-y: auto; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;");
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
      lsSet(K_CURRENT_PROMPT, "");
      log("Cleared prompt editor.");
    };

    saveBtn.onclick = () => {
      const text = String(promptArea.value || "").trim();
      if (!text) {
        log("Nothing to save (prompt is empty).");
        return;
      }

      let idx = parseInt(select.value, 10);
      // Update existing selection
      if (Number.isFinite(idx) && idx >= 0 && idx < prompts.length) {
        prompts[idx] = text;
        log("Updated saved prompt #" + (idx + 1) + ".");
      } else {
        // Add new (avoid exact duplicates)
        const dup = prompts.findIndex((p) => p === text);
        if (dup >= 0) {
          idx = dup;
          log("Already saved as #" + (dup + 1) + ". Selected it.");
        } else {
          prompts.push(text);
          idx = prompts.length - 1;
          log("Saved new prompt #" + (idx + 1) + ".");
        }
      }

      saveJson(K_PROMPTS, prompts);
      refreshSelect(select, prompts);
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
      saveJson(K_PROMPTS, prompts);
      refreshSelect(select, prompts);
      select.value = "-1";
      lsSet(K_SELECTED, "-1");
      log("Deleted saved prompt.");
    };


    actions.appendChild(newBtn);
    actions.appendChild(saveBtn);
    actions.appendChild(delBtn);
    contentWrap.appendChild(actions);
    contentWrap.appendChild(status);

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

            // Only target video generation requests
            if (!body.toolOverrides || !body.toolOverrides.videoGen) {
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
            if (len) {
                const val = parseInt(len);
                if (!isNaN(val)) {
                    log(`Overriding Length: ${config.videoLength} -> ${val}`);
                    config.videoLength = val;
                }
            }

            // 4. Prompt
            const rawPrompt = document.getElementById("exp-prompt")?.value ?? "";
            const promptSanitized = rawPrompt.trim();

            if (promptSanitized) {
              const request_message = String(body.message || "");
              if (request_message.includes("--mode=normal")) {
                body.message = request_message.replace(
                  "--mode=normal",
                  `${promptSanitized} --mode=custom`
                );
              }
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

        if (url && url.includes('/rest/app-chat/conversations/new') && init && init.method === 'POST' && init.body) {
            const newBody = modifyPayload(init.body);
            init.body = newBody;
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
