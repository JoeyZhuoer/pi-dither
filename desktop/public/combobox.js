// Native controls remain authoritative; no document globals are touched at import time.
const controls = new WeakMap(), installations = new WeakMap();
let sequence = 0;
export function syncCombobox(select) { controls.get(select)?.sync(); }

export function installComboboxes(root = globalThis.document) {
  const doc = root?.nodeType === 9 ? root : root?.ownerDocument;
  const win = doc?.defaultView;
  if (!win?.MutationObserver || !doc.body || !root?.querySelectorAll) return { refresh() {}, destroy() {} };
  if (installations.has(doc)) return installations.get(doc);
  const entries = new Map(), removers = [];
  let opened = null, destroyed = false;
  const on = (target, type, fn, options) => {
    target.addEventListener(type, fn, options);
    const remove = () => target.removeEventListener(type, fn, options);
    removers.push(remove); return remove;
  };
  const close = () => opened?.close();
  function enhance(select) {
    if (entries.has(select) || select.multiple || select.size > 1) return;
    const trigger = doc.createElement('button'), text = doc.createElement('span');
    const list = doc.createElement('div'), id = `pi-combobox-${++sequence}`;
    trigger.type = 'button'; trigger.tabIndex = select.tabIndex; trigger.className = `pi-combobox ${select.className}`;
    text.className = 'pi-combobox-text'; trigger.append(text);
    trigger.setAttribute('role', 'combobox'); trigger.setAttribute('aria-haspopup', 'listbox');
    trigger.setAttribute('aria-expanded', 'false'); trigger.setAttribute('aria-controls', id);
    list.id = id; list.className = 'pi-combobox-list'; list.setAttribute('role', 'listbox'); list.hidden = true;
    const original = { tabindex: select.getAttribute('tabindex'), ariaHidden: select.getAttribute('aria-hidden') };
    const local = [], descriptors = new Map();
    let active = -1, signature = '', rows = [], search = '', searchAt = 0;
    const listen = (el, type, fn, options) => { el.addEventListener(type, fn, options); local.push(() => el.removeEventListener(type, fn, options)); };
    const options = () => Array.from(select.options);
    const disabled = () => select.matches(':disabled');
    const enabled = (index) => { const option = select.options[index]; return option && !option.disabled && !option.hidden && !option.parentElement?.disabled; };
    function mark(index) {
      active = index;
      rows.forEach((row, i) => { row.dataset.active = String(i === active); });
      if (active >= 0 && rows[active]) {
        trigger.setAttribute('aria-activedescendant', rows[active].id);
        if (!list.hidden) rows[active].scrollIntoView({ block: 'nearest' });
      } else trigger.removeAttribute('aria-activedescendant');
    }
    function position() {
      if (list.hidden) return;
      const r = trigger.getBoundingClientRect(), viewport = win.visualViewport;
      const left = viewport?.offsetLeft || 0, top = viewport?.offsetTop || 0;
      const width = viewport?.width || win.innerWidth, height = viewport?.height || win.innerHeight;
      if (!trigger.getClientRects().length || r.bottom < top || r.top > top + height) { entry.close(); return; }
      const w = Math.min(Math.max(r.width, 240), Math.max(0, width - 16));
      const below = Math.max(0, top + height - r.bottom - 8), above = Math.max(0, r.top - top - 8);
      const upwards = below < Math.min(280, list.scrollHeight) && above > below;
      const h = Math.min(320, upwards ? above : below);
      Object.assign(list.style, { width: `${w}px`, maxHeight: `${h}px`, left: `${Math.max(left + 8, Math.min(r.left, left + width - w - 8))}px`, top: `${upwards ? Math.max(top + 8, r.top - Math.min(h, list.scrollHeight) - 2) : Math.max(top + 8, r.bottom + 2)}px` });
    }
    function sync() {
      if (select.multiple || select.size > 1) { entry.destroy(); return; }
      const opts = options();
      const name = select.getAttribute('aria-label') || Array.from(select.labels || []).map(label => Array.from(label.childNodes).filter(n => n !== select && n !== trigger).map(n => n.textContent).join(' ').trim()).join(' ') || select.title || select.name || 'Choose an option';
      const labelledby = select.getAttribute('aria-labelledby');
      for (const el of [trigger, list]) {
        el.setAttribute('aria-label', name);
        if (labelledby) el.setAttribute('aria-labelledby', labelledby); else el.removeAttribute('aria-labelledby');
      }
      for (const attr of ['aria-describedby', 'aria-required', 'aria-invalid']) {
        const value = select.getAttribute(attr); if (value != null) trigger.setAttribute(attr, value); else trigger.removeAttribute(attr);
      }
      if (select.required) trigger.setAttribute('aria-required', 'true');
      trigger.disabled = disabled() || !opts.some((_, i) => enabled(i));
      trigger.hidden = select.hidden;
      const caption = opts[select.selectedIndex]?.label || 'No options';
      if (text.textContent !== caption) text.textContent = caption;
      trigger.title = caption;
      const next = JSON.stringify(opts.map((o, i) => [o.label, o.value, enabled(i), o.hidden]));
      if (signature !== next) {
        signature = next;
        rows = opts.map((option, i) => {
          const row = doc.createElement('div'); row.id = `${id}-${i}`; row.className = 'pi-combobox-option';
          row.setAttribute('role', 'option'); row.setAttribute('aria-disabled', String(!enabled(i)));
          row.textContent = option.label; row.hidden = option.hidden; row.dataset.index = String(i); return row;
        });
        list.replaceChildren(...rows); active = select.selectedIndex;
      }
      rows.forEach((row, i) => row.setAttribute('aria-selected', String(i === select.selectedIndex)));
      if (trigger.disabled || trigger.hidden) entry.close();
      if (!list.hidden) { if (!enabled(active)) active = opts.findIndex((_, i) => enabled(i)); mark(active); position(); }
    }
    function open() {
      sync(); if (trigger.disabled || trigger.hidden) return;
      close(); opened = entry; list.hidden = false; trigger.setAttribute('aria-expanded', 'true');
      position(); mark(enabled(select.selectedIndex) ? select.selectedIndex : options().findIndex((_, i) => enabled(i)));
    }
    function commit() {
      if (disabled() || !enabled(active)) return;
      const changed = select.selectedIndex !== active;
      select.selectedIndex = active; entry.close(); sync();
      if (changed) {
        select.dispatchEvent(new win.Event('input', { bubbles: true }));
        select.dispatchEvent(new win.Event('change', { bubbles: true }));
      }
    }
    const entry = {
      sync, position, trigger, list,
      repair() {
        // Reconstruction may keep the select but discard/misplace its generated UI.
        if (select.nextElementSibling !== trigger) select.after(trigger);
        if (list.parentNode !== doc.body) doc.body.append(list);
      },
      close() { list.hidden = true; trigger.setAttribute('aria-expanded', 'false'); trigger.removeAttribute('aria-activedescendant'); search = ''; if (opened === entry) opened = null; },
      destroy() {
        entry.close(); observer.disconnect(); local.forEach(remove => remove());
        for (const [key, descriptor] of descriptors) { if (descriptor) Object.defineProperty(select, key, descriptor); else delete select[key]; }
        select.classList.remove('pi-combobox-native');
        for (const [attr, value] of [['tabindex', original.tabindex], ['aria-hidden', original.ariaHidden]]) { if (value === null) select.removeAttribute(attr); else select.setAttribute(attr, value); }
        trigger.remove(); list.remove(); entries.delete(select); controls.delete(select);
      },
    };
    const observer = new win.MutationObserver(sync);
    try {
      select.after(trigger); doc.body.append(list);
      sync();
      observer.observe(select, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['disabled', 'selected', 'label', 'value', 'hidden', 'multiple', 'size', 'aria-label', 'aria-labelledby', 'aria-describedby', 'aria-invalid', 'required'] });
      // Property assignments do not produce mutation records. Preserve native setters.
      for (const key of ['value', 'selectedIndex']) {
        const descriptor = Object.getOwnPropertyDescriptor(win.HTMLSelectElement.prototype, key);
        const own = Object.getOwnPropertyDescriptor(select, key);
        if (descriptor?.set && !own) {
          descriptors.set(key, own);
          Object.defineProperty(select, key, { configurable: true, get() { return descriptor.get.call(this); }, set(value) { descriptor.set.call(this, value); sync(); } });
        }
      }
      listen(select, 'change', sync);
      // Explicit <label for> activation must not launch the OS select popup.
      listen(select, 'click', event => { event.preventDefault(); if (!disabled()) { trigger.focus({ preventScroll: true }); open(); } });
      listen(select, 'focus', () => trigger.focus());
      listen(select, 'invalid', () => trigger.focus());
      listen(trigger, 'focus', sync);
      listen(trigger, 'click', () => { if (list.hidden) open(); else entry.close(); });
      listen(trigger, 'keydown', event => {
        if (disabled() || event.ctrlKey || event.metaKey) return;
        const key = event.key;
        if (key === 'Tab') { entry.close(); return; }
        if (key === 'Escape') { if (!list.hidden) { event.preventDefault(); event.stopPropagation(); entry.close(); } return; }
        if (['Enter', ' '].includes(key)) { event.preventDefault(); if (list.hidden) open(); else commit(); return; }
        if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(key)) {
          event.preventDefault(); if (list.hidden) open();
          const indices = options().map((_, i) => i).filter(enabled), at = indices.indexOf(active);
          mark(key === 'Home' ? indices[0] : key === 'End' ? indices.at(-1) : indices[Math.max(0, Math.min(indices.length - 1, at + (key === 'ArrowDown' ? 1 : -1)))] ?? -1); return;
        }
        if (key.length === 1 && !event.altKey) {
          event.preventDefault(); if (list.hidden) open();
          const now = Date.now(); search = now - searchAt > 700 ? key : search + key; searchAt = now;
          const query = Array.from(search).every(c => c === search[0]) ? search[0] : search;
          const opts = options();
          for (let step = 1; step <= opts.length; step++) { const i = (active + step) % opts.length; if (enabled(i) && opts[i].label.toLocaleLowerCase().startsWith(query.toLocaleLowerCase())) { mark(i); break; } }
        }
      });
      listen(list, 'pointerdown', event => { if (event.pointerType === 'mouse') event.preventDefault(); });
      listen(list, 'click', event => {
        const row = event.target.closest('[data-index]'); if (!row || !list.contains(row)) return;
        const i = Number(row.dataset.index); if (!enabled(i)) return;
        mark(i); commit(); trigger.focus({ preventScroll: true });
      });
      select.classList.add('pi-combobox-native'); select.tabIndex = -1; select.setAttribute('aria-hidden', 'true');
      entries.set(select, entry); controls.set(select, entry);
    } catch { entry.destroy(); /* A failed enhancement leaves a usable native select. */ }
  }
  function scan(node) {
    if (node.nodeType !== 1 && node.nodeType !== 9) return;
    if (node.matches?.('select')) enhance(node);
    node.querySelectorAll('select').forEach(enhance);
  }
  const observer = new win.MutationObserver(records => {
    for (const record of records) {
      if (record.type === 'attributes') {
        if (record.target.tagName === 'FIELDSET') for (const [select, entry] of entries) if (record.target.contains(select)) entry.sync();
        if (opened && record.target.contains(opened.trigger)) opened.position();
        continue;
      }
      // Scan only inserted subtrees, never rescan the document for transcript text updates.
      for (const node of record.addedNodes) scan(node);
    }
    for (const [select, entry] of entries) { if (!root.contains(select)) entry.destroy(); else entry.repair(); }
  });
  const api = {
    refresh() { if (destroyed) return; scan(root); for (const [select, entry] of entries) { if (!root.contains(select)) entry.destroy(); else { entry.repair(); entry.sync(); } } },
    destroy() { if (destroyed) return; destroyed = true; observer.disconnect(); for (const entry of entries.values()) entry.destroy(); removers.forEach(remove => remove()); installations.delete(doc); },
  };
  installations.set(doc, api); api.refresh();
  observer.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ['hidden', 'disabled', 'style', 'class'] });
  on(doc, 'pointerdown', event => { if (opened && !opened.trigger.contains(event.target) && !opened.list.contains(event.target)) close(); }, true);
  on(doc, 'focusin', event => { if (opened && !opened.trigger.contains(event.target) && !opened.list.contains(event.target)) close(); });
  on(doc, 'reset', () => win.queueMicrotask(() => api.refresh()));
  on(doc, 'scroll', event => { if (opened && !opened.list.contains(event.target)) close(); }, true);
  on(win, 'resize', close); on(win, 'blur', close);
  on(win.visualViewport || win, 'resize', close);
  on(win, 'pagehide', event => { if (event.persisted) close(); else api.destroy(); });
  return api;
}
