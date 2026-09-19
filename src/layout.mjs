import { stripVTControlCharacters } from 'node:util';

// Only metadata is sanitized. Pi still owns the original transcript and editor.
export function cleanLabel(value) {
  return stripVTControlCharacters(String(value ?? ''))
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function createLayout({ visibleWidth, truncateToWidth }) {
  function dimensions(width, height) {
    return {
      width: Number.isFinite(width) ? Math.max(0, Math.min(512, Math.floor(width))) : 0,
      height: Number.isFinite(height) ? Math.max(0, Math.floor(height)) : 24,
    };
  }

  function helpers(width, theme, ascii) {
    const glyph = ascii
      ? { h: '-', v: '|', tl: '+', tr: '+', bl: '+', br: '+', sep: '+' }
      : { h: '─', v: '│', tl: '┌', tr: '┐', bl: '└', br: '┘', sep: '┬' };
    const fit = (text, size) => truncateToWidth(text, Math.max(0, size), '');
    const pad = (text, size) => {
      const clipped = fit(text, size);
      return clipped + ' '.repeat(Math.max(0, size - visibleWidth(clipped)));
    };
    const fg = (token, text) => theme.fg(token, text);
    const border = (text) => fg('border', text);
    const pair = (left, right, size) => {
      const rightWidth = visibleWidth(right);
      if (rightWidth + 3 >= size) return pad(left, size);
      const leftWidth = size - rightWidth - 2;
      return pad(left, leftWidth) + '  ' + right;
    };
    const row = (left, right = '') => border(glyph.v) + ' '
      + pair(left, right, width - 4) + ' ' + border(glyph.v);
    const rule = (left = '', right = '') => {
      const content = pair(left, right, width - 4);
      return border(glyph.tl + glyph.h) + content + border(glyph.h + glyph.tr);
    };
    const bottom = () => border(glyph.bl + glyph.h.repeat(width - 2) + glyph.br);
    const columns = (left, right, token = 'text') => {
      const leftWidth = Math.floor((width - 7) / 2);
      const rightWidth = width - 7 - leftWidth;
      return border(glyph.v) + ' ' + pad(fg(token, left), leftWidth)
        + ' ' + border(glyph.v) + ' ' + pad(fg(token, right), rightWidth)
        + ' ' + border(glyph.v);
    };
    return { glyph, fit, pad, fg, border, pair, row, rule, bottom, columns };
  }

  function renderHeader(snapshot, requestedWidth, requestedHeight, theme, options = {}) {
    const { width, height } = dimensions(requestedWidth, requestedHeight);
    if (width < 20 || height < 12) return [];
    const ascii = options.ascii ?? false;
    const { fg, fit, border, row, rule, bottom, columns } = helpers(width, theme, ascii);
    const project = cleanLabel(snapshot.project);
    const path = cleanLabel(snapshot.path);
    const model = cleanLabel(snapshot.model) || 'No model selected';
    const session = cleanLabel(snapshot.session) || 'Unnamed session';
    const version = cleanLabel(snapshot.version);
    const title = fg('accent', theme.bold(' PI / WORKSTATION '));
    const core = fg('muted', ` CORE / ${version} `);
    const commandHint = fg('muted', '/hotkeys  /settings');

    if (width < 60 || height < 20 || options.compact) {
      return [
        fit(fg('accent', theme.bold('PI / WORKSTATION')) + fg('muted', `  / ${project}`), width),
        fit(fg('muted', path), width),
      ];
    }

    if (width < 100 || height < 32) {
      return [
        rule(title, core),
        row(fg('text', project), fg('muted', 'LOCAL TERMINAL')),
        row(fg('muted', path)),
        bottom(),
        fit(fg('accent', ' 02 / TRANSCRIPT') + '    ' + commandHint, width),
      ];
    }

    const leftSpan = Math.floor((width - 7) / 2) + 2;
    const rightSpan = width - 3 - leftSpan;
    const separator = border((ascii ? '+' : '├')
      + (ascii ? '-' : '─').repeat(leftSpan)
      + (ascii ? '+' : '┬')
      + (ascii ? '-' : '─').repeat(rightSpan)
      + (ascii ? '+' : '┤'));
    return [
      rule(title, core),
      row(fg('text', theme.bold('YOUR TERMINAL. YOUR TOOLS.')), fg('muted', 'LOCAL PRESENTATION / CORE PI')),
      separator,
      columns('01 / WORKSPACE', 'ENGINE / SESSION', 'accent'),
      columns(project, model),
      columns(path, session, 'muted'),
      bottom(),
      fit(fg('accent', ' 02 / TRANSCRIPT') + '    ' + commandHint, width),
    ];
  }

  function renderInputRail(snapshot, requestedWidth, requestedHeight, theme, options = {}) {
    const { width, height } = dimensions(requestedWidth, requestedHeight);
    if (width < 20 || height < 16) return [];
    const { fg, pair, pad } = helpers(width, theme, options.ascii ?? false);
    const project = width >= 100 ? ` / ${cleanLabel(snapshot.project)}` : '';
    const left = fg('accent', theme.bold(` 03 / INPUT${project}`));
    const right = fg('muted', width >= 80 ? '/model  /tree  /workstation ' : '/workstation ');
    const content = width >= 60 ? pair(left, right, width) : pad(left, width);
    return [theme.bg('customMessageBg', content)];
  }

  return { renderHeader, renderInputRail };
}
