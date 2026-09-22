import { readFile, realpath, stat } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute } from 'node:path';

// The main agent loads every installed/configured Pi package through the normal
// resource loader (global profile settings only; the project stays untrusted).
// The bundled pi-subagents copy is added as an explicit extension path only when
// the profile does not configure its own package, so it never loads twice.
// Read-only subagent windows keep their built-in read-only tools and no
// extensions of their own.
export async function desktopExtensions({ agentDir, kind, env = process.env }) {
  if (kind !== 'main') return { paths: [], status: 'restricted', message: 'Desktop subagent windows have built-in read-only tools only.' };
  if (env.PI_DESKTOP_SUBAGENTS === '0') return { paths: [], status: 'disabled', message: 'Extensions are disabled for the main agent by PI_DESKTOP_SUBAGENTS=0.' };
  const fallback = await bundledSubagents({ agentDir, env });
  if (await profileHasSubagents(agentDir)) {
    return { paths: [], status: 'loaded', version: '', message: 'Installed Pi packages load for the main agent; pi-subagents comes from this profile.' };
  }
  if (!fallback) {
    return { paths: [], status: 'missing', message: 'pi-subagents is neither configured in this Pi profile nor bundled. Set PI_DESKTOP_SUBAGENTS_ROOT to an existing installation, then restart the desktop.' };
  }
  return { paths: fallback.paths, status: 'loaded', version: fallback.version,
    message: 'Installed Pi packages load for the main agent; pi-subagents uses the bundled copy because this profile does not configure one.' };
}

// The bundled (or explicitly overridden) pi-subagents package, validated so an
// escaping or malformed entry can never be loaded.
async function bundledSubagents({ agentDir, env }) {
  const override = env.PI_DESKTOP_SUBAGENTS_ROOT;
  if (override && !isAbsolute(override)) throw new Error('PI_DESKTOP_SUBAGENTS_ROOT must be an absolute package directory.');
  const root = override || join(agentDir, 'npm', 'node_modules', 'pi-subagents');
  let manifest;
  try { manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')); }
  catch (error) {
    if (!override && error.code === 'ENOENT') return null;
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
  return { paths, version: String(manifest.version || '') };
}

// True when the profile lists a pi-subagents package and its installed copy is
// present, i.e. the normal resource loader will load it without help.
async function profileHasSubagents(agentDir) {
  try {
    const settings = JSON.parse(await readFile(join(agentDir, 'settings.json'), 'utf8'));
    const packages = Array.isArray(settings?.packages) ? settings.packages : [];
    if (!packages.some((pkg) => String(typeof pkg === 'string' ? pkg : pkg?.source ?? '').includes('pi-subagents'))) return false;
    await stat(join(agentDir, 'npm', 'node_modules', 'pi-subagents', 'package.json'));
    return true;
  } catch { return false; }
}
