// Laptop-motion physics for the photo point cloud.
//
// The native host (macos/PiDither.swift) injects `window.__piDitherMotionHost` and
// delivers accelerometer samples in g; this module turns them into a sway the
// cloud leans with (a bubble level), an inertial lag when the machine is pushed,
// and a shake impulse that bursts the cloud outward. Everything here is pure or
// injectable — storage, document and the sample source are all optional — so the
// maths can be tested without a browser or a sensor.
export const MOTION_KEY = 'pi-desktop:motion:v1';
export const MOTION_MODES = { off: 0, tilt: 1, full: 2 };
export const MOTION_CHOICES = [['off', 'Off'], ['tilt', 'Tilt (lean)'], ['full', 'Full (lean + shake)']];
export const MOTION_HOST_KEY = '__piDitherMotionHost';
// px of cloud lean per g of gravity change; tipping the machine 20 degrees moves
// the gravity vector by about 0.34 g, so a lean is tens of pixels.
export const MOTION_SWING = 120;
// Spring for the lean and the inertial lag (1/s² and 1/s). Underdamped on
// purpose: the cloud overshoots a little and settles with a visible wobble.
export const MOTION_SWING_STIFFNESS = 26;
export const MOTION_SWING_DAMPING = 7;
// px of lag per g of linear acceleration: pushing the machine sideways swings the
// cloud the other way, exactly like mass left behind. The plan's initial value (9)
// was far too small to see; 90 px/g makes a brisk 0.3 g push a ~27 px swing.
export const MOTION_LAG = 90;
// Peak radial speed in px/s at a full shake. The impulse decays over ~0.4 s, so a
// full shake throws every point about MOTION_SHAKE / MOTION_SHAKE_DECAY px out.
export const MOTION_SHAKE = 34;
// Lowered from .18 g after the motion feel review: gentle bumps now start a
// visible burst instead of having to hit the machine noticeably.
export const MOTION_SHAKE_THRESHOLD = .12;
export const MOTION_SHAKE_DECAY = 2.4;
// Linear acceleration in g that means a full shake, on top of the threshold.
export const MOTION_SHAKE_FULL = .9;
export const MOTION_GRAVITY_ALPHA = .12;
export const MOTION_LINEAR_ALPHA = .3;
// Gyroscope (deg/s): a sharp angular jolt adds to the shake in full mode.
// There is deliberately no gyro-driven cloud rotation: the twist cost a full
// per-point target rotation on every frame and was removed after the motion
// performance review.
export const MOTION_GYRO_ALPHA = .3;
// Lowered from 22 deg/s for the same reason: a light twist starts the shake.
export const MOTION_GYRO_SHAKE_THRESHOLD = 14;
export const MOTION_GYRO_SHAKE_FULL = 260;
// A sway below these is treated as still, so the render loop can park.
export const MOTION_SETTLE = .05;
// Device axes -> screen axes, the one place a sensor orientation can be corrected.
// Assumed native report: x to the right, y toward the front edge (the user), z
// leaving the keyboard (up when the machine lies flat), in g. The cloud leans
// toward the lower side and lags opposite to the acceleration; flipping a sign
// here is all it takes if a sensor reports its axes differently.
export const MOTION_AXES = { right: ['x', 1], front: ['y', 1] };

// Contract C1 status values only: a host must not be able to inject arbitrary
// text (or claim 'available' by leaving the field out) into the status line.
export function motionStatus(value) {
  const text = String(value ?? '').trim().toLowerCase();
  return text === 'available' || text === 'denied' ? text : 'unavailable';
}

export function motionMode(value) {
  const mode = String(value ?? '').trim().toLowerCase();
  return Object.hasOwn(MOTION_MODES, mode) ? mode : 'off';
}

export function readMotion(storage) {
  try { return motionMode(storage?.getItem(MOTION_KEY)); } catch { return 'off'; }
}

export function writeMotion(storage, value) {
  const mode = motionMode(value);
  try { storage?.setItem(MOTION_KEY, mode); } catch { /* Optional storage. */ }
  return mode;
}

export function sampleMagnitude(sample) {
  return Math.hypot(Number(sample?.x) || 0, Number(sample?.y) || 0, Number(sample?.z) || 0);
}

