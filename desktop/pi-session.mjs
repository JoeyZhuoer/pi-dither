import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { AgentReducer, JsonLines, createAgentState, safeModel, clip } from './protocol.mjs';
import { assertToolChangeReady, validateToolSelection } from './tools.mjs';
import { sanitizeDelegations, safeDelegationText } from './delegations.mjs';

export class PiSession extends EventEmitter {
  constructor({ id, name, kind, cwd, host, sessionDir, sessionPath, tools, keys = {}, env = process.env }) {
    super();
    this.state = createAgentState(id, name, kind);
    this.state.cwd = cwd;
    this.secrets = Object.values(keys);
    this.reducer = new AgentReducer(this.state);
    this.pending = new Map();
    this.toolPending = new Map();
    this.toolRevision = -1;
    this.metadataGeneration = 0;
    this.decoder = new JsonLines();
    this.stderr = '';
    this.closed = false;
    const args = [fileURLToPath(new URL('./rpc-host.mjs', import.meta.url))];
    this.child = spawn(process.execPath, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'ipc'], detached: process.platform !== 'win32' });
    this.exited = new Promise((done) => { this.child.once('exit', done); this.child.once('error', done); });
    this.child.stdio[3].on('error', (error) => this.fail(error.message));
    this.child.stdio[3].end(JSON.stringify({ root: host.root, name, kind, sessionDir, sessionPath, tools, keys }));
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk) => {
      try { for (const event of this.decoder.push(chunk)) this.receive(event); }
      catch (error) { this.fail(`Invalid Pi RPC stream: ${error.message}`); this.close(); }
    });
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (text) => { this.stderr = (this.stderr + text).slice(-16_000); });
    this.child.stdin.on('error', (error) => this.fail(error.message));
    this.child.on('error', (error) => this.fail(error.message));
    this.child.on('message', (message) => { this.receiveTools(message); this.receiveDelegations(message); });
    this.child.on('disconnect', () => {
      this.rejectToolRequests('Pi tool channel disconnected');
      this.disconnectDelegations(); this.state.activityMode = 'idle'; this.changed();
    });
    this.child.on('exit', (code, signal) => {
      clearTimeout(this.killTimer);
      this.state.connected = false; this.state.currentTool = null; this.state.currentUsage = null; this.state.activityMode = 'idle';
      this.disconnectDelegations();
      for (const message of this.state.messages) if (message.role === 'tool' && message.status === 'running') message.status = 'interrupted';
      if (!this.closed) this.fail(`Pi exited (${signal ?? code}). ${clip(this.stderr, 2000)}`);
      else this.state.phase = 'stopped';
      for (const { reject, timer } of this.pending.values()) { clearTimeout(timer); reject(new Error('Pi process exited')); }
      this.pending.clear(); this.rejectToolRequests('Pi process exited'); this.changed();
    });
    this.ready = this.initialize().catch((error) => {
      this.fail(error.message);
      this.close();
      throw error;
    });
    // Consumers also await ready; this prevents an early process failure becoming unhandled.
    this.ready.catch(() => {});
  }
  changed() { this.state.revision++; this.emit('change'); }
  redact(message) {
    let text = String(message ?? '');
    for (const key of this.secrets) if (key) text = text.split(key).join('[redacted]');
    return text;
  }
  fail(message) { this.state.phase = 'error'; this.state.activityMode = 'idle'; this.state.error = clip(this.redact(message), 4000); this.changed(); }
  receiveDelegations(message) {
    if (this.closed || this.state.kind !== 'main' || message?.type !== 'desktop_delegations'
      || typeof message.sessionId !== 'string' || !Number.isSafeInteger(message.generation) || !Number.isSafeInteger(message.sequence)) return;
    const previous = this.delegationSnapshot;
    if (previous && (message.generation < previous.generation || (message.generation === previous.generation && message.sequence <= previous.sequence))) return;
    const { rows, omitted } = sanitizeDelegations(message.delegations, (text) => this.redact(text));
    const reported = message.delegationStatus;
    this.delegationSnapshot = { sessionId: message.sessionId, generation: message.generation, sequence: message.sequence,
      delegations: rows, delegationStatus: { available: reported?.available === true,
        message: safeDelegationText(reported?.message, (text) => this.redact(text), 1000),
        omitted: omitted + (Number.isSafeInteger(reported?.omitted) && reported.omitted > 0 ? reported.omitted : 0) } };
    if (this.captureDelegations()) this.changed();
  }
  captureDelegations() {
    const snapshot = this.delegationSnapshot;
    if (!snapshot || snapshot.sessionId !== this.state.sessionId || this.closed) return false;
    this.state.delegations = snapshot.delegations;
    this.state.delegationStatus = snapshot.delegationStatus;
    return true;
  }
  disconnectDelegations() {
    this.delegationSnapshot = null;
    if (this.state.kind !== 'main') return;
    this.state.delegations = (this.state.delegations ?? []).map((row) => ['queued', 'running'].includes(row.status)
      ? { ...row, status: 'unknown', phase: 'idle' } : { ...row, phase: 'idle' });
    this.state.delegationStatus = { available: false, message: 'Delegation telemetry disconnected.', omitted: this.state.delegationStatus?.omitted ?? 0 };
  }
  capture(state, stats) {
    this.sessionFile = state.sessionFile;
    if (this.state.sessionId !== state.sessionId) {
      this.state.activityMode = 'idle';
      if (this.state.kind === 'main') {
        this.state.delegations = []; this.state.delegationStatus = { available: false, message: 'Discovering delegation telemetry.', omitted: 0 };
      }
    }
    this.state.sessionId = state.sessionId;
    this.captureDelegations();
    this.state.sessionName = state.sessionName || this.state.name;
    this.state.stats = { tokens: stats.tokens, cost: stats.cost, contextUsage: stats.contextUsage,
      userMessages: stats.userMessages, assistantMessages: stats.assistantMessages, toolCalls: stats.toolCalls,
      totalMessages: stats.totalMessages, updatedAt: Date.now() };
  }
  async initialize() {
    const [state, models, levels, stats, history] = await Promise.all([
      this.command('get_state'), this.command('get_available_models'),
      this.command('get_available_thinking_levels'), this.command('get_session_stats'), this.command('get_messages'),
    ]);
    this.reducer.hydrate(history.messages ?? []);
    this.state.model = safeModel(state.model);
    this.state.thinking = state.thinkingLevel;
    this.state.models = (models.models ?? []).map(safeModel);
    this.state.levels = levels.levels ?? ['off'];
    this.capture(state, stats);
    this.captureTools(await this.toolCommand('get'));
    this.state.connected = true;
    this.state.phase = 'idle'; this.changed();
  }
  receive(event) {
    if (event.type === 'response') {
      const pending = this.pending.get(event.id);
      if (!pending) return;
      this.pending.delete(event.id); clearTimeout(pending.timer);
      if (event.success) pending.resolve(event.data ?? {});
      else pending.reject(new Error(this.redact(event.error || `${event.command} failed`)));
      return;
    }
    if (event.type === 'extension_ui_request' && ['select', 'confirm', 'input', 'editor'].includes(event.method)) {
      // Native terminal dialogs are not implemented here: fail closed, never auto-approve.
      this.child.stdin.write(JSON.stringify({ type: 'extension_ui_response', id: event.id, cancelled: true }) + '\n');
      this.state.notice = 'An unsupported extension dialog was cancelled.'; this.changed();
      return;
    }
    if (event.type === 'extension_ui_request' && event.method === 'notify') {
      this.state.notice = clip(this.redact(event.message), 4000); this.changed(); return;
    }
    if (event.type === 'extension_error') {
      this.state.notice = clip(this.redact(`Extension error: ${event.error}`), 4000); this.changed(); return;
    }
    if (event.message?.errorMessage) event.message.errorMessage = this.redact(event.message.errorMessage);
    for (const key of ['error', 'errorMessage', 'finalError']) if (typeof event[key] === 'string') event[key] = this.redact(event[key]);
    if (this.reducer.apply(event)) this.emit('change');
    if (event.type === 'agent_settled' || event.type === 'compaction_end') {
      this.refresh().catch((error) => { this.state.notice = error.message; this.changed(); });
    }
  }
  command(type, data = {}) {
    if (this.closed || this.child.exitCode !== null || this.child.killed) return Promise.reject(new Error('Pi is not running'));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Pi did not acknowledge ${type}. Delivery is uncertain; do not automatically resend.`));
      }, 45_000);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ ...data, type, id }) + '\n', (error) => {
        if (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
      });
    });
  }
  rejectToolRequests(message) {
    for (const { reject, timer, action } of this.toolPending.values()) {
      clearTimeout(timer);
      if (action === 'set') this.invalidateTools();
      reject(new Error(message));
    }
    this.toolPending.clear();
  }
  receiveTools(message) {
    if (message?.type !== 'desktop_tools_response') return;
    const pending = this.toolPending.get(message.id);
    if (!pending) return;
    this.toolPending.delete(message.id); clearTimeout(pending.timer);
    if (message.success) pending.resolve(message.data);
    else pending.reject(new Error(this.redact(message.error || 'Tool control failed')));
  }
  invalidateTools() {
    this.metadataGeneration++;
    this.state.availableTools = null; this.state.activeTools = null; this.changed();
  }
  toolCommand(action, data = {}, timeout = 15_000) {
    if (this.closed || !this.child.connected) return Promise.reject(new Error('Pi tool channel is not connected'));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.toolPending.delete(id);
        // A late setter may have executed. Do not retain a possibly wider selection for reconnect.
        if (action === 'set') this.invalidateTools();
        reject(new Error('Pi tool control timed out. Refresh before retrying; delivery is uncertain.'));
      }, timeout);
      this.toolPending.set(id, { resolve, reject, timer, action });
      this.child.send({ ...data, type: 'desktop_tools_request', id, action }, (error) => {
        if (error) {
          clearTimeout(timer); this.toolPending.delete(id);
          if (action === 'set') this.invalidateTools();
          reject(error);
        }
      });
    });
  }
  selectionForReplacement() {
    if (!Array.isArray(this.state.activeTools)) throw new Error('Tool selection is unavailable. Refresh before replacing the session.');
    return [...this.state.activeTools];
  }
  captureTools(data) {
    if (data.sessionId !== this.state.sessionId || data.revision < this.toolRevision) return;
    this.toolRevision = data.revision;
    this.state.availableTools = data.availableTools;
    this.state.activeTools = data.activeTools;
    this.state.extensionStatus = data.extensionStatus ?? null;
  }
  async refresh() {
    const generation = ++this.metadataGeneration;
    const [state, stats, levels, models, tools] = await Promise.all([
      this.command('get_state'), this.command('get_session_stats'), this.command('get_available_thinking_levels'), this.command('get_available_models'), this.toolCommand('get'),
    ]);
    if (generation !== this.metadataGeneration || this.closed) return;
    this.state.model = safeModel(state.model);
    this.state.thinking = state.thinkingLevel;
    this.state.levels = levels.levels;
    this.state.models = (models.models ?? []).map(safeModel);
    this.capture(state, stats);
    this.captureTools(tools);
    this.changed();
  }
  async act(action, input) {
    await this.ready;
    switch (action) {
      case 'tools': {
        assertToolChangeReady(this.state);
        if (input.sessionId !== undefined && input.sessionId !== this.state.sessionId) throw new Error('Agent session changed.');
        const tools = validateToolSelection(input.tools, this.state.availableTools, this.state.kind);
        this.metadataGeneration++;
        const result = await this.toolCommand('set', { tools, sessionId: this.state.sessionId, revision: this.toolRevision });
        this.captureTools(result); this.changed();
        return { availableTools: this.state.availableTools, activeTools: this.state.activeTools };
      }
      case 'prompt': {
        const message = input.message?.trim();
        if (!message || message.length > 32_000) throw new Error('Enter a task of 1–32,000 characters.');
        // Interactive-only commands must not accidentally become LLM prompts.
        if (/^\/(?:settings|hotkeys|model|thinking|resume|tree|new|fork|clone|login|logout|quit|export|share|compact)(?:\s|$)/.test(message)) {
          throw new Error('That is a terminal command. Use the desktop controls, or the terminal app for that feature.');
        }
        const streamingBehavior = input.delivery === 'followUp' ? 'followUp' : 'steer';
        return this.command('prompt', { message, streamingBehavior });
      }
      case 'stop': {
        const queue = await this.command('clear_queue');
        await this.command('abort');
        await this.refresh();
        return { recovered: [...(queue.steering ?? []), ...(queue.followUp ?? [])] };
      }
      case 'model':
        if (this.state.phase !== 'idle') throw new Error('Stop the agent before changing models.');
        if (!this.state.models.some((m) => m.id === input.modelId && m.provider === input.provider)) throw new Error('Unknown model');
        await this.command('set_model', { provider: input.provider, modelId: input.modelId });
        await this.refresh(); return {};
      case 'thinking':
        if (this.state.phase !== 'idle') throw new Error('Stop the agent before changing thinking level.');
        if (!this.state.levels.includes(input.level)) throw new Error('Unsupported thinking level');
        await this.command('set_thinking_level', { level: input.level });
        await this.refresh(); return {};
      case 'refresh': await this.refresh(); return {};
      case 'rename':
        if (this.state.phase !== 'idle') throw new Error('Stop the agent before renaming its session.');
        await this.command('set_session_name', { name: input.name }); await this.refresh(); return {};
      case 'clone': {
        if (this.state.phase !== 'idle') throw new Error('Stop the agent before cloning its session.');
        this.metadataGeneration++;
        const result = await this.command('clone');
        if (result.cancelled) throw new Error('Clone was cancelled');
        this.reducer.hydrate((await this.command('get_messages')).messages ?? []);
        await this.refresh(); return {};
      }
      case 'new': {
        if (this.state.phase !== 'idle') throw new Error('Stop the agent before starting a new session.');
        this.metadataGeneration++;
        const result = await this.command('new_session');
        if (result.cancelled) throw new Error('Session replacement was cancelled');
        this.reducer.reset(); await this.refresh(); return {};
      }
      default: throw new Error('Unsupported action');
    }
  }
  close() {
    if (this.closed) return this.exited;
    this.closed = true; this.state.connected = false; this.state.phase = 'stopped'; this.state.activityMode = 'idle';
    this.disconnectDelegations(); this.changed();
    const kill = (signal) => {
      try {
        if (process.platform === 'win32') this.child.kill(signal);
        else if (this.child.pid) process.kill(-this.child.pid, signal);
      } catch (error) { if (error.code !== 'ESRCH') throw error; }
    };
    kill('SIGTERM');
    this.killTimer = setTimeout(() => kill('SIGKILL'), 3000);
    this.killTimer.unref();
    return this.exited;
  }
}
