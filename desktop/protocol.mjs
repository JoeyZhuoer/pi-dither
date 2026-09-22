import { emptyInspection, normalizeInspection, InspectionTools, inspectionText, argumentText, reportedUsage, stopInspection } from './inspection.mjs';

export const TEXT_LIMIT = 64_000;
export const clip = (value, limit = TEXT_LIMIT) => {
  const text = String(value ?? '');
  return text.length > limit ? text.slice(0, limit) + '\n[Display truncated; full output remains in the Pi session.]' : text;
};
export const contentText = (content) => typeof content === 'string' ? content
  : (content ?? []).filter((block) => block.type === 'text').map((block) => block.text).join('\n');
export const safeModel = (model) => model ? {
  id: model.id, provider: model.provider, name: model.name ?? model.id,
  reasoning: !!model.reasoning, contextWindow: model.contextWindow,
} : null;

// RPC is strictly LF-delimited JSON, not Unicode-line-delimited text.
export class JsonLines {
  buffer = '';
  push(chunk) {
    this.buffer += chunk;
    if (this.buffer.length > 8_000_000) throw new Error('Pi RPC frame exceeds the safety limit');
    const frames = [];
    let index;
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index).replace(/\r$/, '');
      this.buffer = this.buffer.slice(index + 1);
      if (line.trim()) frames.push(JSON.parse(line));
    }
    return frames;
  }
}

export function createAgentState(id, name, kind) {
  return {
    id, name, kind, phase: 'starting', connected: false, model: null, thinking: 'off',
    models: [], levels: ['off'], messages: [], queue: { steering: [], followUp: [] },
    inspection: emptyInspection('user', 'session'), stats: null, error: null, notice: '', sessionId: null, revision: 0, trimmed: false,
    sessionName: name, cwd: '', startedAt: Date.now(), lastActivityAt: null,
    currentTool: null, activity: [], activityMode: 'idle', currentUsage: null, availableTools: null, activeTools: null, extensionStatus: null,
    ...(kind === 'main' ? { delegations: [], delegationStatus: { available: false, message: 'Discovering delegation telemetry.', omitted: 0 } } : {}),
  };
}

