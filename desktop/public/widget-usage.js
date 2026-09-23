import { installUsageDiagram } from './features.js';

/**
 * Usage widget: the right-rail selected-agent chart registered with the desktop
 * widget host. The host owns placement and sizing; this module owns only the DOM
 * it renders inside the supplied root and mirrors `updateUsageDiagram` in app.js.
 * The selected agent comes from the host context, never from a fabricated state.
 */
export function install(host) {
  let view = null, container = null;
  return host.register({
    type: 'usage',
    title: 'Usage / session',
    defaultSize: [2, 3],
    sizes: [[2, 2], [2, 3]],
    render(root, ctx) {
      container = root;
      // The heading callback resolves ctx.openUsage() at click time so a re-issued
      // context still opens the Usage window.
      view = installUsageDiagram(root, () => ctx.openUsage());
    },
    update(state, ctx) {
      if (!view) return;
      const agents = state?.agents || [];
      const selected = typeof ctx?.getSelectedAgent === 'function' ? ctx.getSelectedAgent() : null;
      const agent = selected || agents.find((candidate) => candidate.id === 'main') || agents[0] || null;
      view.update(agent, Boolean(state?.connected));
    },
    destroy() {
      view = null;
      container?.replaceChildren();
      container = null;
    },
  });
}
