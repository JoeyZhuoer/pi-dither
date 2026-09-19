import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { AgentReducer, createAgentState, JsonLines, safeModel } from '../desktop/protocol.mjs';
import { createDesktop, authorized } from '../desktop/server.mjs';

test('JSONL preserves Unicode separators, split UTF-8 strings and CRLF records', () => {
  const lines = new JsonLines();
  assert.deepEqual(lines.push('{"text":"a\u2028b\u2029c"}\r'), []);
  assert.deepEqual(lines.push('\n{"text":'), [{ text: 'a\u2028b\u2029c' }]);
  assert.deepEqual(lines.push('"你好"}\n'), [{ text: '你好' }]);
  assert.throws(() => lines.push('bad\n'));
});

test('stream reducer assembles indexed blocks and final message is authoritative', () => {
  const state = createAgentState('main', 'Main', 'main'), reducer = new AgentReducer(state);
  reducer.apply({ type: 'message_start', message: { role: 'assistant', content: [] } });
  for (const [contentIndex, type, delta] of [[0, 'text_delta', 'Hello'], [1, 'thinking_delta', 'Planning'], [2, 'text_delta', 'world']]) {
    reducer.apply({ type: 'message_update', assistantMessageEvent: { contentIndex, type, delta } });
  }
  assert.equal(state.messages[0].text, 'Hello\nworld');
  assert.equal(state.messages[0].thinking, 'Planning');
  reducer.apply({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'Final' }], stopReason: 'stop' } });
  assert.equal(state.messages.length, 1); assert.equal(state.messages[0].text, 'Final');
  assert.equal(state.messages[0].status, 'done');
});

test('tool partial results replace cumulative output; agent_end is not settled', () => {
  const state = createAgentState('main', 'Main', 'main'), reducer = new AgentReducer(state);
  reducer.apply({ type: 'agent_start' });
  reducer.apply({ type: 'tool_execution_start', toolCallId: 't1', toolName: 'read', args: { path: 'a' } });
  for (const text of ['one', 'one two']) reducer.apply({ type: 'tool_execution_update', toolCallId: 't1', toolName: 'read', partialResult: { content: [{ type: 'text', text }] } });
  assert.equal(state.messages[0].text, 'one two');
  reducer.apply({ type: 'agent_end', willRetry: true }); assert.equal(state.phase, 'running');
  reducer.apply({ type: 'auto_retry_start', attempt: 1, maxAttempts: 3 }); assert.equal(state.phase, 'retrying');
  reducer.apply({ type: 'agent_settled' }); assert.equal(state.phase, 'idle');
});

test('serialized model strips provider configuration and credentials', () => {
  const model = safeModel({ id: 'local', provider: 'test', apiKey: 'secret', headers: { Authorization: 'secret' }, baseUrl: 'private' });
  assert.ok(!JSON.stringify(model).includes('secret'));
  assert.ok(!('baseUrl' in model));
});

test('authorization rejects bad hosts, origins, missing tokens and non-ASCII tokens', () => {
  const token = 'test-token', headers = { host: '127.0.0.1:1234', authorization: `Bearer ${token}` };
  assert.equal(authorized({ headers }, token, 1234), true);
  for (const patch of [{ host: 'evil.test:1234' }, { origin: 'https://evil.test' }, { authorization: '' }, { authorization: 'Bearer éééééééééé' }, { 'sec-fetch-site': 'cross-site' }]) {
    assert.equal(authorized({ headers: { ...headers, ...patch } }, token, 1234), false);
  }
});

class FakeSession extends EventEmitter {
  constructor(options) {
    super(); this.state = createAgentState(options.id, options.name, options.kind);
    this.state.connected = true; this.state.phase = 'idle'; this.ready = Promise.resolve(); this.calls = [];
  }
  async act(action, input) { this.calls.push({ action, input }); return {}; }
  close() { this.state.phase = 'stopped'; this.state.connected = false; }
}

test('local API enforces auth, static allowlist, request deduplication and explicit child launch', async () => {
  const app = await createDesktop({ port: 0, token: 'test-token', cwd: '/tmp/test-project', factory: (options) => new FakeSession(options) });
  const base = app.url.split('/#')[0];
  const headers = { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' };
  try {
    assert.equal((await fetch(`${base}/api/state`)).status, 403);
    assert.equal((await fetch(`${base}/api/state`, { headers: { ...headers, Origin: 'https://evil.test' } })).status, 403);
    assert.equal((await fetch(`${base}/.env`)).status, 404);
    assert.equal((await fetch(`${base}/package.json`)).status, 404);
    const page = await fetch(`${base}/`); assert.equal(page.status, 200);
    assert.ok(page.headers.get('content-security-policy').includes("script-src 'self'"));
    assert.ok(!(await page.text()).includes('test-token'));
    const initial = await (await fetch(`${base}/api/state`, { headers })).json();
    assert.equal(initial.agents.length, 1, 'no children are silently started');
    const body = { requestId: randomUUID(), message: 'hello' };
    for (let i = 0; i < 2; i++) assert.equal((await fetch(`${base}/api/agents/main/prompt`, { method: 'POST', headers, body: JSON.stringify(body) })).status, 200);
    assert.equal(app.sessions.get('main').calls.length, 1);
    assert.equal((await fetch(`${base}/api/agents/main/prompt`, { method: 'POST', headers, body: JSON.stringify({ ...body, message: 'changed' }) })).status, 409);
    const child = await (await fetch(`${base}/api/agents`, { method: 'POST', headers, body: JSON.stringify({ requestId: randomUUID(), name: 'Scout', task: 'Inspect only' }) })).json();
    assert.equal(app.sessions.get(child.id).state.kind, 'subagent');
    assert.equal(app.sessions.get(child.id).calls[0].action, 'prompt');
    assert.equal((await fetch(`${base}/api/agents/main/close`, { method: 'POST', headers, body: JSON.stringify({ requestId: randomUUID() }) })).status, 400);
  } finally { await app.close(); }
});
