// Real Chromium rendering + pointer/keyboard tests. No browser dependencies or provider calls.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { EventEmitter } from 'node:events';
import { createDesktop } from '../desktop/server.mjs';
import { createAgentState } from '../desktop/protocol.mjs';
import { checkDelegatedBrowser } from './delegated-browser-checks.mjs';
import { checkManualInspectionBrowser, checkIntegratedCombobox } from './inspection-browser-checks.mjs';

class BrowserFixture extends EventEmitter {
  constructor({ id, name, kind, tools }) {
    super(); this.state = createAgentState(id, name, kind); this.state.connected = true; this.state.phase = 'idle';
    this.state.model = { provider: 'test', id: 'fixture', name: 'Offline test fixture' };
    this.state.models = [this.state.model]; this.ready = Promise.resolve(); this.calls = [];
    this.state.availableTools = (kind === 'main' ? ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls', 'subagent', 'bg_wait', 'subagent_supervisor'] : ['read', 'grep', 'find', 'ls']).map((name) => ({ name, description: `Fixture ${name}` }));
    this.state.activeTools = tools ?? (kind === 'main' ? ['read', 'bash', 'edit', 'write', 'subagent', 'bg_wait', 'subagent_supervisor'] : ['read', 'grep', 'find', 'ls']);
    this.state.extensionStatus = { status: kind === 'main' ? 'loaded' : 'restricted', message: kind === 'main' ? 'pi-subagents loaded (fixture).' : 'Read-only desktop tools.' };
    this.state.stats = { tokens: { input: 25600, output: 1200, cacheRead: 6400, cacheWrite: 800, total: 34000 }, cost: .1234,
      contextUsage: { percent: 25, tokens: 8192, contextWindow: 32768 } };
  }
  async act(action, input) {
    this.calls.push(action);
    if (action === 'prompt') {
      this.state.messages.push({ id: `u${this.calls.length}`, role: 'user', text: input.message, at: Date.now(), status: 'done' },
        { id: `a${this.calls.length}`, role: 'assistant', text: '# Review result\n\n**Read-only finding**: <img src=x onerror="window.pwned=1">\n\n| Check | Result |\n| --- | --- |\n| Tools | Read only |\n\n```js\nconst ok = true;\n```', at: Date.now(), status: 'done' });
    }
    if (action === 'tools') this.state.activeTools = [...input.tools];
    this.state.revision++; this.emit('change');
    return action === 'tools' ? { availableTools: this.state.availableTools, activeTools: this.state.activeTools } : {};
  }
  close() { this.state.connected = false; }
}
const dataDir = await mkdtemp(join(tmpdir(), 'pi-desktop-browser-data-'));
const app = process.env.PI_DESKTOP_TEST_URL ? null : await createDesktop({ port: 0, dataDir, factory: (options) => new BrowserFixture(options) });
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
    throw new Error(`Browser condition timed out: ${expression}${errors.length ? ` — page errors: ${errors.join(' | ')}` : ''}`);
  }
  const { targetId } = await rpc('Target.createTarget', { url: 'about:blank' }, false);
  ({ sessionId } = await rpc('Target.attachToTarget', { targetId, flatten: true }, false));
  await rpc('Page.enable'); await rpc('Runtime.enable'); await rpc('Log.enable');
  await rpc('Emulation.setDeviceMetricsOverride', { width: 1440, height: 960, deviceScaleFactor: 1, mobile: false });
  await rpc('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
  await rpc('Page.addScriptToEvaluateOnNewDocument', { source: `if (!localStorage.getItem('pi-desktop:layout:v1')) localStorage.setItem('pi-desktop:layout:v1', JSON.stringify({ windows: { x: 100, y: 100, w: 700, h: 500, hidden: false }, 'draft-scout': { x: 1000, y: 105, w: 325, h: 310 }, 'draft-review': { x: 965, y: 345, w: 325, h: 310 } }));` });
  await rpc('Page.navigate', { url });
  await until('document.querySelector(".main-window .send")?.disabled === false');
  await evaluate('document.fonts.ready');
  await checkIntegratedCombobox({ evaluate, until, rpc });
  assert.equal(await evaluate('location.hash'), '', 'authorization token removed from address bar');
  assert.equal(await evaluate('document.querySelectorAll(".app-window:not([hidden])").length'), 1, 'startup opens only main, not automatic Scout/Review drafts');
  assert.equal(await evaluate('document.querySelectorAll("[data-subagent-index]").length'), 0);
  assert.equal(await evaluate('Object.keys(JSON.parse(localStorage.getItem("pi-desktop:layout:v1"))).some(id => ["draft-scout", "draft-review"].includes(id))'), false, 'obsolete starter layouts are removed');
  assert.equal(await evaluate('document.querySelectorAll(".utility-window[hidden]").length'), 9);
  assert.equal(await evaluate('document.querySelector("[data-window-id=windows], [data-feature=windows]")'), null, 'legacy Window Manager is not restored');
  assert.equal(await evaluate('document.querySelectorAll("[data-feature=tools]").length'), 1);
  assert.equal(await evaluate('document.querySelector("#backdrop, #background-motion")'), null, 'the old animated backdrop and its motion control are gone');
  assert.ok(await evaluate('document.querySelector("#background") instanceof HTMLCanvasElement && document.querySelector("[data-feature=background]")'), 'the static background canvas and window exist');
  if (app) {
    // Synthetic busy states still update the aggregated fleet activity; no provider or prompt.
    const main = app.sessions.get('main');
    const setActivity = async (phase, mode, expected) => {
      main.state.phase = phase; main.state.activityMode = mode; main.emit('change');
      await until(`document.querySelector("#desktop").dataset.activity === ${JSON.stringify(expected)}`);
    };
    await until('document.querySelector("#desktop").dataset.activity === "idle"');
    await setActivity('running', 'thinking', 'thinking');
    await setActivity('running', 'output', 'output');
    await setActivity('stopped', 'idle', 'idle');
    main.state.phase = 'idle'; main.emit('change');

    // Background window: ground colour plus a locally dithered photo.
    assert.equal(await evaluate(`(() => { document.querySelector('#window-menu-toggle').click(); document.querySelector('[data-feature="background"]').click(); return !document.querySelector('[data-window-id="background"]').hidden; })()`), true, 'background window opens');
    await evaluate(`{ const input = document.querySelector('[data-testid="background-ground"]'); input.value = '#123456'; input.dispatchEvent(new Event('input', { bubbles: true })); }`);
    assert.equal(await evaluate('getComputedStyle(document.documentElement).getPropertyValue("--ground").trim()'), '#123456');
    assert.equal(await evaluate('localStorage.getItem("pi-desktop:ground:v1")'), '#123456');
    assert.equal(await evaluate(`(() => { const c = document.querySelector('#background'); return [c.width, c.height, Array.from(c.getContext('2d').getImageData(2, 2, 1, 1).data).slice(0, 3).join(',')].join('|'); })()`).then((value) => value.split('|')[2]), '18,52,86', 'canvas is filled with the chosen ground colour');
    // A synthetic half-black/half-white photo exercises the dither without a file dialog.
    await evaluate(`(async () => {
      const blob = await new Promise((resolve) => { const c = document.createElement('canvas'); c.width = 64; c.height = 64; const x = c.getContext('2d'); x.fillStyle = '#000'; x.fillRect(0, 0, 32, 64); x.fillStyle = '#fff'; x.fillRect(32, 0, 32, 64); c.toBlob(resolve, 'image/png'); });
      const transfer = new DataTransfer(); transfer.items.add(new File([blob], 'fixture.png', { type: 'image/png' }));
      const input = document.querySelector('[data-testid="background-photo"]');
      input.files = transfer.files; input.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await until('localStorage.getItem("pi-desktop:photo:v1") !== null');
    const dithered = await evaluate(`(() => { const c = document.querySelector('#background'); const data = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let ink = 0; for (let i = 0; i < data.length; i += 4) if (data[i] === 32 && data[i + 1] === 32 && data[i + 2] === 31) ink++; return { ink, total: data.length / 4 }; })()`);
    assert.ok(dithered.ink > dithered.total * .15 && dithered.ink < dithered.total * .6, `photo dithers into ink (${dithered.ink}/${dithered.total})`);
    await evaluate(`document.querySelector('[data-testid="background-remove"]').click()`);
    assert.equal(await evaluate('localStorage.getItem("pi-desktop:photo:v1")'), null, 'removing the photo clears storage');
    // Theme colour paints the chrome and persists separately from the ground.
    await evaluate(`{ const input = document.querySelector('[data-testid="background-theme"]'); input.value = '#2a4b6c'; input.dispatchEvent(new Event('input', { bubbles: true })); }`);
    assert.equal(await evaluate('getComputedStyle(document.documentElement).getPropertyValue("--pink").trim()'), '#2a4b6c');
    assert.equal(await evaluate('localStorage.getItem("pi-desktop:theme:v1")'), '#2a4b6c');
    await evaluate(`document.querySelector('[data-testid="background-theme-reset"]').click()`);
    assert.equal(await evaluate('localStorage.getItem("pi-desktop:theme:v1")'), '#e58da5', 'default theme is restored');
    await evaluate(`document.querySelector('[data-testid="background-default"]').click()`);
    assert.equal(await evaluate('localStorage.getItem("pi-desktop:ground:v1")'), '#e58da5', 'default colour is restored');
    await evaluate(`document.querySelector('[data-window-id="background"] button[aria-label="Close utility window"]').click()`);
  }

  // Window settings (top right): they control the bottom bar. Less frequent
  // windows start out of it, every window stays in the Windows menu, and the
  // choice is remembered.
  assert.ok(await evaluate('!!document.querySelector("#settings") && !!document.querySelector("#settings-dialog") && !!document.querySelector("#settings-list")'), 'settings control exists');
  assert.ok(await evaluate('document.querySelector("#tasks button[data-window-id=workspace]").hidden && document.querySelector("#tasks button[data-window-id=providers]").hidden && !document.querySelector("#tasks button[data-window-id=usage]").hidden'), 'less frequent windows start out of the bottom bar');
  assert.equal(await evaluate('document.querySelector("[data-feature=workspace]").hidden'), false, 'every window stays in the Windows menu');
  await evaluate(`document.querySelector('#settings').click()`);
  assert.equal(await evaluate('document.querySelector("#settings-dialog").open'), true, 'settings dialog opens');
  assert.equal(await evaluate('document.querySelectorAll("#settings-list input[type=checkbox]").length'), 9, 'every window is listed in settings');
  await evaluate(`{ const box = document.querySelector('[data-testid="settings-workspace"]'); box.checked = true; box.dispatchEvent(new Event('change', { bubbles: true })); document.querySelector('#settings-dialog').close(); }`);
  assert.equal(await evaluate('document.querySelector("#tasks button[data-window-id=workspace]").hidden'), false, 'ticking a window adds its bottom button');
  assert.deepEqual(await evaluate('JSON.parse(localStorage.getItem("pi-desktop:taskbar:v1")).sort()'), ['activity', 'background', 'sessions', 'tools', 'usage', 'workspace'], 'choice persists');
  await until('document.querySelector("#settings-dialog").open === false');
  await evaluate(`document.querySelector('#settings').click(); { const box = document.querySelector('[data-testid="settings-workspace"]'); box.checked = false; box.dispatchEvent(new Event('change', { bubbles: true })); document.querySelector('#settings-dialog').close(); }`);
  assert.equal(await evaluate('document.querySelector("#tasks button[data-window-id=workspace]").hidden'), true, 'unticking hides it again');
  await evaluate(`document.querySelector('#settings').click(); document.querySelector('[data-testid="settings-open-git"]').click()`);
  assert.equal(await evaluate('document.querySelector("[data-window-id=git]").hidden'), false, 'settings can open a bottom-bar-hidden window directly');
  await evaluate(`document.querySelector('[data-window-id=git] button[aria-label="Close utility window"]').click()`);

  // Pointer ripple: with a photo in place the dots spread under the pointer and
  // settle back exactly to the base pattern.
  if (app) {
    const canvasHash = `(() => { const c = document.querySelector('#background'), d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let h = 2166136261; for (let i = 0; i < d.length; i += 4) h = Math.imul(h ^ d[i], 16777619); return h; })()`;
    await evaluate(`(async () => { const blob = await new Promise((resolve) => { const c = document.createElement('canvas'); c.width = 64; c.height = 64; const x = c.getContext('2d'); x.fillStyle = '#000'; x.fillRect(0, 0, 32, 64); x.fillStyle = '#fff'; x.fillRect(32, 0, 32, 64); c.toBlob(resolve, 'image/png'); }); const transfer = new DataTransfer(); transfer.items.add(new File([blob], 'ripple.png', { type: 'image/png' })); const input = document.querySelector('[data-testid="background-photo"]'); input.files = transfer.files; input.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await until('localStorage.getItem("pi-desktop:photo:v1") !== null');
    const basePattern = await evaluate(canvasHash);
    await evaluate(`document.dispatchEvent(new PointerEvent('pointermove', { clientX: 120, clientY: 200, bubbles: true }))`);
    await until(`${canvasHash} !== ${basePattern}`);
    assert.notEqual(await evaluate(canvasHash), basePattern, 'the dots spread under the pointer');
    await until(`${canvasHash} === ${basePattern}`);
    assert.equal(await evaluate(canvasHash), basePattern, 'the dots settle back exactly');
    await evaluate(`document.querySelector('[data-testid="background-remove"]').click()`);
    assert.equal(await evaluate('localStorage.getItem("pi-desktop:photo:v1")'), null, 'ripple fixture photo removed');
  }
  await evaluate('document.querySelector("#help").click(); document.querySelector("#help-dialog").close()');
  assert.equal(await evaluate('document.querySelectorAll(".sub-window").length'), 0, 'no child shell exists before an explicit launch or delegation');
  assert.equal(await evaluate('document.querySelector(".life-widget")'), null, 'decorative glider replaced');
  assert.equal(await evaluate('document.querySelector("#usage-diagram").dataset.agentId'), 'main');
  if (app) {
    assert.equal(await evaluate('document.querySelector(".usage-context").getAttribute("aria-valuenow")'), '25');
    assert.match(await evaluate('document.querySelector(".usage-totals").textContent'), /\$0\.1234/);
  }
  const chartHeading = await evaluate('(()=>{const e=document.querySelector("#usage-diagram button"),r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,reachable:document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.closest("#usage-diagram")!==null}})()');
  assert.equal(chartHeading.reachable, true, 'chart heading is not blocked by the desktop or default windows');
  for (const type of ['mousePressed', 'mouseReleased']) await rpc('Input.dispatchMouseEvent', { type, x: chartHeading.x, y: chartHeading.y, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 });
  await until('document.querySelector("[data-window-id=usage]").hidden === false');
  await evaluate(`document.querySelector('[data-window-id=usage] button[aria-label="Close utility window"]').click()`);
  // The initial main opens at the minimum width and a medium height, without
  // any sizing control, and follows the viewport height.
  assert.equal(await evaluate('document.querySelector("#auto-size, [aria-label=\\"Zoom to working size\\"]")'), null);
  const autoHeight = await evaluate('document.querySelector(".main-window").offsetHeight');
  assert.equal(await evaluate('document.querySelector(".main-window").offsetWidth'), 610, 'main opens at the minimum width');
  assert.equal(await evaluate('JSON.parse(localStorage.getItem("pi-desktop:layout:v1")).main.sizeMode'), 'auto');
  await rpc('Emulation.setDeviceMetricsOverride', { width: 980, height: 740, deviceScaleFactor: 1, mobile: false });
  await until(`document.querySelector('.main-window').offsetHeight < ${autoHeight}`);
  await rpc('Emulation.setDeviceMetricsOverride', { width: 1440, height: 960, deviceScaleFactor: 1, mobile: false });
  await until(`document.querySelector('.main-window').offsetHeight === ${autoHeight}`);
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
    await evaluate(`document.querySelector('#add-agent').click(); document.querySelector('#add-agent').click()`);
    assert.deepEqual(await evaluate('Array.from(document.querySelectorAll("[data-subagent-index]"), node => Number(node.dataset.subagentIndex))'), [1, 2], 'manual drafts remain explicitly available');
    assert.ok(await evaluate('document.querySelector(".main-window").offsetWidth > Math.max(...Array.from(document.querySelectorAll(".sub-window"),n=>n.offsetWidth))'));
    await evaluate(`document.querySelector('[data-subagent-index="1"] button[aria-label="Minimize window"]').click(); document.querySelector('#add-agent').click()`);
    assert.equal(await evaluate('document.querySelector(".sub-window:last-of-type")?.dataset.subagentIndex'), '3', 'minimized slot 1 remains occupied');
    await evaluate(`document.querySelector('[data-subagent-index="3"] button[aria-label="Close subagent window"]').click(); document.querySelector('[data-subagent-index="1"] button[aria-label="Close subagent window"]').click(); document.querySelector('#add-agent').click()`);
    assert.equal(await evaluate(`document.querySelectorAll('[data-subagent-index="1"]').length`), 1, 'closing draft 1 releases its display number');
    await evaluate(`{ const draft=document.querySelector('[data-subagent-index="1"]'); for (const box of draft.querySelectorAll('.draft-tools input')) box.checked=box.value==='read'; draft.querySelector('textarea').value='Review the architecture'; }`);
    const main = app.sessions.get('main'), catalog = main.state.availableTools;
    main.state.availableTools = null; main.emit('change');
    await until(`document.querySelector('[data-subagent-index="1"] .draft-footer button').disabled`);
    await evaluate(`document.querySelector('[data-subagent-index="1"] .draft-body').requestSubmit()`);
    assert.equal(app.sessions.size, 1, 'unavailable metadata cannot silently widen a custom draft selection');
    main.state.availableTools = catalog; main.emit('change');
    await until(`!document.querySelector('[data-subagent-index="1"] .draft-footer button').disabled`);
    const draftGeometry = await evaluate(`(() => { const draft=document.querySelector('[data-subagent-index="1"]'); draft.querySelector('.resize-handle').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true})); return ['left','top','width','height'].map(key=>draft.style[key]); })()`);
    await evaluate(`document.querySelector('[data-subagent-index="1"] .draft-body').requestSubmit()`);
    await until('document.querySelectorAll(".child-transfer").length === 1 && document.querySelector(".sub-window .message.assistant") !== null');
    assert.equal(app.sessions.size, 2, 'only explicitly launched child is created');
    assert.deepEqual([...app.sessions.values()].find((agent) => agent.state.kind === 'subagent').state.activeTools, ['read'], 'prelaunch selection is sent before the first prompt');
    const childId = [...app.sessions.keys()].find((id) => id !== 'main');
    assert.deepEqual(await evaluate(`(() => { const child=document.querySelector('[data-window-id="${childId}"]'); return ['left','top','width','height'].map(key=>child.style[key]); })()`), draftGeometry, 'launched child inherits manually chosen draft geometry');
    assert.equal(await evaluate(`JSON.parse(localStorage.getItem('pi-desktop:layout:v1'))[${JSON.stringify(childId)}].sizeMode`), 'manual', 'draft sizing intent survives replacement');
    await checkManualInspectionBrowser({ app, childId, evaluate, until });
    await until(`document.querySelector('#usage-diagram').dataset.agentId === ${JSON.stringify(childId)}`);
    assert.equal(await evaluate('window.pwned'), undefined);
    assert.equal(await evaluate('document.querySelectorAll(".message-body img").length'), 0);
    assert.equal(await evaluate('document.querySelector(".message.assistant .markdown h1")?.textContent'), 'Review result');
    assert.equal(await evaluate('document.querySelectorAll(".message.assistant .markdown table").length'), 1);
    assert.equal(await evaluate('document.querySelectorAll(".message.assistant .md-code-toolbar button").length'), 1);
    await evaluate('document.querySelector(".child-transfer").click()');
    assert.ok((await evaluate('document.querySelector(".main-window textarea").value')).includes('Read-only finding'));
    assert.equal(app.sessions.get('main').calls.length, 0, 'handoff only inserts a draft');
  }
  const compactModels = await evaluate('parseFloat(document.querySelector("[data-window-id=models]").style.width)');
  assert.ok(compactModels > 400, 'compact models preset is roomier than the opening width');
  for (const id of ['models', 'providers', 'workspace', 'git', 'usage', 'sessions', 'activity', 'tools', 'background']) {
    await evaluate(`document.querySelector('#window-menu-toggle').click(); document.querySelector('[data-feature="${id}"]').click()`);
    await until(`document.querySelector('[data-window-id="${id}"]').hidden === false`);
    await until(`document.querySelector('[data-testid="${id}-status"]').textContent !== 'Loading…'`);
    assert.equal(await evaluate(`document.querySelector('[data-testid="${id}-status"]').classList.contains('feature-error')`), false, `${id} loads through integrated API`);
    if (id === 'models') assert.equal(await evaluate('parseFloat(document.querySelector("[data-window-id=models]").style.width)'), 400, 'utility opens at the minimum width');
    const layout = await evaluate(`(()=>{const e=document.querySelector('[data-window-id="${id}"]');return [e.style.left,e.style.top,e.style.width,e.style.height]})()`);
    await evaluate(`document.querySelector('[data-window-id="${id}"] button[aria-label="Close utility window"]').click(); document.querySelector('[data-feature="${id}"]').click()`);
    assert.deepEqual(await evaluate(`(()=>{const e=document.querySelector('[data-window-id="${id}"]');return [e.style.left,e.style.top,e.style.width,e.style.height]})()`), layout, `${id} reopens at the same size and location`);
  }
  const utilitySizes = await evaluate('Array.from(document.querySelectorAll(".utility-window"), e => e.style.width + "/" + e.style.height)');
  assert.ok(utilitySizes.every(size => size.startsWith('400px/')), 'every utility opens at the minimum width with a medium height: ' + JSON.stringify(utilitySizes));
  if (app) {
    assert.equal(await evaluate('document.querySelector("[data-testid=tools-tool-subagent]").checked'), true, 'extension tool is visible and initially active for main');
    assert.match(await evaluate('document.querySelector("[data-testid=tools-extension]").textContent'), /pi-subagents/);
    await evaluate(`document.querySelector('[data-testid="tools-none"]').click(); document.querySelector('[data-testid="tools-apply"]').click()`);
    await until(`document.querySelector('[data-testid="tools-current"]').textContent.includes('None (all tools disabled)') && !document.querySelector('[data-testid="tools-apply"]').disabled`);
    assert.deepEqual(app.sessions.get('main').state.activeTools, []);
    await evaluate(`document.querySelector('[data-testid="tools-tool-read"]').click(); document.querySelector('[data-testid="tools-apply"]').click()`);
    await until(`document.querySelector('[data-testid="tools-current"]').textContent.endsWith('read') && !document.querySelector('[data-testid="tools-apply"]').disabled`);
    assert.deepEqual(app.sessions.get('main').state.activeTools, ['read']);
    await evaluate(`document.querySelector('[data-testid="tools-tool-subagent"]').click(); document.querySelector('[data-testid="tools-apply"]').click()`);
    await until(`document.querySelector('[data-testid="tools-current"]').textContent.includes('read, subagent') && !document.querySelector('[data-testid="tools-apply"]').disabled`);
    assert.deepEqual(app.sessions.get('main').state.activeTools, ['read', 'subagent'], 'extension tools can be explicitly selected');
    await evaluate(`document.querySelector('[data-testid="tools-all"]').click(); document.querySelector('[data-testid="tools-apply"]').click()`);
    await until(`document.querySelector('[data-testid="tools-current"]').textContent.includes('bash') && !document.querySelector('[data-testid="tools-apply"]').disabled`);
    assert.equal(app.sessions.get('main').calls.filter((action) => action === 'prompt').length, 0, 'tool selection never sends a prompt');
    const childId = [...app.sessions.keys()].find((id) => id !== 'main');
    await evaluate(`document.querySelector('[data-testid="tools-agent"]').value=${JSON.stringify(childId)}; document.querySelector('[data-testid="tools-agent"]').dispatchEvent(new Event('change'));`);
    assert.equal(await evaluate('document.querySelector("[data-testid=tools-tool-bash]")'), null, 'subagent catalog never offers shell access');
    assert.equal(await evaluate('document.querySelector("[data-testid=tools-tool-subagent]")'), null, 'read-only desktop child cannot delegate around its ceiling');
    await evaluate(`window.confirm=()=>true; document.querySelector('[data-window-id="${childId}"] button[aria-label="Close subagent window"]').click()`);
    await until(`document.querySelector('[data-window-id="${childId}"]') === null`);
    await evaluate('document.querySelector("#add-agent").click()');
    assert.equal(await evaluate(`document.querySelectorAll('[data-subagent-index="1"]').length`), 1, 'closed live subagent number is reusable');
    await evaluate(`document.querySelector('[data-subagent-index="1"] button[aria-label="Close subagent window"]').click()`);
  }
  await checkDelegatedBrowser({ app, evaluate, until, rpc });
  await evaluate(`for (const button of document.querySelectorAll('.app-window:not([hidden]) button[aria-label="Minimize window"]')) button.click()`);
  assert.equal(await evaluate('document.querySelectorAll(".app-window:not([hidden])").length'), 0);
  await evaluate(`for (const button of document.querySelectorAll('#tasks button')) button.click()`);
  assert.equal(await evaluate('document.querySelectorAll(".utility-window:not([hidden])").length'), 9);
  await evaluate(`for(const button of document.querySelectorAll('.utility-window button[aria-label="Close utility window"]')) button.click(); document.querySelector('[data-feature="usage"]').click()`);
  const featuresScreenshot = await rpc('Page.captureScreenshot', { format: 'png' });
  await writeFile(resolve(`.local/desktop-features-${app ? 'fixture' : 'live'}.png`), Buffer.from(featuresScreenshot.data, 'base64'));
  await evaluate(`document.querySelector('.main-window button[aria-label="Minimize window"]').click()`);
  const savedLayouts = await evaluate('JSON.parse(localStorage.getItem("pi-desktop:layout:v1"))');
  await rpc('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await until('innerWidth === 390');
  assert.ok(await evaluate('document.documentElement.scrollWidth <= innerWidth'), 'mobile view has no horizontal overflow');
  assert.ok(await evaluate('document.querySelector("#usage-diagram").offsetHeight > 0'), 'usage chart remains available on mobile');
  assert.deepEqual(await evaluate('JSON.parse(localStorage.getItem("pi-desktop:layout:v1"))'), savedLayouts, 'mobile reflow does not overwrite desktop preferences');
  await rpc('Emulation.setDeviceMetricsOverride', { width: 1440, height: 960, deviceScaleFactor: 1, mobile: false });
  await until('innerWidth === 1440');
  await rpc('Page.reload');
  await until('document.querySelector(".main-window .send")?.disabled === false');
  assert.equal(await evaluate('document.querySelector(".main-window").hidden'), true, 'hidden main stays hidden across reload');
  assert.deepEqual(await evaluate('Array.from(document.querySelectorAll("[data-subagent-index]"), node => Number(node.dataset.subagentIndex)).sort()'), [], 'reload does not manufacture starter drafts');
  const restoredLayouts = await evaluate('JSON.parse(localStorage.getItem("pi-desktop:layout:v1"))');
  for (const [id, layout] of Object.entries(savedLayouts)) assert.deepEqual(restoredLayouts[id], layout, `${id} layout survives reload`);
  await evaluate('document.querySelector("#tasks button").click()');
  assert.equal(await evaluate('document.querySelector(".main-window").hidden'), false);
  if (app) {
    const main = app.sessions.get('main'); main.state.stats = null; main.emit('change');
    await until('document.querySelector(".usage-context").getAttribute("aria-valuenow") === null');
    assert.match(await evaluate('document.querySelector(".usage-totals").textContent'), /— TOK/);
  }
  assert.deepEqual(errors, [], 'no browser script, resource or CSP errors');
  console.log(`PASS: ${app ? 'fixture' : 'real Pi'} desktop, auth, rendering, drag, resize, minimize, arrange, ${app ? 'launch, tool selection, reusable subagent numbers, automatic delegated windows/live output, manual/delegated inspection, retro combobox keyboard/popup, safe text, handoff, ' : ''}Tools replacing Window Manager, plain background and fleet activity, purpose-specific presets, usage chart, minimum-width opening, hide/show/reload layout memory, mobile layout`);
} finally {
  if (ws?.readyState === WebSocket.OPEN) ws.close();
  chrome.kill('SIGTERM');
  await new Promise((done) => { if (chrome.exitCode !== null) done(); else { chrome.once('exit', done); setTimeout(done, 3000).unref(); } });
  if (app) await app.close();
  await rm(profile, { recursive: true, force: true, maxRetries: 3 });
  await rm(dataDir, { recursive: true, force: true });
}
