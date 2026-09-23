import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setMaxListeners } from 'node:events';
import { installFeatureWindows, installUsageDiagram, usageDiagramData } from '../desktop/public/features.js';

// Small DOM fixture for deterministic controller tests without browser dependencies.
class Element extends EventTarget {
  constructor(tag, parent = null) {
    super(); this.tagName = tag.toUpperCase(); this.parent = parent; this.children = []; this.dataset = {}; this.attributes = {}; this.style = {}; this.className = ''; this._text = ''; this._value = null;
    this.classList = { toggle: (name, enabled) => { const names = new Set(this.className.split(' ').filter(Boolean)); if (enabled) names.add(name); else names.delete(name); this.className = [...names].join(' '); } };
  }
  addEventListener(type, callback, options) { if (options?.signal) setMaxListeners(0, options.signal); super.addEventListener(type, callback, options); }
  get isConnected() { return this.tagName === 'BODY' || !!this.parent?.isConnected; }
  get options() { return this.children; }
  get value() { return this.tagName === 'SELECT' ? (this.children.some(child => child.value === this._value) ? this._value : this.children[0]?.value || '') : this._value || ''; }
  set value(value) { this._value = String(value); }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  set textContent(value) { this._text = String(value); for (const child of this.children) child.parent = null; this.children = []; }
  append(...nodes) { for (const child of nodes) { child.remove(); child.parent = this; this.children.push(child); } }
  prepend(...nodes) { for (const child of [...nodes].reverse()) { child.remove(); child.parent = this; this.children.unshift(child); } }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); this.parent = null; }
  replaceChildren(...nodes) { this.textContent = ''; this.append(...nodes); }
  insertBefore(child, sibling) { child.remove(); child.parent = this; const index = this.children.indexOf(sibling); this.children.splice(index < 0 ? this.children.length : index, 0, child); }
  setAttribute(name, value) { this.attributes[name] = value; }
  removeAttribute(name) { delete this.attributes[name]; }
  querySelectorAll(selector) {
    const match = (child) => selector.split(',').some(part => {
      const testid = part.match(/^\[data-testid="([^"]+)"\]$/);
      return testid ? child.dataset.testid === testid[1] : part.startsWith('.') ? child.className.split(' ').includes(part.slice(1)) : child.tagName === part.toUpperCase();
    });
    return this.children.flatMap(child => [...(match(child) ? [child] : []), ...child.querySelectorAll(selector)]);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  click() { if (!this.disabled) this.dispatchEvent(new Event('click')); }
  requestSubmit() { this.dispatchEvent(new Event('submit', { cancelable: true })); }
}

test('usage diagram retains unknown values, scales real counts and never double-counts provisional usage', () => {
  const unknown = usageDiagramData();
  assert.equal(unknown.total, null); assert.equal(unknown.cost, null); assert.equal(unknown.context, null);
  assert.ok(unknown.segments.every(({ value, width }) => value === null && width === 0));
  const zero = usageDiagramData({ stats: { tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0, contextUsage: { percent: 0 } } });
  assert.equal(zero.total, 0); assert.equal(zero.context, 0); assert.ok(zero.segments.every(({ value, width }) => value === 0 && width === 0));
  const actual = usageDiagramData({ stats: { tokens: { input: 200, output: 50, cacheRead: 80, cacheWrite: 20, total: 400 }, cost: .0123, contextUsage: { percent: 105 } }, currentUsage: { totalTokens: 1000 } });
  assert.deepEqual(actual.segments.map(({ width }) => width), [100, 25, 50]);
  assert.equal(actual.total, 400); assert.equal(actual.provisional, 1000); assert.equal(actual.context, 105);
  const invalid = usageDiagramData({ stats: { tokens: { input: '123', output: NaN, cacheRead: 3, cacheWrite: null, total: -5 }, cost: Infinity, contextUsage: { percent: false } } });
  assert.equal(invalid.total, null); assert.equal(invalid.cost, null); assert.equal(invalid.context, null);
  assert.ok(invalid.segments.every(({ value }) => value === null));
});

test('usage diagram renders safe accessible telemetry, separate turn totals and stale connection state', (t) => {
  const previous = globalThis.document;
  globalThis.document = { createElement: (tag) => new Element(tag) };
  t.after(() => { if (previous === undefined) delete globalThis.document; else globalThis.document = previous; });
  const root = new Element('aside'); let opens = 0;
  const view = installUsageDiagram(root, () => opens++);
  const agent = { id: 'main', name: '<img src=x onerror=bad()>', connected: true, phase: 'idle', stats: { tokens: { input: 200, output: 50, cacheRead: 80, cacheWrite: 20, total: 350 }, cost: .0123, contextUsage: { percent: 25, tokens: 500, contextWindow: 2000 } } };
  view.update(agent, true);
  assert.equal(root.dataset.agentId, 'main'); assert.equal(root.dataset.stale, 'false');
  assert.equal(root.querySelector('.usage-agent').textContent, agent.name); assert.equal(root.querySelector('img'), null);
  assert.match(root.querySelector('.usage-totals').textContent, /350 TOK\$0\.0123/);
  assert.equal(root.querySelector('.usage-context').attributes['aria-valuenow'], '25');
  assert.match(root.querySelector('.usage-bars').attributes['aria-label'], /CACHE: 100 tokens/);
  agent.phase = 'running'; agent.currentUsage = { totalTokens: 42 }; view.update(agent, true);
  assert.match(root.querySelector('.usage-note').textContent, /42 turn tok \(provisional\)/);
  assert.match(root.querySelector('.usage-totals').textContent, /350 TOK/);
  view.update(agent, false); assert.equal(root.dataset.stale, 'true'); assert.match(root.textContent, /OFFLINE/);
  root.querySelector('button').click(); assert.equal(opens, 1);
  agent.stats = null; view.update(agent, true);
  assert.equal(root.querySelector('.usage-context').attributes['aria-valuenow'], undefined);
  assert.equal(root.querySelector('.usage-context').querySelector('.usage-fill').style.width, '0%');
  assert.match(root.querySelector('.usage-totals').textContent, /— TOK/);
});

