import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { findPi } from '../scripts/pi-paths.mjs';
import { EventEmitter } from 'node:events';
import { createNativeService, nativeActivity } from '../desktop/native-host.mjs';
import { createDesktop } from '../desktop/server.mjs';
import { createAgentState } from '../desktop/protocol.mjs';

class NativeFixture extends EventEmitter {
  constructor({ id, name, kind }) { super(); this.state = createAgentState(id, name, kind); this.ready = Promise.resolve(); this.state.phase = 'idle'; this.state.connected = true; }
  async close() { this.state.connected = false; }
}
const factory = (options) => createDesktop({ ...options, factory: (input) => new NativeFixture(input) });

test('native service retains authentication, locks its store and releases lock after shutdown', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'pi-native-lock-'));
  let service;
  try {
    service = await createNativeService({ dataDir, cwd: dataDir, port: 0, factory });
    await assert.rejects(createNativeService({ dataDir, cwd: dataDir, port: 0, factory }), /already open/);
    const url = new URL(service.app.url), token = new URLSearchParams(url.hash.slice(1)).get('token');
    assert.equal((await fetch(`${url.origin}/api/state`)).status, 403);
    const response = await fetch(`${url.origin}/api/state`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(response.status, 200); assert.equal((await response.json()).agents.length, 1);
    assert.deepEqual(service.status(), { busy: 0, delegated: 0, uncertain: false });
    const closing = service.close(); assert.equal(service.close(), closing); await closing;
    service = await createNativeService({ dataDir, cwd: dataDir, port: 0, factory });
  } finally { await service?.close(); await rm(dataDir, { recursive: true, force: true }); }
});

test('native startup failure releases the data lock', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'pi-native-failure-'));
  let service;
  try {
    await assert.rejects(createNativeService({ dataDir, cwd: dataDir, port: 0, factory: async () => { throw new Error('fixture failure'); } }), /fixture failure/);
    service = await createNativeService({ dataDir, cwd: dataDir, port: 0, factory });
  } finally { await service?.close(); await rm(dataDir, { recursive: true, force: true }); }
});

test('quit checks queues and delegated work without claiming missing telemetry is idle', () => {
  const state = createAgentState('main', 'Main', 'main'); state.phase = 'idle';
  const sessions = new Map([['main', { state }]]);
  assert.deepEqual(nativeActivity(sessions), { busy: 0, delegated: 0, uncertain: false });
  state.extensionStatus = { status: 'loaded' };
  assert.equal(nativeActivity(sessions).uncertain, true);
  state.queue = { steering: ['pending'], followUp: [] };
  state.delegationStatus = { available: true, omitted: 0 };
  state.delegations = [{ status: 'running' }, { status: 'complete' }, { status: 'queued' }];
  assert.deepEqual(nativeActivity(sessions), { busy: 1, delegated: 2, uncertain: false });
  state.delegations.push({ status: 'unknown' }); assert.equal(nativeActivity(sessions).uncertain, true);
  state.delegations = []; state.delegationStatus.omitted = 1; assert.equal(nativeActivity(sessions).uncertain, true);
  state.delegations = [{ status: 'paused' }]; assert.equal(nativeActivity(sessions).delegated, 1);
});

test('native CLI launches through a symlink; parent EOF closes real owned Pi without prompts', { timeout: 30000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-native-ipc-'));
  let child, exit, lease;
  try {
    const entry = join(root, 'host-link.mjs');
    await symlink(fileURLToPath(new URL('../desktop/native-host.mjs', import.meta.url)), entry);
    child = spawn(process.execPath, [entry, '--data-dir', root, '--workspace', root, '--port', '0'], {
      env: { HOME: root, PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, PI_CODING_AGENT_DIR: join(root, 'profile'), PI_WORKSTATION_PI_ROOT: findPi().root, PI_OFFLINE: '1', PI_DESKTOP_SUBAGENTS: '0' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    exit = once(child, 'exit');
    child.stderr.resume();
    const ready = await new Promise((resolveReady, reject) => {
      let buffer = '';
      const timer = setTimeout(() => reject(new Error('native handshake timed out')), 20000);
      child.once('error', (error) => { clearTimeout(timer); reject(error); });
      child.once('exit', () => { clearTimeout(timer); reject(new Error('native host exited before readiness')); });
      child.stdout.on('data', (data) => {
        buffer += data;
        while (buffer.includes('\n')) {
          const index = buffer.indexOf('\n'), line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
          let message; try { message = JSON.parse(line); } catch { continue; }
          if (message.event === 'ready') { clearTimeout(timer); resolveReady(message); }
          if (message.event === 'error') { clearTimeout(timer); reject(new Error(message.message)); }
        }
      });
    });
    const url = new URL(ready.url), token = new URLSearchParams(url.hash.slice(1)).get('token');
    const state = await (await fetch(`${url.origin}/api/state`, { headers: { Authorization: `Bearer ${token}` } })).json();
    assert.equal(state.agents.length, 1); assert.deepEqual(state.agents[0].messages, []); assert.equal(state.agents[0].phase, 'idle');
    const children = execFileSync('/bin/ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8' }).trim().split('\n').map((line) => line.trim().split(/\s+/).map(Number)).filter(([, parent]) => parent === child.pid).map(([pid]) => pid);
    assert.ok(children.length > 0);
    child.stdin.end(); assert.deepEqual(await exit, [0, null]);
    for (const pid of children) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    lease = await createNativeService({ dataDir: root, cwd: root, port: 0, factory });
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) { child.stdin.end(); child.kill('SIGTERM'); await exit; }
    await lease?.close(); await rm(root, { recursive: true, force: true });
  }
});
