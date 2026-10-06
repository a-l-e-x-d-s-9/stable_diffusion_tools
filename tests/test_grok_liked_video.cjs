// Run: node tests/test_grok_liked_video.cjs
// Real browser fixtures, no packages or Grok access required.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
let source = fs.readFileSync(path.join(__dirname, '../grok_liked_image_to_video_generator.user.js'), 'utf8');
// Accelerate waits only in the served test copy.
for (const [old, replacement] of [
    ['const POLL = 250', 'const POLL = 10'], ['const LOAD_WAIT = 1400', 'const LOAD_WAIT = 40'],
    ['const TIMEOUT = 30000', 'const TIMEOUT = 1500'], ['delay: 15', 'delay: 0.15'],
    ['sleep(900)', 'sleep(30)'], ['sleep(300)', 'sleep(10)'],
]) { assert(source.includes(old)); source = source.replaceAll(old, replacement); }
const fixture = fs.readFileSync(path.join(__dirname, 'grok_liked_video_fixture.html'));
const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', req.url === '/userscript.js' ? 'text/javascript' : 'text/html');
    res.end(req.url === '/userscript.js' ? source : fixture);
});
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

(async () => {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-liked-test-'));
    const chrome = spawn(process.env.CHROME || 'google-chrome', [
        '--headless', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
        '--no-first-run', '--disable-background-networking', '--remote-debugging-pipe',
        `--user-data-dir=${profile}`, 'about:blank',
    ], { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
    let seq = 0;
    let buffer = '';
    let stderr = '';
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
            const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}; ${stderr.slice(-500)}`)); }, 5000);
            pending.set(id, { resolve, reject, timer });
            chrome.stdio[3].write(JSON.stringify({ id, method, params, sessionId }) + '\0');
        });
    }
    try {
        const scenarios = process.argv.length > 2 ? process.argv.slice(2) : ['normal', 'picked', 'limit', 'pause', 'reload', 'full-navigation', 'quota', 'disabled',
            'route-change', 'lingering-menu', 'hidden-back', 'delayed-back', 'redirect-back', 'status-progress',
            'two-final', 'slow-return', 'stalled-back', 'lazy-return', 'restart', 'ui'];
        for (const scenario of scenarios) {
            const { browserContextId } = await cdp('Target.createBrowserContext');
            const { targetId } = await cdp('Target.createTarget', {
                url: `http://127.0.0.1:${server.address().port}/imagine/saved/liked?case=${scenario}`, browserContextId,
            });
            const { sessionId } = await cdp('Target.attachToTarget', { targetId, flatten: true });
            const evaluate = async expression => {
                const data = await cdp('Runtime.evaluate', { expression, returnByValue: true }, sessionId);
                assert(!data.exceptionDetails, JSON.stringify(data.exceptionDetails));
                return data.result?.value;
            };
            if (scenario === 'ui') {
                await sleep(200);
                await evaluate(`window.root = document.querySelector('#grok-liked-video-panel').shadowRoot;
                    root.getElementById('pick').click(); document.querySelector('a[href="/imagine/post/2"]').click();`);
                assert.equal(await evaluate('document.querySelector("[data-grok-liked-start]")?.dataset.grokLikedStart'), '2');
                assert.equal(await evaluate('root.getElementById("preview").hidden'), false);
                assert.equal(await evaluate('location.pathname'), '/imagine/saved/liked');
                // Recycle the selected card, as a virtualized gallery does.
                await evaluate(`document.querySelector('[data-grok-liked-start]').parentElement.outerHTML = card(2)`);
                await sleep(100);
                assert.equal(await evaluate('document.querySelector("[data-grok-liked-start]")?.dataset.grokLikedStart'), '2');
                const before = await evaluate(`JSON.stringify(root.getElementById('head').getBoundingClientRect())`);
                const rect = JSON.parse(before);
                await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x + 30, y: rect.y + 15, button: 'left', clickCount: 1 }, sessionId);
                await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 70, y: 50, button: 'left', buttons: 1 }, sessionId);
                await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 70, y: 50, button: 'left', clickCount: 1 }, sessionId);
                const position = await evaluate('localStorage.getItem("grok-liked-post-video-v1-panel")');
                assert(Math.abs(JSON.parse(position).left - 40) < 2, position);
                await cdp('Page.reload', {}, sessionId);
                await sleep(200);
                assert.equal(await evaluate('localStorage.getItem("grok-liked-post-video-v1-panel")'), position);
                assert(Math.abs(await evaluate('document.querySelector("#grok-liked-video-panel").getBoundingClientRect().left') - 40) < 2);
                await evaluate(`window.root = document.querySelector('#grok-liked-video-panel').shadowRoot; root.getElementById('minimize').click()`);
                assert.equal(await evaluate('getComputedStyle(root.querySelector(".body")).display'), 'none');
                await evaluate(`root.getElementById('minimize').click(); root.getElementById('clear').click()`);
                assert.equal(await evaluate('document.querySelectorAll("[data-grok-liked-start]").length'), 0);
                assert.equal(await evaluate('root.getElementById("preview").hidden'), true);
                const screenshot = await cdp('Page.captureScreenshot', {}, sessionId);
                fs.writeFileSync('/tmp/grok-liked-panel.png', Buffer.from(screenshot.data, 'base64'));
                console.log('PASS ui: marker, recycled card, preview, drag, saved position, minimize, clear');
                await cdp('Target.disposeBrowserContext', { browserContextId });
                continue;
            }
            let result;
            const deadline = Date.now() + 20000;
            while (Date.now() < deadline) {
                await sleep(100);
                const data = await cdp('Runtime.evaluate', {
                    expression: 'document.querySelector("#result")?.textContent', returnByValue: true,
                }, sessionId);
                const value = data.result?.value;
                if (value && value !== 'RUNNING') { result = JSON.parse(value); break; }
            }
            if (!result) {
                const debug = await cdp('Runtime.evaluate', {
                    expression: 'JSON.stringify({path:location.pathname,state:sessionStorage.getItem("grok-liked-post-video-v1"),body:document.body.innerText})',
                    returnByValue: true,
                }, sessionId);
                throw new Error(`${scenario} timed out: ${debug.result?.value}`);
            }
            assert(result.ok, JSON.stringify(result));
            assert.equal(result.escapes, 0, 'Must never send Escape to the page');
            if (!['full-navigation', 'reload'].includes(scenario)) assert.equal(result.loads, 1, 'Must not force a reload');
            if (!['quota', 'disabled', 'stalled-back'].includes(scenario)) {
                const expectedBacks = scenario === 'picked' ? 5 : ['limit', 'two-final'].includes(scenario) ? 1 : 7;
                assert.equal(result.backs, expectedBacks, `Back clicks: ${JSON.stringify(result)}`);
                assert.equal(result.path, `/imagine/post/${scenario === 'route-change' ? 'generated-' : ''}${result.hits.at(-1)}`, 'Final post must stay open');
                await sleep(300);
                assert.equal(await evaluate('location.pathname'), result.path, 'Must not navigate after finishing');
                assert.equal(await evaluate('Number(sessionStorage.backs)'), expectedBacks);
            }
            if (scenario === 'restart') {
                await evaluate(`history.pushState({}, '', '/imagine/saved/liked'); draw()`);
                await sleep(100);
                await evaluate(`window.root = document.querySelector('#grok-liked-video-panel').shadowRoot;
                    root.getElementById('limit').value = 1;
                    root.getElementById('limit').dispatchEvent(new Event('change'));
                    root.getElementById('pick').click();
                    document.querySelector('a[href="/imagine/post/2"]').click()`);
                assert.equal(await evaluate('root.getElementById("start").textContent'), 'Start');
                assert.equal(await evaluate('root.getElementById("start").disabled'), false);
                let checkpoint = JSON.parse(await evaluate('sessionStorage.getItem("grok-liked-post-video-v1")'));
                assert.equal(checkpoint.phase, 'idle');
                assert.equal(checkpoint.picked, '2');
                assert.equal(checkpoint.limit, 1);
                assert.deepEqual(checkpoint.attempted, []);
                await evaluate('root.getElementById("start").click()');
                const restartDeadline = Date.now() + 5000;
                do {
                    await sleep(100);
                    checkpoint = JSON.parse(await evaluate('sessionStorage.getItem("grok-liked-post-video-v1")'));
                } while (checkpoint.phase !== 'done' && Date.now() < restartDeadline);
                assert.equal(checkpoint.phase, 'done');
                assert.deepEqual(checkpoint.attempted, ['2']);
                assert.deepEqual(await evaluate('hits()'), [...result.hits, 2]);
                await evaluate(`root.getElementById('clear').click()`);
                assert.equal(await evaluate('root.getElementById("start").disabled'), false);
                assert.equal(await evaluate('root.getElementById("start").textContent'), 'Start');
                console.log('PASS restart: completed → pick → Start → new submission; Clear pick also re-arms Start');
            } else console.log(`PASS ${scenario}: ${JSON.stringify(result.hits)}`);
            await cdp('Target.disposeBrowserContext', { browserContextId });
        }
    } finally {
        chrome.kill();
        await new Promise(resolve => chrome.once('close', resolve));
        server.close();
        fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
    }
})().catch(error => { console.error(error); process.exitCode = 1; server.close(); });
