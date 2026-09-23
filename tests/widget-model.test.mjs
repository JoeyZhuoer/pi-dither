import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setMaxListeners } from 'node:events';
import { installComboboxes } from '../desktop/public/combobox.js';
import { install } from '../desktop/public/widget-model.js';

// Small DOM fixture for deterministic widget tests without a browser. It is a superset of the
// shim in features.test.mjs: enough surface for the widget and for the real combobox enhancer
// (matches/classList/after/ownerDocument), so combobox sync can be observed for real.
class Element extends EventTarget {
  constructor(tag) {
    super();
    this.tagName = tag.toUpperCase(); this.parent = null; this.children = []; this.dataset = {};
    this.attributes = {}; this.style = {}; this.className = ''; this._text = ''; this._value = '';
    this.ownerDocument = null; this.disabled = false; this.hidden = false; this.tabIndex = 0;
    this.classList = {
      add: (...names) => { const set = new Set(this.className.split(' ').filter(Boolean)); names.forEach((name) => set.add(name)); this.className = [...set].join(' '); },
      remove: (...names) => { const set = new Set(this.className.split(' ').filter(Boolean)); names.forEach((name) => set.delete(name)); this.className = [...set].join(' '); },
      contains: (name) => this.className.split(' ').includes(name),
      toggle: (name, enabled) => { const set = new Set(this.className.split(' ').filter(Boolean)); if (enabled) set.add(name); else set.delete(name); this.className = [...set].join(' '); },
    };
  }
  addEventListener(type, callback, options) { if (options?.signal) setMaxListeners(0, options.signal); super.addEventListener(type, callback, options); }
  get nodeType() { return 1; }
  get options() { return this.children; }
  get label() { return this.textContent; }
  _selectValue() { return this.children.some((child) => child.value === this._value) ? this._value : (this.children[0]?.value ?? ''); }
  _selectIndex() { const index = this.children.findIndex((child) => child.value === this._value); return index < 0 ? 0 : index; }
  get value() { return this.tagName === 'SELECT' ? this._selectValue() : this._value; }
  set value(value) { this._value = String(value); }
  get selectedIndex() { return this._selectIndex(); }
  set selectedIndex(index) { const child = this.children[index]; if (child) this._value = String(child.value); }
  get textContent() { return this._text + this.children.map((child) => child.textContent).join(''); }
  set textContent(value) { this._text = String(value); for (const child of this.children) child.parent = null; this.children = []; }
  get parentNode() { return this.parent; }
  get nextElementSibling() { if (!this.parent) return null; return this.parent.children[this.parent.children.indexOf(this) + 1] || null; }
  append(...nodes) { for (const child of nodes) { child.remove(); child.parent = this; this.children.push(child); } }
  prepend(...nodes) { for (const child of [...nodes].reverse()) { child.remove(); child.parent = this; this.children.unshift(child); } }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this); this.parent = null; }
  replaceChildren(...nodes) { this.textContent = ''; this.append(...nodes); }
  insertBefore(child, sibling) { child.remove(); child.parent = this; const index = this.children.indexOf(sibling); this.children.splice(index < 0 ? this.children.length : index, 0, child); }
  after(...nodes) { if (!this.parent) return; let index = this.parent.children.indexOf(this); for (const child of nodes) { child.remove(); child.parent = this.parent; this.parent.children.splice(++index, 0, child); } }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  removeAttribute(name) { delete this.attributes[name]; }
  getAttribute(name) { return name in this.attributes ? this.attributes[name] : null; }
  hasAttribute(name) { return name in this.attributes; }
  matches(selector) {
    if (selector === ':disabled') return !!this.disabled;
    if (selector.startsWith('.')) return this.className.split(' ').includes(selector.slice(1));
    return this.tagName === selector.toUpperCase();
  }
  contains(node) { return node === this || this.children.some((child) => child.contains(node)); }
  querySelectorAll(selector) {
    const match = (child) => selector.split(',').some((part) => {
      const testid = part.match(/^\[data-testid="([^"]+)"\]$/);
      return testid ? child.dataset.testid === testid[1] : part.startsWith('.') ? child.className.split(' ').includes(part.slice(1)) : child.tagName === part.toUpperCase();
    });
    return this.children.flatMap((child) => [...(match(child) ? [child] : []), ...child.querySelectorAll(selector)]);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  focus() {}
  click() { if (!this.disabled) this.dispatchEvent(new Event('click')); }
}

