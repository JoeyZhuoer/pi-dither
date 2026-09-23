import { renderMarkdown } from './markdown.js';
import { createInspectionPanel } from './inspection.js';

const activeStatuses = new Set(['queued', 'running']);
const text = (value, limit = 24000) => typeof value === 'string' ? value.slice(0, limit) : '';
export const delegatedId = (context, session, id) => `delegated:${JSON.stringify([context, session, id])}`;
export function delegationRows(main) {
  if (!main?.sessionId || !Array.isArray(main.delegations)) return [];
  const seen = new Set();
  return main.delegations.slice(0, 32).filter((row) => {
    if (!row || typeof row.id !== 'string' || !row.id || seen.has(row.id)) return false;
    seen.add(row.id); return true;
  });
}
export function delegationNotice(main) {
  if (!main?.delegationStatus || main.extensionStatus?.status !== 'loaded') return '';
  const status = main.delegationStatus, omitted = Number.isSafeInteger(status.omitted) && status.omitted > 0 ? status.omitted : 0;
  return [text(status.message, 1000), omitted ? `${omitted} delegated entries omitted by display limits.` : ''].filter(Boolean).join(' ');
}
export function aggregateActivity(agents, connected = true) {
  if (!connected) return 'idle';
  let result = 'idle';
  const add = (mode) => {
    if (mode === 'output') result = 'output';
    else if (result !== 'output' && ['thinking', 'tool', 'unknown'].includes(mode)) result = 'thinking';
  };
  for (const agent of agents) {
    if (!agent.connected) continue;
    // Busy before the first provider delta is observable, but actual reasoning
    // is not. Reuse the busy/thinking visual without inventing reasoning text.
    if (!['idle', 'stopped', 'error'].includes(agent.phase)) add(agent.activityMode && agent.activityMode !== 'idle' ? agent.activityMode : 'unknown');
    if (agent.kind === 'main') for (const row of delegationRows(agent)) {
      if (activeStatuses.has(row.status)) add(row.phase);
    }
  }
  return result;
}

// Separate from manual panels/states: observers can never become API destinations.
export function installDelegatedObservers({ windows, storage, document: doc = document, markdown = renderMarkdown }) {
  const panels = new Map();
  let scope = '', suppressed = new Set();
  const storageKey = () => `pi-desktop:delegated-closed:v1:${scope}`;
  const node = (tag, className, value) => {
    const element = doc.createElement(tag); element.className = className;
    if (value !== undefined) element.textContent = value;
    return element;
  };
  function reconcile(main, context, connected) {
    const nextScope = JSON.stringify([context || '', main?.sessionId || '']);
    if (nextScope !== scope) {
      for (const [id, panel] of panels) { panel.inspection.destroy(); windows.remove(id); }
      panels.clear(); scope = nextScope; suppressed = new Set();
      try {
        const saved = JSON.parse(storage?.getItem(storageKey()) || '[]');
        if (Array.isArray(saved)) suppressed = new Set(saved.filter((id) => typeof id === 'string').slice(-256));
      } catch { /* Optional session storage. */ }
    }
    const rows = delegationRows(main);
    const kept = new Set(rows.map((row) => delegatedId(context || '', main.sessionId, row.id)));
    // Release vanished views before allocating; hidden views still occupy a
    // right-side position and surviving windows never jump between positions.
    for (const [id, panel] of panels) if (!kept.has(id)) { panel.inspection.destroy(); windows.remove(id); panels.delete(id); }
    for (const row of rows) {
      const id = delegatedId(context || '', main.sessionId, row.id);
      if (suppressed.has(id)) continue;
      let panel = panels.get(id);
      if (!panel) {
        const occupied = new Set([...panels.values()].map((panel) => panel.win.index));
        const remembered = windows.saved?.[id]?.observerIndex;
        let index = Number.isSafeInteger(remembered) && remembered >= 0 && remembered < 32 && !occupied.has(remembered) ? remembered : 0;
        while (occupied.has(index)) index++;
        const win = windows.add({ id, title: 'Delegated observer', kind: 'delegated', index,
          onClose: () => {
            suppressed.add(id);
            try { storage?.setItem(storageKey(), JSON.stringify([...suppressed].slice(-256))); } catch { /* Optional. */ }
            panels.get(id)?.inspection.destroy(); panels.delete(id); windows.remove(id);
          } });
        win.element.classList.add('delegated-window');
        win.element.dataset.delegationId = row.id;
        const close = win.element.querySelector('[aria-label="Close subagent window"]');
        if (close) { close.setAttribute('aria-label', 'Close delegated observer'); close.title = 'Close observer only; task continues'; }
        const status = node('div', 'agent-meta delegated-status'); status.setAttribute('role', 'status');
        const inspection = createInspectionPanel({ document: doc, kind: 'delegated' });
        const output = node('div', 'conversation'); output.setAttribute('aria-label', 'Delegated output'); output.tabIndex = 0;
        win.body.append(status, inspection.element, output, node('div', 'agent-footer', 'DISPLAY ONLY'));
        panel = { win, status, inspection, output }; panels.set(id, panel);
      }
      windows.rename(id, `DELEGATED / ${text(row.name, 100) || 'Child'} · Observer`);
      panel.status.textContent = `DELEGATED · ${connected && main.connected ? text(row.status, 40).toUpperCase() || 'UNKNOWN' : 'DISCONNECTED'} · DISPLAY ONLY`;
      // Legacy task scope is explicit; no legacy inference for tools/files/usage.
      const inspection = row.inspection ?? { version: 1, prompt: { text: typeof row.task === 'string' ? text(row.task, 8000) : null, kind: 'task', truncated: typeof row.task === 'string' && row.task.length > 8000 } };
      panel.inspection.update(inspection, { connected: Boolean(connected && main.connected) });
      // Bound both per-message and total rendering, replacing cumulative snapshots.
      let remaining = 64000;
      const take = (value) => { const valueText = text(value, Math.min(24000, remaining)); remaining -= valueText.length; return valueText; };
      const finalOutput = take(row.finalOutput), error = text(row.error, 8000);
      const messages = (Array.isArray(row.messages) ? row.messages : []).slice(-80).filter(Boolean).map((message) => ({ role: message.role, name: text(message.name, 100), text: take(message.text) }));
      const signature = JSON.stringify([messages, finalOutput, error]);
      if (panel.signature === signature) continue;
      const stick = panel.output.scrollHeight - panel.output.scrollTop - panel.output.clientHeight < 70;
      const rendered = messages.map((message) => {
        const item = node('article', 'message'); item.append(node('div', 'message-heading', text(message.name || message.role, 100).toUpperCase()));
        const body = node('div', 'message-body');
        if (message.role === 'assistant') markdown(body, message.text); else body.textContent = message.text;
        item.append(body); return item;
      });
      if (finalOutput) {
        const final = node('article', 'message delegated-final'); final.append(node('div', 'message-heading', 'FINAL OUTPUT'));
        const body = node('div', 'message-body'); markdown(body, finalOutput); final.append(body); rendered.push(final);
      }
      if (error) rendered.push(node('pre', 'agent-error', error));
      panel.output.replaceChildren(...rendered);
      if (stick) panel.output.scrollTop = panel.output.scrollHeight;
      panel.signature = signature;
    }
  }
  return { reconcile };
}
