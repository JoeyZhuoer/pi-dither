import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DesktopWindows, nextSubagentIndex, subagentIndexFromName } from '../desktop/public/windows.js';

test('subagent display numbers reuse the lowest free slot and remain independent of UUIDs/z-order', () => {
  assert.equal(nextSubagentIndex([]), 1);
  assert.equal(nextSubagentIndex([2, 3]), 1);
  assert.equal(nextSubagentIndex([1, 3, 4]), 2);
  assert.equal(nextSubagentIndex([1, 2, 3]), 4, 'hidden windows still supply their occupied indices');
  assert.equal(nextSubagentIndex([0, -1, NaN, Infinity, '1', 1.5, 999999]), 1);
  assert.equal(subagentIndexFromName('SCOUT / 01'), 1);
  assert.equal(subagentIndexFromName('SUBAGENT / 99'), 99);
  for (const name of ['Main', 'SCOUT / -1', 'SCOUT / 00', 'SCOUT / 1.5']) assert.equal(subagentIndexFromName(name), undefined);
  const slots = new Set([1, 2]);
  for (let i = 0; i < 100; i++) { slots.delete(1); const slot = nextSubagentIndex(slots); assert.equal(slot, 1); slots.add(slot); }
});

// Small DOM fixture: window-manager behavior without a browser/runtime dependency.
class Events {
  listeners = new Map();
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(fn);
  }
  removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); }
  emit(type, input = {}) {
    const event = { target: this, preventDefault() { this.defaultPrevented = true; }, ...input };
    for (const fn of [...(this.listeners.get(type) || [])]) fn(event);
    return event;
  }
}
class Element extends Events {
  constructor(tag, doc) {
    super(); this.tagName = tag.toUpperCase(); this.doc = doc; this.children = []; this.style = {}; this.dataset = {};
    this.attributes = {}; this.hidden = false; this.className = ''; this.captures = new Set();
    this.classList = {
      contains: (name) => this.className.split(' ').includes(name),
      toggle: (name, enabled) => {
        const classes = new Set(this.className.split(' ').filter(Boolean));
        if (enabled) classes.add(name); else classes.delete(name);
        this.className = [...classes].join(' ');
      },
      remove: (name) => this.classList.toggle(name, false),
    };
  }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name]; }
  append(...nodes) { for (const node of nodes) { this.children.push(node); node.parentElement = this; } }
  remove() { this.parentElement.children = this.parentElement.children.filter((node) => node !== this); this.parentElement = null; }
  contains(node) { return node === this || this.children.some((child) => child.contains(node)); }
  matches(selector) {
    if (selector === '[hidden]') return this.hidden;
    if (selector.startsWith('.')) return this.classList.contains(selector.slice(1));
    return this.tagName === selector.toUpperCase();
  }
  closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector); }
  querySelector(selector) {
    for (const node of this.children) { if (node.matches(selector)) return node; const nested = node.querySelector(selector); if (nested) return nested; }
    return null;
  }
  set innerHTML(value) {
    assert.match(value, /^<div class="titlebar"/);
    const make = (tag, name) => { const node = new Element(tag, this.doc); node.className = name; return node; };
    const titlebar = make('div', 'titlebar'); titlebar.setAttribute('tabindex', '0');
    titlebar.append(make('span', 'window-title'), make('div', 'titlebar-controls'));
    this.append(titlebar, make('div', 'window-body'), make('button', 'resize-handle'));
  }
  focus() {
    if (this.closest('[hidden]') || this.disabled) return;
    this.doc.activeElement = this;
    for (let node = this; node; node = node.parentElement) node.emit('focusin', { target: this });
  }
  setPointerCapture(id) { this.captures.add(id); }
  hasPointerCapture(id) { return this.captures.has(id); }
  releasePointerCapture(id) { this.captures.delete(id); }
}
const originalGlobals = Object.fromEntries(['document', 'window', 'localStorage', 'matchMedia', 'ResizeObserver'].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
function fixture(t, raw = null, denied = false) {
  const doc = { createElement: (tag) => new Element(tag, doc), activeElement: null };
  let stored = raw;
  const storage = {
    getItem() { if (denied) throw new Error('denied'); return stored; },
    setItem(key, value) { assert.equal(key, 'pi-desktop:layout:v1'); if (denied) throw new Error('denied'); stored = value; },
  };
  const browser = new Events();
  Object.assign(globalThis, { document: doc, window: browser, localStorage: storage, matchMedia: () => ({ matches: false }) });
  t.after(() => { for (const [key, descriptor] of Object.entries(originalGlobals)) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; } });
  const desktop = doc.createElement('div'), tasks = doc.createElement('div');
  desktop.clientWidth = 1400; desktop.clientHeight = 900;
  const manager = new DesktopWindows(desktop, tasks);
  return { manager, desktop, tasks, doc, browser, get stored() { return JSON.parse(stored); } };
}
test('compact presets stay purpose-specific while windows open at minimum width and medium height', (t) => {
  const { manager } = fixture(t);
  const main = addMain(manager);
  const child = manager.add({ id: 'child', title: 'Child', kind: 'subagent' });
  const delegate = manager.add({ id: 'opaque-run-child', title: 'Observer', kind: 'delegated' });
  const ids = ['models', 'providers', 'workspace', 'git', 'usage', 'sessions', 'activity', 'tools', 'background'];
  const compact = new Set(), opened = new Set();
  for (const id of ids) {
    const win = addUtility(manager, id);
    compact.add(`${win.rect.w},${win.rect.h}`);
    assert.deepEqual(win.layoutRect, manager.defaultRect('utility', 0, id));
    manager.show(id);
    // Every purpose opens at the minimum usable width with a medium height.
    assert.equal(win.rect.w, 400, id + ' opens at minimum width');
    assert.equal(win.rect.h, 540, id + ' opens at medium height');
    assert.equal(win.sizeMode, 'auto', id + ' opens automatic');
    opened.add(`${win.rect.w},${win.rect.h}`);
    manager.place(win, { ...win.rect, w: 410, h: 330 });
    assert.deepEqual(win.layoutRect, { ...win.rect });
    manager.arrange(); manager.show(id);
    assert.equal(win.rect.w, 400); assert.equal(win.rect.h, 540);
  }
  assert.equal(compact.size, ids.length, 'compact presets remain purpose-specific');
  assert.equal(opened.size, 1, 'opening size no longer varies by purpose');
  const fallback = addUtility(manager, 'arbitrary');
  assert.equal(fallback.rect.w, 820, 'unknown utilities keep a roomy compact preset');
  manager.show(fallback.id); assert.equal(fallback.rect.w, 400);
  assert.ok(delegate.rect.w > child.rect.w && delegate.rect.h > child.rect.h, 'observers keep a larger compact anchor than manual children');
  manager.show(delegate.id); assert.equal(delegate.rect.w, 400); assert.equal(delegate.rect.h, 540);
  manager.place(main, { x: 0, y: 0, w: 610, h: 440 });
  assert.equal(delegate.rect.w, 400); assert.equal(delegate.rect.h, 540);
  assert.ok(child.rect.h < main.rect.h);
});

