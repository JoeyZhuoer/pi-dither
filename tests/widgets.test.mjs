import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WIDGET_KEY, WIDGET_CELL, WIDGET_GAP, WIDGET_ROW, WIDGET_SIZES, installWidgets } from '../desktop/public/widgets.js';

// Minimal DOM fixture for deterministic widget-host tests without a browser.
class Element extends EventTarget {
  constructor(tag) {
    super();
    this.tagName = tag.toUpperCase(); this.parent = null; this.children = [];
    this.dataset = {}; this.attributes = {}; this.style = {}; this.className = ''; this.id = '';
    this.hidden = false; this.open = false; this.checked = false; this.disabled = false; this.tabIndex = 0;
    this._text = ''; this._value = null;
    this.classList = {
      contains: (name) => this.className.split(' ').filter(Boolean).includes(name),
      add: (name) => { if (!this.classList.contains(name)) this.className = [...this.className.split(' ').filter(Boolean), name].join(' '); },
      remove: (name) => { this.className = this.className.split(' ').filter((part) => part && part !== name).join(' '); },
      toggle: (name, enabled) => { if (enabled) this.classList.add(name); else this.classList.remove(name); },
    };
  }
  get isConnected() { return this.tagName === 'BODY' || !!this.parent?.isConnected; }
  get options() { return this.children; }
  get value() {
    if (this.tagName === 'SELECT') return this.children.some((child) => child.value === this._value) ? this._value : this.children[0]?.value || '';
    return this._value || '';
  }
  set value(value) { this._value = String(value); }
  get textContent() { return this._text + this.children.map((child) => child.textContent).join(''); }
  set textContent(value) { this._text = String(value); for (const child of this.children) child.parent = null; this.children = []; }
  append(...nodes) { for (const child of nodes) { child.remove(); child.parent = this; this.children.push(child); } }
  prepend(...nodes) { for (const child of [...nodes].reverse()) { child.remove(); child.parent = this; this.children.unshift(child); } }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this); this.parent = null; }
  replaceChildren(...nodes) { this.textContent = ''; this.append(...nodes); }
  insertBefore(child, sibling) { child.remove(); child.parent = this; const index = this.children.indexOf(sibling); this.children.splice(index < 0 ? this.children.length : index, 0, child); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  removeAttribute(name) { delete this.attributes[name]; }
  click() { if (!this.disabled) this.dispatchEvent(new Event('click', { bubbles: true })); }
  querySelectorAll(selector) {
    const match = (child) => selector.split(',').some((part) => {
      const testid = part.match(/^\[data-testid="([^"]+)"\]$/);
      if (testid) return child.dataset.testid === testid[1];
      if (part.startsWith('#')) return child.id === part.slice(1);
      if (part.startsWith('.')) return child.classList.contains(part.slice(1));
      return child.tagName === part.toUpperCase();
    });
    return this.children.flatMap((child) => [...(match(child) ? [child] : []), ...child.querySelectorAll(selector)]);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}

class Document extends EventTarget {
  constructor() { super(); this.byId = new Map(); }
  createElement(tag) { return new Element(tag); }
  getElementById(id) { return this.byId.get(id) || null; }
}

class MemoryStorage {
  constructor() { this.map = new Map(); }
  getItem(key) { return this.map.has(key) ? this.map.get(key) : null; }
  setItem(key, value) { this.map.set(key, String(value)); }
}

function pointer(type, x, y) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  event.clientX = x; event.clientY = y;
  return event;
}
function key(type, value) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  event.key = value;
  return event;
}
function fixture({ items, selected = { id: 'main' } } = {}) {
  const document = new Document();
  const root = document.createElement('body');
  const button = document.createElement('button');
  button.id = 'widgets'; root.append(button); document.byId.set('widgets', button);
  const storage = new MemoryStorage();
  if (items) storage.setItem(WIDGET_KEY, JSON.stringify({ version: 1, items }));
  const host = installWidgets({
    root, storage, getState: () => ({ connected: false }), getSelectedAgent: () => selected,
    api: async () => ({}), openUsage: () => {}, document,
  });
  return { document, root, storage, host, button };
}
function sizeOf(width, height) { return [width * WIDGET_CELL + (width - 1) * WIDGET_GAP, height * WIDGET_ROW + (height - 1) * WIDGET_GAP]; }
function topOf(row) { return `${row * (WIDGET_ROW + WIDGET_GAP)}px`; }
function leftOf(column) { return `${column * (WIDGET_CELL + WIDGET_GAP)}px`; }
function persisted(storage) { return JSON.parse(storage.getItem(WIDGET_KEY)); }
function itemOf(storage, type) { return persisted(storage).items.find((item) => item.type === type); }
function registerFake(host, type, def = {}) {
  host.register({ type, title: `${type} fake`, render() {}, ...def });
}

