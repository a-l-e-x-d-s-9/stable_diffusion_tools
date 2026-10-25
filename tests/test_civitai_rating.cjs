// Run: node tests/test_civitai_rating.cjs
// Headless Chrome, supplied markup reduced to relevant structure, mocked ownership.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const source = fs.readFileSync(path.join(__dirname, '../civitai_rating_highlighter.user.js'));
const fixture = fs.readFileSync(path.join(__dirname, 'civitai_rating_fixture.html'));
const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', req.url === '/userscript.js' ? 'text/javascript' : 'text/html');
  res.end(req.url === '/userscript.js' ? source : fixture);
});

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'civitai-rating-test-'));
  const chrome = spawn(process.env.CHROME || 'google-chrome', [
    '--headless', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    '--no-first-run', '--disable-background-networking', '--remote-debugging-pipe',
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
    const { targetId } = await cdp('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp('Target.attachToTarget', { targetId, flatten: true });
    await cdp('Page.enable', {}, sessionId);
    const loaded = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Fixture load timed out')), 10000);
      pageLoaded = () => { clearTimeout(timeout); resolve(); };
    });
    await cdp('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/` }, sessionId);
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
    const frame = 'data-civitai-rating-unrated';
    const color = 'data-civitai-rating-color';
    const badge = '#carousel > .mantine-Badge-root, #gallery > .mantine-Badge-root';
    await until(`document.querySelector('#civitai-rating-highlighter')?.shadowRoot.getElementById('status').textContent.includes('/ 2 loaded')`);
    await until(`document.querySelectorAll('[${color}="R"]').length === 2`);
    assert.equal(await evaluate(`document.querySelectorAll('[${frame}]').length`), 0, 'Visible R badges must prevent red frames');
    for (const [rating, background] of Object.entries({ PG: 'rgb(0, 230, 118)', 'PG-13': 'rgb(161, 253, 124)', R: 'rgb(255, 238, 0)', X: 'rgb(255, 100, 28)', XXX: 'rgb(255, 23, 68)' })) {
      await evaluate(`document.querySelectorAll('${badge}').forEach(b => b.querySelector('span').textContent = '${rating}')`);
      await until(`[...document.querySelectorAll('${badge}')].every(b => b.getAttribute('${color}') === '${rating}')`);
      assert.deepEqual(await evaluate(`[...document.querySelectorAll('${badge}')].map(b => getComputedStyle(b).backgroundColor)`), [background, background]);
      assert.equal(await evaluate(`document.querySelectorAll('[${frame}]').length`), 0);
    }
    assert.equal(await evaluate(`document.querySelector('.mantine-Chip-label').getAttribute('${color}')`), 'PG', 'Filter chips must survive generated class changes');
    assert.equal(await evaluate(`document.querySelectorAll('button [${color}], .mantine-Paper-root [${color}]').length`), 0, 'Remix and OP badges must stay unchanged');
    assert.equal(await evaluate(`document.querySelector('.mantine-Chip-label:last-child').hasAttribute('${color}')`), false);
    // Old badges remain supported; a newly generated hash must work too.
    await evaluate(`document.querySelector('#carousel > .mantine-Badge-root').className = 'ImageGuard-module__root mantine-Badge-root';
      document.querySelector('#gallery > .mantine-Badge-root').className = 'FutureHash_root mantine-Badge-root'`);
    await until(`document.querySelectorAll('[${color}="XXX"]').length === 3`);
    // Removing ratings must restore frames, regardless of unrelated badges/text.
    await evaluate(`document.querySelectorAll('${badge}').forEach(b => b.remove());
      document.querySelector('#gallery').insertAdjacentHTML('beforeend', '<p>PG</p>')`);
    await until(`document.querySelectorAll('[${frame}]').length === 2`);
    assert.equal(await evaluate(`getComputedStyle(document.querySelector('#carousel'), '::after').borderTopWidth`), '8px');
    await evaluate(`document.querySelector('#carousel').insertAdjacentHTML('afterbegin', '<div class="AnotherHash_root mantine-Badge-root"><span class="mantine-Badge-label">PG-13</span></div>')`);
    await until(`!document.querySelector('#carousel').hasAttribute('${frame}') && document.querySelector('#carousel [${color}="PG-13"]')`);
    // Creator checks must still exclude someone else's card.
    await evaluate(`document.querySelector('a[href="https://civitai.com/user/alexds9"]').href = 'https://civitai.com/user/someone-else';
      document.querySelector('#gallery').insertAdjacentHTML('afterbegin', '<div class="mantine-Badge-root">R</div>')`);
    await until(`!document.querySelector('#gallery').hasAttribute('${frame}') && !document.querySelector('#gallery [${color}]')`);
    await evaluate(`document.querySelector('#civitai-rating-highlighter').shadowRoot.getElementById('enabled').click()`);
    assert.equal(await evaluate(`document.querySelectorAll('[${frame}], [${color}]').length`), 0, 'Disabling must remove all marks');
    console.log('PASS: carousel/gallery badges, all five colors, filters, class changes, dynamic ratings, ownership, disabling');
  } finally {
    chrome.kill();
    await new Promise(resolve => chrome.once('exit', resolve));
    server.close();
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
