// ==UserScript==
// @name         ChatGPT-4o Batch Imager 0.5.0
// @namespace    https://yoursite.example
// @version      0.5.0
// @description  Batch-sends prompt templates in chatgpt.com, with cooldown and policy handling.
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

  // 5-10 s between normal prompts
  const minDelayAfterDone = 5000;
  const maxDelayAfterDone = 10000;

  // follow-up delay after sending policy rewrite prompt (short)
  const minDelayAfterPolicyFollowup = 2000;
  const maxDelayAfterPolicyFollowup = 4000;

  // if generic cooldown detected, wait 5-10 minutes
  const genericCooldownMinMinutes = 5;
  const genericCooldownMaxMinutes = 10;

  const replyTimeout = 180000;
  /*─────────────────────────*/

  let counter = 0;
  let paused  = true;
  let lastSentPrompt = '';
  let cooldownTimer = null;
  let cooldownTicker = null;

  /* helpers */
  const $     = sel => document.querySelector(sel);
  const $$    = sel => Array.from(document.querySelectorAll(sel));
  const sleep = ms  => new Promise(r => setTimeout(r, ms));
  const rand  = (a,b)=> Math.floor(Math.random()*(b-a+1))+a;
  const clamp = (v,lo,hi)=> Math.max(lo, Math.min(hi, v));

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
    voiceBtn : 'button[data-testid="composer-speech-button"][aria-label="Start voice mode"]',
    // assistant message containers are dynamic, use role attribute as anchor
    assistantMsg : '[data-message-author-role="assistant"]'
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
    while (Date.now() - t0 < 6000) {
      const btn = $(SEL.sendBtn);
      if (btn && !btn.disabled) return btn;
      await sleep(150);
    }
    return null;
  }

  /* type, wait, send */
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
      ed.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      ed.dispatchEvent(new KeyboardEvent('keyup',   { key: 'Enter', bubbles: true }));
    }
  }

  /* get last assistant text */
  function getLastAssistantText() {
    const nodes = $$(SEL.assistantMsg);
    if (!nodes.length) return '';
    // pick the last visible node with non-empty text
    for (let i = nodes.length - 1; i >= 0; i--) {
      const n = nodes[i];
      if (!(n.offsetParent === null)) {
        const text = (n.textContent || '').trim();
        if (text) return text;
      }
    }
    // fallback to very last
    return (nodes[nodes.length - 1].textContent || '').trim();
  }

  /* cooldown parsing and classification */
  function parseCooldownMs(text) {
    const t = text.toLowerCase();

    // explicit hours and minutes e.g. "wait about 1 hour and 30 minutes"
    const hm = t.match(/(\d+)\s*hour[s]?\s*(?:and\s*(\d+)\s*minute[s]?)?/i);
    if (hm) {
      const h = parseInt(hm[1], 10);
      const m = hm[2] ? parseInt(hm[2], 10) : 0;
      const totalMs = (h * 60 + m) * 60 * 1000;
      return Math.max(0, Math.floor(totalMs / 2));
    }

    // explicit minutes e.g. "wait about 16 minutes" or "wait 8 min"
    const mm = t.match(/(\d+)\s*(?:minute[s]?|mins?|m)\b/i);
    if (mm) {
      const m = parseInt(mm[1], 10);
      const totalMs = m * 60 * 1000;
      return Math.max(0, Math.floor(totalMs / 2));
    }

    // explicit hours shorthand e.g. "2 hrs", "2h"
    const hh = t.match(/(\d+)\s*(?:hr[s]?|h)\b/i);
    if (hh) {
      const h = parseInt(hh[1], 10);
      const totalMs = h * 60 * 60 * 1000;
      return Math.max(0, Math.floor(totalMs / 2));
    }

    return 0;
  }

  function isGenericCooldown(text) {
    const t = text.toLowerCase();
    return (
      /temporary rate limit|cooldown|used too quickly|slow down|wait a short while|try again later/i.test(t)
    );
  }

  function isPolicyBlocked(text) {
    const t = text.toLowerCase();
    // broad but safe cues
    return (
      /content policy/.test(t) ||
      /didn.?t comply/.test(t) ||
      /wasn.?t able to generate.*policy/.test(t) ||
      /cannot generate.*policy/.test(t)
    );
  }

  /* pause/resume management with persistence */
  function scheduleResume(waitMs, reason = 'cooldown') {
    const now = Date.now();
    const resumeAt = now + waitMs;
    sessionStorage.setItem('batch4o_resumeAt', String(resumeAt));
    sessionStorage.setItem('batch4o_paused', '1');

    paused = true;

    if (cooldownTimer) clearTimeout(cooldownTimer);
    if (cooldownTicker) clearInterval(cooldownTicker);

    const human = msToHuman(waitMs);
    console.log(`[Batch-4o] Paused for ${human} due to ${reason}. Will auto-resume at ${new Date(resumeAt).toLocaleTimeString()}.`);

    cooldownTimer = setTimeout(() => {
      paused = false;
      sessionStorage.removeItem('batch4o_resumeAt');
      sessionStorage.setItem('batch4o_paused', '0');
      console.log('[Batch-4o] Auto-resumed after pause.');
    }, waitMs);

    // minute ticker
    cooldownTicker = setInterval(() => {
      const remain = Math.max(0, resumeAt - Date.now());
      const mins = Math.ceil(remain / 60000);
      console.log(`[Batch-4o] Resume in ~${mins} min`);
      if (remain <= 0) {
        clearInterval(cooldownTicker);
        cooldownTicker = null;
      }
    }, 60000);
  }

  function restorePauseIfAny() {
    const resumeAtRaw = sessionStorage.getItem('batch4o_resumeAt');
    const pausedRaw   = sessionStorage.getItem('batch4o_paused');
    if (resumeAtRaw && pausedRaw === '1') {
      const resumeAt = parseInt(resumeAtRaw, 10);
      const remain = resumeAt - Date.now();
      if (remain > 1000) {
        scheduleResume(remain, 'restored');
      } else {
        sessionStorage.removeItem('batch4o_resumeAt');
        sessionStorage.setItem('batch4o_paused', '0');
      }
    }
  }

  function msToHuman(ms) {
    const m = Math.round(ms / 60000);
    if (m < 1) return `${Math.round(ms/1000)} sec`;
    if (m < 60) return `${m} min`;
    const h = Math.floor(m / 60);
    const mm = m % 60;
    return mm ? `${h} h ${mm} min` : `${h} h`;
  }

  /* main loop */
  async function loop() {
    restorePauseIfAny();

    while (true) {
      if (paused) { await sleep(1000); continue; }

      const prompt = expand(template);
      lastSentPrompt = prompt;
      console.log('[Batch-4o]', prompt);
      await typeAndSend(prompt);
      counter++;

      try { await waitUntilReady(); }
      catch(e){ console.warn(e.message); paused = true; continue; }

      // Inspect last assistant reply
      const reply = getLastAssistantText();
      if (reply) {
        // 1) explicit cooldown with numeric time
        const halfWait = parseCooldownMs(reply);
        if (halfWait > 0) {
          scheduleResume(halfWait, 'explicit-cooldown-half');
          continue; // skip normal small delay
        }

        // 2) generic cooldown phrase
        if (isGenericCooldown(reply)) {
          const waitMs = rand(genericCooldownMinMinutes, genericCooldownMaxMinutes) * 60 * 1000;
          scheduleResume(waitMs, 'generic-cooldown');
          continue; // skip normal small delay
        }

        // 3) content policy block -> immediate rewrite request
        if (isPolicyBlocked(reply)) {
          const rewrite = [
            'Please rewrite the following image request so that it fully complies with OpenAI content policy,',
            'while preserving the core style, mood, and artistic intent.',
            'After rewriting, generate the image using the compliant prompt.',
            '',
            'Original request:',
            lastSentPrompt
          ].join('\n');

          console.log('[Batch-4o] Policy block detected. Sending compliant rewrite request...');
          await sleep(500); // small UI breather
          await typeAndSend(rewrite);

          try { await waitUntilReady(); }
          catch(e){ console.warn('Follow-up timed out: ' + e.message); paused = true; continue; }

          await sleep(rand(minDelayAfterPolicyFollowup, maxDelayAfterPolicyFollowup));
          // then proceed as normal
          await sleep(rand(minDelayAfterDone, maxDelayAfterDone));
          continue;
        }
      }

      // normal spacing between successful turns
      await sleep(rand(minDelayAfterDone, maxDelayAfterDone));
    }
  }

  /* TM menu */
  GM_registerMenuCommand('▶️  Start / Resume', ()=>{ paused = false; sessionStorage.setItem('batch4o_paused','0'); console.log('[Batch-4o] resumed'); });
  GM_registerMenuCommand('⏸️  Pause',          ()=>{
    paused = true;
    sessionStorage.setItem('batch4o_paused','1');
    if (cooldownTimer) clearTimeout(cooldownTimer);
    if (cooldownTicker) clearInterval(cooldownTicker);
    console.log('[Batch-4o] paused');
  });
  GM_registerMenuCommand('📝  Edit Template',   ()=>{
    const inp = prompt('Template (use [0-20], {a|b|c}):', template);
    if (inp !== null) {
      template = inp.trim();
      localStorage.setItem('batchPromptTemplate', template);
      counter = 0;
      console.log('[Batch-4o] template updated:', template);
    }
  });
  GM_registerMenuCommand('🧹  Clear cooldown', ()=>{
    if (cooldownTimer) clearTimeout(cooldownTimer);
    if (cooldownTicker) clearInterval(cooldownTicker);
    cooldownTimer = null; cooldownTicker = null;
    sessionStorage.removeItem('batch4o_resumeAt');
    sessionStorage.setItem('batch4o_paused','0');
    paused = false;
    console.log('[Batch-4o] cooldown cleared and resumed');
  });

  console.log('[Batch-4o] 0.5.0 loaded - open Tampermonkey menu to start.');
  loop();
})();