test('feature controller preserves drafts, targets selected agents, protects credentials and ignores stale reads', async () => {
  const previous = { document: globalThis.document, confirm: globalThis.confirm };
  const body = new Element('body'), listeners = new Set(), map = new Map(), calls = [], held = new Map();
  globalThis.document = { createElement: tag => new Element(tag) };
  globalThis.confirm = () => true;
  const notify = () => { for (const listener of listeners) listener(); };
  const windows = {
    windows: map,
    add(options) { const root = new Element('section'); body.append(root); const win = { ...options, body: root }; map.set(options.id, win); return win; },
    list() { return [...map.values()]; },
    show(id) { map.get(id).hidden = false; notify(); },
    hide(id) { map.get(id).hidden = true; notify(); },
    toggle(id) { map.get(id).hidden = !map.get(id).hidden; notify(); },
    focus(win) { for (const value of map.values()) value.focused = value === win; notify(); },
    arrange() {},
    onChange(callback) { listeners.add(callback); return () => listeners.delete(callback); },
  };
  const main = { id: 'main', phase: 'idle', connected: true, sessionId: 'session', model: { provider: 'p', id: 'one' }, models: [{ provider: 'p', id: 'one' }, { provider: 'p', id: 'two' }], levels: ['off', 'high'], thinking: 'off' };
  const state = { connected: true, cwd: '/fixture', agents: [main, { ...main, id: 'child' }] };
  let failProvider = false;
  const api = async (path, data) => {
    calls.push({ path, data: data && structuredClone(data) });
    if (held.has(path)) return held.get(path).promise;
    if (path === '/api/providers/configure' && failProvider) throw new Error('Server echoed secret');
    if (data) return path.endsWith('/stop') ? { recovered: ['queued draft'] } : { ok: true };
    if (path === '/api/providers') return { providers: [{ id: 'p', canConfigure: true }] };
    if (path.startsWith('/api/workspace')) return { cwd: '/fixture', listingPath: '/fixture', parent: '/', entries: [], recent: [{ path: '/fixture', name: 'Fixture' }] };
    if (path === '/api/sessions') return { sessions: [{ key: 'opaque', name: 'Saved', cwd: '/fixture' }, { key: 'archived', name: 'Archived', archived: true }] };
    if (path === '/api/usage') return { agents: state.agents };
    if (path === '/api/git/diff') return { diff: '<img src=x>', truncated: true };
    return { isRepo: true, root: '/fixture', worktrees: [{ path: '/tree', branch: 'topic' }], files: [] };
  };
  const el = id => body.querySelector(`[data-testid="${id}"]`), tick = () => new Promise(resolve => setImmediate(resolve));
  const hold = path => { let resolve; const promise = new Promise(done => resolve = done); held.set(path, { promise }); return value => { held.delete(path); resolve(value); }; };
  let features;
  try {
    windows.add({ id: 'main', title: 'Main', kind: 'main' }); windows.add({ id: 'child', title: 'Child', kind: 'subagent' });
    features = installFeatureWindows({ windows, api, getState: () => state });
    const utilities = windows.list().filter(win => win.kind === 'utility');
    assert.equal(utilities.length, 9); assert.ok(utilities.every(win => win.hidden)); assert.equal(calls.length, 0);
    features.open('models'); el('models-agent').value = 'child'; el('models-agent').dispatchEvent(new Event('change'));
    el('models-model').value = 'two'; for (let i = 0; i < 20; i++) features.update(state);
    assert.equal(el('models-model').value, 'two'); assert.equal(calls.length, 0);
    el('models-apply').click(); await tick();
    assert.deepEqual(calls.at(-1), { path: '/api/agents/child/model', data: { provider: 'p', modelId: 'two' } });
    el('models-thinking').value = 'high'; el('models-thinking-apply').click(); await tick(); el('models-refresh').click(); await tick();
    assert.ok(calls.some(call => call.path === '/api/agents/child/thinking' && call.data.level === 'high'));
    assert.ok(calls.some(call => call.path === '/api/agents/child/refresh'));
    state.agents[1].phase = 'running'; features.update(state); assert.equal(el('models-apply').disabled, true);
    state.agents[1].phase = 'idle'; features.update(state);
    features.open('providers'); await tick(); const release = hold('/api/providers/configure');
    el('providers-key').value = 'secret'; el('providers-set').click(); el('providers-set').click();
    assert.equal(el('providers-key').value, ''); assert.equal(calls.filter(call => call.path === '/api/providers/configure').length, 1);
    release({ ok: true }); await tick(); assert.ok(!body.textContent.includes('secret'));
    failProvider = true; el('providers-key').value = 'secret'; el('providers-set').click(); await tick();
    assert.match(el('providers-status').textContent, /failed/); assert.ok(!body.textContent.includes('secret'));
    failProvider = false; el('providers-remove').click(); await tick(); assert.ok(calls.some(call => call.path === '/api/providers/configure' && call.data.remove));
    features.open('workspace'); await tick();
    const old = hold('/api/workspace?path=%2Fold'); el('workspace-path').value = '/old'; el('workspace-browse').click();
    const next = hold('/api/workspace?path=%2Fnext'); el('workspace-path').value = '/next'; el('workspace-browse').click();
    next({ listingPath: '/next', entries: [], recent: [] }); await tick(); old({ listingPath: '/old', entries: [], recent: [] }); await tick();
    assert.match(el('feature-workspace').textContent, /Browsing: \/next/); assert.doesNotMatch(el('feature-workspace').textContent, /Browsing: \/old/);
    el('workspace-remember').click(); await tick(); el('workspace-forget').click(); await tick(); el('workspace-parent').click(); await tick(); el('workspace-open').click(); await tick();
    for (const path of ['/api/workspace/remember', '/api/workspace/forget', '/api/workspace']) assert.ok(calls.some(call => call.path === path && call.data), path);
    features.open('git'); await tick(); el('git-load-diff').click(); await tick();
    assert.equal(el('git-diff').textContent, '<img src=x>'); assert.equal(el('git-diff').children.length, 0);
    assert.match(el('feature-git').textContent, /truncated/); el('git-worktree-open').click(); await tick();
    assert.ok(calls.some(call => call.path === '/api/workspace' && call.data?.path === '/tree'));
    features.open('usage'); await tick(); assert.match(el('feature-usage').textContent, /Unknown/);
    const usage = hold('/api/usage'); el('usage-refresh').click(); state.agents[0].currentUsage = { totalTokens: 123 }; features.update(state);
    usage({ agents: [{ ...main, currentUsage: null }] }); await tick(); assert.match(el('feature-usage').textContent, /123/);
    features.open('sessions'); await tick(); const rename = el('sessions-name'); rename.value = 'Unsubmitted'; features.update(state);
    assert.equal(el('sessions-name'), rename); assert.equal(rename.value, 'Unsubmitted');
    el('sessions-rename').click(); await tick(); el('sessions-archive').click(); await tick();
    el('sessions-show-archived').checked = true; el('sessions-show-archived').dispatchEvent(new Event('change'));
    body.querySelectorAll('[data-testid="sessions-archive"]').find(item => item.textContent === 'Restore').click(); await tick();
    el('sessions-resume').click(); await tick(); el('sessions-new').click(); await tick(); el('sessions-clone').click(); await tick();
    for (const path of ['/api/sessions/rename', '/api/sessions/archive', '/api/sessions/resume', '/api/agents/main/new', '/api/sessions/clone']) assert.ok(calls.some(call => call.path === path && call.data), path);
    assert.ok(calls.some(call => call.path === '/api/sessions/archive' && call.data.archived === false));
    el('sessions-search').value = 'not found'; el('sessions-search').dispatchEvent(new Event('input')); assert.match(el('feature-sessions').textContent, /No sessions match/);
    features.open('activity'); state.agents[0].phase = 'running'; state.agents[0].activity = [{ at: 1, type: 'tool_start', label: 'read fixture' }]; features.update(state);
    el('activity-focus').click(); assert.equal(map.get('main').focused, true); el('activity-stop').click(); await tick();
    assert.match(el('feature-activity').textContent, /read fixture/); assert.match(el('feature-activity').textContent, /queued draft/);
    assert.equal(features.open('windows'), false); assert.equal(map.has('windows'), false);
    assert.equal(el('feature-windows'), null);
    state.connected = false; features.update(state); assert.equal(el('workspace-open').disabled, true);
    assert.ok(!calls.some(call => call.path.endsWith('/prompt')));
    features.dispose(); assert.equal(listeners.size, 0); assert.equal(body.querySelector('.feature-window'), null); assert.equal(features.open('models'), false);
  } finally {
    features?.dispose(); globalThis.document = previous.document; globalThis.confirm = previous.confirm;
  }
});

