import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { drawBackdrop, FLOW_RADIANS_PER_SECOND, startBackdrop } from '../desktop/public/backdrop.js';

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
    assert.deepEqual(f.frames.at(-1), first, 'the same inputs render the same pixels');
    assert.equal(first.color, '#20201f');
  }
  for (let i = 0; i < snapshots.length; i++) for (let j = i + 1; j < snapshots.length; j++) {
    const changed = [...snapshots[i].cells].filter(cell => !snapshots[j].cells.has(cell)).length;
    assert.ok(changed > 100, 'modes have measurably different spatial patterns');
  }
});

test('busy waves are time-invariant and travel one way through the frozen phase', () => {
  const f = fixture();
  const frameAt = (time, mode, shift = 0) => { drawBackdrop(f.canvas, time, mode, shift); return f.frames.at(-1); };
  const fraction = (before, after) => changedCells(before, after) / (before.width * before.height);
  // No vibration while generating: one phase means one set of pixels, whatever
  // the animation time is.
  for (const mode of ['thinking', 'output']) assert.deepEqual(frameAt(2, mode, 5), frameAt(37.5, mode, 5), `${mode} holds still between phase steps`);
  // The band pattern advances in one steady direction: the demodulated phase
  // at the band frequency decreases monotonically as the phase grows, and y
  // grows downward, so both busy modes travel upward.
  const demodulate = (frame, kx, ky) => {
    let re = 0, im = 0;
    for (const cell of frame.cells) {
      const [x, y] = cell.split(',').map(Number);
      const angle = kx * x + ky * y;
      re += Math.cos(angle); im += Math.sin(angle);
    }
    return Math.atan2(im, re);
  };
  const unwrap = value => { while (value > Math.PI) value -= 2 * Math.PI; while (value < -Math.PI) value += 2 * Math.PI; return value; };
  for (const [mode, kx, ky] of [['thinking', .25, .19], ['output', 0, .34]]) {
    const base = frameAt(0, mode, 0);
    const readings = [.5, 1, 1.5].map(shift => unwrap(demodulate(frameAt(0, mode, shift), kx, ky) - demodulate(base, kx, ky)));
    assert.ok(readings[0] < 0 && readings[1] < readings[0] && readings[2] < readings[1], `${mode} travels steadily in one direction (${readings.map(value => value.toFixed(2)).join(', ')})`);
    assert.ok(Math.abs(readings[2]) >= .4, `${mode} moves measurably (${Math.abs(readings[2]).toFixed(2)} rad)`);
  }
  // Adjacent phase steps change a small part of the dither and never re-dither
  // it wholesale across a cycle.
  const step = FLOW_RADIANS_PER_SECOND / 12;
  for (const mode of ['thinking', 'output']) {
    let largest = 0, smallest = 1;
    for (let i = 0; i < 24; i++) {
      const moved = fraction(frameAt(0, mode, i * step), frameAt(0, mode, (i + 1) * step));
      largest = Math.max(largest, moved); smallest = Math.min(smallest, moved);
    }
    assert.ok(smallest > 0, `${mode} keeps moving`);
    assert.ok(largest < .09, `${mode} has no re-dither pop (largest ${(largest * 100).toFixed(1)}%)`);
  }
  // Any phase keeps the pattern on canvas.
  const area = f.canvas.width * f.canvas.height;
  for (const mode of ['thinking', 'output']) for (const shift of [0, 12, 120, 1200]) {
    const frame = frameAt(0, mode, shift);
    assert.ok(frame.cells.size > 200 && frame.cells.size < area, `${mode} stays on canvas at phase ${shift}`);
  }
});

test('idle keeps its shimmer and holds the phase where generation stopped', () => {
  const f = fixture();
  const frameAt = (time, mode, shift = 0) => { drawBackdrop(f.canvas, time, mode, shift); return f.frames.at(-1); };
  const fraction = (before, after) => changedCells(before, after) / (before.width * before.height);
  // Idle still shimmers from frame to frame, exactly as before.
  const shimmer = fraction(frameAt(40, 'idle'), frameAt(40 + 1 / 12, 'idle'));
  assert.ok(shimmer > 0 && shimmer < .02, 'idle shimmers in place');
  // A frozen phase is part of the idle pixels, so stopping never snaps back.
  assert.notDeepEqual(frameAt(41, 'idle', 3.7), frameAt(41, 'idle', 0), 'idle honors the stopped phase');
  assert.ok(fraction(frameAt(41, 'idle', 3.7), frameAt(41, 'idle', 0)) > .01, 'the frozen phase is visible');
  // Idle holds its position: no travel of its own.
  assert.equal(bestTravel(frameAt(0, 'idle', 3.7), frameAt(3, 'idle', 3.7), 1), 0, 'idle holds position');
});

test('background phase advances only while busy and freezes in place when work stops', () => {
  const f = fixture(), reference = fixture(), controller = startBackdrop(f.canvas);
  const tick = FLOW_RADIANS_PER_SECOND * ((1000 / 12) / 1000);
  let shift = 0;
  controller.setActivity('thinking');
  f.advance(500);
  for (let i = 0; i < 6; i++) shift += tick;
  // Switching to idle keeps that phase and only shimmers from here on.
  controller.setActivity('idle');
  f.advance(1000);
  let ticks = 18;
  drawBackdrop(reference.canvas, ticks / 12, 'idle', shift);
  assert.deepEqual(f.frames.at(-1), reference.frames.at(-1), 'idle continues at the frozen busy phase');
  // Busy again resumes travel from that same phase.
  controller.setActivity('output');
  f.advance(250);
  for (let i = 0; i < 3; i++) shift += tick;
  ticks += 3;
  drawBackdrop(reference.canvas, ticks / 12, 'output', shift);
  assert.deepEqual(f.frames.at(-1), reference.frames.at(-1), 'resuming continues the one-way travel');
  controller.destroy(); assertDisposed(f);
});

test('activity transitions coalesce, normalize invalid modes and never schedule extra work', () => {
  const f = fixture(), reference = fixture(), controller = startBackdrop(f.canvas);
  const tick = FLOW_RADIANS_PER_SECOND * ((1000 / 12) / 1000);
  let ticks = 0, shift = 0;
  for (const mode of ['thinking', 'output', 'idle', 'bogus', 'output']) {
    const count = f.frames.length;
    for (let i = 0; i < 20; i++) controller.setActivity(mode);
    assert.equal(f.frames.length, count);
    assert.equal(f.timers.size, 1);
    f.advance(1000 / 12);
    ticks++;
    if (mode === 'thinking' || mode === 'output') shift += tick;
    drawBackdrop(reference.canvas, ticks / 12, mode, shift);
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
    drawBackdrop(reference.canvas, 1 / 12, 'output', FLOW_RADIANS_PER_SECOND * ((1000 / 12) / 1000));
    assert.deepEqual(f.frames.at(-1), reference.frames[0]);
    assert.equal(f.maxTimers, 1);
    controller.destroy(); assertDisposed(f);
  });
}
