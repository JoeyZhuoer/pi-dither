import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installComboboxes, syncCombobox } from '../desktop/public/combobox.js';

test('combobox imports and explicit sync are harmless without a browser or installed enhancer', () => {
  assert.doesNotThrow(() => syncCombobox({ value: 'fixture' }));
  assert.doesNotThrow(() => syncCombobox(null));
  const api = installComboboxes(); api.refresh(); api.destroy();
  installComboboxes({ querySelectorAll() { throw new Error('tiny DOM must not be scanned'); } }).refresh();
});

test('combobox, inspection and window sizing real Chromium fixture (temporary profile, no desktop/provider)', { timeout: 30000, skip: !process.env.PI_COMBOBOX_BROWSER_TEST }, async t => {
  const chrome = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  try { await access(chrome); } catch { t.skip('Chrome unavailable; set CHROME_PATH'); return; }
  const profile = await mkdtemp(join(tmpdir(), 'pi-combobox-test-'));
  const files = new Map(await Promise.all([
    ['/combobox.js', '../desktop/public/combobox.js'], ['/combobox.css', '../desktop/public/combobox.css'], ['/checks.mjs', './combobox-browser-checks.mjs'],
    ['/windows.js', '../desktop/public/windows.js'], ['/windows-checks.mjs', './windows-dom-checks.mjs'],
    ['/inspection.js', '../desktop/public/inspection.js'], ['/inspection.css', '../desktop/public/inspection.css'], ['/inspection-checks.mjs', './inspection-dom-checks.mjs'],
  ].map(async ([url, path]) => [url, await readFile(new URL(path, import.meta.url), 'utf8')])));
  const html = `<html><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/combobox.css"><link rel="stylesheet" href="/inspection.css"></head><body><script type="module">
    import * as combo from '/combobox.js'; import { checkComboboxBrowser } from '/checks.mjs';
    import * as inspection from '/inspection.js'; import { checkInspectionDOM } from '/inspection-checks.mjs';
    import * as windows from '/windows.js'; import { checkWindowsDOM } from '/windows-checks.mjs';
    try { const result = await checkComboboxBrowser(combo); const inspected = await checkInspectionDOM(inspection); const sized = await checkWindowsDOM(windows); document.body.textContent = 'COMBOBOX_PASS: ' + result + '; ' + inspected + '; ' + sized; }
    catch (error) { document.body.textContent = 'COMBOBOX_FAIL: ' + error.stack; }
  </script></body></html>`;
  const server = createServer((req, res) => {
    const body = req.url === '/' ? html : files.get(req.url);
    res.writeHead(body ? 200 : 404, { 'Content-Type': req.url === '/' ? 'text/html' : req.url.endsWith('.css') ? 'text/css' : 'text/javascript' }); res.end(body || 'Not found');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let child;
  try {
    child = spawn(chrome, ['--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-sync', `--user-data-dir=${profile}`, '--remote-debugging-port=0', '--window-size=390,844', 'about:blank']);
    const endpoint = await new Promise((resolve, reject) => {
      let stderr = '';
      const timer = setTimeout(() => reject(new Error('DevTools startup timeout: ' + stderr)), 10000);
      child.stderr.on('data', data => { stderr += data; const match = stderr.match(/DevTools listening on (ws:\/\/\S+)/); if (match) { clearTimeout(timer); resolve(match[1]); } });
      child.on('error', reject);
    });
    const ws = new WebSocket(endpoint), pending = new Map(); let id = 0, sessionId;
    await new Promise(resolve => ws.addEventListener('open', resolve, { once: true }));
    ws.addEventListener('message', ({ data }) => { const message = JSON.parse(data); if (message.id) { const callback = pending.get(message.id); pending.delete(message.id); callback?.(message); } });
    const rpc = (method, params = {}) => new Promise((resolve, reject) => {
      const next = ++id; pending.set(next, message => message.error ? reject(new Error(JSON.stringify(message.error))) : resolve(message.result));
      ws.send(JSON.stringify({ id: next, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
    let output = '';
    try {
      const { targetId } = await rpc('Target.createTarget', { url: 'about:blank' });
      ({ sessionId } = await rpc('Target.attachToTarget', { targetId, flatten: true }));
      await rpc('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
      await rpc('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/` });
      for (let attempt = 0; attempt < 100; attempt++) {
        const result = await rpc('Runtime.evaluate', { expression: 'document.body?.textContent', returnByValue: true });
        output = result.result.value || '';
        if (output.startsWith('COMBOBOX_PASS:') || output.startsWith('COMBOBOX_FAIL:')) break;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    } finally { ws.close(); }
    assert.match(output, /COMBOBOX_PASS:/, output);
    assert.doesNotMatch(output, /COMBOBOX_FAIL:/, output);
  } finally { child?.kill(); await new Promise(resolve => server.close(resolve)); await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});
