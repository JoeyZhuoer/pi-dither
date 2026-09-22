import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { mkdtemp, mkdir, readFile, rm, realpath } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { DelegationProjection, sanitizeDelegations, DELEGATION_LIMITS } from '../desktop/delegations.mjs';
import { DelegationBridge, findInspectCommand } from '../desktop/delegation-bridge.mjs';
import { PiSession } from '../desktop/pi-session.mjs';
import { AgentReducer, createAgentState } from '../desktop/protocol.mjs';
import { findPi } from '../scripts/pi-paths.mjs';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const snapshot = (runs = []) => ({ kind: 'pi-subagents.async-status-snapshot', version: 1, generatedAt: 10, omitted: {}, runs });
const node = (id, state = 'running', children) => ({ id, kind: 'subagent', label: id, state, ...(children ? { children } : {}) });
const workflow = () => snapshot([{ ...node('flow', 'running', [
  { id: 'check', kind: 'host-step', state: 'running', label: 'CI, not an agent' },
  { ...node('one'), kind: 'step', activity: { currentTool: 'read' } },
  { ...node('two'), kind: 'step' },
]), kind: 'workflow' }]);
const update = (results, end = false, runId = 'run') => ({ type: end ? 'tool_execution_end' : 'tool_execution_update', toolName: 'subagent', toolCallId: 'call',
  [end ? 'result' : 'partialResult']: { details: { runId, mode: 'single', results } } });
const result = (index, output, status = 'running') => ({ index, agent: 'reviewer', task: 'Review task', exitCode: 0,
  progress: { status, recentOutput: [output] } });
const replyFor = (row, extra = {}) => ({ kind: 'pi-subagents.inspect-reply', version: 1, asyncId: row.runId, childId: row.childId, ...extra });
function busFixture(handler) {
  const emitter = new EventEmitter(), requests = [];
  const events = { on(name, fn) { emitter.on(name, fn); return () => emitter.off(name, fn); }, emit(name, value) { emitter.emit(name, value); } };
  events.on('subagents:rpc:v1:request', (request) => { requests.push(request); handler?.(request, (data) => events.emit('subagents:rpc:v1:reply:' + request.requestId,
    { version: 1, requestId: request.requestId, success: true, data })); });
  return { events, requests, emitter };
}
const ping = { capabilities: { statusProjection: { version: 1 } } };

test('foreground cumulative output replaces, stable numeric child identities survive reordered results, no settled-parent completion', () => {
  const p = new DelegationProjection('session');
  p.foreground(update([result(3, 'A'), result(8, 'B')]));
  const first = p.snapshot().delegations, ids = first.map((r) => r.id);
  assert.equal(first[0].phase, 'output');
  p.foreground(update([result(8, 'B plus'), result(3, 'A plus')]));
  assert.deepEqual(p.snapshot().delegations.map((r) => r.id), ids);
  assert.deepEqual(p.snapshot().delegations.map((r) => r.messages[0].text), ['A plus', 'B plus']);
  p.foreground({ type: 'agent_settled' });
  assert.ok(p.snapshot().delegations.every((r) => r.status === 'running'));
  p.foreground(update([{ ...result(3, 'ignored'), finalOutput: 'Answer', messages: [{ role: 'assistant', content: [{ type: 'thinking', thinking: 'never display' }, { type: 'text', text: 'Answer' }] }] },
    { ...result(8, ''), exitCode: 1, error: 'Child failed' }], true));
  assert.equal(p.snapshot().delegations[0].status, 'complete');
  assert.equal(p.snapshot().delegations[0].finalOutput, 'Answer');
  assert.equal(p.snapshot().delegations[1].status, 'failed');
  assert.equal(JSON.stringify(p.snapshot()).includes('never display'), false);
  const replacement = new DelegationProjection('different-session'); replacement.foreground(update([result(3, 'new')]));
  assert.notEqual(replacement.snapshot().delegations[0].id, ids[0]);
});