test('delegated observers use former starter right-side anchors and migrate only untouched old defaults', (t) => {
  const f = fixture(t, JSON.stringify({
    old: { x: 70, y: 45, w: 560, h: 430, zoomed: false, hidden: true },
    custom: { x: 70, y: 45, w: 560, h: 430, zoomed: true },
  }));
  const { manager, desktop, browser } = f;
  addMain(manager);
  const a = manager.add({ id: 'old', title: 'Observer', kind: 'delegated', index: 0 });
  const b = manager.add({ id: 'second', title: 'Observer', kind: 'delegated', index: 1 });
  for (const [index, win] of [a, b].entries()) {
    const anchor = manager.legacyDefaultRect('subagent', index);
    assert.equal(win.rect.y, anchor.y);
    assert.equal(win.rect.x + win.rect.w, anchor.x + anchor.w);
    assert.equal(win.rect.w, win.element.hidden ? 560 : 400, 'visible observers open at minimum width, hidden ones keep the compact anchor');
  }
  assert.equal(a.element.hidden, true);
  assert.equal(f.stored.second.observerIndex, 1);
  assert.equal(new DesktopWindows(desktop, f.tasks).saved.second.observerIndex, 1, 'observer reservation is persisted independently of manual slots');
  const custom = manager.add({ id: 'custom', title: 'Custom', kind: 'delegated' });
  assert.deepEqual(custom.layoutRect, { x: 70, y: 45, w: 560, h: 430 }, 'manual adjustment wins even at former default location');
  const preferred = { ...b.layoutRect };
  globalThis.matchMedia = () => ({ matches: true });
  desktop.clientWidth = 390; browser.emit('resize');
  assert.deepEqual(b.layoutRect, preferred);
  globalThis.matchMedia = () => ({ matches: false });
  desktop.clientWidth = 1400; browser.emit('resize');
  assert.deepEqual(b.rect, preferred);
  manager.arrange();
  assert.equal(custom.rect.y, 105);
  assert.equal(custom.rect.x + custom.rect.w, desktop.clientWidth - 25);
});

