// Desktop widget host. The host owns the #widget-layer rail, the grid model and the
// #widget-manager dialog. Widgets are definitions registered either by the host (the
// built-in clock) or by the optional sibling modules widget-usage.js / widget-model.js,
// each of which exports install(host) and registers its own definition.
//
// Frozen interface:
//   installWidgets({ root, storage, getState, getSelectedAgent, api, openUsage, document })
//     -> { register(definition), refresh(state), openManager(), dispose() }
//   definition = { type, title, sizes = WIDGET_SIZES, defaultSize = [2,2],
//                  render(root, ctx), update(state, ctx), destroy() }
//   ctx = { api, getState, getSelectedAgent, openUsage, document, widgets, size: { w, h } }
// `size` is the widget's own grid size (updated on every geometry change), so a widget
// can reflow for its current cell.
// `render` and `update` receive the widget's content element as `root`; the host draws
// the frame and the .widget-titlebar. `getSelectedAgent()` returns the agent state the
// rail should follow (last focused real agent window, else main).
//
// Geometry is a grid of WIDGET_COLUMNS = 2 columns: x/w are columns, y/h are rows, and
// pixel positions follow WIDGET_CELL / WIDGET_GAP / WIDGET_ROW. Persisted items that
// overlap are relocated; drag and arrow moves that would overlap are rejected.
export const WIDGET_KEY = 'pi-desktop:widgets:v1';
export const WIDGET_CELL = 126;
export const WIDGET_GAP = 6;
export const WIDGET_ROW = 76;
export const WIDGET_SIZES = [[1, 1], [2, 1], [1, 2], [2, 2], [2, 3]];

const WIDGET_COLUMNS = 2;
const COLUMN_STRIDE = WIDGET_CELL + WIDGET_GAP;
const ROW_STRIDE = WIDGET_ROW + WIDGET_GAP;
const STORED_SIZE = /^(\d+)x(\d+)$/;
// Default rail: clock on top, usage below it, model (disabled) last. Only applied for
// a registered type that has no stored item; a stored item keeps its geometry.
const DEFAULT_PLACEMENT = Object.freeze({
  clock: { enabled: true, x: 0, y: 0, w: 2, h: 1 },
  usage: { enabled: true, x: 0, y: 1, w: 2, h: 3 },
  model: { enabled: false, x: 0, y: 4, w: 2, h: 2 },
});

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
const overlaps = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const sizesOf = (definition) => Array.isArray(definition.sizes) && definition.sizes.length ? definition.sizes : WIDGET_SIZES;
function fallbackSize(definition) {
  const sizes = sizesOf(definition);
  const wanted = Array.isArray(definition.defaultSize) ? definition.defaultSize : [2, 2];
  return sizes.find(([w, h]) => w === wanted[0] && h === wanted[1]) || sizes[0] || [2, 2];
}
function normalizeSize(definition, w, h) {
  return sizesOf(definition).find(([sw, sh]) => sw === w && sh === h) || fallbackSize(definition);
}
function defaultEntry(definition) {
  const preset = DEFAULT_PLACEMENT[definition.type];
  if (preset && sizesOf(definition).some(([w, h]) => w === preset.w && h === preset.h)) {
    return { type: definition.type, enabled: preset.enabled, x: preset.x, y: preset.y, w: preset.w, h: preset.h };
  }
  const [w, h] = fallbackSize(definition);
  return { type: definition.type, enabled: true, x: 0, y: 0, w, h };
}
function storedEntry(definition, raw) {
  const [w, h] = normalizeSize(definition, Number(raw.w), Number(raw.h));
  const rawX = Number(raw.x), rawY = Number(raw.y);
  const x = Number.isFinite(rawX) ? Math.trunc(rawX) : 0;
  const y = Number.isFinite(rawY) ? Math.trunc(rawY) : 0;
  return {
    type: definition.type, enabled: raw.enabled === true, w, h,
    x: clamp(x, 0, Math.max(0, WIDGET_COLUMNS - w)), y: Math.max(0, y),
  };
}
function readStored(storage) {
  try {
    const parsed = JSON.parse(storage?.getItem?.(WIDGET_KEY) || 'null');
    if (parsed && parsed.version === 1 && Array.isArray(parsed.items)) {
      return parsed.items.filter((item) => item && typeof item.type === 'string');
    }
  } catch { /* Storage is optional. */ }
  return [];
}
function clockWidget() {
  let date = null, time = null, timer = null;
  const draw = () => {
    const now = new Date();
    if (date) date.textContent = now.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
    if (time) { time.textContent = now.toLocaleTimeString('en-GB'); time.setAttribute?.('datetime', now.toISOString()); }
  };
  return {
    type: 'clock',
    title: 'Clock Tool 1.1',
    sizes: [[2, 1]],
    defaultSize: [2, 1],
    render(root, context) {
      // A single line fits the 2x1 body (~40px below the titlebar): the time at
      // display size, the date compact beside it.
      const line = context.document.createElement('div'); line.className = 'clock-line';
      time = context.document.createElement('time'); time.id = 'clock';
      date = context.document.createElement('span'); date.id = 'date';
      line.append(time, date);
      root.append(line);
      draw();
      timer = setInterval(draw, 1000);
      timer?.unref?.();
    },
    update() { draw(); },
    destroy() { if (timer) { clearInterval(timer); timer = null; } date = null; time = null; },
  };
}

