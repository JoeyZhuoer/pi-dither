import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { desktopExtensions } from '../desktop/extensions.mjs';
import { toolCatalog, setSessionTools } from '../desktop/tools.mjs';
import { PiSession } from '../desktop/pi-session.mjs';
import { AgentReducer, createAgentState } from '../desktop/protocol.mjs';
import { findPi } from '../scripts/pi-paths.mjs';

const installedRoot = process.env.PI_DESKTOP_SUBAGENTS_ROOT || join(process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent'), 'npm', 'node_modules', 'pi-subagents');
const installed = await readFile(join(installedRoot, 'package.json'), 'utf8').then(() => true, () => false);

test('desktop extension discovery is explicit, local, main-only and honors disable/missing states', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-ext-discovery-'));
  try {
    assert.equal((await desktopExtensions({ agentDir: root, kind: 'main', env: {} })).status, 'missing');
    assert.equal((await desktopExtensions({ agentDir: root, kind: 'main', env: { PI_DESKTOP_SUBAGENTS: '0', PI_DESKTOP_SUBAGENTS_ROOT: '/missing' } })).status, 'disabled');
    assert.equal((await desktopExtensions({ agentDir: root, kind: 'subagent', env: { PI_DESKTOP_SUBAGENTS_ROOT: '/missing' } })).status, 'restricted');
    const pkg = join(root, 'npm/node_modules/pi-subagents'); await mkdir(pkg, { recursive: true });
    const manifest = { name: 'pi-subagents', version: 'fixture', pi: { extensions: ['./index.js'] } };
    await writeFile(join(pkg, 'package.json'), JSON.stringify(manifest)); await writeFile(join(pkg, 'index.js'), 'export default () => {};');
    const discovered = await desktopExtensions({ agentDir: root, kind: 'main', env: {} });
    assert.deepEqual(discovered.paths, [await realpath(join(pkg, 'index.js'))]);
    assert.equal(discovered.status, 'loaded');
    await assert.rejects(desktopExtensions({ agentDir: root, kind: 'main', env: { PI_DESKTOP_SUBAGENTS_ROOT: 'relative/path' } }), /absolute/);
    await writeFile(join(pkg, '../outside.js'), ''); manifest.pi.extensions = ['../outside.js'];
    await writeFile(join(pkg, 'package.json'), JSON.stringify(manifest));
    await assert.rejects(desktopExtensions({ agentDir: root, kind: 'main', env: {} }), /within its package/);
    manifest.name = 'different-package'; await writeFile(join(pkg, 'package.json'), JSON.stringify(manifest));
    await assert.rejects(desktopExtensions({ agentDir: root, kind: 'main', env: {} }), /Expected/);
    // A profile that configures and installs its own package is left to normal
    // discovery: no explicit path is returned, so pi-subagents cannot load twice.
    manifest.name = 'pi-subagents'; manifest.pi.extensions = ['./index.js'];
    await writeFile(join(pkg, 'package.json'), JSON.stringify(manifest));
    await writeFile(join(root, 'settings.json'), JSON.stringify({ packages: ['npm:pi-subagents'] }));
    const selfProvided = await desktopExtensions({ agentDir: root, kind: 'main', env: {} });
    assert.deepEqual(selfProvided.paths, []); assert.equal(selfProvided.status, 'loaded');
    assert.match(selfProvided.message, /profile/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('catalog exposes every loaded main tool and keeps the subagent read-only ceiling', () => {
  const path = '/approved/index.ts'; let active = [];
  const session = { sessionId: 'one', isIdle: true, pendingMessageCount: 0,
    getAllTools: () => [
      { name: 'read', description: 'Read', sourceInfo: { source: 'builtin' } },
      { name: 'subagent', description: 'Delegate', parameters: {}, sourceInfo: { source: 'cli', path } },
      { name: 'web_search', description: 'Search', sourceInfo: { source: 'cli', path: '/other/index.ts' } },
    ], getActiveToolNames: () => active, setActiveToolsByName: names => { active = names; },
  };
  assert.deepEqual(toolCatalog(session, 'main'), [
    { name: 'read', description: 'Read' },
    { name: 'subagent', description: 'Delegate' },
    { name: 'web_search', description: 'Search' },
  ]);
  assert.deepEqual(toolCatalog(session, 'subagent'), [{ name: 'read', description: 'Read' }]);
  assert.throws(() => setSessionTools(session, 'subagent', { sessionId: 'one', tools: ['subagent'] }), /Subagents/);
  assert.deepEqual(setSessionTools(session, 'main', { sessionId: 'one', tools: ['subagent', 'web_search'] }), ['subagent', 'web_search']);
  assert.deepEqual(setSessionTools(session, 'main', { sessionId: 'one', tools: [] }), []);
});

test('extension notifications are bounded, visible custom messages hydrate once, hidden context stays hidden', () => {
  const state = createAgentState('main', 'Main', 'main'), reducer = new AgentReducer(state);
  const visible = { role: 'custom', customType: 'subagent-notify', content: [{ type: 'text', text: '<script>literal</script>' }], display: true, timestamp: 123 };
  reducer.apply({ type: 'message_start', message: visible }); reducer.apply({ type: 'message_end', message: visible });
  assert.equal(state.messages.length, 1); assert.equal(state.messages[0].role, 'extension');
  reducer.hydrate([visible, { ...visible, display: false }]);
  assert.equal(state.messages.length, 1); assert.equal(state.messages[0].text, '<script>literal</script>');
  const agent = Object.create(PiSession.prototype); Object.assign(agent, { state, reducer, secrets: ['private-key'], emit() {}, child: { stdin: { write() {} } } });
  agent.receive({ type: 'extension_ui_request', method: 'notify', message: 'private-key ' + 'x'.repeat(10_000) });
  assert.ok(state.notice.includes('[redacted]')); assert.ok(state.notice.length < 4200);
  agent.receive({ type: 'extension_ui_request', method: 'confirm', id: 'confirm-1' });
  assert.match(state.notice, /cancelled/);
});

test('installed pi-subagents: real RPC defaults, selection, dynamic supervisor/new/clone, restricted children; no prompts', { skip: !installed, timeout: 90_000 }, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pi-ext-rpc-'))), sessionDir = join(root, 'sessions'), profile = join(root, 'profile');
  await mkdir(sessionDir); await mkdir(profile);
  // The profile's own extensions load with normal package discovery while project
  // extensions stay untrusted. Both fixtures throw, which must be reported rather
  // than fatal; only the profile copy may appear in the load errors.
  await mkdir(join(profile, 'extensions'), { recursive: true });
  await writeFile(join(profile, 'extensions', 'unrelated.ts'), 'throw new Error("UNRELATED PROFILE EXTENSION LOADED");');
  await mkdir(join(root, '.pi', 'extensions'), { recursive: true });
  await writeFile(join(root, '.pi', 'extensions', 'unrelated.ts'), 'throw new Error("UNRELATED PROJECT EXTENSION LOADED");');
  await writeFile(join(profile, 'settings.json'), '{"compaction":{"enabled":false}}');
  const settingsBefore = await readFile(join(profile, 'settings.json'), 'utf8');
  const env = { PATH: process.env.PATH, HOME: root, PI_CODING_AGENT_DIR: profile, PI_OFFLINE: '1', PI_DESKTOP_SUBAGENTS_ROOT: installedRoot };
  const host = findPi(), all = [];
  const start = async (kind, tools, sessionPath) => { const agent = new PiSession({ id: kind, name: 'Extension regression', kind, cwd: root, host, sessionDir, sessionPath, env, tools }); all.push(agent); await agent.ready; return agent; };
  try {
    const main = await start('main');
    const authBefore = await readFile(join(profile, 'auth.json'), 'utf8');
    for (const name of ['read', 'bash', 'edit', 'write', 'subagent', 'bg_wait', 'subagent_supervisor']) {
      assert.ok(main.state.activeTools.includes(name), `default ${name} active`);
      assert.ok(main.state.availableTools.some(tool => tool.name === name), `catalog exposes ${name}`);
    }
    assert.equal(main.state.extensionStatus.status, 'loaded');
    assert.match(main.state.extensionStatus.loadErrors ?? '', /UNRELATED PROFILE EXTENSION LOADED/, 'the profile extension is discovered');
    assert.doesNotMatch(main.state.extensionStatus.loadErrors ?? '', /UNRELATED PROJECT EXTENSION LOADED/, 'the project extension stays untrusted');
    assert.ok((await main.command('get_commands')).commands.some(c => c.name === 'subagents-guide'));
    const selection = ['read', 'subagent', 'bg_wait', 'subagent_supervisor'];
    await main.act('tools', { tools: selection }); await main.act('new', {});
    assert.deepEqual(main.state.activeTools, selection, 'dynamic supervisor registration must precede selection restoration');
    await main.act('tools', { tools: [] }); await main.act('new', {});
    assert.deepEqual(main.state.activeTools, []);
    const pi = await import(pathToFileURL(join(host.root, 'dist/index.js')).href);
    const seed = pi.SessionManager.create(root, sessionDir);
    seed.appendThinkingLevelChange('off');
    seed.appendMessage({ role: 'user', content: 'Stored fixture, never sent', timestamp: 1 });
    seed.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'Stored answer' }], api: 'anthropic-messages', provider: 'anthropic', model: 'claude-sonnet-4-5', timestamp: 2, stopReason: 'stop', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
    const resumed = await start('main', [], seed.getSessionFile());
    await resumed.act('clone', {}); assert.deepEqual(resumed.state.activeTools, []);
    assert.equal(resumed.state.messages.length, 2);
    const child = await start('subagent', []);
    assert.deepEqual(child.state.activeTools, []); assert.equal(child.state.extensionStatus.status, 'restricted');
    assert.deepEqual(child.state.availableTools.map(t => t.name).sort(), ['find', 'grep', 'ls', 'read']);
    await assert.rejects(child.act('tools', { tools: ['subagent'] }), /Subagents/);
    assert.equal(main.state.messages.length, 0); assert.equal(child.state.messages.length, 0);
    assert.equal(await readFile(join(profile, 'settings.json'), 'utf8'), settingsBefore);
    assert.equal(await readFile(join(profile, 'auth.json'), 'utf8'), authBefore);
    // Execute the installed extension's actual wrapped management tool in a separate
    // credential-free SDK process. No child launch or model/provider request occurs.
    const program = `
      import assert from 'node:assert/strict';
      const pi = await import(${JSON.stringify(pathToFileURL(join(host.root, 'dist/index.js')).href)});
      const modelRuntime = await pi.ModelRuntime.create({allowModelNetwork:false});
      const runtime = await pi.createAgentSessionRuntime(async ({cwd,sessionManager,sessionStartEvent}) => {
        const services = await pi.createAgentSessionServices({cwd,modelRuntime,settingsManager:pi.SettingsManager.create(cwd,pi.getAgentDir(),{projectTrusted:false}),resourceLoaderOptions:{noExtensions:true,additionalExtensionPaths:[${JSON.stringify(installedRoot)}]}});
        return {...await pi.createAgentSessionFromServices({services,sessionManager,sessionStartEvent}),services,diagnostics:services.diagnostics};
      }, {cwd:process.cwd(),agentDir:pi.getAgentDir(),sessionManager:pi.SessionManager.inMemory()});
      try {
        await runtime.session.bindExtensions({mode:'rpc'});
        const tool = runtime.session.agent.state.tools.find(t=>t.name==='subagent'); assert.ok(tool);
        const result = await tool.execute('desktop-list-check',{action:'list'},new AbortController().signal);
        assert.match(JSON.stringify(result.content),/worker/); assert.match(JSON.stringify(result.content),/reviewer/);
        assert.equal(runtime.session.messages.length,0);
        console.log('PASS: installed subagent management tool executed; no child/model launch');
      } finally {await runtime.dispose();}
    `;
    const result = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', program], { cwd: root, env, timeout: 45_000 });
    assert.match(result.stdout, /PASS:/);
  } finally { await Promise.all(all.map(a => a.close())); await rm(root, { recursive: true, force: true }); }
});
