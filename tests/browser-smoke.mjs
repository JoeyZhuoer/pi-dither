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
    throw new Error(`Browser condition timed out: ${expression}`);
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
  assert.equal(await evaluate('document.querySelectorAll(".utility-window[hidden]").length'), 8);
  assert.equal(await evaluate('document.querySelector("[data-window-id=windows], [data-feature=windows]")'), null, 'legacy Window Manager is not restored');
  assert.equal(await evaluate('document.querySelectorAll("[data-feature=tools]").length'), 1);
  await until('document.querySelector("#backdrop").dataset.running === "true"');
  await evaluate(`window.backdropHash = () => { const c=document.querySelector('#backdrop'), pixels=c.getContext('2d').getImageData(0,0,c.width,c.height).data; let hash=2166136261; for(let i=3;i<pixels.length;i+=4) hash=Math.imul(hash^pixels[i],16777619); return hash; }; window.initialPattern=backdropHash();`);
  await until('backdropHash() !== initialPattern');
  assert.ok(await evaluate('document.querySelector("#backdrop").width * document.querySelector("#backdrop").height <= 100000'));
  if (app) {
    // Synthetic busy states drive the flowing field; no provider or prompt.
    const main = app.sessions.get('main');
    const setActivity = async (phase, mode, expected) => {
      main.state.phase = phase; main.state.activityMode = mode; main.emit('change');
      await until(`document.querySelector("#backdrop").dataset.activity === ${JSON.stringify(expected)}`);
    };
    const captureBackdrop = async (name) => {
      const data = await evaluate('document.querySelector("#backdrop").toDataURL("image/png")');
      await writeFile(resolve(`.local/backdrop-${name}.png`), Buffer.from(data.split(',')[1], 'base64'));
    };
    await captureBackdrop('idle');
    await setActivity('running', 'thinking', 'thinking');
    await captureBackdrop('thinking');
    await setActivity('running', 'output', 'output');
    await captureBackdrop('output');
    const flowing = await evaluate('backdropHash()');
    await until(`backdropHash() !== ${flowing}`);
    await setActivity('stopped', 'idle', 'idle');
    await until(`document.querySelector("#backdrop").dataset.activity === "idle"`);
    main.state.phase = 'idle'; main.emit('change');
  }
  await evaluate('document.querySelector("#help").click(); document.querySelector("#background-motion").click(); document.querySelector("#help-dialog").close()');
  const pausedPattern = await evaluate('backdropHash()');
  await evaluate('new Promise(resolve => setTimeout(resolve, 260))');
  assert.equal(await evaluate('backdropHash()'), pausedPattern, 'manual pause freezes the pattern');
  await evaluate('document.querySelector("#background-motion").click()');
  await rpc('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await until('document.querySelector("#backdrop").dataset.running === "false"');
  assert.equal(await evaluate('document.querySelector("#background-motion").disabled'), true);
  const reducedPattern = await evaluate('backdropHash()');
  await evaluate('new Promise(resolve => setTimeout(resolve, 260))');
  assert.equal(await evaluate('backdropHash()'), reducedPattern, 'system reduced motion freezes the pattern');
  await rpc('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
  await until('document.querySelector("#backdrop").dataset.running === "true"');
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
  // The initial main fits without any sizing control, and follows the viewport.
  assert.equal(await evaluate('document.querySelector("#auto-size, [aria-label=\\"Zoom to working size\\"]")'), null);
  const autoWidth = await evaluate('document.querySelector(".main-window").offsetWidth');
  assert.equal(await evaluate('JSON.parse(localStorage.getItem("pi-desktop:layout:v1")).main.sizeMode'), 'auto');
  await rpc('Emulation.setDeviceMetricsOverride', { width: 980, height: 740, deviceScaleFactor: 1, mobile: false });
  await until(`document.querySelector('.main-window').offsetWidth < ${autoWidth}`);
  await rpc('Emulation.setDeviceMetricsOverride', { width: 1440, height: 960, deviceScaleFactor: 1, mobile: false });
  await until(`document.querySelector('.main-window').offsetWidth === ${autoWidth}`);
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
    const draftGeometry = await evaluate(`(() => { const draft=document.querySelector('[data-subagent-index="1"]'); draft.querySelector('.resize-handle').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowLeft',bubbles:true})); return ['left','top','width','height'].map(key=>draft.style[key]); })()`);
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
  const compactModels = await evaluate('document.querySelector("[data-window-id=models]").offsetWidth');
  for (const id of ['models', 'providers', 'workspace', 'git', 'usage', 'sessions', 'activity', 'tools']) {
    await evaluate(`document.querySelector('#window-menu-toggle').click(); document.querySelector('[data-feature="${id}"]').click()`);
    await until(`document.querySelector('[data-window-id="${id}"]').hidden === false`);
    await until(`document.querySelector('[data-testid="${id}-status"]').textContent !== 'Loading…'`);
    assert.equal(await evaluate(`document.querySelector('[data-testid="${id}-status"]').classList.contains('feature-error')`), false, `${id} loads through integrated API`);
    if (id === 'models') assert.ok(await evaluate('document.querySelector("[data-window-id=models]").offsetWidth') > compactModels, 'new utility auto-enlarges');
    const layout = await evaluate(`(()=>{const e=document.querySelector('[data-window-id="${id}"]');return [e.style.left,e.style.top,e.style.width,e.style.height]})()`);
    await evaluate(`document.querySelector('[data-window-id="${id}"] button[aria-label="Close utility window"]').click(); document.querySelector('[data-feature="${id}"]').click()`);
    assert.deepEqual(await evaluate(`(()=>{const e=document.querySelector('[data-window-id="${id}"]');return [e.style.left,e.style.top,e.style.width,e.style.height]})()`), layout, `${id} reopens at the same size and location`);
  }
  assert.ok(await evaluate('new Set(Array.from(document.querySelectorAll(".utility-window"), e => e.style.width + "/" + e.style.height)).size >= 4'), 'utility purposes have distinct working-size presets');
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
  assert.equal(await evaluate('document.querySelectorAll(".utility-window:not([hidden])").length'), 8);
  await evaluate(`for(const button of document.querySelectorAll('.utility-window button[aria-label="Close utility window"]')) button.click(); document.querySelector('[data-feature="usage"]').click()`);
  const featuresScreenshot = await rpc('Page.captureScreenshot', { format: 'png' });
  await writeFile(resolve(`.local/desktop-features-${app ? 'fixture' : 'live'}.png`), Buffer.from(featuresScreenshot.data, 'base64'));
  await evaluate(`document.querySelector('.main-window button[aria-label="Minimize window"]').click()`);
  await evaluate('document.querySelector("#background-motion").click()');
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
  assert.equal(await evaluate('document.querySelector("#backdrop").dataset.running'), 'false', 'manual motion pause survives reload');
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
  console.log(`PASS: ${app ? 'fixture' : 'real Pi'} desktop, auth, rendering, drag, resize, minimize, arrange, ${app ? 'launch, tool selection, reusable subagent numbers, automatic delegated windows/live output, manual/delegated inspection, retro combobox keyboard/popup, safe text, handoff, flowing busy backdrop, ' : ''}Tools replacing Window Manager, activity/pausable/reduced-motion backdrop, purpose-specific presets, usage chart, auto-zoom, hide/show/reload layout memory, mobile layout`);
} finally {
  if (ws?.readyState === WebSocket.OPEN) ws.close();
  chrome.kill('SIGTERM');
  await new Promise((done) => { if (chrome.exitCode !== null) done(); else { chrome.once('exit', done); setTimeout(done, 3000).unref(); } });
  if (app) await app.close();
  await rm(profile, { recursive: true, force: true, maxRetries: 3 });
  await rm(dataDir, { recursive: true, force: true });
}
