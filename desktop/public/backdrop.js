const MAX_CELLS = 100_000;
const MAX_EDGE = 2048;
const FRAME_MS = 1000 / 12;
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
const controllers = new WeakMap();

function browserFor(canvas) {
  return canvas?.ownerDocument?.defaultView ?? globalThis.window;
}

function positive(value, fallback) {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function contextFor(canvas) {
  try { return canvas?.getContext?.('2d'); } catch { return null; }
}

// Unknown inputs safely return to the original idle field.
const activityMode = value => value === 'thinking' || value === 'output' ? value : 'idle';

// While the model generates, the dither wave travels in a single direction: this
// band phase advances steadily and nothing else moves. When work stops the phase
// freezes, so the pattern stays exactly where it was and idle's own shimmer
// takes over. The animation loop owns the phase; drawBackdrop stays pure.
export const FLOW_RADIANS_PER_SECOND = 2.4;

export function drawBackdrop(canvas, timeSeconds = 0, activity = 'idle', phaseShift = 0) {
  const ctx = contextFor(canvas);
  if (!ctx) return;
  const browser = browserFor(canvas);
  const requestedWidth = Math.ceil(positive(browser?.innerWidth, positive(canvas.clientWidth, 1)) / 3);
  const requestedHeight = Math.ceil(positive(browser?.innerHeight, positive(canvas.clientHeight, 1)) / 3);
  const scale = Math.min(1, Math.sqrt(MAX_CELLS / requestedWidth / requestedHeight), MAX_EDGE / requestedWidth, MAX_EDGE / requestedHeight);
  const width = Math.max(1, Math.floor(requestedWidth * scale));
  const height = Math.max(1, Math.floor(requestedHeight * scale));
  // Keep the bitmap bounded independently of devicePixelRatio; CSS supplies the pink ground.
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = '#20201f';
  const time = Number.isFinite(timeSeconds) ? timeSeconds : 0;
  const shift = Number.isFinite(phaseShift) ? phaseShift : 0;
  const mode = activityMode(activity);
  // Only idle drifts internally. Busy fields are rigid, so their only motion is
  // the one-way band phase below and they never vibrate while generating.
  const driftX = mode === 'idle' ? Math.sin(time * .13) * .035 : 0;
  const driftY = mode === 'idle' ? Math.sin(time * .11) * .025 : 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const u = x / width, v = y / height;
    const a = Math.exp(-(((u + .04 - driftX) / .25) ** 2 + ((v - 1.02 - driftY) / .31) ** 2));
    const b = Math.exp(-(((u - .52 + driftX) / .19) ** 2 + ((v - 1.05 + driftY) / .22) ** 2));
    const c = Math.exp(-(((u - 1.01 - driftY) / .20) ** 2 + ((v - .55 - driftX) / .23) ** 2));
    // Idle keeps its original slow band arithmetic and random-like shimmer.
    // Busy bands are static (no vibration) and travel one way with the shift.
    const phase = mode === 'thinking'
      ? x * .25 + y * .19 + Math.sin(y * .055) * 13 + shift
      : mode === 'output' ? y * .34 + x * .07 + Math.sin(x * .035) * 3 + shift
        : x * .41 + y * .27 + time * .24 + Math.sin(y * .073 + time * .09) * 9 + shift;
    const wave = .65 + .35 * Math.sin(phase);
    const density = Math.max(a, b, c) * wave * .88;
    const threshold = BAYER[(y % 4) * 4 + x % 4] / 16;
    if (density > threshold + .06) ctx.fillRect(x, y, 1, 1);
    else if (x % 3 === 0 && y % 3 === 0) ctx.fillRect(x, y, .45, .45);
  }
}

export function startBackdrop(canvas, { paused = false, onStateChange } = {}) {
  // Replacing a controller on the same canvas must not leave a second loop behind.
  if (canvas && typeof canvas === 'object') controllers.get(canvas)?.destroy();
  const browser = browserFor(canvas);
  const document = canvas?.ownerDocument ?? browser?.document;
  const media = browser?.matchMedia?.('(prefers-reduced-motion: reduce)');
  const canRun = !!(contextFor(canvas) && browser?.setTimeout && browser?.clearTimeout);
  const cleanups = [];
  let manualPause = Boolean(paused), disposed = false, pageHidden = false, activity = 'idle', phaseShift = 0;
  let timer = null, running = false, time = 0, lastTick = 0, previousState;
  const now = () => browser?.performance?.now?.() ?? Date.now();
  const hidden = () => Boolean(document?.hidden || pageHidden);

  function notify() {
    const state = { paused: manualPause, running, reducedMotion: Boolean(media?.matches), hidden: hidden() };
    if (!previousState || Object.keys(state).some(key => state[key] !== previousState[key])) {
      previousState = state;
      onStateChange?.({ ...state });
    }
  }

  function tick() {
    timer = null;
    if (!running || disposed) return;
    const current = now();
    // Freeze animation time while stopped, and avoid a jump after a long main-thread stall.
    const delta = Math.min(.25, Math.max(0, (current - lastTick) / 1000));
    time += delta;
    // The busy wave advances in one direction only; idle leaves the phase where
    // it is, so stopping freezes the pattern at its current position.
    if (activity !== 'idle') phaseShift += FLOW_RADIANS_PER_SECOND * delta;
    lastTick = current;
    drawBackdrop(canvas, time, activity, phaseShift);
    timer = browser.setTimeout(tick, FRAME_MS);
  }

  function reconcile() {
    const next = !disposed && canRun && !manualPause && !media?.matches && !hidden();
    if (next !== running) {
      running = next;
      if (running) {
        lastTick = now();
        timer = browser.setTimeout(tick, FRAME_MS);
      } else {
        browser.clearTimeout(timer);
        timer = null;
      }
    }
    notify();
  }

  function listen(target, event, listener) {
    if (!target?.addEventListener) return;
    target.addEventListener(event, listener);
    cleanups.push(() => target.removeEventListener(event, listener));
  }

  function resize() {
    // Running frames pick up size changes at the capped cadence. A stopped, visible
    // background may repaint once for layout, but never starts an animation timer.
    if (!disposed && !running && !hidden()) drawBackdrop(canvas, time, activity, phaseShift);
  }
  listen(browser, 'resize', resize);
  listen(document, 'visibilitychange', () => { resize(); reconcile(); });
  listen(browser, 'pagehide', () => { pageHidden = true; reconcile(); });
  listen(browser, 'pageshow', () => { pageHidden = false; resize(); reconcile(); });
  if (media?.addEventListener) listen(media, 'change', reconcile);
  else if (media?.addListener) {
    media.addListener(reconcile);
    cleanups.push(() => media.removeListener(reconcile));
  }

  const controller = {
    setActivity(value) {
      if (disposed) return;
      // Coalesce transitions into the existing cadence. Paused activity changes
      // do not draw or advance time; a later frame/layout repaint uses the latest.
      activity = activityMode(value);
    },
    setPaused(value) {
      if (disposed) return;
      manualPause = Boolean(value);
      reconcile();
    },
    destroy() {
      if (disposed) return;
      disposed = true;
      for (const cleanup of cleanups) cleanup();
      if (canvas && typeof canvas === 'object' && controllers.get(canvas) === controller) controllers.delete(canvas);
      reconcile();
    },
  };
  if (canvas && typeof canvas === 'object') controllers.set(canvas, controller);
  if (!hidden()) drawBackdrop(canvas, time, activity, phaseShift);
  reconcile();
  return controller;
}
