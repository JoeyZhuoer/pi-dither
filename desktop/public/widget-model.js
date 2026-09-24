// Model & reasoning widget. It mirrors the Models feature window against host state:
// every value comes from update(state), and every write goes through ctx.api. The
// widget follows the agent reported by ctx.getSelectedAgent(); provider/model/thinking
// choices exist only when that agent reports them. Changing a select applies the value
// immediately — there is no separate apply button.
import { syncCombobox } from './combobox.js';

const IDLE_PHASES = ['idle', 'stopped', 'error'];
const idle = (agent) => !!agent && IDLE_PHASES.includes(agent.phase);
// A queued steering/follow-up message means the agent will act again; hold the change.
const queuesEmpty = (agent) => !(agent?.queue?.steering?.length || agent?.queue?.followUp?.length);

function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text != null) element.textContent = String(text);
  if (className) element.className = className;
  return element;
}

// Repopulate only when the option list actually changed so an in-progress choice survives
// unrelated state updates, then keep the retro combobox face in sync with the native select.
function choices(select, items, value) {
  const signature = JSON.stringify(items);
  if (select.dataset.choices !== signature) {
    const previous = select.value;
    select.replaceChildren(...items.map(([key, label]) => {
      const option = node('option', label); option.value = key; return option;
    }));
    select.dataset.choices = signature;
    if (items.some(([key]) => key === previous)) select.value = previous;
  }
  if (value != null) select.value = value;
  syncCombobox(select);
}

// The reported catalog plus the agent's authoritative current model, which may lag the catalog.
function selectedModels(agent) {
  const result = [...(agent?.models || [])];
  if (agent?.model && !result.some((item) => item.provider === agent.model.provider && item.id === agent.model.id)) result.unshift(agent.model);
  return result;
}

function field(parent, labelText, testid) {
  const label = node('label', null, 'widget-field'), caption = node('span', labelText);
  const select = node('select');
  select.setAttribute('aria-label', labelText); select.dataset.testid = testid;
  label.append(caption, select); parent.append(label); return select;
}

function createInstance(root, ctx) {
  const events = new AbortController();
  const on = (element, type, callback) => element.addEventListener(type, callback, { signal: events.signal });
  let request = typeof ctx?.api === 'function' ? ctx.api : null;
  let state = { connected: false, agents: [] };
  let mutation = false, signature = '', disposed = false, queued = null;
  const guards = new Map();

  const panel = node('div', null, 'widget-model-panel'); panel.dataset.testid = 'widget-model';
  const form = node('form', null, 'widget-model-form');
  const providerSelect = field(form, 'Provider', 'model-provider');
  const modelSelect = field(form, 'Model', 'model-model');
  const thinkingSelect = field(form, 'Reasoning', 'model-thinking');
  const status = node('p', '', 'widget-model-status'); status.dataset.testid = 'model-status'; status.setAttribute('role', 'status');
  panel.append(form, status);
  root.replaceChildren(panel);

  const agents = () => state.agents || [];
  const agentById = (id) => agents().find((agent) => agent.id === id);
  // The rail follows the selected agent; prefer the sanitized state copy, then main, then first.
  const target = () => {
    const selected = typeof ctx?.getSelectedAgent === 'function' ? ctx.getSelectedAgent() : null;
    return (selected && agentById(selected.id)) || selected || agentById('main') || agents()[0] || null;
  };
  const usable = () => {
    const agent = target();
    return !!state.connected && !!agent?.connected && idle(agent) && queuesEmpty(agent);
  };
  function guard(element, allowed) { guards.set(element, allowed); element.disabled = mutation || !allowed(); return element; }
  function controls() {
    for (const [element, allowed] of guards) { element.disabled = mutation || !allowed(); syncCombobox(element); }
  }
  function message(text, error = false) {
    status.textContent = text; status.classList.toggle('feature-error', error);
    status.setAttribute('role', error ? 'alert' : 'status');
  }
  // Populate the model select for the current provider, preferring the agent's own model.
  function syncModels(agent) {
    const items = selectedModels(agent).filter((item) => item.provider === providerSelect.value);
    const current = items.some((item) => item.id === agent?.model?.id) ? agent.model.id : undefined;
    choices(modelSelect, items.length ? items.map((item) => [item.id, item.name || item.id]) : [['', 'No model available']], current ?? items[0]?.id);
  }
  function refresh() {
    const agent = target();
    const next = JSON.stringify([agent?.id, agent?.models, agent?.model, agent?.levels, agent?.thinking]);
    if (next !== signature) {
      signature = next;
      const providers = [...new Set(selectedModels(agent).map((item) => item.provider))];
      choices(providerSelect, providers.length ? providers.map((id) => [id, id]) : [['', 'No providers']], agent?.model?.provider);
      syncModels(agent);
      choices(thinkingSelect, (agent?.levels || []).map((level) => [level, level]), agent?.thinking);
    }
    controls();
  }
  // Auto-apply serializes on one in-flight request; the newest change made meanwhile runs
  // next, then the controls re-render from the agent's latest state.
  function enqueue(path, body) {
    if (disposed) return;
    if (!usable()) { message('Unavailable.', true); return; }
    queued = { path, body };
    void flush();
  }
  async function flush() {
    if (disposed || mutation || !queued) return;
    const job = queued; queued = null;
    mutation = true; controls();
    try {
      if (!request) throw new Error('No API');
      await request(job.path, job.body);
      if (!disposed) message('Applied.');
    } catch {
      // Never echo a downstream error: it must not leak provider details.
      if (!disposed) message('Update failed.', true);
    } finally {
      mutation = false;
      if (!disposed) { refresh(); void flush(); }
    }
  }
  function applyModel() {
    const id = target()?.id;
    if (id == null || !providerSelect.value || !modelSelect.value) return;
    enqueue(`/api/agents/${encodeURIComponent(id)}/model`, { provider: providerSelect.value, modelId: modelSelect.value });
  }
  function applyThinking() {
    const id = target()?.id;
    if (id == null || !thinkingSelect.value) return;
    enqueue(`/api/agents/${encodeURIComponent(id)}/thinking`, { level: thinkingSelect.value });
  }

  // A provider switch re-derives the model options for that provider before it is applied.
  on(providerSelect, 'change', () => { syncModels(target()); applyModel(); });
  on(modelSelect, 'change', applyModel);
  on(thinkingSelect, 'change', applyThinking);
  guard(providerSelect, usable);
  guard(modelSelect, usable);
  guard(thinkingSelect, () => usable() && !!thinkingSelect.value);

  return {
    update(nextState, nextCtx) {
      if (disposed) return;
      if (typeof nextCtx?.api === 'function') request = nextCtx.api;
      state = nextState || { connected: false, agents: [] };
      refresh();
    },
    destroy() {
      if (disposed) return;
      disposed = true; events.abort(); guards.clear(); queued = null; request = null;
      root.replaceChildren();
    },
  };
}

export function install(host) {
  if (!host || typeof host.register !== 'function') return;
  let instance = null;
  host.register({
    type: 'model',
    title: 'Model & reasoning',
    defaultSize: [2, 2],
    sizes: [[2, 2]],
    render(root, ctx) { instance = createInstance(root, ctx); },
    update(state, ctx) { instance?.update(state, ctx); },
    destroy() { instance?.destroy(); instance = null; },
  });
}