test('purpose profiles preserve manual/legacy rectangles, hidden state, mobile preference and Arrange', (t) => {
  const f = fixture(t, JSON.stringify({ tools: { x: 50, y: 60, w: 680, h: 530, hidden: true } }));
  const { manager, desktop, tasks, browser } = f;
  addMain(manager);
  const tools = addUtility(manager, 'tools');
  manager.show('tools'); assert.deepEqual(tools.rect, { x: 50, y: 60, w: 680, h: 530 });
  const delegate = manager.add({ id: 'observer', title: 'Observer', kind: 'delegated' });
  const custom = { x: 160, y: 120, w: 950, h: 730 };
  manager.place(delegate, custom); manager.hide(delegate.id);
  const restored = new DesktopWindows(desktop, tasks);
  const copy = restored.add({ id: 'observer', title: 'Observer', kind: 'delegated' });
  assert.equal(copy.element.hidden, true); assert.deepEqual(copy.layoutRect, custom);
  globalThis.matchMedia = () => ({ matches: true });
  desktop.clientWidth = 370; desktop.clientHeight = 1800; browser.emit('resize');
  restored.show(copy.id); assert.deepEqual(copy.layoutRect, custom);
  const mobileNew = restored.add({ id: 'workspace', title: 'Workspace', kind: 'utility' });
  const preferred = { ...mobileNew.layoutRect };
  assert.equal(preferred.w, 800); restored.show(mobileNew.id); assert.equal(mobileNew.zoomed, false);
  globalThis.matchMedia = () => ({ matches: false });
  desktop.clientWidth = 1400; desktop.clientHeight = 900; browser.emit('resize');
  assert.deepEqual(copy.rect, custom); assert.deepEqual(mobileNew.rect, preferred);
  restored.hide(copy.id); restored.arrange();
  assert.equal(copy.element.hidden, true); assert.equal(copy.zoomed, false);
  assert.deepEqual(copy.layoutRect, restored.defaultRect('delegated', 0, copy.id));
  assert.deepEqual(mobileNew.layoutRect, restored.defaultRect('utility', 0, 'workspace'));
  restored.show(copy.id); assert.equal(copy.rect.w, 400); assert.equal(copy.rect.h, 540);
});

const addMain = (manager) => manager.add({ id: 'main', title: 'Main', kind: 'main' });
const addUtility = (manager, id = 'models') => manager.add({ id, title: id.toUpperCase(), kind: 'utility', hidden: true });
const button = (win, label) => win.element.querySelector('.titlebar-controls').children.find((node) => node.getAttribute('aria-label') === label);

