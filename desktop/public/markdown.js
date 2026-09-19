// A deliberately small Markdown renderer: generated elements only, never HTML parsing.
const MAX_SOURCE = 200_000;
const MAX_DEPTH = 16;
const MAX_NODES = 12_000;
const MAX_INLINE_WORK = 2_000_000;

/** Only explicit web/mail links and local relative references are navigable. */
export function safeMarkdownUrl(value) {
  const url = String(value ?? '').trim();
  if (!url || /[\s\u0000-\u001f\u007f-\u009f\\<>"'`]/u.test(url) || url.startsWith('//')) return null;
  const scheme = /^([a-z][a-z\d+.-]*):/i.exec(url);
  if (scheme) {
    if (!/^(https?|mailto)$/i.test(scheme[1])) return null;
    try {
      const parsed = new URL(url);
      if (/^https?:$/i.test(parsed.protocol) && (!/^https?:\/\//i.test(url) || !parsed.hostname)) return null;
      return url;
    } catch { return null; }
  }
  // A colon before the first slash/hash/query is not a relative path.
  return /^[^/#?]*:/.test(url) ? null : url;
}

function element(ctx, tag, text, className) {
  ctx.nodes--;
  const node = ctx.doc.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function plain(ctx, target, text) {
  if (text) target.append(ctx.doc.createTextNode(text));
}
function escaped(text, index) {
  let count = 0;
  while (index > 0 && text[--index] === '\\') count++;
  return count % 2 === 1;
}
function closing(text, marker, from) {
  let end = text.indexOf(marker, from);
  while (end >= 0 && escaped(text, end)) end = text.indexOf(marker, end + marker.length);
  return end;
}
function emphasisEnd(text, marker, from) {
  let end = closing(text, marker, from);
  while (end >= 0) {
    let length = marker.length;
    while (text[end + length] === marker[0]) length++;
    if (!(marker.length === 1 && length === 2)) {
      const candidate = end + length - marker.length;
      if (!/\s/.test(text[candidate - 1]) && !(marker[0] === '_' && /[\p{L}\p{N}]/u.test(text[candidate + marker.length] || ''))) return candidate;
    }
    end = closing(text, marker, end + length);
  }
  return -1;
}
function linkAt(text, start) {
  const labelEnd = closing(text, ']', start + 1);
  if (labelEnd < 0 || text[labelEnd + 1] !== '(') return null;
  let end = labelEnd + 2, nesting = 1, angle = false;
  for (; end < text.length; end++) {
    if (text[end] === '\\') { end++; continue; }
    if (text[end] === '<') angle = true;
    if (text[end] === '>') angle = false;
    if (!angle && text[end] === '(') nesting++;
    if (!angle && text[end] === ')' && --nesting === 0) break;
  }
  if (nesting) return null;
  const destination = text.slice(labelEnd + 2, end).trim();
  const match = /^(?:<([^<>]*)>|(\S+?))(?:\s+["']([^\n]*)["'])?$/.exec(destination);
  if (!match) return null;
  return { label: text.slice(start + 1, labelEnd), url: (match[1] ?? match[2]).replace(/\\([\\()])/g, '$1'), end: end + 1 };
}
function inline(ctx, target, text, depth = 0, allowLinks = true) {
  if (depth >= MAX_DEPTH || ctx.nodes <= 0) { plain(ctx, target, text); return; }
  let index = 0, buffer = '';
  const flush = () => { plain(ctx, target, buffer); buffer = ''; };
  while (index < text.length) {
    if (ctx.nodes <= 0 || ctx.work <= 0) { buffer += text.slice(index); break; }
    const char = text[index];
    if (char === '\\' && /[!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~]/.test(text[index + 1] || '')) {
      buffer += text[index + 1]; index += 2; continue;
    }
    if (!'`[*_~!'.includes(char)) { buffer += char; index++; continue; }
    // Bound repeated delimiter searches for hostile or incomplete streamed input.
    ctx.work -= text.length - index;
    if (char === '`') {
      const run = /^`+/.exec(text.slice(index))[0];
      let end = closing(text, run, index + run.length);
      while (end >= 0 && (text[end - 1] === '`' || text[end + run.length] === '`')) end = closing(text, run, end + run.length);
      if (end >= 0) {
        flush();
        let code = text.slice(index + run.length, end).replace(/\n/g, ' ');
        if (/^ .* $/.test(code) && /[^ ]/.test(code)) code = code.slice(1, -1);
        target.append(element(ctx, 'code', code)); index = end + run.length; continue;
      }
      buffer += run; index += run.length; continue;
    }
    const image = char === '!' && text[index + 1] === '[';
    if (image || (char === '[' && allowLinks)) {
      const link = linkAt(text, index + (image ? 1 : 0));
      if (link) {
        flush();
        if (image) target.append(element(ctx, 'span', `[Image: ${link.label || 'image'}]`, 'md-image-placeholder'));
        else {
          const url = safeMarkdownUrl(link.url);
          const node = element(ctx, url ? 'a' : 'span');
          if (url) {
            node.setAttribute('href', url);
            node.setAttribute('rel', 'noopener noreferrer');
            node.setAttribute('target', '_blank');
          }
          inline(ctx, node, link.label, depth + 1, false); target.append(node);
        }
        index = link.end; continue;
      }
    }
    if ('*_~'.includes(char)) {
      const run = text.slice(index).match(/^(\*+|_+|~+)/)[0];
      const marker = run.length >= 3 && char !== '~' ? char.repeat(3) : run.length >= 2 ? char.repeat(2) : char;
      const intraword = char === '_' && /[\p{L}\p{N}]/u.test(text[index - 1] || '');
      if (!intraword && (char !== '~' || marker === '~~') && /\S/.test(text[index + marker.length] || '')) {
        const end = emphasisEnd(text, marker, index + marker.length);
        if (end > index + marker.length) {
          flush();
          const node = element(ctx, char === '~' ? 'del' : marker.length >= 2 ? 'strong' : 'em');
          const content = marker.length === 3 ? element(ctx, 'em') : node;
          inline(ctx, content, text.slice(index + marker.length, end), depth + 1, allowLinks);
          if (content !== node) node.append(content);
          target.append(node); index = end + marker.length; continue;
        }
      }
    }
    buffer += char; index++;
  }
  flush();
}

const fence = line => /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
const heading = line => /^ {0,3}(#{1,6})(?:\s+|$)(.*)$/.exec(line);
const quote = line => /^ {0,3}> ?(.*)$/.exec(line);
const rule = line => /^ {0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/.test(line);
function listMarker(line) {
  const match = /^( *)([-+*]|\d{1,9}[.)])(?: +(.*)|$)/.exec(line);
  if (!match) return null;
  return { indent: match[1].length, ordered: /^\d/.test(match[2]), start: parseInt(match[2], 10), content: match[3] || '', width: match[0].length - (match[3] || '').length };
}
function cells(line) {
  let text = line.trim();
  if (text.startsWith('|')) text = text.slice(1);
  if (text.endsWith('|') && !escaped(text, text.length - 1)) text = text.slice(0, -1);
  const result = []; let start = 0, ticks = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\\') { i++; continue; }
    if (text[i] === '`') {
      const run = /^`+/.exec(text.slice(i))[0].length;
      ticks = ticks === run ? 0 : ticks || run; i += run - 1;
    } else if (text[i] === '|' && !ticks) { result.push(text.slice(start, i).trim()); start = i + 1; }
  }
  result.push(text.slice(start).trim()); return result;
}
function tableHeader(lines, index) {
  if (!lines[index]?.includes('|') || !lines[index + 1]) return null;
  const headers = cells(lines[index]), separators = cells(lines[index + 1]);
  if (headers.length > 100 || headers.length !== separators.length || !separators.every(cell => /^:?-{3,}:?$/.test(cell))) return null;
  return { headers, align: separators.map(cell => cell.startsWith(':') ? cell.endsWith(':') ? 'center' : 'left' : cell.endsWith(':') ? 'right' : '') };
}
function startsBlock(lines, i) {
  return fence(lines[i]) || heading(lines[i]) || quote(lines[i]) || rule(lines[i]) || listMarker(lines[i]) || tableHeader(lines, i);
}
function codeBlock(ctx, target, text, info) {
  const wrapper = element(ctx, 'div', undefined, 'md-code-block');
  const toolbar = element(ctx, 'div', undefined, 'md-code-toolbar');
  toolbar.append(element(ctx, 'span', info.trim().split(/\s+/)[0].slice(0, 80) || 'code'));
  const button = element(ctx, 'button', 'Copy code');
  button.type = 'button'; button.setAttribute('aria-label', 'Copy code');
  const status = element(ctx, 'span', '', 'md-copy-status'); status.setAttribute('role', 'status');
  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      const clipboard = ctx.doc.defaultView?.navigator?.clipboard;
      if (!clipboard?.writeText) throw new Error('Clipboard unavailable');
      await clipboard.writeText(text); status.textContent = 'Copied';
    } catch { status.textContent = 'Copy unavailable — select code to copy.'; }
    finally { button.disabled = false; }
  });
  toolbar.append(button, status);
  const pre = element(ctx, 'pre'); pre.append(element(ctx, 'code', text));
  wrapper.append(toolbar, pre); target.append(wrapper);
}
function blocks(ctx, target, lines, depth = 0) {
  if (depth >= MAX_DEPTH) { target.append(element(ctx, 'pre', lines.join('\n'), 'md-plain')); return; }
  let i = 0;
  while (i < lines.length) {
    if (ctx.nodes <= 0) { target.append(element(ctx, 'pre', lines.slice(i).join('\n'), 'md-plain')); break; }
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    const opened = fence(line);
    if (opened) {
      const body = []; i++;
      const close = new RegExp(`^ {0,3}${opened[1][0]}{${opened[1].length},}\\s*$`);
      while (i < lines.length && !close.test(lines[i])) body.push(lines[i++]);
      const closed = i < lines.length;
      if (closed) i++;
      codeBlock(ctx, target, body.join('\n') + (closed && body.length ? '\n' : ''), opened[2]); continue;
    }
    const title = heading(line);
    if (title) {
      const node = element(ctx, `h${title[1].length}`);
      inline(ctx, node, title[2].replace(/\s+#+\s*$/, '')); target.append(node); i++; continue;
    }
    if (i + 1 < lines.length && /^ {0,3}(?:=+|-+)\s*$/.test(lines[i + 1])) {
      const node = element(ctx, lines[i + 1].trim()[0] === '=' ? 'h1' : 'h2');
      inline(ctx, node, line); target.append(node); i += 2; continue;
    }
    if (rule(line)) { target.append(element(ctx, 'hr')); i++; continue; }
    if (quote(line)) {
      const body = [];
      while (i < lines.length && quote(lines[i])) body.push(quote(lines[i++])[1]);
      const node = element(ctx, 'blockquote'); blocks(ctx, node, body, depth + 1); target.append(node); continue;
    }
    const first = listMarker(line);
    if (first) {
      const list = element(ctx, first.ordered ? 'ol' : 'ul');
      if (first.ordered && first.start !== 1) list.setAttribute('start', String(first.start));
      while (i < lines.length && ctx.nodes > 0) {
        const marker = listMarker(lines[i]);
        if (!marker || marker.indent !== first.indent || marker.ordered !== first.ordered) break;
        const body = [marker.content]; i++;
        while (i < lines.length) {
          if (!lines[i].trim()) {
            let next = i + 1; while (next < lines.length && !lines[next].trim()) next++;
            const nextMarker = listMarker(lines[next] || '');
            const indent = /^( *)/.exec(lines[next] || '')[1].length;
            if (next < lines.length && (indent > first.indent || (nextMarker && nextMarker.indent === first.indent && nextMarker.ordered === first.ordered))) { while (i < next) { body.push(''); i++; } continue; }
            break;
          }
          const nextMarker = listMarker(lines[i]);
          const indent = /^( *)/.exec(lines[i])[1].length;
          if (indent <= first.indent || (nextMarker && nextMarker.indent <= first.indent)) break;
          body.push(lines[i].slice(Math.min(indent, marker.width))); i++;
        }
        const item = element(ctx, 'li');
        const task = /^\[([ xX])\](?:\s+|$)/.exec(body[0]);
        if (task) {
          item.className = 'md-task';
          const checkbox = element(ctx, 'input'); checkbox.type = 'checkbox'; checkbox.disabled = true; checkbox.checked = task[1] !== ' ';
          checkbox.setAttribute('aria-label', checkbox.checked ? 'Completed task' : 'Incomplete task');
          item.append(checkbox); body[0] = body[0].slice(task[0].length);
        }
        blocks(ctx, item, body, depth + 1); list.append(item);
      }
      target.append(list); continue;
    }
    const table = tableHeader(lines, i);
    if (table) {
      const wrapper = element(ctx, 'div', undefined, 'md-table-scroll');
      wrapper.tabIndex = 0; wrapper.setAttribute('role', 'region'); wrapper.setAttribute('aria-label', 'Markdown table');
      const node = element(ctx, 'table'), head = element(ctx, 'thead'), body = element(ctx, 'tbody');
      const row = (values, header) => {
        const tr = element(ctx, 'tr');
        table.headers.forEach((_, col) => {
          const td = element(ctx, header ? 'th' : 'td');
          if (header) td.setAttribute('scope', 'col');
          if (table.align[col]) td.className = `md-align-${table.align[col]}`;
          inline(ctx, td, values[col] || ''); tr.append(td);
        }); return tr;
      };
      head.append(row(table.headers, true)); i += 2;
      while (i < lines.length && lines[i].trim() && lines[i].includes('|') && ctx.nodes > 0) body.append(row(cells(lines[i++]), false));
      node.append(head, body); wrapper.append(node); target.append(wrapper); continue;
    }
    const body = [line]; i++;
    while (i < lines.length && lines[i].trim() && !startsBlock(lines, i) && !/^ {0,3}(?:=+|-+)\s*$/.test(lines[i])) body.push(lines[i++]);
    const node = element(ctx, 'p'); inline(ctx, node, body.join('\n')); target.append(node);
  }
}

/** Replace target contents with safe Markdown DOM. Incomplete syntax remains text.
 * Limits bound parsing work; excess source is retained as plain text, not dropped.
 */
export function renderMarkdown(target, text) {
  const source = String(text ?? '').replace(/\r\n?/g, '\n');
  const ctx = { doc: target.ownerDocument, nodes: MAX_NODES, work: MAX_INLINE_WORK };
  const fragment = ctx.doc.createDocumentFragment();
  blocks(ctx, fragment, source.slice(0, MAX_SOURCE).split('\n'));
  if (source.length > MAX_SOURCE) fragment.append(element(ctx, 'pre', source.slice(MAX_SOURCE), 'md-plain'));
  target.classList.add('markdown');
  target.replaceChildren(fragment);
}
