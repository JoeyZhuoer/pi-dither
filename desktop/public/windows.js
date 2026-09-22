const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const storageKey = 'pi-desktop:layout:v1';
const rectKeys = ['x', 'y', 'w', 'h'];
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const validRect = (value) => isObject(value) && rectKeys.every((key) => Number.isFinite(value[key])) && value.w > 0 && value.h > 0;

// Compact sizes by purpose; unknown utility IDs retain a roomy generic
// fallback. Manual children alone retain the main-relative cap. Opening
// geometry is separate: the minimum usable width with a medium height (see
// workingRect), and the compact presets are the Arrange/anchor layout.
const profiles = {
  models: [700, 540],
  providers: [620, 500],
  workspace: [800, 600],
  git: [760, 560],
  usage: [560, 420],
  sessions: [680, 520],
  activity: [740, 540],
  tools: [600, 480],
  background: [620, 520],
};
const profileFor = (kind, id) => kind === 'delegated' ? [560, 430]
  : kind === 'utility' ? (Object.hasOwn(profiles, id) ? profiles[id] : [820, 660]) : null;
// Minimum usable width/height per kind, shared by opening geometry and
// viewport clamping so they cannot drift apart.
const minimum = (kind) => kind === 'main' ? { w: 610, h: 440 }
  : kind === 'subagent' ? { w: 270, h: 250 } : { w: 400, h: 320 };
// Opening height as a fraction of the desktop; medium, not the full canvas.
const MEDIUM_HEIGHT = .6;

function readLayout() {
  const saved = Object.create(null);
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw || raw.length > 100000) return saved;
    const parsed = JSON.parse(raw);
    if (!isObject(parsed)) return saved;
    for (const [id, value] of Object.entries(parsed).slice(0, 256)) {
      if (!isObject(value)) continue;
      const entry = {};
      if (validRect(value)) for (const key of rectKeys) entry[key] = value[key];
      if (typeof value.hidden === 'boolean') entry.hidden = value.hidden;
      if (typeof value.zoomed === 'boolean') entry.zoomed = value.zoomed;
      if (['compact', 'auto', 'manual'].includes(value.sizeMode)) entry.sizeMode = value.sizeMode;
      if (Number.isSafeInteger(value.observerIndex) && value.observerIndex >= 0 && value.observerIndex < 32) entry.observerIndex = value.observerIndex;
      if (validRect(value.restore)) {
        entry.restore = Object.fromEntries(rectKeys.map((key) => [key, value.restore[key]]));
        if (['compact', 'auto', 'manual'].includes(value.restoreMode)) entry.restoreMode = value.restoreMode;
      }
      if (Object.keys(entry).length) saved[id] = entry;
    }
  } catch { /* Corrupt data and denied storage must not prevent startup. */ }
  return saved;
}

// Display slots are independent of UUID identity and layout z-order.
export function nextSubagentIndex(indices) {
  const used = new Set([...indices].filter((value) => Number.isSafeInteger(value) && value > 0));
  let index = 1;
  while (used.has(index)) index++;
  return index;
}

