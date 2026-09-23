import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MOTION_AXES, MOTION_CHOICES, MOTION_HOST_KEY, MOTION_KEY, MOTION_LAG, MOTION_MODES, MOTION_SHAKE, MOTION_SHAKE_DECAY, MOTION_SHAKE_THRESHOLD,
  MOTION_SWING, cloudAxes, createMotion, gravityDirection, motionInput, motionMode, motionStatus, readMotion, sampleMagnitude, stepSway, swayMoving, writeMotion,
} from '../desktop/public/motion.js';

const store = (initial = {}) => {
  const map = new Map(Object.entries(initial));
  return { getItem: (key) => map.get(key) ?? null, setItem: (key, value) => map.set(key, String(value)), map };
};

function fakeView(extra = {}) {
  const listeners = new Map();
  return {
    performance: { now: () => Date.now() },
    addEventListener: (type, handler) => listeners.set(type, handler),
    removeEventListener: (type) => listeners.delete(type),
    listeners,
    ...extra,
  };
}

// A host stub shaped exactly like contract C1.
function fakeHost({ status = 'available' } = {}) {
  const subscribers = new Set();
  return {
    version: 1, status, latest: null, peak: 0, subscribers,
    subscribe(callback) { subscribers.add(callback); return () => subscribers.delete(callback); },
    deliver(sample) { this.latest = sample; for (const callback of [...subscribers]) callback(sample); },
  };
}

// Deliver a sample the way createMotion.receive does: the filters keep their state,
// so a stream of tilted samples converges on the real tilt.
function feed(state, sample, times = 60) {
  let input = null;
  for (let index = 0; index < times; index++) {
    input = motionInput({ ...sample, at: (Number(sample.at) || 0) + index * 16 }, state);
    state.gravity = input.gravity;
    state.linear = input.linear;
  }
  return input;
}

// A resting machine with the screen up: the accelerometer reads +1 g on z.
const rest = { x: 0, y: 0, z: 1, at: 0 };
// Tilting the right side down by 20 degrees. The sensor reads the world up in
// device axes, so the right-hand tilt shows up as -sin(20) on x.
const tiltRight = { x: -Math.sin(Math.PI / 9), y: 0, z: Math.cos(Math.PI / 9), at: 16 };

test('motion modes normalize and persist', () => {
  assert.deepEqual(Object.keys(MOTION_MODES), ['off', 'tilt', 'full']);
  assert.deepEqual(MOTION_CHOICES.map(([value]) => value), ['off', 'tilt', 'full']);
  assert.equal(motionMode(' FULL '), 'full');
  assert.equal(motionMode('tilt'), 'tilt');
  assert.equal(motionMode('sideways'), 'off');
  assert.equal(motionMode(null), 'off');
  assert.equal(motionMode(3), 'off');
  const storage = store();
  assert.equal(readMotion(storage), 'off', 'off by default');
  assert.equal(writeMotion(storage, 'full'), 'full');
  assert.equal(storage.map.get(MOTION_KEY), 'full');
  assert.equal(readMotion(storage), 'full');
  assert.equal(writeMotion(storage, 'nonsense'), 'off', 'a bad value falls back to off');
  assert.equal(readMotion({ getItem() { throw new Error('denied'); } }), 'off');
  assert.equal(writeMotion({ setItem() { throw new Error('denied'); } }, 'tilt'), 'tilt', 'storage failure is not fatal');
  // A host may only report the three contract statuses: anything else is clamped
  // so it cannot inject text, and a missing status is never read as available.
  assert.equal(motionStatus('available'), 'available');
  assert.equal(motionStatus('DENIED'), 'denied');
  assert.equal(motionStatus('unavailable'), 'unavailable');
  assert.equal(motionStatus(undefined), 'unavailable');
  assert.equal(motionStatus('<b>live</b>'), 'unavailable');
});

