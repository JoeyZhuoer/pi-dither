import { basename, relative, sep } from 'node:path';
import { homedir } from 'node:os';
import { createLayout } from './layout.mjs';

const WIDGET_KEY = 'pi-terminal-ui:input';
const COMMANDS = ['on', 'off', 'compact', 'auto', 'ascii', 'unicode'];

export function installWorkstation(pi, { version, visibleWidth, truncateToWidth }) {
  const layout = createLayout({ visibleWidth, truncateToWidth });
  const options = { compact: false, ascii: false };
  const renderRequests = new Set();
  let context;
  let enabled = true;
  let attached = false;

  function snapshot() {
    const cwd = context.cwd;
    const homeRelative = relative(homedir(), cwd);
    const inHome = homeRelative === '' || (!homeRelative.startsWith(`..${sep}`)
      && homeRelative !== '..' && !homeRelative.startsWith(sep));
    const path = inHome ? `~${homeRelative ? sep + homeRelative : ''}` : cwd;
    const session = context.sessionManager.getSessionName()
      || `Session ${context.sessionManager.getSessionId().slice(0, 8)}`;
    return {
      version,
      project: basename(cwd) || cwd,
      path,
      model: context.model ? `${context.model.provider}/${context.model.id}` : undefined,
      session,
    };
  }

  function component(tui, renderer) {
    const request = () => tui.requestRender();
    renderRequests.add(request);
    let disposed = false;
    return {
      render(width) {
        if (disposed || !context) return [];
        return renderer(snapshot(), width, tui.terminal.rows, context.ui.theme, options);
      },
      // All styling is computed during render, so theme invalidation cannot leave cached colors.
      invalidate() {},
      dispose() {
        disposed = true;
        renderRequests.delete(request);
      },
    };
  }

  function detach(ctx) {
    if (!attached) return;
    attached = false;
    ctx.ui.setWidget(WIDGET_KEY, undefined);
    ctx.ui.setHeader(undefined);
    ctx.ui.setWorkingIndicator();
    renderRequests.clear();
  }

  function attach(ctx) {
    context = ctx;
    if (attached || !enabled || ctx.mode !== 'tui') return;
    attached = true;
    try {
      ctx.ui.setHeader((tui) => component(tui, layout.renderHeader));
      ctx.ui.setWidget(WIDGET_KEY, (tui) => component(tui, layout.renderInputRail), {
        placement: 'aboveEditor',
      });
      // An uncolored static marker follows the terminal foreground, including theme changes.
      // Core retains its working message, retry/compaction indicators and cancellation behavior.
      ctx.ui.setWorkingIndicator({ frames: ['*'] });
    } catch (error) {
      detach(ctx);
      throw error;
    }
  }

  pi.on('session_start', (_event, ctx) => {
    if (ctx.mode !== 'tui') return;
    attach(ctx);
  });

  for (const event of ['model_select', 'thinking_level_select', 'session_info_changed', 'session_tree']) {
    pi.on(event, (_event, ctx) => {
      if (ctx.mode !== 'tui') return;
      context = ctx;
      for (const request of renderRequests) request();
    });
  }

  pi.on('session_shutdown', (_event, ctx) => {
    if (ctx.mode !== 'tui') return;
    detach(ctx);
    context = undefined;
  });

  pi.registerCommand('workstation', {
    description: 'Layout: on, off, compact, auto, ascii, unicode. Never changes your theme or editor.',
    getArgumentCompletions(prefix) {
      return COMMANDS.filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value }));
    },
    async handler(args, ctx) {
      if (ctx.mode !== 'tui') return;
      const command = args.trim().toLowerCase();
      if (!COMMANDS.includes(command)) {
        ctx.ui.notify('Usage: /workstation on|off|compact|auto|ascii|unicode. /hotkeys shows core controls.', 'info');
        return;
      }
      context = ctx;
      if (command === 'off') {
        enabled = false;
        detach(ctx);
        ctx.ui.notify('Workstation layout off. Core header restored; theme unchanged.', 'info');
        return;
      }
      enabled = true;
      if (command === 'compact' || command === 'auto') options.compact = command === 'compact';
      if (command === 'ascii' || command === 'unicode') options.ascii = command === 'ascii';
      attach(ctx);
      for (const request of renderRequests) request();
      ctx.ui.notify(`Workstation layout: ${options.compact ? 'compact' : 'auto'} / ${options.ascii ? 'ASCII' : 'Unicode'}.`, 'info');
    },
  });
}
