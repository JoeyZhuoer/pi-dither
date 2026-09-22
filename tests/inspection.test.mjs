import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyInspection, normalizeInspection, argumentSummary, resultInspection, snapshotInspection, INSPECTION_LIMITS } from '../desktop/inspection.mjs';
import { AgentReducer, createAgentState } from '../desktop/protocol.mjs';
import { DelegationProjection, DELEGATION_LIMITS } from '../desktop/delegations.mjs';
import { PiSession } from '../desktop/pi-session.mjs';

const redact = (text) => text.replaceAll('known-secret-value', '[redacted]');
const snapshot = (nodes, generatedAt = 100) => ({ kind: 'pi-subagents.async-status-snapshot', version: 1, generatedAt, runs: nodes });
const asyncNode = (state = 'running', extra = {}) => ({ id: 'async', kind: 'subagent', state, label: 'Worker', ...extra });
const foreground = (results, end = false, extra = {}) => ({ type: end ? 'tool_execution_end' : 'tool_execution_update', toolName: 'subagent', toolCallId: 'call',
  [end ? 'result' : 'partialResult']: { details: { runId: 'run', results, ...extra } } });
const toolMessages = (isError = false) => [
  { role: 'assistant', content: [{ type: 'thinking', thinking: 'HIDDEN' }, { type: 'toolCall', id: 'write-id', name: 'write', arguments: { path: 'src/owned.ts', content: 'HIDDEN', password: 'raw-password', apiKey: 'known-secret-value' } }] },
  { role: 'toolResult', toolCallId: 'write-id', toolName: 'write', isError, content: [{ type: 'text', text: 'tool output stays in transcript' }] },
];
const start = (id, path, name = 'write') => ({ type: 'tool_execution_start', toolCallId: id, toolName: name, args: { path, token: 'PRIVATE-TOKEN' } });
const end = (id, isError = false) => ({ type: 'tool_execution_end', toolCallId: id, toolName: 'write', isError, result: { content: [] } });

