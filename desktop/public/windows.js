const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
export class DesktopWindows {
  constructor(desktop, tasks) {
    this.desktop = desktop; this.tasks = tasks; this.windows = new Map(); this.z = 10;
    try { this.saved = JSON.parse(localStorage.getItem('pi-desktop:layout:v1') || '{}'); } catch { this.saved = {}; }
    window.addEventListener('resize', () => { for (const win of this.windows.values()) this.place(win, win.rect); });
  }
  defaultRect(kind, index = 0) {
    const w = this.desktop.clientWidth, h = this.desktop.clientHeight;
    if (kind === 'main') return { x: Math.max(15, w * .055), y: 34, w: Math.min(1000, w * .66), h: Math.min(780, h - 74) };
    return { x: w - 350 - (index % 2) * 35, y: 105 + (index % 3) * 240, w: 325, h: 310 };
  }
  add({ id, title, kind = 'subagent', onClose, index = 0 }) {
    const element = document.createElement('section');
    element.className = `app-window ${kind === 'main' ? 'main-window' : 'sub-window'}`;
    element.setAttribute('aria-label', title); element.dataset.windowId = id;
    element.innerHTML = '<div class="titlebar" tabindex="0"><span class="window-title"></span><div class="titlebar-controls"></div></div><div class="window-body"></div><button class="resize-handle" aria-label="Resize window"></button>';
    const titlebar = element.querySelector('.titlebar');
    titlebar.setAttribute('aria-label', `${title}: drag or use arrow keys to move; Shift plus arrows to resize`);
    element.querySelector('.window-title').textContent = title;
    const task = document.createElement('button'); task.textContent = title; task.title = `Show ${title}`;
    const win = { id, kind, element, task, body: element.querySelector('.window-body'), index, rect: this.defaultRect(kind, index), minimized: false };
    this.windows.set(id, win); this.desktop.append(element); this.tasks.append(task);
    const controls = element.querySelector('.titlebar-controls');
    const control = (symbol, label, action) => {
      const button = document.createElement('button'); button.className = 'icon'; button.textContent = symbol;
      button.setAttribute('aria-label', label); button.title = label; button.addEventListener('click', action); controls.append(button);
    };
    control('_', 'Minimize window', () => { win.minimized = true; element.hidden = true; task.classList.remove('selected'); });
    if (kind === 'main') control('□', 'Maximize or restore main window', () => {
      if (win.restore) { this.place(win, win.restore); win.restore = null; }
      else { win.restore = { ...win.rect }; this.place(win, { x: 4, y: 4, w: this.desktop.clientWidth - 10, h: this.desktop.clientHeight - 10 }); }
      this.focus(win); this.save();
    });
    else control('×', 'Close subagent window', () => onClose?.(win));
    task.addEventListener('click', () => { win.minimized = false; element.hidden = false; this.focus(win); });
    element.addEventListener('pointerdown', () => this.focus(win));
    this.pointer(win, titlebar, false);
    this.pointer(win, element.querySelector('.resize-handle'), true);
    titlebar.addEventListener('keydown', (event) => {
      if (event.target !== titlebar) return;
      this.keyboard(win, event, event.shiftKey);
    });
    element.querySelector('.resize-handle').addEventListener('keydown', (event) => this.keyboard(win, event, true));
    const saved = this.saved[id];
    if (saved && ['x', 'y', 'w', 'h'].every((key) => Number.isFinite(saved[key]))) win.rect = saved;
    this.place(win, win.rect); this.focus(win); return win;
  }
  pointer(win, handle, resizing) {
    handle.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || matchMedia('(max-width:760px)').matches || (!resizing && event.target.closest('button'))) return;
      event.preventDefault(); win.restore = null;
      const start = { x: event.clientX, y: event.clientY, rect: { ...win.rect } };
      handle.setPointerCapture(event.pointerId);
      const move = (next) => {
        if (next.pointerId !== event.pointerId) return;
        const dx = next.clientX - start.x, dy = next.clientY - start.y;
        this.place(win, resizing ? { ...start.rect, w: start.rect.w + dx, h: start.rect.h + dy }
          : { ...start.rect, x: start.rect.x + dx, y: start.rect.y + dy });
      };
      const end = (next) => {
        if (next.pointerId != null && next.pointerId !== event.pointerId) return;
        window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', end);
        window.removeEventListener('pointercancel', end); window.removeEventListener('blur', end);
        if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
        this.save();
      };
      // Window listeners also cover browsers that lose capture during a z-order change.
      window.addEventListener('pointermove', move); window.addEventListener('pointerup', end);
      window.addEventListener('pointercancel', end); window.addEventListener('blur', end);
    });
  }
  keyboard(win, event, resizing) {
    const delta = { ArrowLeft: [-10, 0], ArrowRight: [10, 0], ArrowUp: [0, -10], ArrowDown: [0, 10] }[event.key];
    if (!delta) return; event.preventDefault();
    const next = { ...win.rect }; next[resizing ? 'w' : 'x'] += delta[0]; next[resizing ? 'h' : 'y'] += delta[1];
    this.place(win, next); this.save();
  }
  place(win, requested) {
    const areaW = Math.max(280, this.desktop.clientWidth), areaH = Math.max(300, this.desktop.clientHeight);
    const main = this.windows.get('main');
    const maxW = win.kind === 'main' ? areaW - 8 : Math.min(460, (main?.rect.w ?? 800) - 140, areaW - 8);
    const maxH = win.kind === 'main' ? areaH - 8 : Math.min(510, (main?.rect.h ?? 680) - 100, areaH - 8);
    const w = clamp(requested.w, Math.min(win.kind === 'main' ? 610 : 270, maxW), maxW);
    const h = clamp(requested.h, Math.min(win.kind === 'main' ? 440 : 250, maxH), maxH);
    const x = clamp(requested.x, 0, Math.max(0, areaW - w));
    const y = clamp(requested.y, 0, Math.max(0, areaH - h));
    win.rect = { x, y, w, h };
    Object.assign(win.element.style, { left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px` });
    if (win.kind === 'main') for (const other of this.windows.values()) if (other.kind !== 'main') this.place(other, other.rect);
  }
  focus(win) {
    win.element.style.zIndex = ++this.z;
    for (const other of this.windows.values()) {
      other.element.classList.toggle('active', other === win);
      other.task.classList.toggle('selected', other === win);
    }
  }
  remove(id) { const win = this.windows.get(id); if (!win) return; win.element.remove(); win.task.remove(); this.windows.delete(id); delete this.saved[id]; this.save(); }
  arrange() { for (const win of this.windows.values()) { win.restore = null; this.place(win, this.defaultRect(win.kind, win.index)); } this.save(); }
  save() {
    const saved = Object.fromEntries([...this.windows.values()].slice(0, 12).map((win) => [win.id, win.rect]));
    try { localStorage.setItem('pi-desktop:layout:v1', JSON.stringify(saved)); } catch { /* Private mode can deny storage. */ }
  }
}