test('foreground unknown, pause, detach, tool failure and nonlaunch results are truthful', () => {
  const p = new DelegationProjection('s');
  p.foreground(update([{ index: 1, agent: 'worker', exitCode: 0 }]));
  assert.equal(p.snapshot().delegations[0].status, 'unknown', 'partial exitCode=0 is not success');
  p.foreground({ type: 'tool_execution_end', toolName: 'subagent', toolCallId: 'call', isError: true });
  assert.equal(p.snapshot().delegations[0].status, 'failed');
  p.foreground(update([{ ...result(2, ''), interrupted: true }, { ...result(3, ''), detached: true }], true));
  assert.deepEqual(p.snapshot().delegations.slice(1).map((r) => r.status), ['paused', 'unknown']);
  const before = p.rows.size;
  for (const details of [{ runId: 'management', mode: 'management', results: [result(0, '')] }, { runId: 'async', asyncId: 'async', results: [result(0, '')] }]) {
    p.foreground({ type: 'tool_execution_end', toolName: 'subagent', result: { details } });
  }
  assert.equal(p.rows.size, before);
});

test('async workflows exclude host steps, preserve multi-child and nested identity, replace inspect content, retain missing status as unknown', () => {
  const p = new DelegationProjection('s'); assert.equal(p.asyncSnapshot(workflow()), true);
  const [one, two] = p.snapshot().delegations;
  assert.equal(p.rows.size, 2); assert.equal(one.phase, 'tool'); assert.equal(two.phase, 'unknown');
  assert.notEqual(one.id, two.id);
  p.inspect(two.id, replyFor(two, { status: 'complete', task: 'Owned task', messages: [{ role: 'assistant', kind: 'text', text: 'first' }] }));
  assert.equal(p.rows.get(two.id).status, 'running', 'inspect run status must not overwrite child status');
  assert.equal(p.rows.get(two.id).phase, 'output');
  p.inspect(two.id, replyFor(two, { messages: [{ role: 'assistant', kind: 'text', text: 'replacement' }], finalOutput: 'Final' }));
  assert.deepEqual(p.rows.get(two.id).messages.map((m) => m.text), ['replacement']);
  assert.equal(p.rows.get(two.id).finalOutput, 'Final');
  assert.equal(p.inspect(two.id, { ...replyFor(two), asyncId: 'foreign' }), false);
  assert.equal(p.inspect(two.id, { ...replyFor(two), version: 2 }), false);
  p.inspect(two.id, replyFor(two, { error: { code: 'foreign_session', message: '/private/artifact secret' } }));
  assert.match(p.rows.get(two.id).error, /foreign_session/);
  assert.equal(p.rows.get(two.id).error.includes('/private'), false);
  p.asyncSnapshot(snapshot()); assert.equal(p.rows.get(one.id).status, 'unknown');
  p.asyncSnapshot(snapshot([node('outer', 'running', [{ ...node('step:0', 'running', [node('nested', 'running', [{ ...node('step:0'), kind: 'step' }])]), kind: 'step' }])]));
  assert.ok([...p.rows.values()].some((r) => r.runId === 'nested' && r.childId === 'step:0'));
});

test('version failure, hostile inputs, payload bounds, allowlisted fields and boundary secret redaction', () => {
  const p = new DelegationProjection('s');
  assert.equal(p.asyncSnapshot({ version: 7, runs: [] }), false); assert.equal(p.snapshot().delegationStatus.available, false);
  p.foreground(update(Array.from({ length: 100 }, (_, i) => ({ ...result(i, 'X'.repeat(20_000)), task: 'Y'.repeat(20_000), finalOutput: 'Z'.repeat(30_000),
    messages: Array.from({ length: 100 }, () => ({ role: 'assistant', content: 'Q'.repeat(3000) })) }))));
  const data = p.snapshot();
  assert.ok(data.delegations.length <= DELEGATION_LIMITS.rows); assert.ok(data.delegationStatus.omitted > 0);
  assert.ok(Buffer.byteLength(JSON.stringify(data.delegations)) < DELEGATION_LIMITS.bytes + 100);
  const clean = sanitizeDelegations([{ ...data.delegations[0], task: 'temporary-secret', raw: { apiKey: 'temporary-secret' },
    messages: [{ id: 'id', role: 'assistant', text: '\u001b[31mtemporary-secret\u0000', artifactPath: '/private' }], finalOutput: 'temporary-secret' }], (s) => s.replaceAll('temporary-secret', '[redacted]'));
  assert.equal(JSON.stringify(clean).includes('temporary-secret'), false); assert.equal(JSON.stringify(clean).includes('/private'), false);
  assert.equal(clean.rows[0].messages[0].text, '[redacted]');
  const host = new DelegationProjection('s', (s) => s.replaceAll('temporary-secret', '[redacted]'));
  host.foreground(update([{ ...result(0, ''), messages: [{ role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(7990) + 'temporary-secret' }] }] }]));
  assert.equal(JSON.stringify(host.snapshot()).includes('temporary'), false, 'redact before host clipping');
});