test('DesktopWindows utility contract, notifications, safe rename and non-destructive close', (t) => {
  const { manager, doc } = fixture(t);
  const main = addMain(manager); main.titlebar.focus();
  const changes = []; const unsubscribe = manager.onChange((list) => changes.push(list));
  let closes = 0;
  const utility = manager.add({ id: 'models', title: 'Models', kind: 'utility', hidden: true, onClose: () => closes++ });
  assert.equal(doc.activeElement, main.titlebar);
  assert.deepEqual(manager.list(), [
    { id: 'main', title: 'Main', kind: 'main', hidden: false, focused: true },
    { id: 'models', title: 'Models', kind: 'utility', hidden: true, focused: false },
  ]);
  assert.ok(utility.element.classList.contains('utility-window'));
  assert.equal(utility.element.classList.contains('sub-window'), false);
  assert.equal(manager.add({ id: 'models', title: 'Duplicate' }), utility);
  manager.focus(utility); assert.equal(manager.focused, main);
  manager.show('models'); assert.equal(doc.activeElement, utility.titlebar);
  assert.equal(manager.list()[1].focused, true);
  manager.rename('models', '<img src=x>');
  assert.equal(utility.task.textContent, '<img src=x>');
  assert.equal(utility.element.getAttribute('aria-label'), '<img src=x>');
  assert.match(utility.titlebar.getAttribute('aria-label'), /Shift plus arrows to resize/);
  button(utility, 'Close utility window').emit('click');
  assert.equal(closes, 0); assert.equal(manager.windows.get('models'), utility);
  assert.equal(utility.element.hidden, true); assert.equal(doc.activeElement, main.titlebar);
  utility.task.emit('click'); assert.equal(utility.element.hidden, false);
  manager.toggle('models'); assert.equal(utility.element.hidden, true);
  manager.toggle('models'); assert.equal(utility.element.hidden, false);
  assert.ok(changes.length >= 6);
  const count = changes.length; unsubscribe(); manager.rename('models', 'New'); assert.equal(changes.length, count);
  changes[0][0].title = 'mutated'; assert.equal(manager.list()[0].title, 'Main');
  for (const method of ['show', 'hide', 'toggle', 'rename', 'remove']) assert.doesNotThrow(() => manager[method]('missing', 'No'));
});

test('DesktopWindows subagent close callback and legacy reveal/focus stay compatible', (t) => {
  const { manager } = fixture(t); const main = addMain(manager);
  let closed;
  const child = manager.add({ id: 'child', title: 'Child', onClose: (win) => { closed = win; } });
  assert.ok(main.element.classList.contains('main-window')); assert.ok(child.element.classList.contains('sub-window'));
  button(child, 'Close subagent window').emit('click');
  assert.equal(closed, child); assert.equal(manager.windows.get('child'), child);
  button(main, 'Minimize window').emit('click');
  main.element.hidden = false; manager.focus(main);
  assert.equal(main.minimized, false); assert.equal(manager.list()[0].focused, true);
});

test('DesktopWindows preserves utility geometry and visibility across incremental startup beyond 12 windows', (t) => {
  const f = fixture(t); const { manager, desktop, tasks } = f;
  addMain(manager);
  for (let i = 0; i < 10; i++) manager.add({ id: `agent-${i}`, title: 'Agent' });
  for (const id of ['models', 'providers', 'workspace', 'git', 'usage', 'sessions', 'activity', 'windows']) addUtility(manager, id);
  manager.show('activity'); manager.place(manager.windows.get('activity'), { x: 180, y: 100, w: 900, h: 650 }); manager.save();
  const restored = new DesktopWindows(desktop, tasks);
  addMain(restored); // Saving this first window must not erase pending utility entries.
  const activity = addUtility(restored, 'activity'), models = addUtility(restored, 'models');
  assert.deepEqual(activity.rect, { x: 180, y: 100, w: 900, h: 650 });
  assert.equal(activity.element.hidden, false); assert.equal(models.element.hidden, true);
  restored.hide('activity'); assert.equal(f.stored.activity.hidden, true);
  restored.remove('activity'); assert.equal(Object.hasOwn(f.stored, 'activity'), false);
  assert.equal(f.stored.main.hidden, false, 'agent visibility is persisted too');
});

test('DesktopWindows auto-zooms defaults once and preserves manual sizing over hide/show and reload', (t) => {
  const f = fixture(t), { manager, desktop, tasks } = f;
  addMain(manager); const utility = addUtility(manager), before = { ...utility.rect };
  assert.equal(f.stored.models.zoomed, false, 'creating hidden windows does not consume first-selection zoom');
  manager.show('models'); assert.equal(utility.rect.w, 400); assert.equal(utility.rect.h, 540);
  const enlarged = { ...utility.rect };
  for (let i = 0; i < 4; i++) { manager.hide('models'); manager.show('models'); manager.focus(utility); }
  assert.deepEqual(utility.rect, enlarged, 'no cumulative growth');
  const adjusted = { x: 120, y: 90, w: 650, h: 450 };
  manager.place(utility, adjusted); manager.hide('models'); manager.show('models');
  assert.deepEqual(utility.rect, adjusted);
  manager.hide('models');
  const restored = new DesktopWindows(desktop, tasks); addMain(restored); const reopened = addUtility(restored);
  assert.equal(reopened.element.hidden, true); restored.show('models'); assert.deepEqual(reopened.rect, adjusted);
  restored.arrange(); assert.equal(reopened.zoomed, false); restored.show('models'); assert.equal(reopened.rect.w, 400);
});

