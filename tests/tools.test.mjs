import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { mkdtemp, mkdir, rm, readFile, writeFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createDesktop } from '../desktop/server.mjs';
import { PiSession } from '../desktop/pi-session.mjs';
import { DesktopControls } from '../desktop/controls.mjs';
import { createAgentState } from '../desktop/protocol.mjs';
import { READ_ONLY_TOOLS, validateToolSelection, toolCatalog, setSessionTools } from '../desktop/tools.mjs';
import { findPi } from '../scripts/pi-paths.mjs';
import { loadPi, sessionKey } from '../desktop/workspace.mjs';

const names = ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'];
const catalog = names.map((name) => ({ name, description: `Description of ${name}` }));
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const badTools = [null, {}, 'read', [null], [1], ['read', 'read'], ['../read'], ['READ'], ['bash;echo bad'], ['__proto__'], ['constructor'], ['unknown'], ['read', 'write\n'], Array(65).fill('read')];

function sdkFixture() {
  return { sessionId: 'session-1', isIdle: true, pendingMessageCount: 0, active: ['read'],
    getAllTools() { return [...catalog.map((tool) => ({ ...tool, parameters: {}, sourceInfo: { source: 'builtin', path: '/private' } })), { name: 'custom', sourceInfo: { source: 'sdk' } }]; },
    getActiveToolNames() { return [...this.active]; },
    setActiveToolsByName(tools) { this.active = [...tools]; },
  };
}

test('tools validation and SDK host checks reject malicious, stale, busy and queued inputs before mutation', () => {
  const session = sdkFixture();
  // The main catalog is whatever the session loaded, including SDK/extension tools.
  assert.deepEqual(toolCatalog(session, 'main').map((tool) => tool.name), [...catalog.map((tool) => tool.name), 'custom']);
  assert.ok(toolCatalog(session, 'main').every((tool) => Object.keys(tool).sort().join() === 'description,name'), 'no paths or schemas leak');
  assert.deepEqual(toolCatalog(session, 'subagent').map((tool) => tool.name).sort(), [...READ_ONLY_TOOLS].sort());
  for (const tools of badTools) assert.throws(() => setSessionTools(session, 'main', { tools, sessionId: session.sessionId }));
  for (const tools of [['bash'], ['write'], ['edit'], ['custom']]) assert.throws(() => setSessionTools(session, 'subagent', { tools, sessionId: session.sessionId }));
  assert.throws(() => setSessionTools(session, 'main', { tools: [], sessionId: 'old' }), /session changed/);
  session.isIdle = false;
  assert.throws(() => setSessionTools(session, 'main', { tools: [], sessionId: session.sessionId }), /idle/);
  session.isIdle = true; session.pendingMessageCount = 1;
  assert.throws(() => setSessionTools(session, 'main', { tools: [], sessionId: session.sessionId }), /queue/);
  assert.deepEqual(session.active, ['read']);
  session.pendingMessageCount = 0;
  assert.deepEqual(setSessionTools(session, 'main', { tools: [], sessionId: session.sessionId }), []);
  assert.deepEqual(setSessionTools(session, 'main', { tools: names, sessionId: session.sessionId }), names);
  assert.throws(() => validateToolSelection([], null, 'main'), /unavailable/);
});

class Fixture extends EventEmitter {
  constructor(options) {
    super(); this.options = options; this.calls = [];
    this.state = createAgentState(options.id, options.name, options.kind);
    Object.assign(this.state, { connected: true, phase: 'idle', cwd: options.cwd, sessionId: randomUUID(),
      slot: options.slot,
      availableTools: catalog.filter((tool) => options.kind === 'main' || READ_ONLY_TOOLS.includes(tool.name)),
      activeTools: options.tools ?? (options.kind === 'main' ? ['read', 'bash', 'edit', 'write'] : [...READ_ONLY_TOOLS]) });
    this.ready = Promise.resolve();
  }
  async act(action, data) {
    this.calls.push({ action, data, tools: [...this.state.activeTools] });
    if (action === 'tools') {
      if (this.block) await this.block.promise;
      this.state.activeTools = [...data.tools]; this.emit('change');
      return { availableTools: this.state.availableTools, activeTools: this.state.activeTools };
    }
    return {};
  }
  close() { this.state.connected = false; }
}

