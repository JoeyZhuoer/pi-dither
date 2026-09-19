import { createServer } from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual, createHash } from 'node:crypto';
import { readFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { findPi } from '../scripts/pi-paths.mjs';
import { PiSession } from './pi-session.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const publicRoot = join(root, 'desktop/public');
const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css']], ['/app.js', ['app.js', 'text/javascript']],
  ['/windows.js', ['windows.js', 'text/javascript']], ['/backdrop.js', ['backdrop.js', 'text/javascript']],
  ['/assets/VT323-Regular.ttf', ['assets/VT323-Regular.ttf', 'font/ttf']],
  ['/assets/OFL.txt', ['assets/OFL.txt', 'text/plain']],
]);
const problem = (status, message) => Object.assign(new Error(message), { status });

export function authorized(request, token, port) {
  const origin = `http://127.0.0.1:${port}`;
  if (request.headers.host !== `127.0.0.1:${port}`) return false;
  if (request.headers.origin && request.headers.origin !== origin) return false;
  if (request.headers['sec-fetch-site'] === 'cross-site') return false;
  const supplied = Buffer.from(request.headers.authorization ?? '');
  const expected = Buffer.from(`Bearer ${token}`);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

async function bodyOf(request) {
  if (!(request.headers['content-type'] ?? '').startsWith('application/json')) throw problem(415, 'JSON is required');
  if (Number(request.headers['content-length']) > 128_000) throw problem(413, 'Request is too large');
  let text = '';
  for await (const chunk of request) {
    text += chunk;
    if (Buffer.byteLength(text) > 128_000) throw problem(413, 'Request is too large');
  }
  try {
    const data = JSON.parse(text);
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error();
    return data;
  } catch { throw problem(400, 'Invalid JSON object'); }
}

export async function createDesktop({ cwd = root, port = 4318, token = randomBytes(32).toString('hex'), factory, host } = {}) {
  if (!factory) {
    host ??= findPi();
    if (host.version !== '0.85.1') throw new Error(`Pi Desktop targets Pi 0.85.1; found ${host.version}`);
  }
  const sessions = new Map();
  const peers = new Set();
  const requests = new Map();
  const timers = new Map();
  const sessionDir = join(root, '.local/desktop-sessions');
  if (!factory) await mkdir(sessionDir, { recursive: true, mode: 0o700 });
  const makeSession = factory ?? ((options) => new PiSession({ ...options, cwd, host, sessionDir }));
  const send = (peer, value) => {
    if (peer.writableLength > 2_000_000) { peer.destroy(); peers.delete(peer); return; }
    peer.write(`data: ${JSON.stringify(value)}\n\n`);
  };
  const publish = (value) => { for (const peer of peers) send(peer, value); };
  function addSession(id, name, kind) {
    const agent = makeSession({ id, name, kind });
    sessions.set(id, agent);
    agent.on('change', () => {
      if (timers.has(id)) return;
      timers.set(id, setTimeout(() => {
        timers.delete(id);
        if (sessions.has(id)) publish({ type: 'agent', agent: agent.state });
      }, 80));
    });
    return agent;
  }
  const main = addSession('main', 'Main agent', 'main');
  // Serve an actionable error in the desktop if Pi cannot boot, rather than a blank page.
  main.ready.catch(() => {});

  function json(response, status, data) {
    response.writeHead(status, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(data));
  }
  async function once(key, data, operation) {
    if (typeof data.requestId !== 'string' || !/^[\w-]{8,100}$/.test(data.requestId)) throw problem(400, 'A request ID is required');
    const id = `${key}:${data.requestId}`;
    const digest = createHash('sha256').update(JSON.stringify(data)).digest('hex');
    const prior = requests.get(id);
    if (prior) {
      if (prior.digest !== digest) throw problem(409, 'Request ID reused with different data');
      return prior.promise;
    }
    if ([...requests.values()].filter((entry) => !entry.done).length >= 16) throw problem(429, 'Too many pending commands');
    const entry = { digest, done: false };
    entry.promise = Promise.resolve().then(operation).finally(() => { entry.done = true; });
    requests.set(id, entry);
    if (requests.size > 256) {
      for (const [oldId, old] of requests) { if (old.done) { requests.delete(oldId); break; } }
    }
    return entry.promise;
  }
  const server = createServer(async (request, response) => {
    const actualPort = server.address()?.port;
    const expectedHost = `127.0.0.1:${actualPort}`;
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'");
    response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    try {
      if (request.headers.host !== expectedHost || (request.headers.origin && request.headers.origin !== `http://${expectedHost}`)) {
        throw problem(403, 'Local same-origin access only');
      }
      const path = new URL(request.url, `http://${expectedHost}`).pathname;
      if (!path.startsWith('/api/')) {
        const asset = assets.get(path);
        if (request.method !== 'GET' || !asset) throw problem(404, 'Not found');
        response.writeHead(200, { 'Content-Type': asset[1] });
        response.end(await readFile(join(publicRoot, asset[0]))); return;
      }
      if (!authorized(request, token, actualPort)) throw problem(403, 'Open the authenticated link printed by the local launcher.');
      if (request.method === 'GET' && path === '/api/events') {
        response.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive' });
        peers.add(response);
        send(response, { type: 'snapshot', cwd, version: host?.version ?? 'test', agents: [...sessions.values()].map((agent) => agent.state) });
        const heartbeat = setInterval(() => response.write(': heartbeat\n\n'), 15_000);
        response.on('close', () => { peers.delete(response); clearInterval(heartbeat); });
        return;
      }
      if (request.method === 'GET' && path === '/api/state') {
        json(response, 200, { cwd, version: host?.version ?? 'test', agents: [...sessions.values()].map((agent) => agent.state) }); return;
      }
      if (request.method !== 'POST') throw problem(405, 'Method not allowed');
      const data = await bodyOf(request);
      if (path === '/api/agents') {
        const result = await once('create', data, async () => {
          if (sessions.size >= 7) throw problem(409, 'Limit: one main agent and six read-only subagents.');
          if (typeof data.task !== 'string' || !data.task.trim() || data.task.length > 32_000) throw problem(400, 'Enter a task of 1–32,000 characters.');
          const id = randomUUID();
          const name = String(data.name ?? 'Subagent').slice(0, 60);
          const agent = addSession(id, name, 'subagent');
          try {
            await agent.ready;
            const model = main.state.model;
            if (model && agent.state.models.some((m) => m.id === model.id && m.provider === model.provider)) {
              await agent.act('model', { modelId: model.id, provider: model.provider });
            }
            await agent.act('prompt', { message: data.task });
            return { id };
          } catch (error) {
            agent.state.error = error.message; agent.close();
            publish({ type: 'agent', agent: agent.state });
            throw error;
          }
        });
        json(response, 200, result); return;
      }
      const match = path.match(/^\/api\/agents\/([\w-]+)\/(prompt|stop|model|thinking|new|close)$/);
      if (!match) throw problem(404, 'Unknown endpoint');
      const [, id, action] = match;
      const agent = sessions.get(id);
      if (!agent) throw problem(404, 'Agent not found');
      const result = await once(`${id}:${action}`, data, async () => {
        if (action === 'close') {
          if (id === 'main') throw problem(400, 'The main agent cannot be closed here.');
          agent.close(); sessions.delete(id);
          publish({ type: 'removed', id }); return {};
        }
        return agent.act(action, data);
      });
      json(response, 200, result);
    } catch (error) {
      if (!response.headersSent) json(response, error.status ?? 400, { error: error.message });
      else response.end();
    }
  });
  await new Promise((resolveReady, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolveReady);
  }).catch((error) => { for (const agent of sessions.values()) agent.close(); throw error; });
  const url = `http://127.0.0.1:${server.address().port}/#token=${token}`;
  return {
    server, url, token, sessions,
    async close() {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      for (const peer of peers) peer.end();
      for (const agent of sessions.values()) agent.close();
      await new Promise((done) => server.close(done));
    },
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const projectIndex = args.indexOf('--project');
  if (projectIndex >= 0 && !args[projectIndex + 1]) throw new Error('--project requires a path');
  const app = await createDesktop({ cwd: projectIndex < 0 ? root : resolve(args[projectIndex + 1]), port: Number(process.env.PI_DESKTOP_PORT ?? 4318) });
  console.log(`\nPI / DESKTOP\nLocal authenticated link (keep private):\n${app.url}\n\nCore Pi runs locally; provider requests use your configured credentials.\nCtrl+C stops the server and its agents.\n`);
  if (args.includes('--open') && process.platform === 'darwin') {
    spawn('/usr/bin/open', [app.url], { stdio: 'ignore' }).on('error', (error) => console.error(error.message));
  }
  let closing = false;
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, async () => {
    if (closing) return;
    closing = true; await app.close();
  });
}
