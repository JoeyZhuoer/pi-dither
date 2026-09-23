import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInspectionPanel } from '../desktop/public/inspection.js';

// Intentionally no HTML parsing, networking, timers or browser globals.
class Element {
  children = []; scrollTop = 0; scrollLeft = 0; open = false; textContent = '';
  constructor(tag, document) { this.tagName = tag; this.document = document; }
  append(...items) { this.children.push(...items); }
  focus() { this.document.activeElement = this; }
  set innerHTML(_) { throw new Error('Unsafe HTML'); }
}
function fixture(kind = 'delegated') {
  const document = { createElement: (tag) => new Element(tag, document) };
  const panel = createInspectionPanel({ document, kind });
  const content = panel.element.children[1];
  const sections = content.children;
  return { ...panel, document, content, sections, summary: panel.element.children[0], texts: () => sections.map((section) => section.children[1].textContent).join('\n') };
}
const dto = (extra = {}) => ({ version: 1, prompt: { text: 'Do work', kind: 'task', truncated: false }, tools: { availability: 'complete', total: 0, items: [], omitted: 0 }, files: { availability: 'complete', items: [], omitted: 0 }, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, costUsd: 0, scope: 'child', provisional: false }, timing: { startedAt: 0, endedAt: 0, durationMs: 0, scope: 'run', live: false }, ...extra });
test('inspection: collapsed defaults, honest unavailable/verified-empty and zero metrics', () => {
  const f = fixture();
  assert.equal(f.element.open, false); assert.ok(f.sections.every((s) => !s.open));
  assert.match(f.texts(), /Unavailable/); assert.doesNotMatch(f.texts(), /Verified empty/);
  f.update(dto());
  assert.match(f.texts(), /Verified empty/); assert.match(f.texts(), /Total tokens: 0/);
  assert.match(f.texts(), /Cost USD: \$0/); assert.match(f.texts(), /Elapsed wall time: 0 ms · Run scope/);
  assert.match(f.texts(), /Child totals · Final/);
  f.update({ version: 2, prompt: { text: 'unsupported' } }); assert.doesNotMatch(f.texts(), /unsupported/);
});
test('inspection: stable section nodes, focus and scroll while replacing cumulative snapshots', () => {
  const f = fixture('subagent'); const initial = [...f.sections];
  f.element.open = true; f.sections[1].open = true; f.sections[1].children[0].focus();
  f.element.scrollTop = 12; f.content.scrollTop = 15; f.sections[1].children[1].scrollTop = 22;
  const data = dto({ prompt: { text: '<img onerror="bad()">', kind: 'user', truncated: true }, tools: { availability: 'partial', total: 1, items: [{ id: 'a', name: 'write', status: 'running', summary: '<script>inert</script>' }] }, files: { availability: 'partial', items: [{ path: '<path>', action: 'changed', evidence: 'observed-tool' }, { path: 'b', action: 'added', evidence: 'reported' }] }, usage: { totalTokens: 7, costUsd: 0, scope: 'session', provisional: true } });
  f.update(data); f.update(data, { connected: false });
  assert.deepEqual(f.sections, initial); assert.equal(f.document.activeElement, f.sections[1].children[0]);
  assert.equal(f.element.open, true); assert.equal(f.sections[1].open, true);
  assert.equal(f.element.scrollTop, 12); assert.equal(f.content.scrollTop, 15); assert.equal(f.sections[1].children[1].scrollTop, 22);
  assert.match(f.texts(), /Latest delivered user prompt\n<img/); assert.match(f.texts(), /Clipped prompt preview/);
  assert.equal(f.texts().match(/<script>/g).length, 1); assert.match(f.texts(), /running \(last snapshot\)/);
  assert.match(f.texts(), /Observed successful tool/); assert.match(f.texts(), /Upstream reported change/);
  assert.match(f.texts(), /Session totals · Provisional/); assert.match(f.texts(), /Partial \/ missing metrics/);
  assert.match(f.texts(), /Disconnected/);
});
test('inspection: bounded previews, omission notices, invalid metrics and no inferred totals', () => {
  const f = fixture();
  f.update(dto({ prompt: { text: 'p'.repeat(10000), kind: 'task' }, tools: { availability: 'partial', total: -1, omitted: 3, items: Array.from({ length: 50 }, (_, id) => ({ id, name: 'tool', summary: 't'.repeat(2000) })) }, files: { availability: 'partial', items: Array.from({ length: 70 }, () => ({ path: 'f'.repeat(1000) })) }, usage: { inputTokens: -2, outputTokens: 1.2, totalTokens: Infinity, costUsd: NaN } }));
  assert.match(f.texts(), /13 tool calls omitted/); assert.match(f.texts(), /6 file entries omitted/);
  assert.match(f.texts(), /Total tokens: unavailable/); assert.match(f.texts(), /Cost USD: unavailable/);
  assert.match(f.texts(), /Display previews clipped/); assert.ok(f.texts().length < 29000);
  assert.doesNotMatch(f.texts(), /p{8001}|t{601}|f{513}/);
});
test('inspection: credential-shaped display text is redacted before clipping and hidden prompts stay unavailable', () => {
  const f = fixture();
  f.update(dto({ prompt: { text: '[prompt redacted]' }, tools: { items: [{ name: 'bash', summary: 'password="secret-value" ' + 'x'.repeat(565) + ' Bearer crossing-cutoff-secret' }] } }));
  assert.match(f.texts(), /Assigned task\nUnavailable/);
  assert.doesNotMatch(f.texts(), /secret-value|crossing|prompt redacted/);
});
test('inspection: authoritative settled endpoints only, destroy freezes updates', () => {
  const f = fixture();
  f.update(dto({ timing: { startedAt: 100, endedAt: 350, durationMs: null, scope: 'run' } }));
  assert.match(f.texts(), /Measured wall time \(run endpoints\): 250 ms/);
  f.update(dto({ timing: { startedAt: 100, endedAt: null, durationMs: null, live: true } }));
  assert.match(f.texts(), /Wall time: unavailable/); assert.match(f.texts(), /Live/);
  f.update(dto({ timing: { startedAt: 350, endedAt: 100 } })); assert.match(f.texts(), /Wall time: unavailable/);
  const before = f.texts(); f.destroy(); f.update(dto()); assert.equal(f.texts(), before);
});