export function installWidgets({ root, storage, getState, getSelectedAgent, api, openUsage, document: doc = globalThis.document } = {}) {
  if (!root || !doc || typeof doc.createElement !== 'function') throw new Error('installWidgets requires a root element and a document');
  const definitions = new Map();
  const items = [];
  let stored = readStored(storage);
  let disposed = false;

  const layer = doc.createElement('div');
  layer.id = 'widget-layer';
  layer.setAttribute('aria-label', 'Desktop widgets');
  root.append(layer);

  const manager = doc.createElement('dialog');
  manager.id = 'widget-manager';
  manager.setAttribute('aria-label', 'Widget manager');
  const managerTitle = doc.createElement('div');
  managerTitle.className = 'utility-title'; managerTitle.textContent = 'Widgets';
  const managerMode = doc.createElement('span'); managerMode.textContent = 'DESKTOP';
  managerTitle.append(managerMode);
  const managerBody = doc.createElement('div'); managerBody.className = 'help-body';
  const managerHeading = doc.createElement('h2'); managerHeading.textContent = 'Desktop widgets.';
  const managerNote = doc.createElement('p');
  managerNote.textContent = 'Enable or resize each widget, or reset the rail to its defaults. Changes are saved immediately.';
  const managerList = doc.createElement('div'); managerList.className = 'widget-manager-list';
  const managerForm = doc.createElement('form'); managerForm.setAttribute('method', 'dialog');
  const resetButton = doc.createElement('button');
  resetButton.type = 'button'; resetButton.className = 'widgets-reset';
  resetButton.dataset.testid = 'widgets-reset'; resetButton.textContent = 'Reset widgets';
  const doneButton = doc.createElement('button'); doneButton.className = 'primary'; doneButton.textContent = 'Done';
  managerForm.append(resetButton, doneButton);
  managerBody.append(managerHeading, managerNote, managerList, managerForm);
  manager.append(managerTitle, managerBody);
  root.append(manager);

  // Base context shared by every widget; each entry layers its own `widgets` host
  // reference and its live `size` on top so a widget can key off its own geometry.
  const baseCtx = { api, getState, getSelectedAgent, openUsage, document: doc };
  const host = { register, refresh, openManager, dispose };
  let lastState = null;

  function blocked(rect, item) {
    return items.some((other) => other !== item && other.enabled && overlaps(rect, other));
  }
  function freeSlot(item, w, h) {
    for (let y = 0; y < 100; y++) {
      for (let x = 0; x <= WIDGET_COLUMNS - w; x++) {
        if (!blocked({ x, y, w, h }, item)) return { x, y };
      }
    }
    return null;
  }
  /** Keep an enabled widget where it is, or move it to the first free slot. */
  function place(entry) {
    if (!entry.enabled || !blocked({ x: entry.x, y: entry.y, w: entry.w, h: entry.h }, entry)) return entry;
    const slot = freeSlot(entry, entry.w, entry.h);
    if (slot) { entry.x = slot.x; entry.y = slot.y; }
    return entry;
  }
  function applyGeometry(entry) {
    const width = entry.w * WIDGET_CELL + (entry.w - 1) * WIDGET_GAP;
    const height = entry.h * WIDGET_ROW + (entry.h - 1) * WIDGET_GAP;
    entry.element.style.left = `${entry.x * COLUMN_STRIDE}px`;
    entry.element.style.top = `${entry.y * ROW_STRIDE}px`;
    entry.element.style.width = `${width}px`;
    entry.element.style.height = `${height}px`;
    entry.element.hidden = !entry.enabled;
    if (entry.ctx) { entry.ctx.size.w = entry.w; entry.ctx.size.h = entry.h; }
  }
  /** Re-run a widget's update with the latest state so it can react to a geometry change. */
  function notify(entry) {
    definitions.get(entry.type)?.update?.(lastState, entry.ctx);
  }
  function persist() {
    const payload = { version: 1, items: items.map(({ type, enabled, x, y, w, h }) => ({ type, enabled, x, y, w, h })) };
    for (const raw of stored) if (!definitions.has(raw.type)) payload.items.push(raw);
    stored = payload.items;
    try { storage?.setItem?.(WIDGET_KEY, JSON.stringify(payload)); } catch { /* Storage is optional. */ }
  }
  function isCompact() {
    const view = doc.defaultView;
    if (!view) return false;
    if (typeof view.matchMedia === 'function') return view.matchMedia('(max-width:760px)').matches === true;
    return typeof view.innerWidth === 'number' && view.innerWidth <= 760;
  }
  function moveStrict(entry, x, y) {
    const candidate = { x, y, w: entry.w, h: entry.h };
    if (candidate.x === entry.x && candidate.y === entry.y) return false;
    if (blocked(candidate, entry)) return false;
    entry.x = candidate.x; entry.y = candidate.y;
    applyGeometry(entry);
    return true;
  }
  /** Drag move: a free cell, or push the overlapped widgets into the next free cells. */
  function movePushing(entry, x, y) {
    const candidate = { x, y, w: entry.w, h: entry.h };
    if (candidate.x === entry.x && candidate.y === entry.y) return false;
    const hits = items.filter((other) => other !== entry && other.enabled && overlaps(candidate, other));
    if (!hits.length) { entry.x = candidate.x; entry.y = candidate.y; applyGeometry(entry); return true; }
    const before = { x: entry.x, y: entry.y };
    const originals = hits.map((other) => ({ other, x: other.x, y: other.y }));
    entry.x = candidate.x; entry.y = candidate.y;
    let ok = true;
    for (const other of hits.sort((a, b) => a.y - b.y)) {
      const slot = freeSlot(other, other.w, other.h);
      if (!slot) { ok = false; break; }
      other.x = slot.x; other.y = slot.y;
    }
    if (!ok) {
      entry.x = before.x; entry.y = before.y;
      for (const { other, x: ox, y: oy } of originals) { other.x = ox; other.y = oy; }
      return false;
    }
    applyGeometry(entry);
    for (const { other } of originals) applyGeometry(other);
    return true;
  }
  function startDrag(entry, event) {
    if (disposed || isCompact() || entry.element.hidden) return;
    if (typeof event.button === 'number' && event.button > 0) return;
    event.preventDefault?.();
    const startX = Number(event.clientX) || 0, startY = Number(event.clientY) || 0;
    const origin = { x: entry.x, y: entry.y };
    const snapshot = items.map((item) => ({ item, x: item.x, y: item.y }));
    let moved = false;
    const onMove = (moveEvent) => {
      const dx = (Number(moveEvent.clientX) || 0) - startX;
      const dy = (Number(moveEvent.clientY) || 0) - startY;
      const x = clamp(origin.x + Math.round(dx / COLUMN_STRIDE), 0, Math.max(0, WIDGET_COLUMNS - entry.w));
      const y = Math.max(0, origin.y + Math.round(dy / ROW_STRIDE));
      if ((x !== entry.x || y !== entry.y) && movePushing(entry, x, y)) moved = true;
    };
    const cleanup = () => {
      doc.removeEventListener?.('pointermove', onMove);
      doc.removeEventListener?.('pointerup', onRelease);
      doc.removeEventListener?.('pointercancel', onRelease);
      doc.removeEventListener?.('keydown', onKey);
    };
    const onRelease = () => { cleanup(); if (moved) persist(); };
    const onKey = (keyEvent) => {
      if (keyEvent.key !== 'Escape') return;
      keyEvent.preventDefault?.();
      cleanup();
      for (const snap of snapshot) { snap.item.x = snap.x; snap.item.y = snap.y; }
      for (const snap of snapshot) applyGeometry(snap.item);
    };
    doc.addEventListener?.('pointermove', onMove);
    doc.addEventListener?.('pointerup', onRelease);
    doc.addEventListener?.('pointercancel', onRelease);
    doc.addEventListener?.('keydown', onKey);
    if (event.pointerId != null && typeof entry.titlebar.setPointerCapture === 'function') {
      try { entry.titlebar.setPointerCapture(event.pointerId); } catch { /* Capture is best-effort. */ }
    }
  }
  function arrowMove(entry, event) {
    const deltas = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    const delta = deltas[event.key];
    if (!delta || entry.element.hidden) return;
    event.preventDefault?.();
    const x = clamp(entry.x + delta[0], 0, Math.max(0, WIDGET_COLUMNS - entry.w));
    const y = Math.max(0, entry.y + delta[1]);
    if (moveStrict(entry, x, y)) persist();
  }
  function buildWidget(entry) {
    const definition = definitions.get(entry.type);
    const widget = doc.createElement('div');
    widget.className = `widget widget-${entry.type}`;
    widget.dataset.type = entry.type;
    widget.dataset.testid = `widget-${entry.type}`;
    const titlebar = doc.createElement('div');
    titlebar.className = 'widget-titlebar'; titlebar.tabIndex = 0;
    titlebar.setAttribute('role', 'group');
    titlebar.setAttribute('aria-label', `${definition.title} widget. Drag or use the arrow keys to move it.`);
    const title = doc.createElement('span'); title.className = 'widget-title'; title.textContent = definition.title;
    const grip = doc.createElement('span'); grip.className = 'widget-grip'; grip.setAttribute('aria-hidden', 'true'); grip.textContent = '⠿';
    titlebar.append(title, grip);
    const body = doc.createElement('div'); body.className = 'widget-body';
    widget.append(titlebar, body);
    layer.append(widget);
    entry.element = widget; entry.titlebar = titlebar; entry.body = body;
    entry.ctx = { ...baseCtx, widgets: host, size: { w: entry.w, h: entry.h } };
    definition.render(body, entry.ctx);
    titlebar.addEventListener('pointerdown', (event) => startDrag(entry, event));
    titlebar.addEventListener('keydown', (event) => arrowMove(entry, event));
    applyGeometry(entry);
  }
  function setEnabled(entry, enabled) {
    if (enabled) { entry.enabled = true; place(entry); }
    else entry.enabled = false;
    applyGeometry(entry);
    persist();
    notify(entry);
  }
  function setSize(entry, value) {
    const match = STORED_SIZE.exec(String(value));
    const definition = definitions.get(entry.type);
    if (!match || !definition) return;
    const w = Number(match[1]), h = Number(match[2]);
    if (!sizesOf(definition).some(([sw, sh]) => sw === w && sh === h)) return;
    const candidate = { x: clamp(entry.x, 0, Math.max(0, WIDGET_COLUMNS - w)), y: entry.y, w, h };
    if (entry.enabled && blocked(candidate, entry)) {
      const slot = freeSlot(entry, w, h);
      if (!slot) return;
      candidate.x = slot.x; candidate.y = slot.y;
    }
    entry.w = w; entry.h = h; entry.x = candidate.x; entry.y = candidate.y;
    applyGeometry(entry);
    persist();
    notify(entry);
  }
  function managerRow(entry) {
    const definition = definitions.get(entry.type);
    const row = doc.createElement('div');
    row.className = 'widget-manager-row'; row.dataset.testid = `widget-row-${entry.type}`;
    const label = doc.createElement('label');
    const enable = doc.createElement('input');
    enable.type = 'checkbox'; enable.checked = entry.enabled;
    enable.dataset.testid = `widget-enable-${entry.type}`;
    enable.setAttribute('aria-label', `Enable ${definition.title}`);
    enable.addEventListener('change', () => setEnabled(entry, enable.checked));
    const caption = doc.createElement('span'); caption.textContent = definition.title;
    label.append(enable, caption);
    const select = doc.createElement('select');
    select.dataset.testid = `widget-size-${entry.type}`;
    select.setAttribute('aria-label', `${definition.title} size`);
    for (const [w, h] of sizesOf(definition)) {
      const option = doc.createElement('option');
      option.value = `${w}x${h}`; option.textContent = `${w}×${h}`;
      select.append(option);
    }
    select.value = `${entry.w}x${entry.h}`;
    select.addEventListener('change', () => setSize(entry, select.value));
    row.append(label, select);
    return row;
  }
  function renderManager() {
    managerList.replaceChildren(...items.map(managerRow));
  }
  function resetAll() {
    for (const entry of items) {
      const definition = definitions.get(entry.type);
      const reset = DEFAULT_PLACEMENT[entry.type]
        ? { type: entry.type, ...DEFAULT_PLACEMENT[entry.type] }
        : defaultEntry(definition);
      entry.enabled = reset.enabled; entry.x = reset.x; entry.y = reset.y; entry.w = reset.w; entry.h = reset.h;
    }
    for (const entry of items) { if (entry.enabled) place(entry); applyGeometry(entry); }
    renderManager();
    persist();
    for (const entry of items) notify(entry);
  }
  resetButton.addEventListener('click', resetAll);

  function register(definition) {
    if (disposed) return host;
    if (!definition || typeof definition.type !== 'string' || typeof definition.render !== 'function') {
      throw new Error('A widget definition needs a type and a render(root, ctx) function');
    }
    if (definitions.has(definition.type)) return host;
    const normalized = {
      type: definition.type,
      title: definition.title || definition.type,
      sizes: sizesOf(definition),
      defaultSize: fallbackSize(definition),
      render: definition.render,
      update: typeof definition.update === 'function' ? definition.update : null,
      destroy: typeof definition.destroy === 'function' ? definition.destroy : null,
    };
    definitions.set(normalized.type, normalized);
    const raw = stored.find((item) => item.type === normalized.type);
    const entry = raw ? storedEntry(normalized, raw) : defaultEntry(normalized);
    place(entry);
    items.push(entry);
    buildWidget(entry);
    renderManager();
    return host;
  }
  function refresh(state) {
    if (disposed) return host;
    lastState = state;
    for (const entry of items) definitions.get(entry.type)?.update?.(state, entry.ctx);
    return host;
  }
  function openManager() {
    if (disposed) return manager;
    renderManager();
    if (typeof manager.showModal === 'function') { if (!manager.open) manager.showModal(); }
    else { manager.open = true; manager.hidden = false; }
    return manager;
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    for (const entry of items) definitions.get(entry.type)?.destroy?.();
    for (const entry of items) entry.element?.remove?.();
    items.length = 0;
    definitions.clear();
    manager.close?.();
    manager.remove?.();
    layer.remove?.();
    widgetButton?.removeEventListener?.('click', openManager);
  }

  const widgetButton = typeof doc.getElementById === 'function' ? doc.getElementById('widgets') : null;
  widgetButton?.addEventListener?.('click', openManager);

  register(clockWidget());
  // Optional sibling widgets register themselves. Their absence must not break the host,
  // so each import is independent and failures are swallowed until integration lands.
  for (const specifier of ['./widget-usage.js', './widget-model.js']) {
    import(specifier).then((module) => module.install?.(host)).catch(() => { /* Optional widget module is absent. */ });
  }
  return host;
}
