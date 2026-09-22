import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { emptyInspection } from '../desktop/inspection.mjs';

// Synthetic state only: never sends provider prompts or uses a live app.
export async function checkManualInspectionBrowser({ app, childId, evaluate, until }) {
  const child = app.sessions.get(childId), original = child.state.inspection;
  const calls = [...child.calls], revision = child.state.revision;
  const element = `document.querySelector(${JSON.stringify(`[data-window-id="${childId}"]`)})`;
  const inspector = `${element}.querySelector('.inspection-panel')`;
  const data = emptyInspection('user', 'session');
  data.prompt.text = 'Delivered fixture prompt <img src=x onerror="window.inspectorPwned=1">';
  data.tools = { availability: 'partial', total: 2, omitted: 0, items: [{ id: 'read', name: 'read', status: 'done', summary: 'path: source.js' }] };
  data.usage = { ...data.usage, totalTokens: 17, costUsd: 0, provisional: true };
  data.timing = { startedAt: 1000, endedAt: 1400, durationMs: 400, scope: 'run', live: false };
  try {
    child.state.inspection = data; child.emit('change');
    await until(`${inspector}.textContent.includes('17 tokens')`);
    assert.equal(child.state.revision, revision, 'inspection does not need a transcript revision');
    await evaluate(`${inspector}.open=true; ${inspector}.querySelector('.inspection-section').open=true; ${inspector}.querySelector('summary').focus(); window.manualInspectionNode=${inspector}`);
    assert.match(await evaluate(`${inspector}.textContent`), /Session totals · Provisional/);
    assert.match(await evaluate(`${inspector}.textContent`), /Elapsed wall time: 400 ms/);
    assert.equal(await evaluate(`${inspector}.querySelectorAll('img,button,input,select,textarea').length`), 0, 'inspection is safe text and display-only');
    const geometry = await evaluate(`${element}.getAttribute('style')`);
    data.usage.totalTokens = 23; child.emit('change');
    await until(`${inspector}.textContent.includes('23 tokens')`);
    assert.equal(await evaluate(`${inspector} === window.manualInspectionNode && ${inspector}.open && ${inspector}.querySelector('.inspection-section').open`), true);
    assert.equal(await evaluate(`${inspector}.querySelector('summary') === document.activeElement`), true);
    assert.equal(await evaluate(`${element}.getAttribute('style')`), geometry);
    const compact = await evaluate(`(() => { const win=${element}, panel=${inspector}, before=win.getAttribute('style'); win.style.width='325px'; win.style.height='310px'; panel.open=false; const height=panel.getBoundingClientRect().height; win.setAttribute('style',before); panel.open=true; return height; })()`);
    assert.ok(compact >= 22, 'compact manual windows retain a reachable inspector summary');
    child.state.connected = false; child.emit('change');
    await until(`${inspector}.textContent.includes('disconnected')`);
    child.state.connected = true; delete child.state.inspection; child.emit('change');
    await until(`${inspector}.textContent.includes('tokens unavailable') || ${inspector}.textContent.includes('unavailable tokens')`);
    assert.doesNotMatch(await evaluate(`${inspector}.textContent`), /Delivered fixture prompt|23 tokens/);
    assert.deepEqual(child.calls, calls, 'inspection never sends commands');
    assert.equal(await evaluate('window.inspectorPwned'), undefined);
  } finally {
    child.state.connected = true; child.state.inspection = original; child.emit('change');
    await evaluate(`${inspector}.open=false; delete window.manualInspectionNode`);
  }
}

export async function checkIntegratedCombobox({ evaluate, until, rpc }) {
  await until('document.querySelector(".main-window select.delivery")?.nextElementSibling?.getAttribute("role") === "combobox"');
  const control = 'document.querySelector(".main-window select.delivery")';
  const trigger = `${control}.nextElementSibling`;
  await evaluate(`${control}.addEventListener('change', () => window.deliveryChanges=(window.deliveryChanges||0)+1); ${trigger}.focus()`);
  for (const key of [' ', 'End', 'Enter']) {
    await rpc('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key === ' ' ? 'Space' : key });
    await rpc('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key === ' ' ? 'Space' : key });
  }
  assert.equal(await evaluate(`${control}.value`), 'followUp');
  assert.equal(await evaluate('window.deliveryChanges'), 1, 'themed keyboard commit fires one native change');
  assert.equal(await evaluate(`${control}.name === ${trigger}.name`), true);
  await evaluate(`${control}.value='steer'; ${trigger}.click()`);
  assert.equal(await evaluate(`${trigger}.textContent`), 'Steer');
  assert.equal(await evaluate('window.deliveryChanges'), 1, 'programmatic sync is silent');
  const popup = await evaluate(`(() => { const e=document.getElementById(${trigger}.getAttribute('aria-controls')), r=e.getBoundingClientRect(), s=getComputedStyle(e); return { visible: !e.hidden, background: s.backgroundColor, font: s.fontFamily, position: s.position, fits: r.left>=0 && r.right<=innerWidth && r.top>=0 && r.bottom<=innerHeight }; })()`);
  assert.equal(popup.visible, true); assert.equal(popup.position, 'fixed'); assert.equal(popup.background, 'rgb(222, 222, 219)');
  assert.match(popup.font, /VT323/); assert.equal(popup.fits, true);
  await mkdir(resolve('.local'), { recursive: true });
  const screenshot = await rpc('Page.captureScreenshot', { format: 'png' });
  await writeFile(resolve('.local/desktop-combobox-fixture.png'), Buffer.from(screenshot.data, 'base64'));
  await rpc('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' });
  assert.equal(await evaluate(`${trigger}.getAttribute('aria-expanded')`), 'false');
}
