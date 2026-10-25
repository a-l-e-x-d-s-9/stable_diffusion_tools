// Run: node tests/test_civitai_reactors.cjs
// Headless Chrome, supplied markup reduced to relevant structure, mocked ownership.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const source = fs.readFileSync(path.join(__dirname, '../civitai_image_reactors.user.js'));
const fixture = fs.readFileSync(path.join(__dirname, 'civitai_reactors_fixture.html'));
const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', req.url === '/userscript.js' ? 'text/javascript' : 'text/html');
  res.end(req.url === '/userscript.js' ? source : fixture);
});

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'civitai-reactors-test-'));
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
    const focus = selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).focus()`);
    await focus('#carousel [aria-label="Add reaction"]');
    assert.equal(await evaluate('requests.length'), 0, 'Add reaction must not trigger the popup');
    await focus('#carousel [aria-label="Buzz"]');
    assert.equal(await evaluate('requests.length'), 0, 'Buzz must not trigger the popup');
    await focus('#carousel [aria-label="Like reaction"]');
    await until(`document.querySelector('#carousel .civ-reactors-total')?.textContent === '13+ reactors'`);
    assert.deepEqual(await evaluate('ownershipRequests'), ['134573002'], 'Carousel ownership must use the image API');
    assert.deepEqual(await evaluate('requests.map(r => [r.imageId, r.reaction])'), [['134573002', 'Like'], ['134573002', 'Heart']]);
    assert.equal(await evaluate(`document.querySelector('#carousel .civ-reactors-panel').hidden`), false);
    assert.equal(await evaluate(`document.querySelectorAll('#carousel .civ-reactors-user').length`), 13);
    assert.equal(await evaluate(`document.querySelector('#carousel .civ-reactors-user .civ-reactors-emojis').textContent`), '👍❤️', 'Reactions from one person must be combined');
    assert.equal(await evaluate(`document.querySelector('#carousel .civ-reactors-name').href`), 'https://civitai.red/user/person1/');
    await evaluate(`document.querySelector('#carousel [data-page-next]').click()`);
    await until(`document.querySelector('#carousel .civ-reactors-total')?.textContent === '14 reactors'`);
    assert.equal(await evaluate(`document.querySelector('#carousel .civ-reactors-name').textContent`), 'person14');
    assert.deepEqual(await evaluate('requests[2]'), { imageId: '134573002', reaction: 'Like', after: 'page-2' });
    await evaluate(`document.querySelector('#carousel [data-page-prev]').click()`);
    assert.equal(await evaluate(`document.querySelector('#carousel .civ-reactors-name').textContent`), 'person1');
    // Actual pointer events on a nested label must find the gallery row too.
    const point = await evaluate(`(() => {
      const rect = document.querySelector('#gallery [aria-label="Like reaction"] span').getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    })()`);
    await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point }, sessionId);
    await until(`document.querySelector('#gallery .civ-reactors-total')?.textContent === '13+ reactors'`);
    assert.equal(await evaluate(`document.querySelector('#gallery .civ-reactors-panel').hidden`), false);
    assert.equal(await evaluate('requests.length'), 5);
    assert.deepEqual(await evaluate('ownershipRequests'), ['134573002'], 'Gallery must use its creator link for ownership');
    await focus('#gallery [aria-label="Heart reaction"]');
    assert.equal(await evaluate('requests.length'), 5, 'Changing reaction buttons must reuse the cached combined list');
    // The row must keep working after another CSS module rename and on old markup.
    await evaluate(`document.querySelector('#gallery .reactions').className = 'FutureHash_root reactions'`);
    await focus('#carousel [aria-label="Heart reaction"]');
    await focus('#gallery [aria-label="Like reaction"]');
    await until(`!document.querySelector('#gallery .civ-reactors-panel').hidden`);
    await evaluate(`document.querySelector('#carousel .reactions').className = 'ImageCard-module__reactions reactions'`);
    await focus('#carousel [aria-label="Like reaction"]');
    await until(`!document.querySelector('#carousel .civ-reactors-panel').hidden`);
    assert.equal(await evaluate('requests.length'), 5);
    // A newly inserted, other-user gallery card must stay excluded.
    await evaluate(`{
      const clone = document.querySelector('#gallery').parentElement.cloneNode(true);
      clone.querySelector('.civ-reactors-panel').remove();
      clone.querySelector('#gallery').id = 'other';
      clone.querySelector('a[href*="/user/"]').href = 'https://civitai.com/user/someone-else';
      clone.querySelector('a[href*="/images/"]').href = '/images/999';
      document.querySelector('main').append(clone);
    }`);
    await focus('#other [aria-label="Like reaction"]');
    await evaluate('new Promise(resolve => setTimeout(resolve, 250))');
    assert.equal(await evaluate(`document.querySelector('#other .civ-reactors-panel')`), null);
    assert.equal(await evaluate('requests.length'), 5, 'Other users must not trigger reactors requests');
    console.log('PASS: hashed carousel/gallery rows, hover, focus, merged reactions, paging, caching, ownership, legacy classes');
  } finally {
    chrome.kill();
    await new Promise(resolve => chrome.once('exit', resolve));
    server.close();
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
