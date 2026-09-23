import { access } from 'node:fs/promises';
import { DesktopPreferences, DesktopSessions, directory, browseDirectory, gitInfo, gitDiff, loadPi } from './workspace.mjs';

export class DesktopControls {
  constructor({ dataDir, host, sessions, getCwd, makeSession, replaceFleet }) {
    Object.assign(this, { host, sessions, getCwd, makeSession, replaceFleet });
    this.preferences = new DesktopPreferences(dataDir);
    this.store = new DesktopSessions({ preferences: this.preferences, host });
    this.keys = Object.create(null);
  }
  async initialize() { await this.preferences.load(); }
  registry() {
    return this.registryPromise ??= loadPi(this.host).then((pi) => pi.ModelRuntime.create({ allowModelNetwork: false, signal: AbortSignal.timeout(25_000) }));
  }
  idle() {
    for (const agent of this.sessions.values()) {
      if (!['idle', 'stopped', 'error'].includes(agent.state.phase) || agent.state.queue?.steering?.length || agent.state.queue?.followUp?.length) {
        throw new Error('All agents must be idle with empty queues. Stop running agents before changing workspace, sessions, or providers.');
      }
    }
  }
  async providers() {
    const registry = await this.registry();
    const available = new Set([...this.sessions.values()].flatMap((agent) => (agent.state.models ?? []).map((m) => m.provider)));
    return { scope: 'server-lifetime', providers: registry.getProviders().map((p) => ({ id: p.id, name: p.name || p.id,
      configured: available.has(p.id), canConfigure: !!p.auth?.apiKey, temporaryOverride: Object.hasOwn(this.keys, p.id) })) };
  }
  async get(path, search) {
    switch (path) {
      case '/api/providers': return this.providers();
      case '/api/workspace': {
        const cwd = this.getCwd();
        return { cwd, recent: this.preferences.roots(cwd), ...(await browseDirectory(search.get('path') || cwd)) };
      }
      case '/api/git': return gitInfo(this.getCwd());
      case '/api/git/diff': return gitDiff(this.getCwd());
      case '/api/sessions': return { scope: 'Pi sessions', sessions: (await this.store.list(this.sessions)).map(({ path: _path, ...row }) => row) };
      case '/api/usage': {
        const agents = [...this.sessions.values()];
        await Promise.all(agents.filter((a) => a.state.connected).map((a) => a.refresh?.().catch(() => {})));
        return { agents: [...this.sessions.values()].map(({ state }) => ({ id: state.id, name: state.name, kind: state.kind, sessionId: state.sessionId, stats: state.stats, currentUsage: state.currentUsage })) };
      }
      default: return undefined;
    }
  }
  async candidate(options, keys = this.keys) {
    const agent = this.makeSession({ ...options, keys });
    try { await agent.ready; return agent; }
    catch (error) { await agent.close(); throw error; }
  }
  async openWorkspace(path, sessionPath, name = 'Main agent') {
    this.idle();
    const cwd = await directory(path);
    const old = this.sessions.get('main');
    const tools = old?.selectionForReplacement?.() ?? old?.state.activeTools ?? undefined;
    const agent = await this.candidate({ id: 'main', name, kind: 'main', cwd, sessionPath, tools });
    try { await this.preferences.remember(cwd); }
    catch (error) { await agent.close(); throw error; }
    await this.replaceFleet([agent], cwd);
    return { cwd };
  }
  async configure(data) {
    this.idle();
    const provider = (await this.providers()).providers.find((p) => p.id === data.provider && p.canConfigure);
    if (!provider) throw new Error('Provider does not support a desktop API-key override');
    if (data.remove !== true && (typeof data.apiKey !== 'string' || !data.apiKey.trim() || data.apiKey.length > 16_000 || /[\r\n\0]/.test(data.apiKey))) throw new Error('Enter a valid single-line API key');
    const next = { ...this.keys };
    if (data.remove === true) delete next[provider.id]; else next[provider.id] = data.apiKey.trim();
    const replacements = [];
    try {
      for (const old of this.sessions.values()) {
        let sessionPath = old.sessionFile;
        if (sessionPath) {
          try { await access(sessionPath); }
          catch { sessionPath = undefined; }
        }
        if (!sessionPath && old.state.messages.length) throw new Error('A session has not been persisted yet; it cannot safely be reconnected.');
        const tools = old.selectionForReplacement?.() ?? old.state.activeTools ?? undefined;
        const agent = await this.candidate({ id: old.state.id, name: old.state.name, kind: old.state.kind, slot: old.state.slot, cwd: old.state.cwd || this.getCwd(), sessionPath, tools }, next);
        replacements.push(agent);
        if (!sessionPath && old.state.sessionName && old.state.sessionName !== agent.state.sessionName) await agent.act('rename', { name: old.state.sessionName });
        if (!sessionPath && old.state.model && agent.state.models.some((m) => m.id === old.state.model.id && m.provider === old.state.model.provider)) {
          await agent.act('model', { modelId: old.state.model.id, provider: old.state.model.provider });
          if (agent.state.levels.includes(old.state.thinking)) await agent.act('thinking', { level: old.state.thinking });
        }
      }
    } catch {
      await Promise.all(replacements.map((a) => a.close()));
      // Never return a provider exception that might include the submitted credential.
      throw new Error('Provider reconnect failed. Original agents and overrides were retained; no key is displayed.');
    }
    this.keys = next;
    await this.replaceFleet(replacements, this.getCwd());
    return { ok: true };
  }
  async post(path, data) {
    switch (path) {
      case '/api/providers/configure': return this.configure(data);
      case '/api/workspace': return this.openWorkspace(data.path);
      case '/api/workspace/remember': await this.preferences.remember(await directory(data.path)); return { ok: true };
      case '/api/workspace/forget':
        if (typeof data.path !== 'string') throw new Error('Invalid bookmark');
        await this.preferences.forget(data.path); return { ok: true };
      case '/api/sessions/resume': {
        this.idle();
        const row = await this.store.get(data.key, this.sessions);
        if (!row.persisted) throw new Error('This session is active but not yet persisted; focus its current window instead.');
        if (row.archived) throw new Error('Restore the archived session before resuming it.');
        return this.openWorkspace(row.cwd, row.path, 'Main agent');
      }
      case '/api/sessions/rename': {
        this.idle();
        if (typeof data.name !== 'string' || !data.name.trim() || data.name.length > 200 || /[\r\n\0]/.test(data.name)) throw new Error('Enter a session name of 1–200 characters');
        const row = await this.store.get(data.key, this.sessions);
        const owner = [...this.sessions.values()].find((a) => a.state.connected && a.sessionFile === row.path);
        if (owner) await owner.act('rename', { name: data.name.trim() });
        else await this.store.rename(row, data.name.trim());
        return { ok: true };
      }
      case '/api/sessions/clone': this.idle(); await this.sessions.get('main').act('clone', {}); return { ok: true };
      case '/api/sessions/archive': {
        this.idle();
        if (typeof data.archived !== 'boolean') throw new Error('Archive state must be a boolean');
        const row = await this.store.get(data.key, this.sessions);
        if (row.active && data.archived) throw new Error('An active session cannot be archived');
        const next = this.preferences.archived.filter((key) => key !== row.key);
        if (data.archived) next.push(row.key);
        this.preferences.archived = next; await this.preferences.save(); return { ok: true };
      }
      default: return undefined;
    }
  }
}
