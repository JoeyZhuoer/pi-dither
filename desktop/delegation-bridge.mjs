import { randomUUID } from 'node:crypto';
import { DelegationProjection } from './delegations.mjs';

const REQUEST = 'subagents:rpc:v1:request';
const REPLY = 'subagents:rpc:v1:reply:';
const INSPECT_PREFIX = 'PI_SUBAGENT_INSPECT_JSON:';
const token = (s) => typeof s === 'string' && /^[A-Za-z0-9_.:@+-]{1,256}$/.test(s) && !s.startsWith('--');

// The supported package's public transcript view includes metadata above this
// marker. Project only its bounded text body, never artifact paths from headers.
export function transcriptBody(value) {
  if (typeof value !== 'string') return '';
  const text = value.slice(0, 128000);
  const marker = /^(?:Live transcript tail|Result transcript tail|Recent output from status\.json|Transcript tail(?: from [^\n]+)?|Session transcript tail(?: from [^\n]+)?)(?: \(tail truncated\))?:\r?\n/m.exec(text);
  return marker ? text.slice(marker.index + marker[0].length).slice(-32000) : '';
}

// Public extension bus and a package-owned, read-only command handler. There is
// deliberately no prompt/sendMessage/tool executor/session writer in this bridge.
export class DelegationBridge {
  constructor({ sessionId, generation, events, inspectCommand, context, publish, redact, interval = 1500, timeout = 4000 }) {
    Object.assign(this, { sessionId, generation, events, inspectCommand, context, publish, interval, timeout });
    this.projection = new DelegationProjection(sessionId, redact);
    this.sequence = 0; this.cursor = 0; this.disposed = false; this.pending = new Set();
  }
  send() {
    if (this.disposed) return;
    try {
      this.publish({ type: 'desktop_delegations', sessionId: this.sessionId, generation: this.generation,
        sequence: ++this.sequence, ...this.projection.snapshot() });
    } catch { /* A failed display channel must never interrupt the conversation. */ }
  }
  changed() {
    if (this.disposed || this.flushTimer) return;
    this.flushTimer = setTimeout(() => { this.flushTimer = null; this.send(); }, 200);
    this.flushTimer.unref?.();
  }
  foreground(event) {
    if (this.disposed || event?.toolName !== 'subagent') return;
    try { this.projection.foreground(event); this.changed(); }
    catch { this.projection.unavailable('Foreground delegation telemetry unavailable.'); this.changed(); }
  }
  request(method, params) {
    return new Promise((resolve, reject) => {
      if (this.disposed) { reject(new Error('disposed')); return; }
      const requestId = randomUUID(); let off;
      const finish = (error, value) => {
        clearTimeout(timer); off?.(); this.pending.delete(cancel);
        if (error) reject(error); else resolve(value);
      };
      const cancel = () => finish(new Error('disposed'));
      const timer = setTimeout(() => finish(new Error('timeout')), this.timeout);
      this.pending.add(cancel);
      off = this.events.on(REPLY + requestId, (reply) => {
        if (reply?.requestId !== requestId || reply.version !== 1) return;
        if (reply.success !== true) finish(new Error('unavailable'));
        else finish(null, reply.data);
      });
      try { this.events.emit(REQUEST, { version: 1, requestId, method, ...(params ? { params } : {}) }); }
      catch { finish(new Error('unavailable')); }
    });
  }
  async inspect(row) {
    if (!this.inspectCommand || !token(row.runId) || (row.childId && !token(row.childId))) return;
    const requestId = randomUUID(); let reply;
    // The installed public handler only requires mode/hasUI/ui. Preserve its
    // session context, but replace UI with a private bounded response collector.
    const context = { ...this.context, mode: 'rpc', hasUI: true, ui: {
      setWidget(key, lines) {
        if (key !== 'subagent-inspect' || !Array.isArray(lines) || lines.length !== 1) return;
        const line = lines[0];
        if (typeof line !== 'string' || line.length > 70_000 || !line.startsWith(INSPECT_PREFIX)) return;
        try { const value = JSON.parse(line.slice(INSPECT_PREFIX.length)); if (value.requestId === requestId) reply = value; } catch { /* malformed telemetry only */ }
      },
    } };
    // Keep the operation single-flight even if a future incompatible handler
    // hangs: deadline disables this bridge rather than launching more work.
    await new Promise((resolve, reject) => {
      const cancel = () => finish(new Error('disposed'));
      const finish = (error) => { clearTimeout(timer); this.pending.delete(cancel); error ? reject(error) : resolve(); };
      const timer = setTimeout(() => finish(new Error('timeout')), this.timeout);
      this.pending.add(cancel);
      Promise.resolve().then(() => this.disposed ? undefined : this.inspectCommand.handler(
        `${requestId} ${row.runId}${row.childId ? ` ${row.childId}` : ''} --lines 40`, context)).then(() => finish(), () => finish(new Error('inspect unavailable')));
    });
    if (this.disposed) return;
    if (!reply || !this.projection.inspect(row.id, reply)) throw new Error('inspect unavailable');
  }
  async live(row, summaries) {
    if (!['queued', 'running'].includes(row.status)) return;
    try {
      let route = this.projection.routes.get(row.id);
      if (!route && row.source === 'async') {
        if (!row.childId) route = { id: row.runId };
        else if (/^step:\d+$/.test(row.childId)) route = { id: row.runId, index: Number(row.childId.slice(5)) };
        else {
          // Workflow keys are NOT array positions. Resolve the exact child run
          // using the package's versioned identity summary, never by guessing.
          if (!summaries.has(row.runId)) summaries.set(row.runId, await this.request('status', { id: row.runId }));
          const summary = summaries.get(row.runId)?.details?.workflowChildren;
          const child = summary?.version === 1 && summary.workflowRunId === row.runId
            ? summary.children?.find((item) => item.childId === row.childId) : null;
          if (token(child?.runId)) route = { id: child.runId };
        }
      }
      if (!route || !token(route.id) || this.disposed) return;
      const result = await this.request('status', { ...route, view: 'transcript', lines: 40 });
      if (!this.disposed) this.projection.liveTail(row.id, transcriptBody(result?.text));
    } catch (error) {
      if (error.message === 'timeout' || error.message === 'disposed') throw error;
      // A queued or already-reaped child may not have a readable live tail.
      // Preserve its saved transcript and keep observing other children.
      this.projection.message = 'Some live output is unavailable; saved child messages are retained.';
    }
  }
  async start() {
    this.send();
    try {
      const ping = await this.request('ping');
      if (this.disposed) return;
      if (ping?.capabilities?.statusProjection?.version !== 1) throw new Error('unsupported');
      await this.poll();
    } catch { if (!this.disposed) { this.projection.unavailable('Delegation telemetry unavailable or unsupported; conversation is unaffected.'); this.send(); } }
  }
  async poll() {
    if (this.disposed || this.polling) return;
    this.polling = true;
    try {
      const data = await this.request('status');
      if (this.disposed) return;
      if (!this.projection.asyncSnapshot(data?.asyncSnapshot)) throw new Error('unsupported');
      const rows = [...this.projection.rows.values()].filter((r) => r.source === 'async' || this.projection.routes.has(r.id));
      const summaries = new Map();
      // Round-robin includes terminal rows: final output may arrive after the
      // status turns terminal. At most four child reads per cycle, never overlap.
      for (let i = 0; i < Math.min(rows.length, 4); i++) {
        if (this.disposed) return;
        const row = rows[(this.cursor++) % rows.length];
        if (row.source === 'async') await this.inspect(row);
        await this.live(this.projection.rows.get(row.id) ?? row, summaries);
      }
      if (!this.inspectCommand) this.projection.message = 'Live status available; child inspection unsupported.';
      this.send();
      if (!this.disposed) {
        this.timer = setTimeout(() => this.poll(), this.interval); this.timer.unref?.();
      }
    } catch {
      // No automatic reissue on timeout: the extension operation may still be
      // running. This bounds in-flight work even without upstream cancellation.
      if (!this.disposed) { this.projection.unavailable('Delegation telemetry interrupted; retained entries may be stale.'); this.send(); }
    } finally { this.polling = false; }
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true; clearTimeout(this.timer); clearTimeout(this.flushTimer);
    for (const cancel of this.pending) cancel();
    this.pending.clear(); this.projection.rows.clear(); this.projection.calls.clear(); this.projection.routes.clear(); this.context = null;
  }
}

// Command definitions are part of Pi's public LoadExtensionsResult. Select only
// the explicitly allowlisted installed package, never a same-named prompt or an
// ambient command. Calling the handler cannot fall through to model prompting.
export function findInspectCommand(extensions, paths) {
  for (const extension of extensions ?? []) {
    if (!paths.includes(extension.resolvedPath) && !paths.includes(extension.path)) continue;
    const command = extension.commands?.get('subagents-inspect-rpc');
    if (typeof command?.handler === 'function') return command;
  }
  return null;
}
