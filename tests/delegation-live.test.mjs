import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { DelegationBridge, transcriptBody } from '../desktop/delegation-bridge.mjs';
import { DelegationProjection } from '../desktop/delegations.mjs';

const summary = (children, run = 'flow') => ({ version: 1, workflowRunId: run, children });
const event = (children, results = [], end = false) => ({ type: end ? 'tool_execution_end' : 'tool_execution_update', toolName: 'subagent', toolCallId: 'call',
  [end ? 'result' : 'partialResult']: { details: { mode: 'workflow', runId: 'flow', workflowChildren: summary(children), results } } });

test('foreground workflow children use stable keys, not absent result rows or reordered numeric indexes', () => {
  const projection = new DelegationProjection('session');
  projection.foreground(event([{ childId: 'writer', runId: 'exact-writer', agent: 'worker', state: 'running' },
    { childId: 'review', runId: 'exact-review', agent: 'reviewer', state: 'running', activity: { currentTool: 'read' } }]));
  const first = projection.snapshot().delegations;
  assert.equal(first.length, 2, 'workflow progress has empty details.results in the installed package');
  assert.equal(first[1].phase, 'tool');
  assert.deepEqual(projection.routes.get(first[0].id), { id: 'exact-writer' });
  projection.liveTail(first[0].id, 'First partial output');
  projection.liveTail(first[0].id, 'Newest partial output');
  assert.deepEqual(projection.rows.get(first[0].id).messages.map((m) => m.text), ['Newest partial output']);
  projection.foreground(event([{ childId: 'review', state: 'failed' }, { childId: 'writer', state: 'completed' }], [
    { index: 0, workflowKey: 'writer', messages: [{ role: 'assistant', content: [{ type: 'text', text: 'Final writer result' }] }] },
    { index: 0, workflowKey: 'review', error: 'Review failed' },
  ], true));
  const last = projection.snapshot().delegations;
  assert.deepEqual(last.map((r) => r.id), first.map((r) => r.id));
  assert.equal(last[0].finalOutput, 'Final writer result');
  assert.equal(last[0].status, 'complete');
  assert.equal(last[1].error, 'Review failed');
  projection.liveTail(first[0].id, 'late');
  assert.equal(projection.rows.get(first[0].id).messages[0].text, 'Newest partial output', 'terminal records ignore late live tails');
});

test('implicit async first child materializes without opening a duplicate window', () => {
  const p = new DelegationProjection('s');
  const snapshot = (children) => ({ kind: 'pi-subagents.async-status-snapshot', version: 1, runs: [{ id: 'run', kind: 'subagent', state: 'running', children }] });
  p.asyncSnapshot(snapshot([]));
  const before = p.snapshot().delegations[0];
  p.asyncSnapshot(snapshot([{ id: 'step:0', kind: 'step', label: 'Worker', state: 'running' }]));
  assert.equal(p.rows.size, 1);
  assert.equal(p.snapshot().delegations[0].id, before.id);
  assert.equal(p.snapshot().delegations[0].childId, 'step:0');
});

test('public transcript projection excludes headers and replaces bounded redacted live tails', () => {
  for (const marker of ['Live transcript tail', 'Result transcript tail', 'Recent output from status.json', 'Transcript tail from /private/output-0.log', 'Session transcript tail from /private/session.jsonl']) {
    assert.equal(transcriptBody(`Run: abc\nArtifacts:\n  Session: /private/secret\n${marker} (tail truncated):\nvisible`), 'visible');
  }
  assert.equal(transcriptBody('Run unavailable /private/path'), '');
  const p = new DelegationProjection('s', (v) => v.replaceAll('SECRET', '[redacted]'));
  p.asyncSnapshot({ kind: 'pi-subagents.async-status-snapshot', version: 1, runs: [{ id: 'run', kind: 'subagent', state: 'running' }] });
  const row = [...p.rows.values()][0];
  p.liveTail(row.id, 'x'.repeat(3000) + 'SECRET newest');
  assert.equal(p.rows.get(row.id).messages[0].text.length, 2000);
  assert.ok(p.rows.get(row.id).messages[0].text.endsWith('[redacted] newest'));
  assert.equal(p.rows.get(row.id).phase, 'output');
  p.liveTail(row.id, 'x'.repeat(3000) + 'SECRET newest');
  assert.equal(p.rows.get(row.id).phase, 'unknown', 'unchanged tail is not fresh output');
});

test('async live output resolves workflow keys to exact run IDs using read-only status without prompts', async () => {
  const emitter = new EventEmitter(), requests = [], updates = [];
  const events = { on(key, fn) { emitter.on(key, fn); return () => emitter.off(key, fn); }, emit(key, value) { emitter.emit(key, value); } };
  events.on('subagents:rpc:v1:request', (request) => {
    requests.push(request);
    let data;
    if (request.method === 'ping') data = { capabilities: { statusProjection: { version: 1 } } };
    else if (!request.params) data = { asyncSnapshot: { kind: 'pi-subagents.async-status-snapshot', version: 1, runs: [
      { id: 'flow', kind: 'workflow', state: 'running', children: [{ id: 'writer', kind: 'step', state: 'running', label: 'Writer' }] },
    ] } };
    else if (!request.params.view) data = { details: { workflowChildren: summary([{ childId: 'unrelated', runId: 'do-not-read' }, { childId: 'writer', runId: 'exact-child' }]) } };
    else {
      assert.deepEqual(request.params, { id: 'exact-child', view: 'transcript', lines: 40 });
      data = { text: 'Run: exact-child\nSession: /private/metadata\nTranscript tail from /private/output.log:\n  Streamed before message_end' };
    }
    events.emit('subagents:rpc:v1:reply:' + request.requestId, { version: 1, requestId: request.requestId, success: true, data });
  });
  const bridge = new DelegationBridge({ sessionId: 's', generation: 1, events, publish: (value) => updates.push(value),
    context: { prompt() { assert.fail('no prompt'); } }, inspectCommand: { handler(args, ctx) {
      const [requestId, asyncId, childId] = args.split(' ');
      ctx.ui.setWidget('subagent-inspect', ['PI_SUBAGENT_INSPECT_JSON:' + JSON.stringify({ kind: 'pi-subagents.inspect-reply', version: 1, requestId, asyncId, childId, messages: [] })]);
    } } });
  try {
    await bridge.start();
    assert.deepEqual(requests.map((r) => r.method), ['ping', 'status', 'status', 'status']);
    const row = updates.at(-1).delegations[0];
    assert.equal(row.messages.at(-1).name, 'Live output');
    assert.match(row.messages.at(-1).text, /Streamed before message_end/);
    assert.equal(row.phase, 'output');
    assert.equal(JSON.stringify(row).includes('/private'), false);
    assert.equal(JSON.stringify(requests).includes('do-not-read'), false);
  } finally { bridge.dispose(); }
});
