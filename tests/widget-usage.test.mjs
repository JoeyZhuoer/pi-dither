import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setMaxListeners } from 'node:events';
import { install } from '../desktop/public/widget-usage.js';

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
  // The real usage-widget contract: the heading opens the Usage window and the
  // context supplies the selected agent. No state is fabricated before update.
  spec.render(root, ctx);
  root.querySelector('.utility-title').click();
  assert.equal(opens.count, 1);
});

test('render draws the utility title and the usage bars into the owned root', (t) => {
  const { registrations, root, ctx } = setup(t);
  const spec = registrations[0];
  spec.render(root, ctx);
  assert.match(root.querySelector('.utility-title').textContent, /^Usage \/ session/);
  assert.equal(root.querySelectorAll('.usage-bar').length, 3, 'three token bars render');
  assert.ok(root.querySelector('.usage-bars'), 'the bar group is present');
  assert.ok(root.querySelector('.usage-totals'), 'the totals line is present');
  assert.ok(root.querySelector('.usage-context'), 'the context meter is present');
  assert.ok(root.querySelector('.usage-note'), 'the note line is present');
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
  // The provisional turn count never overwrites the reported session totals.
  assert.match(root.querySelector('.usage-note').textContent, /42 TOK \u00b7 PROVISIONAL/);
  assert.match(root.querySelector('.usage-totals').textContent, /350 TOK/);
  spec.update({ connected: false, agents: [running] }, ctx);
  assert.equal(root.dataset.stale, 'true');
  assert.match(root.textContent, /OFFLINE/);
  running.stats = null;
  spec.update({ connected: true, agents: [running] }, ctx);
  assert.match(root.querySelector('.usage-totals').textContent, /— TOK/);
  assert.equal(root.querySelector('.usage-context').attributes['aria-valuenow'], undefined, 'unknown context drops aria-valuenow');
});

test('clicking the heading calls ctx.openUsage', (t) => {
  const { registrations, root, ctx, opens } = setup(t);
  const spec = registrations[0];
  spec.render(root, ctx);
  const heading = root.querySelector('.utility-title');
  assert.equal(heading.tagName, 'BUTTON');
  heading.click();
  heading.click();
  assert.equal(opens.count, 2, 'every heading click opens the Usage window');
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