// Low-passed unit vector of the measured acceleration (up at rest), plus the raw
// magnitude so callers can spot a spike.
export function gravityDirection(sample, previous, alpha = MOTION_GRAVITY_ALPHA) {
  const rawMagnitude = sampleMagnitude(sample) || 1;
  const weight = Math.min(1, Math.max(0, Number(alpha)));
  const raw = { x: (Number(sample?.x) || 0) / rawMagnitude, y: (Number(sample?.y) || 0) / rawMagnitude, z: (Number(sample?.z) || 0) / rawMagnitude };
  const blended = previous
    ? { x: previous.x + (raw.x - previous.x) * weight, y: previous.y + (raw.y - previous.y) * weight, z: previous.z + (raw.z - previous.z) * weight }
    : raw;
  const length = Math.hypot(blended.x, blended.y, blended.z) || 1;
  // The magnitude is low-passed too, so a spike (or a drop, in free fall) leaves a
  // residual once the direction is subtracted.
  const magnitude = previous && Number.isFinite(previous.magnitude)
    ? previous.magnitude + (rawMagnitude - previous.magnitude) * weight
    : rawMagnitude;
  return { x: blended.x / length, y: blended.y / length, z: blended.z / length, magnitude };
}

// Cloud space is screen right and screen up (the point cloud's own frame), so a
// lean toward the lower front edge tips the cloud toward the bottom of the screen.
export function cloudAxes(right, front) {
  return { x: right, y: -front };
}

function pick(sample, [name, sign]) {
  return sign * (Number(sample?.[name]) || 0);
}

// One sample -> sway targets in cloud pixels and a 0..1 shake level. `state`
// carries the previous gravity, linear acceleration and baseline so the filters
// stay continuous; the returned fields are also written back by the caller.
export function motionInput(sample, state = {}) {
  const gravity = gravityDirection(sample, state.gravity);
  const raw = { x: Number(sample?.x) || 0, y: Number(sample?.y) || 0, z: Number(sample?.z) || 0 };
  // What is left after gravity is the machine's own acceleration; low-passed so a
  // single noisy report cannot throw the cloud around.
  const linear = {
    x: raw.x - gravity.x * gravity.magnitude,
    y: raw.y - gravity.y * gravity.magnitude,
    z: raw.z - gravity.z * gravity.magnitude,
  };
  const weight = Math.min(1, Math.max(0, MOTION_LINEAR_ALPHA));
  const smoothed = state.linear
    ? { x: state.linear.x + (linear.x - state.linear.x) * weight, y: state.linear.y + (linear.y - state.linear.y) * weight, z: state.linear.z + (linear.z - state.linear.z) * weight }
    : linear;
  // Gravity points down; the cloud leans that way. The baseline is the resting
  // orientation captured by rezero(), so enabling motion never jumps.
  const down = { x: -gravity.x, y: -gravity.y, z: -gravity.z };
  // The baseline is a measured acceleration (up at rest), so flip it into the same
  // frame as `down` before differencing.
  const baseline = state.baseline ? { x: -state.baseline.x, y: -state.baseline.y, z: -state.baseline.z } : down;
  const delta = { x: down.x - baseline.x, y: down.y - baseline.y, z: down.z - baseline.z };
  const tilt = cloudAxes(pick(delta, MOTION_AXES.right) * MOTION_SWING, pick(delta, MOTION_AXES.front) * MOTION_SWING);
  const lag = cloudAxes(-pick(smoothed, MOTION_AXES.right) * MOTION_LAG, -pick(smoothed, MOTION_AXES.front) * MOTION_LAG);
  // Gyro samples are optional: the native host adds gx/gy/gz (deg/s) when the
  // gyroscope opened. They add an angular shake term only.
  const gx = Number(sample?.gx), gy = Number(sample?.gy), gz = Number(sample?.gz);
  const hasGyro = [gx, gy, gz].some(Number.isFinite);
  const rawGyro = { x: Number.isFinite(gx) ? gx : 0, y: Number.isFinite(gy) ? gy : 0, z: Number.isFinite(gz) ? gz : 0 };
  let gyro = state.gyro ?? null;
  if (hasGyro) {
    const weightGyro = Math.min(1, Math.max(0, MOTION_GYRO_ALPHA));
    gyro = gyro ? { x: gyro.x + (rawGyro.x - gyro.x) * weightGyro, y: gyro.y + (rawGyro.y - gyro.y) * weightGyro, z: gyro.z + (rawGyro.z - gyro.z) * weightGyro } : rawGyro;
  }
  // A shake is read from the *unsmoothed* residual, so a knock is never delayed by
  // the lag filter; the host's own peak catches spikes between deliveries. A
  // sharp angular jolt contributes too, so an angular knock also bursts the cloud.
  const magnitude = Math.max(Math.hypot(linear.x, linear.y, linear.z), Math.abs(Number(sample?.peak) || 0));
  const span = Math.max(.01, MOTION_SHAKE_FULL - MOTION_SHAKE_THRESHOLD);
  const linearShake = magnitude <= MOTION_SHAKE_THRESHOLD ? 0 : Math.min(1, (magnitude - MOTION_SHAKE_THRESHOLD) / span);
  const angular = gyro ? Math.hypot(gyro.x, gyro.y, gyro.z) : 0;
  const angularSpan = Math.max(.01, MOTION_GYRO_SHAKE_FULL - MOTION_GYRO_SHAKE_THRESHOLD);
  const angularShake = angular <= MOTION_GYRO_SHAKE_THRESHOLD ? 0 : Math.min(1, (angular - MOTION_GYRO_SHAKE_THRESHOLD) / angularSpan);
  const shake = Math.max(linearShake, angularShake);
  return { tiltX: tilt.x, tiltY: tilt.y, lagX: lag.x, lagY: lag.y, shake, gravity, linear: smoothed, gyro, magnitude };
}