test('widget store normalization applies defaults, ignores unknown types, keeps disabled geometry and clamps', () => {
  const { root, storage, host } = fixture({ items: [
    { type: 'clock', enabled: true, x: 9, y: -3, w: 3, h: 3 },
    { type: 'usage', enabled: false, x: 0, y: 4, w: 2, h: 3 },
    { type: 'ghost', enabled: true, x: 0, y: 0, w: 1, h: 1 },
  ] });
  registerFake(host, 'usage', { sizes: [[2, 2], [2, 3]], defaultSize: [2, 3] });
  registerFake(host, 'model', { sizes: [[2, 3]], defaultSize: [2, 3] });
  const clock = root.querySelector('[data-testid="widget-clock"]');
  const usage = root.querySelector('[data-testid="widget-usage"]');
  const model = root.querySelector('[data-testid="widget-model"]');
  assert.ok(clock && usage && model, 'every registered type renders');
  assert.equal(root.querySelector('[data-testid="widget-ghost"]'), null, 'unknown stored types are ignored');
  // clock: out-of-range x/y clamped to the origin, unsupported 3x3 falls back to its 2x2.
  assert.equal(clock.hidden, false);
  assert.equal(clock.style.left, leftOf(0)); assert.equal(clock.style.top, topOf(0));
  assert.deepEqual(sizeOf(2, 2), [clock.style.width, clock.style.height].map(parseFloat));
  // usage: disabled keeps its stored geometry instead of the 0,2 default.
  assert.equal(usage.hidden, true); assert.equal(usage.style.top, topOf(4));
  // model: missing from storage, so it is appended disabled at the 0,5 default.
  assert.equal(model.hidden, true); assert.equal(model.style.top, topOf(5));
  assert.ok(persisted(storage).items.some((item) => item.type === 'ghost'), 'loading alone leaves storage untouched');
  assert.deepEqual(WIDGET_SIZES, [[1, 1], [2, 1], [1, 2], [2, 2], [2, 3]]);
  host.dispose();
});

test('widget defaults materialize for a registered type missing from storage', () => {
  const { root, host } = fixture();
  registerFake(host, 'usage', { sizes: [[2, 3]], defaultSize: [2, 3] });
  registerFake(host, 'model', { sizes: [[2, 3]], defaultSize: [2, 3] });
  assert.equal(root.querySelector('[data-testid="widget-clock"]').hidden, false, 'clock defaults enabled');
  const usage = root.querySelector('[data-testid="widget-usage"]');
  const model = root.querySelector('[data-testid="widget-model"]');
  assert.equal(usage.hidden, false); assert.equal(usage.style.top, topOf(2));
  assert.equal(model.hidden, true); assert.equal(model.style.top, topOf(5));
  host.dispose();
});

test('widget drag snaps to the grid, rejects overlap and Escape cancels', () => {
  const { document, root, storage, host } = fixture();
  const clock = root.querySelector('[data-testid="widget-clock"]');
  const titlebar = clock.querySelector('.widget-titlebar');
  // Sub-half-cell motion snaps back to 0, then a full row lands at y = 1.
  titlebar.dispatchEvent(pointer('pointerdown', 0, 0));
  document.dispatchEvent(pointer('pointermove', 0, 40));
  assert.equal(clock.style.top, topOf(0), 'a 40px nudge snaps back');
  document.dispatchEvent(pointer('pointermove', 0, WIDGET_ROW + WIDGET_GAP));
  assert.equal(clock.style.top, topOf(1), 'a full row snaps to the next cell');
  document.dispatchEvent(pointer('pointerup', 0, WIDGET_ROW + WIDGET_GAP));
  assert.equal(itemOf(storage, 'clock').y, 1, 'drop persists the snapped cell');
  // Escape restores the pre-drag geometry and persists nothing.
  titlebar.dispatchEvent(pointer('pointerdown', 0, 0));
  document.dispatchEvent(pointer('pointermove', 0, 2 * (WIDGET_ROW + WIDGET_GAP)));
  assert.equal(clock.style.top, topOf(3));
  document.dispatchEvent(key('keydown', 'Escape'));
  assert.equal(clock.style.top, topOf(1), 'Escape cancels the drag');
  assert.equal(itemOf(storage, 'clock').y, 1, 'a cancelled drag is not persisted');
  // A later enabled widget is placed clear of the clock (now at y = 1). Dragging the
  // clock onto it pushes it to the next free row instead of rejecting the move.
  registerFake(host, 'usage', { sizes: [[2, 3]], defaultSize: [2, 3] });
  const usage = root.querySelector('[data-testid="widget-usage"]');
  assert.equal(usage.style.top, topOf(3), 'the later widget is relocated clear of the moved clock');
  titlebar.dispatchEvent(pointer('pointerdown', 0, 0));
  document.dispatchEvent(pointer('pointermove', 0, WIDGET_ROW + WIDGET_GAP));
  assert.equal(clock.style.top, topOf(2), 'the drag lands on the next row');
  assert.equal(usage.style.top, topOf(4), 'the overlapped widget is pushed to the next free row');
  document.dispatchEvent(pointer('pointerup', 0, WIDGET_ROW + WIDGET_GAP));
  assert.equal(itemOf(storage, 'usage').y, 4, 'the pushed widget is persisted');
  host.dispose();
});

