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
        { id: `a${this.calls.length}`, role: 'assistant', thinking: `Thinking sample ${this.calls.length} · checking the fixture.`, text: '# Review result\n\n**Read-only finding**: <img src=x onerror="window.pwned=1">\n\n| Check | Result |\n| --- | --- |\n| Tools | Read only |\n\n```js\nconst ok = true;\n```', at: Date.now(), status: 'done' });
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
      // Budget raised with the 2px x 800k cloud: a full-canvas getImageData poll plus
      // the render loop can exceed 12 s on a loaded machine.
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 30000);
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
  assert.equal(await evaluate('document.querySelector("#background")'), null, 'the dithered background canvas is gone');
  assert.ok(await evaluate('document.querySelector("#particles") instanceof HTMLCanvasElement && document.querySelector("[data-feature=background]")'), 'the point-cloud background layer and window exist');
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

    // Appearance window: colours, the photo point cloud and the extra field.
    assert.equal(await evaluate(`(() => { document.querySelector('#window-menu-toggle').click(); document.querySelector('[data-feature="background"]').click(); return !document.querySelector('[data-window-id="background"]').hidden; })()`), true, 'appearance window opens');
    await evaluate(`{ const input = document.querySelector('[data-testid="background-ground"]'); input.value = '#123456'; input.dispatchEvent(new Event('input', { bubbles: true })); }`);
    assert.equal(await evaluate('getComputedStyle(document.documentElement).getPropertyValue("--ground").trim()'), '#123456');
    assert.equal(await evaluate('localStorage.getItem("pi-desktop:ground:v1")'), '#123456');
    assert.equal(await evaluate('getComputedStyle(document.body).backgroundColor'), 'rgb(18, 52, 86)', 'the desk uses the chosen ground colour');
    // A synthetic checkerboard becomes the point cloud: ink everywhere, so both a
    // box near the cursor and a box in the corner have points to move.
    await evaluate(`(async () => {
      const blob = await new Promise((resolve) => { const c = document.createElement('canvas'); c.width = 64; c.height = 64; const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, 64, 64); x.fillStyle = '#000'; for (let row = 0; row < 8; row++) for (let col = 0; col < 8; col++) if ((row + col) % 2) x.fillRect(col * 8, row * 8, 8, 8); c.toBlob(resolve, 'image/png'); });
      const transfer = new DataTransfer(); transfer.items.add(new File([blob], 'cloud.png', { type: 'image/png' }));
      const input = document.querySelector('[data-testid="background-photo"]');
      input.files = transfer.files; input.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await until('localStorage.getItem("pi-desktop:photo:v1") !== null');
    assert.equal(await evaluate('localStorage.getItem("pi-desktop:cloud-pointer:v1")'), null, 'push is the default without a stored choice');
    const cloudStats = `(() => {
      const c = document.querySelector('#particles'), data = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let inked = 0, sumX = 0, sumY = 0;
      for (let i = 3; i < data.length; i += 4) {
        if (data[i] <= 8) continue;
        const index = i >> 2, x = index % c.width;
        inked++; sumX += x; sumY += (index - x) / c.width;
      }
      return { inked, cx: sumX / (inked || 1), cy: sumY / (inked || 1) };
    })()`;
    const cloudHash = `(() => { const c = document.querySelector('#particles'), d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let h = 2166136261; for (let i = 0; i < d.length; i += 4) h = Math.imul(h ^ d[i] ^ d[i + 3], 16777619); return h; })()`;
    const cloudShift = (a, b) => Math.hypot(a.cx - b.cx, a.cy - b.cy);
    const settleForced = async (label) => {
      let previous = null;
      for (let i = 0; i < 100; i++) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        const next = await evaluate(cloudStats);
        if (previous && Math.abs(next.inked - previous.inked) <= Math.max(20, previous.inked * .002) && cloudShift(next, previous) < .2) return next;
        previous = next;
      }
      assert.fail(`the forced cloud did not settle: ${label}`);
    };
    const stableCloud = async (label) => {
      let last = await evaluate(cloudHash);
      for (let i = 0; i < 100; i++) {
        await new Promise((resolve) => setTimeout(resolve, 200));
        const next = await evaluate(cloudHash);
        if (next === last && i > 0) return;   // two identical frames in a row
        last = next;
      }
      assert.fail(`the cloud did not settle: ${label}`);
    };
    await until(`${cloudStats}.inked > 200`);
    assert.ok((await evaluate(cloudStats)).inked > 200, 'the photo becomes a point cloud on the particle layer');
    // Baseline with the pointer outside, so both samples are taken without the
    // pointer parallax.
    await evaluate(`document.dispatchEvent(new PointerEvent('pointerleave', { bubbles: true }))`);
    await stableCloud('the cloud forms');
    await evaluate('new Promise((resolve) => setTimeout(resolve, 2500))');
    const home = await evaluate(cloudStats);
    // Regression guard: the cloud is centred on the canvas, not parked in a corner.
    const cloudCanvas = await evaluate('(() => { const c = document.querySelector("#particles"); return { width: c.width, height: c.height }; })()');
    assert.ok(Math.abs(home.cx - cloudCanvas.width / 2) < cloudCanvas.width * .05, `the cloud sits on the canvas centre (cx ${home.cx.toFixed(1)} of ${cloudCanvas.width})`);
    assert.ok(Math.abs(home.cy - cloudCanvas.height / 2) < cloudCanvas.height * .05, `the cloud sits on the canvas centre (cy ${home.cy.toFixed(1)} of ${cloudCanvas.height})`);
    // The pointer force is bounded to CLOUD_RADIUS (480px). The parallax tilt only
    // depends on the cursor position, so putting the cursor exactly on the canvas
    // centre (tilt 0) means push and pull can only differ through the force. Boxes
    // are compared by statistics, not pixels: a 200k-dot cloud keeps creeping
    // sub-pixel for seconds, so a few thousand dots flip pixel edges on their own.
    const regionStats = (x, y, size) => `(() => {
      const c = document.querySelector('#particles'), d = c.getContext('2d').getImageData(${x}, ${y}, ${size}, ${size}).data;
      let inked = 0, sumX = 0, sumY = 0;
      for (let i = 3; i < d.length; i += 4) {
        if (d[i] <= 8) continue;
        const index = i >> 2, px = index % ${size};
        inked++; sumX += px; sumY += (index - px) / ${size};
      }
      return { inked, cx: sumX / (inked || 1), cy: sumY / (inked || 1) };
    })()`;
    const regionHash = (x, y, size) => `(() => {
      const c = document.querySelector('#particles'), d = c.getContext('2d').getImageData(${x}, ${y}, ${size}, ${size}).data;
      let h = 2166136261;
      for (let i = 0; i < d.length; i += 4) h = Math.imul(h ^ d[i] ^ d[i + 3], 16777619);
      return h;
    })()`;
    const sameRegion = (a, b) => Math.abs(a.inked - b.inked) <= Math.max(20, a.inked * .01) && Math.hypot(a.cx - b.cx, a.cy - b.cy) < .5;
    // Waiting for stability is not enough before asserting a change: a force that has
    // not engaged yet is stable too, so wait for the region to actually differ.
    const untilRegionDiffers = async (expression, target, label) => {
      for (let i = 0; i < 100; i++) {
        const now = await evaluate(expression);
        if (!sameRegion(now, target)) return now;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      assert.fail(`the region never moved: ${label}`);
    };
    const untilRegion = async (expression, target, label) => {
      for (let i = 0; i < 100; i++) {
        const now = await evaluate(expression);
        if (sameRegion(now, target)) return now;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      assert.fail(`the region did not settle: ${label}`);
    };
    // Cursor on the canvas centre keeps the tilt at zero; the near box is offset to
    // stay inside the radius with ink in it.
    const cursor = { x: cloudCanvas.width / 2, y: cloudCanvas.height / 2 }, box = 200;
    const near = { x: cursor.x + 140, y: cursor.y + 60 };
    const nearStats = regionStats(near.x - box / 2, near.y - box / 2, box);
    const farStats = regionStats(cloudCanvas.width - box, cloudCanvas.height - box, box);
    const homeNear = await evaluate(nearStats), homeFar = await evaluate(farStats);
    assert.ok(Math.hypot(near.x + box / 2 - cursor.x, near.y + box / 2 - cursor.y) < 480, 'the near box is inside the cloud radius');
    await evaluate(`document.dispatchEvent(new PointerEvent('pointermove', { clientX: ${cursor.x}, clientY: ${cursor.y}, bubbles: true }))`);
    await settleForced('the push settles');
    const pushedNear = await untilRegionDiffers(nearStats, homeNear, 'the push reaches the points around the cursor');
    const pushedFar = await evaluate(farStats);
    assert.ok(!sameRegion(pushedNear, homeNear), 'the push reaches the points around the cursor');
    await evaluate(`{ const select = document.querySelector('[data-testid="background-cloud"]'); select.value = 'pull'; select.dispatchEvent(new Event('change', { bubbles: true })); }`);
    await settleForced('the pull settles');
    const pulledNear = await evaluate(nearStats), pulledFar = await evaluate(farStats);
    assert.ok(!sameRegion(pulledNear, pushedNear), 'pull rearranges the points around the cursor');
    assert.ok(sameRegion(pulledFar, pushedFar), 'no force reaches beyond CLOUD_RADIUS in either direction');
    assert.ok(sameRegion(pushedFar, homeFar), 'and the far box never leaves home');
    // The far-box comparison is statistical on purpose: a 2px-dot cloud keeps
    // settling sub-pixel, so a handful of boundary pixels (6 of 25722 here) can
    // flip on their own while the region as a whole is unchanged.
    assert.ok(sameRegion(await evaluate(farStats), homeFar), 'the far region is unchanged in both force directions');
    await evaluate(`{ const select = document.querySelector('[data-testid="background-cloud"]'); select.value = 'push'; select.dispatchEvent(new Event('change', { bubbles: true })); }`);
    await evaluate(`document.dispatchEvent(new PointerEvent('pointerleave', { bubbles: true }))`);
    await untilRegion(nearStats, homeNear, 'the stirred box springs home');
    await stableCloud('the cloud springs home');
    const settled = await evaluate(cloudStats);
    assert.ok(Math.abs(settled.inked - home.inked) <= Math.max(30, home.inked * .03), 'the cloud springs back to its home shape');
    assert.ok(sameRegion(await evaluate(farStats), homeFar), 'and the far box is still home');

    // The signed force switch mirrors the site's push/pull modes.
    assert.equal(await evaluate('localStorage.getItem("pi-desktop:cloud-pointer:v1")'), 'push', 'the chosen direction persists');
    await evaluate(`{ const select = document.querySelector('[data-testid="background-cloud"]'); select.value = 'pull'; select.dispatchEvent(new Event('change', { bubbles: true })); }`);
    assert.equal(await evaluate('localStorage.getItem("pi-desktop:cloud-pointer:v1")'), 'pull', 'the pull variant persists');
    await evaluate(`document.dispatchEvent(new PointerEvent('pointermove', { clientX: ${cursor.x}, clientY: ${cursor.y}, bubbles: true }))`);
    await settleForced('the pull stirs again');
    assert.ok(!sameRegion(await untilRegionDiffers(nearStats, homeNear, 'the pull moves the cloud'), homeNear), 'the pull moves the cloud');
    await evaluate(`document.dispatchEvent(new PointerEvent('pointerleave', { bubbles: true }))`);
    await untilRegion(nearStats, homeNear, 'the pull springs home');
    await evaluate(`{ const select = document.querySelector('[data-testid="background-cloud"]'); select.value = 'push'; select.dispatchEvent(new Event('change', { bubbles: true })); }`);
    // Laptop motion (F2). The fixture has no sensor at first, the host injects
    // itself late, and enabling motion picks it up: a stream of tilted samples
    // leans the whole cloud, re-zero levels it again and off lets it settle home.
    assert.equal(await evaluate('(() => { const s = document.querySelector(\'[data-testid="background-motion"]\'); return s ? s.value : null; })()'), 'off', 'motion is off by default');
    assert.equal(await evaluate('localStorage.getItem("pi-desktop:motion:v1")'), null);
    // The Appearance window no longer shows a motion status line.
    assert.ok(await evaluate(`!document.querySelector('[data-testid="background-motion-status"]')`), 'the motion status line is gone');
    assert.equal(await evaluate('(() => { const b = document.querySelector(\'[data-testid="background-motion-rezero"]\'); return b ? b.disabled : null; })()'), true, 're-zero is unavailable with motion off');
    await evaluate(`window.__piDitherMotionHost = {
      version: 1, status: 'available', latest: null, peak: 0, subscribers: new Set(),
      subscribe(callback) { this.subscribers.add(callback); return () => this.subscribers.delete(callback); },
      deliver(sample) { this.latest = sample; this.peak = sample.peak || 0; for (const callback of [...this.subscribers]) callback(sample); },
    }`);
    await evaluate(`{ const select = document.querySelector('[data-testid="background-motion"]'); select.value = 'full'; select.dispatchEvent(new Event('change', { bubbles: true })); }`);
    assert.equal(await evaluate('localStorage.getItem("pi-desktop:motion:v1")'), 'full', 'the motion choice persists');
    await until('window.__piDitherMotionHost.subscribers.size === 1');
    await evaluate(`document.dispatchEvent(new PointerEvent('pointerleave', { bubbles: true }))`);
    await stableCloud('the cloud is home before motion');
    const motionHome = await evaluate(cloudStats), motionFar = await evaluate(farStats);
    // A resting machine reads +1 g on z; tipping the right side down reads negative x.
    await evaluate(`(async () => {
      const deliver = (sample) => window.__piDitherMotionHost.deliver(sample);
      for (let index = 0; index < 90; index++) { deliver({ x: 0, y: 0, z: 1, at: performance.now() + index * 16 }); await new Promise((resolve) => setTimeout(resolve, 16)); }
      for (let index = 0; index < 120; index++) { deliver({ x: -0.342, y: 0, z: 0.94, at: performance.now() + index * 16 }); await new Promise((resolve) => setTimeout(resolve, 16)); }
    })()`);
    await until(`Math.abs((${cloudStats}).cx - ${motionHome.cx}) > 5`);
    const leaned = await evaluate(cloudStats);
    assert.ok(Math.abs(leaned.cx - motionHome.cx) > 5, `a tilt leans the whole cloud (${(leaned.cx - motionHome.cx).toFixed(1)} px)`);
    // Shake: a burst must move points outward and then settle again.
    await evaluate(`(() => { for (let index = 0; index < 40; index++) window.__piDitherMotionHost.deliver({ x: -0.342, y: 0, z: 1.6, at: performance.now() + index * 16, peak: 1.2 }); })()`);
    // The burst happens over the next few frames, so let the loop run before looking.
    await new Promise((resolve) => setTimeout(resolve, 250));
    const shaken = await evaluate(cloudStats);
    assert.ok(shaken.inked !== leaned.inked || Math.abs(shaken.cy - leaned.cy) > 1, `a shake rearranges the cloud (${leaned.inked} -> ${shaken.inked})`);
    // Re-zero makes the current tilt level and the cloud returns to where it was.
    await evaluate('document.querySelector(\'[data-testid="background-motion-rezero"]\').click()');
    await until(`Math.abs((${cloudStats}).cx - ${motionHome.cx}) < 4`);
    assert.ok(Math.abs((await evaluate(cloudStats)).cx - motionHome.cx) < 4, 're-zero brings the cloud back to level');
    // Off: the sway settles home rather than freezing mid-lean.
    await evaluate(`{ const select = document.querySelector('[data-testid="background-motion"]'); select.value = 'off'; select.dispatchEvent(new Event('change', { bubbles: true })); }`);
    assert.equal(await evaluate('localStorage.getItem("pi-desktop:motion:v1")'), 'off');
    // Let the sway spring actually finish: with 2px dots a residual of a fraction of
    // a pixel still flips rounding on a few hundred dots, so the pixel count is only
    // meaningful once it has settled, and even then it is a tolerance, not equality
    // (the exact-equality proof for motion off lives in the unit tests).
    await new Promise((resolve) => setTimeout(resolve, 3000));
    await until(`Math.abs((${cloudStats}).cx - ${motionHome.cx}) < .5`);
    const rested = await evaluate(cloudStats);
    assert.ok(Math.abs(rested.cx - motionHome.cx) < .5 && Math.abs(rested.cy - motionHome.cy) < .5, `with motion off the cloud is back on its home centre (${(rested.cx - motionHome.cx).toFixed(2)}, ${(rested.cy - motionHome.cy).toFixed(2)} px)`);
    assert.ok(Math.abs(rested.inked - motionHome.inked) <= Math.max(200, motionHome.inked * .01), `and its pixel count is back within rounding (${motionHome.inked} -> ${rested.inked})`);
    assert.ok(sameRegion(await evaluate(farStats), motionFar), 'the far box is where it was before motion');

    // Extra drifting field on top of the cloud.
    const cloudOnly = (await evaluate(cloudStats)).inked;
    await evaluate(`{ const select = document.querySelector('[data-testid="background-particles"]'); select.value = 'dense'; select.dispatchEvent(new Event('change', { bubbles: true })); }`);
    assert.equal(await evaluate('localStorage.getItem("pi-desktop:particles:v1")'), 'dense', 'the extra field persists');
    await until(`${cloudStats}.inked !== ${cloudOnly}`);
    await evaluate(`{ const select = document.querySelector('[data-testid="background-particles"]'); select.value = 'off'; select.dispatchEvent(new Event('change', { bubbles: true })); }`);
    assert.equal(await evaluate('localStorage.getItem("pi-desktop:particles:v1")'), 'off', 'the extra field switches off');
    // Theme colour paints the chrome and persists separately from the ground.
    await evaluate(`{ const input = document.querySelector('[data-testid="background-theme"]'); input.value = '#2a4b6c'; input.dispatchEvent(new Event('input', { bubbles: true })); }`);
    assert.equal(await evaluate('getComputedStyle(document.documentElement).getPropertyValue("--pink").trim()'), '#2a4b6c');
    assert.equal(await evaluate('localStorage.getItem("pi-desktop:theme:v1")'), '#2a4b6c');
    await evaluate(`document.querySelector('[data-testid="background-remove"]').click()`);
    assert.equal(await evaluate('localStorage.getItem("pi-desktop:photo:v1")'), null, 'removing the photo clears storage');
    await until(`${cloudStats}.inked === 0`);
    assert.equal((await evaluate(cloudStats)).inked, 0, 'the point cloud clears with the photo');
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
  assert.equal(await evaluate('["models","providers","workspace","git","usage","sessions","activity","tools","background"].filter((id) => document.querySelector(`[data-testid="settings-${id}"]`)).length'), 9, 'each window keeps its own settings row');
  await evaluate(`{ const box = document.querySelector('[data-testid="settings-workspace"]'); box.checked = true; box.dispatchEvent(new Event('change', { bubbles: true })); document.querySelector('#settings-dialog').close(); }`);
  assert.equal(await evaluate('document.querySelector("#tasks button[data-window-id=workspace]").hidden'), false, 'ticking a window adds its bottom button');
  assert.deepEqual(await evaluate('JSON.parse(localStorage.getItem("pi-desktop:taskbar:v1")).sort()'), ['activity', 'background', 'sessions', 'tools', 'usage', 'workspace'], 'choice persists');
  await until('document.querySelector("#settings-dialog").open === false');
  await evaluate(`document.querySelector('#settings').click(); { const box = document.querySelector('[data-testid="settings-workspace"]'); box.checked = false; box.dispatchEvent(new Event('change', { bubbles: true })); document.querySelector('#settings-dialog').close(); }`);
  assert.equal(await evaluate('document.querySelector("#tasks button[data-window-id=workspace]").hidden'), true, 'unticking hides it again');
  await evaluate(`document.querySelector('#settings').click(); document.querySelector('[data-testid="settings-open-git"]').click()`);
  assert.equal(await evaluate('document.querySelector("[data-window-id=git]").hidden'), false, 'settings can open a bottom-bar-hidden window directly');
  await evaluate(`document.querySelector('[data-window-id=git] button[aria-label="Close utility window"]').click()`);

  await evaluate('document.querySelector("#help").click(); document.querySelector("#help-dialog").close()');
  assert.equal(await evaluate('document.querySelectorAll(".sub-window").length'), 0, 'no child shell exists before an explicit launch or delegation');
  assert.equal(await evaluate('document.querySelector(".life-widget")'), null, 'decorative glider replaced');
  assert.equal(await evaluate('document.querySelector("#usage-diagram").dataset.agentId'), 'main');
  if (app) {
    assert.equal(await evaluate('document.querySelector(".usage-context").getAttribute("aria-valuenow")'), '25');
    assert.match(await evaluate('document.querySelector(".usage-totals").textContent'), /\$0\.1234/);
  }
  // The right rail reads as one column: the usage widget shares the clock widget's
  // right offset and width at the normal and the narrow layout, and the stylesheet
  // declares exactly that (a real computed check plus the source of truth).
  const railGap = "(() => {" +
    "const clock = getComputedStyle(document.querySelector('.clock-widget'));" +
    "const usage = getComputedStyle(document.querySelector('#usage-diagram'));" +
    "const clockTitle = getComputedStyle(document.querySelector('.clock-widget .utility-title'));" +
    "const usageTitle = getComputedStyle(document.querySelector('#usage-diagram .utility-title'));" +
    "return { right: [clock.right, usage.right], width: [clock.width, usage.width]," +
    " title: [clockTitle.fontSize + '/' + clockTitle.lineHeight, usageTitle.fontSize + '/' + usageTitle.lineHeight] };" +
    "})()";
  const wideRail = await evaluate(railGap);
  assert.equal(wideRail.right[0], wideRail.right[1], `usage and clock share the right offset (${wideRail.right.join(' vs ')})`);
  assert.equal(wideRail.width[0], wideRail.width[1], `usage and clock share the width (${wideRail.width.join(' vs ')})`);
  assert.equal(wideRail.title[0], wideRail.title[1], `usage and clock share the title rhythm (${wideRail.title.join(' vs ')})`);
  await rpc('Emulation.setDeviceMetricsOverride', { width: 900, height: 960, deviceScaleFactor: 1, mobile: false });
  await until('innerWidth === 900');
  await new Promise((done) => setTimeout(done, 400));
  const narrowRail = await evaluate(railGap);
  assert.equal(narrowRail.right[0], narrowRail.right[1], `the narrow rail keeps one right offset (${narrowRail.right.join(' vs ')})`);
  assert.equal(narrowRail.width[0], narrowRail.width[1], `the narrow rail keeps one width (${narrowRail.width.join(' vs ')})`);
  assert.equal(narrowRail.width[0], '215px', `the narrow rail is 215px wide (${narrowRail.width[0]})`);
  await rpc('Emulation.setDeviceMetricsOverride', { width: 1440, height: 960, deviceScaleFactor: 1, mobile: false });
  await until('innerWidth === 1440');
  await new Promise((done) => setTimeout(done, 400));
  const railCss = await evaluate(`(async () => (await (await fetch('/styles.css')).text()))()`);
  const declared = (rule, key) => (new RegExp(`(?:^|;)${key}:([^;]+)`).exec(rule) || [])[1];
  const usageRule = (/\.usage-widget\{([^}]*)\}/.exec(railCss) || [])[1] || '';
  const clockRule = (/\.clock-widget\{([^}]*)\}/.exec(railCss) || [])[1] || '';
  assert.equal(declared(usageRule, 'right'), declared(clockRule, 'right'), 'the usage rule declares the clock right offset');
  assert.equal(declared(usageRule, 'width'), declared(clockRule, 'width'), 'the usage rule declares the clock width');
  assert.equal(declared(usageRule, 'bottom'), '56px', 'usage stays anchored above the taskbar');
  const narrowBlock = (() => {
    const at = railCss.indexOf('@media(max-width:1000px)');
    let index = railCss.indexOf('{', at), depth = 0;
    const start = index;
    for (; index < railCss.length; index++) { if (railCss[index] === '{') depth++; else if (railCss[index] === '}') { depth--; if (!depth) break; } }
    return railCss.slice(start, index + 1);
  })();
  assert.match(narrowBlock, /\.clock-widget\{width:215px/, 'the clock shrinks in the narrow layout');
  assert.match(narrowBlock, /\.usage-widget\{width:215px/, 'the usage widget shrinks the same way');
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
  // Regression: Tools fills none of the shell's top rows, so the empty toolbar/status/connection must
  // collapse instead of leaving a blank strip between the title bar and the form. Models keeps its toolbar.
  await evaluate(`document.querySelector('#window-menu-toggle').click(); document.querySelector('[data-feature="tools"]').click()`);
  await until(`document.querySelector('[data-window-id="tools"]').hidden === false`);
  for (const row of ['feature-toolbar', 'feature-status', 'feature-connection']) {
    assert.equal(await evaluate(`getComputedStyle(document.querySelector('[data-window-id="tools"] .feature-window > .${row}')).display`), 'none', `empty Tools ${row} collapses`);
  }
  const toolsFormTop = await evaluate(`(() => { const panel = document.querySelector('[data-window-id="tools"] .feature-window'); return Math.round(panel.querySelector('.feature-tools-form').getBoundingClientRect().top - panel.getBoundingClientRect().top); })()`);
  assert.ok(toolsFormTop >= 0 && toolsFormTop < 12, 'Tools form sits directly under the title bar: ' + toolsFormTop);
  await evaluate(`document.querySelector('#window-menu-toggle').click(); document.querySelector('[data-feature="providers"]').click()`);
  await until(`document.querySelector('[data-window-id="providers"]').hidden === false`);
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('[data-window-id="providers"] .feature-window > .feature-toolbar')).display`), 'flex', 'Providers keeps its populated toolbar');
  if (app) {
    assert.equal(await evaluate('document.querySelector("[data-testid=tools-tool-subagent]").checked'), true, 'extension tool is visible and initially active for main');
    assert.match(await evaluate('document.querySelector("[data-testid=tools-extension]").textContent'), /pi-subagents/);
    await evaluate(`document.querySelector('[data-testid="tools-none"]').click(); document.querySelector('[data-testid="tools-apply"]').click()`);
    await until(`document.querySelector('[data-testid="tools-current"]').textContent.includes('None') && !document.querySelector('[data-testid="tools-apply"]').disabled`);
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
  // Reasoning renders inside the agent window again: each assistant message keeps its
  // own collapsible Thinking block, and no right-rail panel exists any more. The main
  // conversation is still empty here, so the block itself is checked once it has a reply.
  assert.equal(await evaluate('document.querySelector("#thinking-panel")'), null, 'the right-rail thinking panel is gone');
  assert.equal(await evaluate('document.querySelector("#thinking-stream, #thinking-follow, [data-testid=settings-thinking]")'), null, 'no stream, follow toggle or settings row remains');
  assert.equal(await evaluate('document.querySelectorAll(".thinking-widget").length'), 0, 'no right-rail widget styles remain in use');

  if (app) {
    const main = app.sessions.get('main');
    // The fixture numbers its replies by prompt call, so compute the expected text.
    const firstSample = `Thinking sample ${main.calls.length + 1} · checking the fixture.`;
    await main.act('prompt', { message: 'render one' });
    await until(`document.querySelector('.main-window .conversation').textContent.includes(${JSON.stringify(firstSample)})`);
    const blocks = await evaluate('document.querySelectorAll(".main-window .conversation details").length');
    assert.ok(blocks >= 1, 'the reply carries its reasoning block');
    const newest = await evaluate('[...document.querySelectorAll(".main-window .conversation details")].at(-1).querySelector("summary").textContent.trim()');
    assert.equal(newest, 'Thinking', 'the block is a Thinking expander');
    assert.ok(await evaluate(`[...document.querySelectorAll('.main-window .conversation .thinking-content')].at(-1).textContent.includes(${JSON.stringify(firstSample)})`), 'the newest reasoning text sits inside the block and is the fixture text');
    assert.ok(await evaluate('[...document.querySelectorAll(".main-window .conversation details")].at(-1).closest(".message") !== null'), 'the block belongs to the message it came from');
    assert.ok(await evaluate('[...document.querySelectorAll(".main-window .conversation .message-body")].at(-1).textContent.includes("Review result")'), 'the answer still renders below the block');
    // Main-window history search (Cmd/Ctrl+F): live matching across answer and
    // reasoning text with a counter, next/previous and Escape to clear.
    await evaluate('document.activeElement instanceof HTMLElement && document.activeElement.blur()');
    await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', metaKey: true, bubbles: true, cancelable: true }))`);
    await until('document.querySelector(".main-window .conversation-search")?.hidden === false');
    assert.equal(await evaluate('document.activeElement === document.querySelector(".main-window .search-input")'), true, 'Cmd/Ctrl+F focuses the search field');
    await evaluate(`{ const input = document.querySelector('.main-window .search-input'); input.value = 'fixture'; input.dispatchEvent(new Event('input', { bubbles: true })); }`);
    assert.ok(await evaluate('document.querySelector(".main-window .thinking-content mark.search-hit") !== null'), 'reasoning text is searchable');
    await evaluate(`{ const input = document.querySelector('.main-window .search-input'); input.value = 'Review result'; input.dispatchEvent(new Event('input', { bubbles: true })); }`);
    assert.ok(await evaluate('document.querySelector(".main-window .message-body mark.search-hit") !== null'), 'answer text is searchable');
    await evaluate(`{ const input = document.querySelector('.main-window .search-input'); input.value = 'ing'; input.dispatchEvent(new Event('input', { bubbles: true })); }`);
    const searchFirst = await evaluate('document.querySelector(".main-window .search-count").textContent');
    assert.match(searchFirst, /^1\/\d+$/, 'the counter shows the active match');
    assert.ok(Number(searchFirst.split('/')[1]) >= 2, 'the query has several matches to step through');
    await evaluate(`document.querySelector('.main-window .search-input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))`);
    assert.match(await evaluate('document.querySelector(".main-window .search-count").textContent'), /^2\//, 'Enter advances to the next match');
    await evaluate(`document.querySelector('.main-window .search-input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true, cancelable: true }))`);
    assert.match(await evaluate('document.querySelector(".main-window .search-count").textContent'), /^1\//, 'Shift + Enter steps back');
    // The composer keeps its own shortcuts: Cmd/Ctrl+F is not intercepted from the textarea.
    await evaluate('document.querySelector(".main-window textarea").focus()');
    const searchGuard = await evaluate(`(() => { const field = document.querySelector('.main-window textarea'); const event = new KeyboardEvent('keydown', { key: 'f', metaKey: true, bubbles: true, cancelable: true }); field.dispatchEvent(event); return event.defaultPrevented; })()`);
    assert.equal(searchGuard, false, 'Cmd/Ctrl+F is ignored while the composer has focus');
    await evaluate(`document.querySelector('.main-window .search-input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))`);
    assert.equal(await evaluate('document.querySelector(".main-window .conversation-search").hidden'), true, 'Escape closes and clears the search');
    assert.equal(await evaluate('document.querySelectorAll(".main-window mark.search-hit").length'), 0, 'closing removes the highlights');
    // A child window renders its own reasoning in its own conversation.
    await evaluate(`document.querySelector('#add-agent').click()`);
    const draftId = await evaluate(`[...document.querySelectorAll('[data-window-id]')].map((node) => node.dataset.windowId).filter((id) => String(id).startsWith('draft-')).at(-1)`);
    assert.ok(draftId, 'a subagent draft appeared for the child reasoning check');
    await evaluate(`{ const draft = document.querySelector('[data-window-id="${draftId}"]'); draft.querySelector('textarea').value = 'reasoning child'; draft.querySelector('.draft-body').requestSubmit(); }`);
    // Wait for the live child window itself, not just the session on the server.
    let childId = null;
    for (let attempt = 0; attempt < 120 && !childId; attempt++) {
      // Match against real sessions: delegated observers also carry a window id.
      const candidates = [...app.sessions.keys()].filter((id) => id !== 'main');
      childId = await evaluate(`(() => { const wanted = ${JSON.stringify(candidates)}; const node = [...document.querySelectorAll('[data-window-id]')].find((win) => wanted.includes(win.dataset.windowId)); return node ? node.dataset.windowId : null; })()`);
      if (!childId) await new Promise((done) => setTimeout(done, 100));
    }
    assert.ok(childId && app.sessions.has(childId), `the fixture launched a child for the reasoning check (draft ${draftId})`);
    const childConv = `document.querySelector('[data-window-id="${childId}"] .conversation')`;
    // The child window renders its own conversation, reasoning included. Its text is
    // the fixture's own stream: mutating the state object here would be overwritten by
    // the next state push, so assert on what the window actually shows.
    await until(`${childConv} && ${childConv}.querySelectorAll('.thinking-content').length >= 1`);
    assert.ok(await evaluate(`${childConv}.querySelector('.thinking-content').textContent.includes('Thinking sample')`), 'the child window renders its own reasoning inside its conversation');
    assert.ok(await evaluate(`${childConv}.querySelectorAll('details').length >= 1`), 'the child reasoning sits in a collapsible block like the main window');
    assert.ok(await evaluate(`${childConv}.querySelectorAll('.message').length >= 1`), 'the child conversation still renders its messages');
    // Leave no extra live child behind: the rest of the run counts windows.
    await evaluate(`window.confirm = () => true; document.querySelector('[data-window-id="${childId}"] button[aria-label="Close subagent window"]').click()`);
    await until(`document.querySelector('[data-window-id="${childId}"]') === null`);
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
  assert.equal(await evaluate('document.querySelector("#thinking-panel, #thinking-stream, [data-testid=settings-thinking]")'), null, 'no thinking panel exists after a reload either');
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
  console.log(`PASS: ${app ? 'fixture' : 'real Pi'} desktop, auth, rendering, drag, resize, minimize, arrange, ${app ? 'launch, tool selection, reusable subagent numbers, automatic delegated windows/live output, manual/delegated inspection, retro combobox keyboard/popup, safe text, handoff, ' : ''}Tools replacing Window Manager, appearance colours, photo point cloud, particle field, in-window reasoning, fleet activity, purpose-specific presets, usage chart, minimum-width opening, hide/show/reload layout memory, mobile layout`);
} finally {
  if (ws?.readyState === WebSocket.OPEN) ws.close();
  chrome.kill('SIGTERM');
  await new Promise((done) => { if (chrome.exitCode !== null) done(); else { chrome.once('exit', done); setTimeout(done, 3000).unref(); } });
  if (app) await app.close();
  await rm(profile, { recursive: true, force: true, maxRetries: 3 });
  await rm(dataDir, { recursive: true, force: true });
}
