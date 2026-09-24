import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setMaxListeners } from 'node:events';
import { createUsageChart, install } from '../desktop/public/widget-usage.js';

// Small DOM fixture for deterministic widget tests without browser dependencies,
// matching the shim used by tests/features.test.mjs.
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

const agent = (overrides = {}) => ({
  id: 'main', name: 'Main', connected: true, phase: 'idle', sessionId: 'session',
  stats: { tokens: { input: 200, output: 50, cacheRead: 80, cacheWrite: 20, total: 350 }, cost: 0.0123, contextUsage: { percent: 25, tokens: 500, contextWindow: 2000 } },
  ...overrides,
});

function setup(t) {
  const previous = globalThis.document;
  globalThis.document = { createElement: (tag) => new Element(tag) };
  t.after(() => { if (previous === undefined) delete globalThis.document; else globalThis.document = previous; });
  const registrations = [], opens = { count: 0 };
  const host = { register(value) { registrations.push(value); return value; } };
  const returned = install(host);
  const root = new Element('aside');
  const ctx = { openUsage: () => { opens.count++; }, getSelectedAgent: () => null };
  return { registrations, returned, root, ctx, opens };
}

test('usage widget registers the frozen host interface', (t) => {
  const { registrations, returned, root, ctx, opens } = setup(t);
  assert.equal(registrations.length, 1, 'install registers exactly one widget');
  const spec = registrations[0];
  assert.equal(returned, spec, 'install returns the registered widget');
  assert.equal(spec.type, 'usage');
  assert.equal(spec.title, 'Usage / session');
  assert.deepEqual(spec.defaultSize, [2, 3]);
  assert.deepEqual(spec.sizes, [[2, 2], [2, 3]]);
  for (const method of ['render', 'update', 'destroy']) assert.equal(typeof spec[method], 'function', `${method} is a function`);
  // The widget has no link to the Usage window; the host titlebar is the only heading.
  spec.render(root, ctx);
  assert.equal(root.querySelector('.utility-title'), null, 'no heading link is rendered');
});

test('render draws the utility title, usage bars and the hidden token chart', (t) => {
  const { registrations, root, ctx } = setup(t);
  const spec = registrations[0];
  spec.render(root, ctx);
  assert.equal(root.querySelector('.utility-title'), null, 'no duplicate heading is rendered');
  assert.equal(root.querySelectorAll('.usage-bar').length, 3, 'three token bars render');
  assert.ok(root.querySelector('.usage-bars'), 'the bar group is present');
  assert.ok(root.querySelector('.usage-totals'), 'the totals line is present');
  assert.ok(root.querySelector('.usage-context'), 'the context meter is present');
  assert.equal(root.querySelector('.usage-note'), null, 'the connection/status note is gone');
  const chart = root.querySelector('[data-testid="usage-chart"]');
  assert.ok(chart, 'the token chart canvas renders');
  assert.equal(chart.tagName, 'CANVAS');
  assert.equal(chart.style.display, 'none', 'the chart stays hidden until a 2x3 size is reported');
});

test('update renders the selected agent reported by ctx.getSelectedAgent', (t) => {
  const { registrations, root, ctx } = setup(t);
  const spec = registrations[0];
  const child = agent({ id: 'child', name: 'Child', sessionId: 'child-session', stats: { tokens: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, total: 120 }, cost: 0.5, contextUsage: { percent: 10, tokens: 100, contextWindow: 1000 } } });
  ctx.getSelectedAgent = () => child;
  spec.render(root, ctx);
  spec.update({ connected: true, agents: [agent(), child] }, ctx);
  assert.equal(root.dataset.agentId, 'child');
  assert.equal(root.dataset.stale, 'false');
  assert.match(root.querySelector('.usage-agent').textContent, /Child/);
  assert.match(root.querySelector('.usage-totals').textContent, /120 TOK\$0\.5000/);
});

test('the token chart shows only at 2x3 and follows ctx.size changes', (t) => {
  const { registrations, root, ctx } = setup(t);
  const spec = registrations[0];
  spec.render(root, ctx);
  const chart = () => root.querySelector('[data-testid="usage-chart"]');
  ctx.size = { w: 2, h: 2 };
  spec.update({ connected: true, agents: [agent()] }, ctx);
  assert.equal(chart().style.display, 'none', 'the chart hides at 2x2');
  ctx.size = { w: 2, h: 3 };
  spec.update({ connected: true, agents: [agent()] }, ctx);
  assert.equal(chart().style.display, 'block', 'the chart shows at 2x3');
  ctx.size = { w: 2, h: 2 };
  spec.update({ connected: true, agents: [agent()] }, ctx);
  assert.equal(chart().style.display, 'none', 'the chart hides again after a resize back to 2x2');
});