function client(app) {
  const base = app.url.split('/#')[0];
  return async (path, body, status = 200) => {
    const response = await fetch(base + path, { method: body ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${app.token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify({ requestId: randomUUID(), ...body }) : undefined });
    const data = await response.json(); assert.equal(response.status, status, JSON.stringify(data)); return data;
  };
}

test('tools API guards, serialized/idempotent acceptance, child validation before spawning or prompting', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-tools-api-')), created = [];
  const app = await createDesktop({ port: 0, cwd: root, dataDir: root, factory: (options) => { const agent = new Fixture(options); created.push(agent); return agent; } });
  const api = client(app), main = app.sessions.get('main');
  try {
    const contextId = (await api('/api/state')).contextId;
    for (const tools of badTools) {
      await api('/api/agents/main/tools', { tools }, 400);
      await api('/api/agents', { task: 'Never prompted', tools }, 400);
    }
    await api('/api/agents', { task: 'Never prompted', tools: ['bash'] }, 400);
    assert.equal(created.length, 1); assert.equal(main.calls.length, 0);
    await api('/api/agents/main/tools', { tools: [], contextId: 'old' }, 409);
    await api('/api/agents/main/tools', { tools: [], sessionId: 'old' }, 409);
    for (const phase of ['starting', 'running', 'retrying', 'compacting', 'stopped', 'error']) {
      main.state.phase = phase; await api('/api/agents/main/tools', { tools: [] }, 400);
    }
    main.state.phase = 'idle'; main.state.connected = false;
    await api('/api/agents/main/tools', { tools: [] }, 400); main.state.connected = true;
    for (const queue of ['steering', 'followUp']) {
      main.state.queue[queue] = ['waiting']; await api('/api/agents/main/tools', { tools: [] }, 400); main.state.queue[queue] = [];
    }
    const body = { requestId: randomUUID(), contextId, sessionId: main.state.sessionId, tools: [] };
    assert.deepEqual((await api('/api/agents/main/tools', body)).activeTools, []);
    await api('/api/agents/main/tools', body); assert.equal(main.calls.length, 1);
    await api('/api/agents/main/tools', { ...body, tools: ['read'] }, 409);
    main.block = deferred();
    const pending = api('/api/agents/main/tools', { tools: ['read'] });
    while (main.calls.length < 2) await new Promise((r) => setTimeout(r, 5));
    await api('/api/agents/main/prompt', { message: 'Must not race' }, 409);
    await api('/api/workspace', { path: root }, 409);
    main.block.resolve(); await pending;
    const child = await api('/api/agents', { task: 'Fake only', tools: [] });
    assert.deepEqual(created.at(-1).options.tools, []);
    assert.deepEqual(created.at(-1).calls.find((call) => call.action === 'prompt').tools, []);
    await api(`/api/agents/${child.id}/tools`, { tools: ['write'] }, 400);
    await api(`/api/agents/${child.id}/tools`, { tools: ['read', 'find'] });
    await api('/api/agents', { task: 'Default fake' });
    assert.deepEqual(created.at(-1).state.activeTools, READ_ONLY_TOOLS);
    assert.deepEqual((await api('/api/state')).agents[0].activeTools, ['read']);
  } finally { main.block?.resolve(); await app.close(); await rm(root, { recursive: true, force: true }); }
});

