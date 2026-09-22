// Offline packaging from explicitly selected, already-installed runtimes.
import { cp, mkdir, readFile, writeFile, rm, readdir, lstat, realpath, chmod, symlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { findPi } from './pi-paths.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const metadata = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
if (process.platform !== 'darwin') throw new Error('Build this application on macOS with Xcode Command Line Tools.');
if (process.arch !== 'arm64') throw new Error('This release is validated only for Apple Silicon. Build/validate an Intel variant separately.');
if (process.version !== 'v22.23.2') throw new Error('This release packages the validated Node 22.23.2 runtime.');
const pi = findPi();
if (pi.version !== '0.85.1') throw new Error('Bundled core Pi must be 0.85.1.');
const extension = await realpath(process.env.PI_DESKTOP_SUBAGENTS_ROOT || join(homedir(), '.pi/agent/npm/node_modules/pi-subagents'));
const extensionMetadata = JSON.parse(await readFile(join(extension, 'package.json'), 'utf8'));
if (extensionMetadata.name !== 'pi-subagents' || extensionMetadata.version !== '0.69.0') throw new Error('This build requires the validated pi-subagents 0.69.0 installation.');
const dist = process.env.PI_DITHER_BUILD_DIR ? resolve(process.env.PI_DITHER_BUILD_DIR) : join(root, 'dist'), app = join(dist, 'Pi Dither.app'), stage = join(dist, '.Pi-Dither-build.app');
await mkdir(dist, { recursive: true });
await rm(stage, { recursive: true, force: true });
const contents = join(stage, 'Contents'), resources = join(contents, 'Resources'), runtime = join(resources, 'runtime');
await mkdir(join(contents, 'MacOS'), { recursive: true });
await mkdir(join(runtime, 'bin'), { recursive: true });
const run = (exe, args) => execFileSync(exe, args, { cwd: root, stdio: 'pipe' });
const packageInventory = [];
const appSource = join(resources, 'app');
await mkdir(appSource, { recursive: true });
// Deliberately never copy the checkout wholesale (.local/auth/sessions/Git).
const appFiles = [
  'package.json', 'scripts/pi-paths.mjs',
  ...['server', 'pi-session', 'protocol', 'controls', 'workspace', 'tools', 'extensions', 'rpc-host', 'delegations', 'delegation-bridge', 'inspection', 'subagent-slots', 'native-host'].map((name) => `desktop/${name}.mjs`),
  ...['app.js', 'background.js', 'particles.js', 'delegated.js', 'inspection.js', 'inspection.css', 'combobox.js', 'combobox.css', 'features.js', 'features.css', 'markdown.js', 'markdown.css', 'windows.js', 'index.html', 'styles.css', 'assets/VT323-Regular.ttf', 'assets/OFL.txt'].map((name) => `desktop/public/${name}`),
];
for (const path of appFiles) await cp(join(root, path), join(appSource, path));
const hashFiles = (paths, base) => Promise.all(paths.map(async (path) => ({ path, sha256: createHash('sha256').update(await readFile(join(base, path))).digest('hex') })));
await writeFile(join(resources, 'source-inventory.json'), JSON.stringify({ application: metadata.version,
  files: await hashFiles(appFiles, appSource),
  buildInputs: await hashFiles(['macos/PiDither.swift', 'macos/Icon.swift', 'macos/SmokeChecks.js', 'scripts/build-macos.mjs'], root),
}, null, 2) + '\n');
// Executed only by the isolated --smoke-test path; never served by the local API.
await mkdir(join(resources, 'validation'), { recursive: true });
await cp(join(root, 'macos/SmokeChecks.js'), join(resources, 'validation/SmokeChecks.js'));
await cp(process.execPath, join(runtime, 'bin/node'));
await chmod(join(runtime, 'bin/node'), 0o755);
const nodeLicense = process.env.PI_DITHER_NODE_LICENSE || join(dirname(dirname(process.execPath)), 'LICENSE');
if (!existsSync(nodeLicense)) throw new Error('Set PI_DITHER_NODE_LICENSE to the bundled Node distribution LICENSE.');
await cp(nodeLicense, join(runtime, 'NODE-LICENSE.txt'));
await mkdir(join(runtime, 'pi'), { recursive: true });
for (const entry of ['dist', 'node_modules', 'docs', 'examples', 'package.json', 'README.md', 'CHANGELOG.md', 'LICENSE', 'npm-shrinkwrap.json']) {
  if (existsSync(join(pi.root, entry))) await cp(join(pi.root, entry), join(runtime, 'pi', entry), { recursive: true, verbatimSymlinks: true });
}
// The npm core tarball omits its monorepo license. Keep the exact v0.85.1
// license in source as well (Git blob b0a8e9b81083294360c69b4ec45d3d39a2b28197).
if (!existsSync(join(runtime, 'pi/LICENSE'))) await cp(join(root, 'macos/licenses/PI-LICENSE.txt'), join(runtime, 'pi/LICENSE'));
await symlink('../pi/dist/bundle/cli.js', join(runtime, 'bin/pi'));

function resolvePackage(name, from) {
  const require = createRequire(join(from, 'package.json'));
  for (const base of require.resolve.paths(name) ?? []) {
    const candidate = join(base, name);
    if (existsSync(join(candidate, 'package.json'))) return candidate;
  }
  throw new Error(`Missing installed runtime dependency: ${name}`);
}
const copied = new Map();
async function copyExtensionPackage(source) {
  const info = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
  if (copied.has(info.name)) {
    if (copied.get(info.name) !== info.version) throw new Error(`Conflicting extension dependency versions: ${info.name}`);
    return;
  }
  copied.set(info.name, info.version);
  const target = join(runtime, 'extensions/node_modules', info.name);
  if (info.name === 'pi-subagents') {
    await mkdir(target, { recursive: true });
    for (const item of ['index.ts', 'index.js', 'src', 'agents', 'skills', 'prompts', 'docs', 'package.json', 'README.md', 'CHANGELOG.md', 'LICENSE', 'install.mjs']) {
      if (existsSync(join(source, item))) await cp(join(source, item), join(target, item), { recursive: true, verbatimSymlinks: true });
    }
  } else {
    await cp(source, target, { recursive: true, verbatimSymlinks: true, filter: (path) => {
      const pieces = relative(source, path).split('/');
      return !pieces.some((part) => ['node_modules', '.git', '.local', '.env'].includes(part));
    } });
  }
  for (const name of Object.keys(info.dependencies ?? {})) await copyExtensionPackage(resolvePackage(name, source));
}
await copyExtensionPackage(extension);
// Peer packages resolve inside the app, never through the developer's global Pi.
for (const name of ['pi-agent-core', 'pi-ai', 'pi-coding-agent', 'pi-tui']) {
  const target = join(runtime, 'extensions/node_modules/@earendil-works', name);
  await mkdir(dirname(target), { recursive: true });
  const peer = name === 'pi-coding-agent' ? join(runtime, 'pi') : join(runtime, 'pi/node_modules/@earendil-works', name);
  await symlink(relative(dirname(target), peer), target);
}

async function inspectTree(path) {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const file = join(path, entry.name);
    if (entry.isSymbolicLink()) {
      const destination = await realpath(file);
      if (!destination.startsWith(runtime + '/')) throw new Error(`Bundle symlink escapes runtime: ${relative(runtime, file)}`);
    } else if (entry.isDirectory()) await inspectTree(file);
    else if (entry.name === 'package.json') {
      try { const info = JSON.parse(await readFile(file, 'utf8')); if (info.name && info.version) packageInventory.push({ name: info.name, version: info.version, path: relative(runtime, dirname(file)) }); } catch {}
    }
  }
}
await inspectTree(runtime);
await writeFile(join(resources, 'runtime-inventory.json'), JSON.stringify({ application: metadata.version, platform: process.platform, arch: process.arch,
  node: process.version, pi: pi.version, subagents: extensionMetadata.version, packages: packageInventory }, null, 2) + '\n');
