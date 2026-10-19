// Run: node tests/test_vast_real_cost.cjs
// Local Chrome fixtures; no Vast.ai access or extra npm dependencies.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const source = fs.readFileSync(path.join(__dirname, '../vast_real_cost.user.js'));
const fixture = fs.readFileSync(path.join(__dirname, 'vast_real_cost_fixture.html'));
const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', req.url === '/userscript.js' ? 'text/javascript' : 'text/html');
  res.end(req.url === '/userscript.js' ? source : fixture);
});

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'vast-real-cost-test-'));
  const chrome = spawn(process.env.CHROME || 'google-chrome', [
    '--headless', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    '--no-first-run', '--disable-background-networking', '--remote-debugging-pipe',
    `--user-data-dir=${profile}`, 'about:blank',
  ], { stdio:['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
  let seq = 0, buffer = '', stderr = '';
  const pending = new Map();
  chrome.stderr.on('data', data => { stderr += data; });
  chrome.stdio[4].on('data', data => {
    buffer += data;
    let end;
    while ((end = buffer.indexOf('\0')) >= 0) {
      const message = JSON.parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
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
    for (const mode of ['gm', 'fallback', 'gm-throws', 'gm-volatile', 'local-blocked']) {
      const { browserContextId } = await cdp('Target.createBrowserContext');
      const { targetId } = await cdp('Target.createTarget', {
        url:`http://127.0.0.1:${server.address().port}/?${mode}`, browserContextId,
      });
      const { sessionId } = await cdp('Target.attachToTarget', { targetId, flatten:true });
      await cdp('Emulation.setDeviceMetricsOverride', {
        width:1280, height:900, deviceScaleFactor:1, mobile:false,
      }, sessionId);
      const evaluate = async expression => {
        const result = await cdp('Runtime.evaluate', {
          expression, returnByValue:true, awaitPromise:true,
        }, sessionId);
        assert(!result.exceptionDetails, JSON.stringify(result.exceptionDetails));
        return result.result?.value;
      };
      const until = async expression => {
        assert(await evaluate(`new Promise(resolve => {
          const deadline = Date.now() + 4000;
          const poll = () => {
            if (${expression}) return resolve(true);
            if (Date.now() > deadline) return resolve(false);
            setTimeout(poll, 25);
          }; poll();
        })`), `Timed out: ${expression}`);
      };
      const ready = () => until(`document.querySelectorAll('.vrc-costs:not(.vrc-pending)').length === 5`);
      await ready();
      await evaluate(`window.rows = () => [...document.querySelectorAll('[data-aid="RowElement"]')];
        window.ranks = hours => rows().map(row => row.querySelector('.vrc-costs').getAttribute('data-vrc-rank-' + hours));
        window.geometry = () => [...rows()[0].querySelectorAll('.fixed-layout, .fixed-layout > *, .button-hover > *, .vrc-costs')].map(node => {
          const r = node.getBoundingClientRect(); return [r.x, r.y, r.width, r.height];
        });`);
      const originalGeometry = await evaluate('geometry()');
      assert.deepEqual(await evaluate('ranks(2)'), ['1', '2', '3', null, null]);
      // Hiding a machine hides both its offers and promotes the next prices.
      await evaluate(`window.rowClicks = 0; rows()[0].onclick = () => rowClicks++;
        rows()[0].querySelector('.vrc-hide-machine').click()`);
      await until(`rows().filter(row => getComputedStyle(row).display === 'none').length === 2`);
      assert.equal(await evaluate('rowClicks'), 0, 'Hide must not trigger the card action');
      for (const hours of [2, 4]) assert.deepEqual(await evaluate(`ranks(${hours})`), [null, null, '1', '2', '3']);
      assert.equal(await evaluate(`document.querySelector('.vrc-hidden-toggle').textContent`), 'Show hidden (1)');
      await evaluate(`document.querySelector('.vrc-hidden-toggle').click()`);
      await until(`rows().every(row => getComputedStyle(row).display !== 'none')`);
      assert.deepEqual(await evaluate('geometry()'), originalGeometry, 'Revealing must preserve all card geometry');
      assert.equal(await evaluate(`rows()[0].querySelector('.vrc-hide-machine').textContent`), 'Unhide');
      for (const hours of [2, 4]) assert.deepEqual(await evaluate(`ranks(${hours})`), [null, null, '1', '2', '3']);
      assert.equal(await evaluate(`(() => {
        const row = rows()[0], button = row.querySelector('.vrc-hide-machine').getBoundingClientRect();
        const rent = row.querySelector('.rent-button').getBoundingClientRect();
        const panel = row.querySelector('.rentable-card').getBoundingClientRect();
        return button.bottom + 6 <= rent.top && button.top >= panel.top && button.right <= panel.right;
      })()`), true, 'Hide control must fit above Rent with a clear gap');
      // Use real pointer clicks: DOM .click() alone would miss overlapping hit areas.
      await evaluate(`window.rentClicks = 0;
        rows()[0].querySelector('.rent-button').onclick = () => rentClicks++`);
      for (const selector of ['.rent-button', '.vrc-hide-machine']) {
        const point = await evaluate(`(() => {
          const button = rows()[0].querySelector('${selector}');
          const rect = button.getBoundingClientRect();
          const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
          return {x, y, hit:document.elementFromPoint(x, y) === button};
        })()`);
        assert.equal(point.hit, true, `${selector} must receive its own pointer clicks`);
        await cdp('Input.dispatchMouseEvent', {type:'mousePressed', x:point.x, y:point.y, button:'left', clickCount:1}, sessionId);
        await cdp('Input.dispatchMouseEvent', {type:'mouseReleased', x:point.x, y:point.y, button:'left', clickCount:1}, sessionId);
      }
      await until(`rows()[0].querySelector('.vrc-hide-machine').textContent === 'Hide'`);
      assert.equal(await evaluate('rentClicks'), 1, 'Only the Rent click should trigger renting');
      // Restore the hidden state used by the remaining persistence checks.
      await evaluate(`rows()[0].querySelector('.vrc-hide-machine').click()`);
      await until(`rows()[0].querySelector('.vrc-hide-machine').textContent === 'Unhide'`);
      // Replacement cards retain hidden state; replacing the menu repairs its toggle.
      await evaluate(`draw(); document.querySelector('.sort-info').innerHTML = '<div data-aid="SearchPageGpuButtons">#GPUs: Any</div>'`);
      await ready();
      await until(`document.querySelector('.vrc-hidden-toggle')?.textContent === 'Hide hidden (1)'`);
      assert.deepEqual(await evaluate('ranks(2)'), [null, null, '1', '2', '3']);
      // Reused DOM rows must bind the hide control to their current machine ID.
      await evaluate(`rows()[0].querySelector('[data-testid="machine-id"] span').textContent = ' m:300001 '`);
      await until(`rows()[0].querySelector('.vrc-hide-machine').getAttribute('aria-label') === 'Hide machine 300001'`);
      await evaluate(`rows()[0].querySelector('.vrc-hide-machine').click()`);
      await until(`document.querySelector('.vrc-hidden-toggle').textContent === 'Hide hidden (2)'`);
      const stored = ['gm', 'local-blocked'].includes(mode) ? 'gm:vast-real-cost-hidden-machines-v1' : 'vast-real-cost-hidden-machines-v1';
      assert.deepEqual(await evaluate(`JSON.parse(localStorage.getItem('${stored}')).sort()`), ['142650', '300001']);
      if (mode === 'gm') {
        assert.deepEqual(await evaluate(`JSON.parse(localStorage.getItem('vast-real-cost-hidden-machines-v1')).sort()`),
          ['142650', '300001'], 'Always keep the browser backup, even when GM storage works');
        // Recover the existing userscript list if the browser backup is removed.
        await evaluate(`localStorage.removeItem('vast-real-cost-hidden-machines-v1')`);
      }
      await cdp('Page.reload', {}, sessionId);
      await until(`document.querySelector('.vrc-hidden-toggle')?.textContent === 'Show hidden (2)'`);
      await until(`document.querySelectorAll('.vrc-machine-collapsed').length === 2`);
      await evaluate(`document.querySelector('.vrc-hidden-toggle').click()`);
      await until(`document.querySelector('.vrc-hide-machine')?.textContent === 'Unhide'`);
      await evaluate(`document.querySelector('.vrc-hide-machine').click()`);
      await until(`document.querySelector('.vrc-hidden-toggle').textContent === 'Hide hidden (1)'`);
      assert.deepEqual(await evaluate(`JSON.parse(localStorage.getItem('${stored}'))`), ['300001']);
      await until(`document.querySelector('.vrc-costs').getAttribute('data-vrc-rank-2') === '1'`);
      // Self-generated changes must settle; no animation-frame observer loop.
      assert.equal(await evaluate(`new Promise(resolve => {
        let changes = 0;
        const observer = new MutationObserver(() => changes++);
        observer.observe(document.body, {childList:true, subtree:true, characterData:true});
        setTimeout(() => { observer.disconnect(); resolve(changes); }, 150);
      })`), 0);
      // Unhiding must also survive a later visit, without reviving old saved IDs.
      await cdp('Page.navigate', {url:`http://127.0.0.1:${server.address().port}/?${mode}&revisit`}, sessionId);
      await until(`document.querySelector('.vrc-hidden-toggle')?.textContent === 'Show hidden (1)'`);
      await until(`document.querySelectorAll('.vrc-hide-machine').length === 5`);
      assert.equal(await evaluate(`document.querySelectorAll('.vrc-machine-collapsed').length`), 0);
      assert.deepEqual(await evaluate(`JSON.parse(localStorage.getItem('${stored}'))`), ['300001']);
      if (mode === 'gm') {
        assert.equal(await evaluate(`document.querySelector('.vrc-refresh-enabled').checked`), true);
        assert.equal(await evaluate(`document.querySelector('.vrc-refresh-seconds').value`), '15');
        assert.deepEqual(await evaluate(`[...autoRefreshTimers.values()].map(timer => timer.delay)`), [15000]);
        await evaluate(`const interval = document.querySelector('.vrc-refresh-seconds');
          interval.value = '17'; interval.dispatchEvent(new Event('change', {bubbles:true}));
          document.querySelector('.vrc-hide-machine').click()`);
        await until(`document.querySelectorAll('.vrc-machine-collapsed').length === 2`);
        const previousTotal = await evaluate(`document.querySelectorAll('.vrc-costs')[2].textContent`);
        assert.deepEqual(await evaluate(`[...autoRefreshTimers.values()].map(timer => timer.delay)`), [17000]);
        await evaluate('fireAutoRefresh()');
        await until(`refreshRequests === 1 && document.querySelector('.vrc-refresh-status').textContent.startsWith('Updated')`);
        await until(`document.querySelectorAll('.vrc-machine-collapsed').length === 2`);
        assert.notEqual(await evaluate(`document.querySelectorAll('.vrc-costs')[2].textContent`), previousTotal,
          'Refreshing must update the native offers and cost calculations');
        assert.equal(await evaluate(`[...document.querySelectorAll('.vrc-machine-collapsed')]
          .some(row => row.querySelector('.vrc-costs')?.hasAttribute('data-vrc-rank-2'))`), false);
        assert.deepEqual(await evaluate('lastRefreshFilter'), {queryKey:['bundles'], type:'active'});
        assert.deepEqual(await evaluate('lastRefreshOptions'), {throwOnError:true});
        // Manual refresh remains available when automatic refresh is disabled.
        await evaluate(`document.querySelector('.vrc-refresh-enabled').click();
          window.refreshHold = true; document.querySelector('.vrc-refresh-now').click()`);
        await until(`refreshRequests === 2 && document.querySelector('.vrc-refresh-now').disabled`);
        assert.equal(await evaluate('autoRefreshTimers.size'), 0);
        await evaluate(`document.querySelector('.vrc-refresh-now').click()`);
        assert.equal(await evaluate('refreshRequests'), 2, 'Prevent overlapping refreshes');
        await evaluate(`window.refreshHold = false; releaseRefresh()`);
        await until(`!document.querySelector('.vrc-refresh-now').disabled`);
        // Failures must release the button and allow a successful retry.
        await evaluate(`window.refreshFailure = true; document.querySelector('.vrc-refresh-now').click()`);
        await until(`document.querySelector('.vrc-refresh-status').textContent === 'Refresh failed. Try again.'`);
        assert.equal(await evaluate('refreshRequests'), 3);
        await evaluate(`window.refreshFailure = false; document.querySelector('.vrc-refresh-now').click()`);
        await until(`refreshRequests === 4 && document.querySelector('.vrc-refresh-status').textContent.startsWith('Updated')`);
        await evaluate(`window.savedClient = window.__TANSTACK_QUERY_CLIENT__;
          delete window.__TANSTACK_QUERY_CLIENT__;
          document.querySelector('.vrc-refresh-now').click()`);
        await until(`document.querySelector('.vrc-refresh-status').textContent === 'Search not ready. Try again.'`);
        assert.equal(await evaluate('refreshRequests'), 4, 'Do not bypass Vast when its query is unavailable');
        await evaluate(`window.__TANSTACK_QUERY_CLIENT__ = savedClient;
          document.querySelector('.vrc-refresh-enabled').click();
          Object.defineProperty(document, 'visibilityState', {configurable:true, value:'hidden'});
          fireAutoRefresh()`);
        assert.equal(await evaluate('refreshRequests'), 4, 'Skip background refreshes');
        await evaluate(`delete document.visibilityState;
          Object.defineProperty(navigator, 'onLine', {configurable:true, value:false}); fireAutoRefresh()`);
        assert.equal(await evaluate('refreshRequests'), 4, 'Skip offline refreshes');
        await evaluate(`delete navigator.onLine; fireAutoRefresh()`);
        await until(`refreshRequests === 5 && document.querySelector('.vrc-refresh-status').textContent.startsWith('Updated')`);
        await evaluate(`document.querySelector('.vrc-refresh-enabled').click()`);
        await cdp('Page.reload', {}, sessionId);
        await until(`document.querySelector('.vrc-refresh-seconds')?.value === '17'`);
        assert.equal(await evaluate(`document.querySelector('.vrc-refresh-enabled').checked`), false);
        assert.equal(await evaluate('autoRefreshTimers.size'), 0, 'Remember the disabled setting after reload');
        console.log('PASS refresh: 15s default, saved interval/toggle, native data updates, hidden ranks, manual refresh, concurrency, errors, background/offline');
      }
      await cdp('Target.disposeBrowserContext', { browserContextId });
      console.log(`PASS ${mode}: machine hiding, ranking, layout, rerenders, row reuse, persistence, unhide, stable DOM`);
    }
  } finally {
    chrome.kill();
    await new Promise(resolve => chrome.once('exit', resolve));
    server.close();
    fs.rmSync(profile, { recursive:true, force:true, maxRetries:10, retryDelay:100 });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
