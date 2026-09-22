// Display-only inspection v1. Only allowlisted facts cross the browser boundary.
export const INSPECTION_LIMITS = Object.freeze({ prompt: 8000, tools: 40, summary: 600, files: 64, path: 512, bytes: 24 * 1024 });
const list = (value) => Array.isArray(value) ? value : [];
const record = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
export const inspectionNumber = (value, integer = false) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && (!integer || Number.isSafeInteger(value)) ? value : null;
const count = (value) => inspectionNumber(value, true);
const credential = /(?:api[-_]?key|access[-_]?token|refresh[-_]?token|authorization|password|passwd|secret|credential|cookie|token|auth|private[-_]?key)/i;
export function inspectionText(value, redact = (x) => x, limit = 8000) {
  if (typeof value !== 'string') return '';
  // Redaction must precede clipping, including when a key straddles the cutoff.
  return redact(value)
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g, '[redacted]')
    .replace(/\b(Bearer|Basic)\s+[^\s"',;]+/gi, '$1 [redacted]')
    .replace(/((?:["']?)(?:api[-_]?key|access[-_]?token|refresh[-_]?token|authorization|password|passwd|secret|credential|cookie|token|auth|private[-_]?key)["']?\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;}]+)/gi, '$1[redacted]')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').slice(0, limit);
}
// Preserve the existing transcript's code/edit arguments, while masking credentials.
export function argumentText(args, redact = (x) => x, limit = 8000) {
  return inspectionText(JSON.stringify(args, (key, value) => credential.test(key) ? '[redacted]' : value, 2), redact, limit);
}
export function argumentSummary(args, redact = (x) => x, limit = INSPECTION_LIMITS.summary) {
  const visit = (value, depth = 0) => {
    if (depth > 4) return '[omitted]';
    if (typeof value === 'string') return inspectionText(value, redact, Math.max(1200, limit));
    if (typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value) || value === null) return value;
    if (Array.isArray(value)) return value.slice(0, 12).map((v) => visit(v, depth + 1));
    if (!value || typeof value !== 'object') return undefined;
    return Object.fromEntries(Object.entries(value).slice(0, 24).map(([key, v]) => [inspectionText(key, redact, 80), credential.test(key) ? '[redacted]'
      : /^(thinking|artifacts?|details|content|newText|oldText)$/i.test(key) ? '[omitted]' : visit(v, depth + 1)]));
  };
  return inspectionText(JSON.stringify(visit(args)) ?? '', redact, limit);
}
export function emptyInspection(kind = 'task', scope = 'child') {
  return { version: 1, prompt: { text: null, kind, truncated: false }, tools: { availability: 'unavailable', items: [], total: null, omitted: 0 },
    files: { availability: 'unavailable', items: [], omitted: 0 }, usage: { inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, totalTokens: null, costUsd: null, scope, provisional: false },
    timing: { startedAt: null, endedAt: null, durationMs: null, scope: 'run', live: false } };
}
export function normalizeInspection(value, redact = (x) => x, { kind = 'task', scope = 'child' } = {}) {
  const dto = emptyInspection(kind, scope);
  if (value?.version !== 1) return dto;
  const text = (v, n) => inspectionText(v, redact, n);
  const prompt = text(value.prompt?.text, Number.MAX_SAFE_INTEGER);
  dto.prompt = { text: typeof value.prompt?.text === 'string' && prompt.trim() !== '[prompt redacted]' ? prompt.slice(0, 8000) : null,
    kind, truncated: value.prompt?.truncated === true || prompt.length > 8000 };
  const availability = (v) => ['partial', 'complete'].includes(v) ? v : 'unavailable';
  const tools = record(value.tools), files = record(value.files);
  dto.tools.availability = availability(tools.availability); dto.tools.total = count(tools.total);
  const toolIds = new Set();
  for (const tool of list(tools.items).slice(-40)) {
    const id = text(tool?.id, 256), name = text(tool?.name, 160);
    if (!id || !name || toolIds.has(id)) continue;
    toolIds.add(id);
    dto.tools.items.push({ id, name, status: ['running', 'done', 'error', 'interrupted'].includes(tool.status) ? tool.status : 'unknown', summary: text(tool.summary, 600) });
  }
  if (dto.tools.items.length && dto.tools.availability === 'unavailable') dto.tools.availability = 'partial';
  dto.tools.omitted = Math.min(Number.MAX_SAFE_INTEGER, (count(tools.omitted) ?? 0) + Math.max(0, list(tools.items).length - 40));
  dto.files.availability = availability(files.availability);
  const paths = new Set();
  for (const file of list(files.items).slice(0, 64)) {
    const path = text(file?.path, 512);
    if (!path || !['observed-tool', 'reported'].includes(file?.evidence) || paths.has(path)) continue;
    paths.add(path); dto.files.items.push({ path, action: ['changed', 'added', 'deleted'].includes(file.action) ? file.action : 'unknown', evidence: file.evidence });
  }
  if (dto.files.items.length && dto.files.availability === 'unavailable') dto.files.availability = 'partial';
  dto.files.omitted = Math.min(Number.MAX_SAFE_INTEGER, (count(files.omitted) ?? 0) + Math.max(0, list(files.items).length - 64));
  for (const field of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'totalTokens']) dto.usage[field] = count(value.usage?.[field]);
  dto.usage.costUsd = inspectionNumber(value.usage?.costUsd); dto.usage.provisional = value.usage?.provisional === true;
  for (const field of ['startedAt', 'endedAt', 'durationMs']) dto.timing[field] = inspectionNumber(value.timing?.[field]);
  if (dto.timing.endedAt !== null && dto.timing.startedAt !== null && dto.timing.endedAt < dto.timing.startedAt) dto.timing.endedAt = null;
  dto.timing.live = value.timing?.live === true && dto.timing.startedAt !== null && dto.timing.endedAt === null;
  // JSON escaping and UTF-8 expansion count against the budget, not JS length.
  const size = () => Buffer.byteLength(JSON.stringify(dto));
  while (size() > INSPECTION_LIMITS.bytes && dto.tools.items.length) { dto.tools.items.shift(); dto.tools.omitted = Math.min(Number.MAX_SAFE_INTEGER, dto.tools.omitted + 1); dto.tools.availability = 'partial'; }
  while (size() > INSPECTION_LIMITS.bytes && dto.files.items.length) { dto.files.items.pop(); dto.files.omitted = Math.min(Number.MAX_SAFE_INTEGER, dto.files.omitted + 1); dto.files.availability = 'partial'; }
  while (size() > INSPECTION_LIMITS.bytes && dto.prompt.text?.length) { dto.prompt.text = dto.prompt.text.slice(0, Math.floor(dto.prompt.text.length * 0.8)); dto.prompt.truncated = true; }
  if (dto.tools.omitted && dto.tools.availability === 'complete') dto.tools.availability = 'partial';
  if (dto.files.omitted && dto.files.availability === 'complete') dto.files.availability = 'partial';
  return dto;
}
export function reportedUsage(usage, provisional = false, scope = 'child') {
  return { inputTokens: usage?.input, outputTokens: usage?.output, cacheReadTokens: usage?.cacheRead, cacheWriteTokens: usage?.cacheWrite,
    totalTokens: usage?.total, costUsd: usage?.cost, scope, provisional };
}
export function stopInspection(value, { now, measured = false } = {}) {
  const dto = structuredClone(value ?? emptyInspection());
  if (dto.timing.live && measured && dto.timing.startedAt !== null) {
    dto.timing.endedAt = now ?? Date.now(); dto.timing.durationMs = Math.max(0, dto.timing.endedAt - dto.timing.startedAt);
  }
  dto.timing.live = false;
  for (const tool of dto.tools.items) if (tool.status === 'running') tool.status = 'interrupted';
  return dto;
}
// A bounded tracker for attributable calls; never infer mutations from shell text
// or a read path. A write/edit needs an exact ID and explicit successful result.
export class InspectionTools {
  constructor(redact = (x) => x) { this.redact = redact; this.calls = new Map(); this.files = new Map(); this.omitted = 0; this.filesOmitted = 0; }
  start(id, name, args) {
    if (typeof id !== 'string' || !id || id.length > 256 || typeof name !== 'string' || !name) return;
    // Correlate exact bounded upstream IDs, never their clipped/redacted display.
    const key = id;
    if (!this.calls.has(key) && this.calls.size >= 40) { this.calls.delete(this.calls.keys().next().value); this.omitted++; }
    this.calls.set(key, { id: inspectionText(id, this.redact, 256), name: inspectionText(name, this.redact, 160), summary: argumentSummary(args, this.redact), status: 'running',
      path: ['write', 'edit'].includes(name) && typeof args?.path === 'string' ? inspectionText(args.path, this.redact, 512) : null });
  }
  end(id, isError, observeFiles = true) {
    const call = this.calls.get(id);
    if (!call) return;
    call.status = isError === true ? 'error' : isError === false ? 'done' : 'unknown';
    if (observeFiles && isError === false && call.path && !this.files.has(call.path)) {
      if (this.files.size < 64) this.files.set(call.path, { path: call.path, action: 'changed', evidence: 'observed-tool' });
      else this.filesOmitted++;
    }
    if (isError === false) call.path = null;
  }
  project(dto, total = null) {
    dto.tools = { availability: this.calls.size || count(total) !== null ? 'partial' : 'unavailable', items: [...this.calls.values()].map(({ path, ...call }) => call), total, omitted: this.omitted };
    dto.files = { availability: this.files.size ? 'partial' : 'unavailable', items: [...this.files.values()], omitted: this.filesOmitted };
    return dto;
  }
  stop() { for (const call of this.calls.values()) if (call.status === 'running') call.status = 'interrupted'; }
}
export function resultInspection(result = {}, { status = 'unknown', redact = (x) => x, previous, activity } = {}) {
  const dto = previous ? structuredClone(previous) : emptyInspection();
  const live = status === 'running';
  const progress = result.progress ?? result.progressSummary ?? activity ?? {};
  if (typeof (result.task ?? progress.task) === 'string') dto.prompt = { text: result.task ?? progress.task, kind: 'task', truncated: false };
  if (Array.isArray(result.messages)) {
    const tracker = new InspectionTools(redact);
    // Scan bounded recent history. Missing older calls remain unavailable, not success.
    for (const m of result.messages.slice(-400)) {
      if (m?.role === 'assistant') for (const c of list(m.content).slice(0, 200)) if (c?.type === 'toolCall') tracker.start(c.id, c.name, c.arguments);
      if (m?.role === 'toolResult') tracker.end(m.toolCallId, m.isError);
    }
    if (!live) tracker.stop();
    tracker.project(dto, progress.toolCount);
  } else if (count(progress.toolCount) !== null) { dto.tools.total = progress.toolCount; dto.tools.availability = 'partial'; }
  dto.tools.items = dto.tools.items.filter((t) => t.id !== 'current-tool');
  if (!Array.isArray(result.messages) && Array.isArray(progress.recentTools)) {
    dto.tools.items = progress.recentTools.slice(-40).map((t, i) => ({ id: `recent:${i}`, name: t?.tool, status: 'unknown', summary: inspectionText(t?.args, redact, 600) }));
    dto.tools.omitted = Math.max(0, progress.recentTools.length - 40);
  }
  if (progress.currentTool && live && !dto.tools.items.some((t) => t.status === 'running' && t.name === progress.currentTool)) {
    dto.tools.items = [...dto.tools.items.filter((t) => t.id !== 'current-tool'), { id: 'current-tool', name: progress.currentTool, status: 'running', summary: inspectionText(progress.currentToolArgs, redact, 600) }];
    dto.tools.availability = 'partial';
  }
  const reports = result.acceptance?.childReport?.changedFiles;
  if (Array.isArray(reports)) {
    const observed = dto.files.items.filter((f) => f.evidence === 'observed-tool');
    dto.files = { availability: 'partial', items: [...observed, ...reports.slice(0, 64).filter((p) => typeof p === 'string' && !observed.some((f) => f.path === p)).map((path) => ({ path, action: 'unknown', evidence: 'reported' }))],
      omitted: (Array.isArray(result.messages) ? dto.files.omitted : 0) + Math.max(0, reports.length - 64) };
  }
  if (result.usage && typeof result.usage === 'object') dto.usage = reportedUsage({ ...result.usage, total: result.usage.total ?? progress.tokens }, live);
  else {
    // Progress counters are snapshots, not authoritative terminal usage. Missing
    // results must never promote retained running values to final billing.
    for (const [field, source] of [['inputTokens', 'inputTokens'], ['outputTokens', 'outputTokens'], ['totalTokens', 'tokens']]) if (count(progress[source]) !== null) {
      dto.usage[field] = progress[source]; dto.usage.provisional = true;
    }
    if (live) dto.usage.provisional = true;
  }
  if (inspectionNumber(progress.durationMs) !== null) dto.timing.durationMs = progress.durationMs;
  dto.timing.live = false; // A duration snapshot alone is not an execution-start timestamp.
  return normalizeInspection(live ? dto : stopInspection(dto), redact);
}
export function snapshotInspection(node, previous, redact) {
  const dto = previous ? structuredClone(previous) : emptyInspection();
  const running = node.state === 'running';
  const start = node.state === 'queued' || node.state === 'pending' ? null : inspectionNumber(node.startedAt);
  const end = inspectionNumber(node.endedAt);
  dto.timing = { startedAt: start, endedAt: end, durationMs: start !== null && end !== null && end >= start ? end - start : dto.timing.durationMs, scope: 'run', live: running && start !== null && end === null };
  if (count(node.activity?.toolCount) !== null) { dto.tools.total = node.activity.toolCount; dto.tools.availability = 'partial'; }
  dto.tools.items = dto.tools.items.filter((t) => t.id !== 'current-tool');
  if (running && typeof node.activity?.currentTool === 'string') dto.tools.items.push({ id: 'current-tool', name: node.activity.currentTool, status: 'running', summary: '' });
  if (running) dto.usage.provisional = true; // Status alone cannot finalize cached usage.
  return normalizeInspection(running ? dto : stopInspection(dto), redact);
}
export function inspectReplyInspection(reply, previous, redact) {
  const dto = previous ? structuredClone(previous) : emptyInspection();
  if (typeof reply.task === 'string') dto.prompt = { text: reply.task, kind: 'task', truncated: reply.truncated?.task === true };
  // The inspect protocol strips call IDs and reports display text, not arguments.
  // Do not correlate neighboring records or label uncorrelated calls successful.
  const calls = list(reply.messages).filter((m) => m?.kind === 'toolCall');
  dto.tools.items = calls.slice(-40).map((m, i) => ({ id: `preview:${i}`, name: m.name || 'Tool', status: 'unknown', summary: inspectionText(m.text, redact, 600) }));
  dto.tools.omitted = Math.max(0, calls.length - 40);
  if (calls.length || dto.tools.total !== null) dto.tools.availability = 'partial';
  return normalizeInspection(dto, redact);
}