test('opening geometry recovers from a narrow native viewport and retains its mode through reload', (t) => {
  const f = fixture(t), { manager, desktop, tasks, browser } = f;
  desktop.clientWidth = 800; desktop.clientHeight = 600;
  addMain(manager); const models = addUtility(manager);
  manager.show(models.id); const narrow = { ...models.rect };
  assert.equal(models.sizeMode, 'auto'); assert.equal(f.stored.models.sizeMode, 'auto');
  assert.equal(narrow.w, 400); assert.equal(narrow.h, 360);
  desktop.clientWidth = 1440; desktop.clientHeight = 940; browser.emit('resize');
  assert.equal(models.rect.w, 400, 'minimum width does not scale with the viewport');
  assert.ok(models.rect.h > narrow.h, 'one-time fitting must not pin the narrow height');
  assert.equal(models.rect.h, 564);
  const preferred = { ...models.layoutRect }, focused = manager.focused;
  manager.hide(models.id); desktop.clientWidth = 900; browser.emit('resize');
  assert.equal(models.element.hidden, true); assert.notEqual(manager.focused, models);
  assert.deepEqual(models.layoutRect, preferred, 'resize leaves the preferred position intact');
  manager.destroy(); const restored = new DesktopWindows(desktop, tasks); addMain(restored);
  const copy = addUtility(restored); assert.equal(copy.element.hidden, true); assert.equal(copy.sizeMode, 'auto');
  desktop.clientWidth = 1440; desktop.clientHeight = 940; restored.resize(); restored.show(copy.id); assert.equal(copy.rect.w, 400);
  assert.equal(copy.rect.h, 564);
  assert.equal(focused, models); restored.destroy();
});

test('Arrange restores automatic fitting on selection; manual overrides, maximize restore and mobile remain safe', (t) => {
  const f = fixture(t, JSON.stringify({ main: { x: 35, y: 25, w: 700, h: 500, zoomed: true } }));
  const { manager, desktop, browser } = f; const main = addMain(manager);
  manager.show('main'); assert.equal(main.rect.w, 700); assert.equal(main.sizeMode, 'manual');
  manager.arrange(); manager.show('main'); assert.equal(main.sizeMode, 'auto'); assert.equal(main.rect.w, 610); assert.equal(main.rect.h, 540);
  button(main, 'Maximize or restore main window').emit('click'); assert.equal(main.restoreMode, 'auto');
  desktop.clientWidth = 1000; desktop.clientHeight = 700; browser.emit('resize');
  button(main, 'Maximize or restore main window').emit('click');
  assert.equal(main.sizeMode, 'auto'); assert.equal(main.rect.w, 610); assert.equal(main.rect.h, 440);
  manager.place(main, { x: 20, y: 30, w: 650, h: 480 }); manager.save();
  const preferred = { ...main.layoutRect }; desktop.clientWidth = 1400; browser.emit('resize');
  assert.deepEqual(main.rect, preferred); assert.equal(main.sizeMode, 'manual');
  globalThis.matchMedia = () => ({ matches: true }); desktop.clientWidth = 390; browser.emit('resize');
  assert.equal(manager.autoSize(), false); assert.deepEqual(main.layoutRect, preferred);
  globalThis.matchMedia = () => ({ matches: false }); desktop.clientWidth = 1400; browser.emit('resize');
  assert.deepEqual(main.rect, preferred); manager.arrange(); manager.show('main'); assert.equal(main.sizeMode, 'auto');
  manager.arrange(); assert.equal(main.sizeMode, 'compact'); assert.equal(main.zoomed, false);
});

test('maximized auto-sized windows retain restore intent across reload', (t) => {
  const { manager, desktop, tasks } = fixture(t); const main = addMain(manager);
  manager.autoSize(main); button(main, 'Maximize or restore main window').emit('click');
  manager.destroy(); desktop.clientWidth = 1000; desktop.clientHeight = 700;
  const next = new DesktopWindows(desktop, tasks), copy = addMain(next);
  assert.equal(copy.restoreMode, 'auto'); assert.ok(copy.restore);
  button(copy, 'Maximize or restore main window').emit('click');
  assert.equal(copy.sizeMode, 'auto'); assert.equal(copy.rect.w, 610); assert.equal(copy.rect.h, 440);
  desktop.clientWidth = 1400; desktop.clientHeight = 900; next.resize(); assert.equal(copy.rect.w, 610); assert.equal(copy.rect.h, 540);
  next.destroy();
});