test('feature menu, appearance window and window settings exist in the shell', async () => {
  const html = await readFile(new URL('../desktop/public/index.html', import.meta.url), 'utf8');
  assert.doesNotMatch(html, /data-feature="windows"|Window manager|window management/);
  assert.match(html, /data-feature="tools"/);
  assert.match(html, /data-feature="background">Appearance/);
  assert.match(html, /id="settings" aria-haspopup="dialog"/);
  assert.match(html, /id="settings-dialog"/);
  assert.match(html, /id="settings-list"/);
  assert.match(html, /data-testid not needed|/);
  assert.match(html, /id="arrange"/); assert.match(html, /id="tasks"/);
  assert.doesNotMatch(html, /background-motion|id="backdrop"/);
  assert.doesNotMatch(html, /id="background"/);
  assert.match(html, /id="particles"/);
  assert.match(html, /The desktop chrome and ground colours are yours in <strong>Appearance<\/strong>/);
  assert.match(html, /dithered photo/);
});

test('Tools drafts, authoritative Apply, guards, empty catalogs and stale responses (no provider)', async (t) => {
  const previous = globalThis.document;
  const body = new Element('body'), map = new Map(), listeners = new Set(), calls = [];
  globalThis.document = { createElement: tag => new Element(tag) };
  t.after(() => { globalThis.document = previous; });
  const notify = () => { for (const fn of listeners) fn(); };
  const windows = {
    windows: map,
    add(options) { const root = new Element('section'); body.append(root); const win = { ...options, body: root }; map.set(options.id, win); return win; },
    list() { return [...map.values()]; },
    show(id) { map.get(id).hidden = false; notify(); },
    focus() { notify(); },
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  };
  const catalog = [{ name: 'read', description: '<img src=x>Read files' }, { name: 'ls', description: 'List files' }];
  const main = { id: 'main', name: 'Main', connected: true, phase: 'idle', sessionId: 's1', availableTools: catalog, activeTools: ['read'], queue: { steering: [], followUp: [] } };
  const child = { ...main, id: 'child', name: 'Child', sessionId: 's2', activeTools: [] };
  let state = { cwd: '/fixture', connected: true, agents: [main, child] }, resolve, fail = false;
  const api = async (path, data) => {
    calls.push({ path, data });
    if (fail) throw new Error('Tools rejected');
    return new Promise(done => { resolve = done; });
  };
  const features = installFeatureWindows({ windows, api, getState: () => state });
  t.after(() => features.dispose());
  const el = id => body.querySelector(`[data-testid="${id}"]`), tick = () => new Promise(done => setImmediate(done));
  const update = (changes = {}) => { state = { ...state, ...changes }; features.update(state); };
  const patch = (id, changes) => update({ agents: state.agents.map(agent => agent.id === id ? { ...agent, ...changes } : agent) });
  const active = () => ['read', 'ls'].filter(name => el(`tools-tool-${name}`)?.checked);
  assert.equal(features.open('tools', 'child'), true); assert.equal(el('tools-agent').value, 'child');
  assert.match(el('tools-current').textContent, /None \(all tools disabled\)/);
  assert.equal(el('feature-tools').querySelector('img'), null);
  assert.equal(features.open('tools', 'missing'), false);
  el('tools-all').click(); assert.deepEqual(active(), ['read', 'ls']);
  const readInput = el('tools-tool-read');
  for (let i = 0; i < 20; i++) patch('main', { stats: { tokens: { total: i } } });
  patch('child', { stats: { tokens: { total: 4 } }, availableTools: [...catalog].reverse() });
  assert.equal(el('tools-tool-read'), readInput); assert.deepEqual(active(), ['read', 'ls']); assert.equal(calls.length, 0);
  el('tools-none').click(); assert.deepEqual(active(), []); assert.equal(calls.length, 0);
  el('tools-apply').click(); el('tools-apply').click();
  // Even synthetic form submission cannot bypass the pending guard.
  el('tools-apply').parent.parent.requestSubmit();
  assert.deepEqual(calls, [{ path: '/api/agents/child/tools', data: { tools: [] } }]);
  assert.equal(el('tools-tool-read').disabled, true);
  resolve({ availableTools: catalog, activeTools: [] }); await tick();
  assert.deepEqual(active(), []); assert.match(el('tools-current').textContent, /None/);
  el('tools-all').click(); el('tools-apply').click();
  resolve({ availableTools: catalog, activeTools: [] }); await tick();
  assert.deepEqual(active(), [], 'unchanged authoritative active set still resets the submitted draft');
  el('tools-all').click(); el('tools-apply').click();
  resolve({ availableTools: catalog, activeTools: ['ls'] }); await tick();
  assert.deepEqual(active(), ['ls']); assert.match(el('tools-current').textContent, /Current active tools: ls/);
  // Adopt the server's snapshot before testing later unrelated updates.
  patch('child', { activeTools: ['ls'] });
  el('tools-tool-read').checked = true; el('tools-tool-ls').checked = false;
  el('tools-apply').click(); assert.deepEqual(calls.at(-1).data, { tools: ['read'] });
  patch('child', { activeTools: [] });
  resolve({ availableTools: catalog, activeTools: ['read'] }); await tick();
  assert.deepEqual(active(), []); assert.match(el('tools-current').textContent, /None/);
  el('tools-all').click(); patch('child', { sessionId: 's3' }); assert.deepEqual(active(), []);
  el('tools-all').click(); el('tools-apply').click();
  patch('child', { availableTools: [{ ...catalog[0], description: 'Changed catalog' }] });
  resolve({ availableTools: catalog, activeTools: ['ls'] }); await tick();
  assert.deepEqual(active(), []); assert.equal(el('tools-tool-ls'), null);
  el('tools-all').click(); features.open('tools', 'main'); assert.deepEqual(active(), ['read']);
  features.open('tools', 'child'); assert.deepEqual(active(), []);
  patch('child', { availableTools: catalog, activeTools: [] });
  for (const changes of [
    { connected: false }, { phase: 'running' }, { queue: { steering: ['queued'], followUp: [] } },
    { queue: { steering: [], followUp: ['queued'] } }, { availableTools: null }, { activeTools: null },
    { availableTools: undefined }, { activeTools: undefined },
  ]) {
    patch('child', { ...child, ...changes });
    const before = calls.length;
    assert.equal(el('tools-apply').disabled, true, JSON.stringify(changes));
    el('tools-apply').parent.parent.requestSubmit(); await tick();
    assert.equal(calls.length, before);
  }
  patch('child', child); el('tools-all').click(); update({ connected: false });
  assert.equal(el('tools-apply').disabled, true); assert.deepEqual(active(), ['read', 'ls']);
  update({ connected: true }); assert.deepEqual(active(), ['read', 'ls']);
  patch('child', { availableTools: [], activeTools: [] });
  assert.equal(el('tools-apply').disabled, false); assert.match(el('feature-tools').textContent, /No tools available/);
  el('tools-apply').click(); resolve({ availableTools: [], activeTools: [] }); await tick();
  assert.deepEqual(calls.at(-1).data, { tools: [] });
  patch('child', child); el('tools-all').click(); fail = true; el('tools-apply').click(); await tick();
  assert.match(el('tools-status').textContent, /Tools rejected/); assert.deepEqual(active(), ['read', 'ls']);
  assert.equal(el('tools-apply').disabled, false); fail = false;
  el('tools-apply').click(); patch('child', { sessionId: 'new-session' });
  resolve({ availableTools: catalog, activeTools: ['ls'] }); await tick(); assert.deepEqual(active(), []);
  el('tools-all').click(); el('tools-apply').click(); features.open('tools', 'main');
  resolve({ availableTools: catalog, activeTools: ['ls'] }); await tick(); assert.deepEqual(active(), ['read']);
  features.open('tools', 'child'); el('tools-apply').click(); update({ agents: [state.agents[0]] });
  resolve({ availableTools: catalog, activeTools: ['read'] }); await tick(); assert.equal(el('tools-agent').value, 'main');
  update({ agents: [] }); assert.equal(el('tools-apply').disabled, true); assert.match(el('tools-current').textContent, /No agent/);
  assert.ok(calls.every(call => /^\/api\/agents\/(child|main)\/tools$/.test(call.path)));
});