test('bridge discovers only via bus, executes allowlisted read-only inspect handlers, bounds work and disposes timers/listeners', { timeout: 5000 }, async (t) => {
  const { events, requests, emitter } = busFixture((request, reply) => reply(request.method === 'ping' ? ping : { asyncSnapshot: workflow() }));
  const publishes = [], inspections = [];
  let active = 0, maximum = 0, observed, deadline;
  const fourInspections = new Promise((resolve, reject) => {
    observed = resolve;
    // The production poll timer is intentionally unref'd. Keep this fixture alive
    // until its evidence arrives, rather than assuming two cycles fit in 35 ms.
    deadline = setTimeout(() => reject(new Error('Four inspect replies did not arrive')), 4000);
  });
  const bridge = new DelegationBridge({ sessionId: 's', generation: 1, events, publish: (s) => { publishes.push(s); if (inspections.length >= 4) observed(); }, interval: 20,
    context: { prompt() { assert.fail('no model prompts'); }, sendMessage() { assert.fail('no conversation mutations'); } },
    inspectCommand: { async handler(args, ctx) {
      active++; maximum = Math.max(active, maximum); await sleep(2);
      inspections.push(args); const [requestId, asyncId, childId] = args.split(' ');
      ctx.ui.setWidget('subagent-inspect', ['PI_SUBAGENT_INSPECT_JSON:' + JSON.stringify({ kind: 'pi-subagents.inspect-reply', version: 1,
        requestId, asyncId, childId, messages: [{ role: 'assistant', kind: 'text', text: 'inspection ' + inspections.length }] })]);
      ctx.ui.setWidget('subagent-inspect', undefined); active--;
    } } });
  t.after(() => { clearTimeout(deadline); bridge.dispose(); });
  await bridge.start(); await fourInspections; clearTimeout(deadline); bridge.dispose();
  assert.equal(maximum, 1); assert.ok(inspections.length >= 4); assert.ok(requests.every((r) => ['ping', 'status'].includes(r.method)));
  assert.ok(inspections.every((s) => s.endsWith('--lines 40'))); assert.ok(publishes.at(-1).delegations[0].messages[0].text.startsWith('inspection'));
  const count = requests.length, sent = publishes.length; await sleep(35);
  assert.equal(requests.length, count); assert.equal(publishes.length, sent); assert.equal(bridge.pending.size, 0);
  assert.deepEqual(emitter.eventNames(), ['subagents:rpc:v1:request']);
  bridge.dispose();
  assert.equal(findInspectCommand([{ path: '/ambient', commands: new Map([['subagents-inspect-rpc', { handler() {} }]]) }], ['/installed']), null);
  assert.ok(findInspectCommand([{ path: '/home/user/.pi/agent/npm/node_modules/pi-subagents/src/extension/index.ts', commands: new Map([['subagents-inspect-rpc', { handler() {} }]]) }], []), 'a profile-discovered pi-subagents package is matched');
});

test('bridge timeout is nonfatal, stops reissuing in-flight work, rejects stale replies and session replacement', async () => {
  let late; const { events, requests, emitter } = busFixture((request, reply) => { if (request.method === 'ping') reply(ping); else late = reply; });
  const updates = [], bridge = new DelegationBridge({ sessionId: 'old', generation: 1, events, publish: (s) => updates.push(s), timeout: 8, interval: 3 });
  await bridge.start(); assert.equal(updates.at(-1).delegationStatus.available, false);
  late({ asyncSnapshot: workflow() }); await sleep(15); assert.equal(requests.length, 2); assert.equal(bridge.rows?.size ?? bridge.projection.rows.size, 0);
  assert.deepEqual(emitter.eventNames(), ['subagents:rpc:v1:request']); bridge.dispose();
  const next = new DelegationBridge({ sessionId: 'new', generation: 2, events, publish: (s) => updates.push(s), timeout: 100 });
  const started = next.start(); await sleep(1); next.dispose(); await started;
  const count = updates.length; late({ asyncSnapshot: workflow() }); await sleep(1); assert.equal(updates.length, count);
  assert.equal(next.pending.size, 0);
});