await writeFile(join(resources, 'THIRD-PARTY-NOTICES.txt'), `Pi Dither includes Node.js ${process.version}, core Pi ${pi.version}, pi-subagents ${extensionMetadata.version}, their runtime dependencies, and VT323.\nUpstream licenses are retained with their packages; Node's license is runtime/NODE-LICENSE.txt and VT323's is app/desktop/public/assets/OFL.txt.\nSee runtime-inventory.json for exact bundled package versions. No user profiles, keys, sessions or unrelated Pi extensions are included.\n`);
const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleName</key><string>Pi Dither</string><key>CFBundleDisplayName</key><string>Pi Dither</string>
<key>CFBundleIdentifier</key><string>com.joeyzhuoer.pi-dither</string><key>CFBundleExecutable</key><string>PiDither</string>
<key>CFBundlePackageType</key><string>APPL</string><key>CFBundleShortVersionString</key><string>${metadata.version}</string><key>CFBundleVersion</key><string>${metadata.version}</string>
<key>CFBundleIconFile</key><string>AppIcon</string><key>LSMinimumSystemVersion</key><string>14.0</string>
<key>LSMultipleInstancesProhibited</key><true/><key>NSHighResolutionCapable</key><true/>
<key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
<key>NSHumanReadableCopyright</key><string>Pi Dither contributors. Bundled components retain their upstream licenses.</string>
</dict></plist>`;
await writeFile(join(contents, 'Info.plist'), plist);
run('/usr/bin/plutil', ['-lint', join(contents, 'Info.plist')]);
const target = 'arm64-apple-macosx14.0';
run('/usr/bin/xcrun', ['swiftc', '-swift-version', '5', '-O', '-target', target, '-framework', 'AppKit', '-framework', 'WebKit', join(root, 'macos/PiDither.swift'), '-o', join(contents, 'MacOS/PiDither')]);
const iconTool = join(dist, '.make-icon'), iconset = join(dist, '.AppIcon.iconset');
run('/usr/bin/xcrun', ['swiftc', '-swift-version', '5', '-O', join(root, 'macos/Icon.swift'), '-o', iconTool]);
run(iconTool, [iconset, join(root, 'desktop/public/assets/VT323-Regular.ttf')]);
run('/usr/bin/iconutil', ['-c', 'icns', iconset, '-o', join(resources, 'AppIcon.icns')]);
await rm(iconset, { recursive: true, force: true }); await rm(iconTool);

async function signMachO(path) {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const file = join(path, entry.name);
    if (entry.isDirectory()) await signMachO(file);
    else if (entry.isFile() && ((await lstat(file)).mode & 0o111 || /\.(node|dylib)$/.test(file))) {
      if (run('/usr/bin/file', ['-b', file]).toString().includes('Mach-O')) run('/usr/bin/codesign', ['--force', '--sign', '-', '--timestamp=none', file]);
    }
  }
}
await signMachO(contents);
run('/usr/bin/codesign', ['--force', '--sign', '-', '--timestamp=none', stage]);
run('/usr/bin/codesign', ['--verify', '--deep', '--strict', stage]);
await rm(app, { recursive: true, force: true });
await cp(stage, app, { recursive: true, verbatimSymlinks: true }); await rm(stage, { recursive: true, force: true });
const zipName = `Pi-Dither-${metadata.version}-macOS-arm64.zip`, archive = join(dist, zipName);
await rm(archive, { force: true });
run('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, archive]);
const digest = createHash('sha256').update(await readFile(archive)).digest('hex');
await writeFile(join(dist, 'SHA256SUMS.txt'), `${digest}  ${zipName}\n`);
console.log(`Built ${app}\nArchive: ${archive}\nAd-hoc signed Apple Silicon/macOS 14+ build; not Developer-ID signed or notarized.`);
