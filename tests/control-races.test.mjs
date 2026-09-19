import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createDesktop } from '../desktop/server.mjs';
import { createAgentState } from '../desktop/protocol.mjs';

const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
class Fixture extends EventEmitter {
  constructor(options, ready = Promise.resolve()) {
    super(); this.state = createAgentState(options.id, options.name, options.kind);
    this.state.cwd = options.cwd; this.state.phase = 'idle'; this.state.connected = true;
    this.ready = ready; this.ready.catch(() => {}); this.calls = []; this.closed = false;
  }
  async act(action) { this.calls.push(action); return {}; }
  close() { this.closed = true; this.state.connected = false; this.emit('change'); }
}

test('control lock prevents prompt/context races; failed provider restart retains original fleet and redacts errors', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-race-test-')), second = join(root, 'second'); await mkdir(second);
  const begun = deferred(), release = deferred(); let delay = true;
  const created = [];
  const app = await createDesktop({ cwd: root, port: 0, dataDir: join(root, 'data'), factory: (options) => {
    let ready = Promise.resolve();
    if (options.keys.deepseek) ready = Promise.reject(new Error(`Credential failure: ${options.keys.deepseek}`));
    else if (delay && options.cwd.endsWith('/second')) { ready = release.promise; begun.resolve(); }
    const agent = new Fixture(options, ready); created.push(agent); return agent;
  } });
  const base = app.url.split('/#')[0];
  const post = (path, body = {}) => fetch(base + path, { method: 'POST', headers: { Authorization: `Bearer ${app.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId: randomUUID(), ...body }) });
  try {
    const initial = app.sessions.get('main');
    const initialContext = (await (await fetch(base + '/api/state', { headers: { Authorization: `Bearer ${app.token}` } })).json()).contextId;
    const switching = post('/api/workspace', { path: second });
    await begun.promise;
    const blocked = await post('/api/agents/main/prompt', { message: 'Must never be accepted into the old workspace' });
    assert.equal(blocked.status, 409); assert.deepEqual(initial.calls, []);
    release.resolve(); assert.equal((await switching).status, 200); delay = false;
    const current = app.sessions.get('main'); assert.notEqual(current, initial); assert.equal(initial.closed, true);
    assert.equal((await post('/api/agents/main/prompt', { message: 'Stale tab', contextId: initialContext })).status, 409);
    assert.equal((await post('/api/agents/main/prompt', { message: 'Stale session', sessionId: 'old-session' })).status, 409);
    assert.deepEqual(current.calls, []);
    // An old process event cannot poison the new main's snapshot.
    initial.state.phase = 'error'; initial.emit('change'); assert.equal(app.sessions.get('main').state.phase, 'idle');
    const failed = await post('/api/providers/configure', { provider: 'deepseek', apiKey: 'fixture-secret-never-echo' });
    assert.equal(failed.status, 400); assert.ok(!(await failed.text()).includes('fixture-secret-never-echo'));
    assert.equal(app.sessions.get('main'), current); assert.equal(current.closed, false);
    assert.equal(created.at(-1).closed, true);
  } finally { release.resolve(); await app.close(); await rm(root, { recursive: true, force: true }); }
});
