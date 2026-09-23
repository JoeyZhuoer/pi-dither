// Model & reasoning widget. It mirrors the Models feature window against host state:
// every value comes from update(state), and every write goes through ctx.api. The
// widget never inspects app.js or keeps credentials; provider/model/thinking choices
// exist only when the selected agent reports them.
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

// Repopulate only when the option list actually changed so an in-progress draft survives
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
  let mutation = false, signature = '', disposed = false;
  const guards = new Map();

  const panel = node('div', null, 'widget-model-panel'); panel.dataset.testid = 'widget-model';
  const form = node('form', null, 'widget-model-form');
  const agentSelect = field(form, 'Agent', 'model-agent');
  const providerSelect = field(form, 'Provider', 'model-provider');
  const modelSelect = field(form, 'Model', 'model-model');
  const thinkingSelect = field(form, 'Thinking level', 'model-thinking');
  const applyModel = node('button', 'Apply model'); applyModel.type = 'button'; applyModel.dataset.testid = 'model-apply';
  const applyThinking = node('button', 'Apply thinking'); applyThinking.type = 'button'; applyThinking.dataset.testid = 'model-thinking-apply';
  const actions = node('div', null, 'widget-model-actions'); actions.append(applyModel, applyThinking); form.append(actions);
  const current = node('p', '', 'widget-model-current'); current.dataset.testid = 'model-current';
  const status = node('p', '', 'widget-model-status'); status.dataset.testid = 'model-status'; status.setAttribute('role', 'status');
  panel.append(form, current, status);
  root.replaceChildren(panel);

  const agents = () => state.agents || [];
  const agentById = (id) => agents().find((agent) => agent.id === id);
  const agentIdle = (id) => {
    const agent = agentById(id);
    return !!state.connected && !!agent?.connected && idle(agent) && queuesEmpty(agent);
  };
  const canModel = () => agentIdle(agentSelect.value) && !!providerSelect.value && !!modelSelect.value;
  const canThinking = () => agentIdle(agentSelect.value) && !!thinkingSelect.value;

  function guard(element, allowed) { guards.set(element, allowed); element.disabled = mutation || !allowed(); return element; }
  function controls() {
    for (const [element, allowed] of guards) { element.disabled = mutation || !allowed(); syncCombobox(element); }
  }
  function message(text, error = false) {
    status.textContent = text; status.classList.toggle('feature-error', error);
    status.setAttribute('role', error ? 'alert' : 'status');
  }
  function modelOptions(value) {
    const items = selectedModels(agentById(agentSelect.value)).filter((item) => item.provider === providerSelect.value);
    choices(modelSelect, items.length ? items.map((item) => [item.id, item.name || item.id]) : [['', 'No model available']], value);
  }
  function refresh() {
    const oldAgent = agentSelect.value;
    choices(agentSelect, agents().length ? agents().map((agent) => [agent.id, agent.name || agent.id]) : [['', 'No agents']]);
    const agent = agentById(agentSelect.value);
    const next = JSON.stringify([agent?.id, agent?.models, agent?.model, agent?.levels, agent?.thinking]);
    if (oldAgent !== agentSelect.value || next !== signature) {
      signature = next;
      const providers = [...new Set(selectedModels(agent).map((item) => item.provider))];
      choices(providerSelect, providers.length ? providers.map((id) => [id, id]) : [['', 'No providers']], agent?.model?.provider);
      modelOptions(agent?.model?.id);
      choices(thinkingSelect, (agent?.levels || []).map((level) => [level, level]), agent?.thinking);
    }
    current.textContent = agent
      ? `${agent.name || agent.id} · ${agent.phase} · Current: ${agent.model ? `${agent.model.provider} / ${agent.model.id}` : 'Unknown'} · Thinking: ${agent.thinking ?? 'Unknown'}`
      : 'No agents.';
    controls();
  }
  async function mutate(allowed, send) {
    if (disposed || mutation) return;
    if (!allowed()) { message('Unavailable.', true); return; }
    mutation = true; controls(); message('Applying…');
    try {
      await send();
      if (!disposed) message('Applied.');
    } catch {
      // Never echo a downstream error: it must not leak provider details.
      if (!disposed) message('Update failed.', true);
    } finally {
      mutation = false; if (!disposed) controls();
    }
  }

  on(agentSelect, 'change', () => { signature = ''; refresh(); });
  on(providerSelect, 'change', () => modelOptions());
  guard(providerSelect, () => agentIdle(agentSelect.value));
  guard(modelSelect, () => agentIdle(agentSelect.value));
  guard(thinkingSelect, () => agentIdle(agentSelect.value) && !!thinkingSelect.value);
  guard(applyModel, canModel);
  guard(applyThinking, canThinking);
  on(applyModel, 'click', () => {
    const id = agentSelect.value, body = { provider: providerSelect.value, modelId: modelSelect.value };
    void mutate(() => agentIdle(id) && !!body.provider && !!body.modelId, () => {
      if (!request) throw new Error('No API');
      return request(`/api/agents/${encodeURIComponent(id)}/model`, body);
    });
  });
  on(applyThinking, 'click', () => {
    const id = agentSelect.value, level = thinkingSelect.value;
    void mutate(() => agentIdle(id) && !!level, () => {
      if (!request) throw new Error('No API');
      return request(`/api/agents/${encodeURIComponent(id)}/thinking`, { level });
    });
  });

  return {
    update(nextState, nextCtx) {
      if (disposed) return;
      if (typeof nextCtx?.api === 'function') request = nextCtx.api;
      state = nextState || { connected: false, agents: [] };
      refresh();
    },
    destroy() {
      if (disposed) return;
      disposed = true; events.abort(); guards.clear(); request = null;
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
    defaultSize: [2, 3],
    sizes: [[2, 2], [2, 3]],
    render(root, ctx) { instance = createInstance(root, ctx); },
    update(state, ctx) { instance?.update(state, ctx); },
    destroy() { instance?.destroy(); instance = null; },
  });
}
