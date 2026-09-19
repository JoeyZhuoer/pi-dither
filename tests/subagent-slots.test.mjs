import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allocateSubagentSlot, subagentDisplayName } from '../desktop/subagent-slots.mjs';
import { nextSubagentIndex } from '../desktop/public/windows.js';
import { createDesktop } from '../desktop/server.mjs';
import { createAgentState } from '../desktop/protocol.mjs';

test('subagent slot allocation reuses holes without renumbering surviving or hidden agents', () => {
  const agents = [{ kind: 'main', slot: 1 }, { kind: 'subagent', slot: 2 }, { kind: 'subagent', slot: 4, connected: false }];
  assert.equal(allocateSubagentSlot(agents), 1);
  assert.equal(allocateSubagentSlot(agents, 4), 1, 'even stopped/error agents occupy a slot until explicitly closed');
  assert.equal(allocateSubagentSlot(agents, 3), 3, 'honor a locally reserved draft slot when available');
  for (const bad of [0, -1, 10, '1', null, true, 1.5, Infinity]) assert.throws(() => allocateSubagentSlot(agents, bad), /integer/);
  assert.equal(allocateSubagentSlot(agents), nextSubagentIndex([2, 4]), 'frontend/server agree on the lowest free number');
  assert.equal(subagentDisplayName('SCOUT / 09', 1), 'SCOUT / 01');
  assert.equal(subagentDisplayName('  ', 2), 'Subagent / 02');
});

class Fixture extends EventEmitter {
  constructor(options) {
    super(); this.state = createAgentState(options.id, options.name, options.kind);
    this.state.connected = true; this.state.phase = 'idle'; this.ready = Promise.resolve(); this.calls = [];
  }
  async act(action, input) { this.calls.push({ action, input }); return {}; }
  close() { this.state.phase = 'stopped'; this.state.connected = false; }
}

test('API reuses a closed child number with a new UUID and resolves cross-tab slot collisions', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'pi-slots-test-'));
  let spawned = 0;
  const app = await createDesktop({ port: 0, dataDir, factory: (options) => { spawned++; return new Fixture(options); } });
  const base = app.url.split('/#')[0], headers = { Authorization: `Bearer ${app.token}`, 'Content-Type': 'application/json' };
  const post = (path, data = {}) => fetch(base + path, { method: 'POST', headers, body: JSON.stringify({ ...data, requestId: randomUUID() }) });
  const launch = async (slot) => {
    const response = await post('/api/agents', { name: 'SUBAGENT', task: 'Synthetic fixture only', ...(slot === undefined ? {} : { slot }) });
    assert.equal(response.status, 200); return response.json();
  };
  try {
    const one = await launch(1), two = await launch(1);
    assert.equal(one.slot, 1); assert.equal(two.slot, 2, 'a second tab cannot assign an occupied display number');
    assert.equal(app.sessions.get(one.id).state.name, 'SUBAGENT / 01');
    assert.equal(app.sessions.get(two.id).state.slot, 2);
    assert.equal((await post(`/api/agents/${one.id}/close`)).status, 200);
    const reused = await launch();
    assert.equal(reused.slot, 1); assert.notEqual(reused.id, one.id);
    assert.equal(app.sessions.get(two.id).state.name, 'SUBAGENT / 02', 'surviving agent stays numbered 2');
    const prior = spawned;
    assert.equal((await post('/api/agents', { task: 'Invalid slot', slot: 0 })).status, 400);
    assert.equal(spawned, prior, 'invalid input rejected before spawning');
  } finally { await app.close(); await rm(dataDir, { recursive: true, force: true }); }
});
