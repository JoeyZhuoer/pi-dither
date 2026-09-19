import { readFile, realpath, stat } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute } from 'node:path';

// Only this explicitly supported, already-installed package is loaded. Never enable
// ambient/project extensions, install packages, or modify the user's Pi settings.
export async function desktopExtensions({ agentDir, kind, env = process.env }) {
  if (kind !== 'main') return { paths: [], status: 'restricted', message: 'Desktop subagent windows have built-in read-only tools only.' };
  if (env.PI_DESKTOP_SUBAGENTS === '0') return { paths: [], status: 'disabled', message: 'pi-subagents disabled by PI_DESKTOP_SUBAGENTS=0.' };
  const override = env.PI_DESKTOP_SUBAGENTS_ROOT;
  if (override && !isAbsolute(override)) throw new Error('PI_DESKTOP_SUBAGENTS_ROOT must be an absolute package directory.');
  const root = override || join(agentDir, 'npm', 'node_modules', 'pi-subagents');
  let manifest;
  try { manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')); }
  catch (error) {
    if (!override && error.code === 'ENOENT') return { paths: [], status: 'missing', message: 'pi-subagents is not installed in this Pi profile. Set PI_DESKTOP_SUBAGENTS_ROOT to an existing installation, then restart the desktop.' };
    throw new Error(`Cannot read pi-subagents package: ${error.message}`);
  }
  if (manifest.name !== 'pi-subagents' || !Array.isArray(manifest.pi?.extensions) || !manifest.pi.extensions.length) {
    throw new Error('Expected an installed pi-subagents package with extension entry points.');
  }
  const canonicalRoot = await realpath(root), paths = [];
  for (const entry of manifest.pi.extensions) {
    if (typeof entry !== 'string' || !/\.(?:ts|js|mjs)$/.test(entry)) throw new Error('Unsupported pi-subagents extension entry.');
    const path = await realpath(resolve(canonicalRoot, entry));
    const within = relative(canonicalRoot, path);
    if (!within || within.startsWith('..') || isAbsolute(within) || !(await stat(path)).isFile()) throw new Error('pi-subagents extension must be a file within its package.');
    paths.push(path);
  }
  return { paths, status: 'loaded', version: String(manifest.version || ''), message: 'pi-subagents loaded for the main agent. Its delegated agents use their own configured permissions, separate from read-only desktop windows.' };
}
