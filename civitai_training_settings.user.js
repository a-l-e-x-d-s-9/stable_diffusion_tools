// ==UserScript==
// @name         Civitai Training Settings Saver
// @namespace    https://github.com/a-l-e-x-d-s-9
// @version      1.1.0
// @description  Auto-save Civitai training settings as JSON by model name, with copy/delete/use UI.
// @author       Alex
// @match        https://civitai.com/models/train*
// @match        https://civitai.red/models/train*
// @match        https://civitai.green/models/train*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_setClipboard
// @grant        GM_registerMenuCommand
// @run-at       document-idle
// ==/UserScript==

(() => {
  "use strict";

  const STORAGE_KEY = "aixfun_civitai_training_settings_by_model_v1";
  const PANEL_ID = "aixfun-training-settings-saver-panel";
  const SAVE_DEBOUNCE_MS = 700;

  let saveTimer = null;
  let renderTimer = null;
  let lastSavedHash = "";
  let panelOpen = true;
  let applyingSavedSettings = false;

  const css = `
    #${PANEL_ID} {
      position: fixed;
      top: 88px;
      right: 14px;
      width: 360px;
      max-height: 76vh;
      z-index: 999999;
      background: #181a20;
      color: #e7e7e7;
      border: 1px solid #3b4252;
      border-radius: 10px;
      box-shadow: 0 8px 28px rgba(0,0,0,0.45);
      font-family: Arial, sans-serif;
      font-size: 13px;
      overflow: hidden;
    }

    #${PANEL_ID} * {
      box-sizing: border-box;
    }

    #${PANEL_ID} .aix-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding: 9px 10px;
      background: #202735;
      border-bottom: 1px solid #3b4252;
      font-weight: 700;
    }

    #${PANEL_ID} .aix-head-title {
      display: flex;
      align-items: center;
      gap: 7px;
      min-width: 0;
    }

    #${PANEL_ID} .aix-dot {
      width: 10px;
      height: 10px;
      border-radius: 99px;
      background: #ffd84d;
      box-shadow: 0 0 8px rgba(255,216,77,0.6);
      flex: 0 0 auto;
    }

    #${PANEL_ID} .aix-body {
      padding: 10px;
      overflow: auto;
      max-height: calc(76vh - 42px);
      display: ${panelOpen ? "block" : "none"};
    }

    #${PANEL_ID} .aix-row {
      margin-bottom: 8px;
    }

    #${PANEL_ID} .aix-muted {
      color: #aeb7c5;
      font-size: 12px;
      line-height: 1.35;
    }

    #${PANEL_ID} .aix-current {
      padding: 8px;
      border: 1px solid #344155;
      border-radius: 8px;
      background: #11151d;
      margin-bottom: 10px;
      word-break: break-word;
    }

    #${PANEL_ID} .aix-current-name {
      color: #fff2a8;
      font-weight: 700;
      margin-bottom: 4px;
    }

    #${PANEL_ID} button {
      appearance: none;
      border: 1px solid #4b5568;
      border-radius: 7px;
      background: #263244;
      color: #f0f0f0;
      padding: 6px 8px;
      cursor: pointer;
      font-size: 12px;
      line-height: 1;
    }

    #${PANEL_ID} button:hover {
      background: #33435a;
    }

    #${PANEL_ID} button.aix-primary {
      background: #0b70c9;
      border-color: #238ae6;
    }

    #${PANEL_ID} button.aix-use {
      background: #256d3b;
      border-color: #35a85a;
    }

    #${PANEL_ID} button.aix-warn {
      background: #672626;
      border-color: #974141;
    }

    #${PANEL_ID} button.aix-small {
      padding: 5px 7px;
      font-size: 11px;
    }

    #${PANEL_ID} .aix-buttons {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-bottom: 10px;
    }

    #${PANEL_ID} .aix-list {
      display: flex;
      flex-direction: column;
      gap: 7px;
    }

    #${PANEL_ID} .aix-item {
      border: 1px solid #344155;
      border-radius: 8px;
      background: #11151d;
      padding: 8px;
    }

    #${PANEL_ID} .aix-item-name {
      font-weight: 700;
      color: #ffffff;
      word-break: break-word;
      margin-bottom: 4px;
    }

    #${PANEL_ID} .aix-item-meta {
      color: #aeb7c5;
      font-size: 11px;
      margin-bottom: 7px;
    }

    #${PANEL_ID} .aix-item-actions {
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
    }

    #${PANEL_ID} .aix-toggle {
      background: transparent;
      border: 0;
      color: #d9e4f5;
      padding: 3px 6px;
      font-size: 15px;
    }

    .aix-training-toast {
      position: fixed;
      top: 16px;
      left: 16px;
      z-index: 1000000;
      background: #ffe36e;
      color: #151515;
      border: 1px solid #b99700;
      border-radius: 8px;
      padding: 9px 12px;
      font-family: Arial, sans-serif;
      font-size: 13px;
      font-weight: 700;
      box-shadow: 0 6px 18px rgba(0,0,0,0.35);
    }
  `;

  function injectStyle() {
    if (document.getElementById("aix-training-settings-saver-style")) return;

    const style = document.createElement("style");
    style.id = "aix-training-settings-saver-style";
    style.textContent = css;
    document.head.appendChild(style);
  }

  function toast(message) {
    const old = document.querySelector(".aix-training-toast");
    if (old) old.remove();

    const el = document.createElement("div");
    el.className = "aix-training-toast";
    el.textContent = message;
    document.body.appendChild(el);

    setTimeout(() => el.remove(), 1800);
  }

  function loadStore() {
    const raw = GM_getValue(STORAGE_KEY, "{}");
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }

  function saveStore(store) {
    GM_setValue(STORAGE_KEY, JSON.stringify(store, null, 2));
  }

  function cleanText(text) {
    return String(text || "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function normalizeKey(text) {
    return cleanText(text).toLowerCase();
  }

  function safeKey(text) {
    return cleanText(text) || "Unknown Model";
  }

  function getAccordionPanelByTitle(titleText) {
    const wanted = normalizeKey(titleText);
    const controls = Array.from(document.querySelectorAll("[data-accordion-control='true'], .mantine-Accordion-control"));

    for (const control of controls) {
      const label = control.querySelector(".mantine-Accordion-label") || control;
      const text = normalizeKey(label.textContent);
      if (!text.includes(wanted)) continue;

      const item = control.closest(".mantine-Accordion-item") || control.parentElement;
      if (!item) continue;

      return item.querySelector(".mantine-Accordion-panel") || item;
    }

    return null;
  }

  function readTableFromPanel(panel) {
    const data = {};
    if (!panel) return data;

    const rows = Array.from(panel.querySelectorAll("table tbody tr"));
    for (const row of rows) {
      const cells = Array.from(row.querySelectorAll("td"));
      if (cells.length < 2) continue;

      const key = cleanText(cells[0].textContent);
      if (!key) continue;

      const valueCell = cells[1];
      const checkbox = valueCell.querySelector("input[type='checkbox']");
      const input = valueCell.querySelector("input:not([type='hidden']):not([type='checkbox'])");
      const hidden = valueCell.querySelector("input[type='hidden']");
      const textarea = valueCell.querySelector("textarea");
      const select = valueCell.querySelector("select");

      let value;

      if (checkbox) {
        value = !!checkbox.checked;
      } else if (textarea) {
        value = textarea.value;
      } else if (select) {
        value = select.value;
      } else if (input) {
        value = input.value;
      } else if (hidden) {
        value = hidden.value;
      } else {
        value = cleanText(valueCell.textContent);
      }

      data[key] = value;
    }

    return data;
  }

  function getModelDetails() {
    const panel = getAccordionPanelByTitle("Model Details");
    return readTableFromPanel(panel);
  }

  function getSamplePrompts() {
    const panel = getAccordionPanelByTitle("Sample Media Prompts");
    const prompts = {};
    if (!panel) return prompts;

    const wrappers = Array.from(panel.querySelectorAll(".mantine-InputWrapper-root, .mantine-TextInput-root"));
    for (const wrapper of wrappers) {
      const label = wrapper.querySelector("label");
      const input = wrapper.querySelector("input, textarea");
      if (!label || !input) continue;

      const key = cleanText(label.textContent).replace(/\s+\*$/, "");
      if (!key) continue;

      prompts[key] = input.value || "";
    }

    return prompts;
  }

  function getTrainingParameters() {
    const panel = getAccordionPanelByTitle("Training Parameters");
    return readTableFromPanel(panel);
  }

  function getSelectedTrainingModel() {
    const result = {
      family: "",
      presetLabel: "",
      presetValue: "",
      description: "",
    };

    const checked = document.querySelector(
      "input.mantine-SegmentedControl-input[type='radio']:checked, input[type='radio']:checked"
    );

    if (!checked) return result;

    result.presetValue = checked.value || "";

    const control = checked.closest(".mantine-SegmentedControl-control") || checked.closest("div");
    const label = control ? control.querySelector("label") : document.querySelector(`label[for="${checked.id}"]`);

    if (label) {
      result.presetLabel = cleanText(label.textContent).replace(/\bNEW\b$/i, "").trim();
    }

    const group = checked.closest(".mantine-Group-root");
    if (group) {
      const largerGroup = group.parentElement ? group.parentElement.closest(".mantine-Group-root") : null;
      const searchRoot = largerGroup || group;
      const badges = Array.from(searchRoot.querySelectorAll(".mantine-Badge-label")).map((x) => cleanText(x.textContent));
      const family = badges.find((x) => x && !/^new$/i.test(x) && x !== result.presetLabel);
      result.family = family || "";
    }

    const card = checked.closest(".mantine-Card-root") || checked.closest("[data-with-border='true']");
    if (card) {
      const paragraphs = Array.from(card.querySelectorAll("p"))
        .map((p) => cleanText(p.textContent))
        .filter(Boolean);

      const description = paragraphs.find((text) => {
        const lower = text.toLowerCase();
        return !lower.includes("ai-toolkit is now") &&
          !lower.includes("note:") &&
          text !== result.presetLabel &&
          text !== result.family;
      });

      result.description = description || "";
    }

    return result;
  }

  function getPageSnapshot() {
    const modelDetails = getModelDetails();
    const modelName = safeKey(modelDetails.Name || modelDetails.name || "");

    return {
      schema: "aixfun.civitai.training-settings.v1",
      savedAt: new Date().toISOString(),
      page: {
        url: location.href,
        modelId: new URLSearchParams(location.search).get("modelId") || "",
        step: new URLSearchParams(location.search).get("step") || "",
        host: location.host,
      },
      modelName,
      modelDetails,
      selectedTrainingModel: getSelectedTrainingModel(),
      sampleMediaPrompts: getSamplePrompts(),
      trainingParameters: getTrainingParameters(),
    };
  }

  function stableHash(obj) {
    return JSON.stringify(obj);
  }

  function saveCurrentSnapshot({ silent = true } = {}) {
    if (applyingSavedSettings) return false;

    const snapshot = getPageSnapshot();

    if (!snapshot.modelName || snapshot.modelName === "Unknown Model") {
      return false;
    }

    const comparable = {
      modelDetails: snapshot.modelDetails,
      selectedTrainingModel: snapshot.selectedTrainingModel,
      sampleMediaPrompts: snapshot.sampleMediaPrompts,
      trainingParameters: snapshot.trainingParameters,
      pageModelId: snapshot.page.modelId,
    };

    const hash = stableHash(comparable);
    if (hash === lastSavedHash) return false;

    const store = loadStore();
    store[snapshot.modelName] = snapshot;
    saveStore(store);

    lastSavedHash = hash;

    if (!silent) {
      toast("Training settings saved");
    }

    scheduleRender();
    return true;
  }

  function debounceSave() {
    if (applyingSavedSettings) return;

    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveCurrentSnapshot({ silent: true });
    }, SAVE_DEBOUNCE_MS);
  }

  function scheduleRender() {
    clearTimeout(renderTimer);
    renderTimer = setTimeout(renderPanel, 250);
  }

  function copyText(text, label) {
    GM_setClipboard(text, "text");
    toast(label || "Copied");
  }

  function copyCurrent() {
    const snapshot = getPageSnapshot();
    copyText(JSON.stringify(snapshot, null, 2), "Current settings copied");
  }

  function copySaved(modelName) {
    const store = loadStore();
    if (!store[modelName]) {
      toast("Saved settings not found");
      return;
    }

    copyText(JSON.stringify(store[modelName], null, 2), "Saved settings copied");
  }

  function copyAll() {
    const store = loadStore();
    copyText(JSON.stringify(store, null, 2), "All saved settings copied");
  }

  function deleteSaved(modelName) {
    if (!confirm(`Delete saved training settings for:\n\n${modelName}`)) return;

    const store = loadStore();
    delete store[modelName];
    saveStore(store);
    toast("Saved settings deleted");
    renderPanel();
  }

  function deleteAllSaved() {
    if (!confirm("Delete all saved Civitai training settings?")) return;

    saveStore({});
    toast("All saved settings deleted");
    renderPanel();
  }

  function isEditableField(el) {
    if (!el) return false;
    if (el.disabled) return false;
    if (el.readOnly) return false;
    if (el.getAttribute("aria-readonly") === "true") return false;
    if (el.closest("[data-disabled='true']")) return false;
    return true;
  }

  function fireFieldEvents(el) {
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));
    el.dispatchEvent(new Event("blur", { bubbles: true }));
  }

  function setNativeValue(el, value) {
    const prototype = el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;

    const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");

    if (descriptor && descriptor.set) {
      descriptor.set.call(el, String(value));
    } else {
      el.value = String(value);
    }

    fireFieldEvents(el);
  }

  function setNativeChecked(el, checked) {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "checked");

    if (descriptor && descriptor.set) {
      descriptor.set.call(el, !!checked);
    } else {
      el.checked = !!checked;
    }

    fireFieldEvents(el);
  }

  function applyRadioByValue(value) {
    if (!value) return false;

    const radio = Array.from(document.querySelectorAll("input[type='radio']")).find((el) => el.value === value);
    if (!radio || radio.disabled || radio.checked) return false;

    radio.click();
    setNativeChecked(radio, true);
    return true;
  }

  function applySamplePrompts(savedPrompts) {
    const panel = getAccordionPanelByTitle("Sample Media Prompts");
    if (!panel || !savedPrompts) return 0;

    let count = 0;
    const wrappers = Array.from(panel.querySelectorAll(".mantine-InputWrapper-root, .mantine-TextInput-root"));

    for (const wrapper of wrappers) {
      const label = wrapper.querySelector("label");
      const input = wrapper.querySelector("input, textarea");
      if (!label || !input || !isEditableField(input)) continue;

      const key = cleanText(label.textContent).replace(/\s+\*$/, "");
      if (!Object.prototype.hasOwnProperty.call(savedPrompts, key)) continue;

      setNativeValue(input, savedPrompts[key]);
      count += 1;
    }

    return count;
  }

  function applyTrainingParameters(savedParams) {
    const panel = getAccordionPanelByTitle("Training Parameters");
    if (!panel || !savedParams) return 0;

    let count = 0;
    const rows = Array.from(panel.querySelectorAll("table tbody tr"));

    for (const row of rows) {
      const cells = Array.from(row.querySelectorAll("td"));
      if (cells.length < 2) continue;

      const key = cleanText(cells[0].textContent);
      if (!key || !Object.prototype.hasOwnProperty.call(savedParams, key)) continue;

      const valueCell = cells[1];
      const savedValue = savedParams[key];

      const checkbox = valueCell.querySelector("input[type='checkbox']");
      const input = valueCell.querySelector("input:not([type='hidden']):not([type='checkbox'])");
      const textarea = valueCell.querySelector("textarea");
      const select = valueCell.querySelector("select");

      if (checkbox) {
        if (!isEditableField(checkbox)) continue;
        setNativeChecked(checkbox, !!savedValue);
        count += 1;
        continue;
      }

      if (textarea) {
        if (!isEditableField(textarea)) continue;
        setNativeValue(textarea, savedValue);
        count += 1;
        continue;
      }

      if (select) {
        if (!isEditableField(select)) continue;
        select.value = String(savedValue);
        fireFieldEvents(select);
        count += 1;
        continue;
      }

      if (input) {
        if (!isEditableField(input)) continue;
        setNativeValue(input, savedValue);
        count += 1;
      }
    }

    return count;
  }

  function useSaved(modelName) {
    const store = loadStore();
    const saved = store[modelName];

    if (!saved) {
      toast("Saved settings not found");
      return;
    }

    const current = getPageSnapshot();
    const currentName = current.modelName || "Unknown Model";

    const ok = confirm(
      `Apply saved training settings?\n\n` +
      `From saved record:\n${modelName}\n\n` +
      `To current page model:\n${currentName}\n\n` +
      `Only editable fields will be changed. Disabled/read-only fields will be skipped.`
    );

    if (!ok) return;

    applyingSavedSettings = true;

    let changed = 0;

    try {
      if (saved.selectedTrainingModel && saved.selectedTrainingModel.presetValue) {
        if (applyRadioByValue(saved.selectedTrainingModel.presetValue)) {
          changed += 1;
        }
      }

      changed += applySamplePrompts(saved.sampleMediaPrompts || {});
      changed += applyTrainingParameters(saved.trainingParameters || {});
    } finally {
      setTimeout(() => {
        applyingSavedSettings = false;
        lastSavedHash = "";
        saveCurrentSnapshot({ silent: true });
        renderPanel();
      }, 900);
    }

    toast(`Applied saved settings: ${changed} field(s)`);
  }

  function formatMeta(entry) {
    const parts = [];

    if (entry.selectedTrainingModel) {
      const family = entry.selectedTrainingModel.family || "";
      const preset = entry.selectedTrainingModel.presetLabel || entry.selectedTrainingModel.presetValue || "";
      const combo = cleanText(`${family} ${preset}`);
      if (combo) parts.push(combo);
    }

    if (entry.savedAt) {
      parts.push(new Date(entry.savedAt).toLocaleString());
    }

    return parts.join(" | ");
  }

  function renderPanel() {
    injectStyle();

    let panel = document.getElementById(PANEL_ID);
    if (!panel) {
      panel = document.createElement("div");
      panel.id = PANEL_ID;
      document.body.appendChild(panel);
    }

    const current = getPageSnapshot();
    const store = loadStore();
    const entries = Object.entries(store).sort((a, b) => {
      const ad = a[1]?.savedAt || "";
      const bd = b[1]?.savedAt || "";
      return bd.localeCompare(ad);
    });

    const currentName = current.modelName || "Unknown Model";
    const selected = current.selectedTrainingModel || {};
    const currentModelText = cleanText(`${selected.family || ""} ${selected.presetLabel || selected.presetValue || ""}`) || "Not detected";

    panel.innerHTML = `
      <div class="aix-head">
        <div class="aix-head-title">
          <span class="aix-dot"></span>
          <span>Training Settings Saver</span>
        </div>
        <button class="aix-toggle" data-aix-action="toggle">${panelOpen ? "-" : "+"}</button>
      </div>

      <div class="aix-body">
        <div class="aix-current">
          <div class="aix-current-name">${escapeHtml(currentName)}</div>
          <div class="aix-muted">Selected: ${escapeHtml(currentModelText)}</div>
          <div class="aix-muted">Saved records: ${entries.length}</div>
        </div>

        <div class="aix-buttons">
          <button class="aix-primary" data-aix-action="save-now">Save now</button>
          <button data-aix-action="copy-current">Copy current JSON</button>
          <button data-aix-action="copy-all">Copy all JSON</button>
          <button class="aix-warn" data-aix-action="delete-all">Delete all</button>
        </div>

        <div class="aix-row aix-muted">
          Auto-saves after changes. Use applies old saved values into editable fields only.
        </div>

        <div class="aix-list">
          ${entries.map(([name, entry]) => `
            <div class="aix-item">
              <div class="aix-item-name">${escapeHtml(name)}</div>
              <div class="aix-item-meta">${escapeHtml(formatMeta(entry))}</div>
              <div class="aix-item-actions">
                <button class="aix-small aix-use" data-aix-action="use-saved" data-model-name="${escapeAttr(name)}">Use</button>
                <button class="aix-small" data-aix-action="copy-saved" data-model-name="${escapeAttr(name)}">Copy</button>
                <button class="aix-small aix-warn" data-aix-action="delete-saved" data-model-name="${escapeAttr(name)}">Delete</button>
              </div>
            </div>
          `).join("")}
        </div>
      </div>
    `;

    panel.onclick = (event) => {
      const button = event.target.closest("button[data-aix-action]");
      if (!button) return;

      const action = button.getAttribute("data-aix-action");
      const modelName = button.getAttribute("data-model-name");

      if (action === "toggle") {
        panelOpen = !panelOpen;
        renderPanel();
      } else if (action === "save-now") {
        lastSavedHash = "";
        saveCurrentSnapshot({ silent: false });
      } else if (action === "copy-current") {
        copyCurrent();
      } else if (action === "copy-all") {
        copyAll();
      } else if (action === "copy-saved") {
        copySaved(modelName);
      } else if (action === "use-saved") {
        useSaved(modelName);
      } else if (action === "delete-saved") {
        deleteSaved(modelName);
      } else if (action === "delete-all") {
        deleteAllSaved();
      }
    };
  }

  function escapeHtml(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function escapeAttr(value) {
    return escapeHtml(value);
  }

  function installWatchers() {
    document.addEventListener("input", debounceSave, true);
    document.addEventListener("change", debounceSave, true);
    document.addEventListener("click", () => {
      setTimeout(debounceSave, 150);
    }, true);

    const observer = new MutationObserver(() => {
      if (applyingSavedSettings) return;
      debounceSave();
      scheduleRender();
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["checked", "value", "data-active", "aria-expanded", "disabled"],
    });
  }

  function installMenuCommands() {
    GM_registerMenuCommand("Copy current Civitai training settings JSON", copyCurrent);
    GM_registerMenuCommand("Copy all saved Civitai training settings JSON", copyAll);
    GM_registerMenuCommand("Save current Civitai training settings now", () => {
      lastSavedHash = "";
      saveCurrentSnapshot({ silent: false });
    });
  }

  function init() {
    injectStyle();
    installMenuCommands();
    renderPanel();
    installWatchers();

    setTimeout(() => {
      lastSavedHash = "";
      saveCurrentSnapshot({ silent: true });
      renderPanel();
    }, 1200);
  }

  init();
})();