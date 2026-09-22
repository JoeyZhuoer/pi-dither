import { syncCombobox } from './combobox.js';
import { DEFAULT_GROUND, DEFAULT_THEME } from './background.js';

const TITLES = {
  models: 'Models & reasoning', providers: 'Providers', workspace: 'Workspace',
  git: 'Git & worktrees', usage: 'Usage', sessions: 'Sessions', activity: 'Activity', tools: 'Tools',
  background: 'Appearance & photo',
};
const idle = (agent) => !!agent && ['idle', 'stopped', 'error'].includes(agent.phase);
const number = (value) => typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString() : 'Unknown';
const cost = (value) => typeof value === 'number' && Number.isFinite(value) ? `$${value.toFixed(6)}` : 'Unknown';
const date = (value) => value && Number.isFinite(new Date(value).getTime()) ? new Date(value).toLocaleString() : 'Unknown';
function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text != null) element.textContent = String(text);
  if (className) element.className = className;
  return element;
}
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

const nonnegative = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;

/** Reported session totals only. Never add provisional turn usage to them. */
export function usageDiagramData(agent) {
  const stats = agent?.stats, tokens = stats?.tokens;
  const read = nonnegative(tokens?.cacheRead), write = nonnegative(tokens?.cacheWrite);
  const cache = read === null || write === null ? null : nonnegative(read + write);
  const segments = [
    { label: 'IN', value: nonnegative(tokens?.input) },
    { label: 'OUT', value: nonnegative(tokens?.output) },
    { label: 'CACHE', value: cache },
  ];
  const scale = Math.max(1, ...segments.map(({ value }) => value ?? 0));
  return {
    total: nonnegative(tokens?.total), cost: nonnegative(stats?.cost),
    context: nonnegative(stats?.contextUsage?.percent),
    contextTokens: nonnegative(stats?.contextUsage?.tokens),
    contextWindow: nonnegative(stats?.contextUsage?.contextWindow),
    provisional: nonnegative(agent?.currentUsage?.totalTokens),
    segments: segments.map((segment) => ({ ...segment, width: (segment.value ?? 0) / scale * 100 })),
  };
}

/** Desktop overview, updated from existing SSE state; no timers or requests. */
export function installUsageDiagram(root, openUsage) {
  const heading = node('button', 'Usage / session', 'utility-title');
  heading.type = 'button'; heading.setAttribute('aria-label', 'Open detailed session usage');
  heading.append(node('span', '↗')); heading.addEventListener('click', openUsage);
  const label = node('p', '', 'usage-agent'), bars = node('div', null, 'usage-bars');
  bars.setAttribute('role', 'img'); bars.title = 'Token counts; bars share a scale relative to the largest category. Cache combines read and write.';
  const rows = ['IN', 'OUT', 'CACHE'].map((text) => {
    const row = node('div', null, 'usage-bar'), track = node('span', null, 'usage-track');
    const fill = node('span', null, 'usage-fill'), amount = node('span', '', 'usage-amount');
    row.setAttribute('aria-hidden', 'true'); track.append(fill);
    row.append(node('span', text), track, amount); bars.append(row); return { fill, amount };
  });
  const totals = node('div', null, 'usage-totals'), total = node('span'), price = node('span'); totals.append(total, price);
  const contextLabel = node('p', '', 'usage-context-label'), context = node('div', null, 'usage-track usage-context');
  const contextFill = node('span', null, 'usage-fill'); context.append(contextFill);
  context.setAttribute('role', 'progressbar'); context.setAttribute('aria-label', 'Context occupancy');
  context.setAttribute('aria-valuemin', '0'); context.setAttribute('aria-valuemax', '100');
  const contextRow = node('div', null, 'usage-context-row'); contextRow.append(contextLabel, context);
  const note = node('p', '', 'usage-note');
  root.replaceChildren(heading, label, bars, totals, contextRow, note);
  const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });
  const short = (value) => value === null ? '—' : compact.format(value);
  return {
    update(agent, connected) {
      const data = usageDiagramData(agent), online = Boolean(connected && agent?.connected);
      root.dataset.agentId = agent?.id || ''; root.dataset.stale = String(!online);
      label.textContent = agent?.name || 'Waiting for an agent'; label.title = `${label.textContent} · ${agent?.sessionId || 'No session reported'}`;
      for (const [index, segment] of data.segments.entries()) {
        rows[index].fill.style.width = `${segment.width}%`;
        rows[index].amount.textContent = short(segment.value); rows[index].amount.title = number(segment.value);
      }
      bars.setAttribute('aria-label', data.segments.map(({ label, value }) => `${label}: ${number(value)} tokens`).join('; '));
      total.textContent = `${short(data.total)} TOK`; total.title = `Reported session tokens: ${number(data.total)}`;
      price.textContent = data.cost === null ? '$ —' : `$${data.cost.toFixed(4)}`; price.title = `Reported session cost: ${cost(data.cost)}`;
      contextLabel.textContent = `CONTEXT / ${data.context === null ? '—' : `${data.context.toLocaleString(undefined, { maximumFractionDigits: 1 })}%`}`;
      const contextText = `${number(data.contextTokens)} of ${number(data.contextWindow)} context tokens`;
      context.title = contextText; context.setAttribute('aria-valuetext', data.context === null ? `Occupancy unknown. ${contextText}` : `${number(data.context)}% used. ${contextText}`);
      contextFill.style.width = `${Math.min(100, data.context ?? 0)}%`;
      if (data.context === null) context.removeAttribute('aria-valuenow'); else context.setAttribute('aria-valuenow', String(Math.min(100, data.context)));
      note.textContent = !online ? 'OFFLINE / last reported totals'
        : !idle(agent) ? `ACTIVE / ${data.provisional === null ? 'turn usage pending' : `${short(data.provisional)} turn tok (provisional)`}`
          : 'REPORTED SESSION TOTALS';
    },
  };
}

