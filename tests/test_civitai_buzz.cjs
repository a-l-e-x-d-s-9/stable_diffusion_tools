// Run: node tests/test_civitai_buzz.cjs
// Headless Chrome with local fixtures and mocked API balances; no Civitai access.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const source = fs.readFileSync(path.join(__dirname, '../civitai_top_corner_yellow_buzz_only.user.js'));
const fixture = fs.readFileSync(path.join(__dirname, 'civitai_buzz_fixture.html'));
const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', req.url === '/userscript.js' ? 'text/javascript' : 'text/html');
  res.end(req.url === '/userscript.js' ? source : fixture);
});

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'civitai-buzz-test-'));
  const chrome = spawn(process.env.CHROME || 'google-chrome', [
    '--headless', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    '--no-first-run', '--disable-background-networking', '--remote-debugging-pipe',
    `--user-data-dir=${profile}`, 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
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
    for (const scenario of ['animated', 'static']) {
      const { browserContextId } = await cdp('Target.createBrowserContext');
      const { targetId } = await cdp('Target.createTarget', {
        url: `http://127.0.0.1:${server.address().port}/?${scenario}`, browserContextId,
      });
      const { sessionId } = await cdp('Target.attachToTarget', { targetId, flatten: true });
      const evaluate = async expression => {
        const data = await cdp('Runtime.evaluate', {
          expression, returnByValue: true, awaitPromise: true,
        }, sessionId);
        assert(!data.exceptionDetails, JSON.stringify(data.exceptionDetails));
        return data.result?.value;
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
      const verify = async (formatted, exact, yellow, green) => {
        await until(`document.querySelector('[data-tm-combined-buzz-value]')?.textContent === '${formatted}'`);
        await until(`getComputedStyle(document.querySelector('.UserBuzz__buzzText')).display === 'none'`);
        const result = await evaluate(`(() => {
          const root = document.querySelector('.UserBuzz__userBuzz');
          const text = root.querySelector('[data-tm-combined-buzz-value]');
          const native = root.querySelector('.UserBuzz__buzzText');
          const link = text.closest('a');
          return {
            nativeHidden: getComputedStyle(native).display === 'none',
            visible: text.getBoundingClientRect().width > 0 && text.getBoundingClientRect().height > 0,
            count: root.querySelectorAll('[data-tm-combined-buzz-value]').length,
            title: text.title, label: link.getAttribute('aria-label'), href: link.href,
            backgroundImage: getComputedStyle(text).backgroundImage,
            color: getComputedStyle(text).color,
            textFillColor: getComputedStyle(text).webkitTextFillColor,
            sales: !!root.querySelector('[data-tm-sales-badge]'),
          };
        })()`);
        assert.equal(result.nativeHidden, true, 'The native digits and suffix must all be hidden');
        assert.equal(result.visible, true, 'The combined balance must occupy visible space');
        assert.equal(result.count, 1, 'Repairs must not duplicate the counter');
        assert.equal(result.title, `Combined Buzz: ${exact}\nYellow Buzz: ${yellow}\nGreen Buzz: ${green}`);
        assert.equal(result.label, `Combined Yellow and Green Buzz: ${exact}`);
        assert.equal(result.href, 'https://civitai.red/user/buzz-dashboard');
        assert.equal(result.backgroundImage, 'none');
        assert.equal(result.color, 'rgb(245, 159, 0)');
        assert.equal(result.textFillColor, 'rgb(245, 159, 0)');
        assert.equal(result.sales, true);
      };
      await verify('971k', '970,513', '570,026', '400,487');
      assert.equal(await evaluate('buzzRequests'), 1);
      if (scenario === 'animated') {
        assert.equal(await evaluate(`document.querySelectorAll('.CustomNumberFlow__digit').length`), 4,
          'Keep the native animation DOM intact');
      }
      // A route change can replace the entire account contents.
      await evaluate('renderHeader()');
      await verify('971k', '970,513', '570,026', '400,487');
      // A live balance update can replace only the native number wrapper.
      await evaluate(`document.querySelector('.UserBuzz__buzzText').outerHTML = nativeNumber()`);
      await verify('971k', '970,513', '570,026', '400,487');
      // Spending can reset styles and update the existing native number even
      // while the API cache is fresh. Repair the display and refetch the total.
      await evaluate(`balances.yellow -= 5000;
        document.querySelector('.UserBuzz__userBuzz').style.cssText = '--buzz-gradient: blue; color: blue';
        document.querySelector('.UserBuzz__buzzText').style.cssText = 'display: inline !important';
        changeNativeBalance('953.2k')`);
      await verify('966k', '965,513', '565,026', '400,487');
      assert.equal(await evaluate('buzzRequests'), 2, 'A spend must bypass the fresh cache');
      // Animated digits can change attributes without touching text nodes.
      await evaluate(`balances.green -= 20000;
        const digit = document.querySelector('[data-digit]');
        if (digit) digit.setAttribute('data-digit', '1');
        else changeNativeBalance('933.2k')`);
      await verify('946k', '945,513', '565,026', '380,487');
      assert.equal(await evaluate('buzzRequests'), 3);
      // A second spend during a slow request must queue a new request after
      // the old response, rather than leaving the earlier balance on screen.
      await evaluate(`holdNextBuzzRequest = true; balances.yellow = 500000;
        changeNativeBalance('900k')`);
      await until('buzzRequests === 4 && typeof releaseBuzzRequest === "function"');
      await evaluate(`balances.yellow = 490000; changeNativeBalance('890k');
        new Promise(resolve => setTimeout(resolve, 450))`);
      await evaluate('releaseBuzzRequest()');
      await verify('870k', '870,487', '490,000', '380,487');
      assert.equal(await evaluate('buzzRequests'), 5, 'A spend during a request must not be lost');
      // Animation/style updates alone must repair the UI without polling API.
      await evaluate(`document.querySelector('.UserBuzz__buzzText').style.display = 'inline';
        const stack = document.querySelector('[class*="stack"]');
        if (stack) stack.style.setProperty('--cnf-n', '8')`);
      await verify('870k', '870,487', '490,000', '380,487');
      await evaluate('new Promise(resolve => setTimeout(resolve, 450))');
      assert.equal(await evaluate('buzzRequests'), 5, 'Style repairs must not cause API loops');
      // Fetch fresh balances through the normal visibility refresh, including
      // the serializer variants already supported by the transaction client.
      for (const [format, yellow, green, blue, formatted, exact] of [
        ['devalue', 1200000, 345678, 9000000, '1.546m', '1,545,678'],
        ['plain', 0, 0, 999999, '0', '0'],
      ]) {
        await evaluate(`apiFormat = '${format}'; balances = { yellow: ${yellow}, green: ${green}, blue: ${blue} };
          localStorage.clear();
          Object.defineProperty(document, 'hidden', { configurable: true, value: false });
          document.dispatchEvent(new Event('visibilitychange'))`);
        await verify(formatted, exact, yellow.toLocaleString('en-US'), green.toLocaleString('en-US'));
      }
      // Repeated observer repairs must settle instead of mutating every frame.
      assert.equal(await evaluate(`new Promise(resolve => {
        let changes = 0;
        const observer = new MutationObserver(() => changes++);
        observer.observe(document.querySelector('.UserBuzz__userBuzz'), { childList: true, subtree: true, attributes: true });
        setTimeout(() => { observer.disconnect(); resolve(changes); }, 200);
      })`), 0);
      await cdp('Target.disposeBrowserContext', { browserContextId });
      console.log(`PASS ${scenario}: API sums, solid yellow, rerenders, spending, in-flight spending, zero balance, stable DOM`);
    }
  } finally {
    chrome.kill();
    await new Promise(resolve => chrome.once('exit', resolve));
    server.close();
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