test('the token chart records one point per completed user turn, leaves gaps and resets per agent', (t) => {
  const previous = globalThis.document;
  globalThis.document = { createElement: (tag) => new Element(tag) };
  t.after(() => { if (previous === undefined) delete globalThis.document; else globalThis.document = previous; });
  const chart = createUsageChart();
  // No completed turn yet: the baseline is adopted without a fabricated point.
  chart.update(agent({ stats: { userMessages: 0, tokens: { total: 0 } } }), { w: 2, h: 3 });
  assert.equal(chart.history.length, 0, 'an idle baseline records no turn');
  // Turn 1: running, then idle with the reported cumulative total.
  chart.update(agent({ phase: 'running', stats: { userMessages: 1, tokens: { total: 0 } } }), { w: 2, h: 3 });
  assert.equal(chart.history.length, 0, 'a running turn is not charted yet');
  chart.update(agent({ phase: 'idle', stats: { userMessages: 1, tokens: { total: 350 } } }), { w: 2, h: 3 });
  assert.deepEqual(chart.history, [{ turn: 1, tokens: 350 }], 'turn 1 records its own token usage');
  // Turn 2 stores the delta, not the cumulative session total.
  chart.update(agent({ phase: 'running', stats: { userMessages: 2, tokens: { total: 350 } } }), { w: 2, h: 3 });
  chart.update(agent({ phase: 'idle', stats: { userMessages: 2, tokens: { total: 500 } } }), { w: 2, h: 3 });
  assert.deepEqual(chart.history[1], { turn: 2, tokens: 150 }, 'turn 2 stores the turn delta');
  // Unknown totals keep the turn as a gap instead of fabricating a value.
  chart.update(agent({ phase: 'running', stats: { userMessages: 3, tokens: null } }), { w: 2, h: 3 });
  chart.update(agent({ phase: 'idle', stats: { userMessages: 3, tokens: null } }), { w: 2, h: 3 });
  assert.deepEqual(chart.history[2], { turn: 3, tokens: null }, 'an unknown turn total leaves a gap');
  // Changing the selected agent resets the history.
  chart.update(agent({ id: 'child', phase: 'idle', stats: { userMessages: 1, tokens: { total: 10 } } }), { w: 2, h: 3 });
  assert.equal(chart.history.length, 0, 'changing the selected agent resets the history');
  // The history is capped at 40 completed turns.
  for (let i = 1; i <= 60; i++) {
    chart.update(agent({ phase: 'running', stats: { userMessages: i, tokens: { total: i * 10 } } }), { w: 2, h: 3 });
    chart.update(agent({ phase: 'idle', stats: { userMessages: i, tokens: { total: i * 10 } } }), { w: 2, h: 3 });
  }
  assert.equal(chart.history.length, 40, 'the history is capped at 40 turns');
});

test('update falls back to the main agent when the host offers no selection', (t) => {
  const { registrations, root, ctx } = setup(t);
  const spec = registrations[0];
  spec.render(root, ctx);
  spec.update({ connected: true, agents: [agent({ id: 'child', name: 'Child' }), agent()] }, ctx);
  assert.equal(root.dataset.agentId, 'main');
  assert.match(root.querySelector('.usage-agent').textContent, /Main/);
});

test('update preserves provisional, offline and unavailable usage without fabricating values', (t) => {
  const { registrations, root, ctx } = setup(t);
  const spec = registrations[0];
  const running = agent({ phase: 'running', currentUsage: { totalTokens: 42 } });
  ctx.getSelectedAgent = () => running;
  spec.render(root, ctx);
  spec.update({ connected: true, agents: [running] }, ctx);
  // The provisional turn count never overwrites the reported session totals, and
  // no connection/status note is rendered at all.
  assert.equal(root.querySelector('.usage-note'), null, 'no note line is rendered');
  assert.match(root.querySelector('.usage-totals').textContent, /350 TOK/);
  spec.update({ connected: false, agents: [running] }, ctx);
  assert.equal(root.dataset.stale, 'true');
  assert.doesNotMatch(root.textContent, /OFFLINE/);
  running.stats = null;
  spec.update({ connected: true, agents: [running] }, ctx);
  assert.match(root.querySelector('.usage-totals').textContent, /— TOK/);
  assert.equal(root.querySelector('.usage-context').attributes['aria-valuenow'], undefined, 'unknown context drops aria-valuenow');
});

test('destroy releases the diagram DOM and makes update inert', (t) => {
  const { registrations, root, ctx } = setup(t);
  const spec = registrations[0];
  spec.render(root, ctx);
  assert.ok(root.children.length > 0, 'render produced DOM');
  spec.destroy();
  assert.equal(root.children.length, 0, 'destroy clears the owned DOM');
  assert.doesNotThrow(() => spec.update({ connected: true, agents: [agent()] }, ctx));
  assert.equal(root.children.length, 0, 'update after destroy does not repopulate');
});