/** Utility windows issue metadata/control requests only; they never send model prompts. */
export function installFeatureWindows({ windows, api, toast = () => {}, getState, background }) {
  let state = getState() || { agents: [], connected: false }, disposed = false, mutation = false;
  const events = new AbortController(), panels = new Map(), guards = new Map();
  const agents = () => state.agents || [];
  const agentById = (id) => agents().find((agent) => agent.id === id);
  const allIdle = () => !!state.connected && agents().every(idle);
  const agentIdle = (id) => !!state.connected && !!agentById(id)?.connected && idle(agentById(id));
  const on = (element, type, callback) => element.addEventListener(type, callback, { signal: events.signal });
  function guard(element, allowed) { guards.set(element, allowed); element.disabled = mutation || !allowed(); return element; }
  function controls() {
    for (const [element, allowed] of guards) {
      if (!element.isConnected) { guards.delete(element); continue; }
      element.disabled = mutation || !allowed();
      syncCombobox(element);
    }
  }
  function button(text, testid, callback, allowed) {
    const element = node('button', text); element.type = 'button'; element.dataset.testid = testid;
    on(element, 'click', callback); if (allowed) guard(element, allowed); return element;
  }
  function field(parent, labelText, testid, type = 'text') {
    const label = node('label', null, 'feature-field'), caption = node('span', labelText);
    const input = node(type === 'select' ? 'select' : 'input');
    if (type !== 'select') input.type = type;
    input.setAttribute('aria-label', labelText); input.dataset.testid = testid;
    label.append(caption, input); parent.append(label); return input;
  }
  function message(panel, text, error = false) {
    panel.status.textContent = text; panel.status.classList.toggle('feature-error', error);
    panel.status.setAttribute('role', error ? 'alert' : 'status');
  }
  function section(parent, heading) {
    const element = node('section', null, 'feature-section'); element.append(node('h3', heading)); parent.append(element); return element;
  }
  function empty(parent, text) { parent.append(node('p', text, 'feature-empty')); }
  function visible(id) { return windows.list().some((win) => win.id === id && !win.hidden); }
  function focus(id) { windows.show(id); const win = windows.windows.get(id); if (win) windows.focus(win); }
  async function load(panel, key, request, render) {
    if (disposed) return;
    if (panel.request?.key === key) return panel.request.promise;
    const generation = ++panel.generation;
    message(panel, 'Loading…');
    const promise = (async () => {
      try {
        const result = await request();
        if (disposed || generation !== panel.generation) return;
        render(result); message(panel, 'Updated.');
      } catch (error) {
        if (!disposed && generation === panel.generation) message(panel, error.message || 'Request failed.', true);
      } finally {
        if (generation === panel.generation) panel.request = null;
      }
    })();
    panel.request = { key, promise }; return promise;
  }
  async function mutate(panel, allowed, request, success, sensitive = false) {
    if (disposed || mutation) return;
    if (!allowed()) { message(panel, 'Unavailable: connect and wait for the required agents to be idle.', true); return; }
    // Invalidate metadata fetched before a mutation; it must not overwrite its result.
    panel.generation++; panel.request = null;
    mutation = true; controls(); message(panel, 'Applying…');
    try {
      const result = await request();
      if (!disposed) { message(panel, 'Applied.'); toast(sensitive ? 'Provider override updated. No key was validated or displayed.' : 'Change applied.'); await success?.(result); }
    } catch (error) {
      // Provider errors are deliberately generic: a downstream error must never echo credentials.
      if (!disposed) message(panel, sensitive ? 'Provider update failed. The key was cleared; check the provider configuration and connection.' : error.message || 'Request failed.', true);
    } finally { mutation = false; if (!disposed) { controls(); renderModels(); renderActivity(); } }
  }
  function makePanel(id, index) {
    const win = windows.windows.get(id) || windows.add({ id, title: TITLES[id], kind: 'utility', index, hidden: true });
    const root = node('div', null, 'feature-window'); root.dataset.testid = `feature-${id}`;
    const toolbar = node('div', null, 'feature-toolbar'), status = node('p', '', 'feature-status');
    status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite'); status.dataset.testid = `${id}-status`;
    const connection = node('p', state.connected ? '' : 'Disconnected. Metadata may be stale; controls are unavailable.', 'feature-connection');
    const content = node('div', null, 'feature-content'); root.append(toolbar, connection, status, content); win.body.append(root);
    const panel = { id, win, root, toolbar, connection, status, content, generation: 0, refresh: null, request: null };
    panels.set(id, panel); return panel;
  }
  Object.keys(TITLES).forEach(makePanel);
  function refreshButton(panel) {
    panel.toolbar.append(button('Refresh', `${panel.id}-refresh`, () => panel.refresh?.(), () => !!state.connected));
  }

  // Models: preserve draft selections until the selected agent's authoritative model state changes.
  const models = panels.get('models');
  const modelForm = node('form', null, 'feature-form'); models.content.append(modelForm);
  const modelAgent = field(modelForm, 'Agent', 'models-agent', 'select');
  const provider = field(modelForm, 'Provider', 'models-provider', 'select');
  const model = field(modelForm, 'Model', 'models-model', 'select');
  const thinking = field(modelForm, 'Thinking level', 'models-thinking', 'select');
  const modelState = node('p'); modelState.dataset.testid = 'models-current'; models.content.append(modelState);
  let modelSignature = '';
  const selectedModels = () => {
    const agent = agentById(modelAgent.value), result = [...(agent?.models || [])];
    if (agent?.model && !result.some((item) => item.provider === agent.model.provider && item.id === agent.model.id)) result.unshift(agent.model);
    return result;
  };
  function modelOptions(value) {
    const items = selectedModels().filter((item) => item.provider === provider.value);
    choices(model, items.length ? items.map((item) => [item.id, item.name || item.id]) : [['', 'No model available']], value);
  }
  function renderModels() {
    const oldAgent = modelAgent.value;
    choices(modelAgent, agents().length ? agents().map((agent) => [agent.id, agent.name || agent.id]) : [['', 'No agents']]);
    const agent = agentById(modelAgent.value);
    const signature = JSON.stringify([agent?.id, agent?.models, agent?.model, agent?.levels, agent?.thinking]);
    if (oldAgent !== modelAgent.value || signature !== modelSignature) {
      modelSignature = signature;
      const providers = [...new Set(selectedModels().map((item) => item.provider))];
      choices(provider, providers.length ? providers.map((id) => [id, id]) : [['', 'No providers']], agent?.model?.provider);
      modelOptions(agent?.model?.id);
      choices(thinking, (agent?.levels || []).map((level) => [level, level]), agent?.thinking);
    }
    modelState.textContent = agent ? `${agent.name || agent.id} · ${agent.phase} · Current: ${agent.model ? `${agent.model.provider} / ${agent.model.id}` : 'Unknown'} · Thinking: ${agent.thinking ?? 'Unknown'}` : 'No agents. Configure Pi in the terminal if no models are available.';
    controls();
  }
  on(modelAgent, 'change', () => { modelSignature = ''; renderModels(); });
  on(provider, 'change', () => modelOptions());
  const canModel = () => agentIdle(modelAgent.value) && !!model.value && !!provider.value;
  for (const input of [provider, model]) guard(input, () => agentIdle(modelAgent.value));
  guard(thinking, () => agentIdle(modelAgent.value) && !!thinking.value);
  const applyModel = button('Apply model', 'models-apply', () => modelForm.requestSubmit(), canModel); modelForm.append(applyModel);
  on(modelForm, 'submit', (event) => {
    event.preventDefault(); const id = modelAgent.value, body = { provider: provider.value, modelId: model.value };
    void mutate(models, () => agentIdle(id) && !!body.provider && !!body.modelId, () => api(`/api/agents/${encodeURIComponent(id)}/model`, body));
  });
  modelForm.append(button('Apply thinking', 'models-thinking-apply', () => {
    const id = modelAgent.value, level = thinking.value;
    void mutate(models, () => agentIdle(id) && !!level, () => api(`/api/agents/${encodeURIComponent(id)}/thinking`, { level }));
  }, () => agentIdle(modelAgent.value) && !!thinking.value));
  models.refresh = () => {
    const id = modelAgent.value;
    return mutate(models, () => agentIdle(id), () => api(`/api/agents/${encodeURIComponent(id)}/refresh`, {}));
  };
  models.toolbar.append(button('Refresh agent metadata', 'models-refresh', () => models.refresh(), () => agentIdle(modelAgent.value)));

  // Tool drafts are local until Apply; only runtime-reported tools are selectable.
  const tools = panels.get('tools'), toolsForm = node('form', null, 'feature-tools-form');
  tools.content.append(toolsForm);
  const toolsAgent = field(toolsForm, 'Agent', 'tools-agent', 'select');
  const toolsCurrent = node('p'), toolsList = node('div', null, 'feature-tools-list');
  toolsCurrent.dataset.testid = 'tools-current';
  const toolsExtension = node('p', null, 'feature-empty'); toolsExtension.dataset.testid = 'tools-extension';
  toolsForm.append(toolsCurrent, toolsExtension, toolsList);
  const toolsActions = node('div', null, 'feature-toolbar'); toolsForm.append(toolsActions);
  tools.content.append(node('p', 'Apply changes only this agent’s session tools. Requires a connected, idle agent with no queued messages. No prompt is sent. Tool restrictions are not an OS sandbox.', 'feature-empty'));
  let toolsSignature = '';
  const toolInputs = new Map();
  const supportsTools = (agent) => Array.isArray(agent?.availableTools) && Array.isArray(agent?.activeTools);
  // Order is not a catalog/active-set change. Usage and connection updates preserve drafts.
  const toolVersion = (agent) => JSON.stringify([state.cwd, state.contextId, agent?.id, agent?.sessionId,
    agent?.availableTools?.map(({ name, description }) => [name, description]).sort(([a], [b]) => a.localeCompare(b)),
    agent?.activeTools && [...agent.activeTools].sort()]);
  const canTools = () => {
    const agent = agentById(toolsAgent.value);
    return agentIdle(toolsAgent.value) && supportsTools(agent)
      && !(agent.queue?.steering?.length || agent.queue?.followUp?.length);
  };
  function renderTools() {
    choices(toolsAgent, agents().length ? agents().map((agent) => [agent.id, agent.name || agent.id]) : [['', 'No agents']]);
    const agent = agentById(toolsAgent.value), supported = supportsTools(agent), signature = toolVersion(agent);
    if (signature !== toolsSignature) {
      toolsSignature = signature; toolInputs.clear(); toolsList.replaceChildren(); message(tools, '');
      if (supported) {
        for (const tool of agent.availableTools) {
          const label = node('label', null, 'feature-tool'), input = node('input'); input.type = 'checkbox';
          input.id = `tools-tool-${tool.name}`; input.dataset.testid = input.id;
          input.checked = agent.activeTools.includes(tool.name);
          const caption = node('span', null, 'feature-tool-caption');
          caption.append(node('strong', tool.name), node('span', tool.description || '', 'feature-tool-description'));
          label.append(input, caption); toolsList.append(label); toolInputs.set(tool.name, input); guard(input, canTools);
        }
        if (!agent.availableTools.length) empty(toolsList, 'No tools available for this agent.');
      } else empty(toolsList, 'Tool selection is unavailable for this agent.');
    }
    toolsExtension.hidden = !agent?.extensionStatus;
    toolsExtension.textContent = agent?.extensionStatus?.message || '';
    toolsCurrent.textContent = !agent ? 'No agent selected.' : `${agent.name || agent.id} · Current active tools: ${supported ? agent.activeTools.join(', ') || 'None (all tools disabled)' : 'Unavailable (not reported)'}`;
    controls();
  }
  on(toolsAgent, 'change', renderTools);
  for (const [text, id, checked] of [['Select none', 'tools-none', false], ['Select all', 'tools-all', true]]) {
    toolsActions.append(button(text, id, () => {
      if (mutation || !canTools()) return;
      for (const input of toolInputs.values()) input.checked = checked;
    }, canTools));
  }
  toolsActions.append(button('Apply', 'tools-apply', () => toolsForm.requestSubmit(), canTools));
  on(toolsForm, 'submit', (event) => {
    event.preventDefault();
    const id = toolsAgent.value, signature = toolVersion(agentById(id));
    const selected = [...toolInputs].filter(([, input]) => input.checked).map(([name]) => name);
    void mutate(tools, () => id === toolsAgent.value && canTools(),
      () => api(`/api/agents/${encodeURIComponent(id)}/tools`, { tools: selected }), (result) => {
        // A later session/catalog/selection snapshot wins over an older in-flight response.
        if (toolVersion(agentById(id)) !== signature) return;
        state = { ...state, agents: agents().map((agent) => agent.id === id
          ? { ...agent, availableTools: result.availableTools, activeTools: result.activeTools } : agent) };
        // Apply also resets a draft when the server returns the original active set.
        if (toolsAgent.value === id) toolsSignature = '';
        renderTools(); message(tools, 'Applied.');
      });
  });

  // Provider keys live only in a password input and the single in-flight POST body.
  const providersPanel = panels.get('providers');
  providersPanel.content.append(node('p', 'Temporary overrides last for this server lifetime only. Global auth is unchanged. Keys are not provider-validated until a real request. OAuth and custom endpoints are terminal-managed.'));
  const providerList = node('div'); providersPanel.content.append(providerList);
  const providerForm = node('form', null, 'feature-form'); providersPanel.content.append(providerForm);
  const providerChoice = field(providerForm, 'Built-in provider', 'providers-provider', 'select');
  const apiKey = field(providerForm, 'Temporary API key', 'providers-key', 'password');
  apiKey.autocomplete = 'new-password'; apiKey.spellcheck = false;
  const reconnect = () => globalThis.confirm('Reconnect all agents to apply this temporary provider override? Saved sessions are preserved. No key validation request will be sent.');
  providerForm.append(button('Set key & reconnect', 'providers-set', () => providerForm.requestSubmit(), () => allIdle() && !!providerChoice.value));
  on(providerForm, 'submit', (event) => {
    event.preventDefault();
    const body = { provider: providerChoice.value, apiKey: apiKey.value }; apiKey.value = '';
    if (!body.apiKey.trim()) { message(providersPanel, 'Enter an API key.', true); return; }
    if (mutation || !allIdle() || !body.provider) { body.apiKey = ''; message(providersPanel, 'All agents must be idle and connected to the server.', true); return; }
    if (!reconnect()) { body.apiKey = ''; return; }
    void mutate(providersPanel, allIdle, async () => {
      try { return await api('/api/providers/configure', body); } finally { body.apiKey = ''; }
    }, () => providersPanel.refresh(), true);
  });
  providerForm.append(button('Remove override & reconnect', 'providers-remove', () => {
    apiKey.value = ''; const id = providerChoice.value;
    if (!reconnect()) return;
    void mutate(providersPanel, () => allIdle() && !!id, () => api('/api/providers/configure', { provider: id, remove: true }), () => providersPanel.refresh(), true);
  }, () => allIdle() && !!providerChoice.value));
  guard(apiKey, allIdle); guard(providerChoice, allIdle);
  on(providerChoice, 'change', () => { apiKey.value = ''; controls(); });
  providersPanel.refresh = () => load(providersPanel, 'providers', () => api('/api/providers'), (data) => {
    providerList.replaceChildren();
    for (const item of data.providers || []) providerList.append(node('p', `${item.name || item.id} (${item.id}) · ${item.configured ? 'Configured' : 'Not configured'} · ${item.temporaryOverride ? 'Temporary override' : 'No temporary override'}${item.canConfigure ? '' : ' · Terminal-managed'}`));
    if (!data.providers?.length) empty(providerList, 'No providers reported.');
    const items = (data.providers || []).filter((item) => item.canConfigure);
    choices(providerChoice, items.length ? items.map((item) => [item.id, item.name || item.id]) : [['', 'No configurable built-in providers']]); controls();
  }); refreshButton(providersPanel);

  // Appearance: theme accent, ground colour and a locally stored dithered
  // photo. No requests, no timers; changes apply immediately and persist.
  const backgroundPanel = panels.get('background');
  backgroundPanel.content.append(node('p', 'The theme colour paints the desktop chrome; the ground colour fills the desk. The photo is downscaled, stored locally and dithered into the ground colour. Nothing is uploaded. Very large photos show until the app restarts.'));
  const backgroundForm = node('form', null, 'feature-form'); backgroundPanel.content.append(backgroundForm);
  const themeInput = field(backgroundForm, 'Theme colour', 'background-theme', 'color');
  const groundInput = field(backgroundForm, 'Ground colour', 'background-ground', 'color');
  const photoInput = field(backgroundForm, 'Photo', 'background-photo', 'file');
  photoInput.accept = 'image/*';
  const usesBackground = () => !!background;
  const themeDefault = button('Default theme', 'background-theme-reset', () => {
    if (!background) return;
    themeInput.value = background.setTheme(DEFAULT_THEME);
    message(backgroundPanel, `Theme colour reset to ${DEFAULT_THEME}.`);
  });
  const groundDefault = button('Default ground', 'background-default', () => {
    if (!background) return;
    groundInput.value = background.setGround(DEFAULT_GROUND);
    message(backgroundPanel, `Ground colour reset to ${DEFAULT_GROUND}.`);
  });
  const photoRemove = button('Remove photo', 'background-remove', () => {
    if (!background) return;
    background.clearPhoto(); photoInput.value = '';
    message(backgroundPanel, 'Photo removed. The colours stay.');
  });
  backgroundForm.append(themeDefault, groundDefault, photoRemove);
  for (const element of [themeInput, groundInput, photoInput, themeDefault, groundDefault, photoRemove]) guard(element, usesBackground);
  on(themeInput, 'input', () => { if (background) background.setTheme(themeInput.value); });
  on(themeInput, 'change', () => { if (background) message(backgroundPanel, `Theme colour ${background.state.theme}.`); });
  on(groundInput, 'input', () => { if (background) background.setGround(groundInput.value); });
  on(groundInput, 'change', () => { if (background) message(backgroundPanel, `Ground colour ${background.state.ground}.`); });
  on(photoInput, 'change', () => {
    const file = photoInput.files && photoInput.files[0];
    if (!background || !file) return;
    message(backgroundPanel, 'Preparing photo…');
    void background.setPhotoFile(file).then((result) => {
      if (!disposed) message(backgroundPanel, result.message, result.ok && !result.stored);
    }).catch((error) => {
      if (!disposed) message(backgroundPanel, error.message || 'The photo could not be used.', true);
    }).finally(() => { photoInput.value = ''; });
  });
  const renderBackground = () => {
    if (!background) return;
    themeInput.value = background.state.theme;
    groundInput.value = background.state.ground;
  };

  // Workspace browsing never changes cwd until an explicit, confirmed Open action.
  const workspace = panels.get('workspace');
  const workspaceCurrent = node('p'); workspace.content.append(workspaceCurrent);
  const browseForm = node('form', null, 'feature-form'); workspace.content.append(browseForm);
  const pathInput = field(browseForm, 'Directory path', 'workspace-path');
  browseForm.append(button('Browse', 'workspace-browse', () => browseForm.requestSubmit(), () => !!state.connected));
  const browseInfo = node('p'), directories = section(workspace.content, 'Directory entries'), roots = section(workspace.content, 'Recent / bookmarked roots');
  workspace.content.insertBefore(browseInfo, directories);
  let browsingPath = '', parentPath = null;
  function openWorkspace(panel, path) {
    if (!path || !globalThis.confirm(`Open workspace ${path}? All agents must be idle. A new main session will be created and desktop-owned agents closed; saved sessions remain on disk.`)) return;
    return mutate(panel, allIdle, () => api('/api/workspace', { path }), (data) => {
      if (data.cwd) workspaceCurrent.textContent = `Current workspace: ${data.cwd}`;
      browsingPath = data.cwd || path; pathInput.value = browsingPath;
      invalidate(['workspace', 'git', 'sessions', 'usage']);
    });
  }
  function browse(path) {
    return load(workspace, `browse:${path || ''}`, () => api(`/api/workspace${path ? `?path=${encodeURIComponent(path)}` : ''}`), (data) => {
      browsingPath = data.listingPath || data.cwd || ''; parentPath = data.parent;
      workspaceCurrent.textContent = `Current workspace: ${data.cwd || state.cwd || 'Unknown'}`;
      browseInfo.textContent = `Browsing: ${browsingPath}`;
      // Do not overwrite a path draft typed while a browse request was in flight.
      if (!pathInput.value || pathInput.value === path) pathInput.value = browsingPath;
      directories.replaceChildren(node('h3', 'Directory entries'));
      for (const entry of data.entries || []) {
        const row = node('div', null, 'feature-row');
        row.append(node('span', `${entry.type === 'directory' ? 'DIR' : 'FILE'} / ${entry.name}`));
        if (entry.type === 'directory') row.append(button('Browse', 'workspace-entry-browse', () => { pathInput.value = entry.path; void browse(entry.path); }, () => !!state.connected));
        directories.append(row);
      }
      if (!data.entries?.length) empty(directories, 'This directory is empty.');
      roots.replaceChildren(node('h3', 'Recent / bookmarked roots'));
      for (const entry of data.recent || []) {
        const row = node('div', null, 'feature-row'); row.append(node('span', `${entry.name || entry.path} · ${entry.path}`));
        row.append(button('Browse', 'workspace-root-browse', () => { pathInput.value = entry.path; void browse(entry.path); }, () => !!state.connected),
          button('Open', 'workspace-root-open', () => openWorkspace(workspace, entry.path), allIdle),
          button('Forget bookmark', 'workspace-forget', () => mutate(workspace, () => !!state.connected, () => api('/api/workspace/forget', { path: entry.path }), () => browse(browsingPath)), () => !!state.connected)); roots.append(row);
      }
      if (!data.recent?.length) empty(roots, 'No recent or bookmarked roots.'); controls();
    });
  }
  on(browseForm, 'submit', (event) => { event.preventDefault(); if (state.connected) void browse(pathInput.value.trim()); });
  workspace.toolbar.append(button('Parent', 'workspace-parent', () => { pathInput.value = parentPath; void browse(parentPath); }, () => !!state.connected && !!parentPath),
    button('Bookmark directory', 'workspace-remember', () => mutate(workspace, () => !!state.connected && !!browsingPath, () => api('/api/workspace/remember', { path: browsingPath }), () => browse(browsingPath)), () => !!state.connected && !!browsingPath),
    button('Open directory', 'workspace-open', () => openWorkspace(workspace, browsingPath), () => allIdle() && !!browsingPath));
  workspace.refresh = () => browse(browsingPath); refreshButton(workspace);

  const git = panels.get('git'), gitSummary = node('p'), gitFiles = section(git.content, 'Changed files'), worktrees = section(git.content, 'Worktrees');
  git.content.prepend(gitSummary);
  const diffSection = section(git.content, 'Read-only diff'), diffStatus = node('p'), diff = node('pre', '', 'feature-diff');
  diff.dataset.testid = 'git-diff'; diff.tabIndex = 0; diffSection.append(diffStatus, diff);
  let repository = false, diffGeneration = 0, diffPending = false;
  async function loadDiff() {
    if (diffPending || !state.connected || !repository || disposed) return;
    diffPending = true; const generation = ++diffGeneration; diffStatus.textContent = 'Loading diff…'; controls();
    try {
      const data = await api('/api/git/diff');
      if (!disposed && generation === diffGeneration) { diff.textContent = data.diff || 'No diff reported.'; diffStatus.textContent = data.truncated ? 'Diff truncated by server.' : 'Diff loaded. Untracked file contents may not be included.'; }
    } catch (error) { if (!disposed && generation === diffGeneration) { diffStatus.textContent = error.message || 'Diff failed.'; diff.textContent = ''; } }
    finally { if (generation === diffGeneration) { diffPending = false; controls(); } }
  }
  git.toolbar.append(button('Load diff', 'git-load-diff', loadDiff, () => !!state.connected && repository && !diffPending));
  git.refresh = () => load(git, 'git', () => api('/api/git'), (data) => {
    repository = !!data.isRepo; diffGeneration++; diffPending = false; diff.textContent = ''; diffStatus.textContent = '';
    gitSummary.textContent = data.error || (repository ? `${data.root} · ${data.branch || 'Detached HEAD'} · ${data.head || 'Unknown HEAD'} · ${data.dirty ? 'Changes present' : 'Clean'}` : 'This workspace is not a Git repository.');
    gitFiles.replaceChildren(node('h3', 'Changed files')); worktrees.replaceChildren(node('h3', 'Worktrees'));
    for (const file of data.files || []) gitFiles.append(node('p', `${file.status} / ${file.path}`));
    if (!data.files?.length) empty(gitFiles, 'No changed files reported.');
    for (const tree of data.worktrees || []) {
      const row = node('div', null, 'feature-row');
      row.append(node('span', `${tree.path} · ${tree.branch || tree.head || 'Unknown revision'}${['current', 'bare', 'detached', 'locked', 'prunable'].filter((key) => tree[key]).map((key) => ` · ${key}`).join('')}`),
        button('Open workspace', 'git-worktree-open', () => openWorkspace(git, tree.path), () => allIdle() && !tree.bare)); worktrees.append(row);
    }
    if (!data.worktrees?.length) empty(worktrees, 'No worktrees reported.'); controls();
  }); refreshButton(git);

  // Unknown values stay unknown. Provisional active usage is deliberately separate from totals.
  const usage = panels.get('usage'), usageAgent = field(usage.toolbar, 'Usage view', 'usage-agent', 'select');
  const usageData = node('div'); usage.content.append(node('p', 'Session totals are authoritative reported stats. Active-message usage is provisional and is not added to those totals.'), usageData);
  let usageRows = null, usageSignature = '';
  function statsList(parent, stats = {}) {
    const list = node('dl', null, 'feature-stats');
    for (const [label, value] of [
      ['Input tokens', number(stats?.tokens?.input)], ['Output tokens', number(stats?.tokens?.output)],
      ['Cache read tokens', number(stats?.tokens?.cacheRead)], ['Cache write tokens', number(stats?.tokens?.cacheWrite)],
      ['Total tokens', number(stats?.tokens?.total)], ['Reported cost', cost(stats?.cost)],
      ['Context tokens', number(stats?.contextUsage?.tokens)], ['Context window', number(stats?.contextUsage?.contextWindow)],
      ['Context occupancy', typeof stats?.contextUsage?.percent === 'number' ? `${number(stats.contextUsage.percent)}%` : 'Unknown'],
      ['User messages', number(stats?.userMessages)], ['Assistant messages', number(stats?.assistantMessages)],
      ['Tool calls', number(stats?.toolCalls)], ['Total messages', number(stats?.totalMessages)],
    ]) list.append(node('dt', label), node('dd', value));
    parent.append(list);
  }
  function renderUsage() {
    const rows = usageRows || agents();
    choices(usageAgent, [['*', 'All agents'], ...rows.map((agent) => [agent.id, agent.name || agent.id])]);
    const selected = rows.filter((agent) => usageAgent.value === '*' || agent.id === usageAgent.value);
    const signature = JSON.stringify([usageAgent.value, selected.map(({ id, name, sessionId, stats, currentUsage }) => ({ id, name, sessionId, stats, currentUsage }))]);
    if (signature === usageSignature) return; usageSignature = signature; usageData.replaceChildren();
    if (!selected.length) empty(usageData, 'No usage reported.');
    for (const agent of selected) {
      const item = section(usageData, agent.name || agent.id); item.append(node('p', `Session: ${agent.sessionId || 'Unknown'}`)); statsList(item, agent.stats);
      item.append(node('h4', 'Provisional active-message usage (not included above)'));
      if (agent.currentUsage == null) empty(item, 'No active-message usage reported.');
      else {
        // Preserve the provider-reported shape rather than infer an unsupported cost/token schema.
        item.append(node('pre', JSON.stringify(agent.currentUsage, null, 2), 'feature-provisional'));
      }
    }
  }
  on(usageAgent, 'change', renderUsage);
  const usageVersion = (agent) => JSON.stringify([agent?.sessionId, agent?.stats, agent?.currentUsage]);
  usage.refresh = () => {
    const versions = new Map(agents().map((agent) => [agent.id, usageVersion(agent)]));
    return load(usage, 'usage', () => api('/api/usage'), (data) => {
      usageRows = (data.agents || []).map((row) => {
        const latest = agentById(row.id);
        if (!latest || usageVersion(latest) === versions.get(row.id)) return row;
        return { ...row, ...latest, stats: latest.stats === null ? null : { ...row.stats, ...latest.stats } };
      }); renderUsage();
    });
  }; refreshButton(usage);

  const sessions = panels.get('sessions'), search = field(sessions.toolbar, 'Search sessions', 'sessions-search', 'search');
  const showArchived = field(sessions.toolbar, 'Include archived sessions', 'sessions-show-archived', 'checkbox');
  const sessionList = node('div'); sessions.content.append(node('p', 'Desktop-owned sessions only. Archive changes metadata, never deletes transcripts.'), sessionList);
  let sessionRows = [];
  function renderSessions() {
    sessionList.replaceChildren();
    const query = search.value.trim().toLocaleLowerCase();
    const selected = sessionRows.filter((entry) => (!entry.archived || showArchived.checked) && [entry.name, entry.cwd, entry.preview].some((value) => String(value || '').toLocaleLowerCase().includes(query)));
    for (const entry of selected) {
      const item = section(sessionList, entry.name || 'Unnamed session'); item.dataset.sessionKey = entry.key;
      item.append(node('p', `${entry.cwd || 'Unknown workspace'} · ${date(entry.updated)} · ${number(entry.messageCount)} messages${entry.active ? ' · Active' : ''}${entry.archived ? ' · Archived' : ''}`), node('p', entry.preview || 'No preview.'));
      const renameForm = node('form', null, 'feature-form'), name = field(renameForm, 'Session name', 'sessions-name'); name.value = entry.name || ''; name.maxLength = 200;
      renameForm.append(button('Rename', 'sessions-rename', () => renameForm.requestSubmit(), allIdle));
      on(renameForm, 'submit', (event) => {
        event.preventDefault(); const value = name.value.trim(); if (!value) { message(sessions, 'Enter a session name.', true); return; }
        void mutate(sessions, allIdle, () => api('/api/sessions/rename', { key: entry.key, name: value }), () => sessions.refresh());
      }); item.append(renameForm);
      item.append(button('Resume', 'sessions-resume', () => {
        if (!globalThis.confirm(`Resume ${entry.name || 'this session'} and replace the current desktop session? Saved transcripts are preserved; the session workspace will be restored.`)) return;
        void mutate(sessions, allIdle, () => api('/api/sessions/resume', { key: entry.key }), () => invalidate(['sessions', 'workspace', 'git', 'usage']));
      }, allIdle), button(entry.archived ? 'Restore' : 'Archive', 'sessions-archive', () => mutate(sessions, () => allIdle() && (!entry.active || entry.archived), () => api('/api/sessions/archive', { key: entry.key, archived: !entry.archived }), () => sessions.refresh()), () => allIdle() && (!entry.active || entry.archived)));
    }
    if (!selected.length) empty(sessionList, sessionRows.length ? 'No sessions match these filters.' : 'No desktop sessions found.'); controls();
  }
  on(search, 'input', renderSessions); on(showArchived, 'change', renderSessions);
  sessions.toolbar.append(button('New main session', 'sessions-new', () => {
    if (!globalThis.confirm('Start a new main session? The current session remains saved.')) return;
    void mutate(sessions, () => agentIdle('main'), () => api('/api/agents/main/new', {}), () => invalidate(['sessions', 'usage']));
  }, () => agentIdle('main')), button('Clone current main session', 'sessions-clone', () => {
    void mutate(sessions, () => allIdle() && agentIdle('main'), () => api('/api/sessions/clone', {}), () => sessions.refresh());
  }, () => allIdle() && agentIdle('main')));
  sessions.refresh = () => load(sessions, 'sessions', () => api('/api/sessions'), (data) => { sessionRows = data.sessions || []; renderSessions(); }); refreshButton(sessions);

  const activity = panels.get('activity'), activityList = node('div');
  activity.content.append(node('p', 'Actual reported events only. Missing activity does not mean a process is hung. Hiding a window does not stop an agent.'), activityList);
  const activityNodes = new Map();
  function renderActivity() {
    const current = new Set(agents().map((agent) => agent.id));
    for (const [id, item] of activityNodes) if (!current.has(id)) { item.root.remove(); activityNodes.delete(id); }
    activityList.querySelector('.feature-empty')?.remove();
    if (!current.size) empty(activityList, 'No agents.');
    for (const agent of agents()) {
      let item = activityNodes.get(agent.id);
      if (!item) {
        const root = section(activityList, agent.name || agent.id), info = node('p'), queue = node('pre'), history = node('ol');
        root.append(info, queue, button('Focus agent', 'activity-focus', () => focus(agent.id)), button('Stop', 'activity-stop', () => {
          void mutate(activity, () => !!state.connected && !!agentById(agent.id)?.connected && !idle(agentById(agent.id)), () => api(`/api/agents/${encodeURIComponent(agent.id)}/stop`, {}), (result) => {
            if (result.recovered?.length) {
              const recovered = section(root, 'Recovered queued messages — copy before leaving');
              recovered.append(node('pre', result.recovered.join('\n\n')));
              message(activity, 'Stopped. Recovered queued messages are shown below; nothing was resent.');
            }
          });
        }, () => !!state.connected && !!agentById(agent.id)?.connected && !idle(agentById(agent.id))), history);
        item = { root, info, queue, history, signature: '' }; activityNodes.set(agent.id, item);
      }
      const signature = JSON.stringify([agent.name, agent.phase, agent.connected, agent.startedAt, agent.lastActivityAt, agent.currentTool, agent.queue, agent.activity, agent.notice]);
      if (signature === item.signature) continue; item.signature = signature;
      item.root.querySelector('h3').textContent = agent.name || agent.id;
      item.info.textContent = `${agent.phase || 'Unknown phase'} · ${agent.connected ? 'Connected' : 'Disconnected'}\nStarted: ${date(agent.startedAt)}\nLast activity: ${date(agent.lastActivityAt)}\nCurrent tool: ${typeof agent.currentTool === 'string' ? agent.currentTool : agent.currentTool ? JSON.stringify(agent.currentTool) : 'None reported'}${agent.notice ? `\n${agent.notice}` : ''}`;
      const queue = agent.queue || {};
      item.queue.textContent = [...(queue.steering || []).map((value) => `STEER / ${value}`), ...(queue.followUp || []).map((value) => `FOLLOW-UP / ${value}`)].join('\n') || 'No queued messages.';
      item.history.replaceChildren(...(agent.activity || []).map((event) => node('li', `${date(event.at)} · ${event.type} · ${event.label || ''}`)));
      if (!agent.activity?.length) item.history.append(node('li', 'No activity events reported.'));
    }
    controls();
  }

  function invalidate(ids) {
    for (const id of ids) {
      const panel = panels.get(id); panel.generation++; panel.request = null;
      if (id === 'git') { diffGeneration++; diffPending = false; diff.textContent = ''; repository = false; }
      if (visible(id) && state.connected) void panel.refresh?.();
    }
  }
  let visibility = new Map();
  function windowChanges() {
    if (disposed) return;
    for (const [id, panel] of panels) {
      const shown = visible(id), previous = visibility.get(id); visibility.set(id, shown);
      if (!shown && id === 'providers') apiKey.value = '';
      // Metadata refresh is explicit for models; opening it never mutates an agent.
      if (shown && !previous && state.connected && id !== 'models') void panel.refresh?.();
    }
  }
  const unsubscribe = windows.onChange(windowChanges);
  let contextSignature = JSON.stringify([state.cwd, agents().map((agent) => [agent.id, agent.sessionId])]);
  function update(snapshot) {
    if (disposed) return;
    const wasConnected = state.connected; state = snapshot || getState() || { agents: [] };
    for (const panel of panels.values()) panel.connection.textContent = state.connected ? '' : 'Disconnected. Metadata may be stale; controls are unavailable.';
    workspaceCurrent.textContent = `Current workspace: ${state.cwd || 'Unknown'}`;
    renderModels(); renderTools(); renderActivity(); renderBackground();
    if (usageRows) {
      usageRows = agents().map((agent) => {
        const previous = usageRows.find((row) => row.id === agent.id && row.sessionId === agent.sessionId);
        return { ...previous, ...agent, stats: agent.stats === null ? null : { ...previous?.stats, ...agent.stats }, currentUsage: agent.currentUsage };
      });
    }
    renderUsage(); controls();
    const next = JSON.stringify([state.cwd, agents().map((agent) => [agent.id, agent.sessionId])]);
    if (next !== contextSignature || (!wasConnected && state.connected)) {
      const cwdChanged = JSON.parse(contextSignature)[0] !== state.cwd;
      contextSignature = next;
      if (cwdChanged) { browsingPath = ''; usageRows = null; }
      invalidate(['workspace', 'git', 'usage', 'sessions', 'providers']);
    }
  }
  renderModels(); renderTools(); renderActivity(); renderUsage(); renderBackground(); windowChanges();
  return {
    open(id, agentId) {
      if (disposed || !panels.has(id)) return false;
      if (id === 'tools' && agentId != null) {
        if (!agentById(agentId)) return false;
        toolsAgent.value = agentId; renderTools();
      }
      focus(id); return true;
    },
    update,
    dispose() {
      if (disposed) return;
      disposed = true; events.abort(); unsubscribe(); apiKey.value = ''; diffGeneration++;
      for (const panel of panels.values()) { panel.generation++; panel.root.remove(); }
      guards.clear(); activityNodes.clear(); toolInputs.clear();
      // DesktopWindows shells and persisted layout remain owned by the host.
    },
  };
}
