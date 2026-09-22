import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { drawBackdrop, flowOffset, startBackdrop } from '../desktop/public/backdrop.js';

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
    for (const mode of ['idle', 'thinking', 'output']) drawBackdrop(f.canvas, 12, mode);
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
    for (const mode of [undefined, 'idle', 'invalid', null, {}, 'tool']) {
      drawBackdrop(f.canvas, time, mode);
      assert.equal(createHash('sha256').update([...f.frames.at(-1).cells].join('|')).digest('hex'), expected);
    }
  }
});

// Ink margins along one axis: a coarse profile for measuring how far the
// flowing field drifted between two frames. Positive means the pattern moved
// toward smaller coordinates along that axis.
function axisProfile(frame, axis) {
  const counts = new Map();
  for (const cell of frame.cells) {
    const value = Number(cell.split(',')[axis]);
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return { counts, length: axis === 0 ? frame.width : frame.height };
}
function bestTravel(before, after, axis, limit = 8) {
  const a = axisProfile(before, axis), b = axisProfile(after, axis);
  let best = 0, bestScore = Infinity;
  for (let shift = -limit; shift <= limit; shift++) {
    let score = 0;
    for (let index = 0; index < a.length; index++) {
      const next = b.counts.get(index), previous = a.counts.get(index + shift);
      if (next || previous) score += Math.abs((next ?? 0) - (previous ?? 0));
    }
    if (score < bestScore) { bestScore = score; best = shift; }
  }
  return best;
}
function changedCells(before, after) {
  let changed = 0;
  for (const cell of before.cells) if (!after.cells.has(cell)) changed++;
  for (const cell of after.cells) if (!before.cells.has(cell)) changed++;
  return changed;
}

test('activity patterns are deterministic and spatially distinct in the same palette', () => {
  const f = fixture(), snapshots = [];
  for (const mode of ['idle', 'thinking', 'output']) {
    drawBackdrop(f.canvas, 12, mode);
    const first = f.frames.at(-1);
    snapshots.push(first);
    drawBackdrop(f.canvas, 12, mode);
    assert.deepEqual(f.frames.at(-1), first);
    drawBackdrop(f.canvas, 12 + 1 / 12, mode);
    const next = f.frames.at(-1);
    assert.notDeepEqual(next.cells, first.cells);
    assert.equal(next.color, '#20201f');
  }
  for (let i = 0; i < snapshots.length; i++) for (let j = i + 1; j < snapshots.length; j++) {
    const changed = [...snapshots[i].cells].filter(cell => !snapshots[j].cells.has(cell)).length;
    assert.ok(changed > 100, 'modes have measurably different spatial patterns');
  }
});

test('idle shimmers in place while busy fields drift smoothly with small per-frame changes', () => {
  const f = fixture();
  const frameAt = (time, mode) => { drawBackdrop(f.canvas, time, mode); return f.frames.at(-1); };
  const changedFraction = (before, after) => changedCells(before, after) / (before.width * before.height);
  // The stopped field keeps its original slow shimmer and never drifts.
  const idleMoved = changedFraction(frameAt(40, 'idle'), frameAt(40 + 1 / 12, 'idle'));
  assert.ok(idleMoved < .02, 'idle only shimmers in place');
  assert.equal(bestTravel(frameAt(0, 'idle'), frameAt(3, 'idle'), 1), 0, 'idle does not drift');
  // Busy fields flow gently: each frame changes only a small part of the
  // dither, clearly more than idle, but nothing like a whole-band jump.
  for (const mode of ['thinking', 'output']) {
    const moved = changedFraction(frameAt(7, mode), frameAt(7 + 1 / 12, mode));
    assert.ok(moved > idleMoved * 3 && moved < .05, `${mode} flows with small per-frame changes (${(moved * 100).toFixed(1)}%)`);
    for (const axis of [0, 1]) assert.ok(Math.abs(bestTravel(frameAt(7, mode), frameAt(7 + 1 / 12, mode), axis)) <= 1, `${mode} never jumps in one frame`);
    // A whole-cell crossing must not re-dither the field.
    let largest = 0;
    for (let step = 0; step < 24; step++) largest = Math.max(largest, changedFraction(frameAt(step / 12, mode), frameAt((step + 1) / 12, mode)));
    assert.ok(largest < .05, `${mode} has no re-dither pop (largest ${(largest * 100).toFixed(1)}%)`);
  }
  // Over several seconds the drift path keeps moving: output rises, thinking
  // wanders on both axes, and both stay inside a bounded canvas-relative path.
  const drift = (mode, time) => flowOffset(mode, time, f.canvas.width, f.canvas.height);
  const rise = drift('output', 3).y - drift('output', 0).y;
  assert.ok(rise >= 2, `output drifts upward (${rise.toFixed(2)} cells over 3s)`);
  const wander = drift('thinking', 0), later = drift('thinking', 1.5);
  assert.ok(Math.hypot(later.x - wander.x, later.y - wander.y) >= 1, 'thinking drifts sideways');
  assert.equal(drift('idle', 5), null, 'idle has no drift offset');
  for (const mode of ['thinking', 'output']) {
    let largest = 0, reach = 0;
    for (let step = 0; step <= 2400; step++) {
      const current = drift(mode, step / 12);
      const previous = drift(mode, (step - 1) / 12);
      if (step) largest = Math.max(largest, Math.hypot(current.x - previous.x, current.y - previous.y));
      reach = Math.max(reach, Math.hypot(current.x, current.y));
    }
    assert.ok(largest <= .3, `${mode} moves a little each frame (${largest.toFixed(2)} cells)`);
    assert.ok(reach <= Math.max(f.canvas.width, f.canvas.height) * .55, `${mode} drift stays bounded (${reach.toFixed(1)} cells)`);
  }
  // The drift path is bounded, so the pattern always stays on canvas.
  const area = f.canvas.width * f.canvas.height;
  for (const time of [0, 40, 90, 180, 400]) for (const mode of ['thinking', 'output']) {
    const frame = frameAt(time, mode);
    assert.ok(frame.cells.size > 200 && frame.cells.size < area, `${mode} stays on canvas at ${time}s`);
  }
});

test('activity transitions coalesce, normalize invalid modes and never schedule extra work', () => {
  const f = fixture(), reference = fixture(), controller = startBackdrop(f.canvas);
  let ticks = 0;
  for (const mode of ['thinking', 'output', 'idle', 'bogus', 'output']) {
    const count = f.frames.length;
    for (let i = 0; i < 20; i++) controller.setActivity(mode);
    assert.equal(f.frames.length, count);
    assert.equal(f.timers.size, 1);
    f.advance(1000 / 12);
    ticks++;
    drawBackdrop(reference.canvas, ticks / 12, mode);
    assert.deepEqual(f.frames.at(-1), reference.frames.at(-1));
  }
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
    controller.setActivity('output');
    if (stop === 'manual') controller.setPaused(false);
    if (stop === 'hidden') f.visibility(false);
    if (stop === 'reduced') f.reduction(false);
    f.advance(100);
    drawBackdrop(reference.canvas, 1 / 12, 'output');
    assert.deepEqual(f.frames.at(-1), reference.frames[0]);
    assert.equal(f.maxTimers, 1);
    controller.destroy(); assertDisposed(f);
  });
}