class FakeMutationObserver { constructor(callback) { this.callback = callback; } observe() {} disconnect() {} }
class FakeHTMLSelectElement {}
Object.defineProperty(FakeHTMLSelectElement.prototype, 'value', { configurable: true, get() { return this._selectValue(); }, set(value) { this._value = String(value); } });
Object.defineProperty(FakeHTMLSelectElement.prototype, 'selectedIndex', { configurable: true, get() { return this._selectIndex(); }, set(index) { const child = this.children[index]; if (child) this._value = String(child.value); } });

function createDocument() {
  const doc = new EventTarget(), win = new EventTarget();
  win.MutationObserver = FakeMutationObserver; win.HTMLSelectElement = FakeHTMLSelectElement; win.Event = Event;
  win.innerWidth = 1200; win.innerHeight = 800; win.queueMicrotask = queueMicrotask; win.document = doc;
  doc.nodeType = 9; doc.defaultView = win;
  doc.createElement = (tag) => { const element = new Element(tag); element.ownerDocument = doc; return element; };
  doc.body = doc.createElement('body');
  doc.querySelectorAll = (selector) => doc.body.querySelectorAll(selector);
  doc.contains = (node) => doc.body.contains(node);
  return doc;
}

function fixture() {
  const previous = globalThis.document, doc = createDocument();
  globalThis.document = doc;
  const root = doc.createElement('div'); doc.body.append(root);
  const calls = [];
  const api = async (path, body) => { calls.push({ path, body: body && structuredClone(body) }); return body ? { ok: true } : {}; };
  const ctx = { api };
  let definition = null;
  install({ register: (next) => { definition = next; } });
  definition.render(root, ctx);
  const el = (testid) => root.querySelector(`[data-testid="${testid}"]`);
  const finish = () => { definition.destroy(); if (previous === undefined) delete globalThis.document; else globalThis.document = previous; };
  return { definition, root, calls, ctx, el, finish };
}

const main = (extra = {}) => ({
  id: 'main', name: 'Main', connected: true, phase: 'idle', thinking: 'off', levels: ['off', 'high'],
  model: { provider: 'p', id: 'one' }, models: [{ provider: 'p', id: 'one', name: 'One' }, { provider: 'p', id: 'two', name: 'Two' }], ...extra,
});
const child = (extra = {}) => ({
  id: 'child', name: 'Child', connected: true, phase: 'idle', thinking: 'low', levels: ['low'],
  model: { provider: 'q', id: 'solo' }, models: [{ provider: 'q', id: 'solo', name: 'Solo' }], ...extra,
});
const tick = () => new Promise((resolve) => setImmediate(resolve));

test('widget model registers the frozen descriptor', () => {
  const registered = [];
  install({ register: (definition) => registered.push(definition) });
  assert.equal(registered.length, 1);
  const [definition] = registered;
  assert.equal(definition.type, 'model');
  assert.equal(definition.title, 'Model & reasoning');
  assert.deepEqual(definition.defaultSize, [2, 3]);
  assert.deepEqual(definition.sizes, [[2, 2], [2, 3]]);
  for (const method of ['render', 'update', 'destroy']) assert.equal(typeof definition[method], 'function', method);
});