export class AgentReducer {
  constructor(state, redact = (x) => x) { this.state = state; this.redact = redact; this.inspectionTools = new InspectionTools(redact); this.serial = 0; this.assistant = null; this.blocks = []; }
  captureInspectionStats(stats) {
    const dto = this.state.inspection;
    dto.usage = reportedUsage({ ...stats?.tokens, cost: stats?.cost }, dto.timing.live, 'session');
    this.inspectionTools.project(dto, stats?.toolCalls);
    this.state.inspection = normalizeInspection(dto, this.redact, { kind: 'user', scope: 'session' });
  }
  stopInspection(settled = false) {
    this.inspectionTools.stop();
    this.state.inspection = stopInspection(this.state.inspection, { measured: settled });
  }
  inspectEvent(event) {
    if (!['agent_start', 'agent_settled', 'message_start', 'tool_execution_start', 'tool_execution_end'].includes(event.type)) return;
    const dto = this.state.inspection;
    if (event.type === 'agent_start' && !this.hydrating && !dto.timing.live) {
      dto.timing = { startedAt: Date.now(), endedAt: null, durationMs: null, scope: 'run', live: true };
      dto.usage.provisional = true;
    }
    if (event.type === 'message_start' && event.message?.role === 'user') {
      const text = inspectionText(contentText(event.message.content), this.redact, Number.MAX_SAFE_INTEGER);
      dto.prompt = { text, kind: 'user', truncated: text.length > 8000 };
    }
    if (event.type === 'tool_execution_start') {
      this.inspectionTools.start(event.toolCallId, event.toolName, event.args);
      this.inspectionTools.project(dto);
    }
    if (event.type === 'tool_execution_end') {
      this.inspectionTools.end(event.toolCallId, event.isError, !this.hydrating);
      this.inspectionTools.project(dto);
    }
    if (event.type === 'agent_settled' && !this.hydrating) this.stopInspection(true);
    this.state.inspection = normalizeInspection(this.state.inspection, this.redact, { kind: 'user', scope: 'session' });
  }
  add(message) {
    this.state.messages.push({ id: `m${++this.serial}`, at: Date.now(), ...message });
    return this.state.messages.at(-1);
  }
  reset() {
    this.inspectionTools = new InspectionTools(this.redact); this.state.inspection = emptyInspection('user', 'session');
    this.state.messages = []; this.state.queue = { steering: [], followUp: [] };
    this.state.error = null; this.state.notice = ''; this.state.stats = null;
    this.state.phase = 'idle'; this.state.activityMode = 'idle'; this.assistant = null; this.blocks = [];
    this.state.trimmed = false; this.state.currentTool = null; this.state.currentUsage = null;
    this.state.activity = []; this.state.lastActivityAt = null; this.state.revision++;
  }
  hydrate(messages) {
    this.reset(); this.hydrating = true;
    for (const message of messages) {
      if (['user', 'assistant', 'custom'].includes(message.role)) this.apply({ type: 'message_start', message });
      if (message.role === 'assistant') {
        this.apply({ type: 'message_end', message });
        for (const call of (message.content ?? []).filter((b) => b.type === 'toolCall')) this.apply({ type: 'tool_execution_start', toolCallId: call.id, toolName: call.name, args: call.arguments });
      } else if (message.role === 'toolResult') this.apply({ type: 'tool_execution_end', toolCallId: message.toolCallId, toolName: message.toolName, result: message, isError: message.isError });
      else if (message.role === 'bashExecution') this.add({ role: 'tool', name: 'bash', args: clip(message.command), text: clip(message.output), status: message.cancelled ? 'cancelled' : message.exitCode ? 'error' : 'done', at: message.timestamp });
      else if (['compactionSummary', 'branchSummary'].includes(message.role)) this.add({ role: 'assistant', text: clip(message.summary), status: 'done', at: message.timestamp });
    }
    // Inherited clone/fork history cannot prove this child changed a file.
    for (const call of this.inspectionTools.calls.values()) call.path = null;
    this.hydrating = false; this.inspectionTools.stop(); this.inspectionTools.project(this.state.inspection);
    this.state.inspection = normalizeInspection(this.state.inspection, this.redact, { kind: 'user', scope: 'session' });
    for (const message of this.state.messages) if (message.role === 'tool' && message.status === 'running') message.status = 'interrupted';
    this.state.phase = 'idle'; this.state.activityMode = 'idle'; this.state.currentTool = null; this.state.currentUsage = null;
    this.state.activity = []; this.state.lastActivityAt = messages.at(-1)?.timestamp ?? null;
    this.state.revision++;
  }
  tool(id, name) {
    return this.state.messages.find((message) => message.id === `tool:${id}`)
      ?? this.add({ id: `tool:${id}`, role: 'tool', name, args: '', text: '', status: 'running' });
  }
  apply(event) {
    this.inspectEvent(event);
    const state = this.state;
    const labels = { agent_start: 'Run started', agent_settled: 'Run settled', turn_start: 'Assistant turn started',
      tool_execution_start: `Tool started: ${clip(event.toolName, 80)}`, tool_execution_end: `Tool ${event.isError ? 'failed' : 'finished'}: ${clip(event.toolName, 80)}`,
      auto_retry_start: 'Provider retry scheduled', auto_retry_end: 'Provider retry finished',
      compaction_start: 'Context compaction started', compaction_end: 'Context compaction ended', queue_update: 'Message queue updated' };
    state.lastActivityAt = Date.now();
    if (labels[event.type]) {
      state.activity.push({ id: `a${++this.serial}`, at: state.lastActivityAt, type: event.type, label: labels[event.type] });
      state.activity = state.activity.slice(-80);
    }
    switch (event.type) {
      case 'turn_start': state.activityMode = state.currentTool ? 'tool' : 'idle'; break;
      case 'agent_start': state.phase = 'running'; state.activityMode = 'idle'; state.error = null; state.startedAt = Date.now(); break;
      // agent_end is NOT terminal: retries and queued continuations may follow it.
      case 'agent_settled':
        state.phase = 'idle'; state.activityMode = 'idle'; state.currentTool = null; state.currentUsage = null;
        for (const message of state.messages) if (message.role === 'tool' && message.status === 'running') message.status = 'interrupted';
        break;
      case 'auto_retry_start': state.phase = 'retrying'; state.activityMode = 'idle'; state.notice = `Retry ${event.attempt}/${event.maxAttempts}`; break;
      case 'auto_retry_end':
        if (!event.success) state.error = clip(event.finalError);
        state.notice = ''; break;
      case 'compaction_start': state.phase = 'compacting'; state.activityMode = 'tool'; break;
      case 'compaction_end':
        state.activityMode = 'idle';
        state.notice = event.aborted ? 'Compaction cancelled' : event.errorMessage ? 'Compaction failed' : 'Context compacted';
        if (event.errorMessage) state.error = clip(event.errorMessage);
        if (event.reason === 'manual') state.phase = event.willRetry ? 'running' : 'idle';
        break;
      case 'queue_update':
        state.queue = { steering: (event.steering ?? []).map((x) => clip(x)), followUp: (event.followUp ?? []).map((x) => clip(x)) }; break;
      case 'message_start': {
        if (event.message.role === 'custom' && event.message.display === true) this.add({ role: 'extension', text: clip(contentText(event.message.content)), status: 'done', at: event.message.timestamp ?? Date.now() });
        if (event.message.role === 'user') this.add({ role: 'user', text: clip(contentText(event.message.content)), status: 'done', at: event.message.timestamp ?? Date.now() });
        if (event.message.role === 'assistant') {
          this.blocks = [];
          state.currentUsage = null;
          this.assistant = this.add({ role: 'assistant', text: '', thinking: '', status: 'streaming', at: event.message.timestamp ?? Date.now() });
        }
        break;
      }
      case 'message_update': {
        const activity = event.assistantMessageEvent?.type;
        if (/^thinking_(start|delta|end)$/.test(activity)) state.activityMode = 'thinking';
        else if (/^text_(start|delta|end)$/.test(activity)) state.activityMode = 'output';
        else if (/^toolcall_(start|delta|end)$/.test(activity)) state.activityMode = 'tool';
        if (event.usage) state.currentUsage = event.usage;
        if (!this.assistant) break;
        const delta = event.assistantMessageEvent;
        if (!delta || !/^(text|thinking)_(start|delta|end)$/.test(delta.type)) break;
        const index = delta.contentIndex;
        if (!Number.isInteger(index) || index < 0 || index > 1024) break;
        const type = delta.type.startsWith('text') ? 'text' : 'thinking';
        const block = this.blocks[index] ??= { type, text: '' };
        if (delta.type.endsWith('_delta')) block.text = clip(block.text + (delta.delta ?? ''));
        if (delta.type.endsWith('_end') && typeof delta.content === 'string') block.text = clip(delta.content);
        for (const field of ['text', 'thinking']) {
          this.assistant[field] = clip(this.blocks.filter((b) => b?.type === field).map((b) => b.text).join('\n'));
        }
        break;
      }
      case 'message_end': {
        const message = event.message;
        if (message.role !== 'assistant') break;
        state.activityMode = state.currentTool ? 'tool' : 'idle';
        const target = this.assistant ?? this.add({ role: 'assistant' });
        target.text = clip(contentText(message.content));
        target.thinking = clip((message.content ?? []).filter((b) => b.type === 'thinking').map((b) => b.thinking).join('\n'));
        target.status = message.stopReason === 'aborted' ? 'cancelled' : message.stopReason === 'error' ? 'error' : 'done';
        if (message.errorMessage) { target.text ||= clip(message.errorMessage); state.error = clip(message.errorMessage); }
        this.assistant = null; this.blocks = []; break;
      }
      case 'tool_execution_start': {
        state.activityMode = 'tool';
        const tool = this.tool(event.toolCallId, event.toolName);
        tool.args = argumentText(event.args, this.redact, 8000); state.currentTool = event.toolName; break;
      }
      case 'tool_execution_update':
        state.activityMode = 'tool';
        // partialResult is cumulative, not a delta.
        this.tool(event.toolCallId, event.toolName).text = clip(contentText(event.partialResult?.content)); break;
      case 'tool_execution_end': {
        const tool = this.tool(event.toolCallId, event.toolName);
        tool.text = clip(contentText(event.result?.content));
        tool.status = event.isError ? 'error' : 'done';
        state.currentTool = state.messages.find((m) => m.role === 'tool' && m.status === 'running')?.name ?? null;
        state.activityMode = state.currentTool ? 'tool' : 'idle';
        if (event.result?.details?.patch) tool.patch = clip(event.result.details.patch);
        break;
      }
      case 'extension_error': state.error = clip(event.error); break;
      default: return false;
    }
    let bytes = state.messages.reduce((total, message) => total + (message.text?.length ?? 0) + (message.thinking?.length ?? 0), 0);
    while (state.messages.length > 160 || (bytes > 1_000_000 && state.messages.length > 1)) {
      const removed = state.messages.shift();
      bytes -= (removed.text?.length ?? 0) + (removed.thinking?.length ?? 0);
      state.trimmed = true;
    }
    state.revision++;
    return true;
  }
}
