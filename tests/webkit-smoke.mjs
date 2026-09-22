// Isolated WKWebView component validation; deliberately does not launch Pi Dither.app.
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

if (process.platform !== 'darwin') throw new Error('WKWebView validation requires macOS.');
const execute = promisify(execFile), temp = await mkdtemp(join(tmpdir(), 'pi-dither-webkit-'));
const source = fileURLToPath(new URL('./WebKitSmoke.swift', import.meta.url)), binary = join(temp, 'WebKitSmoke');
let server;
try {
  await execute('/usr/bin/xcrun', ['swiftc', '-framework', 'AppKit', '-framework', 'WebKit', source, '-o', binary], { timeout: 120000 });
  const files = new Map();
  for (const path of ['combobox.js', 'combobox.css', 'inspection.js', 'inspection.css', 'windows.js', 'styles.css', 'assets/VT323-Regular.ttf']) {
    files.set('/' + path, await readFile(new URL('../desktop/public/' + path, import.meta.url)));
  }
  for (const path of ['combobox-browser-checks.mjs', 'inspection-dom-checks.mjs', 'windows-dom-checks.mjs']) files.set('/' + path, await readFile(new URL('./' + path, import.meta.url)));
  const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/combobox.css"><link rel="stylesheet" href="/inspection.css"></head><body><script type="module">
    import * as combo from '/combobox.js'; import * as inspection from '/inspection.js';
    import { checkComboboxBrowser } from '/combobox-browser-checks.mjs';
    import { checkInspectionDOM } from '/inspection-dom-checks.mjs';
    import * as windows from '/windows.js'; import { checkWindowsDOM } from '/windows-dom-checks.mjs';
    try { await document.fonts.ready; const a=await checkComboboxBrowser(combo); const b=await checkInspectionDOM(inspection); const c=await checkWindowsDOM(windows); window.webkit.messageHandlers.fixtureResult.postMessage({ok:true,detail:a+'; '+b+'; '+c}); }
    catch (error) { window.webkit.messageHandlers.fixtureResult.postMessage({ok:false,detail:String(error.stack || error)}); }
  </script></body></html>`;
  server = createServer((req, res) => {
    const body = req.url === '/' ? html : files.get(req.url);
    const mime = req.url.endsWith('.css') ? 'text/css' : req.url.endsWith('.ttf') ? 'font/ttf' : /\.m?js$/.test(req.url) ? 'text/javascript' : 'text/html';
    res.writeHead(body ? 200 : 404, { 'Content-Type': mime }); res.end(body || 'Not found');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const home = join(temp, 'home'), work = join(temp, 'work'); await mkdir(home); await mkdir(work);
  // No inherited credentials, Pi profile, browser profile, installed-app origin or fixed port.
  const env = { HOME: home, CFFIXED_USER_HOME: home, PATH: '/usr/bin:/bin:/usr/sbin:/sbin', TMPDIR: temp };
  for (const width of [390, 1440]) {
    const { stdout } = await execute(binary, [`http://127.0.0.1:${server.address().port}/`, String(width)], { cwd: work, env, timeout: 40000, maxBuffer: 64000 });
    assert.match(stdout, /^PASS: isolated WKWebView/m); process.stdout.write(stdout);
  }
} finally {
  if (server?.listening) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  await rm(temp, { recursive: true, force: true });
}
