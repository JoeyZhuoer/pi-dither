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
  const ctx = { api, getSelectedAgent: () => null };
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
const optionValues = (select) => select.options.map((option) => option.value);
const optionPairs = (select) => select.options.map((option) => [option.value, option.label]);
const change = (select) => select.dispatchEvent(new Event('change'));

test('widget model registers a 2x2 auto-applying descriptor', () => {
  const registered = [];
  install({ register: (definition) => registered.push(definition) });
  assert.equal(registered.length, 1);
  const [definition] = registered;
  assert.equal(definition.type, 'model');
  assert.equal(definition.title, 'Model & reasoning');
  assert.deepEqual(definition.defaultSize, [2, 2]);
  assert.deepEqual(definition.sizes, [[2, 2]]);
  for (const method of ['render', 'update', 'destroy']) assert.equal(typeof definition[method], 'function', method);
});

test('widget model renders three fields for the selected agent with no agent picker or apply buttons', (t) => {
  const f = fixture(); t.after(f.finish);
  const agent = main();
  f.ctx.getSelectedAgent = () => agent;
  f.definition.update({ connected: true, agents: [agent] }, f.ctx);

  assert.deepEqual([f.el('model-provider'), f.el('model-model'), f.el('model-thinking')].map((select) => select?.tagName), ['SELECT', 'SELECT', 'SELECT']);
  assert.equal(f.el('model-agent'), null, 'the agent select is gone');
  assert.equal(f.el('model-apply'), null, 'the model apply button is gone');
  assert.equal(f.el('model-thinking-apply'), null, 'the thinking apply button is gone');

  assert.deepEqual(optionValues(f.el('model-provider')), ['p']);
  assert.deepEqual(optionPairs(f.el('model-model')), [['one', 'One'], ['two', 'Two']]);
  assert.deepEqual(optionValues(f.el('model-thinking')), ['off', 'high']);
  assert.equal(f.el('model-model').value, 'one', 'the select starts on the agent model');
  assert.equal(f.el('model-thinking').value, 'off', 'the select starts on the reported level');
});

test('widget model follows ctx.getSelectedAgent and falls back to main then first', (t) => {
  const f = fixture(); t.after(f.finish);
  const agent = main(), kid = child();
  f.definition.update({ connected: true, agents: [agent, kid] }, f.ctx);
  // No selected agent: the widget mirrors main.
  assert.equal(f.el('model-provider').value, 'p');
  assert.deepEqual(optionValues(f.el('model-model')), ['one', 'two']);

  f.ctx.getSelectedAgent = () => kid;
  f.definition.update({ connected: true, agents: [agent, kid] }, f.ctx);
  assert.equal(f.el('model-provider').value, 'q');
  assert.deepEqual(optionValues(f.el('model-model')), ['solo']);
  assert.deepEqual(optionValues(f.el('model-thinking')), ['low']);

  // A selected agent missing from the sanitized list is still honored.
  const outside = { ...kid, id: 'external', model: { provider: 'q', id: 'solo' } };
  f.ctx.getSelectedAgent = () => outside;
  f.definition.update({ connected: true, agents: [agent, kid] }, f.ctx);
  assert.equal(f.el('model-provider').value, 'q');
});

test('widget model shows unavailable placeholders for an empty catalog', (t) => {
  const f = fixture(); t.after(f.finish);
  const bare = main({ model: null, models: [], levels: undefined, thinking: undefined });
  f.ctx.getSelectedAgent = () => bare;
  f.definition.update({ connected: true, agents: [bare] }, f.ctx);
  assert.deepEqual(optionPairs(f.el('model-provider')), [['', 'No providers']]);
  assert.deepEqual(optionPairs(f.el('model-model')), [['', 'No model available']]);
  assert.equal(optionValues(f.el('model-thinking')).length, 0);
  assert.equal(f.el('model-thinking').disabled, true, 'no reported levels disables the reasoning select');

  f.ctx.getSelectedAgent = () => null;
  f.definition.update({ connected: true, agents: [] }, f.ctx);
  assert.deepEqual(optionPairs(f.el('model-provider')), [['', 'No providers']]);
  assert.deepEqual(optionPairs(f.el('model-model')), [['', 'No model available']]);
});

test('widget model auto-applies the model and reasoning selects through ctx.api', async (t) => {
  const f = fixture(); t.after(f.finish);
  const agent = main();
  f.ctx.getSelectedAgent = () => agent;
  f.definition.update({ connected: true, agents: [agent] }, f.ctx);

  const modelSelect = f.el('model-model');
  modelSelect.value = 'two'; change(modelSelect); await tick();
  assert.deepEqual(f.calls.at(-1), { path: '/api/agents/main/model', body: { provider: 'p', modelId: 'two' } });

  const thinkingSelect = f.el('model-thinking');
  thinkingSelect.value = 'high'; change(thinkingSelect); await tick();
  assert.deepEqual(f.calls.at(-1), { path: '/api/agents/main/thinking', body: { level: 'high' } });

  assert.equal(f.calls.length, 2, 'each change sends exactly one write');
  assert.equal(f.el('model-status').textContent, 'Applied.');
  assert.equal(modelSelect.disabled, false, 'controls return after the request');
});