test('desktop ResizeObserver handles native container changes without window events and disposes cleanly', (t) => {
  let observer;
  globalThis.ResizeObserver = class {
    constructor(callback) { this.callback = callback; observer = this; }
    observe(target) { this.target = target; }
    disconnect() { this.disconnected = true; }
  };
  const { manager, desktop, browser } = fixture(t); addMain(manager);
  const models = addUtility(manager); manager.show(models.id);
  assert.equal(observer.target, desktop); const before = models.rect.h;
  desktop.clientHeight = 600; observer.callback(); assert.ok(models.rect.h < before);
  desktop.clientHeight = 900; observer.callback(); assert.equal(models.rect.h, before);
  manager.destroy(); assert.equal(observer.disconnected, true); assert.equal(browser.listeners.get('resize').size, 0);
});

test('DesktopWindows viewport clamping never overwrites preferred geometry, including hidden and mobile windows', (t) => {
  const f = fixture(t), { manager, desktop, tasks, browser } = f;
  const main = addMain(manager), child = manager.add({ id: 'child', title: 'Child' }), utility = addUtility(manager);
  const expected = { main: { x: 40, y: 30, w: 1000, h: 750 }, child: { x: 880, y: 250, w: 430, h: 480 }, models: { x: 340, y: 140, w: 900, h: 650 } };
  for (const win of [main, child, utility]) { manager.place(win, expected[win.id]); manager.hide(win.id); }
  desktop.clientWidth = 700; desktop.clientHeight = 500; browser.emit('resize');
  for (const win of [main, child, utility]) {
    manager.show(win.id); assert.deepEqual(win.layoutRect, expected[win.id]); manager.hide(win.id);
  }
  const restored = new DesktopWindows(desktop, tasks);
  const copies = [addMain(restored), restored.add({ id: 'child', title: 'Child' }), addUtility(restored)];
  assert.ok(copies.every((win) => win.element.hidden));
  globalThis.matchMedia = () => ({ matches: true });
  desktop.clientWidth = 370; desktop.clientHeight = 1800; browser.emit('resize');
  for (const win of copies) { restored.show(win.id); assert.deepEqual(win.layoutRect, expected[win.id]); restored.hide(win.id); }
  globalThis.matchMedia = () => ({ matches: false });
  desktop.clientWidth = 1400; desktop.clientHeight = 900; browser.emit('resize');
  for (const win of copies) { restored.show(win.id); assert.deepEqual(win.rect, expected[win.id]); }
});

test('DesktopWindows honors legacy custom geometry but zooms old untouched defaults', (t) => {
  const { manager } = fixture(t, JSON.stringify({ models: { x: 70, y: 45, w: 820, h: 660, hidden: true }, main: { x: 40, y: 30, w: 750, h: 550 } }));
  const main = addMain(manager); manager.show('main'); assert.deepEqual(main.rect, { x: 40, y: 30, w: 750, h: 550 });
  const utility = addUtility(manager); manager.show('models'); assert.equal(utility.rect.w, 400);
});

test('DesktopWindows remembers maximized and restored sizes through hiding and reload', (t) => {
  const { manager, desktop, tasks, browser } = fixture(t); const main = addMain(manager), normal = { ...main.rect };
  button(main, 'Maximize or restore main window').emit('click'); const maximized = { ...main.rect };
  main.titlebar.emit('pointerdown', { button: 0, pointerId: 1, clientX: 30, clientY: 10 });
  browser.emit('pointerup', { pointerId: 1 });
  assert.deepEqual(main.restore, normal, 'selecting a maximized title does not discard its restore size');
  manager.hide('main'); manager.show('main'); assert.deepEqual(main.rect, maximized); manager.hide('main');
  const restored = new DesktopWindows(desktop, tasks), copy = addMain(restored);
  restored.show('main'); assert.deepEqual(copy.rect, maximized);
  button(copy, 'Maximize or restore main window').emit('click'); assert.deepEqual(copy.rect, normal);
});

