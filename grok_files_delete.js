// ==UserScript==
// @name         Grok Files - Bulk Delete (Fast, Robust)
// @namespace    aixfun
// @version      0.7.0
// @description  Adds a small control panel and bulk-deletes items on https://grok.com/files
// @match        https://grok.com/files*
// @run-at       document-start
// @grant        GM_addStyle
// ==/UserScript==

(() => {
  "use strict";

  // -----------------------------
  // Config (tweak if needed)
  // -----------------------------
  const CFG = {
    stepDelayMs: 20,
    dialogWaitMs: 2500,
    deleteWaitMs: 50,
    maxRetriesPerFile: 2,
    scrollIdlePassesToStop: 4, // how many "no new rows" passes before stopping
    autoReloadEvery: 0,        // set to e.g. 80 to reload after N deletions (0 disables)
  };

  // -----------------------------
  // State
  // -----------------------------
  const S = {
    running: false,
    stopRequested: false,
    dryRun: true,
    processed: new Set(),      // fileIds attempted
    deletedOk: new Set(),      // fileIds we saw success for
    countTried: 0,
    countDeleted: 0,
    countSkipped: 0,
    lastStatus: "",
    lastDeleteSignals: new Map(), // fileId -> { ok, ts, url, status }
    deletionsSinceReload: 0,
  };

  // -----------------------------
  // Helpers
  // -----------------------------
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const now = () => new Date().toISOString().replace("T", " ").replace("Z", "");

  const log = (...a) => console.log("[GrokBulkDelete]", ...a);

  function setStatus(msg) {
    S.lastStatus = msg;
    const el = document.getElementById("gbd_status");
    if (el) el.textContent = msg;
  }

  function extractFileIdFromHref(href) {
    if (!href) return null;
    const m = String(href).match(/[?&]file=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
    return m ? m[1] : null;
  }

  function isElementInDOM(el) {
    return !!(el && el.ownerDocument && el.ownerDocument.contains(el));
  }

  function makeClickable(btn) {
    if (!btn) return;
    // Tailwind "hidden" is display:none. Remove it and force display.
    btn.classList.remove("hidden");
    btn.style.display = "inline-flex";
    btn.style.visibility = "visible";
    btn.style.opacity = "1";
    btn.style.pointerEvents = "auto";
    btn.style.width = "auto";
  }

  function getFileRows() {
    // Each row has an <a href="/files?file=UUID&sort=size"> inside an <li>
    const anchors = Array.from(document.querySelectorAll('a[href^="/files?file="]'));
    const rows = [];

    for (const a of anchors) {
      const fileId = extractFileIdFromHref(a.getAttribute("href"));
      if (!fileId) continue;
      const li = a.closest("li") || a;
      rows.push({ fileId, a, li });
    }

    // De-dup by fileId (in case UI duplicates anchors)
    const seen = new Set();
    return rows.filter((r) => (seen.has(r.fileId) ? false : (seen.add(r.fileId), true)));
  }

  function findDeleteButton(row) {
    // Provided snippet: button[aria-label="Delete file"] exists but is hidden until hover.
    const btn = row.li.querySelector('button[aria-label="Delete file"]')
             || row.a.querySelector('button[aria-label="Delete file"]');
    return btn || null;
  }

  function findOpenDialog() {
    // Radix often uses portals. Try a few common selectors.
    const candidates = [
      ...document.querySelectorAll('[role="alertdialog"]'),
      ...document.querySelectorAll('[role="dialog"]'),
      ...document.querySelectorAll("[data-state='open'] [role='dialog']"),
      ...document.querySelectorAll("[data-state='open'][role='dialog']"),
    ];

    // Choose last visible-ish one
    for (let i = candidates.length - 1; i >= 0; i--) {
      const d = candidates[i];
      const style = window.getComputedStyle(d);
      if (style && style.display !== "none" && style.visibility !== "hidden" && d.offsetParent !== null) {
        return d;
      }
    }

    // If offsetParent is null for portals, still try last one
    return candidates.length ? candidates[candidates.length - 1] : null;
  }

    function findConfirmButton(dialog) {
        if (!dialog) return null;

        // Prefer aria-label when there is no visible text
        const aria =
              dialog.querySelector('button[aria-label="Delete"]') ||
              dialog.querySelector('button[aria-label*="Delete"]') ||
              dialog.querySelector('button[aria-label*="Confirm"]');
        if (aria) return aria;

        const buttons = Array.from(dialog.querySelectorAll("button"));
        const text = (b) => (b.innerText || b.textContent || "").trim().toLowerCase();

        return buttons.find((b) => {
            const t = text(b);
            if (!t) return false;
            if (/cancel|keep|close|no/.test(t)) return false;
            return /delete|confirm|yes|ok/.test(t);
        }) || null;
    }


  async function waitForDialog(timeoutMs) {
    const t0 = performance.now();
    while (performance.now() - t0 < timeoutMs) {
      const d = findOpenDialog();
      if (d) return d;
      await sleep(60);
    }
    return null;
  }

  async function waitForDeleteSignal(fileId, timeoutMs) {
    const t0 = performance.now();
    while (performance.now() - t0 < timeoutMs) {
      const sig = S.lastDeleteSignals.get(fileId);
      if (sig && sig.ok) return sig;
      await sleep(80);
    }
    return null;
  }

  async function waitRowGone(row, timeoutMs) {
    const t0 = performance.now();
    while (performance.now() - t0 < timeoutMs) {
      if (!isElementInDOM(row.li)) return true;
      await sleep(80);
    }
    return false;
  }

    async function waitForInlineConfirmButton(row, timeoutMs) {
        const t0 = performance.now();
        while (performance.now() - t0 < timeoutMs) {
            // After clicking the trash icon, Grok shows an inline check button:
            // <button aria-label="Delete"> (check icon)
            const btn =
                  row.li.querySelector('button[aria-label="Delete"]') ||
                  row.li.querySelector('button[aria-label*="Delete"]');

            if (btn) return btn;
            await sleep(50);
        }
        return null;
    }

  function markRowVisually(row, kind) {
    if (!row || !row.li) return;
    if (kind === "deleting") {
      row.li.style.opacity = "0.55";
      row.li.style.filter = "grayscale(0.6)";
    } else if (kind === "deleted") {
      row.li.style.opacity = "0.25";
      row.li.style.textDecoration = "line-through";
    } else if (kind === "skipped") {
      row.li.style.opacity = "0.65";
      row.li.style.outline = "1px solid rgba(255, 180, 0, 0.7)";
      row.li.style.outlineOffset = "2px";
    }
  }

  // -----------------------------
  // Network interception (best-effort)
  // -----------------------------
  function captureUuidFromUrl(url) {
    const m = String(url).match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
    return m ? m[1] : null;
  }

  function patchFetch() {
    const orig = window.fetch;
    if (typeof orig !== "function") return;

    window.fetch = async function(input, init) {
      const url = (typeof input === "string") ? input : (input && input.url) || "";
      const method = (init && init.method) ? String(init.method).toUpperCase() : "GET";

      let res;
      try {
        res = await orig.apply(this, arguments);
      } catch (e) {
        throw e;
      } finally {
        // nothing
      }

      try {
        const uuid = captureUuidFromUrl(url);
        if (uuid && (method === "DELETE" || /\/files\b/i.test(url))) {
          S.lastDeleteSignals.set(uuid, {
            ok: !!res && res.ok,
            ts: Date.now(),
            url,
            status: res ? res.status : 0,
          });
        }
      } catch (e) {
        // ignore
      }

      return res;
    };
  }

  function patchXHR() {
    const X = window.XMLHttpRequest;
    if (!X) return;

    const origOpen = X.prototype.open;
    const origSend = X.prototype.send;

    X.prototype.open = function(method, url) {
      this.__gbd_method = method ? String(method).toUpperCase() : "GET";
      this.__gbd_url = url || "";
      return origOpen.apply(this, arguments);
    };

    X.prototype.send = function() {
      this.addEventListener("loadend", () => {
        try {
          const url = this.__gbd_url || "";
          const method = this.__gbd_method || "GET";
          const uuid = captureUuidFromUrl(url);
          if (uuid && (method === "DELETE" || /\/files\b/i.test(url))) {
            const ok = this.status >= 200 && this.status < 300;
            S.lastDeleteSignals.set(uuid, {
              ok,
              ts: Date.now(),
              url,
              status: this.status,
            });
          }
        } catch (e) {
          // ignore
        }
      });
      return origSend.apply(this, arguments);
    };
  }

  patchFetch();
  patchXHR();

  // -----------------------------
  // Core delete logic
  // -----------------------------
async function deleteOne(row) {
  if (!row || !row.fileId) return false;

  const fileId = row.fileId;

  if (S.processed.has(fileId)) return false;

  S.processed.add(fileId);
  S.countTried += 1;

  setStatus(`${now()} - Target: ${fileId} (dryRun=${S.dryRun})`);
  markRowVisually(row, "deleting");

  if (S.dryRun) {
    await sleep(CFG.stepDelayMs);
    markRowVisually(row, "skipped");
    S.countSkipped += 1;
    return true;
  }

  for (let attempt = 1; attempt <= CFG.maxRetriesPerFile; attempt++) {
    if (!S.running || S.stopRequested) return false;

    setStatus(`${now()} - Deleting ${fileId} (attempt ${attempt}/${CFG.maxRetriesPerFile})`);

    // 1) Click row delete button (trash)
    const delBtn = findDeleteButton(row);
    if (!delBtn) {
      setStatus(`${now()} - Could not find delete button for ${fileId}, skipping`);
      markRowVisually(row, "skipped");
      S.countSkipped += 1;
      return true;
    }

    makeClickable(delBtn);
    await sleep(30);
    delBtn.click();
    await sleep(CFG.stepDelayMs);

    // 2) Confirm delete: inline check button first, dialog fallback
    const inlineConfirm = await waitForInlineConfirmButton(row, 2000);
    if (inlineConfirm) {
      makeClickable(inlineConfirm);
      await sleep(30);
      inlineConfirm.click();
      await sleep(CFG.stepDelayMs);
    } else {
      const dialog = await waitForDialog(CFG.dialogWaitMs);
      if (!dialog) {
        setStatus(`${now()} - No confirm UI for ${fileId} (attempt ${attempt}), retrying`);
        await sleep(CFG.stepDelayMs);
        continue;
      }

      const confirmBtn = findConfirmButton(dialog);
      if (!confirmBtn) {
        setStatus(`${now()} - Could not find confirm button for ${fileId} (attempt ${attempt}), retrying`);
        await sleep(CFG.stepDelayMs);
        continue;
      }

      confirmBtn.click();
      await sleep(CFG.stepDelayMs);
    }

    // 3) Wait for delete to land (network signal OR row disappears)
    const sig = await waitForDeleteSignal(fileId, CFG.deleteWaitMs);
    if (sig && sig.ok) {
      S.deletedOk.add(fileId);
      S.countDeleted += 1;
      S.deletionsSinceReload += 1;
      markRowVisually(row, "deleted");

      const gone = await waitRowGone(row, 1200);
      if (!gone && isElementInDOM(row.li)) row.li.remove();

      setStatus(`${now()} - Deleted OK ${fileId} (status ${sig.status})`);
      return true;
    }

    const gone = await waitRowGone(row, 1800);
    if (gone) {
      S.deletedOk.add(fileId);
      S.countDeleted += 1;
      S.deletionsSinceReload += 1;
      setStatus(`${now()} - Deleted (row disappeared) ${fileId}`);
      return true;
    }

    setStatus(`${now()} - Delete uncertain for ${fileId} (attempt ${attempt}), retrying`);
    await sleep(CFG.stepDelayMs);
  }

  markRowVisually(row, "skipped");
  S.countSkipped += 1;
  setStatus(`${now()} - Skipped after retries ${fileId}`);
  return true;
}


  async function scrollToLoadMore() {
    const before = document.body.scrollHeight;
    window.scrollTo(0, document.body.scrollHeight);
    await sleep(700);
    const after = document.body.scrollHeight;
    return after > before;
  }

  async function mainLoop() {
    let idlePasses = 0;

    while (S.running && !S.stopRequested) {
      // Optional auto-reload to re-sync list state
      if (CFG.autoReloadEvery > 0 && S.deletionsSinceReload >= CFG.autoReloadEvery) {
        setStatus(`${now()} - Auto reload after ${S.deletionsSinceReload} deletions`);
        await sleep(400);
        location.reload();
        return;
      }

      const rows = getFileRows().filter((r) => !S.processed.has(r.fileId));
      if (!rows.length) {
        const grew = await scrollToLoadMore();
        idlePasses += 1;

        setStatus(`${now()} - No new rows (idle ${idlePasses}/${CFG.scrollIdlePassesToStop})`);
        if (!grew && idlePasses >= CFG.scrollIdlePassesToStop) break;

        await sleep(350);
        continue;
      }

      idlePasses = 0;

        // Delete all currently visible rows (faster than 1-per-pass)
        for (const r of rows) {
          if (!S.running || S.stopRequested) break;
          await deleteOne(r);
          await sleep(CFG.stepDelayMs);
          updateCounters();
        }

    }

    S.running = false;
    S.stopRequested = false;
    updateButtons();
    setStatus(`${now()} - Stopped. tried=${S.countTried}, deleted=${S.countDeleted}, skipped=${S.countSkipped}`);
  }

  // -----------------------------
  // UI
  // -----------------------------
  function updateCounters() {
    const el = document.getElementById("gbd_counts");
    if (!el) return;
    el.textContent = `tried: ${S.countTried} | deleted: ${S.countDeleted} | skipped: ${S.countSkipped} | dryRun: ${S.dryRun}`;
  }

  function updateButtons() {
    const start = document.getElementById("gbd_start");
    const stop = document.getElementById("gbd_stop");
    if (start) start.disabled = S.running;
    if (stop) stop.disabled = !S.running;
  }

  function injectUI() {
    if (document.getElementById("gbd_panel")) return;

    GM_addStyle(`
      #gbd_panel {
        position: fixed;
        top: 12px;
        right: 12px;
        z-index: 999999;
        width: 320px;
        background: rgba(15,15,18,0.92);
        color: #fff;
        border: 1px solid rgba(255,255,255,0.12);
        border-radius: 12px;
        padding: 10px 10px 8px 10px;
        font: 12px/1.25 system-ui, -apple-system, Segoe UI, Roboto, Ubuntu, Cantarell, Arial, sans-serif;
        box-shadow: 0 10px 30px rgba(0,0,0,0.35);
      }
      #gbd_panel button {
        cursor: pointer;
        border-radius: 10px;
        border: 1px solid rgba(255,255,255,0.14);
        background: rgba(255,255,255,0.08);
        color: #fff;
        padding: 6px 10px;
        font-weight: 600;
      }
      #gbd_panel button:disabled { opacity: 0.5; cursor: not-allowed; }
      #gbd_panel .row { display:flex; gap:8px; align-items:center; margin-top:8px; }
      #gbd_panel .muted { color: rgba(255,255,255,0.72); font-weight: 500; }
      #gbd_panel input[type="checkbox"] { transform: translateY(1px); }
      #gbd_panel .status {
        margin-top: 8px;
        padding: 6px 8px;
        background: rgba(0,0,0,0.25);
        border-radius: 10px;
        border: 1px solid rgba(255,255,255,0.10);
        max-height: 72px;
        overflow: auto;
        white-space: pre-wrap;
      }
      #gbd_panel .title { font-size: 13px; font-weight: 800; letter-spacing: 0.2px; }
      #gbd_panel .warn { color: #ffcc66; font-weight: 700; }
    `);

    const div = document.createElement("div");
    div.id = "gbd_panel";
    div.innerHTML = `
      <div class="title">Grok Files bulk delete</div>
      <div class="muted">Page: /files (deletes in current list order)</div>

      <div class="row">
        <button id="gbd_start">Start</button>
        <button id="gbd_stop" disabled>Stop</button>
        <label class="muted" style="margin-left:auto;">
          <input id="gbd_dryrun" type="checkbox" checked />
          Dry run
        </label>
      </div>

      <div class="row muted">
        <span class="warn">Tip:</span>
        <span>Uncheck Dry run only when ready.</span>
      </div>

      <div id="gbd_counts" class="muted" style="margin-top:8px;">tried: 0 | deleted: 0 | skipped: 0 | dryRun: true</div>
      <div id="gbd_status" class="status">Idle</div>
    `;

    document.documentElement.appendChild(div);

    document.getElementById("gbd_dryrun").addEventListener("change", (e) => {
      S.dryRun = !!e.target.checked;
      updateCounters();
    });

    document.getElementById("gbd_start").addEventListener("click", async () => {
      if (S.running) return;

      // Safety: only allow running on the files page
      if (!location.pathname.startsWith("/files")) {
        setStatus(`${now()} - Not on /files, refusing to run`);
        return;
      }

      S.running = true;
      S.stopRequested = false;
      updateButtons();
      updateCounters();

      setStatus(`${now()} - Started`);
      await sleep(100);
      mainLoop().catch((e) => {
        S.running = false;
        S.stopRequested = false;
        updateButtons();
        setStatus(`${now()} - ERROR: ${String(e && e.message ? e.message : e)}`);
        console.error(e);
      });
    });

    document.getElementById("gbd_stop").addEventListener("click", () => {
      if (!S.running) return;
      S.stopRequested = true;
      setStatus(`${now()} - Stop requested`);
      updateButtons();
    });

    updateButtons();
    updateCounters();
  }

  // Wait until DOM exists enough to inject UI
  function onReady(fn) {
    if (document.readyState === "complete" || document.readyState === "interactive") fn();
    else document.addEventListener("DOMContentLoaded", fn, { once: true });
  }

  onReady(() => {
    injectUI();
    log("Loaded. Open https://grok.com/files?sort=size then click Start.");
  });

})();
