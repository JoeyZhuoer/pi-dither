import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { emptyInspection } from '../desktop/inspection.mjs';

// Synthetic telemetry only: this checks the integrated server/SSE/DOM path without
// a provider request or a real extension child launch.
export async function checkDelegatedBrowser({ app, evaluate, until, rpc }) {
  if (!app) return;
  const main = app.sessions.get('main');
  const original = { sessionId: main.state.sessionId, phase: main.state.phase,
    activityMode: main.state.activityMode, delegations: main.state.delegations, delegationStatus: main.state.delegationStatus };
  const calls = [...main.calls], count = app.sessions.size;
  const publish = (patch) => { Object.assign(main.state, patch); main.state.revision++; main.emit('change'); };
  const selector = (id) => `[data-delegation-id="${id}"]`;
  const element = (id) => `document.querySelector(${JSON.stringify(selector(id))})`;
  const row = (id, source, phase) => ({ id, runId: `run-${id}`, childId: 'step:0', name: `Delegate ${id}`, source,
    status: 'running', phase, task: `Fixture task ${id}`, messages: [{ id: 'a1', role: 'assistant', text: `Live ${id}`, status: 'streaming' }],
    finalOutput: '', error: null, updatedAt: Date.now() });
  try {
    publish({ sessionId: 'fixture-delegated-parent', phase: 'running', activityMode: 'thinking', delegations: [] });
    await until('document.querySelector("#desktop").dataset.activity === "thinking"');
    publish({ activityMode: 'output' });
    await until('document.querySelector("#desktop").dataset.activity === "output"');
    publish({ phase: 'idle', activityMode: 'idle' });
    await until('document.querySelector("#desktop").dataset.activity === "idle"');

    const first = row('fixture-foreground', 'foreground', 'thinking');
    const second = row('fixture-async', 'async', 'output');
    publish({ delegations: [first, second] });
    await until('document.querySelectorAll("[data-delegation-id]").length === 2');
    await until('document.querySelector("#desktop").dataset.activity === "output"');
    assert.equal(app.sessions.size, count, 'observer creation does not spawn manual sessions');
    assert.equal(await evaluate('document.querySelectorAll("[data-delegation-id][data-subagent-index]").length'), 0, 'observers do not reserve manual slots');
    assert.equal(await evaluate('document.querySelectorAll("[data-delegation-id] textarea, [data-delegation-id] .model-select, [data-delegation-id] .send, [data-delegation-id] .tool-settings").length'), 0, 'observer windows cannot send tasks or change tools');
    assert.equal(await evaluate(`${element(first.id)}.hidden`), false);
    assert.equal(await evaluate(`${element(second.id)}.hidden`), false);
    for (const [index, id] of [first.id, second.id].entries()) {
      const position = await evaluate(`(() => { const win=${element(id)}, desktop=document.querySelector('#desktop'); return { top: parseFloat(win.style.top), right: desktop.clientWidth - parseFloat(win.style.left) - parseFloat(win.style.width) }; })()`);
      assert.equal(position.top, 105 + index * 240, 'delegates use former Scout/Review vertical positions');
      assert.equal(position.right, 25 + index * 35, 'delegates align with former right-side anchors');
    }

    first.inspection = emptyInspection(); first.inspection.prompt.text = 'Assigned child task';
    first.inspection.usage = { ...first.inspection.usage, totalTokens: 99, costUsd: 0, provisional: true };
    publish({ delegations: [first, second] });
    await until(`${element(first.id)}.querySelector('.inspection-summary').textContent.includes('99 tokens')`);
    await evaluate(`${element(first.id)}.querySelector('.inspection-panel').open=true; ${element(first.id)}.querySelector('.inspection-section').open=true`);
    const geometry = await evaluate(`${element(first.id)}.getAttribute('style')`);
    first.inspection.usage.totalTokens = 120;
    publish({ delegations: [first, second] });
    await until(`${element(first.id)}.querySelector('.inspection-summary').textContent.includes('120 tokens')`);
    assert.equal(await evaluate(`${element(first.id)}.querySelector('.inspection-section').open`), true);
    assert.equal(await evaluate(`${element(first.id)}.getAttribute('style')`), geometry, 'inspection updates leave observer geometry unchanged');
    assert.match(await evaluate(`${element(first.id)}.querySelector('.inspection-content').textContent`), /Assigned child task/);
    delete first.inspection;
    publish({ delegations: [first, second] });
    await until(`${element(first.id)}.querySelector('.inspection-summary').textContent.includes('tokens') && !${element(first.id)}.querySelector('.inspection-summary').textContent.includes('120 tokens')`);
    assert.match(await evaluate(`${element(first.id)}.querySelector('.inspection-content').textContent`), /Unavailable/, 'old-backend inspection remains usable');

    first.messages = [{ id: 'a1', role: 'assistant', text: '# Live replacement\n\n<img src=x onerror="window.delegatePwned=1">', status: 'streaming' }];
    publish({ delegations: [first, second] });
    await until(`${element(first.id)}.textContent.includes('Live replacement')`);
    assert.equal(await evaluate('document.querySelectorAll("[data-delegation-id]").length'), 2, 'cumulative updates reuse windows');
    assert.equal(await evaluate('document.querySelectorAll("[data-delegation-id] img").length'), 0);
    assert.equal(await evaluate('window.delegatePwned'), undefined);
    assert.equal(await evaluate(`${element(first.id)}.textContent.includes('Live fixture-foreground')`), false, 'cumulative text replaces rather than duplicates');
    const screenshot = await rpc('Page.captureScreenshot', { format: 'png' });
    await writeFile(resolve('.local/desktop-delegated-fixture.png'), Buffer.from(screenshot.data, 'base64'));
    publish({ delegationStatus: { available: false, message: 'Synthetic telemetry interruption.', omitted: 2 } });
    await until('document.querySelector(".main-window .queue").textContent.includes("Synthetic telemetry interruption")');
    assert.match(await evaluate('document.querySelector(".main-window .queue").textContent'), /2 delegated entries omitted/);
    publish({ delegationStatus: { available: true, message: '', omitted: 0 } });

    await evaluate(`${element(second.id)}.querySelector('button[aria-label="Minimize window"]').click()`);
    second.messages[0].text = 'Output while minimized';
    publish({ delegations: [first, second] });
    await until(`${element(second.id)}.textContent.includes('Output while minimized')`);
    assert.equal(await evaluate(`${element(second.id)}.hidden`), true, 'streaming does not unminimize observer');
    const observerId = await evaluate(`${element(second.id)}.dataset.windowId`);
    await evaluate(`Array.from(document.querySelectorAll('#tasks button')).find(button => button.textContent.includes('Delegate fixture-async')).click()`);
    assert.equal(await evaluate(`${element(second.id)}.hidden`), false, 'taskbar can reopen observer');
    assert.equal(await evaluate(`${element(second.id)}.dataset.windowId`), observerId);

    first.status = 'complete'; first.phase = 'idle'; first.finalOutput = 'Completed foreground report';
    second.status = 'failed'; second.phase = 'idle'; second.error = 'Synthetic child failure';
    publish({ delegations: [first, second] });
    await until(`${element(first.id)}.textContent.includes('Completed foreground report') && ${element(second.id)}.textContent.includes('Synthetic child failure')`);
    await until('document.querySelector("#desktop").dataset.activity === "idle"');

    await evaluate(`${element(first.id)}.querySelector('button[aria-label^="Close"]').click()`);
    await until(`${element(first.id)} === null`);
    second.messages[0].text = 'Retained terminal output';
    publish({ delegations: [first, second] });
    await until(`${element(second.id)}.textContent.includes('Retained terminal output')`);
    assert.equal(await evaluate(element(first.id)), null, 'later snapshots do not reopen a closed observer');
    assert.deepEqual(main.calls, calls, 'display-only windows never send commands to parent');

    // The live browser reconnects from a fresh snapshot; identities remain stable.
    await rpc('Page.reload');
    await until('document.querySelector(".main-window .send")?.disabled === false');
    await until(`${element(second.id)} !== null`);
    assert.equal(await evaluate(`${element(second.id)}.dataset.windowId`), observerId, 'reconnect keeps observer identity');
    assert.equal(await evaluate(`JSON.parse(localStorage.getItem('pi-desktop:layout:v1'))[${JSON.stringify(observerId)}].observerIndex`), 1, 'reconnect keeps the second position reserved rather than reallocating it as first');
    assert.equal(await evaluate('document.querySelectorAll("[data-delegation-id=fixture-async]").length'), 1);
    assert.equal(await evaluate(element(first.id)), null, 'closed observer stays suppressed across reload');

    publish({ sessionId: 'fixture-next-parent', delegations: [] });
    await until('document.querySelectorAll("[data-delegation-id]").length === 0');
    assert.equal(app.sessions.size, count);
    assert.deepEqual(main.calls, calls);
  } finally { publish(original); }
}
