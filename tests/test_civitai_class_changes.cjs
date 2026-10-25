// Run: node tests/test_civitai_class_changes.cjs
// Local model-page and player fixtures in headless Chrome; playback is stubbed.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const sources = {
  '/premium.js': fs.readFileSync(path.join(__dirname, '../civitai_premium_gallery_mockup.user.js')),
  '/audio.js': fs.readFileSync(path.join(__dirname, '../civitai_audio_play_hover.user.js')),
};
const fixture = fs.readFileSync(path.join(__dirname, 'civitai_class_changes_fixture.html'));
const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', sources[req.url] ? 'text/javascript' : 'text/html');
  if (req.url === '/test-video.mp4') { res.statusCode = 404; res.end(); return; }
  res.end(sources[req.url] || fixture);
});

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'civitai-class-changes-test-'));
  const chrome = spawn(process.env.CHROME || 'google-chrome', [
    '--headless', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    '--no-first-run', '--disable-background-networking', '--remote-debugging-pipe', '--window-size=1100,900',
    `--user-data-dir=${profile}`, 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
  let seq = 0, buffer = '', stderr = '', pageLoaded;
  const pending = new Map();
  chrome.stderr.on('data', data => { stderr += data; });
  chrome.stdio[4].on('data', data => {
    buffer += data;
    let end;
    while ((end = buffer.indexOf('\0')) >= 0) {
      const message = JSON.parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      if (message.method === 'Page.loadEventFired') pageLoaded?.();
      if (!pending.has(message.id)) continue;
      const { resolve, reject, timer } = pending.get(message.id);
      pending.delete(message.id);
      clearTimeout(timer);
      if (message.error) reject(new Error(JSON.stringify(message.error)));
      else resolve(message.result);
    }
  });
  function cdp(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
      const id = ++seq;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${method} timed out: ${stderr.slice(-500)}`));
      }, 10000);
      pending.set(id, { resolve, reject, timer });
      chrome.stdio[3].write(JSON.stringify({ id, method, params, sessionId }) + '\0');
    });
  }
  try {
    for (const scenario of ['audio', 'premium', 'legacy', 'navigation-preview', 'icon-preview', 'renderer-only', 'unlabelled-gallery']) {
      const { browserContextId } = await cdp('Target.createBrowserContext');
      const { targetId } = await cdp('Target.createTarget', { url: 'about:blank', browserContextId });
      const { sessionId } = await cdp('Target.attachToTarget', { targetId, flatten: true });
      await cdp('Page.enable', {}, sessionId);
      const loaded = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Fixture load timed out')), 10000);
        pageLoaded = () => { clearTimeout(timeout); resolve(); };
      });
      await cdp('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/models/1?case=${scenario}` }, sessionId);
      await loaded;
      const evaluate = async expression => {
        const result = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
        assert(!result.exceptionDetails, JSON.stringify(result.exceptionDetails));
        return result.result?.value;
      };
      const until = async expression => {
        assert(await evaluate(`new Promise(resolve => {
          const deadline = Date.now() + 5000;
          const poll = () => {
            if (${expression}) return resolve(true);
            if (Date.now() >= deadline) return resolve(false);
            setTimeout(poll, 25);
          }; poll();
        })`), `Timed out: ${expression}`);
      };
      await until('window.scriptReady');
      if (scenario === 'audio') {
        const move = async (selector, padding = false) => {
          const point = await evaluate(`(() => {
            const rect = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
            return { x: rect.left + ${padding ? 5 : 'rect.width / 2'}, y: rect.top + ${padding ? 5 : 'rect.height / 2'} };
          })()`);
          await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point }, sessionId);
          return point;
        };
        const point = await move('#activate');
        await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point }, sessionId);
        await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point }, sessionId);
        await move('#unrelated');
        await evaluate('new Promise(resolve => setTimeout(resolve, 600))');
        assert.equal(await evaluate('document.querySelector("#video1").volume'), 0, 'A heading must not start the nearby video');
        await move('#linked', true);
        await until('!document.querySelector("#video1").muted && document.querySelector("#video1").volume === 1');
        await move('#overlay1');
        await evaluate('document.querySelector("#video1").dispatchEvent(new Event("ended"))');
        assert.equal(await evaluate('document.querySelector("#video1").muted'), false, 'An overlay inside the same media link must keep audio active');
        await move('#overlay2');
        assert.equal(await evaluate('document.querySelector("#video2").volume'), 0, 'Switching must preserve the hover delay');
        await until('!document.querySelector("#video2").muted && document.querySelector("#video2").volume === 1');
        assert.equal(await evaluate('document.querySelector("#video1").muted'), true, 'Only one video may play audio');
        await move('#ambiguous > span');
        await until('document.querySelector("#video2").muted');
        assert.equal(await evaluate('[...document.querySelectorAll("#ambiguous video")].every(video => video.volume === 0)'), true);
        console.log('PASS audio: wrapper padding, overlays, unlinked player, delayed switching, unrelated areas, multiple videos');
      } else {
        await until('document.querySelectorAll("#gallery-grid .cpgm-gallery-add").length === 2');
        assert.equal(await evaluate('document.querySelectorAll(".cpgm-gallery-add").length'), 2, 'Controls must only be added to gallery media');
        assert.equal(await evaluate('document.querySelector("#native-preview").dataset.cpgmNativePreview'), 'true', 'The model preview must be found despite renamed section classes');
        assert.equal(await evaluate('document.querySelector("#cpgm-description-editor").textContent'), 'Model description to preserve.');
        assert.equal(await evaluate('document.querySelector("#comments [data-cpgm-hide-in-mock]")'), null, 'Comment renderers must stay untouched');
        await evaluate('document.querySelector("[data-cpgm-mode-value=edit]").click(); document.querySelector("#gallery-image .cpgm-gallery-add").click()');
        await until('document.querySelectorAll("#cpgm-preview .cpgm-preview-item").length === 1');
        assert.equal(await evaluate('document.querySelector("#native-preview").dataset.cpgmReplaced'), 'true');
        assert.equal(await evaluate('document.querySelector("#gallery-section").hasAttribute("data-cpgm-replaced")'), false, 'Replacing the preview must not hide the gallery');
        assert.equal(await evaluate('document.querySelector("#cpgm-description-editor").isContentEditable'), true);
        // Newly loaded cards receive controls; repeated reconciliation must not duplicate them.
        await evaluate(`{
          const copy = document.querySelector('#gallery-image').cloneNode(true);
          copy.id = 'late-image';
          copy.querySelector('.cpgm-gallery-add').remove();
          copy.querySelector('a').href = '/images/202';
          document.querySelector('#gallery-grid').append(copy);
        }`);
        await until('document.querySelectorAll("#gallery-grid .cpgm-gallery-add").length === 3');
        assert.equal(await evaluate('document.querySelectorAll("#cpgm-preview .cpgm-gallery-add, #comments .cpgm-gallery-add, #native-preview .cpgm-gallery-add").length'), 0);
        console.log(`PASS ${scenario}: scoped gallery controls, preview replacement, description editing, late cards`);
      }
      await cdp('Target.disposeBrowserContext', { browserContextId });
    }
  } finally {
    chrome.kill();
    await new Promise(resolve => chrome.once('exit', resolve));
    server.close();
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