test('feature windows: real DOM forms, contracts, guards and async races (synthetic API, no prompts)', { timeout: 45000, skip: process.env.PI_DESKTOP_FEATURE_BROWSER_TEST !== '1' }, async (t) => {
  const binary = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  try { await access(binary); } catch { t.skip('Set CHROME_PATH to run the real-DOM feature tests.'); return; }
  const source = await readFile(new URL('../desktop/public/features.js', import.meta.url));
  const css = await readFile(new URL('../desktop/public/features.css', import.meta.url));
  const windowsSource = await readFile(new URL('../desktop/public/windows.js', import.meta.url));
  const backgroundSource = await readFile(new URL('../desktop/public/background.js', import.meta.url));
  const particlesSource = await readFile(new URL('../desktop/public/particles.js', import.meta.url));
  const motionSource = await readFile(new URL('../desktop/public/motion.js', import.meta.url));
  const comboSource = await readFile(new URL('../desktop/public/combobox.js', import.meta.url));
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', req.url.endsWith('.js') ? 'text/javascript' : req.url === '/features.css' ? 'text/css' : 'text/html');
    res.end(req.url === '/combobox.js' ? comboSource : req.url === '/features.js' ? source : req.url === '/windows.js' ? windowsSource : req.url === '/background.js' ? backgroundSource : req.url === '/particles.js' ? particlesSource : req.url === '/motion.js' ? motionSource : req.url === '/features.css' ? css : '<!doctype html><title>Feature fixture</title><link rel="stylesheet" href="/features.css"><main id="desktop"></main>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const profile = await mkdtemp(join(tmpdir(), 'pi-feature-test-'));
  const chrome = spawn(binary, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-sync', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let ws, counter = 0, sessionId;
  const pending = new Map();
  try {
    const endpoint = await new Promise((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(new Error(`Chrome startup timed out: ${output.slice(-2000)}`)), 12000);
      chrome.once('error', (error) => { clearTimeout(timer); reject(error); });
      chrome.once('exit', (code) => { clearTimeout(timer); reject(new Error(`Chrome exited (${code}): ${output.slice(-2000)}`)); });
      chrome.stderr.on('data', (chunk) => {
        output += chunk;
        const match = output.match(/DevTools listening on (ws:\/\/\S+)/);
        if (match) { clearTimeout(timer); resolve(match[1]); }
      });
    });
    ws = new WebSocket(endpoint);
    await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); });
    ws.addEventListener('message', ({ data }) => {
      const message = JSON.parse(data), item = pending.get(message.id);
      if (!item) return;
      pending.delete(message.id); clearTimeout(item.timer);
      if (message.error) item.reject(new Error(JSON.stringify(message.error))); else item.resolve(message.result);
    });
    function rpc(method, params = {}, page = true) {
      const id = ++counter;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`CDP timeout: ${method}`)), 12000);
        pending.set(id, { resolve, reject, timer });
        ws.send(JSON.stringify({ id, method, params, ...(page && sessionId ? { sessionId } : {}) }));
      });
    }
    const { targetId } = await rpc('Target.createTarget', { url: 'about:blank' }, false);
    ({ sessionId } = await rpc('Target.attachToTarget', { targetId, flatten: true }, false));
    await rpc('Runtime.enable'); await rpc('Page.enable');
    await rpc('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/` });
    await rpc('Runtime.evaluate', { awaitPromise: true, expression: "document.readyState === 'complete' ? Promise.resolve() : new Promise(resolve => window.addEventListener('load', resolve, { once: true }))" });
    const result = await rpc('Runtime.evaluate', { awaitPromise: true, returnByValue: true, expression: `
      (async () => {
        const { installFeatureWindows } = await import('/features.js');
        const checks = [];
        const check = (value, name) => { if (!value) throw new Error(name); checks.push(name); };
        const tick = () => new Promise(resolve => setTimeout(resolve, 0));
        const el = (id) => document.querySelector('[data-testid="' + id + '"]');
        const click = (id) => el(id).click();
        const change = (id, value) => { el(id).value = value; el(id).dispatchEvent(new Event('change')); };
        let confirms = 0; globalThis.confirm = () => { confirms++; return true; };
        const listeners = new Set(), map = new Map();
        const notify = () => { for (const listener of listeners) listener(); };
        const windows = {
          windows: map,
          add(options) { const body = document.createElement('section'); body.hidden = options.hidden; document.querySelector('main').append(body); const win = { ...options, body, element: body, hidden: options.hidden }; map.set(options.id, win); return win; },
          list() { return [...map.values()].map(win => ({ id: win.id, title: win.title, kind: win.kind, hidden: win.hidden, focused: !!win.focused })); },
          show(id) { const win = map.get(id); if (win) { win.hidden = false; win.body.hidden = false; notify(); } },
          hide(id) { const win = map.get(id); if (win) { win.hidden = true; win.body.hidden = true; notify(); } },
          toggle(id) { map.get(id).hidden ? this.show(id) : this.hide(id); },
          focus(win) { for (const item of map.values()) item.focused = win === item; notify(); },
          arrange() { this.arranged = true; notify(); },
          onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
        };
        const main = { id: 'main', kind: 'main', name: 'Main', connected: true, phase: 'idle', sessionId: 's1', model: { provider: 'p', id: 'one' }, models: [{ provider: 'p', id: 'one' }, { provider: 'p', id: 'two' }], levels: ['off', 'high'], thinking: 'off', stats: { tokens: { input: 5, total: 10 }, cost: null }, activity: [], queue: { steering: [], followUp: [] }, availableTools: [{ name: 'read', description: '<img src=x>Read files' }, { name: 'ls', description: 'List files' }], activeTools: ['read'] };
        const child = { ...main, id: 'child', kind: 'subagent', name: 'Child', sessionId: 's2' };
        let state = { connected: true, cwd: '/fixture', agents: [main, child] };
        windows.add({ id: 'main', kind: 'main', title: 'Main' }); windows.add({ id: 'child', kind: 'subagent', title: 'Child' });
        const calls = [], toasts = [], deferred = new Map();
        let failProvider = false;
        const api = async (path, body) => {
          calls.push({ path, body: body ? JSON.parse(JSON.stringify(body)) : undefined });
          if (deferred.has(path)) return await deferred.get(path).promise;
          if (path === '/api/providers/configure' && failProvider) throw new Error('server echoed TEST-SECRET');
          if (body && path.endsWith('/tools')) return { availableTools: main.availableTools, activeTools: body.tools };
          if (body) return path.endsWith('/stop') ? { recovered: ['queued draft'] } : { ok: true, cwd: '/fixture' };
          if (path === '/api/providers') return { providers: [{ id: 'p', name: 'Provider', configured: true, canConfigure: true, temporaryOverride: false }, { id: 'oauth', name: 'OAuth', canConfigure: false }] };
          if (path.startsWith('/api/workspace')) return { cwd: '/fixture', listingPath: '/fixture', parent: '/', entries: [{ name: 'sub', path: '/fixture/sub', type: 'directory' }, { name: '<img src=x onerror=alert(1)>', path: '/fixture/file', type: 'file' }], recent: [{ name: 'Root', path: '/fixture' }] };
          if (path === '/api/git') return { isRepo: true, root: '/fixture', branch: 'main', head: 'abc', dirty: true, files: [{ path: '<script>bad</script>', status: 'M' }], worktrees: [{ path: '/fixture/tree', branch: 'topic' }] };
          if (path === '/api/git/diff') return { diff: '<img src=x onerror=alert(1)>', truncated: true };
          if (path === '/api/usage') return { agents: state.agents };
          if (path === '/api/sessions') return { sessions: [{ key: 'opaque/key', name: 'Saved', cwd: '/fixture', preview: 'preview', updated: 1, messageCount: 2, active: false, archived: false }, { key: 'archive', name: 'Archived', cwd: '/fixture', archived: true }] };
          throw new Error('Unexpected endpoint ' + path);
        };
        const hold = (path) => { let resolve; const promise = new Promise(done => resolve = done); deferred.set(path, { promise, resolve }); return value => { deferred.delete(path); resolve(value); }; };
        const features = installFeatureWindows({ windows, api, toast: value => toasts.push(value), getState: () => state });
        check([...map.values()].filter(win => win.kind === 'utility').length === 9 && [...map.values()].filter(win => win.kind === 'utility').every(win => win.hidden), 'nine utility windows initially hidden');
        check(calls.length === 0, 'installation makes no requests or prompts');
        check(features.open('tools', 'child') && el('tools-agent').value === 'child', 'Tools shortcut targets selected agent');
        check(el('tools-tool-read').checked && !el('tools-tool-ls').checked && !el('feature-tools').querySelector('img'), 'Tools checks reported active names and safely renders descriptions');
        click('tools-none');
        for (let i = 0; i < 20; i++) features.update(state);
        check(!el('tools-tool-read').checked && calls.length === 0, 'Tools none draft survives SSE without implicit Apply');
        const releaseTools = hold('/api/agents/child/tools'); click('tools-apply'); click('tools-apply');
        el('tools-apply').closest('form').requestSubmit();
        check(calls.length === 1 && calls[0].body.tools.length === 0 && el('tools-apply').disabled, 'Tools empty selection submits once via real form');
        releaseTools({ availableTools: child.availableTools, activeTools: [] }); await tick();
        check(el('tools-current').textContent.includes('None (all tools disabled)'), 'Tools shows authoritative empty active set');
        child.activeTools = []; features.update(state);
        click('tools-all'); click('tools-apply'); await tick();
        check(calls.at(-1).body.tools.join(',') === 'read,ls' && el('tools-tool-read').checked && el('tools-tool-ls').checked, 'Tools all is explicit and authoritative');
        child.activeTools = ['read', 'ls']; features.update(state);
        el('tools-tool-ls').click(); click('tools-apply'); await tick();
        check(calls.at(-1).body.tools.join(',') === 'read', 'real checkbox toggles apply a subset');
        child.activeTools = ['read']; child.queue = { steering: ['queued'], followUp: [] }; features.update(state);
        check(el('tools-apply').disabled && el('tools-tool-read').disabled, 'Tools queued target is disabled');
        child.queue = { steering: [], followUp: [] }; child.phase = 'running'; features.update(state);
        check(el('tools-apply').disabled, 'Tools busy target is disabled');
        child.phase = 'idle'; child.connected = false; features.update(state);
        check(el('tools-apply').disabled, 'Tools disconnected target is disabled');
        child.connected = true; child.activeTools = null; features.update(state);
        check(el('tools-apply').disabled && el('tools-current').textContent.includes('Unavailable'), 'missing Tools metadata never fabricates enabled tools');
        child.activeTools = []; child.availableTools = []; features.update(state);
        check(!el('tools-apply').disabled && !el('tools-tool-read'), 'empty catalog is supported and exposes no unavailable tools');
        child.availableTools = main.availableTools; child.activeTools = ['read']; features.update(state);
        calls.length = 0;
        features.open('models'); change('models-agent', 'child'); change('models-model', 'two');
        for (let i = 0; i < 20; i++) features.update(state);
        check(el('models-model').value === 'two' && calls.length === 0, 'SSE updates preserve model draft and never refresh-storm');
        click('models-apply'); await tick(); change('models-thinking', 'high'); click('models-thinking-apply'); await tick(); click('models-refresh'); await tick();
        check(calls.some(call => call.path === '/api/agents/child/model' && call.body.modelId === 'two') && calls.some(call => call.path === '/api/agents/child/thinking' && call.body.level === 'high') && calls.some(call => call.path === '/api/agents/child/refresh'), 'models and reasoning target selected agent');
        state.agents[1].phase = 'running'; features.update(state);
        check(el('models-apply').disabled, 'busy agent model mutation disabled');
        state.agents[1].phase = 'idle'; features.update(state);
        features.open('providers'); await tick();
        check(el('providers-key').type === 'password' && el('providers-provider').options.length === 1, 'provider keys use password and only configurable providers');
        const releaseProvider = hold('/api/providers/configure'); el('providers-key').value = 'TEST-SECRET'; click('providers-set'); click('providers-set');
        check(el('providers-key').value === '' && calls.filter(call => call.path === '/api/providers/configure').length === 1 && confirms === 1, 'credentials clear immediately; explicit reconnect and duplicate-submit protection');
        releaseProvider({ ok: true }); await tick();
        failProvider = true; el('providers-key').value = 'TEST-SECRET'; click('providers-set'); await tick();
        check(!document.body.textContent.includes('TEST-SECRET') && !toasts.join('').includes('TEST-SECRET'), 'provider errors cannot echo secrets');
        failProvider = false; click('providers-remove'); await tick();
        check(calls.some(call => call.path === '/api/providers/configure' && call.body.remove === true), 'provider remove endpoint');
        features.open('workspace'); await tick(); el('workspace-path').value = '/draft'; features.update(state);
        check(el('workspace-path').value === '/draft', 'workspace input preserved across updates');
        const releaseOld = hold('/api/workspace?path=%2Fold'); el('workspace-path').value = '/old'; click('workspace-browse');
        const releaseNew = hold('/api/workspace?path=%2Fnew'); el('workspace-path').value = '/new'; click('workspace-browse');
        releaseNew({ cwd: '/fixture', listingPath: '/new', entries: [], recent: [] }); await tick();
        releaseOld({ cwd: '/fixture', listingPath: '/old', entries: [], recent: [] }); await tick();
        check(el('feature-workspace').textContent.includes('Browsing: /new') && !el('feature-workspace').textContent.includes('Browsing: /old'), 'late directory response cannot replace newer browse');
        click('workspace-remember'); await tick(); click('workspace-forget'); await tick(); click('workspace-parent'); await tick(); click('workspace-open'); await tick();
        check(['/api/workspace/remember', '/api/workspace/forget', '/api/workspace'].every(path => calls.some(call => call.path === path && call.body)), 'bookmark, forget and confirmed workspace-open endpoints');
        features.open('git'); await tick(); click('git-load-diff'); await tick();
        check(el('git-diff').textContent.startsWith('<img') && el('feature-git').textContent.includes('truncated') && !el('feature-git').querySelector('img,script'), 'Git diff is safe plain text with truncation status');
        click('git-worktree-open'); await tick();
        check(calls.some(call => call.path === '/api/workspace' && call.body?.path === '/fixture/tree'), 'worktree opens through workspace contract');
        features.open('usage'); await tick();
        check(el('feature-usage').textContent.includes('Unknown') && el('usage-agent').options.length === 3, 'usage unknowns and all-agent selector');
        const releaseUsage = hold('/api/usage'); click('usage-refresh'); state.agents[0].currentUsage = { totalTokens: 123 }; features.update(state); releaseUsage({ agents: [{ ...main, currentUsage: null }] }); await tick();
        check(el('feature-usage').textContent.includes('123'), 'late usage response does not discard newer SSE usage');
        features.open('sessions'); await tick();
        const rename = el('sessions-name'); rename.value = 'Draft rename'; features.update(state);
        check(el('sessions-name') === rename && rename.value === 'Draft rename', 'session rename form survives SSE');
        click('sessions-rename'); await tick(); click('sessions-archive'); await tick();
        el('sessions-show-archived').checked = true; el('sessions-show-archived').dispatchEvent(new Event('change'));
        [...document.querySelectorAll('[data-testid="sessions-archive"]')].find(button => button.textContent === 'Restore').click(); await tick();
        click('sessions-resume'); await tick(); click('sessions-new'); await tick(); click('sessions-clone'); await tick();
        check(['/api/sessions/rename', '/api/sessions/archive', '/api/sessions/resume', '/api/agents/main/new', '/api/sessions/clone'].every(path => calls.some(call => call.path === path && call.body)), 'all session mutation contracts');
        check(calls.some(call => call.path === '/api/sessions/archive' && call.body.archived === false), 'session restore uses metadata archive=false');
        el('sessions-search').value = 'no match'; el('sessions-search').dispatchEvent(new Event('input'));
        check(el('feature-sessions').textContent.includes('No sessions match'), 'sessions search empty state');
        features.open('activity'); state.agents[0].phase = 'running'; state.agents[0].activity = [{ id: 'a', at: 1, type: 'tool_start', label: 'read fixture' }]; features.update(state);
        click('activity-focus'); check(map.get('main').focused, 'activity focuses actual agent'); click('activity-stop'); await tick();
        check(el('feature-activity').textContent.includes('read fixture') && el('feature-activity').textContent.includes('queued draft'), 'factual activity and stop preserve recovered queue');
        check(features.open('windows') === false && !map.has('windows') && !el('feature-windows'), 'removed manager has no controller, panel or task');
        state.connected = false; features.update(state); check(el('workspace-open').disabled && el('activity-stop').disabled, 'disconnected controls disabled');
        check(!calls.some(call => call.path.endsWith('/prompt')), 'no model prompts issued');
        state.connected = true; state.agents[0].phase = 'idle'; features.update(state); await tick();
        const releaseDispose = hold('/api/git'); click('git-refresh'); features.dispose(); releaseDispose({ isRepo: true, root: 'late' }); await tick();
        check(!document.querySelector('.feature-window') && listeners.size === 0, 'dispose removes UI/listeners and ignores late responses');
        check(features.open('models') === false, 'disposed open is inert');
        const { DesktopWindows } = await import('/windows.js');
        localStorage.setItem('pi-desktop:layout:v1', JSON.stringify({ windows: { x: 20, y: 20, w: 600, h: 400, hidden: false } }));
        const desktop = document.createElement('main'), tasks = document.createElement('footer');
        desktop.style.cssText = 'width:1200px;height:800px'; document.body.append(desktop, tasks);
        const engine = new DesktopWindows(desktop, tasks);
        const legacyFeatures = installFeatureWindows({ windows: engine, api, getState: () => ({ connected: true, agents: [] }) });
        check(!engine.windows.has('windows') && !desktop.querySelector('[data-window-id="windows"]') && !tasks.textContent.includes('Windows'), 'legacy visible manager layout creates no panel or task');
        legacyFeatures.open('tools');
        const toolsWindow = engine.windows.get('tools');
        toolsWindow.element.querySelector('[aria-label="Minimize window"]').click();
        check(toolsWindow.element.hidden, 'normal minimize control retained');
        toolsWindow.task.click(); check(!toolsWindow.element.hidden, 'taskbar still restores Tools');
        toolsWindow.element.querySelector('[aria-label="Close utility window"]').click();
        check(toolsWindow.element.hidden, 'normal utility close retained');
        engine.show('tools'); engine.arrange();
        check(!toolsWindow.element.hidden && tasks.children.length === 9, 'Arrange and nine feature tasks retained');
        legacyFeatures.dispose(); desktop.remove(); tasks.remove(); localStorage.removeItem('pi-desktop:layout:v1');

        return checks;
      })()
    ` });
    assert.equal(result.exceptionDetails, undefined, result.exceptionDetails?.exception?.description);
    assert.ok(result.result.value.length >= 25);
    t.diagnostic(result.result.value.join('\n'));
  } finally {
    for (const item of pending.values()) clearTimeout(item.timer);
    ws?.close();
    chrome.kill('SIGTERM');
    if (chrome.exitCode === null) await new Promise((resolve) => { const timeout = setTimeout(resolve, 2000); chrome.once('exit', () => { clearTimeout(timeout); resolve(); }); });
    await new Promise((resolve) => server.close(resolve));
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
