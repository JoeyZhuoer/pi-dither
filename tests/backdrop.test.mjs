import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { drawBackdrop, startBackdrop, WaterSurface } from '../desktop/public/backdrop.js';

class Events {
  listeners = new Map();
  addEventListener(type, callback) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(callback);
  }
  removeEventListener(type, callback) { this.listeners.get(type)?.delete(callback); }
  emit(type) { for (const callback of [...(this.listeners.get(type) ?? [])]) callback({ type }); }
  get listenerCount() { return [...this.listeners.values()].reduce((count, listeners) => count + listeners.size, 0); }
}

// All scheduling, viewport, visibility and media state belong to the canvas's fake
// window: no global mutation, browser process, provider, or real timer is needed.
function fixture({ width = 480, height = 300, hidden = false, reducedMotion = false, legacyMedia = false } = {}) {
  const browser = new Events(), document = new Events(), media = new Events();
  const timers = new Map(), frames = [];
  let clock = 0, nextTimer = 0, maxTimers = 0, bitmapResets = 0, bitmapWidth = 0, bitmapHeight = 0;
  Object.assign(browser, {
    innerWidth: width, innerHeight: height, devicePixelRatio: 4, document,
    performance: { now: () => clock },
    setTimeout(callback, delay) {
      assert.ok(delay >= 1000 / 12, 'timer must respect the 12fps cap');
      const id = ++nextTimer;
      timers.set(id, { callback, at: clock + delay });
      maxTimers = Math.max(maxTimers, timers.size);
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    matchMedia(query) { assert.equal(query, '(prefers-reduced-motion: reduce)'); return media; },
  });
  Object.assign(document, { defaultView: browser, hidden });
  media.matches = reducedMotion;
  if (legacyMedia) {
    media.addListener = callback => Events.prototype.addEventListener.call(media, 'change', callback);
    media.removeListener = callback => Events.prototype.removeEventListener.call(media, 'change', callback);
    media.addEventListener = undefined;
    media.removeEventListener = undefined;
  }
  const ctx = {
    fillStyle: '',
    clearRect(x, y, width, height) { frames.push({ width, height, cells: new Set(), calls: 0, color: null }); },
    fillRect(x, y, width, height) {
      const frame = frames.at(-1);
      frame.cells.add(`${x},${y},${width},${height}`);
      frame.calls++;
      frame.color = this.fillStyle;
    },
  };
  const canvas = {
    ownerDocument: document,
    getContext(type) { assert.equal(type, '2d'); return ctx; },
    get width() { return bitmapWidth; },
    set width(value) { bitmapWidth = value; bitmapResets++; },
    get height() { return bitmapHeight; },
    set height(value) { bitmapHeight = value; bitmapResets++; },
  };
  return {
    canvas, browser, document, media, timers, frames,
    get maxTimers() { return maxTimers; },
    get bitmapResets() { return bitmapResets; },
    advance(ms) {
      const end = clock + ms;
      while (timers.size) {
        const [id, timer] = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
        if (timer.at > end) break;
        clock = timer.at;
        timers.delete(id);
        timer.callback();
      }
      clock = end;
    },
    resize(width, height) { browser.innerWidth = width; browser.innerHeight = height; browser.emit('resize'); },
    visibility(hidden) { document.hidden = hidden; document.emit('visibilitychange'); },
    reduction(value) { media.matches = value; media.emit('change'); },
  };
}

function state(paused, running, reducedMotion = false, hidden = false) {
  return { paused, running, reducedMotion, hidden };
}

function assertDisposed(f) {
  assert.equal(f.timers.size, 0);
  assert.equal(f.browser.listenerCount, 0);
  assert.equal(f.document.listenerCount, 0);
  assert.equal(f.media.listenerCount, 0);
}

test('drawBackdrop is a deterministic one-shot that gently evolves without changing the ink/pink palette', () => {
  const f = fixture();
  drawBackdrop(f.canvas);
  drawBackdrop(f.canvas, 0);
  drawBackdrop(f.canvas, 1 / 12);
  drawBackdrop(f.canvas, 12);
  assert.deepEqual(f.frames[0], f.frames[1]);
  assert.notDeepEqual(f.frames[0].cells, f.frames[2].cells);
  assert.notDeepEqual(f.frames[0].cells, f.frames[3].cells);
  const first = f.frames[0], next = f.frames[2];
  const changed = [...first.cells].filter(cell => !next.cells.has(cell)).length + [...next.cells].filter(cell => !first.cells.has(cell)).length;
  assert.ok(changed / (first.width * first.height) < .02, 'adjacent frames change only a small fraction of the dither');
  assert.ok(f.frames.every(frame => frame.color === '#20201f'));
  assert.equal(f.timers.size, 0);
  assert.equal(f.browser.listenerCount, 0);
  assert.equal(f.bitmapResets, 2, 'steady-size frames must not reset the bitmap');
});

test('drawBackdrop caps cells and individual bitmap dimensions even for huge or narrow viewports', () => {
  const f = fixture();
  for (const [width, height] of [[1920, 1080], [7680, 4320], [1e9, 1e9], [1e9, 1], [1, 1e9], [0, NaN], [Infinity, -1]]) {
    f.resize(width, height);
    drawBackdrop(f.canvas, 12);
    for (const frame of f.frames.slice(-3)) {
      assert.ok(frame.width * frame.height <= 100_000);
      assert.ok(frame.calls <= 100_000);
    }
    const frame = f.frames.at(-1);
    assert.ok(frame.width >= 1 && frame.height >= 1);
    assert.ok(frame.width <= 2048 && frame.height <= 2048);
    assert.ok(frame.width * frame.height <= 100_000);
    assert.ok(frame.calls <= 100_000);
  }
});

test('drawBackdrop and startBackdrop handle absent or unavailable canvases without animation work', () => {
  assert.doesNotThrow(() => drawBackdrop(null));
  assert.doesNotThrow(() => drawBackdrop({ getContext() { throw new Error('unavailable'); } }));
  const f = fixture(), states = [];
  f.canvas.getContext = () => null;
  const controller = startBackdrop(f.canvas, { onStateChange: value => states.push(value) });
  f.advance(1000);
  assert.deepEqual(states, [state(false, false)]);
  assert.equal(f.frames.length, 0);
  assert.equal(f.timers.size, 0);
  controller.destroy();
  assertDisposed(f);
  const noCanvas = startBackdrop(null);
  noCanvas.setPaused(true);
  noCanvas.destroy();
});

test('drawBackdrop treats nonfinite animation time as zero', () => {
  const f = fixture();
  drawBackdrop(f.canvas, 0);
  for (const time of [NaN, Infinity, -Infinity]) {
    drawBackdrop(f.canvas, time);
    assert.deepEqual(f.frames.at(-1), f.frames[0]);
  }
});

test('startBackdrop runs only one 12fps loop, coalesces running resizes and notifies only state changes', () => {
  const f = fixture(), states = [];
  const controller = startBackdrop(f.canvas, { onStateChange: value => states.push(value) });
  assert.deepEqual(states, [state(false, true)]);
  assert.equal(f.frames.length, 1);
  f.advance(1000);
  assert.ok(f.frames.length >= 11 && f.frames.length <= 13, `${f.frames.length} frames in one second including the initial frame`);
  assert.notDeepEqual(f.frames[0].cells, f.frames.at(-1).cells);
  assert.equal(states.length, 1);
  const count = f.frames.length;
  for (let i = 0; i < 30; i++) f.resize(900 + i, 600);
  assert.equal(f.frames.length, count, 'resize bursts use the existing frame cadence');
  f.advance(100);
  assert.equal(f.canvas.width, Math.ceil(929 / 3));
  assert.equal(f.canvas.height, 200);
  assert.equal(f.maxTimers, 1);
  controller.destroy();
  assert.deepEqual(states.at(-1), state(false, false));
  assertDisposed(f);
});

test('startBackdrop manual pause freezes time, preserves static resize and resumes without duplicate timers', () => {
  const f = fixture(), states = [];
  const controller = startBackdrop(f.canvas, { paused: true, onStateChange: value => states.push(value) });
  assert.deepEqual(states, [state(true, false)]);
  assert.equal(f.frames.length, 1, 'paused starts with a static background');
  f.advance(5000);
  assert.equal(f.frames.length, 1);
  f.resize(600, 300);
  assert.equal(f.frames.length, 2);
  assert.equal(f.canvas.width, 200);
  assert.equal(f.timers.size, 0);
  controller.setPaused(true);
  assert.equal(states.length, 1);
  controller.setPaused(false);
  controller.setPaused(false);
  f.advance(100);
  const reference = fixture({ width: 600, height: 300 });
  drawBackdrop(reference.canvas, 1 / 12);
  assert.deepEqual(f.frames.at(-1), reference.frames[0], 'paused wall time must not advance the flow');
  controller.setPaused(true);
  const count = f.frames.length;
  f.advance(5000);
  assert.equal(f.frames.length, count);
  assert.deepEqual(states, [state(true, false), state(false, true), state(true, false)]);
  assert.equal(f.maxTimers, 1);
  controller.destroy();
  assertDisposed(f);
});

test('startBackdrop visibility and page lifecycle stop all timers and hidden resize work', () => {
  const f = fixture(), states = [];
  const controller = startBackdrop(f.canvas, { onStateChange: value => states.push(value) });
  f.visibility(true);
  assert.deepEqual(states.at(-1), state(false, false, false, true));
  assert.equal(f.timers.size, 0);
  f.resize(900, 600);
  f.advance(5000);
  assert.equal(f.frames.length, 1);
  f.visibility(false);
  assert.deepEqual(states.at(-1), state(false, true));
  assert.equal(f.canvas.width, 300);
  f.browser.emit('pagehide');
  assert.deepEqual(states.at(-1), state(false, false, false, true));
  assert.equal(f.timers.size, 0);
  const count = f.frames.length;
  f.advance(5000);
  assert.equal(f.frames.length, count);
  f.browser.emit('pageshow');
  f.browser.emit('pageshow');
  assert.deepEqual(states.at(-1), state(false, true));
  assert.equal(f.maxTimers, 1);
  controller.setPaused(true);
  f.visibility(true);
  f.visibility(false);
  f.browser.emit('pagehide');
  f.browser.emit('pageshow');
  assert.deepEqual(states.at(-1), state(true, false));
  assert.equal(f.timers.size, 0, 'page restore does not override the manual preference');
  controller.destroy();
  assertDisposed(f);
});

test('startBackdrop initially hidden performs no drawing, and restores a static reduced-motion frame', () => {
  const f = fixture({ hidden: true, reducedMotion: true }), states = [];
  const controller = startBackdrop(f.canvas, { onStateChange: value => states.push(value) });
  assert.equal(f.frames.length, 0);
  assert.deepEqual(states, [state(false, false, true, true)]);
  f.advance(5000);
  f.visibility(false);
  assert.equal(f.frames.length, 1);
  assert.equal(f.timers.size, 0);
  assert.deepEqual(states.at(-1), state(false, false, true));
  controller.destroy();
  assertDisposed(f);
});

for (const legacyMedia of [false, true]) {
  test(`startBackdrop honors live reduced-motion changes (${legacyMedia ? 'legacy' : 'modern'} media events)`, () => {
    const f = fixture({ reducedMotion: true, legacyMedia }), states = [];
    const controller = startBackdrop(f.canvas, { onStateChange: value => states.push(value) });
    assert.deepEqual(states, [state(false, false, true)]);
    assert.equal(f.frames.length, 1);
    assert.equal(f.timers.size, 0);
    f.advance(5000);
    assert.equal(f.frames.length, 1);
    f.reduction(false);
    f.reduction(false);
    assert.deepEqual(states, [state(false, false, true), state(false, true)]);
    f.advance(100);
    assert.equal(f.frames.length, 2);
    f.reduction(true);
    assert.equal(f.timers.size, 0);
    f.advance(5000);
    assert.equal(f.frames.length, 2);
    controller.setPaused(true);
    f.reduction(false);
    assert.deepEqual(states.at(-1), state(true, false));
    assert.equal(f.timers.size, 0);
    controller.setPaused(false);
    assert.equal(f.timers.size, 1);
    controller.destroy();
    assertDisposed(f);
  });
}

test('startBackdrop replacement and disposal remove all listeners/timers and stale callbacks cannot revive work', () => {
  const f = fixture(), states = [];
  const first = startBackdrop(f.canvas);
  const firstTick = [...f.timers.values()][0].callback;
  const controller = startBackdrop(f.canvas, { onStateChange: value => states.push(value) });
  assert.equal(f.browser.listenerCount, 3);
  assert.equal(f.document.listenerCount, 1);
  assert.equal(f.media.listenerCount, 1);
  assert.equal(f.timers.size, 1);
  firstTick();
  first.destroy();
  first.setPaused(false);
  assert.equal(f.timers.size, 1);
  const tick = [...f.timers.values()][0].callback;
  controller.destroy();
  controller.destroy();
  controller.setPaused(false);
  const count = f.frames.length, stateCount = states.length;
  f.resize(900, 600);
  f.visibility(true);
  f.visibility(false);
  f.reduction(true);
  f.reduction(false);
  f.browser.emit('pagehide');
  f.browser.emit('pageshow');
  tick();
  f.advance(5000);
  assert.equal(f.frames.length, count);
  assert.equal(states.length, stateCount);
  assert.equal(f.maxTimers, 1);
  assertDisposed(f);
});

// Golden hashes captured from the pre-activity implementation, not from the
// new idle branch: preserve every fill call and its order at multiple times.
test('idle pixels exactly match the original animation', () => {
  const f = fixture();
  const goldens = [
    [0, '2fbcd1876a13f69720c24dc52556bb52c5bb870b8d255b7a7f8772d9e0afb13d'],
    [1 / 12, '5d06550b1e9b7b91f370c9c859cf288b55ea28ceed333550fab41ea4ea400eee'],
    [12, 'eb0fe44a27921f6530eb6567321acd22eb78e3f0986d6a343fbf621ef16202ef'],
    [123.5, 'be44e5ef3f0a4cb67c9ea2e6f29597ee005c3628754b522ed7b92d87f3e16a52'],
  ];
  for (const [time, expected] of goldens) {
    drawBackdrop(f.canvas, time);
    assert.equal(createHash('sha256').update([...f.frames.at(-1).cells].join('|')).digest('hex'), expected);
  }
});

function changedCells(before, after) {
  let changed = 0;
  for (const cell of before.cells) if (!after.cells.has(cell)) changed++;
  for (const cell of after.cells) if (!before.cells.has(cell)) changed++;
  return changed;
}

test('water waves interfere, bounce off the edges and slowly flatten out', () => {
  // Interference: the surface is linear, so two droplets together equal the sum
  // of the same droplets simulated apart.
  const first = new WaterSurface(60, 40), second = new WaterSurface(60, 40), both = new WaterSurface(60, 40);
  first.drop(20, 18, 4, 1); second.drop(42, 24, 3, .8);
  both.drop(20, 18, 4, 1); both.drop(42, 24, 3, .8);
  for (let step = 0; step < 12; step++) { first.step(0); second.step(0); both.step(0); }
  let deviation = 0;
  for (let index = 0; index < both.current.length; index++) deviation = Math.max(deviation, Math.abs(both.current[index] - first.current[index] - second.current[index]));
  assert.ok(deviation < 1e-4, `waves superpose (max deviation ${deviation})`);
  // Reflective edges: without damping a closed surface keeps its energy, so the
  // waves bounce back instead of leaking out of the frame.
  const energy = surface => { let total = 0; for (let index = 0; index < surface.current.length; index++) total += surface.current[index] ** 2; return total; };
  const peak = surface => { let value = 0; for (let index = 0; index < surface.current.length; index++) value = Math.max(value, Math.abs(surface.current[index])); return value; };
  const sealed = new WaterSurface(40, 24);
  sealed.drop(10, 12, 3, 1);
  for (let step = 0; step < 60; step++) sealed.step(0);
  const settled = energy(sealed);
  for (let step = 60; step < 2000; step++) sealed.step(0);
  assert.ok(energy(sealed) > settled * .4, `reflected waves keep their energy (${(energy(sealed) / settled).toFixed(2)} of the settled level)`);
  assert.ok(peak(sealed) > .2 && peak(sealed) < 3, `the bouncing surface stays bounded (peak ${peak(sealed).toFixed(2)})`);
  // Damping makes the surface slowly disappear and report itself quiet.
  const fading = new WaterSurface(40, 24);
  fading.drop(20, 12, 3, 1);
  assert.equal(fading.silent(), false, 'a fresh droplet is active');
  for (let step = 0; step < 600; step++) fading.step(1 / 12);
  assert.equal(fading.silent(), true, 'the surface goes quiet when nothing is dropped');
  assert.ok(fading.energy < .01, `quiet surface energy is small (${fading.energy.toExponential(1)})`);
});

test('busy activity rains ripples while idle adds none and lets them fade', () => {
  const f = fixture(), reference = fixture();
  // A deterministic but varied droplet stream, so the ripples spread out.
  let seed = 7;
  const random = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const controller = startBackdrop(f.canvas, { random });
  controller.setActivity('thinking');
  f.advance(2000);
  drawBackdrop(reference.canvas, (f.frames.length - 1) / 12);
  const base = reference.frames.at(-1);
  const ripple = changedCells(f.frames.at(-1), base) / (base.width * base.height);
  assert.ok(ripple > .015, `busy frames carry visible ripples (${(ripple * 100).toFixed(1)}% of cells)`);
  // Stopping adds nothing new: after enough time the water has disappeared and
  // the frame is exactly the plain pattern again.
  controller.setActivity('idle');
  for (let second = 0; second < 60; second++) f.advance(1000);
  drawBackdrop(reference.canvas, (f.frames.length - 1) / 12);
  assert.deepEqual(f.frames.at(-1), reference.frames.at(-1), 'waves disappear when generation stops');
  controller.destroy(); assertDisposed(f);
});

test('idle keeps its original shimmer in place', () => {
  const f = fixture();
  const frameAt = time => { drawBackdrop(f.canvas, time); return f.frames.at(-1); };
  const shimmer = changedCells(frameAt(40), frameAt(40 + 1 / 12)) / (f.canvas.width * f.canvas.height);
  assert.ok(shimmer > 0 && shimmer < .02, `idle shimmers in place (${(shimmer * 100).toFixed(2)}%)`);
  assert.ok(Math.abs(frameAt(40).cells.size - frameAt(43).cells.size) < 40, 'idle does not drift away');
});

test('activity transitions coalesce, normalize invalid modes and never schedule extra work', () => {
  const f = fixture(), reference = fixture(), controller = startBackdrop(f.canvas, { random: () => .5 });
  let ticks = 0;
  for (const mode of ['idle', 'bogus', 'tool', 'idle']) {
    const count = f.frames.length;
    for (let i = 0; i < 20; i++) controller.setActivity(mode);
    assert.equal(f.frames.length, count);
    assert.equal(f.timers.size, 1);
    f.advance(1000 / 12);
    ticks++;
    drawBackdrop(reference.canvas, ticks / 12);
    assert.deepEqual(f.frames.at(-1), reference.frames.at(-1), `${mode} keeps the plain pattern`);
  }
  const count = f.frames.length;
  for (let i = 0; i < 20; i++) controller.setActivity(i % 2 ? 'thinking' : 'output');
  assert.equal(f.frames.length, count, 'activity changes never draw outside the cadence');
  assert.equal(f.timers.size, 1, 'activity changes never schedule a second loop');
  f.advance(1000); ticks += 12;
  drawBackdrop(reference.canvas, ticks / 12);
  assert.notDeepEqual(f.frames.at(-1).cells, reference.frames.at(-1).cells, 'busy activity rains water');
  assert.equal(f.maxTimers, 1);
  controller.destroy(); controller.setActivity('thinking');
  assertDisposed(f);
});

for (const stop of ['manual', 'hidden', 'reduced']) {
  test(`activity cannot override ${stop} suspension or advance paused time`, () => {
    const f = fixture(), reference = fixture(), controller = startBackdrop(f.canvas);
    if (stop === 'manual') controller.setPaused(true);
    if (stop === 'hidden') f.visibility(true);
    if (stop === 'reduced') f.reduction(true);
    const count = f.frames.length;
    for (let i = 0; i < 30; i++) {
      controller.setActivity(i % 2 ? 'thinking' : 'output');
      f.advance(100);
    }
    assert.equal(f.frames.length, count);
    assert.equal(f.timers.size, 0);
    controller.setActivity('idle');
    if (stop === 'manual') controller.setPaused(false);
    if (stop === 'hidden') f.visibility(false);
    if (stop === 'reduced') f.reduction(false);
    f.advance(100);
    drawBackdrop(reference.canvas, 1 / 12);
    assert.deepEqual(f.frames.at(-1), reference.frames[0]);
    assert.equal(f.maxTimers, 1);
    controller.destroy(); assertDisposed(f);
  });
}