test('widget model re-derives models on a provider switch before applying', async (t) => {
  const f = fixture(); t.after(f.finish);
  const agent = main({ models: [
    { provider: 'p', id: 'one', name: 'One' },
    { provider: 'q', id: 'solo', name: 'Solo' },
  ], model: { provider: 'p', id: 'one' } });
  f.ctx.getSelectedAgent = () => agent;
  f.definition.update({ connected: true, agents: [agent] }, f.ctx);

  const providerSelect = f.el('model-provider');
  assert.deepEqual(optionValues(providerSelect), ['p', 'q']);
  providerSelect.value = 'q'; change(providerSelect); await tick();
  assert.deepEqual(optionValues(f.el('model-model')), ['solo'], 'the model list re-derives for the new provider');
  assert.equal(f.el('model-model').value, 'solo');
  assert.deepEqual(f.calls.at(-1), { path: '/api/agents/main/model', body: { provider: 'q', modelId: 'solo' } });
});

test('widget model serializes one in-flight write and applies the newest change next', async (t) => {
  const f = fixture(); t.after(f.finish);
  const agent = main();
  f.ctx.getSelectedAgent = () => agent;
  f.definition.update({ connected: true, agents: [agent] }, f.ctx);

  const modelSelect = f.el('model-model'), thinkingSelect = f.el('model-thinking');
  modelSelect.value = 'two'; change(modelSelect);
  assert.equal(f.calls.length, 1, 'the first change is already in flight');
  thinkingSelect.value = 'high'; change(thinkingSelect);
  assert.equal(f.calls.length, 1, 'a second change waits for the in-flight write');
  await tick();
  assert.equal(f.calls.length, 2, 'the queued change runs after');
  assert.deepEqual(f.calls[0], { path: '/api/agents/main/model', body: { provider: 'p', modelId: 'two' } });
  assert.deepEqual(f.calls[1], { path: '/api/agents/main/thinking', body: { level: 'high' } });
});

test('widget model keeps a failed write generic and guards every idle condition', async (t) => {
  const f = fixture(); t.after(f.finish);
  const fail = { ...f.ctx, api: async () => { throw new Error('secret provider detail'); } };
  const agent = main();
  f.ctx.getSelectedAgent = () => agent;
  f.definition.update({ connected: true, agents: [agent] }, fail);
  const modelSelect = f.el('model-model');
  modelSelect.value = 'two'; change(modelSelect); await tick();
  assert.equal(f.el('model-status').textContent, 'Update failed.');
  assert.doesNotMatch(f.root.textContent, /secret provider detail/);

  const apply = (selected = agent) => {
    f.ctx.getSelectedAgent = () => selected;
    f.definition.update({ connected: true, agents: [selected] }, f.ctx);
  };
  for (const [label, state] of [
    ['running', { phase: 'running' }],
    ['steering queued', { queue: { steering: ['x'] } }],
    ['follow-up queued', { queue: { followUp: ['y'] } }],
    ['agent offline', { connected: false }],
  ]) {
    apply(main(state));
    for (const testid of ['model-provider', 'model-model', 'model-thinking']) assert.equal(f.el(testid).disabled, true, `${testid} disabled when ${label}`);
  }
  f.ctx.getSelectedAgent = () => agent;
  f.definition.update({ connected: false, agents: [agent] }, f.ctx);
  assert.equal(f.el('model-provider').disabled, true, 'a disconnected desktop disables the selects');
  apply(main());
  assert.equal(f.el('model-provider').disabled, false, 'an idle agent re-enables the selects');
  assert.equal(f.el('model-thinking').disabled, false, 'a reported level keeps its control usable');
});

test('widget model encodes the selected agent id in both endpoints', async (t) => {
  const f = fixture(); t.after(f.finish);
  const agent = { ...main(), id: 'team/one' };
  f.ctx.getSelectedAgent = () => agent;
  f.definition.update({ connected: true, agents: [agent] }, f.ctx);
  const thinkingSelect = f.el('model-thinking');
  thinkingSelect.value = 'high'; change(thinkingSelect); await tick();
  assert.deepEqual(f.calls.at(-1), { path: '/api/agents/team%2Fone/thinking', body: { level: 'high' } });
});

test('widget model keeps the retro comboboxes in sync after state changes', (t) => {
  const f = fixture(); t.after(f.finish);
  const agent = main();
  f.ctx.getSelectedAgent = () => agent;
  f.definition.update({ connected: true, agents: [agent] }, f.ctx);
  const comboboxes = installComboboxes(f.root.ownerDocument.body);
  t.after(() => comboboxes.destroy());
  const providerSelect = f.el('model-provider');
  const triggerText = () => providerSelect.nextElementSibling.querySelector('.pi-combobox-text').textContent;
  assert.equal(providerSelect.classList.contains('pi-combobox-native'), true, 'the widget selects are enhanced');
  assert.equal(triggerText(), 'p');

  const kid = child();
  f.ctx.getSelectedAgent = () => kid;
  f.definition.update({ connected: true, agents: [agent, kid] }, f.ctx);
  assert.equal(providerSelect.value, 'q');
  assert.equal(triggerText(), 'q', 'the enhanced trigger follows the selected agent');
});

test('widget model destroy stops updates and releases the root', (t) => {
  const f = fixture();
  const agent = main();
  f.ctx.getSelectedAgent = () => agent;
  f.definition.update({ connected: true, agents: [agent] }, f.ctx);
  f.definition.destroy();
  assert.equal(f.root.children.length, 0);
  f.definition.update({ connected: true, agents: [child()] }, f.ctx);
  assert.equal(f.root.children.length, 0, 'a destroyed widget ignores later state');
  f.finish();
});