test('widget model selects reflect reported state and never invent options', (t) => {
  const f = fixture(); t.after(f.finish);
  f.definition.update({ connected: true, agents: [main(), child()] }, f.ctx);
  const optionValues = (select) => select.options.map((option) => option.value);
  const optionLabels = (select) => select.options.map((option) => option.label);

  assert.deepEqual(optionValues(f.el('model-agent')), ['main', 'child']);
  assert.deepEqual(optionLabels(f.el('model-agent')), ['Main', 'Child']);
  assert.equal(f.el('model-agent').value, 'main');
  assert.deepEqual(optionValues(f.el('model-provider')), ['p']);
  assert.deepEqual(optionValues(f.el('model-model')), ['one', 'two']);
  assert.deepEqual(optionValues(f.el('model-thinking')), ['off', 'high']);
  assert.equal(f.el('model-model').value, 'one');
  assert.equal(f.el('model-thinking').value, 'off');
  assert.match(f.el('model-current').textContent, /Main · idle · Current: p \/ one · Thinking: off/);

  // Selecting another agent swaps every choice to that agent's reported catalog.
  const agentSelect = f.el('model-agent');
  agentSelect.value = 'child'; agentSelect.dispatchEvent(new Event('change'));
  assert.deepEqual(optionValues(f.el('model-provider')), ['q']);
  assert.deepEqual(optionValues(f.el('model-model')), ['solo']);
  assert.deepEqual(optionValues(f.el('model-thinking')), ['low']);
  assert.equal(f.el('model-model').value, 'solo');
  assert.match(f.el('model-current').textContent, /Child · idle · Current: q \/ solo · Thinking: low/);
});

test('widget model shows unavailable placeholders instead of guessing', (t) => {
  const f = fixture(); t.after(f.finish);
  f.definition.update({ connected: true, agents: [main({ model: null, models: [], levels: undefined, thinking: undefined })] }, f.ctx);
  assert.deepEqual(f.el('model-provider').options.map((option) => [option.value, option.label]), [['', 'No providers']]);
  assert.deepEqual(f.el('model-model').options.map((option) => [option.value, option.label]), [['', 'No model available']]);
  assert.equal(f.el('model-thinking').options.length, 0);
  assert.match(f.el('model-current').textContent, /Current: Unknown · Thinking: Unknown/);
  for (const testid of ['model-apply', 'model-thinking-apply']) assert.equal(f.el(testid).disabled, true, testid);

  f.definition.update({ connected: true, agents: [] }, f.ctx);
  assert.deepEqual(f.el('model-agent').options.map((option) => [option.value, option.label]), [['', 'No agents']]);
  assert.deepEqual(f.el('model-provider').options.map((option) => [option.value, option.label]), [['', 'No providers']]);
  assert.deepEqual(f.el('model-model').options.map((option) => [option.value, option.label]), [['', 'No model available']]);
  assert.equal(f.el('model-current').textContent, 'No agents.');
  assert.equal(f.el('model-apply').disabled, true);
});

test('widget model preserves a draft until the agent\'s authoritative state changes', (t) => {
  const f = fixture(); t.after(f.finish);
  f.definition.update({ connected: true, agents: [main()] }, f.ctx);
  f.el('model-model').value = 'two';
  f.definition.update({ connected: true, agents: [main({ phase: 'idle' })] }, f.ctx);
  assert.equal(f.el('model-model').value, 'two', 'unrelated updates keep the draft');
  f.el('model-thinking').value = 'high';
  f.definition.update({ connected: true, agents: [main({ thinking: 'high' })] }, f.ctx);
  assert.equal(f.el('model-thinking').value, 'high', 'reported state selects the runtime value');
});

test('widget model applies model and thinking through ctx.api with exact bodies', async (t) => {
  const f = fixture(); t.after(f.finish);
  f.definition.update({ connected: true, agents: [main()] }, f.ctx);
  f.el('model-model').value = 'two'; f.el('model-thinking').value = 'high';

  f.el('model-apply').click(); await tick();
  assert.deepEqual(f.calls.at(-1), { path: '/api/agents/main/model', body: { provider: 'p', modelId: 'two' } });
  f.el('model-thinking-apply').click(); await tick();
  assert.deepEqual(f.calls.at(-1), { path: '/api/agents/main/thinking', body: { level: 'high' } });
  assert.equal(f.calls.length, 2);
  assert.equal(f.el('model-status').textContent, 'Applied.');
  assert.equal(f.el('model-apply').disabled, false, 'controls return after the request');

  // A double submit while a request is in flight sends exactly one write.
  f.definition.update({ connected: true, agents: [child()] }, f.ctx);
  f.el('model-apply').click(); f.el('model-apply').click(); await tick();
  assert.equal(f.calls.length, 3);
});

