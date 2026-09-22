// Runs in a real, isolated DOM (Chromium or WKWebView), with synthetic facts only.
export async function checkInspectionDOM({ createInspectionPanel }) {
  const assert = (ok, message) => { if (!ok) throw new Error(message); };
  const host = document.createElement('div');
  Object.assign(host.style, { display: 'flex', flexDirection: 'column', height: '600px', width: '100%' });
  document.body.append(host);
  const panel = createInspectionPanel({ document, kind: 'delegated' }); host.append(panel.element);
  const text = () => panel.element.textContent;
  assert(!panel.element.open && text().includes('Unavailable'), 'collapsed and unavailable by default');
  const data = { version: 1, prompt: { kind: 'task', text: '<img src=x onerror="window.inspectionPwned=1">\n' + 'task '.repeat(1400) },
    tools: { availability: 'partial', total: 1, items: [{ id: '1', name: 'read', status: 'done', summary: 'path: index.js password="fixture-secret"' }] },
    files: { availability: 'partial', items: [{ path: 'index.js', action: 'changed', evidence: 'reported' }] },
    usage: { scope: 'child', totalTokens: 99, costUsd: 0, provisional: true },
    timing: { startedAt: 100, endedAt: 400, durationMs: 300, scope: 'run' } };
  panel.update(data);
  panel.element.open = true;
  const section = panel.element.querySelector('.inspection-section'), pre = section.querySelector('pre');
  section.open = true; section.querySelector('summary').focus(); pre.scrollTop = 20;
  const before = pre.scrollTop;
  data.usage.totalTokens = 105; panel.update(data);
  assert(panel.element.querySelector('.inspection-section') === section && section.open && panel.element.open, 'expansion and nodes persist');
  assert(document.activeElement === section.querySelector('summary') && pre.scrollTop === before, 'focus and scroll persist');
  assert(text().includes('105 tokens') && text().includes('$0') && text().includes('300 ms') && text().includes('Provisional'), 'cumulative metrics and scope');
  assert(!panel.element.querySelector('img') && !window.inspectionPwned && !text().includes('fixture-secret'), 'safe/redacted display');
  const output = document.createElement('div'); output.style.cssText = 'flex:1;min-height:60px'; output.textContent = 'Primary child output'; host.append(output);
  assert(panel.element.getBoundingClientRect().height <= 600 * .42 + 1 && output.getBoundingClientRect().height >= 60, 'expanded inspection does not consume primary output');
  panel.update(data, { connected: false }); assert(text().includes('disconnected'), 'disconnect is visible');
  panel.update(null); assert(text().includes('Unavailable') && !text().includes('105 tokens'), 'missing/new context clears old data');
  const previous = text(); panel.destroy(); panel.update(data); assert(text() === previous, 'destroy stops updates'); host.remove();
  return 'inspection metrics, scope, safe text, bounds, expansion/focus/scroll and teardown passed';
}