test('inspection v1 defaults and numeric validation preserve unavailable vs reported zero', () => {
  assert.deepEqual(normalizeInspection({ version: 2 }), emptyInspection());
  const value = emptyInspection();
  Object.assign(value.usage, { inputTokens: 0, outputTokens: -1, cacheReadTokens: Infinity, cacheWriteTokens: 1.5, totalTokens: '0', costUsd: 0 });
  value.tools.total = Number.MAX_SAFE_INTEGER + 1;
  value.timing = { startedAt: 40, endedAt: 20, durationMs: NaN, live: true };
  const dto = normalizeInspection(value);
  assert.equal(dto.usage.inputTokens, 0); assert.equal(dto.usage.costUsd, 0);
  for (const field of ['outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'totalTokens']) assert.equal(dto.usage[field], null);
  assert.equal(dto.tools.total, null); assert.equal(dto.timing.endedAt, null); assert.equal(dto.timing.durationMs, null);
  assert.equal(dto.usage.scope, 'child'); assert.equal(dto.timing.scope, 'run');
  value.timing = { startedAt: '2026-01-01T00:00:00Z', endedAt: '2026-01-01T00:00:01Z', durationMs: 1000, live: true };
  assert.deepEqual(normalizeInspection(value).timing, { startedAt: null, endedAt: null, durationMs: 1000, scope: 'run', live: false }, 'timing accepts epoch-millisecond numbers, never ISO strings');
  for (const bad of [null, [], '', 5, { version: 1, tools: { items: [null, {}, 7] }, files: { items: [null, {}, 7] } }]) assert.doesNotThrow(() => normalizeInspection(bad));
});

test('redaction precedes clipping and credential argument fields are removed recursively', () => {
  const summary = argumentSummary({ headers: { Authorization: 'Basic opaque-auth' }, nested: { token: 'raw-token', client_secret: 'raw-client', password: 'raw-password' },
    content: 'PRIVATE CONTENT', thinking: 'PRIVATE REASONING', artifacts: { path: 'PRIVATE ARTIFACT' }, path: 'safe.ts', query: 'x'.repeat(595) + 'known-secret-value' }, redact);
  for (const secret of ['opaque-auth', 'raw-token', 'raw-client', 'raw-password', 'PRIVATE', 'known-secret']) assert.equal(summary.includes(secret), false, secret);
  const dto = emptyInspection(); dto.prompt.text = 'x'.repeat(7990) + 'known-secret-value';
  dto.tools = { availability: 'partial', total: 1, omitted: 0, items: [{ id: 'id', name: 'bash', status: 'unknown', summary: 'password="raw-password" api_key=opaque-key Authorization: Bearer raw-bearer' }] };
  dto.files.items = [{ path: 'known-secret-value', evidence: 'reported', action: 'changed' }];
  const text = JSON.stringify(normalizeInspection(dto, redact));
  for (const secret of ['known-secret', 'raw-password', 'opaque-key', 'raw-bearer']) assert.equal(text.includes(secret), false, secret);
});

test('inspection byte budget handles multibyte/escaped text, bounded fields, overflow and safe omission counts', () => {
  const dto = emptyInspection(); dto.prompt.text = '\u2028😀"'.repeat(8000);
  dto.tools = { availability: 'complete', total: 300, omitted: Number.MAX_SAFE_INTEGER, items: Array.from({ length: 300 }, (_, i) => ({ id: `id${i}` + 'x'.repeat(400), name: 'tool', status: 'done', summary: '\u2028😀"'.repeat(600) })) };
  dto.files = { availability: 'complete', omitted: 2, items: Array.from({ length: 200 }, (_, i) => ({ path: `${i}/` + '😀'.repeat(512), action: 'changed', evidence: 'reported' })) };
  const clean = normalizeInspection(dto);
  assert.ok(Buffer.byteLength(JSON.stringify(clean)) <= INSPECTION_LIMITS.bytes);
  assert.ok(clean.prompt.text.length <= 8000); assert.equal(clean.prompt.truncated, true);
  assert.ok(clean.tools.items.length <= 40); assert.ok(clean.files.items.length <= 64);
  assert.equal(clean.tools.omitted, Number.MAX_SAFE_INTEGER); assert.ok(clean.files.omitted >= 138);
  assert.equal(clean.tools.availability, 'partial'); assert.equal(clean.files.availability, 'partial');
  assert.ok(clean.tools.items.every((t) => t.id.length <= 256 && t.summary.length <= 600));
  assert.ok(clean.files.items.every((f) => f.path.length <= 512));
});

test('successful write/edit correlation and reported files never promote shared Git, read, bash or failed writes', () => {
  const source = { task: 'Assigned task', messages: [...toolMessages(),
    { role: 'assistant', content: [{ type: 'toolCall', id: 'read', name: 'read', arguments: { path: 'read-only.ts' } }, { type: 'toolCall', id: 'shell', name: 'bash', arguments: { command: 'touch guessed.ts' } }, { type: 'toolCall', id: 'edit', name: 'edit', arguments: { path: 'failed-edit.ts' } }] },
    ...['read', 'shell', 'edit'].map((toolCallId) => ({ role: 'toolResult', toolCallId, isError: toolCallId === 'edit' })),
    { role: 'toolResult', toolCallId: 'no-call', toolName: 'write', isError: false, details: { path: 'uncorrelated.ts' } }],
    effects: { fileMutation: { status: 'observed', evidence: { source: 'tracked-files', changedFiles: ['shared-git.ts'] } } },
    acceptance: { childReport: { changedFiles: ['reported.ts'], commandsRun: [{ command: 'PRIVATE COMMAND' }] } },
    usage: { input: 0, output: 4, cacheRead: 3, cacheWrite: 0, cost: 0 }, progress: { toolCount: 4, durationMs: 1250, tokens: 4 } };
  const dto = resultInspection(source, { status: 'complete', redact });
  assert.deepEqual(dto.files.items, [{ path: 'src/owned.ts', action: 'changed', evidence: 'observed-tool' }, { path: 'reported.ts', action: 'unknown', evidence: 'reported' }]);
  assert.equal(dto.files.availability, 'partial'); assert.equal(dto.tools.total, 4);
  assert.deepEqual(dto.tools.items.map((t) => t.status), ['done', 'done', 'done', 'error']);
  assert.equal(dto.usage.inputTokens, 0); assert.equal(dto.usage.costUsd, 0); assert.equal(dto.usage.provisional, false); assert.equal(dto.usage.totalTokens, 4);
  assert.equal(dto.timing.durationMs, 1250); assert.equal(dto.timing.startedAt, null); assert.equal(dto.timing.live, false);
  for (const text of ['HIDDEN', 'raw-password', 'known-secret', 'shared-git', 'PRIVATE COMMAND', 'uncorrelated']) assert.equal(JSON.stringify(dto).includes(text), false);
  assert.equal(resultInspection({ messages: toolMessages(true) }, { status: 'failed' }).files.availability, 'unavailable');
  const unknown = toolMessages(); delete unknown[1].isError;
  assert.equal(resultInspection({ messages: unknown }).files.availability, 'unavailable');
});

test('foreground repeated/reordered snapshots replace cumulative inspection and never copy workflow aggregate cost', () => {
  const p = new DelegationProjection('s', redact);
  const one = { index: 7, task: 'x'.repeat(3000), messages: toolMessages(), usage: { input: 20, output: 2, cost: 0.01 }, progress: { status: 'running', toolCount: 1, durationMs: 20 } };
  const two = { index: 2, task: 'second', progress: { status: 'running' } };
  p.foreground(foreground([one, two])); const ids = [...p.rows.keys()];
  p.foreground(foreground([two, one])); p.foreground(foreground([two, one]));
  const dto = p.rows.get(ids[0]).inspection;
  assert.equal(dto.prompt.text.length, 3000); assert.equal(dto.prompt.truncated, false);
  assert.equal(dto.tools.items.length, 1); assert.equal(dto.tools.total, 1); assert.equal(dto.files.items.length, 1);
  assert.equal(dto.usage.inputTokens, 20); assert.equal(dto.usage.provisional, true);
  p.foreground(foreground([{ ...one, stopped: true }, { ...two, timedOut: true }], true));
  assert.equal(p.rows.get(ids[0]).status, 'stopped'); assert.equal(p.rows.get(ids[0]).inspection.timing.live, false);
  const workflowChildren = { version: 1, workflowRunId: 'run', children: [{ childId: 'a', state: 'running', activity: { tokens: 99, inputTokens: 90, outputTokens: 9, durationMs: 200, toolCount: 2, currentTool: 'read' } }, { childId: 'b', state: 'running' }] };
  const w = new DelegationProjection('s'); w.foreground(foreground([], false, { workflowChildren, totalCost: { costUsd: 42 }, totalChildUsage: { cost: 42 } }));
  const rows = [...w.rows.values()];
  assert.equal(rows[0].inspection.usage.totalTokens, 99); assert.equal(rows[0].inspection.timing.durationMs, 200);
  assert.equal(rows[0].inspection.tools.items[0].name, 'read'); assert.ok(rows.every((r) => r.inspection.usage.costUsd === null));
  assert.equal(rows[1].inspection.usage.totalTokens, null);
  workflowChildren.children = [{ childId: 'b', state: 'failed' }, { childId: 'a', state: 'completed' }];
  w.foreground(foreground([{ workflowKey: 'a', usage: { input: 100, output: 10, cost: 0.2 } }], true, { workflowChildren }));
  assert.equal(w.rows.get(rows[0].id).inspection.usage.costUsd, 0.2); assert.equal(w.rows.get(rows[1].id).inspection.usage.costUsd, null);
  const report = { acceptance: { childReport: { changedFiles: Array.from({ length: 100 }, (_, i) => `file-${i}`) } } };
  const first = resultInspection(report), repeated = resultInspection(report, { previous: first });
  assert.deepEqual(first.files, repeated.files, 'repeated reported snapshots do not inflate omitted counts');
});

test('status-only terminal updates never promote cached progress counters to final usage', () => {
  const running = resultInspection({}, { status: 'running', activity: { tokens: 99, inputTokens: 90, outputTokens: 9 } });
  for (const status of ['complete', 'paused', 'unknown', 'failed', 'stopped']) {
    const retained = resultInspection({}, { status, previous: running });
    assert.equal(retained.usage.totalTokens, 99);
    assert.equal(retained.usage.provisional, true, status);
    assert.equal(snapshotInspection({ state: status }, running).usage.provisional, true);
    const p = new DelegationProjection('s');
    const workflowChildren = { version: 1, workflowRunId: 'run', children: [{ childId: 'a', state: 'running', activity: { tokens: 99 } }] };
    p.foreground(foreground([], false, { workflowChildren }));
    workflowChildren.children = [{ childId: 'a', state: status === 'complete' ? 'completed' : status }];
    p.foreground(foreground([], false, { workflowChildren }));
    assert.equal([...p.rows.values()][0].inspection.usage.provisional, true);
  }
  const final = resultInspection({ usage: { input: 100, output: 10, total: 110, cost: 0.2 } }, { status: 'complete', previous: running });
  assert.equal(final.usage.provisional, false); assert.equal(final.usage.totalTokens, 110);
  assert.equal(resultInspection({}, { status: 'complete', previous: final }).usage.provisional, false);
});

test('upstream prompt-redaction sentinel is unavailable, and transcript arguments retain code', () => {
  assert.equal(resultInspection({ task: '[prompt redacted]' }).prompt.text, null);
  const state = createAgentState('child', 'Child', 'subagent'), reducer = new AgentReducer(state, redact);
  reducer.apply({ type: 'tool_execution_start', toolCallId: 'edit', toolName: 'edit', args: {
    path: 'test.js', edits: [{ oldText: 'const n = 1;', newText: 'const n = 2;' }], password: 'raw-password', content: 'plain code' } });
  const text = state.messages.find(m => m.role === 'tool').args;
  assert.match(text, /const n = 1;/); assert.match(text, /const n = 2;/); assert.match(text, /plain code/);
  assert.doesNotMatch(text, /raw-password/);
});

test('async inspect previews remain partial, task truncation explicit, counts/timestamps authoritative and old snapshots ignored', () => {
  const p = new DelegationProjection('s'); p.asyncSnapshot(snapshot([asyncNode('running', { startedAt: 10, activity: { toolCount: 9, currentTool: 'write' } })]));
  const row = [...p.rows.values()][0];
  const reply = { kind: 'pi-subagents.inspect-reply', version: 1, asyncId: 'async', task: 'x'.repeat(2000), truncated: { task: true }, messages: [
    { role: 'assistant', kind: 'toolCall', name: 'write', text: 'path: unverified.ts' }, { role: 'toolResult', kind: 'toolResult', name: 'write', text: 'Success' },
  ] };
  p.inspect(row.id, reply); p.inspect(row.id, reply);
  let dto = p.rows.get(row.id).inspection;
  assert.equal(dto.prompt.truncated, true); assert.equal(dto.tools.total, 9); assert.equal(dto.tools.items.length, 1);
  assert.equal(dto.tools.items[0].status, 'unknown'); assert.equal(dto.tools.availability, 'partial');
  assert.equal(dto.files.availability, 'unavailable'); assert.deepEqual(dto.files.items, []);
  assert.equal(dto.usage.totalTokens, null); assert.equal(dto.usage.costUsd, null); assert.equal(dto.timing.live, true);
  p.asyncSnapshot(snapshot([asyncNode('stopped', { startedAt: 10, endedAt: 80 })], 200));
  p.asyncSnapshot(snapshot([asyncNode('running', { startedAt: 10 })], 150)); dto = p.rows.get(row.id).inspection;
  assert.equal(p.rows.get(row.id).status, 'stopped'); assert.equal(dto.timing.durationMs, 70); assert.equal(dto.timing.live, false);
  const queued = new DelegationProjection('q'); queued.asyncSnapshot(snapshot([asyncNode('queued', { startedAt: 10 })]));
  assert.equal([...queued.rows.values()][0].inspection.timing.startedAt, null); assert.equal([...queued.rows.values()][0].inspection.timing.live, false);
});

test('async disappearance, failed/unknown/paused status and disconnection stop timers without fabricated settlement', () => {
  for (const state of ['failed', 'unknown', 'paused', 'stopped']) {
    const p = new DelegationProjection('s'); p.asyncSnapshot(snapshot([asyncNode('running', { startedAt: 10 })]));
    const id = [...p.rows.keys()][0]; p.asyncSnapshot(snapshot([asyncNode(state, { startedAt: 10 })], 200));
    assert.equal(p.rows.get(id).inspection.timing.live, false); assert.equal(p.rows.get(id).inspection.timing.endedAt, null);
  }
  const p = new DelegationProjection('s'); p.asyncSnapshot(snapshot([asyncNode('running', { startedAt: 10 })]));
  p.asyncSnapshot(snapshot([], 200)); assert.equal([...p.rows.values()][0].inspection.timing.live, false);
  p.asyncSnapshot(snapshot([asyncNode('running', { startedAt: 10 })], 300)); p.unavailable();
  assert.equal([...p.rows.values()][0].inspection.timing.live, false);
});

test('manual prompt is latest delivered user input, not queued/system text; session totals never add streaming usage', (t) => {
  let now = 100; t.mock.method(Date, 'now', () => now);
  const state = createAgentState('child', 'Child', 'subagent'), reducer = new AgentReducer(state, redact);
  assert.equal(state.inspection.timing.startedAt, null);
  reducer.apply({ type: 'queue_update', steering: ['undelivered'], followUp: ['also undelivered'] });
  reducer.apply({ type: 'message_start', message: { role: 'system', content: 'system secret' } }); assert.equal(state.inspection.prompt.text, null);
  now = 200; reducer.apply({ type: 'agent_start' });
  reducer.apply({ type: 'message_start', message: { role: 'user', content: 'Delivered known-secret-value' } });
  assert.equal(state.inspection.prompt.text, 'Delivered [redacted]'); assert.equal(state.inspection.prompt.kind, 'user');
  reducer.captureInspectionStats({ tokens: { input: 10, output: 5, cacheRead: 2, cacheWrite: 0, total: 17 }, cost: 0, toolCalls: 0 });
  reducer.apply({ type: 'message_update', usage: { input: 9999, cost: 99 } });
  assert.equal(state.inspection.usage.totalTokens, 17); assert.equal(state.inspection.usage.scope, 'session'); assert.equal(state.inspection.usage.costUsd, 0);
  now = 250; reducer.apply({ type: 'agent_end' }); reducer.apply({ type: 'agent_start' }); assert.equal(state.inspection.timing.startedAt, 200);
  now = 400; reducer.apply({ type: 'agent_settled' });
  assert.deepEqual(state.inspection.timing, { startedAt: 200, endedAt: 400, durationMs: 200, scope: 'run', live: false });
  reducer.captureInspectionStats({ tokens: { total: 20 }, cost: 0.1 }); assert.equal(state.inspection.usage.provisional, false);
  now = 500; reducer.apply({ type: 'agent_start' }); assert.equal(state.inspection.timing.startedAt, 500);
  reducer.stopInspection(); assert.equal(state.inspection.timing.live, false); assert.equal(state.inspection.timing.endedAt, null);
});

test('hydrate/clone history and later stats cannot attribute file writes; live success can, failure cannot; reset clears evidence', () => {
  const state = createAgentState('child', 'Child', 'subagent'), reducer = new AgentReducer(state, redact);
  reducer.hydrate([{ role: 'user', content: 'Saved task', timestamp: 100 }, ...toolMessages()]);
  assert.equal(state.inspection.prompt.text, 'Saved task'); assert.equal(state.inspection.timing.startedAt, null); assert.equal(state.inspection.timing.durationMs, null);
  assert.equal(state.inspection.files.items.length, 0); assert.equal(state.inspection.tools.items[0].status, 'done');
  reducer.captureInspectionStats({ toolCalls: 1 }); assert.equal(state.inspection.files.availability, 'unavailable');
  reducer.apply(end('write-id')); assert.equal(state.inspection.files.items.length, 0, 'late result cannot promote a hydrated call');
  reducer.apply(start('live', 'live.ts')); reducer.apply(end('live'));
  assert.deepEqual(state.inspection.files.items, [{ path: 'live.ts', action: 'changed', evidence: 'observed-tool' }]);
  reducer.apply(start('bad', 'bad.ts', 'edit')); reducer.apply(end('bad', true));
  assert.equal(state.inspection.files.items.length, 1); assert.equal(JSON.stringify(state.inspection).includes('PRIVATE-TOKEN'), false);
  reducer.reset(); assert.deepEqual(state.inspection, emptyInspection('user', 'session'));
  reducer.hydrate([{ role: 'user', content: 'New saved task' }]); assert.equal(state.inspection.tools.items.length, 0);
  const agent = Object.create(PiSession.prototype); Object.assign(agent, { state, reducer, secrets: [], emit() {} });
  state.sessionId = 'old'; agent.capture({ sessionId: 'new' }, { tokens: { total: 0 }, cost: 0 });
  assert.equal(state.inspection.prompt.text, null); assert.equal(state.inspection.usage.totalTokens, 0);
});

test('clone replacement preserves freshly reported session totals after hydration', async () => {
  const state = createAgentState('child', 'Child', 'subagent'), reducer = new AgentReducer(state);
  Object.assign(state, { phase: 'idle', sessionId: 'old' });
  const agent = Object.create(PiSession.prototype); Object.assign(agent, { state, reducer, secrets: [], emit() {}, ready: Promise.resolve(), metadataGeneration: 0,
    async command(type) { return type === 'get_messages' ? { messages: [{ role: 'user', content: 'Cloned prompt' }, ...toolMessages()] } : {}; },
    async refresh() { this.capture({ sessionId: 'new' }, { tokens: { total: 42 }, cost: 0, toolCalls: 1 }); } });
  await agent.act('clone', {});
  assert.equal(state.inspection.prompt.text, 'Cloned prompt'); assert.equal(state.inspection.usage.totalTokens, 42);
  assert.equal(state.inspection.usage.costUsd, 0); assert.equal(state.stats.tokens.total, 42);
  assert.equal(state.inspection.files.availability, 'unavailable'); assert.equal(state.inspection.timing.startedAt, null);
});

test('tool IDs correlate exactly, never via clipped or redacted collisions', () => {
  const state = createAgentState('child', 'Child', 'subagent'), reducer = new AgentReducer(state, redact);
  reducer.apply(start('known-secret-value', 'real.ts')); reducer.apply(end('[redacted]'));
  assert.deepEqual(state.inspection.files.items, []);
  reducer.apply(end('known-secret-value')); assert.equal(state.inspection.files.items[0].path, 'real.ts');
  reducer.apply(start('x'.repeat(257), 'wrong.ts')); reducer.apply(end('x'.repeat(256)));
  assert.equal(state.inspection.files.items.length, 1);
});

test('aggregate delegation budget includes inspection, JSON framing and omission notices', () => {
  const p = new DelegationProjection('s');
  const results = Array.from({ length: 32 }, (_, index) => ({ index, task: '😀'.repeat(8000), messages: toolMessages(), progress: { status: 'running' },
    acceptance: { childReport: { changedFiles: Array.from({ length: 64 }, (_, i) => `${i}/` + '😀'.repeat(512)) } } }));
  p.foreground(foreground(results)); const data = p.snapshot();
  assert.ok(data.delegationStatus.omitted > 0); assert.ok(Buffer.byteLength(JSON.stringify(data)) <= DELEGATION_LIMITS.bytes);
  assert.ok(data.delegations.every((r) => Buffer.byteLength(JSON.stringify(r.inspection)) <= INSPECTION_LIMITS.bytes));
});

test('IPC stale generations/sequences cannot replace inspection; disconnect freezes and replacement clears it', () => {
  const state = createAgentState('main', 'Main', 'main'); state.sessionId = 's';
  const agent = Object.create(PiSession.prototype); Object.assign(agent, { state, secrets: [], emit() {} });
  const p = new DelegationProjection('s'); p.asyncSnapshot(snapshot([asyncNode('running', { startedAt: 20 })]));
  const envelope = { type: 'desktop_delegations', sessionId: 's', generation: 1, sequence: 2, ...p.snapshot() };
  agent.receiveDelegations(envelope); const before = JSON.stringify(state.delegations);
  for (const patch of [{ generation: 0, sequence: 999 }, { generation: 1, sequence: 1 }]) agent.receiveDelegations({ ...envelope, ...patch, delegations: [] });
  assert.equal(JSON.stringify(state.delegations), before);
  agent.disconnectDelegations(); assert.equal(state.delegations[0].inspection.timing.live, false);
  agent.capture({ sessionId: 'new' }, {}); assert.deepEqual(state.delegations, []);
});
