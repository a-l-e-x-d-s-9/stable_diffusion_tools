// Run: node tests/test_civitai_reactions.cjs
// Uses headless Chrome and local fixtures; never contacts or reacts on Civitai.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const source = fs.readFileSync(path.join(__dirname, '../civitai_add_reactions.user.js'));
const settleDelay = Number(source.toString().match(/const SETTLE_DELAY = (\d+)/)[1]);
const fixture = fs.readFileSync(path.join(__dirname, 'civitai_reactions_fixture.html'));
const references = Object.fromEntries(['post', 'viewer'].map(name =>
  [`/references/${name}.html`, fs.readFileSync(path.join(__dirname, `fixtures/civitai/${name}.html`))]));
const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', req.url === '/userscript.js' ? 'text/javascript' : 'text/html');
  res.end(req.url === '/userscript.js' ? source : references[req.url] || fixture);
});
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'civitai-reactions-test-'));
  const chrome = spawn(process.env.CHROME || 'google-chrome', [
    '--headless', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    '--no-first-run', '--disable-background-networking', '--remote-debugging-pipe',
    '--window-size=1100,800', `--user-data-dir=${profile}`, 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
  let seq = 0, buffer = '', stderr = '';
  const pending = new Map();
  chrome.stderr.on('data', data => { stderr += data; });
  chrome.stdio[4].on('data', data => {
    buffer += data;
    let end;
    while ((end = buffer.indexOf('\0')) >= 0) {
      const message = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
      if (!pending.has(message.id)) continue;
      const { resolve, reject, timer } = pending.get(message.id);
      pending.delete(message.id); clearTimeout(timer);
      if (message.error) reject(new Error(JSON.stringify(message.error))); else resolve(message.result);
    }
  });
  function cdp(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
      const id = ++seq;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out: ${stderr.slice(-500)}`)); }, 10000);
      pending.set(id, { resolve, reject, timer });
      chrome.stdio[3].write(JSON.stringify({ id, method, params, sessionId }) + '\0');
    });
  }
  try {
    const scenarios = process.argv.slice(2);
    for (const scenario of scenarios.length ? scenarios : [
      'gallery', 'header', 'indicator', 'missing', 'delayed', 'loop', 'middle', 'single', 'video',
      'model', 'post', 'viewer', 'viewer-embla', 'viewer-query', 'viewer-page',
      'no-hover', 'outside', 'typing', 'editable', 'overlap', 'scrolled', 'navigate',
      'custom-style', 'stalled', 'viewer-loading',
      'post-scroll', 'post-reference', 'viewer-reference',
      'concurrent', 'concurrent-scroll', 'concurrent-restart', 'concurrent-missing', 'concurrent-navigate',
    ]) {
      const { browserContextId } = await cdp('Target.createBrowserContext');
      const { targetId } = await cdp('Target.createTarget', {
        url: `http://127.0.0.1:${server.address().port}/?case=${scenario}`, browserContextId,
      });
      const { sessionId } = await cdp('Target.attachToTarget', { targetId, flatten: true });
      const evaluate = async expression => {
        const data = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
        assert(!data.exceptionDetails, JSON.stringify(data.exceptionDetails));
        return data.result?.value;
      };
      await evaluate(`new Promise(resolve => { const poll = () => document.querySelector('#app button') ? resolve() : setTimeout(poll, 20); poll(); })`);
      await sleep(100);
      if (scenario.startsWith('concurrent')) {
        const shortcut = `new KeyboardEvent('keydown', {key:'S',ctrlKey:true,shiftKey:true,bubbles:true})`;
        const hover = card => evaluate(`{
          const rect = document.querySelector('[data-card="${card}"] img').getBoundingClientRect();
          window.dispatchEvent(new PointerEvent('pointermove', {clientX:rect.left+20,clientY:rect.top+10}));
        }`);
        const until = async (expression, timeout = 10000) => {
          const deadline = Date.now() + timeout;
          while (Date.now() < deadline) {
            if (await evaluate(expression)) return;
            await sleep(30);
          }
          assert.fail(`${scenario}: timed out waiting for ${expression}; ${JSON.stringify(await evaluate('({hits,arrows})'))}`);
        };
        await hover('selected');
        await evaluate(`window.dispatchEvent(${shortcut})`);
        await until(`arrows.includes('selected')`);
        assert.equal(await evaluate(`hits.includes('12:Like')`), false, 'First post must still be waiting');
        // Root discovery may return a smaller scope when an arrow is hidden.
        // Neither that change nor repeated keys may start overlapping workers.
        await evaluate(`document.querySelector('[data-card="selected"] .next').style.display = 'none';
          window.dispatchEvent(${shortcut}); window.dispatchEvent(${shortcut});
          document.querySelector('[data-card="selected"] .next').style.display = ''`);
        assert.equal(await evaluate(`hits.includes('12:Like')`), false, 'Nested scopes must share a lock');
        if (scenario === 'concurrent-scroll') {
          await evaluate(`document.querySelector('#gallery').scrollTop = document.querySelector('[data-card="unrelated"]').offsetTop`);
        }
        await hover('unrelated');
        if (scenario === 'concurrent-navigate') {
          await evaluate(`window.dispatchEvent(${shortcut}); history.pushState({}, '', '/models/2')`);
          await sleep(200);
          assert.deepEqual(await evaluate('hits'), ['11:Like', '11:Heart', '21:Like'], 'Navigation must stop both workers');
          // Both locks must release on cancellation so a new request can start.
          await hover('selected');
          await evaluate(`window.dispatchEvent(${shortcut})`);
          await hover('unrelated');
          await evaluate(`window.dispatchEvent(${shortcut})`);
        } else {
          await evaluate(`window.dispatchEvent(${shortcut}); window.dispatchEvent(${shortcut})`);
          await until(`hits.includes('21:Like')`, 750);
          assert.equal(await evaluate(`hits.includes('13:Heart')`), false, 'Second post must start while the first is active');
        }
        if (scenario === 'concurrent-restart') {
          await until(`hits.includes('22:Heart')`);
          await sleep(150);
          assert.equal(await evaluate(`hits.includes('13:Heart')`), false, 'First post must still be active when the second finishes');
          await evaluate(`document.querySelector('[data-card="unrelated"] .indicators button').click();
            window.dispatchEvent(${shortcut})`);
          await until(`arrows.filter(card => card === 'unrelated').length === 2`, 750);
        }
        await until(`hits.includes('13:Heart') && hits.includes('22:Heart')`);
        await sleep(settleDelay + 350);
        const result = await evaluate('({hits,arrows,events,active:[...active]})');
        const expected = [11, 12, 13, 21, 22].flatMap(id => [`${id}:Like`, `${id}:Heart`]);
        assert.deepEqual([...result.hits].sort(), [...expected].sort(), `${scenario}: ${JSON.stringify(result)}`);
        assert.equal(new Set(result.hits).size, result.hits.length, 'Concurrent or repeated requests must not toggle reactions off');
        assert.equal(result.arrows.filter(card => card === 'selected').length, 2);
        assert.equal(result.arrows.filter(card => card === 'unrelated').length, scenario === 'concurrent-restart' ? 2 : 1);
        assert.equal(result.active.length, expected.length);
        if (scenario !== 'concurrent-navigate') {
          const arrow = result.events.find(event => event.type === 'arrow' && event.card === 'selected');
          const reaction = result.events.find(event => event.key === '12:Like');
          assert(reaction.time - arrow.time >= settleDelay, `Must preserve the configured ${settleDelay} ms viewing delay`);
        }
        console.log(`PASS ${scenario}: concurrent posts, independent locks, ${settleDelay} ms delay`);
        await cdp('Target.disposeBrowserContext', { browserContextId });
        continue;
      }
      const selector = scenario === 'header' ? '.header' : scenario === 'indicator' ? '.indicators button' : scenario === 'model' ? '.model img' : '.card img, .card video';
      if (!['no-hover', 'post', 'post-scroll', 'post-reference', 'viewer-reference'].includes(scenario)) {
        await evaluate(`{
          const rect = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
          window.dispatchEvent(new PointerEvent('pointermove', {clientX:rect.left + 20,clientY:rect.top + 10}));
        }`);
      }
      if (scenario === 'outside') await evaluate(`window.dispatchEvent(new PointerEvent('pointermove', {clientX:950, clientY:600}))`);
      if (scenario === 'scrolled') await evaluate(`document.querySelector('#gallery').style.transform = 'translateY(400px)'`);
      const hotkey = `new KeyboardEvent('keydown', {key:'${scenario === 'header' ? 'X' : 'S'}',ctrlKey:true,shiftKey:true,bubbles:true})`;
      await evaluate(`${scenario === 'typing' ? "document.querySelector('#editor')" : scenario === 'editable' ? "document.querySelector('#editable')" : 'window'}.dispatchEvent(${hotkey})`);
      if (scenario === 'overlap') await evaluate(`window.dispatchEvent(${hotkey}); window.dispatchEvent(new KeyboardEvent('keydown', {key:'S',ctrlKey:true,shiftKey:true,repeat:true}))`);
      if (scenario === 'navigate') await evaluate(`history.pushState({}, '', '/models/2')`);
      const ignored = ['no-hover', 'outside', 'typing', 'editable', 'scrolled', 'viewer-loading'];
      let expected = ignored.includes(scenario) ? [] : scenario === 'model'
        ? ['101:Heart', '102:Like', '102:Heart', '103:Like', '103:Heart', '104:Like', '104:Heart']
        : ['post', 'post-scroll'].includes(scenario) ? [401, 402, 403].flatMap(id => [`${id}:Like`, `${id}:Heart`])
        : ['post-reference', 'viewer-reference'].includes(scenario) ? [144664787, 144664795, 144664796, 144664802].flatMap(id => [`${id}:Like`, `${id}:Heart`])
        : scenario.startsWith('viewer') ? [201, 202, 203].flatMap(id => [`${id}:Like`, `${id}:Heart`])
        : (['single', 'stalled'].includes(scenario) ? [11] : scenario === 'middle' ? [12, 13] : [11, 12, 13]).flatMap(id => [`${id}:Like`, `${id}:Heart`]);
      const expectedArrows = ignored.includes(scenario) || ['single', 'post', 'post-scroll', 'post-reference'].includes(scenario) ? 0 : scenario === 'viewer-reference' ? 4 :
        scenario === 'model' || scenario.startsWith('viewer') || scenario === 'loop' ? 3 : ['middle', 'stalled'].includes(scenario) ? 1 : 2;
      if (scenario === 'navigate') expected = ['11:Like'];
      const deadline = Date.now() + 12000;
      let result;
      do {
        await sleep(100);
        result = await evaluate('({hits, arrows, active:[...active], openAdds})');
      } while (result.hits.length < expected.length && Date.now() < deadline);
      await sleep(scenario === 'stalled' ? 4500 : Math.max(900, settleDelay + 350));
      result = await evaluate('({hits, arrows, active:[...active], openAdds})');
      assert.deepEqual(result.hits, expected, `${scenario}: ${JSON.stringify(result)}`);
      assert.equal(result.arrows.length, scenario === 'navigate' ? 0 : expectedArrows, `${scenario}: ${JSON.stringify(result)}`);
      assert(!result.hits.some(key => key.startsWith('21:') || key.startsWith('301:') || key.startsWith('900:')), 'Unrelated cards/comments must stay untouched');
      if (scenario === 'model') assert(result.active.includes('101:Like'), 'Existing reaction must remain active');
      if (['missing', 'post'].includes(scenario)) assert(result.openAdds > 0, 'Must reveal missing reaction buttons');
      console.log(`PASS ${scenario}`);
      await cdp('Target.disposeBrowserContext', { browserContextId });
    }
  } finally {
    chrome.kill();
    await new Promise(resolve => chrome.once('close', resolve));
    server.close();
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
  }
})().catch(error => { console.error(error); process.exitCode = 1; server.close(); });