test('widget model keeps errors generic and guards every idle condition', async (t) => {
  const f = fixture(); t.after(f.finish);
  const fail = { api: async () => { throw new Error('secret provider detail'); } };
  f.definition.update({ connected: true, agents: [main()] }, fail);
  f.el('model-apply').click(); await tick();
  assert.equal(f.el('model-status').textContent, 'Update failed.');
  assert.doesNotMatch(f.root.textContent, /secret provider detail/);

  const setPhase = (extra) => f.definition.update({ connected: true, agents: [main(extra)] }, f.ctx);
  for (const [label, state] of [
    ['running', { phase: 'running' }],
    ['steering queued', { queue: { steering: ['x'] } }],
    ['follow-up queued', { queue: { followUp: ['y'] } }],
    ['agent offline', { connected: false }],
  ]) {
    setPhase(state);
    assert.equal(f.el('model-apply').disabled, true, label);
    assert.equal(f.el('model-thinking-apply').disabled, true, label);
    assert.equal(f.el('model-provider').disabled, true, label);
    assert.equal(f.el('model-model').disabled, true, label);
    assert.equal(f.el('model-thinking').disabled, true, label);
  }
  f.definition.update({ connected: false, agents: [main()] }, f.ctx);
  assert.equal(f.el('model-apply').disabled, true, 'disconnected desktop disables Apply');
  setPhase({});
  assert.equal(f.el('model-apply').disabled, false, 'idle agent re-enables Apply');
  assert.equal(f.el('model-thinking').disabled, false, 'reported thinking level keeps its control usable');
});

test('widget model encodes the selected agent id in both endpoints', async (t) => {
  const f = fixture(); t.after(f.finish);
  const agent = { ...main(), id: 'team/one' };
  f.definition.update({ connected: true, agents: [agent] }, f.ctx);
  f.el('model-thinking').value = 'high';
  f.el('model-thinking-apply').click(); await tick();
  assert.deepEqual(f.calls.at(-1), { path: '/api/agents/team%2Fone/thinking', body: { level: 'high' } });
});

test('widget model keeps the retro comboboxes in sync after state changes', (t) => {
  const f = fixture(); t.after(f.finish);
  f.definition.update({ connected: true, agents: [main(), child()] }, f.ctx);
  const comboboxes = installComboboxes(f.root.ownerDocument.body);
  t.after(() => comboboxes.destroy());
  const agentSelect = f.el('model-agent');
  const triggerText = () => agentSelect.nextElementSibling.querySelector('.pi-combobox-text').textContent;
  assert.equal(agentSelect.classList.contains('pi-combobox-native'), true, 'the widget selects are enhanced');
  assert.equal(triggerText(), 'Main');

  agentSelect.value = 'child'; agentSelect.dispatchEvent(new Event('change'));
  assert.equal(triggerText(), 'Child');

  // Removing the selected agent leaves no explicit value assignment, so only the widget's
  // explicit syncCombobox call can refresh the enhanced trigger text.
  f.definition.update({ connected: true, agents: [main({ name: 'Main renamed' })] }, f.ctx);
  assert.equal(agentSelect.value, 'main');
  assert.equal(triggerText(), 'Main renamed');
});

test('widget model destroy stops updates and releases the root', (t) => {
  const f = fixture();
  f.definition.update({ connected: true, agents: [main()] }, f.ctx);
  f.definition.destroy();
  assert.equal(f.root.children.length, 0);
  f.definition.update({ connected: true, agents: [child()] }, f.ctx);
  assert.equal(f.root.children.length, 0, 'a destroyed widget ignores later state');
  f.finish();
});
