import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { AgentReducer, JsonLines, createAgentState, safeModel, clip } from './protocol.mjs';

export class PiSession extends EventEmitter {
  constructor({ id, name, kind, cwd, host, sessionDir, env = process.env }) {
    super();
    this.state = createAgentState(id, name, kind);
    this.reducer = new AgentReducer(this.state);
    this.pending = new Map();
    this.decoder = new JsonLines();
    this.stderr = '';
    this.closed = false;
    const args = [host.cli, '--mode', 'rpc', '--offline', '--no-extensions', '--no-approve',
      '--session-dir', sessionDir, '--name', name];
    if (kind !== 'main') args.push('--tools', 'read,grep,find,ls', '--append-system-prompt',
      'You are a read-only subagent in Pi Desktop. Analyze the user task and report concise findings with evidence. Do not change files or try to bypass the read-only tool boundary.');
    this.child = spawn(process.execPath, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk) => {
      try { for (const event of this.decoder.push(chunk)) this.receive(event); }
      catch (error) { this.fail(`Invalid Pi RPC stream: ${error.message}`); this.close(); }
    });
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (text) => { this.stderr = (this.stderr + text).slice(-16_000); });
    this.child.stdin.on('error', (error) => this.fail(error.message));
    this.child.on('error', (error) => this.fail(error.message));
    this.child.on('exit', (code, signal) => {
      clearTimeout(this.killTimer);
      this.state.connected = false;
      if (!this.closed) this.fail(`Pi exited (${signal ?? code}). ${clip(this.stderr, 2000)}`);
      else this.state.phase = 'stopped';
      for (const { reject, timer } of this.pending.values()) { clearTimeout(timer); reject(new Error('Pi process exited')); }
      this.pending.clear(); this.changed();
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
  fail(message) { this.state.phase = 'error'; this.state.error = clip(message, 4000); this.changed(); }
  async initialize() {
    const [state, models, levels, stats] = await Promise.all([
      this.command('get_state'), this.command('get_available_models'),
      this.command('get_available_thinking_levels'), this.command('get_session_stats'),
    ]);
    this.state.model = safeModel(state.model);
    this.state.thinking = state.thinkingLevel;
    this.state.sessionId = state.sessionId;
    this.state.models = (models.models ?? []).map(safeModel);
    this.state.levels = levels.levels ?? ['off'];
    this.state.stats = { tokens: stats.tokens, cost: stats.cost, contextUsage: stats.contextUsage };
    this.state.connected = true;
    this.state.phase = 'idle'; this.changed();
  }
  receive(event) {
    if (event.type === 'response') {
      const pending = this.pending.get(event.id);
      if (!pending) return;
      this.pending.delete(event.id); clearTimeout(pending.timer);
      if (event.success) pending.resolve(event.data ?? {});
      else pending.reject(new Error(event.error || `${event.command} failed`));
      return;
    }
    if (event.type === 'extension_ui_request' && ['select', 'confirm', 'input', 'editor'].includes(event.method)) {
      // Extensions are disabled in this release. Unexpected dialogs must fail closed, not hang/approve.
      this.child.stdin.write(JSON.stringify({ type: 'extension_ui_response', id: event.id, cancelled: true }) + '\n');
      this.state.notice = 'An unsupported extension dialog was cancelled.'; this.changed();
      return;
    }
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
  async refresh() {
    const [state, stats, levels] = await Promise.all([
      this.command('get_state'), this.command('get_session_stats'), this.command('get_available_thinking_levels'),
    ]);
    this.state.model = safeModel(state.model);
    this.state.thinking = state.thinkingLevel;
    this.state.sessionId = state.sessionId;
    this.state.levels = levels.levels;
    this.state.stats = { tokens: stats.tokens, cost: stats.cost, contextUsage: stats.contextUsage };
    this.changed();
  }
  async act(action, input) {
    await this.ready;
    switch (action) {
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
      case 'new': {
        if (this.state.phase !== 'idle') throw new Error('Stop the agent before starting a new session.');
        const result = await this.command('new_session');
        if (result.cancelled) throw new Error('Session replacement was cancelled');
        this.reducer.reset(); await this.refresh(); return {};
      }
      default: throw new Error('Unsupported action');
    }
  }
  close() {
    if (this.closed) return;
    this.closed = true; this.state.connected = false; this.state.phase = 'stopped'; this.changed();
    const kill = (signal) => {
      try {
        if (process.platform === 'win32') this.child.kill(signal);
        else if (this.child.pid) process.kill(-this.child.pid, signal);
      } catch (error) { if (error.code !== 'ESRCH') throw error; }
    };
    kill('SIGTERM');
    this.killTimer = setTimeout(() => kill('SIGKILL'), 3000);
    this.killTimer.unref();
  }
}
