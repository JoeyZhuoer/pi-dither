// Real Chromium rendering + pointer/keyboard tests. No browser dependencies or provider calls.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { EventEmitter } from 'node:events';
import { createDesktop } from '../desktop/server.mjs';
import { createAgentState } from '../desktop/protocol.mjs';

class BrowserFixture extends EventEmitter {
  constructor({ id, name, kind }) {
    super(); this.state = createAgentState(id, name, kind); this.state.connected = true; this.state.phase = 'idle';
    this.state.model = { provider: 'test', id: 'fixture', name: 'Offline test fixture' };
    this.state.models = [this.state.model]; this.ready = Promise.resolve(); this.calls = [];
  }
  async act(action, input) {
    this.calls.push(action);
    if (action === 'prompt') {
      this.state.messages.push({ id: `u${this.calls.length}`, role: 'user', text: input.message, at: Date.now(), status: 'done' },
        { id: `a${this.calls.length}`, role: 'assistant', text: 'Read-only finding: <img src=x onerror="window.pwned=1">\n```js\nconst ok = true;\n```', at: Date.now(), status: 'done' });
    }
    this.state.revision++; this.emit('change'); return {};
  }
  close() { this.state.connected = false; }
}
const app = process.env.PI_DESKTOP_TEST_URL ? null : await createDesktop({ port: 0, factory: (options) => new BrowserFixture(options) });
const url = process.env.PI_DESKTOP_TEST_URL || app.url;
const profile = await mkdtemp(join(tmpdir(), 'pi-desktop-chrome-'));
const chrome = spawn(process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
  '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
  '--disable-background-networking', '--disable-sync', '--hide-scrollbars', '--window-size=1440,960', 'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] });
let ws, counter = 0, sessionId;
const pending = new Map(), errors = [];
try {
  const endpoint = await new Promise((resolveEndpoint, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`Chrome DevTools did not start: ${output.slice(-1500)}`)), 15000);
    chrome.on('error', (error) => { clearTimeout(timer); reject(error); });
    chrome.on('exit', (code) => { clearTimeout(timer); reject(new Error(`Browser exited before DevTools was available (${code}): ${output.slice(-1500)}`)); });
    chrome.stderr.on('data', (data) => {
      output += data;
      const match = output.match(/DevTools listening on (ws:\/\/\S+)/);
      if (match) { clearTimeout(timer); resolveEndpoint(match[1]); }
    });
  });
  ws = new WebSocket(endpoint);
  await new Promise((resolveOpen, reject) => { ws.addEventListener('open', resolveOpen, { once: true }); ws.addEventListener('error', reject, { once: true }); });
  ws.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data);
    if (message.id) {
      const item = pending.get(message.id); if (!item) return;
      pending.delete(message.id); clearTimeout(item.timer);
      if (message.error) item.reject(new Error(JSON.stringify(message.error))); else item.resolve(message.result);
    }
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.text + ': ' + (message.params.exceptionDetails.exception?.description ?? ''));
    if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') errors.push(message.params.entry.text);
  });
  function rpc(method, params = {}, page = true) {
    const id = ++counter;
    return new Promise((resolveResult, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 12000);
      pending.set(id, { resolve: resolveResult, reject, timer });
      ws.send(JSON.stringify({ id, method, params, ...(page && sessionId ? { sessionId } : {}) }));
    });
  }
  async function evaluate(expression) {
    const result = await rpc('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || 'Browser evaluation failed');
    return result.result.value;
  }
  async function until(expression) {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await evaluate(expression)) return;
      await new Promise((done) => setTimeout(done, 100));
    }
    throw new Error(`Browser condition timed out: ${expression}`);
  }
  const { targetId } = await rpc('Target.createTarget', { url: 'about:blank' }, false);
  ({ sessionId } = await rpc('Target.attachToTarget', { targetId, flatten: true }, false));
  await rpc('Page.enable'); await rpc('Runtime.enable'); await rpc('Log.enable');
  await rpc('Emulation.setDeviceMetricsOverride', { width: 1440, height: 960, deviceScaleFactor: 1, mobile: false });
  await rpc('Page.navigate', { url });
  await until('document.querySelector(".main-window .send")?.disabled === false');
  await evaluate('document.fonts.ready');
  assert.equal(await evaluate('location.hash'), '', 'authorization token removed from address bar');
  assert.equal(await evaluate('document.querySelectorAll(".app-window").length'), 3);
  assert.ok(await evaluate('document.querySelector(".main-window").offsetWidth > Math.max(...Array.from(document.querySelectorAll(".sub-window"),n=>n.offsetWidth))'));
  const original = await evaluate('({x:document.querySelector(".main-window").offsetLeft,y:document.querySelector(".main-window").offsetTop})');
  const title = await evaluate('(()=>{const r=document.querySelector(".main-window .titlebar").getBoundingClientRect();return {x:r.x+100,y:r.y+10}})()');
  for (const [type, x, y] of [['mousePressed', title.x, title.y], ['mouseMoved', title.x + 30, title.y + 20], ['mouseReleased', title.x + 30, title.y + 20]]) {
    await rpc('Input.dispatchMouseEvent', { type, x, y, button: type === 'mouseMoved' ? 'none' : 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 });
  }
  await until(`document.querySelector('.main-window').offsetLeft === ${original.x + 30}`);
  assert.equal(await evaluate('document.querySelector(".main-window").offsetLeft'), original.x + 30);
  const oldWidth = await evaluate('document.querySelector(".main-window").offsetWidth');
  await evaluate('document.querySelector(".main-window .resize-handle").focus()');
  await rpc('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowRight', code: 'ArrowRight' });
  await rpc('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowRight', code: 'ArrowRight' });
  assert.equal(await evaluate('document.querySelector(".main-window").offsetWidth'), oldWidth + 10);
  await evaluate(`document.querySelector('.main-window button[aria-label="Minimize window"]').click()`);
  assert.equal(await evaluate('document.querySelector(".main-window").hidden'), true);
  await evaluate('document.querySelector("#tasks button").click(); document.querySelector("#arrange").click()');
  assert.equal(await evaluate('document.querySelector(".main-window").hidden'), false);
  // Capture a clean, non-synthetic startup view before exercising the fixture conversation.
  await evaluate('document.querySelector("#toast").hidden=true');
  await mkdir(resolve('.local'), { recursive: true });
  const screenshot = await rpc('Page.captureScreenshot', { format: 'png' });
  await writeFile(resolve(`.local/desktop-${app ? 'fixture' : 'live'}.png`), Buffer.from(screenshot.data, 'base64'));
  if (app) {
    await evaluate('document.querySelector(".draft-body textarea").value="Review the architecture"; document.querySelector(".draft-body").requestSubmit()');
    await until('document.querySelectorAll(".child-transfer").length === 1 && document.querySelector(".sub-window .message.assistant") !== null');
    assert.equal(app.sessions.size, 2, 'only explicitly launched child is created');
    assert.equal(await evaluate('window.pwned'), undefined);
    assert.equal(await evaluate('document.querySelectorAll(".message-body img").length'), 0);
    await evaluate('document.querySelector(".child-transfer").click()');
    assert.ok((await evaluate('document.querySelector(".main-window textarea").value')).includes('Read-only finding'));
    assert.equal(app.sessions.get('main').calls.length, 0, 'handoff only inserts a draft');
  }
  await rpc('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await until('innerWidth === 390');
  assert.ok(await evaluate('document.documentElement.scrollWidth <= innerWidth'), 'mobile view has no horizontal overflow');
  assert.deepEqual(errors, [], 'no browser script, resource or CSP errors');
  console.log(`PASS: ${app ? 'fixture' : 'real Pi'} desktop, auth, rendering, drag, resize, minimize, arrange, ${app ? 'launch, safe text, handoff, ' : ''}mobile layout`);
} finally {
  if (ws?.readyState === WebSocket.OPEN) ws.close();
  chrome.kill('SIGTERM');
  await new Promise((done) => { if (chrome.exitCode !== null) done(); else { chrome.once('exit', done); setTimeout(done, 3000).unref(); } });
  if (app) await app.close();
  await rm(profile, { recursive: true, force: true, maxRetries: 3 });
}
