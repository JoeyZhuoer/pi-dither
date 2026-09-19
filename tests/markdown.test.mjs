import test from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown, safeMarkdownUrl } from '../desktop/public/markdown.js';

// Minimal DOM test double. No HTML parser: accidental innerHTML use fails immediately.
class Node {
  constructor(doc, tag = '#text', text = '') {
    this.ownerDocument = doc; this.tagName = tag; this.children = []; this.attributes = {}; this.listeners = {};
    this.value = text; this.className = '';
    this.classList = { add: name => { this.className = `${this.className} ${name}`.trim(); } };
  }
  set innerHTML(_) { throw new Error('HTML injection sink used'); }
  append(...nodes) {
    for (const node of nodes) {
      if (node.tagName === '#fragment') this.children.push(...node.children);
      else this.children.push(node);
    }
  }
  replaceChildren(...nodes) { this.children = []; this.value = ''; this.append(...nodes); }
  set textContent(text) { this.children = []; this.value = String(text); }
  get textContent() { return this.value + this.children.map(node => node.textContent).join(''); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  addEventListener(name, listener) { this.listeners[name] = listener; }
}
function fixture(text, clipboard) {
  const doc = {
    createElement: tag => new Node(doc, tag),
    createTextNode: text => new Node(doc, '#text', text),
    createDocumentFragment: () => new Node(doc, '#fragment'),
    defaultView: { navigator: { clipboard } },
  };
  const target = new Node(doc, 'div');
  renderMarkdown(target, text); return target;
}
function all(node, tag) { return node.children.flatMap(child => [...(child.tagName === tag ? [child] : []), ...all(child, tag)]); }
function every(node) { return [node, ...node.children.flatMap(every)]; }

test('markdown: headings, nested emphasis, strike, rules, inline code and escaped syntax', () => {
  const target = fixture('# Title\n\n## Second\n\nUnderline\n===\n\n**bold and *italic***, *italic **bold***, ***both***, ~~gone~~ and `x < y`. foo_bar_baz \\*literal\\*\n\n---');
  assert.equal(all(target, 'h1').length, 2);
  assert.equal(all(target, 'h2')[0].textContent, 'Second');
  assert.equal(all(target, 'strong')[0].textContent, 'bold and italic');
  assert.equal(all(target, 'em')[1].textContent, 'italic bold');
  assert.equal(all(target, 'del')[0].textContent, 'gone');
  assert.equal(all(target, 'code')[0].textContent, 'x < y');
  assert.equal(all(target, 'hr').length, 1);
  assert.match(target.textContent, /foo_bar_baz \*literal\*/);
});

test('markdown: nested mixed lists, ordered start, task state and continuation blocks', () => {
  const target = fixture('3. First\n   - [x] Done\n     - deep\n   - [ ] Pending\n4. Second\n\n   continuation\n\nAfter');
  assert.equal(all(target, 'ol')[0].attributes.start, '3');
  assert.equal(all(target, 'ul').length, 2);
  assert.equal(all(target, 'li').length, 5);
  assert.deepEqual(all(target, 'input').map(node => [node.type, node.checked, node.disabled]), [['checkbox', true, true], ['checkbox', false, true]]);
  assert.match(all(target, 'li').at(-1).textContent, /Secondcontinuation/);
  assert.equal(target.children.at(-1).textContent, 'After');
});

test('markdown: quotes contain Markdown and nested quotes', () => {
  const target = fixture('> ## Quote\n>\n> > **nested**\n> - entry');
  assert.equal(all(target, 'blockquote').length, 2);
  assert.equal(all(target, 'h2')[0].textContent, 'Quote');
  assert.equal(all(target, 'strong')[0].textContent, 'nested');
  assert.equal(all(target, 'li')[0].textContent, 'entry');
});

test('markdown: tables respect alignment, escaped pipes and code pipes', () => {
  const target = fixture('| Name | Value |\n| :--- | ---: |\n| **a** | `b|c` |\n| x\\|y | 2 |');
  assert.equal(all(target, 'table').length, 1);
  assert.equal(all(target, 'th')[1].className, 'md-align-right');
  assert.equal(all(target, 'th')[0].attributes.scope, 'col');
  assert.deepEqual(all(target, 'td').map(node => node.textContent), ['a', 'b|c', 'x|y', '2']);
});

test('markdown: fences preserve tabs and literal markup; copy is explicit and exact', async () => {
  const writes = [];
  const target = fixture('```js onclick=alert(1)\n\t<script>**x**</script>\n```', { writeText: async text => writes.push(text) });
  assert.equal(writes.length, 0);
  assert.equal(all(target, 'script').length, 0);
  assert.equal(all(target, 'strong').length, 0);
  assert.equal(all(target, 'code')[0].textContent, '\t<script>**x**</script>\n');
  const button = all(target, 'button')[0];
  assert.equal(button.type, 'button');
  await button.listeners.click();
  assert.deepEqual(writes, ['\t<script>**x**</script>\n']);
  assert.equal(button.disabled, false);
  assert.match(target.textContent, /Copied/);
});

test('markdown: copy permission failure and missing clipboard are visible, retryable', async () => {
  for (const clipboard of [undefined, { writeText: async () => { throw new Error('denied'); } }]) {
    const target = fixture('~~~\ncode\n~~~', clipboard);
    const button = all(target, 'button')[0]; await button.listeners.click();
    assert.match(target.textContent, /Copy unavailable/); assert.equal(button.disabled, false);
  }
});

test('markdown: links use a strict protocol allowlist and fixed attributes', () => {
  for (const url of ['https://example.com/a_(b)', 'http://localhost:3000/', 'mailto:a@example.com', '/docs', './readme.md', '../a', '#heading', '?q=abc']) assert.equal(safeMarkdownUrl(url), url);
  for (const url of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,test', 'file:///etc/passwd', 'vbscript:x', '//example.com', '\\example.com', 'https://example.com\\x', 'java\nscript:x', 'java\tscript:x', 'https:example.com', 'https://', 'https://a/"onclick="x', 'blob:https://example.com/x', '']) assert.equal(safeMarkdownUrl(url), null, url);
  const target = fixture('[web](https://example.com/a_(b)) [mail](mailto:a@example.com) [relative](./a) [bad](javascript:alert(1)) [data](data:text/html,x) [title](https://example.com "hello")');
  assert.equal(all(target, 'a').length, 4);
  assert.equal(all(target, 'a')[0].attributes.href, 'https://example.com/a_(b)');
  for (const link of all(target, 'a')) assert.deepEqual(Object.keys(link.attributes).sort(), ['href', 'rel', 'target']);
  assert.equal(all(target, 'a')[0].attributes.rel, 'noopener noreferrer');
});

test('markdown: HTML, image syntax and hostile attributes never create active content', () => {
  const target = fixture('<script>alert(1)</script> <img src="https://tracker" onerror="x">\n\n![remote](https://tracker/pixel) ![svg](data:image/svg+xml,evil)\n\n[x](file:///etc/passwd) [x](javascript:alert(1))\n\n```html onmouseover="bad"\n<iframe src=evil>\n```');
  assert.match(target.textContent, /<script>alert\(1\)<\/script>/);
  assert.match(target.textContent, /\[Image: remote\]/);
  for (const node of every(target)) {
    assert.ok(!['img', 'script', 'iframe', 'svg', 'style', 'object'].includes(node.tagName));
    assert.ok(!Object.keys(node.attributes).some(name => /^on|src|style/.test(name)));
  }
  assert.equal(all(target, 'a').length, 0);
});

test('markdown: incomplete streaming input stays safe and rerender replaces old content', () => {
  for (const source of ['**unfinished', '[unfinished](javascript:', '![image](https://tracker', '`unfinished', '<script', '```js\nconst x = 1;', '~~~~\nx\n~~~']) {
    const target = fixture(source);
    assert.equal(all(target, 'a').length, 0);
    assert.ok(target.textContent.length > 0);
  }
  const target = fixture('```js\nconst x = 1;');
  assert.equal(all(target, 'code')[0].textContent, 'const x = 1;');
  renderMarkdown(target, '**complete**');
  assert.equal(all(target, 'button').length, 0);
  assert.equal(all(target, 'strong')[0].textContent, 'complete');
  renderMarkdown(target, null); assert.equal(target.textContent, '');
});

test('markdown: bounded hostile input retains plain-text tail without runaway recursion', { timeout: 3000 }, () => {
  const oversized = 'x'.repeat(210_000);
  assert.equal(fixture(oversized).textContent, oversized);
  const delimiters = '[*~_'.repeat(20_000);
  assert.ok(fixture(delimiters).textContent.length > 0);
  const nested = '> '.repeat(1000) + 'end';
  assert.match(fixture(nested).textContent, /end/);
  const blanks = '- item\n' + '\n'.repeat(80_000) + '- next';
  assert.match(fixture(blanks).textContent, /next/);
  const nodes = fixture('- a\n'.repeat(20_000));
  assert.ok(every(nodes).length < 25_000);
  assert.match(nodes.textContent, /a/);
});
