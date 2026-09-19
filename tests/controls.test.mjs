import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createDesktop } from '../desktop/server.mjs';
import { PiSession } from '../desktop/pi-session.mjs';
import { loadPi, gitInfo, gitDiff, parseStatus, parseWorktrees, sessionKey } from '../desktop/workspace.mjs';
import { findPi } from '../scripts/pi-paths.mjs';
import { AgentReducer, createAgentState } from '../desktop/protocol.mjs';

const git = (cwd, ...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Test', '-c', 'user.email=test@localhost', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

test('Git inspection reports real changes and linked worktrees without mutation', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pi-git-test-')));
  try {
    const project = join(root, 'repo'), linked = join(root, 'other worktree'); await mkdir(project);
    git(project, 'init', '-q', '-b', 'main'); await writeFile(join(project, 'hello.txt'), 'first\n'); git(project, 'add', '.'); git(project, 'commit', '-qm', 'Fixture');
    git(project, 'worktree', 'add', '-b', 'review', linked);
    await writeFile(join(project, 'hello.txt'), 'changed\n'); await writeFile(join(project, 'untracked file.txt'), 'local\n');
    const before = git(project, 'status', '--porcelain');
    const info = await gitInfo(project); assert.equal(info.branch, 'main'); assert.equal(info.dirty, true);
    assert.ok(info.files.some((f) => f.path === 'untracked file.txt'));
    assert.equal(info.worktrees.length, 2); assert.ok(info.worktrees.find((t) => t.path === project).current);
    assert.ok(info.worktrees.some((t) => t.path === linked && t.branch === 'review'));
    assert.ok((await gitDiff(project)).diff.includes('+changed'));
    assert.equal(git(project, 'status', '--porcelain'), before);
    assert.equal((await gitInfo(root)).isRepo, false);
    const marker = join(root, 'filter-executed');
    await writeFile(join(project, '.gitattributes'), '*.txt filter=unsafe\n');
    git(project, 'config', 'filter.unsafe.clean', `touch '${marker}'; cat`);
    git(project, 'config', 'filter.unsafe.required', 'true');
    await gitInfo(project); await gitDiff(project);
    await assert.rejects(readFile(marker), { code: 'ENOENT' }, 'read-only inspection must not run configured filters');
    assert.deepEqual(parseStatus('R  new name\0old name\0?? next\0'), [{ status: 'R ', path: 'new name' }, { status: '??', path: 'next' }]);
    assert.equal(parseWorktrees('worktree /a\0HEAD abc\0detached\0locked reason\0\0', '/a')[0].locked, 'reason');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('activity and provisional usage are factual; persisted hydration restores tool output', () => {
  const state = createAgentState('main', 'Main', 'main'), reducer = new AgentReducer(state);
  reducer.apply({ type: 'agent_start' });
  reducer.apply({ type: 'tool_execution_start', toolCallId: 'a', toolName: 'read', args: { path: 'file' } });
  assert.equal(state.currentTool, 'read'); assert.ok(state.activity.some((a) => a.type === 'tool_execution_start'));
  reducer.apply({ type: 'message_update', usage: { totalTokens: 7, cost: { total: .01 } }, assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: '' } });
  assert.equal(state.currentUsage.totalTokens, 7);
  reducer.apply({ type: 'agent_settled' }); assert.equal(state.currentUsage, null);
  reducer.hydrate([
    { role: 'user', content: 'hello', timestamp: 123 },
    { role: 'assistant', content: [{ type: 'text', text: '# Result' }, { type: 'toolCall', id: 'a', name: 'read', arguments: {} }], stopReason: 'toolUse', timestamp: 124 },
    { role: 'toolResult', toolCallId: 'a', toolName: 'read', content: [{ type: 'text', text: 'contents' }], timestamp: 125 },
  ]);
  assert.equal(state.messages[0].at, 123); assert.ok(state.messages.some((m) => m.role === 'tool' && m.text === 'contents' && m.status === 'done'));
  assert.equal(state.phase, 'idle'); assert.equal(state.currentTool, null); assert.equal(state.lastActivityAt, 125);
});

test('real Pi: resume/rename/clone/archive/workspace/provider controls, isolated profiles and no model prompts', { timeout: 90_000 }, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pi-controls-test-')));
  const project = join(root, 'project'), other = join(root, 'other'), dataDir = join(root, 'data'), agentDir = join(root, 'agent');
  for (const path of [project, other, agentDir, join(dataDir, 'desktop-sessions')]) await mkdir(path, { recursive: true });
  const host = findPi(), pi = await loadPi(host);
  const sessionDir = join(dataDir, 'desktop-sessions');
  const seed = pi.SessionManager.create(project, sessionDir);
  seed.appendSessionInfo('Saved fixture');
  seed.appendMessage({ role: 'user', content: 'A stored question, not a live prompt', timestamp: 1000 });
  seed.appendMessage({ role: 'assistant', api: 'anthropic-messages', provider: 'anthropic', model: 'claude-sonnet-4-5', content: [{ type: 'text', text: '# Stored answer\n\n**Safe** Markdown.' }], timestamp: 1001, stopReason: 'stop', usage: { input: 10, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 13, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
  const originalKey = sessionKey(seed.getSessionFile());
  // Keep profile-based credentials/settings completely out of the real user's profile.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/(API_KEY|AUTH_TOKEN|ACCESS_TOKEN|GOOGLE_APPLICATION_CREDENTIALS|AWS_)/.test(key)));
  env.PI_CODING_AGENT_DIR = agentDir;
  const app = await createDesktop({ cwd: project, port: 0, host, dataDir,
    factory: (options) => new PiSession({ ...options, env }),
  });
  const base = app.url.split('/#')[0];
  const api = async (path, body, expected = 200) => {
    const response = await fetch(base + path, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${app.token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify({ ...body, requestId: randomUUID() }) : undefined });
    const data = await response.json(); assert.equal(response.status, expected, `${path}: ${JSON.stringify(data)}`); return data;
  };
  try {
    await app.sessions.get('main').ready;
    for (const endpoint of ['/api/providers', '/api/workspace', '/api/sessions', '/api/git', '/api/usage']) assert.equal((await fetch(base + endpoint)).status, 403);
    assert.ok((await api('/api/sessions')).sessions.some((s) => s.key === originalKey));
    await api('/api/sessions/resume', { key: originalKey });
    let main = app.sessions.get('main'); assert.ok(main.state.messages.some((m) => m.text.includes('Stored answer')));
    assert.equal(main.state.stats.tokens.total, 13);
    await api('/api/sessions/rename', { key: originalKey, name: 'Renamed safely' });
    assert.equal(main.state.sessionName, 'Renamed safely');
    await api('/api/sessions/clone', {});
    assert.notEqual(sessionKey(main.sessionFile), originalKey);
    assert.ok(main.state.messages.some((m) => m.text.includes('Stored answer')));
    await api('/api/sessions/archive', { key: originalKey, archived: true });
    assert.equal((await api('/api/sessions')).sessions.find((s) => s.key === originalKey).archived, true);
    await api('/api/sessions/resume', { key: originalKey }, 400);
    await api('/api/sessions/archive', { key: originalKey, archived: false });
    await api('/api/sessions/archive', { key: sessionKey(main.sessionFile), archived: true }, 400);
    await api('/api/sessions/resume', { key: '../auth.json' }, 400);
    const unchangedId = main.state.sessionId;
    await api('/api/workspace', { path: join(root, 'missing') }, 400);
    assert.equal(app.sessions.get('main').state.sessionId, unchangedId);
    main.state.phase = 'running';
    await api('/api/workspace', { path: other }, 400);
    await api('/api/providers/configure', { provider: 'deepseek', apiKey: 'fixture-not-a-real-key' }, 400);
    main.state.phase = 'idle';
    await api('/api/workspace/remember', { path: other });
    assert.ok((await api('/api/workspace')).recent.some((r) => r.path === other));
    await api('/api/workspace', { path: other });
    main = app.sessions.get('main'); assert.equal(main.state.cwd, other); assert.equal(main.state.messages.length, 0);
    const key = 'fixture-not-a-real-key';
    await api('/api/providers/configure', { provider: 'deepseek', apiKey: key });
    const providers = await api('/api/providers'); assert.equal(providers.providers.find((p) => p.id === 'deepseek').temporaryOverride, true);
    assert.ok(!JSON.stringify(await api('/api/state')).includes(key));
    assert.ok(!app.sessions.get('main').child.spawnargs.join(' ').includes(key));
    assert.ok(!(await readFile(join(dataDir, 'preferences.json'), 'utf8')).includes(key));
    await api('/api/providers/configure', { provider: 'deepseek', remove: true });
    assert.equal((await api('/api/providers')).providers.find((p) => p.id === 'deepseek').temporaryOverride, false);
    await api('/api/sessions/resume', { key: originalKey });
    assert.equal(app.sessions.get('main').state.cwd, project);
    assert.ok((await api('/api/usage')).agents[0].stats.tokens.total >= 13);
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});