// Where the spring is being pulled: the lean plus the lag, in cloud pixels.
export function swayTarget(input = {}) {
  return {
    x: (Number(input?.tiltX) || 0) + (Number(input?.lagX) || 0),
    y: (Number(input?.tiltY) || 0) + (Number(input?.lagY) || 0),
  };
}

// A damped spring toward that target. Time-stepped so 60 and 120 Hz behave the
// same, and it always pulls back to rest when a target ends.
export function stepSway(state, input = {}, { seconds = 1 / 60 } = {}) {
  const dt = Math.min(.05, Math.max(0, Number(seconds) || 0));
  if (!state || dt <= 0) return state;
  const target = swayTarget(input);
  const ax = MOTION_SWING_STIFFNESS * (target.x - state.x) - MOTION_SWING_DAMPING * state.vx;
  const ay = MOTION_SWING_STIFFNESS * (target.y - state.y) - MOTION_SWING_DAMPING * state.vy;
  state.vx += ax * dt; state.vy += ay * dt;
  state.x += state.vx * dt; state.y += state.vy * dt;
  return state;
}

// Still means settled on the target, not zero: a machine held at a constant angle
// keeps a steady lean, and that must park the render loop instead of running it
// forever.
export function swayMoving(state, input = {}) {
  const target = swayTarget(input);
  return Math.abs(state.x - target.x) > MOTION_SETTLE || Math.abs(state.y - target.y) > MOTION_SETTLE
    || Math.abs(state.vx) > MOTION_SETTLE || Math.abs(state.vy) > MOTION_SETTLE;
}

