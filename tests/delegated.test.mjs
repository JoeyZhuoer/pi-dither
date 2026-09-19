import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aggregateActivity, delegatedId, delegationRows, delegationNotice, installDelegatedObservers } from '../desktop/public/delegated.js';

const main = (rows = [], extra = {}) => ({ kind: 'main', sessionId: 'session', connected: true, phase: 'idle', delegations: rows, ...extra });
const row = (extra = {}) => ({ id: 'run/child', name: 'Review', status: 'running', phase: 'thinking', task: '<script>task</script>', messages: [{ role: 'assistant', text: 'one' }], ...extra });
test('identities are scoped, deduplicated, bounded and legacy-safe', () => {
  assert.notEqual(delegatedId('a', 'b', 'c'), delegatedId('a', 'c', 'b'));
  assert.ok(delegatedId('a', 'b', 'c').startsWith('delegated:'));
  assert.deepEqual(delegationRows({}), []);
  assert.equal(delegationRows(main([row(), row()])).length, 1);
  assert.equal(delegationRows(main(Array.from({ length: 100 }, (_, i) => row({ id: String(i) })))).length, 32);
});
test('authoritative activity prioritizes output and ignores settled/disconnected work', () => {
  assert.equal(aggregateActivity([main()]), 'idle');
  assert.equal(aggregateActivity([main([], { phase: 'running', activityMode: 'idle' })]), 'thinking', 'busy before first delta uses the busy visual');
  assert.equal(aggregateActivity([main([row()])]), 'thinking');
  assert.equal(aggregateActivity([main([row({ phase: 'output' })])]), 'output');
  assert.equal(aggregateActivity([main([row({ phase: 'output', status: 'complete' })])]), 'idle');
  assert.equal(aggregateActivity([main([row()], { connected: false })]), 'idle');
  assert.equal(aggregateActivity([main([row()])], false), 'idle');
  const manual = { connected: true, phase: 'busy', activityMode: 'tool' };
  assert.equal(aggregateActivity([manual]), 'thinking');
  assert.equal(aggregateActivity([manual, main([], { phase: 'busy', activityMode: 'output' })]), 'output');
  assert.equal(aggregateActivity([{ ...manual, phase: 'idle', activityMode: 'output' }]), 'idle');
});
test('telemetry limitations are visible without changing ordinary conversation errors', () => {
  assert.equal(delegationNotice(main()), '');
  const state = main([], { extensionStatus: { status: 'loaded' }, delegationStatus: { available: false, message: 'Telemetry interrupted.', omitted: 3 } });
  assert.match(delegationNotice(state), /Telemetry interrupted/);
  assert.match(delegationNotice(state), /3 delegated entries omitted/);
  assert.equal(delegationNotice({ ...state, extensionStatus: null }), '', 'legacy backend remains quiet');
});
class Element {
  children = []; dataset = {}; classList = { add() {} }; scrollHeight = 0; scrollTop = 0; clientHeight = 0;
  constructor(tag) { this.tagName = tag; }
  setAttribute() {}
  append(...items) { this.children.push(...items); }
  replaceChildren(...items) { this.children = items; }
  querySelector() { return null; }
}
function fixture() {
  const live = new Map(), storage = new Map(); let adds = 0, renames = 0;
  const windows = {
    add(options) { adds++; const win = { ...options, body: new Element('div'), element: new Element('section') }; live.set(win.id, win); return win; },
    remove(id) { live.delete(id); }, rename(id, title) { live.get(id).title = title; renames++; },
  };
  const options = { windows, storage: { getItem: (key) => storage.get(key), setItem: (key, value) => storage.set(key, value) }, document: { createElement: (tag) => new Element(tag) }, markdown: (node, text) => { node.textContent = text; } };
  return { ...options, live, create: () => installDelegatedObservers(options), adds: () => adds, renames: () => renames };
}
test('observer lifecycle replaces cumulative output, preserves minimize, suppresses close, resets context', () => {
  const f = fixture(), model = f.create();
  model.reconcile(main([row()]), 'ctx', true);
  const win = [...f.live.values()][0];
  assert.equal(win.kind, 'delegated'); assert.equal(win.element.dataset.delegationId, 'run/child');
  assert.equal(win.element.dataset.subagentIndex, undefined);
  assert.match(win.title, /DELEGATED.*Observer/);
  assert.equal(win.body.children[1].textContent, 'TASK / <script>task</script>');
  win.minimized = true;
  model.reconcile(main([row({ messages: [{ role: 'assistant', text: 'one two' }], finalOutput: 'done', error: '<error>' })]), 'ctx', true);
  assert.equal(f.adds(), 1); assert.equal(win.minimized, true);
  const output = win.body.children[2];
  assert.equal(output.children.length, 3);
  assert.equal(output.children[0].children[1].textContent, 'one two');
  assert.equal(output.children[1].children[1].textContent, 'done');
  assert.equal(output.children[2].textContent, '<error>');
  model.reconcile(main([row()]), 'ctx', false);
  assert.match(win.body.children[0].textContent, /DISCONNECTED/);
  win.onClose(); model.reconcile(main([row()]), 'ctx', true);
  assert.equal(f.live.size, 0);
  f.create().reconcile(main([row()]), 'ctx', true); assert.equal(f.live.size, 0, 'suppression survives controller reload');
  model.reconcile(main([row({ id: 'new-run' })]), 'ctx', true); assert.equal(f.live.size, 1);
  model.reconcile(main([row()], { sessionId: 'replacement' }), 'ctx', true);
  assert.equal(f.live.size, 1); assert.notEqual([...f.live.keys()][0], win.id);
  model.reconcile(main(), 'ctx', true); assert.equal(f.live.size, 0);
});
test('observer positions reuse vacancies without moving surviving or minimized views', () => {
  const f = fixture(), model = f.create();
  model.reconcile(main([row({ id: 'a' }), row({ id: 'b' })]), 'ctx', true);
  const [a, b] = [...f.live.values()];
  assert.equal(a.index, 0); assert.equal(b.index, 1);
  b.minimized = true; a.onClose();
  model.reconcile(main([row({ id: 'a' }), row({ id: 'b' }), row({ id: 'c' })]), 'ctx', true);
  const c = [...f.live.values()].find((win) => win.element.dataset.delegationId === 'c');
  assert.equal(c.index, 0, 'closed observer releases first right-side position');
  assert.equal(b.index, 1); assert.equal(b.minimized, true);
  model.reconcile(main([row({ id: 'c' }), row({ id: 'd' })]), 'ctx', true);
  const d = [...f.live.values()].find((win) => win.element.dataset.delegationId === 'd');
  assert.equal(d.index, 1, 'vanished rows release positions before new rows allocate');
  assert.equal(c.index, 0);
});

