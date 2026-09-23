import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { realpath, stat, readdir, readFile, writeFile, mkdir, rename, lstat } from 'node:fs/promises';
import { resolve, dirname, basename, join, sep } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { findPi } from '../scripts/pi-paths.mjs';

const exec = promisify(execFile);
export async function directory(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 4096 || value.includes('\0')) throw new Error('Enter a valid directory path');
  const path = await realpath(resolve(value.startsWith('~/') ? join(homedir(), value.slice(2)) : value));
  if (!(await stat(path)).isDirectory()) throw new Error('Workspace must be a directory');
  return path;
}
export async function browseDirectory(path) {
  path = await directory(path);
  const entries = await readdir(path, { withFileTypes: true });
  const ordered = entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
  return { listingPath: path, parent: dirname(path) === path ? null : dirname(path),
    entries: ordered.slice(0, 500).map((entry) => ({ name: entry.name, path: join(path, entry.name), type: entry.isDirectory() ? 'directory' : 'file' })),
    truncated: entries.length > 500 };
}
export class DesktopPreferences {
  constructor(dataDir) { this.path = join(dataDir, 'preferences.json'); this.recent = []; this.archived = []; }
  async load() {
    try {
      const value = JSON.parse(await readFile(this.path, 'utf8'));
      this.recent = Array.isArray(value.recent) ? value.recent.filter((p) => typeof p === 'string').slice(0, 20) : [];
      this.archived = Array.isArray(value.archived) ? value.archived.filter((p) => typeof p === 'string').slice(0, 5000) : [];
    } catch (error) { if (error.code !== 'ENOENT') this.warning = 'Saved desktop preferences could not be read.'; }
  }
  async save() {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temp = `${this.path}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify({ recent: this.recent, archived: this.archived }, null, 2), { mode: 0o600, flag: 'wx' });
    await rename(temp, this.path);
  }
  async remember(path) { this.recent = [path, ...this.recent.filter((p) => p !== path)].slice(0, 20); await this.save(); }
  async forget(path) { this.recent = this.recent.filter((p) => p !== path); await this.save(); }
  roots(cwd) { return [...new Set([cwd, ...this.recent])].map((path) => ({ path, name: basename(path) || path })); }
}
async function git(cwd, args, maxBuffer = 2_000_000) {
  const options = { cwd, timeout: 10_000, maxBuffer, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' } };
  // Even read commands can invoke repository-configured clean/process filters.
  // Read names only, then disable all such helpers rather than executing them.
  let names = '';
  try { names = (await exec('git', ['config', '--null', '--name-only', '--get-regexp', '^filter\\..*\\.(clean|process|required)$'], options)).stdout; }
  catch (error) { if (error.code !== 1) throw error; }
  const filters = names.split('\0').filter(Boolean);
  if (filters.length > 1000) throw new Error('Too many Git filter settings to inspect safely');
  const overrides = filters.flatMap((name) => ['-c', `${name}=${name.endsWith('.required') ? 'false' : ''}`]);
  const result = await exec('git', ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', ...overrides, ...args], options);
  return result.stdout;
}
export function parseStatus(text) {
  const records = text.split('\0'), files = [];
  for (let i = 0; i < records.length; i++) {
    const record = records[i]; if (!record) continue;
    const status = record.slice(0, 2), path = record.slice(3);
    if (/[RC]/.test(status)) i++;
    files.push({ status, path });
  }
  return files;
}
export function parseWorktrees(text, cwd) {
  const result = []; let tree;
  for (const field of text.split('\0')) {
    if (!field) { tree = null; continue; }
    const split = field.indexOf(' '), key = split < 0 ? field : field.slice(0, split), value = split < 0 ? '' : field.slice(split + 1);
    if (key === 'worktree') { tree = { path: value, branch: '', head: '', current: resolve(value) === resolve(cwd) }; result.push(tree); }
    else if (tree && key === 'HEAD') tree.head = value;
    else if (tree && key === 'branch') tree.branch = value.replace(/^refs\/heads\//, '');
    else if (tree && ['bare', 'detached', 'locked', 'prunable'].includes(key)) tree[key] = value || true;
  }
  return result;
}
export async function gitInfo(cwd) {
  let root;
  try { root = (await git(cwd, ['rev-parse', '--show-toplevel'])).trim(); }
  catch (error) {
    if (error.code === 128 && /not a git repository/.test(error.stderr ?? '')) return { isRepo: false, files: [], worktrees: [] };
    throw new Error('Git repository inspection failed. Check the directory and Git installation.');
  }
  const [branch, head, status, trees] = await Promise.all([
    git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => ''),
    git(root, ['rev-parse', '--verify', 'HEAD']).catch(() => ''),
    git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=normal']),
    git(root, ['worktree', 'list', '--porcelain', '-z']),
  ]);
  const files = parseStatus(status);
  return { isRepo: true, root, branch: branch.trim(), head: head.trim(), dirty: files.length > 0,
    files: files.slice(0, 1000), truncated: files.length > 1000, worktrees: parseWorktrees(trees, root) };
}
export async function gitDiff(cwd) {
  const [unstaged, staged] = await Promise.all([
    git(cwd, ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--']),
    git(cwd, ['diff', '--cached', '--no-ext-diff', '--no-textconv', '--no-color', '--']),
  ]);
  const text = `UNSTAGED\n${unstaged}\nSTAGED\n${staged}`;
  return { diff: text.slice(0, 128_000), truncated: text.length > 128_000 };
}
export async function loadPi(host = findPi()) { return import(pathToFileURL(join(host.root, 'dist/index.js')).href); }
export const sessionKey = (path) => createHash('sha256').update(resolve(path)).digest('hex').slice(0, 32);
// Pi Dither stores and lists sessions in the standard Pi session root
// (~/.pi/agent/sessions) so the app and the `pi` CLI share one store.
export class DesktopSessions {
  constructor({ preferences, host }) { this.preferences = preferences; this.host = host; }
  async root() { return join((await loadPi(this.host)).getAgentDir(), 'sessions'); }
  async list(agents) {
    const pi = await loadPi(this.host);
    const root = resolve(join(pi.getAgentDir(), 'sessions'));
    const items = await pi.SessionManager.listAll();
    // Reject symlinks and entries outside the Pi session root, even if a future
    // Pi listing expands its scope.
    const own = [];
    for (const item of items) {
      try {
        const path = resolve(item.path);
        if (path === root || !path.startsWith(root + sep) || (await lstat(item.path)).isSymbolicLink()) continue;
        own.push(item);
      } catch { /* A disappeared session is omitted, never replaced with another path. */ }
    }
    const rows = own.map((item) => ({ key: sessionKey(item.path), path: item.path, name: item.name || item.firstMessage?.slice(0, 80) || 'Unnamed session',
      cwd: item.cwd, updated: item.modified, messageCount: item.messageCount, preview: item.firstMessage?.slice(0, 180) || '',
      active: [...agents.values()].some((agent) => agent.state.connected && agent.sessionFile === item.path),
      archived: this.preferences.archived.includes(sessionKey(item.path)), persisted: true }));
    for (const agent of agents.values()) {
      if (!agent.state.connected || !agent.sessionFile || rows.some((row) => row.path === agent.sessionFile)) continue;
      rows.unshift({ key: sessionKey(agent.sessionFile), path: agent.sessionFile, name: agent.state.sessionName || agent.state.name,
        cwd: agent.state.cwd, updated: new Date(), messageCount: agent.state.messages.length, preview: '', active: true, archived: false, persisted: false });
    }
    return rows.sort((a, b) => new Date(b.updated) - new Date(a.updated));
  }
  async get(key, agents) {
    if (typeof key !== 'string' || !/^[a-f0-9]{32}$/.test(key)) throw new Error('Invalid session key');
    const row = (await this.list(agents)).find((item) => item.key === key);
    if (!row) throw new Error('Session not found in the Pi session store');
    if (row.persisted) {
      const root = resolve(await this.root()), path = await realpath(row.path);
      if (path === root || !path.startsWith(root + sep)) throw new Error('Session path is outside the Pi session store');
    }
    return row;
  }
  async rename(row, name) {
    const pi = await loadPi(this.host);
    pi.SessionManager.open(row.path).appendSessionInfo(name);
  }
}
