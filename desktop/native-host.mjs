// Private stdio owner for the macOS application. No terminal/browser launching.
import { DatabaseSync } from 'node:sqlite';
import { mkdir } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { createDesktop } from './server.mjs';

export function nativeActivity(sessions) {
  let busy = 0, delegated = 0, uncertain = false;
  for (const { state } of sessions.values()) {
    if (!['idle', 'stopped', 'error'].includes(state.phase) || state.queue?.steering?.length || state.queue?.followUp?.length) busy++;
    if (state.kind !== 'main') continue;
    delegated += (state.delegations ?? []).filter((row) => ['queued', 'running', 'paused'].includes(row.status)).length;
    if (state.extensionStatus?.status === 'loaded' && (state.delegationStatus?.available !== true || state.delegationStatus?.omitted > 0
      || (state.delegations ?? []).some((row) => row.status === 'unknown'))) uncertain = true;
  }
  return { busy, delegated, uncertain };
}

export async function createNativeService({ dataDir, cwd, port = 4317, factory = createDesktop }) {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  // A kernel-backed SQLite exclusive lock releases even after SIGKILL. Unlike a
  // PID-file stale-lock cleanup it cannot accidentally unlink a new owner's lock.
  const lease = new DatabaseSync(join(dataDir, 'native-runtime.sqlite'));
  let app;
  try {
    lease.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE; CREATE TABLE IF NOT EXISTS lease (id INTEGER);');
  } catch { lease.close(); throw new Error('This data folder is already open in another Pi Dither instance.'); }
  try {
    app = await factory({ cwd, port, dataDir });
    await app.sessions.get('main').ready;
  } catch (error) { try { await app?.close(); } finally { lease.close(); } throw error; }
  let closing;
  return { app, status: () => nativeActivity(app.sessions), close() {
    return closing ??= Promise.resolve().then(() => app.close()).finally(() => lease.close());
  } };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), value = (name) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
  const dataDir = value('--data-dir'), cwd = value('--workspace'), port = Number(value('--port') ?? 4317);
  if (!dataDir || !cwd || !Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid native bootstrap arguments.');
  const send = (event) => { if (!process.stdout.destroyed) process.stdout.write(JSON.stringify(event) + '\n'); };
  let service, stopping = false, startup;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    try { await startup; await service?.close(); send({ event: 'stopped' }); }
    finally { process.exit(Number(process.exitCode) || 0); }
  };
  // Parent crash/exit closes this pipe; do not orphan desktop-owned processes.
  const input = createInterface({ input: process.stdin });
  input.on('line', (line) => {
    if (line.length > 4096) return;
    let request; try { request = JSON.parse(line); } catch { return; }
    if (request.command === 'status') send({ event: 'status', ...(service?.status() ?? { busy: 1, delegated: 0, uncertain: true }) });
    if (request.command === 'shutdown') void stop();
  });
  input.on('close', () => { void stop(); });
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => { void stop(); });
  process.stdout.on('error', () => { void stop(); });
  startup = createNativeService({ dataDir: resolve(dataDir), cwd: resolve(cwd), port }).then((result) => {
    service = result;
    if (!stopping) send({ event: 'ready', url: result.app.url });
  }).catch(() => {
    // Do not forward unredacted provider/module exceptions to the app or logs.
    send({ event: 'error', message: 'Could not start Pi Dither. Another instance may own its data folder or port 4317, or a bundled runtime could not load.' });
    process.exitCode = 1; input.close();
  });
}