test('arrow keys move a focused titlebar one cell and reject overlap', () => {
  const { root, storage, host } = fixture();
  const clock = root.querySelector('[data-testid="widget-clock"]');
  const titlebar = clock.querySelector('.widget-titlebar');
  titlebar.dispatchEvent(key('keydown', 'ArrowDown'));
  assert.equal(clock.style.top, topOf(1), 'ArrowDown moves one row');
  assert.equal(itemOf(storage, 'clock').y, 1, 'arrow moves persist');
  titlebar.dispatchEvent(key('keydown', 'ArrowUp'));
  assert.equal(clock.style.top, topOf(0), 'ArrowUp moves back');
  registerFake(host, 'usage', { sizes: [[2, 3]], defaultSize: [2, 3] });
  titlebar.dispatchEvent(key('keydown', 'ArrowDown'));
  assert.equal(clock.style.top, topOf(0), 'an overlapping arrow move is rejected');
  host.dispose();
});

test('widget manager toggles, resizes and resets with immediate persistence', () => {
  const { root, storage, host, button } = fixture();
  registerFake(host, 'usage', { sizes: [[2, 2], [2, 3]], defaultSize: [2, 3] });
  assert.equal(button.getAttribute('aria-haspopup'), null, 'the host does not restyle the page button');
  button.click();
  const manager = root.querySelector('#widget-manager');
  assert.equal(manager.open, true, 'the #widgets button opens the manager');
  const clock = root.querySelector('[data-testid="widget-clock"]');
  const usage = root.querySelector('[data-testid="widget-usage"]');
  const enableClock = root.querySelector('[data-testid="widget-enable-clock"]');
  enableClock.checked = false; enableClock.dispatchEvent(new Event('change', { bubbles: true }));
  assert.equal(clock.hidden, true); assert.equal(itemOf(storage, 'clock').enabled, false, 'disable persists');
  const reEnabled = root.querySelector('[data-testid="widget-enable-clock"]');
  reEnabled.checked = true; reEnabled.dispatchEvent(new Event('change', { bubbles: true }));
  assert.equal(clock.hidden, false); assert.equal(itemOf(storage, 'clock').enabled, true, 'enable persists');
  assert.equal(clock.style.top, topOf(0), 'enable/disable keeps geometry');
  const sizeUsage = root.querySelector('[data-testid="widget-size-usage"]');
  sizeUsage.value = '2x2'; sizeUsage.dispatchEvent(new Event('change', { bubbles: true }));
  assert.deepEqual([itemOf(storage, 'usage').w, itemOf(storage, 'usage').h], [2, 2]);
  assert.equal(usage.style.height, `${sizeOf(2, 2)[1]}px`);
  root.querySelector('[data-testid="widgets-reset"]').click();
  assert.deepEqual([itemOf(storage, 'usage').w, itemOf(storage, 'usage').h, itemOf(storage, 'usage').y], [2, 3, 2], 'reset restores widget defaults');
  assert.equal(usage.style.height, `${sizeOf(2, 3)[1]}px`);
  assert.equal(itemOf(storage, 'clock').enabled, true);
  host.dispose();
});

test('clock widget renders the local time and updates through refresh', () => {
  const { root, storage, host } = fixture();
  const clock = root.querySelector('[data-testid="widget-clock"]');
  const date = clock.querySelector('#date');
  const time = clock.querySelector('#clock');
  assert.ok(date && time, 'clock content renders inside the widget');
  assert.match(time.textContent, /^\d{2}:\d{2}:\d{2}$/);
  assert.ok(date.textContent.includes(String(new Date().getFullYear())));
  time.textContent = 'stale';
  host.refresh({ connected: false });
  assert.match(time.textContent, /^\d{2}:\d{2}:\d{2}$/, 'refresh re-syncs the clock');
  host.dispose();
});

test('widget context exposes the selected agent, host api and widgets self-reference', () => {
  const selected = { id: 'child', phase: 'idle' };
  const { host } = fixture({ selected });
  const calls = [];
  registerFake(host, 'probe', { render() {}, update(state, ctx) {
    calls.push({ state, selected: ctx.getSelectedAgent(), self: ctx.widgets, hasApi: typeof ctx.api === 'function' });
  } });
  host.refresh({ connected: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].state.connected, true);
  assert.equal(calls[0].selected, selected, 'getSelectedAgent follows the current selection');
  assert.equal(calls[0].self.register, host.register, 'ctx.widgets is the host api');
  assert.equal(calls[0].hasApi, true);
  host.dispose();
});