test('candidate/workspace/provider replacements carry empty and subset selections without broadening', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-tools-controls-'));
  const main = new Fixture({ id: 'main', name: 'Main', kind: 'main', cwd: root, tools: [] });
  const sub = new Fixture({ id: 'sub', name: 'Sub / 02', kind: 'subagent', slot: 2, cwd: root, tools: ['find'] });
  const sessions = new Map([['main', main], ['sub', sub]]), candidates = [];
  const controls = new DesktopControls({ dataDir: root, sessions, getCwd: () => root,
    makeSession: (options) => { const agent = new Fixture(options); candidates.push(agent); return agent; },
    replaceFleet: async (agents) => { sessions.clear(); for (const agent of agents) sessions.set(agent.state.id, agent); },
  });
  controls.registryPromise = Promise.resolve({ getProviders: () => [{ id: 'fake', auth: { apiKey: {} } }] });
  try {
    await controls.initialize();
    await controls.configure({ provider: 'fake', apiKey: 'fake-key' });
    assert.deepEqual(candidates.map((agent) => agent.options.tools), [[], ['find']]);
    assert.equal(candidates[1].state.slot, 2, 'provider replacement preserves the surviving display slot');
    assert.equal(candidates[1].state.name, 'Sub / 02');
    await controls.openWorkspace(root);
    assert.deepEqual(candidates.at(-1).options.tools, []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('private bridge correlates responses, ignores stale metadata, times out and rejects pending work on exit', async () => {
  const agent = Object.create(PiSession.prototype);
  Object.assign(agent, { state: createAgentState('main', 'Main', 'main'), toolPending: new Map(), toolRevision: 3, metadataGeneration: 0,
    secrets: [], child: { connected: true, send(message) { this.last = message; } }, emit() {} });
  agent.state.sessionId = 'new'; agent.state.activeTools = [];
  agent.captureTools({ sessionId: 'new', revision: 2, activeTools: ['bash'] });
  agent.captureTools({ sessionId: 'old', revision: 99, activeTools: ['bash'] });
  assert.deepEqual(agent.state.activeTools, []);
  const pending = agent.toolCommand('get');
  agent.receiveTools({ type: 'response', id: agent.child.last.id, success: true });
  assert.equal(agent.toolPending.size, 1);
  agent.receiveTools({ type: 'desktop_tools_response', id: agent.child.last.id, success: true, data: { answer: 1 } });
  assert.deepEqual(await pending, { answer: 1 });
  await assert.rejects(agent.toolCommand('set', {}, 5), /timed out/);
  assert.equal(agent.state.activeTools, null); assert.throws(() => agent.selectionForReplacement(), /unavailable/);
  agent.state.activeTools = ['read'];
  const exited = agent.toolCommand('set'); agent.rejectToolRequests('Pi process exited');
  await assert.rejects(exited, /process exited/); assert.equal(agent.toolPending.size, 0);
  assert.equal(agent.state.activeTools, null);
  agent.child.connected = false; await assert.rejects(agent.toolCommand('get'), /not connected/);
});

test('a delayed metadata refresh cannot restore the previous session or tool selection', async () => {
  const delayed = deferred(), agent = Object.create(PiSession.prototype);
  Object.assign(agent, { state: createAgentState('main', 'Main', 'main'), metadataGeneration: 0, toolRevision: 1, emit() {},
    command: async (type) => type === 'get_state' ? { sessionId: 'old' } : {},
    toolCommand: () => delayed.promise,
  });
  agent.state.sessionId = 'old';
  const pending = agent.refresh();
  agent.metadataGeneration++; agent.state.sessionId = 'new'; agent.toolRevision = 2; agent.state.activeTools = [];
  delayed.resolve({ sessionId: 'old', revision: 1, availableTools: catalog, activeTools: ['bash'] });
  await pending;
  assert.equal(agent.state.sessionId, 'new'); assert.deepEqual(agent.state.activeTools, []);
});

test('real installed Pi tools: none/all/subset, runtime new/clone, resume/workspace/reconnect and child ceiling without prompts', { timeout: 90_000 }, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pi-tools-real-')));
  const project = join(root, 'project'), other = join(root, 'other'), profile = join(root, 'profile'), dataDir = join(root, 'data'), sessionDir = join(dataDir, 'desktop-sessions');
  for (const path of [project, other, profile, sessionDir]) await mkdir(path, { recursive: true });
  const previousProfile = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = profile;
  const env = { PATH: process.env.PATH, HOME: root, PI_CODING_AGENT_DIR: profile, PI_OFFLINE: '1' };
  let app, child;
  try {
    const host = findPi(), pi = await loadPi(host);
    const seed = pi.SessionManager.create(project, sessionDir);
    seed.appendSessionInfo('Stored fixture');
    seed.appendThinkingLevelChange('off');
    seed.appendMessage({ role: 'user', content: 'Stored, never prompted', timestamp: 1 });
    seed.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'Stored answer' }], api: 'anthropic-messages', provider: 'anthropic', model: 'claude-sonnet-4-5', timestamp: 2, stopReason: 'stop', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
    const seedPath = seed.getSessionFile(), seedBytes = await readFile(seedPath, 'utf8');
    await writeFile(join(profile, 'settings.json'), JSON.stringify({ compaction: { enabled: false } }));
    const settingsBefore = await readFile(join(profile, 'settings.json'), 'utf8');
    app = await createDesktop({ port: 0, cwd: project, host, dataDir, factory: (options) => new PiSession({ ...options, env }) });
    const api = client(app); let main = app.sessions.get('main'); await main.ready;
    const authBefore = await readFile(join(profile, 'auth.json'), 'utf8');
    assert.deepEqual([...main.state.activeTools].sort(), ['bash', 'edit', 'read', 'write']);
    assert.ok(main.state.availableTools.length >= 7);
    assert.ok(main.state.availableTools.every((tool) => Object.keys(tool).sort().join() === 'description,name'));
    assert.equal(main.child.stdio[3] !== null, true); assert.equal(main.child.connected, true);
    await api('/api/agents/main/tools', { tools: [] });
    assert.deepEqual((await main.toolCommand('get')).activeTools, []);
    await api('/api/agents/main/new', {}); assert.deepEqual(main.state.activeTools, []);
    const all = main.state.availableTools.map((tool) => tool.name);
    await api('/api/agents/main/tools', { tools: all }); assert.deepEqual((await main.toolCommand('get')).activeTools, all);
    await api('/api/agents/main/tools', { tools: ['read', 'find'] });
    await api('/api/sessions/resume', { key: sessionKey(seedPath) }); main = app.sessions.get('main');
    assert.deepEqual(main.state.activeTools, ['read', 'find']);
    const beforeApply = await readFile(main.sessionFile, 'utf8');
    await api('/api/agents/main/tools', { tools: [] });
    assert.equal(await readFile(main.sessionFile, 'utf8'), beforeApply, 'tool change must not append session entries');
    await api('/api/sessions/clone', {}); assert.deepEqual(main.state.activeTools, []);
    assert.equal(main.state.messages.length, 2);
    await api('/api/workspace', { path: other }); main = app.sessions.get('main'); assert.deepEqual(main.state.activeTools, []);
    await api('/api/providers/configure', { provider: 'deepseek', apiKey: 'fake-key-not-sent' });
    main = app.sessions.get('main'); assert.deepEqual(main.state.activeTools, []);
    await api('/api/providers/configure', { provider: 'deepseek', remove: true });
    main = app.sessions.get('main'); assert.deepEqual(main.state.activeTools, []);
    assert.equal(await readFile(seedPath, 'utf8'), seedBytes);
    assert.equal(await readFile(join(profile, 'settings.json'), 'utf8'), settingsBefore);
    assert.equal(await readFile(join(profile, 'auth.json'), 'utf8'), authBefore);
    const revision = main.toolRevision;
    for (const tools of badTools) await assert.rejects(main.toolCommand('set', { tools, sessionId: main.state.sessionId, revision }));
    assert.deepEqual((await main.toolCommand('get')).activeTools, []);
    await assert.rejects(main.toolCommand('set', { tools: ['read'], sessionId: 'old', revision }), /session changed/);
    await assert.rejects(main.toolCommand('set', { tools: ['read'], sessionId: main.state.sessionId, revision: revision - 1 }), /state changed/);
    await main.command('follow_up', { message: 'Queued only; never run' });
    await assert.rejects(main.toolCommand('set', { tools: ['read'], sessionId: main.state.sessionId, revision }), /empty queue/);
    await main.command('clear_queue');
    child = new PiSession({ id: 'child', name: 'Child', kind: 'subagent', cwd: project, host, sessionDir, env, tools: [] }); await child.ready;
    assert.deepEqual(child.state.activeTools, []);
    assert.deepEqual(child.state.availableTools.map((tool) => tool.name).sort(), [...READ_ONLY_TOOLS].sort());
    await assert.rejects(child.toolCommand('set', { tools: ['bash'], sessionId: child.state.sessionId, revision: child.toolRevision }), /Subagents/);
    await child.act('tools', { tools: ['grep'] }); await child.act('new', {}); assert.deepEqual(child.state.activeTools, ['grep']);
    // A queued IPC request must settle when the actual child exits, not leak its timeout.
    child.child.kill('SIGSTOP');
    const pending = child.toolCommand('get'); const rejected = assert.rejects(pending, /exited|disconnected/);
    child.child.kill('SIGKILL'); await rejected; await child.exited;
    assert.equal(child.state.connected, false); assert.equal(child.toolPending.size, 0);
    const exited = once(main.child, 'exit'); await main.close(); await exited;
  } finally {
    await child?.close(); await app?.close();
    if (previousProfile === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousProfile;
    await rm(root, { recursive: true, force: true });
  }
});