test('gravity is a low-passed unit vector with the raw magnitude kept', () => {
  assert.equal(Math.round(sampleMagnitude({ x: 3, y: 4, z: 12 }) * 100) / 100, 13);
  assert.equal(Math.round(sampleMagnitude(null) * 100) / 100, 0);
  const first = gravityDirection({ x: 0, y: 0, z: 9.81 });
  assert.deepEqual([first.x, first.y, first.z].map((v) => +v.toFixed(6)), [0, 0, 1], 'scale free: a huge magnitude still normalizes');
  assert.equal(+first.magnitude.toFixed(2), 9.81, 'and the magnitude is reported');
  const halfway = gravityDirection({ x: 0, y: 1, z: 0 }, first, .5);
  assert.deepEqual([halfway.x, halfway.y, halfway.z].map((v) => +v.toFixed(3)), [0, .707, .707], 'a step change is filtered, not snapped');
  const settled = gravityDirection({ x: 0, y: 1, z: 0 }, halfway, 1);
  assert.deepEqual([settled.x, settled.y, settled.z].map((v) => +v.toFixed(6)), [0, 1, 0], 'weight 1 follows exactly');
});

test('a tilt becomes a lean in cloud pixels and a push becomes an opposite lag', () => {
  const baseline = gravityDirection(rest);
  const state = { gravity: baseline, baseline };
  const level = motionInput(rest, state);
  assert.ok(Math.abs(level.tiltX) < 1e-9 && Math.abs(level.tiltY) < 1e-9, 'a resting machine is level');
  assert.equal(level.shake, 0, 'and still');
  assert.equal(+level.gravity.z.toFixed(6), 1);

  const tilted = feed(state, tiltRight);
  assert.ok(tilted.tiltX > 30 && tilted.tiltX < 50, `20 degrees leans the cloud right by tens of pixels (${tilted.tiltX.toFixed(1)})`);
  assert.ok(Math.abs(tilted.tiltY) < 1e-9, 'and not sideways');
  assert.equal(+tilted.tiltX.toFixed(1), +(Math.sin(Math.PI / 9) * MOTION_SWING).toFixed(1), 'the lean is MOTION_SWING per g of gravity change');

  // A rightward push: the machine accelerates right, the cloud is left behind.
  // A push is a transient: within a few samples the gravity filter absorbs it (a
  // steady acceleration is indistinguishable from a tilt), so the peak lag is what
  // the cloud swings on.
  const pushed = feed({ gravity: baseline, baseline, linear: { x: 0, y: 0, z: 0 } }, { x: .5, y: 0, z: 1, at: 32 }, 1);
  assert.ok(pushed.lagX < -10, `the cloud lags opposite the acceleration (${pushed.lagX.toFixed(1)})`);
  assert.ok(pushed.lagX > -(.5 * MOTION_LAG) && pushed.lagX < -10, `the lag is the smoothed acceleration times MOTION_LAG (${pushed.lagX.toFixed(1)} of at most ${-(.5 * MOTION_LAG)})`);
  assert.ok(Math.abs(pushed.tiltX) < 25, 'a straight push barely tips it yet');
  const later = feed({ gravity: baseline, baseline, linear: { x: 0, y: 0, z: 0 } }, { x: .5, y: 0, z: 1, at: 48 }, 30);
  // A sustained acceleration and a tilt are the same thing to an accelerometer, so
  // the push ends up read as a lean: the device's left side is the lower one.
  assert.ok(later.tiltX < -20, `a sustained push settles into a lean (${later.tiltX.toFixed(1)})`);

  // A spike: the unsmoothed linear magnitude drives the shake, so a real knock is
  // never delayed by the lag filter.
  const knock = motionInput({ x: 0, y: 0, z: 1 + MOTION_SHAKE_THRESHOLD + .4, at: 48 }, { gravity: baseline, baseline, linear: { x: 0, y: 0, z: 0 } });
  assert.ok(knock.shake > .3 && knock.shake <= 1, `a spike raises the shake level (${knock.shake.toFixed(2)})`);
  assert.equal(motionInput(rest, { gravity: baseline, baseline, linear: { x: 0, y: 0, z: 0 } }).shake, 0, 'a quiet machine never shakes');
  const peakOnly = motionInput({ ...rest, at: 64, peak: 1.4 }, { gravity: baseline, baseline, linear: { x: 0, y: 0, z: 0 } });
  assert.equal(peakOnly.shake, 1, 'the host peak is used when a spike lands between samples');
  assert.deepEqual(cloudAxes(10, 20), { x: 10, y: -20 }, 'front maps to screen down');
  assert.deepEqual(MOTION_AXES.right, ['x', 1]);
});

