import { createHash } from 'node:crypto';

export const DELEGATION_LIMITS = Object.freeze({ rows: 32, messages: 40, text: 8000, bytes: 256_000 });
const statuses = new Set(['queued', 'running', 'complete', 'failed', 'partial', 'paused', 'stopped', 'rejected', 'unknown']);
const terminal = (status) => !['queued', 'running', 'unknown'].includes(status);
const visibleOutput = (messages, redact) => list(messages).slice(-DELEGATION_LIMITS.messages).filter((m) => m?.role === 'assistant')
  .map((m) => safeDelegationText(m.text, redact, 2000)).join('\n');
const list = (value) => Array.isArray(value) ? value : [];
const identity = (value) => typeof value === 'string' && value.length > 0 && value.length <= 256 ? value : null;
const statusOf = (value) => value === 'completed' ? 'complete' : value === 'pending' ? 'queued' : statuses.has(value) ? value : 'unknown';
const textOf = (content, redact) => typeof content === 'string' ? redact(content) : list(content).filter((b) => b?.type === 'text').slice(0, 80).map((b) => typeof b.text === 'string' ? redact(b.text).slice(0, 8000) : '').join('\n');
// An early single-run snapshot may not have materialized its step yet. Its
// implicit first child and later explicit step:0 must keep one window identity.
export const delegationId = (sessionId, source, runId, childId) => `delegate:${createHash('sha256').update(JSON.stringify([sessionId, source, runId, source === 'async' && childId === '' ? 'step:0' : childId])).digest('hex').slice(0, 32)}`;

// A strict allowlist, used again at the server boundary. No raw details, artifact
// paths, tool arguments, thinking blocks, or credential-bearing metadata escape.
export function safeDelegationText(value, redact = (x) => x, limit = DELEGATION_LIMITS.text) {
  if (typeof value !== 'string') return '';
  return redact(value).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').slice(0, limit);
}
export function sanitizeDelegations(rows, redact = (x) => x) {
  let bytes = 0, omitted = Math.max(0, list(rows).length - DELEGATION_LIMITS.rows);
  const result = [];
  for (const row of list(rows).slice(0, DELEGATION_LIMITS.rows)) {
    if (!row || !identity(row.id) || !identity(row.runId) || typeof row.childId !== 'string') { omitted++; continue; }
    const text = (v, n) => safeDelegationText(v, redact, n);
    const clean = { id: text(row.id, 256), runId: text(row.runId, 256), childId: text(row.childId, 256), name: text(row.name, 160),
      source: row.source === 'async' ? 'async' : 'foreground', status: statusOf(row.status),
      phase: ['idle', 'thinking', 'output', 'tool', 'unknown'].includes(row.phase) ? row.phase : 'unknown',
      task: text(row.task, 2000), messages: list(row.messages).slice(-DELEGATION_LIMITS.messages).map((m, i) => ({
        id: text(m?.id, 256) || `m${i}`, role: ['user', 'assistant', 'tool'].includes(m?.role) ? m.role : 'assistant',
        text: text(m?.text, 2000), ...(m?.name ? { name: text(m.name, 160) } : {}),
        ...(m?.status ? { status: text(m.status, 40) } : {}),
      })), finalOutput: text(row.finalOutput), error: text(row.error, 2000),
      updatedAt: Number.isFinite(row.updatedAt) && row.updatedAt >= 0 ? row.updatedAt : 0 };
    const size = Buffer.byteLength(JSON.stringify(clean));
    if (bytes + size > DELEGATION_LIMITS.bytes) { omitted++; continue; }
    bytes += size; result.push(clean);
  }
  return { rows: result, omitted };
}

