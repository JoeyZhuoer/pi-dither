const count = (value) => Number.isSafeInteger(value) && value >= 0 ? value : null;
const number = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
// Defense in depth at display time; server-known secrets are already redacted.
const redactedText = (value) => typeof value === 'string' ? value
  .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g, '[redacted]')
  .replace(/\b(Bearer|Basic)\s+[^\s"',;]+/gi, '$1 [redacted]')
  .replace(/((?:["']?)(?:api[-_]?key|access[-_]?token|refresh[-_]?token|authorization|password|passwd|secret|credential|cookie|token|auth|private[-_]?key)["']?\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;}]+)/gi, '$1[redacted]')
  : '';
const availability = (value) => ['partial', 'complete'].includes(value) ? value : 'unavailable';
const shown = (value) => value === null ? 'unavailable' : String(value);
const duration = (value) => value === null ? 'unavailable' : `${value} ms`;

// Display-only: no transcript inference, API calls, timers, or child controls.
export function createInspectionPanel({ document: doc, kind }) {
  const node = (tag, className, text) => {
    const element = doc.createElement(tag); element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  };
  const element = node('details', 'inspection-panel');
  const summary = node('summary', 'inspection-summary');
  const content = node('div', 'inspection-content');
  element.append(summary, content);
  const sections = {};
  for (const title of ['Prompt', 'Tools', 'Files', 'Usage + time']) {
    const section = node('details', 'inspection-section');
    const heading = node('summary', 'inspection-heading', title);
    const body = node('pre', 'inspection-value');
    section.append(heading, body); content.append(section); sections[title] = body;
  }
  let destroyed = false;
  const set = (target, value) => { if (target.textContent !== value) target.textContent = value; };
  function update(inspection, { connected = true } = {}) {
    if (destroyed) return;
    const data = inspection?.version === 1 ? inspection : {};
    // A second display budget also bounds malformed/non-normalized fixture inputs.
    let remaining = 20000;
    let clipped = false;
    const take = (value, limit) => {
      const clean = redactedText(value);
      const result = clean.slice(0, Math.min(limit, remaining)); remaining -= result.length;
      if (clean.length > result.length) clipped = true;
      return result;
    };
    const prompt = data.prompt || {};
    const promptLabel = prompt.kind === 'user' || (!prompt.kind && kind !== 'delegated') ? 'Latest delivered user prompt' : 'Assigned task';
    const promptAvailable = typeof prompt.text === 'string' && prompt.text.trim() !== '[prompt redacted]';
    const promptText = take(promptAvailable ? prompt.text : null, 8000);
    const promptClipped = prompt.truncated === true || clipped;
    const tools = data.tools || {}, files = data.files || {}, usage = data.usage || {}, timing = data.timing || {};
    const toolAvailability = availability(tools.availability), fileAvailability = availability(files.availability);
    const toolItems = Array.isArray(tools.items) ? tools.items.slice(-40).filter(Boolean) : [];
    const fileItems = Array.isArray(files.items) ? files.items.slice(0, 64).filter(Boolean) : [];
    const toolOmitted = (count(tools.omitted) ?? 0) + Math.max(0, (Array.isArray(tools.items) ? tools.items.length : 0) - 40);
    const fileOmitted = (count(files.omitted) ?? 0) + Math.max(0, (Array.isArray(files.items) ? files.items.length : 0) - 64);
    const evidenceLabel = (state, items, omitted) => state === 'unavailable' ? 'Unavailable · unknown coverage' : state === 'partial' ? 'Partial evidence · not a complete record' : !items.length && !omitted ? 'Complete evidence · verified empty' : 'Complete evidence';
    const toolLines = toolItems.map((item) => {
      const status = ['running', 'done', 'error', 'interrupted'].includes(item.status) ? item.status : 'unknown';
      return `${take(item.name, 100) || 'Unknown tool'} · ${status}${!connected && status === 'running' ? ' (last snapshot)' : ''}\n${take(item.summary, 600)}`;
    });
    const fileLines = fileItems.map((item) => {
      const action = ['changed', 'added', 'deleted'].includes(item.action) ? item.action : 'unknown';
      const provenance = item.evidence === 'observed-tool' ? 'Observed successful tool' : item.evidence === 'reported' ? 'Upstream reported change' : 'Unknown evidence';
      return `${take(item.path, 512) || 'Unknown path'} · ${action} · ${provenance}`;
    });
    const tokens = count(usage.totalTokens), cost = number(usage.costUsd);
    const scope = usage.scope === 'session' ? 'Session totals' : usage.scope === 'child' ? 'Child totals' : 'Usage scope unavailable';
    const fields = [['Input tokens', 'inputTokens'], ['Output tokens', 'outputTokens'], ['Cache read tokens', 'cacheReadTokens'], ['Cache write tokens', 'cacheWriteTokens'], ['Total tokens', 'totalTokens']];
    const partial = fields.some(([, key]) => count(usage[key]) === null) || cost === null;
    const hasUsage = fields.some(([, key]) => count(usage[key]) !== null) || cost !== null;
    const state = !hasUsage ? 'Unavailable' : usage.provisional === true ? 'Provisional / live snapshot' : 'Final reported values';
    // durationMs may be reported or backend-measured; v1 does not encode that provenance.
    // Only authoritative settled endpoints can supply a measured fallback.
    const started = number(timing.startedAt), ended = number(timing.endedAt);
    const reported = number(timing.durationMs);
    const measured = started !== null && ended !== null && ended >= started ? ended - started : null;
    const elapsed = reported ?? measured;
    const timeLabel = reported !== null ? 'Elapsed wall time' : measured !== null ? 'Measured wall time (run endpoints)' : 'Wall time';
    const timeState = !connected ? 'Disconnected · last snapshot' : timing.live === true ? 'Live snapshot · not a ticking clock' : ended !== null ? 'Settled' : 'Settlement unavailable';
    const scroll = [element, content, ...Object.values(sections)].map((target) => [target, target.scrollTop, target.scrollLeft]);
    set(summary, `Inspection · ${shown(count(tools.total))} tools · ${shown(tokens)} tokens · ${cost === null ? 'cost unavailable' : `$${cost}`} · ${duration(elapsed)}${usage.provisional === true ? ' · provisional' : ''}${!connected ? ' · disconnected' : ''}`);
    set(sections.Prompt, `${promptLabel}\n${promptAvailable ? promptText || '(Empty prompt)' : 'Unavailable'}${promptClipped ? '\nClipped prompt preview' : ''}`);
    set(sections.Tools, `${evidenceLabel(toolAvailability, toolItems, toolOmitted)} · Total: ${shown(count(tools.total))}\n${toolLines.join('\n\n')}${toolOmitted ? `\n${toolOmitted} tool calls omitted` : ''}`);
    set(sections.Files, `${evidenceLabel(fileAvailability, fileItems, fileOmitted)}\n${fileLines.join('\n')}${fileOmitted ? `\n${fileOmitted} file entries omitted` : ''}\nChild-attributed evidence only; not a workspace diff.`);
    set(sections['Usage + time'], `${scope} · ${state}${partial ? ' · Partial / missing metrics' : ''}\n${fields.map(([label, key]) => `${label}: ${shown(count(usage[key]))}`).join('\n')}\nCost USD: ${cost === null ? 'unavailable' : `$${cost}`}\n${timeLabel}: ${duration(elapsed)} · ${timing.scope === 'run' ? 'Run scope' : 'Timing scope unavailable'}\n${timeState}${clipped ? '\nDisplay previews clipped to bounded limits' : ''}`);
    for (const [target, top, left] of scroll) { target.scrollTop = top; target.scrollLeft = left; }
  }
  update(null);
  return { element, update, destroy() { destroyed = true; } };
}