test('the sway spring converges to the lean, overshoots a little and returns to rest', () => {
  const state = { x: 0, y: 0, vx: 0, vy: 0 };
  for (let step = 0; step < 300; step++) stepSway(state, { tiltX: 100, lagX: -40 }, { seconds: 1 / 60 });
  assert.ok(Math.abs(state.x - 60) < .5, `the sway settles on tilt + lag (${state.x.toFixed(2)})`);
  assert.equal(swayMoving(state, { tiltX: 100, lagX: -40 }), false, 'and reports still once it is on target');
  for (let step = 0; step < 300; step++) stepSway(state, {}, { seconds: 1 / 60 });
  assert.ok(Math.abs(state.x) < .1, `it returns to rest when the lean ends (${state.x.toFixed(2)})`);
  // An impulse overshoots: that wobble is the point of the underdamped spring.
  const kicked = { x: 0, y: 0, vx: 200, vy: 0 };
  let peak = 0;
  for (let step = 0; step < 300; step++) { stepSway(kicked, {}, { seconds: 1 / 60 }); peak = Math.max(peak, Math.abs(kicked.x)); }
  assert.ok(peak > 5, `a velocity kick swings the cloud (${peak.toFixed(1)} px)`);
  assert.equal(stepSway(state, {}, { seconds: 0 }), state, 'a zero-length step is a no-op');
});

test('createMotion connects to the native host and drives the sway from live samples', () => {
  const host = fakeHost({ status: 'available' });
  const storage = store();
  const view = fakeView({ [MOTION_HOST_KEY]: host });
  const motion = createMotion({ storage, document: { defaultView: view } });
  assert.equal(motion.source, 'native');
  assert.equal(motion.status, 'available');
  assert.equal(motion.mode, 'off', 'motion is off until the user asks for it');
  assert.equal(host.subscribers.size, 1, 'the host is subscribed once');

  assert.equal(motion.setMode('full'), 'full');
  assert.equal(storage.map.get(MOTION_KEY), 'full', 'the choice persists');
  for (let index = 0; index < 60; index++) motion.sample({ ...rest, at: index * 16 });
  for (let index = 0; index < 60; index++) motion.sample({ ...tiltRight, at: 1000 + index * 16 });
  let moving = false;
  for (let step = 0; step < 240; step++) moving = motion.step(1 / 60) || moving;
  assert.ok(moving, 'the loop is asked to keep running while the cloud leans');
  assert.ok(motion.sway.x > 30, `the cloud leans toward the lower side (${motion.sway.x.toFixed(1)})`);
  assert.ok(Math.abs(motion.sway.y) < 1, 'and not the other way');

  // Re-zero makes the current position level again: the same sample now reads level.
  motion.rezero();
  for (let index = 0; index < 60; index++) motion.sample({ ...tiltRight, at: 3000 + index * 16 });
  for (let step = 0; step < 400; step++) motion.step(1 / 60);
  assert.ok(Math.abs(motion.sway.x) < .2, `re-zero removes the offset (${motion.sway.x.toFixed(2)})`);

  // A shake is delivered as an impulse that decays to nothing.
  motion.sample({ x: 0, y: 0, z: 2, at: 1000, peak: 1.2 });
  assert.ok(motion.shake > .5, `a knock raises the shake level (${motion.shake.toFixed(2)})`);
  for (let step = 0; step < 120; step++) motion.step(1 / 60);
  assert.equal(motion.shake, 0, 'and it decays away');

  motion.destroy();
  assert.equal(host.subscribers.size, 0, 'destroy unsubscribes');
});

