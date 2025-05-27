// ==UserScript==
// @name         ChatGPT-4o Batch Imager 0.4.3
// @namespace    https://yoursite.example
// @version      0.4.3
// @description  Batch-sends prompt templates in chatgpt.com, waits for reply-done voice button.
// @author       You
// @match        https://chatgpt.com/*
// @run-at       document-idle
// @grant        GM_registerMenuCommand
// ==/UserScript==

(() => {
  'use strict';

  /*─── editable settings ───*/
  let template = localStorage.getItem('batchPromptTemplate') ??
    'Futuristic skyline #[0-20] at {dawn|sunset|night}';

  /* 5–10 s between prompts (user request) */
  const minDelayAfterDone = 5000;   // 5 s
  const maxDelayAfterDone = 10000;  //10 s
  const replyTimeout      = 180000;
  /*─────────────────────────*/

  let counter = 0;
  let paused  = true;

  /* helpers */
  const $     = sel => document.querySelector(sel);
  const sleep = ms  => new Promise(r => setTimeout(r, ms));
  const rand  = (a,b)=> Math.floor(Math.random()*(b-a+1))+a;

  function expand(t) {
    t = t.replace(/\[(\d+)-(\d+)\]/g, (_,a,b)=> +a + (counter % (+b-(+a)+1)));
    t = t.replace(/\{([^}]+)\}/g, (_,lst)=>{
      const opts = lst.split('|').map(s=>s.trim()).filter(Boolean);
      return opts[rand(0,opts.length-1)];
    });
    return t;
  }

  /* selectors */
  const SEL = {
    editor   : 'div#prompt-textarea.ProseMirror[contenteditable="true"]',
    sendBtn  : 'button[data-testid="send-button"][aria-label="Send prompt"]',
    stopBtn  : 'button[data-testid="composer-stop-button"], button svg[aria-label="Stop generating"]',
    voiceBtn : 'button[data-testid="composer-speech-button"][aria-label="Start voice mode"]'
  };

  const isGenerating = () => !!$(SEL.stopBtn);
  const isReady      = () => !!$(SEL.voiceBtn) && !isGenerating();

  /* wait helpers */
  async function waitUntilReady() {
    const t0 = Date.now();
    while (Date.now() - t0 < replyTimeout) {
      if (isReady()) return;
      await sleep(900);
    }
    throw new Error('Timed-out waiting for GPT reply.');
  }

  async function waitForEditor() {
    const t0 = Date.now();
    while (Date.now() - t0 < 10000) {
      const node = $(SEL.editor);
      if (node) return node;
      await sleep(250);
    }
    throw new Error('Prompt editor not found.');
  }

  async function waitForSendButton() {
    const t0 = Date.now();
    while (Date.now() - t0 < 6000) {              // up to 6 s to enable
      const btn = $(SEL.sendBtn);
      if (btn && !btn.disabled) return btn;
      await sleep(150);
    }
    return null;
  }

  /* -------- type, wait, send ---------- */
  async function typeAndSend(text) {
    const ed = await waitForEditor();
    ed.focus();
    document.execCommand('selectAll', false, null);
    document.execCommand('insertText', false, text);
    ed.dispatchEvent(new Event('input', { bubbles: true }));

    const btn = await waitForSendButton();
    if (btn) {
      btn.click();
    } else {
      /* fallback: simulate Enter key */
      ed.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      ed.dispatchEvent(new KeyboardEvent('keyup',   { key: 'Enter', bubbles: true }));
    }
  }

  /* main loop */
  async function loop() {
    while (true) {
      if (paused) { await sleep(1000); continue; }

      const prompt = expand(template);
      console.log('[Batch-4o]', prompt);
      await typeAndSend(prompt);
      counter++;

      try { await waitUntilReady(); }
      catch(e){ console.warn(e.message); paused = true; continue; }

      await sleep(rand(minDelayAfterDone, maxDelayAfterDone));
    }
  }

  /* TM menu */
  GM_registerMenuCommand('▶️  Start / Resume', ()=>{ paused = false; console.log('[Batch-4o] resumed'); });
  GM_registerMenuCommand('⏸️  Pause',          ()=>{ paused = true;  console.log('[Batch-4o] paused');  });
  GM_registerMenuCommand('📝  Edit Template',   ()=>{
    const inp = prompt('Template (use [0-20], {a|b|c}):', template);
    if (inp !== null) {
      template = inp.trim();
      localStorage.setItem('batchPromptTemplate', template);
      counter = 0;
      console.log('[Batch-4o] template updated:', template);
    }
  });

  console.log('[Batch-4o] 0.4.3 loaded – open Tamper-monkey menu to start.');
  loop();
})();
