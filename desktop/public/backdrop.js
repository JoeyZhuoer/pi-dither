const MAX_CELLS = 100_000;
const MAX_EDGE = 2048;
const FRAME_MS = 1000 / 12;
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
const controllers = new WeakMap();

// Water tuning: how long a wave lives, how strongly its slope lights the
// dither, how far the light may push the density, and when the surface counts
// as flat again.
const WATER_DECAY = .3;
const WATER_REST = .4;
const WATER_GAIN = 8.5;
const WATER_LIGHT_LIMIT = .45;
const WATER_SILENT = .05;

function browserFor(canvas) {
  return canvas?.ownerDocument?.defaultView ?? globalThis.window;
}

function positive(value, fallback) {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function contextFor(canvas) {
  try { return canvas?.getContext?.('2d'); } catch { return null; }
}

// The bitmap size is bounded independently of devicePixelRatio; CSS supplies the
// pink ground. The water simulation uses exactly these cells.
export function backdropSize(canvas) {
  const browser = browserFor(canvas);
  const requestedWidth = Math.ceil(positive(browser?.innerWidth, positive(canvas?.clientWidth, 1)) / 3);
  const requestedHeight = Math.ceil(positive(browser?.innerHeight, positive(canvas?.clientHeight, 1)) / 3);
  const scale = Math.min(1, Math.sqrt(MAX_CELLS / requestedWidth / requestedHeight), MAX_EDGE / requestedWidth, MAX_EDGE / requestedHeight);
  return { width: Math.max(1, Math.floor(requestedWidth * scale)), height: Math.max(1, Math.floor(requestedHeight * scale)) };
}

// A damped 2D water surface on the backdrop's cell grid. Droplets send out rings
// that superpose (interfere) and reflect off the mirrored edges; once nothing
// new is dropped they slowly flatten out. Exported for tests.
export class WaterSurface {
  constructor(cols, rows, random = Math.random) {
    this.cols = Math.max(3, Math.floor(cols));
    this.rows = Math.max(3, Math.floor(rows));
    this.stride = this.cols + 2;
    const size = this.stride * (this.rows + 2);
    this.previous = new Float32Array(size);
    this.current = new Float32Array(size);
    this.next = new Float32Array(size);
    this.random = typeof random === 'function' ? random : Math.random;
    this.pending = 0;
    this.energy = 0;
    this.active = false;
  }
  // A smooth bump added to both time levels, i.e. a zero-velocity displacement:
  // the wave equation turns it into an expanding ring without growing the mean.
  drop(x, y, radius = 4, amplitude = 1) {
    const centerX = Math.round(this.clampX(x)), centerY = Math.round(this.clampY(y));
    const spread = Math.max(1, Number.isFinite(radius) ? radius : 4);
    const strength = Number.isFinite(amplitude) ? amplitude : 1;
    const reach = Math.ceil(spread * 3);
    for (let offsetY = -reach; offsetY <= reach; offsetY++) for (let offsetX = -reach; offsetX <= reach; offsetX++) {
      const distance = (offsetX * offsetX + offsetY * offsetY) / (spread * spread);
      if (distance > 9) continue;
      const x2 = centerX + offsetX, y2 = centerY + offsetY;
      if (x2 < 1 || y2 < 1 || x2 > this.cols || y2 > this.rows) continue;
      const bump = strength * Math.exp(-distance);
      this.current[y2 * this.stride + x2] += bump;
      this.previous[y2 * this.stride + x2] += bump;
    }
    this.active = true;
  }
  clampX(x) { return Number.isFinite(x) ? Math.min(Math.max(x, 1), this.cols) : 1 + this.random() * this.cols; }
  clampY(y) { return Number.isFinite(y) ? Math.min(Math.max(y, 1), this.rows) : 1 + this.random() * this.rows; }
  // While the model generates, random droplets keep the surface alive. Output is
  // more energetic than thinking.
  spawn(delta, activity) {
    if (activity !== 'thinking' && activity !== 'output') return 0;
    const rate = activity === 'output' ? 4.2 : 2.6;
    this.pending += Math.min(.5, Math.max(0, Number.isFinite(delta) ? delta : 0)) * rate;
    let made = 0;
    while (this.pending >= 1) {
      this.pending -= 1; made++;
      const radius = 3 + this.random() * 4;
      const amplitude = activity === 'output' ? .7 + this.random() * .7 : .45 + this.random() * .5;
      this.drop(this.random() * this.cols, this.random() * this.rows, radius, amplitude);
    }
    return made;
  }
  // Time-based stepping: small passes keep the wave speed steady and the
  // scheme stable, while damping is applied per second so the fade rate does
  // not depend on the frame cadence.
  step(delta) {
    const seconds = Math.max(0, Math.min(.5, Number.isFinite(delta) ? delta : 0));
    const passes = Math.max(1, Math.min(6, Math.round(seconds * 24)));
    const damping = Math.exp(-WATER_DECAY * seconds / passes);
    for (let pass = 0; pass < passes; pass++) this.advance(damping, pass === passes - 1);
  }
  // One explicit finite-difference pass with zero (reflecting) edges. The
  // laplacian weight stays below the stability limit so the surface never
  // grows; the wave speed is sqrt(WATER_REST) cells per pass.
  advance(damping, measure) {
    const { cols, rows, stride, current, previous, next } = this;
    let energy = 0;
    for (let y = 1; y <= rows; y++) {
      const row = y * stride;
      for (let x = 1; x <= cols; x++) {
        const index = row + x;
        const here = current[index];
        const value = (2 * here - previous[index]
          + WATER_REST * (current[index - 1] + current[index + 1] + current[index - stride] + current[index + stride] - 4 * here)) * damping;
        next[index] = value;
        if (measure) energy += value * value;
      }
    }
    const recycled = previous;
    this.previous = current; this.current = next; this.next = recycled;
    if (measure) {
      this.energy = energy;
      this.active = energy > WATER_SILENT;
    }
  }
  silent() { return !this.active; }
}

// The base dither field is the original idle pattern, kept exactly as it was.
// A water surface, when present, lights it with its slope so ripples show as
// dithered crests and troughs; without a surface the pixels are unchanged.
export function drawBackdrop(canvas, timeSeconds = 0, water = null) {
  const ctx = contextFor(canvas);
  if (!ctx) return;
  const { width, height } = backdropSize(canvas);
  // Keep the bitmap bounded independently of devicePixelRatio; CSS supplies the pink ground.
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = '#20201f';
  const time = Number.isFinite(timeSeconds) ? timeSeconds : 0;
  const field = water && Number.isInteger(water.cols) && Number.isInteger(water.rows) && water.cols === width && water.rows === height
    && water.stride === width + 2 && water.current instanceof Float32Array && !water.silent?.() ? water : null;
  const driftX = Math.sin(time * .13) * .035;
  const driftY = Math.sin(time * .11) * .025;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const u = x / width, v = y / height;
    const a = Math.exp(-(((u + .04 - driftX) / .25) ** 2 + ((v - 1.02 - driftY) / .31) ** 2));
    const b = Math.exp(-(((u - .52 + driftX) / .19) ** 2 + ((v - 1.05 + driftY) / .22) ** 2));
    const c = Math.exp(-(((u - 1.01 - driftY) / .20) ** 2 + ((v - .55 - driftX) / .23) ** 2));
    const phase = x * .41 + y * .27 + time * .24 + Math.sin(y * .073 + time * .09) * 9;
    const wave = .65 + .35 * Math.sin(phase);
    let density = Math.max(a, b, c) * wave * .88;
    if (field) {
      const index = (y + 1) * field.stride + (x + 1);
      const slope = (field.current[index + 1] - field.current[index - 1]) + (field.current[index + field.stride] - field.current[index - field.stride]);
      const light = slope * WATER_GAIN;
      density += light > WATER_LIGHT_LIMIT ? WATER_LIGHT_LIMIT : light < -WATER_LIGHT_LIMIT ? -WATER_LIGHT_LIMIT : light;
    }
    const threshold = BAYER[(y % 4) * 4 + x % 4] / 16;
    if (density > threshold + .06) ctx.fillRect(x, y, 1, 1);
    else if (x % 3 === 0 && y % 3 === 0) ctx.fillRect(x, y, .45, .45);
  }
}

