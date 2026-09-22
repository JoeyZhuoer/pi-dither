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

// Busy modes drift the whole dithered field with fractional offsets so the
// pattern glides smoothly, and sample the threshold in those same moving
// coordinates: the whole bitmap then stays a true translation of itself, with
// only a little changing each frame. Idle keeps its own vibration, its hard
// Bayer lattice and no offset.
const FLOW_CELLS_PER_SECOND = 1.6;
// Exported for tests: deterministic, side-effect-free drift path.
export function flowOffset(mode, time, width, height) {
  if (mode === 'output') {
    const lift = Math.max(1, height * .5);
    return { x: 0, y: lift * Math.sin(time * FLOW_CELLS_PER_SECOND / lift) };
  }
  if (mode === 'thinking') {
    const across = Math.max(1, width * .3), down = Math.max(1, height * .24);
    const axis = FLOW_CELLS_PER_SECOND / Math.SQRT2;
    return { x: across * Math.sin(time * axis / across), y: down * Math.sin(time * axis / down + 1.9) };
  }
  return null;
}
// Bilinear interpolation of the 4x4 lattice: continuous in space, so moving
// the sampled coordinates with the field translates the dither instead of
// re-dithering it wholesale at each whole-cell crossing.
function softThreshold(sx, sy) {
  const fx = sx - Math.floor(sx), fy = sy - Math.floor(sy);
  const x0 = ((Math.floor(sx) % 4) + 4) % 4, y0 = ((Math.floor(sy) % 4) + 4) % 4;
  const x1 = (x0 + 1) % 4, y1 = (y0 + 1) % 4;
  const top = BAYER[y0 * 4 + x0] + (BAYER[y0 * 4 + x1] - BAYER[y0 * 4 + x0]) * fx;
  const bottom = BAYER[y1 * 4 + x0] + (BAYER[y1 * 4 + x1] - BAYER[y1 * 4 + x0]) * fx;
  return (top + (bottom - top) * fy) / 16;
}

// The generated text seeds a dither wave: direction, wavelength, travel speed
// and ripple all come from a local fingerprint of that text, and the wave also
// advances as more text arrives. Each generation therefore shapes the
// background differently.
function waveFrom(shape) {
  const s = shape >>> 0;
  const angle = (s & 0xff) / 255 * Math.PI * 2;
  const frequency = .07 + ((s >>> 8) & 0xff) / 255 * .26;
  return { x: Math.cos(angle) * frequency, y: Math.sin(angle) * frequency,
    speed: .7 + ((s >>> 16) & 0xff) / 255 * 1.6,
    ripple: .25 + ((s >>> 24) & 0x0f) / 15 * 1.05,
    phase: ((s >>> 28) & 0x0f) / 16 * Math.PI * 2 };
}

export function drawBackdrop(canvas, timeSeconds = 0, activity = 'idle', shape = 0, progress = 0) {
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
  const mode = activityMode(activity);
  // Only idle drifts internally. Busy fields stay rigid so all of their motion
  // is one coherent translation of the complete pattern.
  const driftX = mode === 'idle' ? Math.sin(time * .13) * .035 : 0;
  const driftY = mode === 'idle' ? Math.sin(time * .11) * .025 : 0;
  const flow = flowOffset(mode, time, width, height);
  // The seeded wave and its text progress only exist while the model is busy;
  // idle keeps the original field, threshold and shimmer untouched.
  const ditherWave = flow ? waveFrom(Number.isFinite(shape) ? shape : 0) : null;
  const arrived = Number.isFinite(progress) && progress > 0 ? progress : 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const sx = flow ? x + flow.x : x, sy = flow ? y + flow.y : y;
    const u = sx / width, v = sy / height;
    const a = Math.exp(-(((u + .04 - driftX) / .25) ** 2 + ((v - 1.02 - driftY) / .31) ** 2));
    const b = Math.exp(-(((u - .52 + driftX) / .19) ** 2 + ((v - 1.05 + driftY) / .22) ** 2));
    const c = Math.exp(-(((u - 1.01 - driftY) / .20) ** 2 + ((v - .55 - driftX) / .23) ** 2));
    // Idle keeps the original slow band arithmetic. Busy bands keep the same
    // random-like vibration as idle and ride the translation above.
    const phase = mode === 'thinking'
      ? sx * .25 + sy * .19 + Math.sin(sy * .055 - time * .3) * 9
      : mode === 'output' ? sy * .34 + sx * .07 + Math.sin(sx * .035 + time * .45) * 3
        : x * .41 + y * .27 + time * .24 + Math.sin(y * .073 + time * .09) * 9;
    const band = .65 + .35 * Math.sin(phase);
    let density = Math.max(a, b, c) * band * .88;
    if (ditherWave) {
      // A traveling dither wave: it moves along its seeded direction, ripples,
      // and is nudged forward by the text being generated.
      const along = (sx - width / 2) * ditherWave.x + (sy - height / 2) * ditherWave.y
        - time * ditherWave.speed - arrived * .05 + ditherWave.phase;
      const cross = (sx * -ditherWave.y + sy * ditherWave.x) * 2.7 + time * .9;
      const crest = .5 + .5 * Math.sin(along + Math.sin(cross) * (1.5 + ditherWave.ripple * 4));
      const vibrate = .84 + .16 * Math.sin(time * 2.6 + along * .4);
      density = density * (.36 + 1.28 * crest) * vibrate;
    }
    const threshold = flow ? softThreshold(sx, sy) : BAYER[(y % 4) * 4 + x % 4] / 16;
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
  let manualPause = Boolean(paused), disposed = false, pageHidden = false, activity = 'idle', shape = 0, progress = 0;
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
    time += Math.min(.25, Math.max(0, (current - lastTick) / 1000));
    lastTick = current;
    drawBackdrop(canvas, time, activity, shape, progress);
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
    if (!disposed && !running && !hidden()) drawBackdrop(canvas, time, activity, shape, progress);
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
    // Local fingerprint of the generated text (shape) and how much has arrived
    // (progress). Neither is stored or sent anywhere; they only steer the wave.
    setSignal(nextShape = 0, nextProgress = 0) {
      if (disposed) return;
      shape = Number.isFinite(nextShape) ? nextShape >>> 0 : 0;
      progress = Number.isFinite(nextProgress) && nextProgress > 0 ? nextProgress : 0;
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
  if (!hidden()) drawBackdrop(canvas, time, activity, shape, progress);
  reconcile();
  return controller;
}