test('delayed inspect after disposal cannot publish into replacement, and display-channel failure is nonfatal', async () => {
  const { events } = busFixture((request, reply) => reply(request.method === 'ping' ? ping : { asyncSnapshot: workflow() }));
  let release, invoked;
  const entered = new Promise((resolve) => { invoked = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const updates = [];
  const bridge = new DelegationBridge({ sessionId: 'old', generation: 1, events, timeout: 1000, publish: (s) => updates.push(s),
    inspectCommand: { async handler(args, ctx) {
      invoked(); await gate; const [requestId, asyncId, childId] = args.split(' ');
      ctx.ui.setWidget('subagent-inspect', ['PI_SUBAGENT_INSPECT_JSON:' + JSON.stringify({ kind: 'pi-subagents.inspect-reply', version: 1,
        requestId, asyncId, childId, finalOutput: 'stale output' })]);
    } } });
  const start = bridge.start(); await entered; bridge.dispose(); await start;
  const count = updates.length; release(); await sleep(2);
  assert.equal(updates.length, count); assert.equal(bridge.pending.size, 0); assert.equal(bridge.projection.rows.size, 0);
  const broken = new DelegationBridge({ sessionId: 'new', generation: 2, events, publish() { throw new Error('closed IPC'); } });
  await broken.start(); broken.dispose();
});

test('private snapshots are session/generation correlated, sanitized at server boundary, reset on replacement/disconnect; manual agents excluded', () => {
  const state = createAgentState('main', 'Main', 'main'); state.sessionId = 'old';
  const agent = Object.create(PiSession.prototype); Object.assign(agent, { state, secrets: ['key'], emit() {} });
  const p = new DelegationProjection('old'); p.foreground(update([result(0, 'key')]));
  const envelope = { type: 'desktop_delegations', sessionId: 'old', generation: 1, sequence: 1, ...p.snapshot() };
  agent.receiveDelegations(envelope); assert.equal(state.delegations[0].messages[0].text, '[redacted]');
  agent.receiveDelegations({ ...envelope, sessionId: 'new', generation: 2 });
  agent.receiveDelegations({ ...envelope, sequence: 999 });
  assert.equal(agent.delegationSnapshot.sessionId, 'new');
  agent.capture({ sessionId: 'new' }, {}); assert.equal(state.delegations.length, 1);
  agent.capture({ sessionId: 'third' }, {}); assert.deepEqual(state.delegations, []); assert.equal(state.activityMode, 'idle');
  agent.receiveDelegations({ ...envelope, sessionId: 'third', generation: 3 }); agent.disconnectDelegations();
  assert.equal(state.delegations[0].status, 'unknown'); assert.equal(state.delegationStatus.available, false);
  state.kind = 'subagent'; state.delegations = []; agent.receiveDelegations({ ...envelope, generation: 4 }); assert.deepEqual(state.delegations, []);
  assert.equal('delegations' in createAgentState('child', 'Child', 'subagent'), false);
});

test('activityMode follows thinking/text/tool events without reasoning contents and resets on hydrate/settlement/failure', () => {
  const state = createAgentState('main', 'Main', 'main'), reducer = new AgentReducer(state);
  reducer.apply({ type: 'agent_start' }); assert.equal(state.activityMode, 'idle');
  reducer.apply({ type: 'message_update', assistantMessageEvent: { type: 'thinking_start', contentIndex: 0 } }); assert.equal(state.activityMode, 'thinking');
  reducer.apply({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 1, delta: 'Visible' } }); assert.equal(state.activityMode, 'output');
  reducer.apply({ type: 'tool_execution_start', toolCallId: 'a', toolName: 'read', args: {} }); assert.equal(state.activityMode, 'tool');
  reducer.apply({ type: 'tool_execution_start', toolCallId: 'b', toolName: 'grep', args: {} });
  reducer.apply({ type: 'tool_execution_end', toolCallId: 'a', toolName: 'read', result: { content: [] } }); assert.equal(state.activityMode, 'tool');
  reducer.apply({ type: 'agent_end' }); assert.equal(state.activityMode, 'tool');
  reducer.apply({ type: 'agent_settled' }); assert.equal(state.activityMode, 'idle');
  reducer.apply({ type: 'compaction_start' }); assert.equal(state.activityMode, 'tool');
  reducer.hydrate([]); assert.equal(state.activityMode, 'idle');
  state.activityMode = 'output'; reducer.reset(); assert.equal(state.activityMode, 'idle');
  const agent = Object.create(PiSession.prototype); Object.assign(agent, { state, secrets: [], emit() {} }); state.activityMode = 'thinking'; agent.fail('failed'); assert.equal(state.activityMode, 'idle');
});

const installedRoot = process.env.PI_DESKTOP_SUBAGENTS_ROOT || join(homedir(), '.pi/agent/npm/node_modules/pi-subagents');
const installed = await readFile(join(installedRoot, 'package.json'), 'utf8').then(() => true, () => false);
test('installed package no-prompt RPC telemetry probe and empty tool selection across runtime new', { skip: !installed, timeout: 30_000 }, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pi-delegations-probe-'))), profile = join(root, 'profile'), sessionDir = join(root, 'sessions');
  await mkdir(profile); await mkdir(sessionDir); let agent;
  try {
    agent = new PiSession({ id: 'main', name: 'Read-only telemetry probe', kind: 'main', cwd: root, host: findPi(), sessionDir, tools: [],
      env: { PATH: process.env.PATH, HOME: root, PI_CODING_AGENT_DIR: profile, PI_OFFLINE: '1', PI_DESKTOP_SUBAGENTS_ROOT: installedRoot } });
    await agent.ready;
    const waitAvailable = async () => { for (let i = 0; i < 100 && !agent.state.delegationStatus.available; i++) await sleep(30); assert.equal(agent.state.delegationStatus.available, true, agent.state.delegationStatus.message); };
    await waitAvailable();
    assert.deepEqual(agent.state.delegations, []); assert.deepEqual(agent.state.activeTools, []); assert.equal(agent.state.messages.length, 0);
    const before = await agent.command('get_messages'); const old = agent.state.sessionId;
    await sleep(1700); assert.deepEqual(await agent.command('get_messages'), before, 'polls do not enter conversation');
    await agent.act('new', {}); assert.notEqual(agent.state.sessionId, old); await waitAvailable();
    assert.deepEqual(agent.state.activeTools, []); assert.deepEqual(agent.state.delegations, []); assert.equal(agent.state.messages.length, 0);
    assert.equal(agent.delegationSnapshot.sessionId, agent.state.sessionId); assert.ok(agent.delegationSnapshot.generation >= 2);
    // Exercise the installed command handler itself (unknown id, no launch or
    // prompt), with a public SDK in-memory session and only isolated profile I/O.
    const program = `
      import assert from 'node:assert/strict';
      import {DelegationBridge, findInspectCommand} from ${JSON.stringify(new URL('../desktop/delegation-bridge.mjs', import.meta.url).href)};
      const pi = await import(${JSON.stringify(pathToFileURL(join(findPi().root, 'dist/index.js')).href)});
      const modelRuntime = await pi.ModelRuntime.create({allowModelNetwork:false});
      let api, context;
      const services = await pi.createAgentSessionServices({cwd:process.cwd(),modelRuntime,
        settingsManager:pi.SettingsManager.inMemory({compaction:{enabled:false}}),resourceLoaderOptions:{noExtensions:true,
        additionalExtensionPaths:[${JSON.stringify(installedRoot)}],extensionFactories:[{name:'read-only-probe',factory(p){api=p;p.on('session_start',(_e,ctx)=>{context=ctx;});}}]}});
      const {session} = await pi.createAgentSessionFromServices({services,sessionManager:pi.SessionManager.inMemory()});
      let bridge;
      try {
        await session.bindExtensions({mode:'rpc'});
        const loaded=services.resourceLoader.getExtensions().extensions;
        const command=findInspectCommand(loaded,loaded.filter(e=>e.commands.has('subagents-inspect-rpc')).map(e=>e.path));
        assert.ok(command);
        bridge=new DelegationBridge({sessionId:session.sessionId,generation:1,events:api.events,context,inspectCommand:command,publish(){}});
        bridge.projection.asyncSnapshot({kind:'pi-subagents.async-status-snapshot',version:1,runs:[{id:'desktop-nonexistent-probe',kind:'subagent',label:'probe',state:'unknown'}]});
        const row=[...bridge.projection.rows.values()][0];
        await bridge.inspect(row);
        assert.match(bridge.projection.rows.get(row.id).error,/not_found/);
        assert.equal(session.messages.length,0);
        console.log('PASS installed read-only inspect handler; no model prompt');
      } finally {bridge?.dispose();session.dispose();}
    `;
    const probe = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', program], { cwd: root,
      env: { PATH: process.env.PATH, HOME: root, PI_CODING_AGENT_DIR: profile, PI_OFFLINE: '1' }, timeout: 15_000 });
    assert.match(probe.stdout, /PASS installed read-only inspect/);
  } finally { await agent?.close(); await rm(root, { recursive: true, force: true }); }
});