export function startBackdrop(canvas, { paused = false, onStateChange, random } = {}) {
  // Replacing a controller on the same canvas must not leave a second loop behind.
  if (canvas && typeof canvas === 'object') controllers.get(canvas)?.destroy();
  const browser = browserFor(canvas);
  const document = canvas?.ownerDocument ?? browser?.document;
  const media = browser?.matchMedia?.('(prefers-reduced-motion: reduce)');
  const canRun = !!(contextFor(canvas) && browser?.setTimeout && browser?.clearTimeout);
  const cleanups = [];
  let manualPause = Boolean(paused), disposed = false, pageHidden = false, activity = 'idle', water = null;
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

  function surface() {
    const size = backdropSize(canvas);
    if (!water || water.cols !== size.width || water.rows !== size.height) water = new WaterSurface(size.width, size.height, random);
    return water;
  }

  function tick() {
    timer = null;
    if (!running || disposed) return;
    const current = now();
    // Freeze animation time while stopped, and avoid a jump after a long main-thread stall.
    const delta = Math.min(.25, Math.max(0, (current - lastTick) / 1000));
    time += delta;
    // Busy work rains new droplets; idle makes none, so the surface flattens out.
    if (activity !== 'idle' || water) {
      const field = surface();
      field.spawn(delta, activity);
      if (activity !== 'idle' || !field.silent()) field.step(delta);
      drawBackdrop(canvas, time, field.silent() ? null : field);
    } else {
      drawBackdrop(canvas, time);
    }
    lastTick = current;
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
    if (!disposed && !running && !hidden()) drawBackdrop(canvas, time, water && !water.silent() ? water : null);
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
      activity = value === 'thinking' || value === 'output' ? value : 'idle';
    },
    setPaused(value) {
      if (disposed) return;
      manualPause = Boolean(value);
      reconcile();
    },
    destroy() {
      if (disposed) return;
      disposed = true;
      water = null;
      for (const cleanup of cleanups) cleanup();
      if (canvas && typeof canvas === 'object' && controllers.get(canvas) === controller) controllers.delete(canvas);
      reconcile();
    },
  };
  if (canvas && typeof canvas === 'object') controllers.set(canvas, controller);
  if (!hidden()) drawBackdrop(canvas, time);
  reconcile();
  return controller;
}
