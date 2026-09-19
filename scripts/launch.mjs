import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findPi } from './pi-paths.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
let project = root;
if (args[0] === '--project') {
  if (!args[1]) throw new Error('--project requires a directory');
  project = resolve(args[1]);
  args.splice(0, 2);
}

const host = findPi();
if (host.version !== '0.85.1') {
  throw new Error(`This local release targets Pi 0.85.1; found ${host.version}. Revalidate before upgrading.`);
}

// Explicit per-process loading. No global install, trust override, or saved theme mutation.
const child = spawn(process.execPath, [
  host.cli,
  '--offline',
  '--no-extensions',
  '--tui-mode', 'regular',
  '--extension', join(root, 'extensions/index.ts'),
  '--theme', join(root, 'themes/pi-terminal.json'),
  '--use-theme', 'pi-terminal',
  ...args,
], { cwd: project, stdio: 'inherit', env: process.env });

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => child.kill(signal));
}
child.on('error', (error) => {
  console.error(`Unable to start Pi Workstation: ${error.message}`);
  process.exitCode = 1;
});
child.on('exit', (code) => { process.exitCode = code ?? 1; });
