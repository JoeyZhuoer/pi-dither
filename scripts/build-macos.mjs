// Offline packaging for the macOS wrapper. Only the application source is
// bundled; Pi, Node, pi-subagents and user packages all come from the user's
// native installation at runtime.
import { cp, mkdir, readFile, writeFile, rm, readdir, lstat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const metadata = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
if (process.platform !== 'darwin') throw new Error('Build this application on macOS with Xcode Command Line Tools.');
if (process.arch !== 'arm64') throw new Error('This release is validated only for Apple Silicon. Build/validate an Intel variant separately.');
if (Number(process.version.slice(1).split('.')[0]) < 22) throw new Error('Build this application with Node 22 or newer.');
const dist = process.env.PI_DITHER_BUILD_DIR ? resolve(process.env.PI_DITHER_BUILD_DIR) : join(root, 'dist'), app = join(dist, 'Pi Dither.app'), stage = join(dist, '.Pi-Dither-build.app');
await mkdir(dist, { recursive: true });
await rm(stage, { recursive: true, force: true });
const contents = join(stage, 'Contents'), resources = join(contents, 'Resources');
await mkdir(join(contents, 'MacOS'), { recursive: true });
const run = (exe, args) => execFileSync(exe, args, { cwd: root, stdio: 'pipe' });
const appSource = join(resources, 'app');
await mkdir(appSource, { recursive: true });
// Deliberately never copy the checkout wholesale (.local/auth/sessions/Git).
const appFiles = [
  'package.json', 'scripts/pi-paths.mjs',
  ...['server', 'pi-session', 'protocol', 'controls', 'workspace', 'tools', 'extensions', 'rpc-host', 'delegations', 'delegation-bridge', 'inspection', 'subagent-slots', 'native-host'].map((name) => `desktop/${name}.mjs`),
  ...['app.js', 'background.js', 'particles.js', 'motion.js', 'delegated.js', 'inspection.js', 'inspection.css', 'combobox.js', 'combobox.css', 'features.js', 'features.css', 'markdown.js', 'markdown.css', 'windows.js', 'index.html', 'styles.css', 'assets/VT323-Regular.ttf', 'assets/OFL.txt'].map((name) => `desktop/public/${name}`),
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
await writeFile(join(resources, 'runtime-inventory.json'), JSON.stringify({ application: metadata.version, platform: process.platform, arch: process.arch }, null, 2) + '\n');
await writeFile(join(resources, 'THIRD-PARTY-NOTICES.txt'), `Pi Dither bundles no Node, Pi or pi-subagents runtime.\nThe only bundled third-party asset is VT323 (app/desktop/public/assets/OFL.txt and assets/VT323-Regular.ttf).\nPi, Node and all packages are loaded from the user's native installation and profile; no user profiles, keys or sessions are bundled.\n`);
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