export function subagentIndexFromName(name) {
  const value = Number(String(name || '').match(/\/\s*(\d+)\s*$/)?.[1]);
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

export class DesktopWindows {
  constructor(desktop, tasks) {
    this.desktop = desktop; this.tasks = tasks; this.windows = new Map(); this.z = 10;
    this.saved = readLayout(); this.listeners = new Set(); this.focused = null;
    this.resize = () => {
      const size = `${desktop.clientWidth}:${desktop.clientHeight}`;
      if (size === this.lastSize || !desktop.clientWidth || !desktop.clientHeight) return;
      this.lastSize = size;
      for (const win of this.windows.values()) this.reflow(win);
      this.save();
    };
    window.addEventListener('resize', this.resize);
    // WKWebView/container layout can change independently of a window resize.
    if (typeof ResizeObserver === 'function') {
      this.resizeObserver = new ResizeObserver(this.resize); this.resizeObserver.observe(desktop);
    }
  }
  destroy() {
    window.removeEventListener('resize', this.resize); this.resizeObserver?.disconnect();
    for (const win of this.windows.values()) win.cancelPointer?.();
    this.listeners.clear();
  }
  legacyDefaultRect(kind, index = 0) {
    // Mobile uses stacked CSS, but must not replace a remembered desktop layout.
    const mobile = matchMedia('(max-width:760px)').matches;
    const w = mobile ? Math.max(1200, this.desktop.clientWidth) : this.desktop.clientWidth;
    const h = mobile ? Math.max(800, this.desktop.clientHeight) : this.desktop.clientHeight;
    if (kind === 'main') return { x: Math.max(15, w * .055), y: 34, w: Math.min(1000, w * .66), h: Math.min(780, h - 74) };
    if (kind === 'utility') return { x: 70 + (index % 4) * 28, y: 45 + (index % 4) * 28, w: Math.min(820, w * .7), h: Math.min(660, h - 70) };
    return { x: w - 350 - (index % 2) * 35, y: 105 + (index % 3) * 240, w: 325, h: 310 };
  }
  defaultRect(kind, index = 0, id) {
    const profile = profileFor(kind, id);
    const rect = this.legacyDefaultRect(kind === 'delegated' ? 'subagent' : kind, index);
    if (!profile) return rect;
    const mobile = matchMedia('(max-width:760px)').matches;
    const w = mobile ? Math.max(1200, this.desktop.clientWidth) : this.desktop.clientWidth;
    const h = mobile ? Math.max(800, this.desktop.clientHeight) : this.desktop.clientHeight;
    const width = Math.min(profile[0], w * .7), height = Math.min(profile[1], h - 70);
    // Use the former Scout/Review right-side anchors, retaining the observer's
    // larger preset. Align right edges so a wider view stays inside the desktop.
    return { ...rect, ...(kind === 'delegated' ? { x: Math.max(0, rect.x + rect.w - width) } : {}), w: width, h: height };
  }
  add({ id, title, kind = 'subagent', onClose, index = 0, hidden = false }) {
    if (this.windows.has(id)) return this.windows.get(id);
    const element = document.createElement('section');
    element.className = `app-window ${kind === 'main' ? 'main-window' : kind === 'utility' ? 'utility-window' : 'sub-window'}`;
    element.setAttribute('aria-label', title); element.dataset.windowId = id;
    element.innerHTML = '<div class="titlebar" tabindex="0"><span class="window-title"></span><div class="titlebar-controls"></div></div><div class="window-body"></div><button class="resize-handle" aria-label="Resize window"></button>';
    const titlebar = element.querySelector('.titlebar');
    const task = document.createElement('button');
    const saved = this.saved[id];
    const minimized = typeof saved?.hidden === 'boolean' ? saved.hidden : Boolean(hidden);
    const defaults = this.defaultRect(kind, index, id);
    const previousObserver = { ...this.legacyDefaultRect('utility', index), w: defaults.w, h: defaults.h };
    const migrateObserver = kind === 'delegated' && saved?.zoomed === false && validRect(saved)
      && rectKeys.every((key) => Math.abs(saved[key] - previousObserver[key]) < .01);
    const layoutRect = validRect(saved) && !migrateObserver ? Object.fromEntries(rectKeys.map((key) => [key, saved[key]])) : defaults;
    // Preserve legacy custom layouts; old untouched defaults can gain auto-zoom.
    const legacyDefaults = this.legacyDefaultRect(kind, index);
    const legacyCustom = validRect(saved) && ![defaults, legacyDefaults].some(rect =>
      rectKeys.every((key) => Math.abs(saved[key] - rect[key]) < .01));
    const win = { id, title, kind, element, task, titlebar, body: element.querySelector('.window-body'), index,
      rect: { ...layoutRect }, layoutRect, minimized,
      // Legacy zoomed=true cannot distinguish automatic from manual sizing.
      // Preserve it conservatively until Arrange or an explicit layout reset.
      sizeMode: saved?.sizeMode ?? ((saved?.zoomed ?? legacyCustom) ? 'manual' : 'compact'),
      zoomed: saved?.sizeMode ? saved.sizeMode !== 'compact' : typeof saved?.zoomed === 'boolean' ? saved.zoomed : legacyCustom,
      restore: validRect(saved?.restore) ? { ...saved.restore } : null, restoreMode: saved?.restoreMode ?? 'manual' };
    element.hidden = minimized;
    this.windows.set(id, win); this.desktop.append(element); this.tasks.append(task);
    this.setTitle(win, title);
    const controls = element.querySelector('.titlebar-controls');
    const control = (symbol, label, action) => {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'icon'; button.textContent = symbol;
      button.setAttribute('aria-label', label); button.title = label; button.addEventListener('click', action); controls.append(button);
    };
    control('_', 'Minimize window', () => this.hide(id));
    if (kind === 'main') control('□', 'Maximize or restore main window', () => {
      if (win.restore) {
        const mode = win.restoreMode;
        this.place(win, win.restore); win.restore = null; win.sizeMode = mode; win.zoomed = mode !== 'compact'; this.reflow(win);
      } else {
        win.restore = win.sizeMode === 'auto' ? this.workingRect(win) : { ...win.layoutRect }; win.restoreMode = win.sizeMode;
        this.place(win, { x: 4, y: 4, w: this.desktop.clientWidth - 10, h: this.desktop.clientHeight - 10 });
      }
      this.focus(win, true, false); this.save();
    });
    else if (kind === 'utility') control('×', 'Close utility window', () => this.hide(id));
    else control('×', 'Close subagent window', () => onClose?.(win));
    task.type = 'button'; task.addEventListener('click', () => this.show(id));
    element.addEventListener('pointerdown', () => this.focus(win, true, false));
    element.addEventListener('focusin', (event) => {
      if (element.hidden) return;
      if (!event.target.closest('.titlebar-controls')) win.lastFocus = event.target;
      this.focus(win, true, event.target === titlebar && !this.restoringFocus);
    });
    this.pointer(win, titlebar, false);
    this.pointer(win, element.querySelector('.resize-handle'), true);
    titlebar.addEventListener('keydown', (event) => {
      if (event.target !== titlebar) return;
      this.keyboard(win, event, event.shiftKey);
    });
    element.querySelector('.resize-handle').addEventListener('keydown', (event) => this.keyboard(win, event, true));
    this.reflow(win);
    if (!element.hidden) { this.zoomToFit(win); this.focus(win, false, false); }
    this.save(); this.changed(); return win;
  }
  setTitle(win, title) {
    win.title = String(title);
    win.element.setAttribute('aria-label', win.title);
    win.titlebar.setAttribute('aria-label', `${win.title}: drag or use arrow keys to move; Shift plus arrows to resize`);
    win.element.querySelector('.window-title').textContent = win.title;
    win.task.textContent = win.title; win.task.title = `Show ${win.title}`;
  }
  rename(id, title) {
    const win = this.windows.get(id); if (!win || win.title === String(title)) return;
    this.setTitle(win, title); this.changed();
  }
  list() {
    return [...this.windows.values()].map((win) => ({ id: win.id, title: win.title, kind: win.kind,
      hidden: win.element.hidden, focused: !win.element.hidden && this.focused === win }));
  }
  // Notifications carry a fresh list; subscribing does not immediately invoke the callback.
  onChange(callback) { this.listeners.add(callback); return () => this.listeners.delete(callback); }
  changed() {
    for (const callback of [...this.listeners]) {
      try { callback(this.list()); } catch (error) { console.error('Window change listener failed', error); }
    }
  }
  show(id) {
    const win = this.windows.get(id); if (!win) return;
    win.element.hidden = false; win.minimized = false;
    this.reflow(win); this.focus(win, false); this.restoreFocus(win);
    this.save(); this.changed(); return win;
  }
  hide(id) {
    const win = this.windows.get(id); if (!win || win.element.hidden) return;
    const hadFocus = win.element.contains(document.activeElement);
    if (hadFocus && !document.activeElement.closest('.titlebar-controls')) win.lastFocus = document.activeElement;
    win.cancelPointer?.(); win.element.hidden = true; win.minimized = true;
    win.element.classList.remove('active'); win.task.classList.remove('selected');
    this.focusAfterRemoval(win, hadFocus);
    this.save(); this.changed(); return win;
  }
  toggle(id) { const win = this.windows.get(id); return win?.element.hidden ? this.show(id) : this.hide(id); }
  // Callers can implement hide/show all by looping over list(); neither operation stops agents.
  restoreFocus(win) {
    if (win.element.hidden) return;
    const target = win.lastFocus, previous = this.restoringFocus;
    this.restoringFocus = true;
    try {
      if (target && win.element.contains(target) && !target.closest('[hidden]') && !target.disabled) {
        target.focus({ preventScroll: true });
        if (document.activeElement === target) return;
      }
      win.titlebar.focus({ preventScroll: true });
    } finally { this.restoringFocus = previous; }
  }
  focusAfterRemoval(win, hadFocus) {
    if (this.focused === win) {
      this.focused = null;
      const next = [...this.windows.values()].filter((other) => other !== win && !other.element.hidden)
        .sort((a, b) => Number(b.element.style.zIndex || 0) - Number(a.element.style.zIndex || 0))[0];
      if (next) this.focus(next, false, false);
    }
    if (!hadFocus) return;
    if (this.focused && !this.focused.element.hidden) this.restoreFocus(this.focused);
    else {
      const task = this.tasks.querySelector('button');
      if (task) task.focus({ preventScroll: true });
      else { this.desktop.setAttribute('tabindex', '-1'); this.desktop.focus({ preventScroll: true }); }
    }
  }
  pointer(win, handle, resizing) {
    handle.addEventListener('pointerdown', (event) => {
      if (win.element.hidden || event.button !== 0 || matchMedia('(max-width:760px)').matches || (!resizing && event.target.closest('button'))) return;
      event.preventDefault(); win.cancelPointer?.();
      this.focus(win, true, !resizing);
      const start = { x: event.clientX, y: event.clientY, rect: { ...win.rect } };
      handle.setPointerCapture(event.pointerId);
      const move = (next) => {
        if (next.pointerId !== event.pointerId) return;
        const dx = next.clientX - start.x, dy = next.clientY - start.y;
        if (!dx && !dy) return;
        win.restore = null;
        this.place(win, resizing ? { ...start.rect, w: start.rect.w + dx, h: start.rect.h + dy }
          : { ...start.rect, x: start.rect.x + dx, y: start.rect.y + dy });
      };
      const end = (next = {}) => {
        if (next.pointerId != null && next.pointerId !== event.pointerId) return;
        window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', end);
        window.removeEventListener('pointercancel', end); window.removeEventListener('blur', end);
        if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
        win.cancelPointer = null; this.save();
      };
      win.cancelPointer = end;
      // Window listeners also cover browsers that lose capture during a z-order change.
      window.addEventListener('pointermove', move); window.addEventListener('pointerup', end);
      window.addEventListener('pointercancel', end); window.addEventListener('blur', end);
    });
  }
  keyboard(win, event, resizing) {
    if (win.element.hidden || event.altKey || event.ctrlKey || event.metaKey || event.isComposing) return;
    const delta = { ArrowLeft: [-10, 0], ArrowRight: [10, 0], ArrowUp: [0, -10], ArrowDown: [0, 10] }[event.key];
    if (!delta) return; event.preventDefault(); win.restore = null;
    const next = { ...win.rect }; next[resizing ? 'w' : 'x'] += delta[0]; next[resizing ? 'h' : 'y'] += delta[1];
    this.place(win, next); this.save();
  }
  workingRect(win) {
    const w = this.desktop.clientWidth, h = this.desktop.clientHeight;
    const limits = minimum(win.kind);
    // Open at the minimum usable width with a medium height. Manual resizing
    // replaces these values for that window and keeps them (sizeMode manual).
    const target = { w: Math.min(limits.w, Math.max(1, w - 8)), h: Math.max(limits.h, Math.round(h * MEDIUM_HEIGHT)) };
    const child = win.kind === 'subagent' || win.kind === 'delegated';
    // Grow toward the left, keeping the right-side child anchors. Fit the
    // available height below each anchor rather than piling every child at top.
    const x = child && win.sizeMode === 'compact' ? win.layoutRect.x + win.layoutRect.w - target.w : win.layoutRect.x;
    if (child) target.h = Math.min(target.h, Math.max(limits.h, h - win.layoutRect.y - 8));
    return { ...win.layoutRect, ...target, x };
  }
  autoSize(win = this.focused) {
    if (typeof win === 'string') win = this.windows.get(win);
    if (!win || this.windows.get(win.id) !== win || win.element.hidden || matchMedia('(max-width:760px)').matches) return false;
    const fitted = this.workingRect(win);
    win.restore = null; win.sizeMode = 'auto'; win.zoomed = true; win.layoutRect = fitted;
    this.reflow(win); this.save(); this.changed(); return true;
  }
  zoomToFit(win) {
    if (!win.zoomed) this.autoSize(win);
  }
  reflow(win) {
    const mobile = matchMedia('(max-width:760px)').matches;
    const requested = win.restore && !mobile
      ? { x: 4, y: 4, w: this.desktop.clientWidth - 10, h: this.desktop.clientHeight - 10 }
      : win.sizeMode === 'auto' && !mobile ? this.workingRect(win) : win.layoutRect;
    this.place(win, requested, false);
  }
  place(win, requested, remember = true) {
    const areaW = Math.max(280, this.desktop.clientWidth), areaH = Math.max(300, this.desktop.clientHeight);
    const main = this.windows.get('main');
    const small = win.kind !== 'main' && win.kind !== 'utility' && win.kind !== 'delegated';
    const maxW = small ? Math.max(1, Math.min(460, (main?.rect.w ?? 800) - 140, areaW - 8)) : areaW - 8;
    const maxH = small ? Math.max(1, Math.min(510, (main?.rect.h ?? 680) - 100, areaH - 8)) : areaH - 8;
    const defaults = this.defaultRect(win.kind, win.index, win.id);
    const limits = minimum(win.kind);
    const rect = Object.fromEntries(rectKeys.map((key) => [key, Number.isFinite(requested?.[key]) ? requested[key] : defaults[key]]));
    const w = clamp(rect.w, Math.min(limits.w, maxW), maxW);
    const h = clamp(rect.h, Math.min(limits.h, maxH), maxH);
    const x = clamp(rect.x, 0, Math.max(0, areaW - w));
    const y = clamp(rect.y, 0, Math.max(0, areaH - h));
    win.rect = { x, y, w, h };
    if (remember) { win.layoutRect = { ...win.rect }; win.zoomed = true; win.sizeMode = 'manual'; }
    Object.assign(win.element.style, { left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px` });
    if (win.kind === 'main') for (const other of this.windows.values()) if (other.kind !== 'main' && other.kind !== 'utility') this.reflow(other);
  }
  focus(win, notify = true, zoom = true) {
    if (typeof win === 'string') win = this.windows.get(win);
    if (!win || this.windows.get(win.id) !== win || win.element.hidden) return;
    win.minimized = false; // Existing app callers also reveal element.hidden directly before focusing.
    if (zoom) this.zoomToFit(win);
    if (this.focused === win) return;
    this.focused = win; win.element.style.zIndex = ++this.z;
    for (const other of this.windows.values()) {
      other.element.classList.toggle('active', other === win);
      other.task.classList.toggle('selected', other === win);
    }
    if (notify) this.changed();
  }
  remove(id) {
    const win = this.windows.get(id); if (!win) return;
    const hadFocus = win.element.contains(document.activeElement);
    win.cancelPointer?.(); win.element.remove(); win.task.remove(); this.windows.delete(id);
    this.focusAfterRemoval(win, hadFocus);
    delete this.saved[id]; this.save(); this.changed();
  }
  arrange() {
    for (const win of this.windows.values()) {
      win.restore = null; win.zoomed = false; win.sizeMode = 'compact'; win.layoutRect = this.defaultRect(win.kind, win.index, win.id); this.reflow(win);
    }
    this.save(); this.changed();
  }
  save() {
    // Preserve not-yet-added utilities during startup; all live windows precede old entries.
    const saved = Object.create(null);
    for (const win of this.windows.values()) saved[win.id] = { ...win.layoutRect, hidden: win.element.hidden, zoomed: win.zoomed, sizeMode: win.sizeMode,
      ...(win.restore ? { restore: { ...win.restore }, restoreMode: win.restoreMode } : {}), ...(win.kind === 'delegated' ? { observerIndex: win.index } : {}) };
    for (const [id, entry] of Object.entries(this.saved)) {
      if (Object.keys(saved).length >= 256) break;
      if (!Object.hasOwn(saved, id)) saved[id] = entry;
    }
    this.saved = saved;
    try { localStorage.setItem(storageKey, JSON.stringify(saved)); } catch { /* Private mode can deny storage. */ }
  }
}
