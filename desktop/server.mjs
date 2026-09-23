import { createServer } from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual, createHash } from 'node:crypto';
import { readFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { findPi } from '../scripts/pi-paths.mjs';
import { PiSession } from './pi-session.mjs';
import { DesktopControls } from './controls.mjs';
import { directory } from './workspace.mjs';
import { assertToolChangeReady, validateToolSelection } from './tools.mjs';
import { allocateSubagentSlot, subagentDisplayName } from './subagent-slots.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const publicRoot = join(root, 'desktop/public');
const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css']], ['/app.js', ['app.js', 'text/javascript']],
  ['/windows.js', ['windows.js', 'text/javascript']],
  ['/background.js', ['background.js', 'text/javascript']], ['/particles.js', ['particles.js', 'text/javascript']],
  ['/motion.js', ['motion.js', 'text/javascript']],
  ['/delegated.js', ['delegated.js', 'text/javascript']],
  ['/inspection.js', ['inspection.js', 'text/javascript']], ['/inspection.css', ['inspection.css', 'text/css']],
  ['/combobox.js', ['combobox.js', 'text/javascript']], ['/combobox.css', ['combobox.css', 'text/css']],
  ['/markdown.js', ['markdown.js', 'text/javascript']], ['/markdown.css', ['markdown.css', 'text/css']],
  ['/features.js', ['features.js', 'text/javascript']], ['/features.css', ['features.css', 'text/css']],
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
  request.setEncoding('utf8');
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

export async function createDesktop({ cwd = root, port = 4318, token = randomBytes(32).toString('hex'), factory, host, dataDir = join(root, '.local') } = {}) {
  if (!factory) {
    host ??= findPi();
    if (host.version !== '0.85.1') throw new Error(`Pi Dither targets Pi 0.85.1; found ${host.version}`);
    cwd = await directory(cwd);
  }
  const sessions = new Map();
  const owned = new Set();
  const peers = new Set();
  const requests = new Map();
  const timers = new Map();
  const sessionDir = join(dataDir, 'desktop-sessions');
  if (!factory) await mkdir(sessionDir, { recursive: true, mode: 0o700 });
  let controls, controlBusy = false, closing = false, contextId = randomUUID();
  const makeSession = (options) => {
    if (closing) throw problem(503, 'Desktop server is stopping');
    const input = { cwd, host, sessionDir, keys: controls?.keys ?? {}, ...options };
    const agent = factory ? factory(input) : new PiSession(input);
    agent.state.cwd = input.cwd;
    if (input.kind === 'subagent') agent.state.slot = input.slot;
    owned.add(agent);
    agent.exited?.then(() => owned.delete(agent), () => owned.delete(agent));
    return agent;
  };
  const send = (peer, value) => {
    if (peer.writableLength > 2_000_000) { peer.destroy(); peers.delete(peer); return; }
    peer.write(`data: ${JSON.stringify(value)}\n\n`);
  };
  const publish = (value) => { for (const peer of peers) send(peer, value); };
  const snapshot = () => ({ type: 'snapshot', contextId, cwd, desktopVersion: '0.4.0', version: host?.version ?? 'test', agents: [...sessions.values()].map((agent) => agent.state) });
  function attach(agent) {
    const id = agent.state.id;
    sessions.set(id, agent);
    agent.on('change', () => {
      if (closing || sessions.get(id) !== agent || timers.has(id)) return;
      timers.set(id, setTimeout(() => {
        timers.delete(id);
        if (!closing && sessions.get(id) === agent) publish({ type: 'agent', contextId, agent: agent.state });
      }, 80));
    });
    return agent;
  }
  function addSession(id, name, kind, tools, slot) { return attach(makeSession({ id, name, kind, tools, slot })); }
  controls = new DesktopControls({ dataDir, host, sessions, getCwd: () => cwd, makeSession,
    replaceFleet: async (agents, nextCwd) => {
      if (closing) { await Promise.all(agents.map((agent) => agent.close())); throw problem(503, 'Desktop server is stopping'); }
      const previous = [...sessions.values()];
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear(); sessions.clear(); cwd = nextCwd; contextId = randomUUID();
      for (const agent of agents) attach(agent);
      publish(snapshot());
      await Promise.all(previous.map((agent) => agent.close()));
      for (const agent of previous) owned.delete(agent);
    },
  });
  await controls.initialize();
  addSession('main', 'Main agent', 'main').ready.catch(() => {});
  // Serialize command acceptance, not the model run. This prevents context switches
  // racing with accepted prompts or other control operations from another browser tab.
  async function command(operation) {
    if (closing || controlBusy) throw problem(409, 'Another control operation is in progress. Wait for its result before retrying.');
    controlBusy = true;
    try { return await operation(); } finally { controlBusy = false; }
  }

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
      const requestUrl = new URL(request.url, `http://${expectedHost}`);
      const path = requestUrl.pathname;
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
        send(response, snapshot());
        const heartbeat = setInterval(() => response.write(': heartbeat\n\n'), 15_000);
        response.on('close', () => { peers.delete(response); clearInterval(heartbeat); });
        return;
      }
      if (request.method === 'GET' && path === '/api/state') {
        json(response, 200, snapshot()); return;
      }
      if (request.method === 'GET') {
        const result = await controls.get(path, requestUrl.searchParams);
        if (result !== undefined) { json(response, 200, result); return; }
      }
      if (request.method !== 'POST') throw problem(405, 'Method not allowed');
      const data = await bodyOf(request);
      if (data.contextId !== undefined && data.contextId !== contextId) throw problem(409, 'Desktop context changed. Review the new workspace/session before sending this command.');
      if (/^\/api\/(providers|workspace|sessions)(\/|$)/.test(path)) {
        const result = await once(path, data, () => command(() => controls.post(path, data)));
        if (result === undefined) throw problem(404, 'Unknown feature endpoint');
        json(response, 200, result); return;
      }
      if (path === '/api/agents') {
        const result = await once('create', data, () => command(async () => {
          if (sessions.size >= 7) throw problem(409, 'Limit: one main agent and six read-only subagents.');
          if (typeof data.task !== 'string' || !data.task.trim() || data.task.length > 32_000) throw problem(400, 'Enter a task of 1–32,000 characters.');
          const tools = Object.hasOwn(data, 'tools')
            ? validateToolSelection(data.tools, sessions.get('main').state.availableTools, 'subagent') : undefined;
          const slot = allocateSubagentSlot(sessions.values(), data.slot);
          const id = randomUUID();
          const name = subagentDisplayName(data.name, slot);
          const agent = addSession(id, name, 'subagent', tools, slot);
          try {
            await agent.ready;
            const model = sessions.get('main').state.model;
            if (model && agent.state.models.some((m) => m.id === model.id && m.provider === model.provider)) {
              await agent.act('model', { modelId: model.id, provider: model.provider });
            }
            await agent.act('prompt', { message: data.task });
            return { id, slot, name };
          } catch (error) {
            agent.state.error = error.message; agent.close();
            publish({ type: 'agent', agent: agent.state });
            throw error;
          }
        }));
        json(response, 200, result); return;
      }
      const match = path.match(/^\/api\/agents\/([\w-]+)\/(prompt|stop|model|thinking|new|close|refresh|tools)$/);
      if (!match) throw problem(404, 'Unknown endpoint');
      const [, id, action] = match;
      const agent = sessions.get(id);
      if (!agent) throw problem(404, 'Agent not found');
      if (data.sessionId !== undefined && data.sessionId !== agent.state.sessionId) throw problem(409, 'Agent session changed. Review it before sending this command.');
      const result = await once(`${id}:${action}`, data, () => command(async () => {
        if (sessions.get(id) !== agent) throw problem(409, 'The agent has been replaced. Refresh before retrying.');
        if (data.contextId !== undefined && data.contextId !== contextId) throw problem(409, 'Desktop context changed.');
        if (data.sessionId !== undefined && data.sessionId !== agent.state.sessionId) throw problem(409, 'Agent session changed.');
        if (action === 'tools') {
          assertToolChangeReady(agent.state);
          validateToolSelection(data.tools, agent.state.availableTools, agent.state.kind);
        }
        if (action === 'close') {
          if (id === 'main') throw problem(400, 'The main agent cannot be closed here.');
          sessions.delete(id); await agent.close();
          publish({ type: 'removed', id }); return {};
        }
        return agent.act(action, data);
      }));
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
      closing = true;
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      for (const peer of peers) peer.end();
      await Promise.all([...owned].map((agent) => agent.close()));
      owned.clear();
      controls.keys = Object.create(null);
      await new Promise((done) => server.close(done));
    },
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const projectIndex = args.indexOf('--project');
  if (projectIndex >= 0 && !args[projectIndex + 1]) throw new Error('--project requires a path');
  const app = await createDesktop({ cwd: projectIndex < 0 ? root : resolve(args[projectIndex + 1]), port: Number(process.env.PI_DESKTOP_PORT ?? 4318),
    dataDir: process.env.PI_DESKTOP_DATA_DIR ? resolve(process.env.PI_DESKTOP_DATA_DIR) : join(root, '.local'),
  });
  console.log(`\nPI DITHER / WEB\nLocal authenticated link (keep private):\n${app.url}\n\nCore Pi runs locally; provider requests use your configured credentials.\nCtrl+C stops the server and its agents.\n`);
  if (args.includes('--open') && process.platform === 'darwin') {
    spawn('/usr/bin/open', [app.url], { stdio: 'ignore' }).on('error', (error) => console.error(error.message));
  }
  let closing = false;
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, async () => {
    if (closing) return;
    closing = true; await app.close();
  });
}