test('DesktopWindows form interaction does not move controls under the pointer', (t) => {
  const { manager, doc } = fixture(t); const main = addMain(manager), initial = { ...main.rect };
  const input = doc.createElement('input'); main.body.append(input);
  main.element.emit('pointerdown', { target: input }); input.focus(); assert.deepEqual(main.rect, initial);
  assert.equal(main.sizeMode, 'auto', 'a new visible main fits before any interaction');
  main.titlebar.focus(); assert.deepEqual(main.rect, initial, 'already-fitted windows do not grow again');
  assert.equal(button(main, 'Zoom to working size'), undefined, 'no separate fitting button');
});

test('DesktopWindows validates corrupt, non-object, oversized and denied localStorage', (t) => {
  for (const raw of ['null', '[]', 'true', '42', '"text"', '{broken', ' '.repeat(100001)]) {
    const { manager } = fixture(t, raw); assert.doesNotThrow(() => addMain(manager)); assert.equal(Object.getPrototypeOf(manager.saved), null);
  }
  const { manager } = fixture(t, null, true); assert.doesNotThrow(() => { addMain(manager); manager.hide('main'); manager.arrange(); });
});

test('DesktopWindows accepts old layout but rejects invalid geometry and non-boolean visibility', (t) => {
  const { manager } = fixture(t, '{"main":{"x":30,"y":40,"w":750,"h":550},"models":{"x":-1e300,"y":1e300,"w":1e300,"h":1e300,"hidden":false},"git":{"x":0,"y":0,"w":-3,"h":40,"hidden":"false"},"usage":null,"__proto__":{"x":10,"y":20,"w":500,"h":400,"hidden":false}}');
  const main = addMain(manager); assert.deepEqual(main.rect, { x: 30, y: 40, w: 750, h: 550 });
  const models = addUtility(manager); assert.deepEqual(models.rect, { x: 0, y: 8, w: 1392, h: 892 }); assert.equal(models.element.hidden, false);
  const git = addUtility(manager, 'git'); assert.equal(git.element.hidden, true); assert.ok(git.rect.w >= 400);
  assert.doesNotThrow(() => addUtility(manager, 'usage'));
  const special = addUtility(manager, '__proto__'); assert.equal(special.rect.w, 500); assert.equal(special.element.hidden, false);
  assert.equal({}.hidden, undefined);
});

test('DesktopWindows bounds agents below main while leaving utilities roomy on resize and arrange', (t) => {
  const { manager, desktop, browser } = fixture(t); const main = addMain(manager);
  const child = manager.add({ id: 'child', title: 'Child' }), utility = addUtility(manager);
  manager.place(utility, { x: 100, y: 100, w: 1100, h: 700 });
  manager.place(main, { x: 0, y: 0, w: 610, h: 440 });
  assert.equal(utility.rect.w, 1100); assert.equal(utility.rect.h, 700);
  manager.place(child, { x: -100, y: 100000, w: 10000, h: 10000 });
  assert.ok(child.rect.w < main.rect.w); assert.ok(child.rect.h < main.rect.h);
  desktop.clientWidth = 300; desktop.clientHeight = 320; browser.emit('resize');
  for (const win of manager.windows.values()) {
    assert.ok(win.rect.x >= 0 && win.rect.y >= 0); assert.ok(win.rect.x + win.rect.w <= 300); assert.ok(win.rect.y + win.rect.h <= 320);
  }
  assert.ok(child.rect.w < main.rect.w); assert.ok(child.rect.h < main.rect.h);
  manager.place(utility, { x: NaN, y: Infinity, w: 'bad', h: null });
  assert.ok(Object.values(utility.rect).every(Number.isFinite));
  manager.arrange(); assert.equal(utility.element.hidden, true);
});

