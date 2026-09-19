import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import { createLayout, cleanLabel } from '../src/layout.mjs';
import { installWorkstation } from '../src/workstation.mjs';
import { findPi } from '../scripts/pi-paths.mjs';

const host = findPi();
const hostRequire = createRequire(join(host.root, 'package.json'));
const widthHelpers = await import(pathToFileURL(hostRequire.resolve('@earendil-works/pi-tui')));
// Test-only inspection of the installed schema/loader; production uses public imports only.
const themeDirectory = join(host.root, 'dist/modes/interactive/theme');
const { loadThemeFromPath } = await import(pathToFileURL(join(themeDirectory, 'theme.js')));
const themePath = new URL('../themes/pi-terminal.json', import.meta.url);
const theme = loadThemeFromPath(themePath.pathname, 'truecolor');
const layout = createLayout(widthHelpers);
const snapshot = {
  version: host.version,
  project: 'pi-terminal-ui',
  path: '~/Projects/pi-terminal-ui',
  model: 'test/local-model',
  session: 'Session 12345678',
};
const plain = (lines) => lines.map(stripVTControlCharacters).join('\n');

test('theme covers every installed token and loads in both color modes', () => {
  const schema = JSON.parse(readFileSync(join(themeDirectory, 'theme-schema.json'), 'utf8'));
  const json = JSON.parse(readFileSync(themePath, 'utf8'));
  assert.deepEqual(Object.keys(json.colors).sort(), Object.keys(schema.properties.colors.properties).sort());
  for (const alias of Object.values(json.colors)) assert.match(json.vars[alias], /^#[0-9a-f]{6}$/i);
  for (const mode of ['truecolor', '256color']) {
    assert.equal(loadThemeFromPath(themePath.pathname, mode).name, 'pi-terminal');
  }
});

test('both renderers fit narrow, normal and large terminals with real Pi cell measurements', () => {
  const adversarial = {
    ...snapshot,
    project: '解析器 👩🏽‍💻 e\u0301 ' + 'W'.repeat(500),
    path: '~/一个很长的目录/' + '🧑‍🚀'.repeat(100),
    model: '\x1b[31muntrusted\x1b[0m\nmodel',
    session: '\x1b]0;injected-title\x07name\twith\rcontrols',
  };
  for (const colorMode of ['truecolor', '256color']) {
    const currentTheme = loadThemeFromPath(themePath.pathname, colorMode);
    for (const width of [0, 1, 2, 10, 19, 20, 39, 40, 59, 60, 79, 80, 99, 100, 120, 200]) {
      for (const height of [8, 12, 16, 24, 32, 40]) {
        for (const options of [{}, { ascii: true }, { compact: true }]) {
          for (const renderer of Object.values(layout)) {
            for (const line of renderer(adversarial, width, height, currentTheme, options)) {
              assert.ok(widthHelpers.visibleWidth(line) <= width, `${width}x${height}: ${line}`);
              assert.ok(!/[\r\n\t\x07]/.test(line));
              assert.ok(!line.includes('injected-title'));
              assert.ok(!line.includes('\uFFFD'));
            }
          }
        }
      }
    }
  }
});

test('roomy view has real workspace, model and session; short view yields rows to the editor', () => {
  const wide = layout.renderHeader(snapshot, 120, 40, theme);
  assert.match(plain(wide), /01 \/ WORKSPACE/);
  assert.match(plain(wide), /test\/local-model/);
  assert.match(plain(wide), /Session 12345678/);
  assert.match(plain(wide), /02 \/ TRANSCRIPT/);
  assert.equal(wide.length, 8);
  assert.equal(layout.renderHeader(snapshot, 80, 24, theme).length, 5);
  assert.equal(layout.renderHeader(snapshot, 40, 24, theme).length, 2);
  assert.equal(layout.renderHeader(snapshot, 120, 40, theme, { compact: true }).length, 2);
  assert.deepEqual(layout.renderHeader(snapshot, 80, 8, theme), []);
  assert.deepEqual(layout.renderInputRail(snapshot, 80, 8, theme), []);
});

test('ASCII option changes only owned chrome; labels cannot inject terminal controls', () => {
  const text = plain(layout.renderHeader(snapshot, 120, 40, theme, { ascii: true }));
  assert.ok(!/[┌┐└┘─│├┤┬]/.test(text));
  assert.match(text, /\+-/);
  assert.equal(cleanLabel('one\n\x1b[31mtwo\x1b[0m\u202ethree'), 'one two three');
});

function fixture(mode = 'tui') {
  const events = new Map();
  const commands = new Map();
  const widgets = new Map();
  let header;
  let indicator;
  let headerSets = 0;
  let requests = 0;
  let activeTheme = theme;
  const tui = { terminal: { rows: 40 }, requestRender: () => { requests++; } };
  const ctx = {
    mode,
    cwd: '/tmp/workstation-fixture',
    model: { provider: 'test', id: 'local-model' },
    sessionManager: { getSessionName: () => 'Test session', getSessionId: () => '12345678-abcd' },
    ui: {
      get theme() { return activeTheme; },
      setHeader(factory) {
        header?.dispose();
        header = factory?.(tui, activeTheme);
        headerSets++;
      },
      setWidget(key, factory) {
        widgets.get(key)?.dispose();
        if (factory) widgets.set(key, factory(tui, activeTheme));
        else widgets.delete(key);
      },
      setWorkingIndicator(value) { indicator = value; },
      notify() {},
    },
  };
  const pi = {
    on(name, callback) { events.set(name, callback); },
    registerCommand(name, command) { commands.set(name, command); },
  };
  installWorkstation(pi, { version: host.version, ...widthHelpers });
  return {
    ctx, events, commands, widgets,
    emit(name) { return events.get(name)?.({}, ctx); },
    get header() { return header; },
    get indicator() { return indicator; },
    get headerSets() { return headerSets; },
    get requests() { return requests; },
    set theme(value) { activeTheme = value; },
    command(value) { return commands.get('workstation').handler(value, ctx); },
  };
}

test('extension is presentation-only and does not register input, provider, tool or prompt hooks', () => {
  const f = fixture();
  assert.deepEqual([...f.events.keys()].sort(), [
    'model_select', 'session_info_changed', 'session_shutdown', 'session_start', 'session_tree', 'thinking_level_select',
  ]);
  assert.deepEqual([...f.commands.keys()], ['workstation']);
  assert.equal(f.headerSets, 0, 'factory does not create session resources');
  assert.equal(f.emit('session_start'), undefined);
  assert.equal(f.widgets.size, 1);
  assert.deepEqual(f.indicator, { frames: ['*'] });
});

test('repeated start, disable, enable and shutdown do not duplicate or retain components', async () => {
  const f = fixture();
  f.emit('session_start');
  const oldHeader = f.header;
  f.emit('session_start');
  assert.equal(f.headerSets, 1);
  await f.command('off');
  assert.equal(f.header, undefined);
  assert.equal(f.indicator, undefined);
  assert.equal(f.widgets.size, 0);
  assert.deepEqual(oldHeader.render(120), []);
  const requests = f.requests;
  f.emit('model_select');
  assert.equal(f.requests, requests);
  await f.command('on');
  assert.equal(f.widgets.size, 1);
  assert.match(plain(f.header.render(120)), /PI \/ WORKSTATION/);
  f.emit('session_shutdown');
  const headerSets = f.headerSets;
  f.emit('session_shutdown');
  assert.equal(f.headerSets, headerSets);
  assert.equal(f.widgets.size, 0);
});

test('theme invalidation and model changes render current values without stale colors', () => {
  const f = fixture();
  f.emit('session_start');
  const before = f.header.render(120);
  f.theme = loadThemeFromPath(join(themeDirectory, 'light.json'), 'truecolor');
  f.header.invalidate();
  assert.notDeepEqual(f.header.render(120), before);
  f.ctx.model = undefined;
  assert.equal(f.emit('model_select'), undefined);
  assert.match(plain(f.header.render(120)), /No model selected/);
  assert.equal(f.requests, 2);
});

test('RPC, JSON and print runs never invoke terminal UI', async () => {
  for (const mode of ['rpc', 'json', 'print']) {
    const f = fixture(mode);
    f.ctx.ui = new Proxy({}, { get() { throw new Error('TUI accessed outside tui mode'); } });
    for (const event of f.events.keys()) f.emit(event);
    await f.command('on');
    await f.command('off');
    assert.equal(f.headerSets, 0);
  }
});
