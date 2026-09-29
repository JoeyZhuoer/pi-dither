import { installUsageDiagram } from './features.js';

const CHART_WIDTH = 252;
const CHART_HEIGHT = 52;
const MAX_SAMPLES = 40;

/**
 * Time-vs-token strip chart for the 2x3 usage widget. It keeps a bounded
 * in-memory history of the reported session total: an unknown total is stored
 * as null, which breaks the line instead of fabricating a value, and the
 * history resets when the selected agent changes. The host supplies ctx.size
 * per widget; the chart is shown only for a 2x3 placement and repainted on
 * every update (including the update the host re-issues after a resize).
 */
export function createUsageChart() {
  const element = document.createElement('canvas');
  element.className = 'usage-chart';
  element.dataset.testid = 'usage-chart';
  element.width = CHART_WIDTH; element.height = CHART_HEIGHT;
  element.setAttribute('role', 'img');
  element.setAttribute('aria-label', 'Reported tokens per user turn');
  element.style.display = 'none'; element.style.width = '100%';
  element.style.height = `${CHART_HEIGHT}px`; element.style.marginTop = '4px';
  const history = [];
  let agentId = null;

  function draw() {
    const context = element.getContext?.('2d');
    if (!context) return;
    const width = element.width, height = element.height;
    const left = 3, right = width - 3, top = 5, bottom = height - 5;
    context.clearRect(0, 0, width, height);
    // Thin axis: a vertical rule plus the baseline.
    context.strokeStyle = '#20201f'; context.lineWidth = 1;
    context.beginPath(); context.moveTo(left, top); context.lineTo(left, bottom); context.lineTo(right, bottom); context.stroke();
    const known = history.filter((sample) => sample.tokens !== null);
    if (!known.length) return;
    const max = Math.max(1, ...known.map((sample) => sample.tokens));
    // x is the completed user turn: one evenly spaced slot per user input.
    const at = (index) => history.length < 2 ? (left + right) / 2 : left + (index / (history.length - 1)) * (right - left);
    const place = (index, tokens) => [at(index), bottom - (tokens / max) * (bottom - top)];
    context.beginPath();
    let drawing = false;
    history.forEach((sample, index) => {
      if (sample.tokens === null) { drawing = false; return; }
      const [x, y] = place(index, sample.tokens);
      if (drawing) context.lineTo(x, y); else { context.moveTo(x, y); drawing = true; }
    });
    context.stroke();
    // A 2x2 ink square per completed turn keeps single-point runs visible.
    history.forEach((sample, index) => {
      if (sample.tokens === null) return;
      const [x, y] = place(index, sample.tokens);
      context.fillRect(x - 1, y - 1, 2, 2);
    });
  }

  // One point per user input, derived from the transcript: assistant usage
  // between two user messages is that turn's token total. A hydrated session
  // rebuilds the full chart after resume; no timers or wall-clock sampling.
  function historyOf(agent) {
    const messages = Array.isArray(agent?.messages) ? agent.messages : [];
    const turns = [];
    for (const message of messages) {
      if (message?.role === 'user') { turns.push({ turn: turns.length + 1, tokens: 0, known: false }); continue; }
      if (message?.role !== 'assistant' || !turns.length) continue;
      const usage = message.usage;
      if (!usage) continue;
      const total = Number.isFinite(usage.totalTokens) ? usage.totalTokens
        : [usage.input, usage.output, usage.cacheRead, usage.cacheWrite].reduce((sum, value) => sum + (Number.isFinite(value) ? value : 0), 0);
      const last = turns[turns.length - 1];
      last.tokens += total; last.known = true;
    }
    return turns.map(({ turn, tokens, known }) => ({ turn, tokens: known ? tokens : null }));
  }

  return {
    element, history,
    update(agent, size) {
      const id = agent?.id || '';
      if (id !== agentId) { agentId = id; history.length = 0; }
      const next = historyOf(agent).slice(-MAX_SAMPLES);
      if (JSON.stringify(next) !== JSON.stringify(history)) { history.length = 0; history.push(...next); }
      const large = (size?.h ?? 0) >= 3;
      element.style.display = large ? 'block' : 'none';
      if (large) {
        // The chart flexes to the remaining rail height; resize the bitmap to match.
        const rendered = Math.round(element.clientHeight || 0);
        if (rendered > 0 && rendered !== element.height) element.height = rendered;
        draw();
      }
    },
  };
}

/**
 * Usage widget: the right-rail selected-agent chart registered with the desktop
 * widget host. The host owns placement and sizing (including ctx.size and the
 * update re-issued after a resize); this module owns only the DOM it renders
 * inside the supplied root and mirrors `updateUsageDiagram` in app.js. The
 * selected agent comes from the host context, never from a fabricated state.
 * The widget reports no connection/status line; the 2x3 token trend replaces it.
 */
export function install(host) {
  let view = null, container = null, chart = null;
  return host.register({
    type: 'usage',
    title: 'Usage / session',
    defaultSize: [2, 3],
    sizes: [[2, 2], [2, 3]],
    render(root, ctx) {
      container = root;
      view = installUsageDiagram(root);
      chart = createUsageChart();
      root.append(chart.element);
    },
    update(state, ctx) {
      if (!view) return;
      const agents = state?.agents || [];
      const selected = typeof ctx?.getSelectedAgent === 'function' ? ctx.getSelectedAgent() : null;
      const agent = selected || agents.find((candidate) => candidate.id === 'main') || agents[0] || null;
      view.update(agent, Boolean(state?.connected));
      chart?.update(agent, ctx?.size);
    },
    destroy() {
      view = null; chart = null;
      container?.replaceChildren();
      container = null;
    },
  });
}