test('observer position reservations survive reload with an earlier closed view', () => {
  const f = fixture(), model = f.create();
  model.reconcile(main([row({ id: 'a' }), row({ id: 'b' })]), 'ctx', true);
  const [a, b] = [...f.live.values()];
  a.onClose();
  f.windows.saved = { [b.id]: { observerIndex: 1 } };
  f.live.clear();
  f.create().reconcile(main([row({ id: 'a' }), row({ id: 'b' }), row({ id: 'c' })]), 'ctx', true);
  const kept = [...f.live.values()];
  assert.equal(kept.find((win) => win.element.dataset.delegationId === 'b').index, 1);
  assert.equal(kept.find((win) => win.element.dataset.delegationId === 'c').index, 0);
});

test('render budget preserves final/error and bounds cumulative payload', () => {
  const f = fixture(), model = f.create();
  model.reconcile(main([row({ messages: Array.from({ length: 200 }, () => ({ role: 'tool', text: 'x'.repeat(100000) })), finalOutput: 'f'.repeat(100000), error: 'e'.repeat(100000) })]), 'ctx', true);
  const output = [...f.live.values()][0].body.children[2];
  assert.equal(output.children.length, 82);
  assert.equal(output.children.at(-2).children[1].textContent.length, 24000);
  assert.equal(output.children.at(-1).textContent.length, 8000);
  assert.equal(output.children.slice(0, -1).reduce((n, item) => n + item.children[1].textContent.length, 0), 64000);
});