test('motion off yields zero sway no matter what arrives', () => {
  const host = fakeHost();
  const motion = createMotion({ provider: host, storage: store(), document: { defaultView: fakeView() } });
  motion.setMode('off');
  motion.sample({ x: 2, y: -2, z: 3, at: 10, peak: 2 });
  for (let step = 0; step < 60; step++) assert.equal(motion.step(1 / 60), false, 'an off switch never asks for frames');
  assert.equal(motion.sway.x, 0, 'sway x stays exactly 0');
  assert.equal(motion.sway.y, 0, 'sway y stays exactly 0');
  assert.equal(motion.shake, 0, 'and the shake stays 0');

  // tilt mode leans but never lags or shakes
  motion.setMode('tilt');
  for (let index = 0; index < 60; index++) motion.sample({ ...rest, at: index * 16 });
  for (let index = 0; index < 60; index++) motion.sample({ x: .9, y: 0, z: 0, at: 1000 + index * 16, peak: 1.5 });
  for (let step = 0; step < 60; step++) motion.step(1 / 60);
  assert.ok(motion.sway.x < -10, `tilt mode leans (${motion.sway.x.toFixed(1)})`);
  assert.equal(motion.shake, 0, 'tilt mode never shakes');
});

test('a late host is picked up when motion is switched on, and a browser sensor works too', () => {
  // No host yet: the app must not pretend a sensor exists.
  const view = fakeView();
  const motion = createMotion({ storage: store(), document: { defaultView: view } });
  assert.equal(motion.source, 'none');
  assert.equal(motion.status, 'none');
  assert.equal(motion.setMode('full'), 'full');
  assert.equal(motion.source, 'none', 'still none until a sensor appears');

  // The host injects itself late (or the sensor appears); enabling picks it up.
  const host = fakeHost({ status: 'available' });
  view[MOTION_HOST_KEY] = host;
  assert.equal(motion.setMode('off'), 'off');
  assert.equal(motion.setMode('full'), 'full');
  assert.equal(motion.source, 'native');
  assert.equal(host.subscribers.size, 1);
  motion.destroy();

  // The web fallback converts m/s² to g and listens for devicemotion.
  const webView = fakeView({ DeviceMotionEvent: function DeviceMotionEvent() {} });
  const web = createMotion({ storage: store(), document: { defaultView: webView } });
  assert.equal(web.source, 'web');
  assert.equal(web.status, 'available');
  web.setMode('full');
  webView.listeners.get('devicemotion')({ accelerationIncludingGravity: { x: 9.80665, y: 0, z: 0 } });
  assert.equal(web.count, 1);
  assert.equal(+web.state.gravity.magnitude.toFixed(4), 1, 'g units, not m/s²');
  assert.equal(+web.state.gravity.x.toFixed(3), 1, 'and the axis is kept');
  web.destroy();
  assert.equal(webView.listeners.has('devicemotion'), false, 'destroy removes the listener');
});

test('the reported sample rate is measured, not assumed', () => {
  const motion = createMotion({ provider: fakeHost(), storage: store(), document: { defaultView: fakeView() } });
  motion.setMode('full');
  for (let index = 0; index < 61; index++) motion.sample({ ...rest, at: index * 16.667 });
  assert.equal(motion.rate, 60, `sixty samples in a second is 60 Hz (${motion.rate})`);
  assert.equal(motion.count, 61);
  assert.ok(motion.state.rate !== 0);
  assert.equal(MOTION_SHAKE_DECAY > 0 && MOTION_SHAKE > 0, true);
});
