// Real AppKit + WKWebView smoke test with a relocated bundle and no credentials.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

if (process.platform !== 'darwin') throw new Error('Native smoke test requires a macOS GUI session.');
const app = resolve(process.env.PI_DITHER_TEST_APP || 'dist/Pi Dither.app');
// LaunchServices can target an already-running same-ID app. Never let a fixture
// redirect a user's installed instance into test mode.
const running = execFileSync('/bin/ps', ['-axo', 'command='], { encoding: 'utf8' });
assert.ok(!running.split('\n').some(line => /\/Contents\/MacOS\/PiDither(?:\s|$)/.test(line)), 'Quit existing Pi Dither instances before native bundle validation.');
execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
const root = await mkdtemp(join(tmpdir(), 'pi-dither-native-'));
let child;
try {
  const relocated = join(root, 'Relocated App With Spaces', 'Pi Dither.app');
  execFileSync('/usr/bin/ditto', [app, relocated]);
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', relocated]);
  const inventory = JSON.parse(await readFile(join(relocated, 'Contents/Resources/runtime-inventory.json'), 'utf8'));
  assert.equal(inventory.pi, '0.85.1'); assert.equal(inventory.subagents, '0.69.0');
  assert.ok(!inventory.packages.some((pkg) => ['pi-web-search', 'pi-atelier'].includes(pkg.name)));
  const sourceInventory = JSON.parse(await readFile(join(relocated, 'Contents/Resources/source-inventory.json'), 'utf8'));
  for (const required of ['desktop/public/windows.js', 'desktop/public/app.js', 'desktop/public/inspection.js', 'desktop/public/combobox.js', 'desktop/inspection.mjs']) {
    assert.ok(sourceInventory.files.some(file => file.path === required), `bundled feature missing: ${required}`);
  }
  for (const { path, sha256 } of sourceInventory.files) {
    assert.ok(!path.startsWith('/') && !path.split('/').includes('..') && /^(desktop\/|scripts\/|package\.json$)/.test(path));
    const digest = data => createHash('sha256').update(data).digest('hex');
    assert.equal(digest(await readFile(join(relocated, 'Contents/Resources/app', path))), sha256, path + ' packaged digest');
    assert.equal(digest(await readFile(resolve(path))), sha256, path + ' matches current source');
  }
  for (const { path, sha256 } of sourceInventory.buildInputs) {
    assert.ok(['macos/PiDither.swift', 'macos/Icon.swift', 'macos/SmokeChecks.js', 'scripts/build-macos.mjs'].includes(path));
    assert.equal(createHash('sha256').update(await readFile(resolve(path))).digest('hex'), sha256, path + ' build is current');
    if (path === 'macos/SmokeChecks.js') assert.equal(createHash('sha256').update(await readFile(join(relocated, 'Contents/Resources/validation/SmokeChecks.js'))).digest('hex'), sha256);
  }
  child = spawn(join(relocated, 'Contents/MacOS/PiDither'), ['--smoke-test', '--reset-window-layout'], {
    env: { HOME: root, PATH: '/usr/bin:/bin:/usr/sbin:/sbin', TMPDIR: process.env.TMPDIR || tmpdir(), PI_DITHER_SMOKE_ROOT: root },
    cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', (data) => { stdout = (stdout + data).slice(-8000); });
  child.stderr.on('data', (data) => { stderr = (stderr + data).slice(-8000); });
  const code = await new Promise((resolveExit, reject) => {
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error(`Native launch timed out: ${stdout}\n${stderr}`)); }, 90_000);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', (code) => { clearTimeout(timer); resolveExit(code); });
  });
  assert.equal(code, 0, `${stdout}\n${stderr}`); assert.match(stdout, /PASS: native WKWebView/); assert.match(stdout, /PASS: native feature checks/);
  assert.match(stdout, /PASS: window layout reset; unrelated preferences retained/);
  assert.ok(!stdout.includes('token='), 'native test output does not disclose the bootstrap token');
  const processes = execFileSync('/bin/ps', ['-axo', 'pid=,command='], { encoding: 'utf8' });
  assert.ok(!processes.split('\n').some((line) => line.includes(root)), 'no native/owned Pi process survives shutdown');
  console.log(stdout.trim());
  // Exercise the same LaunchServices route as Finder double-click, not only
  // direct executable launch. A separate temporary profile is still required.
  const launchOut = join(root, 'launchservices.stdout'), launchErr = join(root, 'launchservices.stderr');
  const launcher = spawn('/usr/bin/open', ['-n', '-W', '--env', `PI_DITHER_SMOKE_ROOT=${root}`, '--env', `HOME=${root}`, '--env', 'PATH=/usr/bin:/bin:/usr/sbin:/sbin', '--stdout', launchOut, '--stderr', launchErr, relocated, '--args', '--smoke-test'], { stdio: 'ignore' });
  const launchCode = await new Promise((resolveExit, reject) => {
    const timer = setTimeout(() => { launcher.kill(); reject(new Error('LaunchServices smoke timed out')); }, 90_000);
    launcher.once('error', (error) => { clearTimeout(timer); reject(error); });
    launcher.once('exit', (code) => { clearTimeout(timer); resolveExit(code); });
  });
  assert.equal(launchCode, 0);
  const launched = await readFile(launchOut, 'utf8');
  assert.match(launched, /PASS: native WKWebView/); assert.match(launched, /PASS: native feature checks/);
  assert.ok(!launched.includes('token='), 'LaunchServices does not disclose the bootstrap token');
  assert.ok(!execFileSync('/bin/ps', ['-axo', 'pid=,command='], { encoding: 'utf8' }).split('\n').some((line) => line.includes(root)), 'LaunchServices leaves no app/owned Pi process');
  console.log('PASS: Finder/LaunchServices route, relocated bundle, offline installed runtimes, private profile, deep signature and process cleanup.');
} finally {
  if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  const processes = () => execFileSync('/bin/ps', ['-axo', 'pid=,command='], { encoding: 'utf8' }).split('\n').filter((line) => line.includes(root));
  for (const line of processes()) {
    if (!line.includes('/Contents/MacOS/PiDither') && !line.includes('/usr/bin/open ')) continue;
    try { process.kill(Number(line.trim().split(/\s+/)[0]), 'SIGTERM'); } catch {}
  }
  for (let attempt = 0; attempt < 80 && processes().length; attempt++) await new Promise((done) => setTimeout(done, 100));
  if (processes().length) throw new Error(`Native test cleanup incomplete; isolated files retained at ${root}`);
  await rm(root, { recursive: true, force: true });
}