export class DelegationProjection {
  constructor(sessionId, redact = (x) => x) { this.sessionId = sessionId; this.redact = redact; this.rows = new Map(); this.calls = new Map(); this.routes = new Map(); this.omitted = 0; this.available = false; this.message = 'Discovering delegation telemetry.'; }
  unavailable(message = 'Delegation telemetry unavailable.') {
    this.available = false; this.message = message;
    for (const row of this.rows.values()) if (['queued', 'running'].includes(row.status)) { row.status = 'unknown'; row.phase = 'unknown'; }
  }
  put(row) {
    const id = delegationId(this.sessionId, row.source, row.runId, row.childId);
    if (!this.rows.has(id) && this.rows.size >= DELEGATION_LIMITS.rows) {
      // Keep active work preferentially; retained history remains strictly bounded.
      const old = [...this.rows.values()].filter((r) => !['running', 'queued'].includes(r.status)).sort((a, b) => a.updatedAt - b.updatedAt)[0];
      if (!old || (!['running', 'queued'].includes(row.status) && row.updatedAt <= old.updatedAt)) { this.omitted = Math.max(1, this.omitted); return; }
      this.rows.delete(old.id); this.routes.delete(old.id); this.omitted++;
    }
    const previous = this.rows.get(id);
    const clean = sanitizeDelegations([{ ...previous, ...row, id }], this.redact).rows[0];
    if (clean) this.rows.set(id, clean);
  }
  foreground(event) {
    if (event.toolName !== 'subagent' || !['tool_execution_update', 'tool_execution_end'].includes(event.type)) return;
    const details = (event.partialResult ?? event.result)?.details;
    if (!details && event.type === 'tool_execution_end') {
      const runId = this.calls.get(event.toolCallId);
      this.calls.delete(event.toolCallId);
      for (const row of this.rows.values()) if (row.source === 'foreground' && row.runId === runId && !terminal(row.status)) {
        row.status = event.isError ? 'failed' : 'unknown'; row.phase = event.isError ? 'idle' : 'unknown';
        row.error = event.isError ? 'Delegation tool failed before reporting child results.' : '';
      }
      return;
    }
    if (!details || details.asyncId || details.background || details.mode === 'management' || !identity(details.runId)) return;
    const end = event.type === 'tool_execution_end';
    if (end) this.calls.delete(event.toolCallId);
    else if (typeof event.toolCallId === 'string' && (this.calls.has(event.toolCallId) || this.calls.size < DELEGATION_LIMITS.rows)) this.calls.set(event.toolCallId, details.runId);
    if (details.workflowChildren?.version === 1 && details.workflowChildren.workflowRunId === details.runId) {
      this.foregroundWorkflow(details, end); return;
    }
    const results = list(details.results);
    this.omitted = Math.max(this.omitted, results.length - DELEGATION_LIMITS.rows);
    for (const row of results.slice(0, DELEGATION_LIMITS.rows)) {
      if (!row || !Number.isSafeInteger(row.index) || row.index < 0 || row.kind === 'host-step') continue;
      const progress = row.progress ?? row.progressSummary ?? {};
      const status = row.stopped ? 'stopped' : row.interrupted ? 'paused' : row.detached ? 'unknown'
        : row.error || row.timedOut ? 'failed' : end && typeof row.exitCode === 'number' ? (row.exitCode === 0 ? 'complete' : 'failed')
        : statusOf(progress.status);
      let messages = list(row.messages).slice(-DELEGATION_LIMITS.messages).flatMap((m, i) => {
        const text = textOf(m?.content, this.redact);
        return text ? [{ id: `m${i}`, role: m.role === 'toolResult' ? 'tool' : m.role, text, ...(m.toolName ? { name: m.toolName } : {}) }] : [];
      });
      if (!messages.length && Array.isArray(progress.recentOutput)) messages = [{ id: 'output', role: 'assistant', text: progress.recentOutput.slice(-20).map((s) => safeDelegationText(s, this.redact)).join('\n').slice(-2000) }];
      const previous = this.rows.get(delegationId(this.sessionId, 'foreground', details.runId, String(row.index)));
      const output = visibleOutput(messages, this.redact);
      const outputChanged = output && output !== visibleOutput(previous?.messages, this.redact);
      this.put({ runId: details.runId, childId: String(row.index), source: 'foreground', name: row.agent || progress.agent || 'Delegate',
        status, phase: terminal(status) ? 'idle' : progress.currentTool ? 'tool' : outputChanged ? 'output' : 'unknown', task: row.task || progress.task,
        messages, finalOutput: end ? row.finalOutput : '', error: row.error || progress.error,
        updatedAt: Date.now() });
    }
  }
  foregroundWorkflow(details, end) {
    const children = list(details.workflowChildren.children);
    this.omitted = Math.max(this.omitted, children.length - DELEGATION_LIMITS.rows);
    for (const child of children.slice(0, DELEGATION_LIMITS.rows)) {
      if (!identity(child?.childId)) continue;
      const id = delegationId(this.sessionId, 'foreground', details.runId, child.childId);
      const result = list(details.results).find((r) => r?.workflowKey === child.childId);
      const status = statusOf(child.state), previous = this.rows.get(id);
      this.put({ ...previous, runId: details.runId, childId: child.childId, source: 'foreground', name: child.agent || child.childId,
        status, phase: terminal(status) ? 'idle' : child.activity?.currentTool ? 'tool' : 'unknown',
        ...(result ? { task: result.task, error: result.error, ...(end ? { finalOutput: result.finalOutput || textOf(list(result.messages).findLast((m) => m?.role === 'assistant')?.content, this.redact) } : {}) } : {}), updatedAt: Date.now() });
      // Only package-supplied exact run identities; never infer a workflow child
      // index from its visible position (snapshots can omit/reorder children).
      if (this.rows.has(id) && identity(child.runId)) this.routes.set(id, { id: child.runId });
    }
  }
  liveTail(rowId, value) {
    const row = this.rows.get(rowId);
    if (!row || !['queued', 'running'].includes(row.status)) return;
    const text = safeDelegationText(value, this.redact, 64000).slice(-2000);
    if (!text) return;
    const previous = row.messages.find((m) => m.id === 'live-tail')?.text;
    this.put({ ...row, messages: [...row.messages.filter((m) => m.id !== 'live-tail'), { id: 'live-tail', role: 'tool', name: 'Live output', text }],
      phase: row.phase === 'tool' ? 'tool' : text !== previous ? 'output' : 'unknown', updatedAt: Date.now() });
  }
  asyncSnapshot(snapshot) {
    if (snapshot?.kind !== 'pi-subagents.async-status-snapshot' || snapshot.version !== 1 || !Array.isArray(snapshot.runs)) {
      this.unavailable('Unsupported delegation status snapshot.'); return false;
    }
    this.available = true; this.message = '';
    this.snapshotOmitted = Math.max(0, Number(snapshot.omitted?.runs) || 0) + Math.max(0, Number(snapshot.omitted?.children) || 0) + (snapshot.omitted?.byteLimitExceeded ? 1 : 0);
    const seen = new Set(); let visited = 0;
    const visit = (node, root, depth = 0) => {
      if (!node || depth > 4 || ++visited > 128 || !identity(node.id) || node.kind === 'host-step') return;
      if (!['subagent', 'workflow', 'step'].includes(node.kind)) return;
      const children = list(node.children);
      const runNode = node.kind === 'subagent' || node.kind === 'workflow';
      if (runNode) root = node.id;
      // Workflow containers and single-run wrappers with steps are not extra agents.
      if (node.kind !== 'workflow' && !(runNode && children.length)) {
        const childId = runNode ? '' : node.id;
        seen.add(delegationId(this.sessionId, 'async', root, childId));
        const status = statusOf(node.state);
        this.put({ runId: root, childId, source: 'async', name: node.label || 'Delegate', status,
          phase: terminal(status) ? 'idle' : node.activity?.currentTool ? 'tool' : 'unknown', updatedAt: node.updatedAt ?? snapshot.generatedAt ?? Date.now() });
      }
      for (const child of children.slice(0, 32)) visit(child, root, depth + 1);
    };
    for (const root of snapshot.runs.slice(0, 32)) if (identity(root?.id)) visit(root, root.id);
    // Absence is not proof of completion: snapshots may omit or age out records.
    for (const row of this.rows.values()) if (row.source === 'async' && !seen.has(row.id) && !terminal(row.status)) {
      row.status = 'unknown'; row.phase = 'unknown';
    }
    return true;
  }
  inspect(rowId, reply) {
    const row = this.rows.get(rowId);
    if (!row || reply?.kind !== 'pi-subagents.inspect-reply' || reply.version !== 1 || reply.asyncId !== row.runId || (reply.childId ?? '') !== row.childId) return false;
    if (reply.error) {
      this.put({ ...row, error: `Inspection unavailable (${safeDelegationText(reply.error.code, undefined, 80)}).` }); return true;
    }
    // inspect.status describes the RUN, not necessarily this child. Its snapshot
    // child status remains authoritative; only inspected output is replaced here.
    const live = row.messages.find((m) => m.id === 'live-tail');
    const messages = list(reply.messages).slice(-DELEGATION_LIMITS.messages).filter((m) => ['text', 'toolCall', 'toolResult'].includes(m?.kind)).map((m, i) => ({ id: `m${i}`,
      role: m.kind === 'toolCall' || m.kind === 'toolResult' ? 'tool' : m.role, text: m.text, name: m.name,
      status: m.isError ? 'error' : 'done' }));
    const output = visibleOutput(messages, this.redact);
    const outputChanged = output && output !== visibleOutput(row.messages, this.redact);
    if (live && !terminal(row.status)) messages.push(live);
    this.put({ ...row, task: reply.task ?? row.task, messages, finalOutput: reply.finalOutput ?? '', error: '',
      phase: !terminal(row.status) && row.phase !== 'tool' && outputChanged ? 'output' : row.phase, updatedAt: Date.now() });
    return true;
  }
  snapshot() {
    const { rows, omitted } = sanitizeDelegations([...this.rows.values()]);
    return { delegations: rows, delegationStatus: { available: this.available, message: this.message,
      omitted: Math.min(Number.MAX_SAFE_INTEGER, this.omitted + (this.snapshotOmitted || 0) + omitted) } };
  }
}