test('DesktopWindows keyboard movement/resizing resets maximize restoration without hijacking control keys', (t) => {
  const { manager } = fixture(t); const main = addMain(manager); const utility = addUtility(manager); manager.show('models');
  const x = utility.rect.x, w = utility.rect.w;
  const move = utility.titlebar.emit('keydown', { key: 'ArrowRight' }); assert.equal(move.defaultPrevented, true); assert.equal(utility.rect.x, x + 10);
  utility.titlebar.emit('keydown', { key: 'ArrowRight', shiftKey: true }); assert.equal(utility.rect.w, w + 10);
  utility.element.querySelector('.resize-handle').emit('keydown', { key: 'ArrowDown' });
  const rect = { ...utility.rect };
  utility.titlebar.emit('keydown', { key: 'ArrowRight', ctrlKey: true }); assert.deepEqual(utility.rect, rect);
  utility.titlebar.emit('keydown', { key: 'ArrowRight', target: button(utility, 'Minimize window') }); assert.deepEqual(utility.rect, rect);
  manager.hide('models'); utility.titlebar.emit('keydown', { key: 'ArrowRight' }); assert.deepEqual(utility.rect, rect);
  const original = { ...main.rect }; const maximize = button(main, 'Maximize or restore main window');
  maximize.emit('click'); assert.ok(main.restore); maximize.emit('click'); assert.deepEqual(main.rect, original);
  maximize.emit('click'); main.titlebar.emit('keydown', { key: 'ArrowLeft', shiftKey: true }); assert.equal(main.restore, null);
});

test('DesktopWindows remembers input focus, falls back from removed/disabled controls, and supports hide/show all loops', (t) => {
  const { manager, doc } = fixture(t); const main = addMain(manager); const utility = addUtility(manager);
  const input = doc.createElement('input'); utility.body.append(input);
  manager.show('models'); input.focus();
  button(utility, 'Minimize window').focus(); button(utility, 'Minimize window').emit('click');
  assert.equal(doc.activeElement, main.titlebar);
  utility.task.emit('click'); assert.equal(doc.activeElement, input);
  manager.hide('models'); input.disabled = true; manager.show('models'); assert.equal(doc.activeElement, utility.titlebar);
  input.disabled = false; input.focus(); manager.hide('models'); input.remove(); manager.show('models'); assert.equal(doc.activeElement, utility.titlebar);
  const outside = doc.createElement('button'); outside.focus(); manager.hide('models'); assert.equal(doc.activeElement, outside, 'hiding without DOM focus does not steal it');
  for (const { id } of manager.list()) manager.hide(id);
  assert.ok(manager.list().every((entry) => entry.hidden && !entry.focused));
  manager.focus(main); assert.equal(manager.focused, null);
  for (const { id } of manager.list()) manager.show(id);
  assert.ok(manager.list().every((entry) => !entry.hidden)); assert.equal(manager.list().filter((entry) => entry.focused).length, 1);
  manager.remove('models'); assert.equal(doc.activeElement, main.titlebar);
  manager.remove('main'); assert.equal(doc.activeElement, manager.desktop);
});

test('DesktopWindows pointer movement/resizing filters pointer IDs and cancels safely when hidden or removed', (t) => {
  const { manager, browser } = fixture(t); addMain(manager); const utility = addUtility(manager); manager.show('models');
  const start = { ...utility.rect };
  utility.titlebar.emit('pointerdown', { button: 0, pointerId: 1, clientX: 10, clientY: 10 });
  browser.emit('pointermove', { pointerId: 2, clientX: 70, clientY: 50 }); assert.deepEqual(utility.rect, start);
  browser.emit('pointermove', { pointerId: 1, clientX: 70, clientY: 50 }); assert.equal(utility.rect.x, start.x + 60);
  browser.emit('pointerup', { pointerId: 2 }); assert.ok(utility.cancelPointer);
  manager.hide('models'); assert.equal(utility.cancelPointer, null); assert.equal(utility.titlebar.hasPointerCapture(1), false);
  const hiddenRect = { ...utility.rect }; browser.emit('pointermove', { pointerId: 1, clientX: 90, clientY: 90 }); assert.deepEqual(utility.rect, hiddenRect);
  manager.show('models'); const handle = utility.element.querySelector('.resize-handle');
  handle.emit('pointerdown', { button: 0, pointerId: 3, clientX: 0, clientY: 0 });
  browser.emit('pointermove', { pointerId: 3, clientX: 30, clientY: 20 }); assert.equal(utility.rect.w, start.w + 30);
  browser.emit('blur'); assert.equal(utility.cancelPointer, null);
  handle.emit('pointerdown', { button: 0, pointerId: 4, clientX: 0, clientY: 0 }); manager.remove('models');
  assert.equal(handle.hasPointerCapture(4), false); assert.equal(browser.listeners.get('pointermove').size, 0);
});