// The live sway and shake the render loop feeds into stepPhotoCloud. With the mode
// off, `sway.x`/`sway.y`/`shake` are exactly 0 and the cloud maths is untouched.
export function createMotion({ provider, storage, document: doc = globalThis.document, onSample } = {}) {
  const view = () => doc?.defaultView ?? globalThis;
  let mode = readMotion(storage);
  let source = 'none', status = 'none';
  let release = null, webHandler = null, rateWindow = null;
  const state = { x: 0, y: 0, vx: 0, vy: 0, shake: 0, gravity: null, linear: null, gyro: null, baseline: null, input: null, lastAt: 0, count: 0, rate: 0 };

  function hostProvider() {
    if (provider && typeof provider.subscribe === 'function') return provider;
    const injected = view()?.[MOTION_HOST_KEY];
    return injected && typeof injected.subscribe === 'function' ? injected : null;
  }

  function discover() {
    const host = hostProvider();
    if (host) return { source: 'native', status: motionStatus(host.status), subscribe: (handler) => host.subscribe(handler) };
    const target = view();
    if (target && typeof target.DeviceMotionEvent === 'function' && typeof target.addEventListener === 'function') {
      // The constructor existing is not a sensor: features.js labels this source
      // BROWSER EVENTS and shows WAITING until a sample actually arrives.
      return { source: 'web', status: 'available', subscribe: null };
    }
    return { source: 'none', status: 'none', subscribe: null };
  }

  function disconnect() {
    if (typeof release === 'function') { try { release(); } catch { /* Already gone. */ } }
    release = null;
    if (webHandler) { view()?.removeEventListener?.('devicemotion', webHandler); webHandler = null; }
  }

  // Discovery runs at construction and again whenever the mode is switched on, so
  // a host injected late (or an app that starts before the sensor) still connects.
  function connect() {
    disconnect();
    const found = discover();
    source = found.source; status = found.status;
    if (found.subscribe) {
      try {
        const handle = found.subscribe((sample) => receive(sample));
        release = typeof handle === 'function' ? handle : () => hostProvider()?.unsubscribe?.(handle);
      } catch { source = 'none'; status = 'unavailable'; release = null; }
    } else if (source === 'web') {
      webHandler = (event) => {
        const acceleration = event?.accelerationIncludingGravity;
        if (!acceleration) return;
        receive({ x: (Number(acceleration.x) || 0) / 9.80665, y: (Number(acceleration.y) || 0) / 9.80665, z: (Number(acceleration.z) || 0) / 9.80665, at: Date.now() });
      };
      view()?.addEventListener?.('devicemotion', webHandler, { passive: true });
    }
    return source;
  }

  function receive(sample) {
    // A zero vector is not an orientation: browsers may fire a devicemotion event
    // with everything at zero, and normalising that would invent a direction.
    if (sampleMagnitude(sample) < 1e-3) return null;
    const at = Number.isFinite(Number(sample?.at)) ? Number(sample.at) : Date.now();
    const input = motionInput(sample, state);
    state.gravity = input.gravity;
    state.linear = input.linear;
    state.gyro = input.gyro;
    state.input = input;
    state.last = sample;
    // The first sample after enabling becomes level, so switching motion on never
    // tips the cloud; rezero() re-pins it later on demand.
    if (mode !== 'off' && !state.baseline && state.gravity) state.baseline = { x: state.gravity.x, y: state.gravity.y, z: state.gravity.z };
    // Only full mode bursts: tilt mode is a pure lean, and off never reacts.
    state.shake = mode === 'full' ? Math.max(state.shake, input.shake) : 0;
    state.lastAt = at;
    state.count += 1;
    if (!rateWindow) rateWindow = { at, count: 0 };
    else rateWindow.count += 1;
    const elapsed = (at - rateWindow.at) / 1000;
    if (elapsed >= 1) {
      state.rate = Math.round(rateWindow.count / elapsed);
      rateWindow = { at, count: 0 };
    }
    onSample?.(input);
    return input;
  }

  function setMode(value) {
    const next = writeMotion(storage, value);
    const enabling = mode === 'off' && next !== 'off';
    mode = next;
    // Re-discover on every switch-on: a host injected after the app started (or a
    // machine whose sensor appears later) must win over the browser fallback.
    if (enabling) connect();
    if (mode === 'off') { state.input = null; state.shake = 0; state.x = 0; state.y = 0; state.vx = 0; state.vy = 0; }
    else if (enabling) rezero();
    return mode;
  }

  // Capture the current resting orientation as level. Without a sample yet the
  // first one becomes the baseline, so enabling never tips the cloud.
  function rezero() {
    state.baseline = state.gravity ? { x: state.gravity.x, y: state.gravity.y, z: state.gravity.z } : null;
    // Re-derive the target from the last sample: the frame the machine is in right
    // now must read level, not the one it was in when the sample arrived. Without
    // this a parked loop would hold the old lean forever.
    if (state.last) {
      state.input = motionInput(state.last, state);
      state.shake = 0;
    }
    return state.baseline;
  }

  // One physics step: decay the shake, advance the spring, publish sway. Returns
  // true while anything is still moving, so the render loop keeps running.
  function step(seconds) {
    const dt = Math.min(.05, Math.max(0, Number(seconds) || 0));
    const active = mode !== 'off';
    if (state.shake > 0) {
      const decay = MOTION_SHAKE_DECAY * dt;
      state.shake = state.shake > decay ? state.shake - decay : 0;
    }
    const input = active && state.input
      ? (mode === 'tilt' ? { tiltX: state.input.tiltX, tiltY: state.input.tiltY, lagX: 0, lagY: 0 } : state.input)
      : { tiltX: 0, tiltY: 0, lagX: 0, lagY: 0 };
    stepSway(state, input, { seconds: dt });
    sway.x = state.x; sway.y = state.y;
    return swayMoving(state, input) || state.shake > 0;
  }

  const sway = { x: 0, y: 0 };
  connect();

  return {
    get mode() { return mode; },
    get status() { return status; },
    get source() { return source; },
    get rate() { return state.rate; },
    get count() { return state.count; },
    get shake() { return state.shake; },
    get sway() { return sway; },
    get state() { return state; },
    setMode, rezero, connect, step, sample: receive,
    destroy() { disconnect(); state.input = null; state.shake = 0; },
  };
}
