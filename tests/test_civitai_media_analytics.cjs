// Run: node tests/test_civitai_media_analytics.cjs
// Real headless Chrome with the supplied Studio daily series and mocked transport.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const source = fs.readFileSync(path.join(__dirname, '../civitai_media_analytics.user.js'), 'utf8');
for (const domain of ['com', 'red', 'green']) {
  assert(source.includes(`@match        https://civitai.${domain}/*`));
}
// Permit the local fixture origin for URL-only viewer navigation in this test.
const servedSource = source.replace('if (!/^civitai\\.(com|red|green)$/i.test(url.hostname)) return null;',
  'if (!/^civitai\\.(com|red|green)$/i.test(url.hostname) && url.hostname !== "127.0.0.1") return null;');
assert.notEqual(servedSource, source);
const server = http.createServer((req, res) => {
  const script = req.url === '/userscript.js';
  res.setHeader('Content-Type', script ? 'text/javascript' : 'text/html');
  res.end(script ? servedSource : fs.readFileSync(path.join(__dirname,
    req.url === '/response.html' ? 'civitai_media_analytics_response.html' : 'civitai_media_analytics_fixture.html')));
});

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'civitai-analytics-test-'));
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
    await cdp('Network.enable', {}, sessionId);
    await cdp('Network.setBlockedURLs', { urls: ['*://image.civitai.com/*'] }, sessionId);
    const loaded = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Fixture load timed out')), 10000);
      pageLoaded = () => { clearTimeout(timeout); resolve(); };
    });
    await cdp('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/` }, sessionId);
    await loaded;
    const evaluate = async (expression, session = sessionId) => {
      const result = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, session);
      assert(!result.exceptionDetails, JSON.stringify(result.exceptionDetails));
      return result.result?.value;
    };
    const until = async (expression, session = sessionId) => {
      assert(await evaluate(`new Promise(resolve => {
        const deadline = Date.now() + 5000;
        const poll = () => {
          if (${expression}) return resolve(true);
          if (Date.now() >= deadline) return resolve(false);
          setTimeout(poll, 25);
        }; poll();
      })`, session), `Timed out: ${expression}`);
    };
    await evaluate(`window.ui = id => document.querySelector('#' + id + ' .civ-media-analytics')?.shadowRoot;
      window.click = (id, selector) => ui(id).querySelector(selector).click();
      window.month = (id, value) => { const el = ui(id).querySelector('.month'); el.value = value; el.dispatchEvent(new Event('change')); };`);
    await until(`ui('image') && ui('video')`);
    assert.equal(await evaluate('requests.length'), 0, 'Cards must not eagerly request analytics');
    assert.equal(await evaluate(`document.querySelectorAll('.civ-media-analytics').length`), 2, 'Avatars must be excluded');
    await evaluate(`month('video', '2026-10')`);
    assert.equal(await evaluate(`ui('image').querySelector('.month').value`), '2026-10', 'A month change must update the other hidden panel');
    assert.equal(await evaluate(`GM_getValue('civitai-media-analytics-month')`), '2026-10');
    assert.equal(await evaluate('requests.length'), 0, 'Changing a hidden panel must not fetch');
    assert(await evaluate(`(() => {
      const button = ui('video').querySelector('.toggle').getBoundingClientRect();
      const media = document.querySelector('#video video').getBoundingClientRect();
      return Math.abs(button.x + button.width / 2 - media.x - media.width / 2) < 1
        && Math.abs(media.bottom - button.bottom - 8) < 1;
    })()`), 'The icon must be centered at the bottom of the media');
    // Move the real pointer to the button: one enter opens and staying does not toggle.
    const point = await evaluate(`(() => { const r = ui('video').querySelector('.toggle').getBoundingClientRect(); return { x:r.x+r.width/2,y:r.y+r.height/2 }; })()`);
    await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point }, sessionId);
    await until(`!ui('video').querySelector('.panel').hidden`);
    await until(`ui('video').querySelector('.chart svg')`);
    assert.equal(await evaluate(`ui('video').querySelector('.total').textContent`), '555 this month');
    assert.equal(await evaluate(`ui('video').querySelectorAll('.chart .data-point').length`), 93);
    await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x + 1, y: point.y }, sessionId);
    assert.equal(await evaluate(`ui('video').querySelector('.panel').hidden`), false);
    // A real click following hover must not undo it or navigate the linked media.
    await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point }, sessionId);
    await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point }, sessionId);
    assert.equal(await evaluate(`ui('video').querySelector('.panel').hidden`), false);
    assert.equal(await evaluate('navigations'), 0);
    assert.deepEqual(await evaluate(`[...ui('video').querySelectorAll('.metric')].map(el => el.textContent)`),
      ['Views over time', 'Reactions over time', 'Feed impressions over time']);
    assert.deepEqual(await evaluate(`[...ui('video').querySelectorAll('.total')].map(el => el.textContent)`),
      ['555 this month', '36 this month', '245,476 this month']);
    assert.equal(await evaluate(`ui('video').querySelectorAll('.chart svg').length`), 3);
    assert.equal(await evaluate(`ui('video').querySelectorAll('.prev, .next').length`), 0);
    assert(await evaluate(`(() => {
      const panel = ui('video').querySelector('.panel').getBoundingClientRect();
      const charts = [...ui('video').querySelectorAll('.chart svg')].map(el => el.getBoundingClientRect());
      return charts.every((rect, index) => rect.height > 0 && rect.top >= panel.top && rect.bottom <= panel.bottom
        && (index === 0 || rect.top >= charts[index - 1].bottom));
    })()`), 'All three graphs must be visible and stacked vertically');
    // Real pointer motion selects one shared date across all three graphs.
    await evaluate(`window.chartPoint = (metric, day) => {
      const svg = ui('video').querySelector('[data-metric="' + metric + '"] svg');
      const point = svg.createSVGPoint(); point.x = 43 + (day - 1) / 30 * 290; point.y = 40;
      const screen = point.matrixTransform(svg.getScreenCTM()); return {x:screen.x,y:screen.y};
    }`);
    const hoverDay = async (metric, day) => {
      const position = await evaluate(`chartPoint(${JSON.stringify(metric)}, ${day})`);
      await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', ...position }, sessionId);
    };
    await hoverDay('series', 6);
    assert.deepEqual(await evaluate(`[...ui('video').querySelectorAll('.readout')].map(el => [el.hidden,el.textContent])`),
      [[false,'2026-10-06 · 51'],[false,'2026-10-06 · 4'],[false,'2026-10-06 · 16,523']]);
    assert(await evaluate(`(() => {
      const lines = [...ui('video').querySelectorAll('.focus-line')];
      const x = lines.map(line => line.getBoundingClientRect().x);
      return lines.every(line => line.getAttribute('visibility') === 'visible') && Math.max(...x)-Math.min(...x) < 1;
    })()`), 'The reference lines must align on screen across all graphs');
    assert.equal(await evaluate(`ui('video').querySelectorAll('.focus-dot[visibility="visible"]').length`), 3);
    await hoverDay('impressionSeries', 31);
    assert.deepEqual(await evaluate(`[...ui('video').querySelectorAll('.readout')].map(el => el.textContent)`),
      ['2026-10-31 · 0','2026-10-31 · 0','2026-10-31 · 19'], 'A zero count must remain visible');
    await hoverDay('reactionSeries', 12);
    assert.deepEqual(await evaluate(`[...ui('video').querySelectorAll('.readout')].map(el => el.textContent)`),
      ['2026-10-12 · 46','2026-10-12 · 1','2026-10-12 · 17,787'], 'Any of the three graphs must drive the shared date');
    if (process.env.ANALYTICS_SCREENSHOT) {
      const shot = await cdp('Page.captureScreenshot', { format: 'png' }, sessionId);
      fs.writeFileSync(process.env.ANALYTICS_SCREENSHOT, Buffer.from(shot.data, 'base64'));
    }
    await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1050, y: 800 }, sessionId);
    assert(await evaluate(`[...ui('video').querySelectorAll('.readout')].every(el => el.hidden)`), 'Leaving the graphs must clear the readouts');
    assert.equal(await evaluate(`ui('video').querySelectorAll('.focus-line[visibility="visible"]').length`), 0);
    await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point }, sessionId);
    assert.equal(await evaluate(`ui('video').querySelector('.panel').hidden`), true, 'Re-entering must hide');
    await evaluate(`click('video', '.toggle')`);
    await until(`ui('video').querySelector('.chart svg')`);
    assert.equal(await evaluate('requests.length'), 1, 'All three graphs and reopening reuse one cached request');
    assert.equal(await evaluate('requests[0].credentials'), true);
    await evaluate(`month('video', '2026-09')`);
    await until(`requests.length === 2 && ui('video').querySelector('.chart svg')`);
    assert.equal(await evaluate(`ui('video').querySelector('.studio').href`), 'https://creator-studio.civitai.com/analytics/content/image/143710065?month=2026-09');

    // A failed refresh must be retryable, with no stale graph shown as new data.
    await evaluate(`mode='forbidden'; click('video', '.refresh')`);
    await until(`ui('video').querySelector('.status').textContent.includes('Sign in')`);
    assert.equal(await evaluate(`ui('video').querySelector('.chart svg')`), null);
    await evaluate(`mode='ok'; click('video', '.refresh')`);
    await until(`ui('video').querySelector('.chart svg')`);
    await evaluate(`mode='login'; click('video', '.refresh')`);
    await until(`ui('video').querySelector('.status').textContent.includes('check access')`);
    await evaluate(`mode='wrong-id'; click('video', '.refresh')`);
    await until(`ui('video').querySelector('.status').textContent.includes('check access')`);
    await evaluate(`mode='injection'; click('video', '.refresh')`);
    await until(`ui('video').querySelector('.status').textContent.includes('Unsupported')`);
    assert.equal(await evaluate('window.compromised'), undefined, 'Hydration data must never be evaluated');
    await evaluate(`mode='missing'; click('video', '.refresh')`);
    await until(`ui('video').querySelector('[data-metric="impressionSeries"] .chart')?.textContent.includes('unavailable')`);
    assert.equal(await evaluate(`ui('video').querySelectorAll('.chart svg').length`), 2, 'Missing impressions must keep views and reactions visible');
    await hoverDay('series', 6);
    assert.equal(await evaluate(`ui('video').querySelector('[data-metric="impressionSeries"] .readout').textContent`), '2026-10-06 · No data');
    await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1050, y: 800 }, sessionId);
    await evaluate(`mode='gaps'; click('video', '.refresh')`);
    await until(`ui('video').querySelectorAll('.chart svg').length === 3`);
    assert(await evaluate(`[...ui('video').querySelectorAll('.readout')].every(el => el.hidden)`), 'Reloading data must clear the previous reference date');
    await hoverDay('series', 6);
    assert.equal(await evaluate(`ui('video').querySelector('[data-metric="reactionSeries"] .readout').textContent`), '2026-10-06 · No data', 'Missing days must not select a different day in one metric');
    assert.equal(await evaluate(`ui('video').querySelector('[data-metric="reactionSeries"] .focus-dot').getAttribute('visibility')`), 'hidden');
    assert.equal(await evaluate(`ui('video').querySelectorAll('.focus-line[visibility="visible"]').length`), 3);
    assert(await evaluate(`Math.abs(Number(ui('video').querySelector('[data-metric="reactionSeries"] .data-point').getAttribute('cx')) - (43+290/30)) < 0.001`), 'A series missing its first day must share the same date axis');
    await evaluate(`mode='ok'`);

    // Recycled cards and lazy-inserted cards get the correct image ID.
    await evaluate(`document.querySelector('#image a').href = 'https://civitai.green/videos/42'`);
    await evaluate(`click('image', '.toggle')`);
    await until(`requests.some(r => r.url.includes('/image/42?'))`);
    await evaluate(`const card = document.createElement('div'); card.className='card'; card.id='lazy';
      card.innerHTML='<a href="https://civitai.green/images/43"><img src="https://image.civitai.com/test/lazy.jpeg"></a>'; document.querySelector('main').append(card);`);
    await until(`ui('lazy')`);
    assert.equal(await evaluate(`ui('lazy').querySelector('.month').value`), '2026-09', 'New media must inherit the shared month');
    await evaluate(`document.querySelector('#lazy').remove()`);
    await until(`document.querySelectorAll('.civ-media-analytics').length === 2`);

    // Full-size viewer follows direct and query image URLs, even without DOM changes.
    // Local test host is rewritten only in the test copy of mediaId below.
    await evaluate(`history.replaceState({}, '', '/images/99');
      const viewer = document.createElement('div'); viewer.id='viewer'; viewer.setAttribute('role','dialog');
      viewer.innerHTML='<div><img src="https://image.civitai.com/test/full.jpeg"></div>'; document.body.append(viewer);`);
    await until(`ui('viewer')`);
    await evaluate(`click('viewer', '.toggle')`);
    await until(`requests.some(r => r.url.includes('/image/99?'))`);
    await evaluate(`history.replaceState({}, '', '/models/1?imageId=100')`);
    await until(`ui('viewer').querySelector('.panel').hidden`);
    await evaluate(`click('viewer', '.toggle')`);
    await until(`requests.some(r => r.url.includes('/image/100?'))`);
    // A late response for an old month must not replace the selected month.
    await evaluate(`delay=200; month('viewer','2026-07'); delay=5; month('viewer','2026-08')`);
    await until(`ui('viewer').querySelector('.chart svg')`);
    await evaluate(`new Promise(resolve => setTimeout(resolve, 250))`);
    assert.equal(await evaluate(`ui('viewer').querySelector('.studio').href`), 'https://creator-studio.civitai.com/analytics/content/image/100?month=2026-08');
    assert.equal(await evaluate(`ui('viewer').querySelector('.total').textContent`), '27,528 this month', 'A slow old month cannot replace the new chart');
    await evaluate(`ui('viewer').querySelector('.toggle').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,composed:true}))`);
    assert.equal(await evaluate(`ui('viewer').querySelector('.panel').hidden`), true);

    // Global month changes refresh all open media and leave closed panels lazy.
    const beforeGlobalChange = await evaluate('requests.length');
    await evaluate(`month('image', '2026-05')`);
    await until(`ui('image').querySelectorAll('.chart svg').length === 3 && ui('video').querySelectorAll('.chart svg').length === 3`);
    assert.deepEqual(await evaluate(`requests.slice(${beforeGlobalChange}).map(r => [new URL(r.url).pathname.split('/').at(-1), r.month]).sort()`),
      [['143710065', '2026-05'], ['42', '2026-05']], 'Only the two open panels should request the new month');
    assert.deepEqual(await evaluate(`['image','video','viewer'].map(id => ui(id).querySelector('.month').value)`),
      ['2026-05', '2026-05', '2026-05']);
    assert.equal(await evaluate(`ui('viewer').querySelector('.studio').href`), 'https://creator-studio.civitai.com/analytics/content/image/100?month=2026-05');

    // A separate tab restores the saved month before it opens any panel.
    const { targetId: secondTarget } = await cdp('Target.createTarget', { url: 'about:blank' });
    const { sessionId: secondSession } = await cdp('Target.attachToTarget', { targetId: secondTarget, flatten: true });
    await cdp('Network.enable', {}, secondSession);
    await cdp('Network.setBlockedURLs', { urls: ['*://image.civitai.com/*'] }, secondSession);
    await cdp('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/` }, secondSession);
    await until(`document.querySelector('#video .civ-media-analytics')?.shadowRoot.querySelector('.month').value === '2026-05'`, secondSession);
    assert.equal(await evaluate('requests.length', secondSession), 0, 'Restoring the saved month must not fetch hidden panels');
    await evaluate(`document.querySelector('#video .civ-media-analytics').shadowRoot.querySelector('.toggle').click()`, secondSession);
    await until(`document.querySelector('#video .civ-media-analytics').shadowRoot.querySelectorAll('.chart svg').length === 3`, secondSession);
    await evaluate(`month('video', '2026-04')`);
    await until(`document.querySelector('#video .civ-media-analytics').shadowRoot.querySelector('.month').value === '2026-04'
      && requests.at(-1)?.month === '2026-04'
      && document.querySelector('#video .civ-media-analytics').shadowRoot.querySelectorAll('.chart svg').length === 3`, secondSession);
    assert.equal(await evaluate('storageWrites.length', secondSession), 0, 'Receiving a remote month must not write it back in a loop');
    await until(`ui('image').querySelectorAll('.chart svg').length === 3 && ui('video').querySelectorAll('.chart svg').length === 3`);
    await evaluate(`month('video', '')`);
    assert.equal(await evaluate(`ui('video').querySelector('.month').value`), '2026-04', 'Clearing a month must restore the shared selection');
    assert.equal(await evaluate(`GM_getValue('civitai-media-analytics-month')`), '2026-04');

    await cdp('Page.enable', {}, secondSession);
    await cdp('Page.reload', {}, secondSession);
    await until(`document.querySelector('#video .civ-media-analytics')?.shadowRoot.querySelector('.month').value === '2026-04'`, secondSession);
    assert.equal(await evaluate('requests.length', secondSession), 0, 'Reloading must preserve the month without fetching');
    console.log('PASS: synchronized date cursors and values from every graph, aligned axes, zero/missing counts, cursor cleanup, persistent global month, cross-tab updates, stacked graphs, hover, exact series, caching, errors, safe parsing, viewer navigation, stale responses, all domains');
  } finally {
    chrome.kill();
    await new Promise(resolve => chrome.once('exit', resolve));
    server.close();
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
