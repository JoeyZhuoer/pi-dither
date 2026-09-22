// Optional particle layer over the background.
//
// Two behaviours share one canvas and one frame loop:
//  - free field: drifting dots linked by faint lines with elastic collisions
//    and a pointer stir (the default constellation look);
//  - photo cloud: the user's image turned into a point cloud, animated with the
//    reference site's logic — a spring back to each point's home position plus a
//    1/(1+d)² pointer force that pushes (spread) or pulls (gather), with per-point
//    colour/alpha easing.
// Physics helpers are pure (randomness is injected) so tests need no browser.
import { backgroundSize, ditherPhoto } from './background.js';

export const PARTICLES_KEY = 'pi-desktop:particles:v1';
export const PARTICLE_MODES = { off: 0, sparse: 70, normal: 130, dense: 220 };
// Photo-cloud modes and their pointer strengths, mirroring the reference site's
// signed-force switch (its GATHER uses +40, its default SPREAD −100).
export const PHOTO_MODES = { photo: 'spread', 'photo-gather': 'gather' };
export const PHOTO_STRENGTH = { spread: -100, gather: 40 };
export const PHOTO_POINTS = 4000;
export const PHOTO_SPEED = [20, 30];
export const PARTICLE_CHOICES = [
  ['off', 'Off'], ['sparse', 'Sparse'], ['normal', 'Normal'], ['dense', 'Dense'],
  ['photo', 'Photo cloud (push)'], ['photo-gather', 'Photo cloud (pull)'],
];
export const LINK_DISTANCE = 90;
export const POINTER_RADIUS = 80;
export const INK = '#20201f';
const MAX_PARTICLES = 400;

export function isPhotoMode(value) {
  return Object.hasOwn(PHOTO_MODES, String(value ?? ''));
}

export function particleMode(value) {
  const mode = String(value ?? '').trim().toLowerCase();
  return Object.hasOwn(PARTICLE_MODES, mode) || Object.hasOwn(PHOTO_MODES, mode) ? mode : 'off';
}

export function particleCount(value) {
  const mode = particleMode(value);
  return isPhotoMode(mode) ? PHOTO_POINTS : PARTICLE_MODES[mode];
}

export function readParticles(storage) {
  try { return particleMode(storage?.getItem(PARTICLES_KEY)); } catch { return 'off'; }
}

export function writeParticles(storage, value) {
  const mode = particleMode(value);
  try { storage?.setItem(PARTICLES_KEY, mode); } catch { /* Optional storage. */ }
  return mode;
}

export function createField(width, height, count, random = Math.random) {
  const total = Math.max(0, Math.min(MAX_PARTICLES, Math.floor(Number(count) || 0)));
  const field = { width: Math.max(1, width), height: Math.max(1, height), particles: [], flashes: [] };
  for (let index = 0; index < total; index++) {
    const speed = 8 + random() * 22, angle = random() * Math.PI * 2;
    field.particles.push({ x: random() * field.width, y: random() * field.height,
      vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed, r: .9 + random() * .9 });
  }
  return field;
}

// One deterministic step: drift, edge bounces, pointer stir, elastic collisions.
export function stepField(field, { width = field.width, height = field.height, seconds = 1 / 60, pointer } = {}) {
  const dt = Math.min(.05, Math.max(0, Number(seconds) || 0));
  field.width = Math.max(1, width); field.height = Math.max(1, height);
  const { particles } = field;
  for (const particle of particles) {
    if (pointer) {
      const dx = particle.x - pointer.x, dy = particle.y - pointer.y;
      const distance = Math.hypot(dx, dy);
      if (distance < POINTER_RADIUS) {
        // Push away with a slight swirl, so the cursor stirs the field. A
        // particle exactly under the pointer pushes along its own heading.
        const drift = Math.hypot(particle.vx, particle.vy);
        const nx = distance > .001 ? dx / distance : (drift > .001 ? particle.vx / drift : 1);
        const ny = distance > .001 ? dy / distance : (drift > .001 ? particle.vy / drift : 0);
        const push = (1 - distance / POINTER_RADIUS) * 90 * dt;
        particle.vx += nx * push - ny * push * .35;
        particle.vy += ny * push + nx * push * .35;
      }
    }
    // Keep drift lively with a bounded speed band instead of random nudges, so
    // steps stay deterministic and untouched particles stay untouched.
    const speed = Math.hypot(particle.vx, particle.vy);
    if (speed > 60) { particle.vx = particle.vx / speed * 60; particle.vy = particle.vy / speed * 60; }
    else if (speed !== 0 && speed < 10) { particle.vx = particle.vx / speed * 10; particle.vy = particle.vy / speed * 10; }
    particle.x += particle.vx * dt; particle.y += particle.vy * dt;
    if (particle.x < particle.r) { particle.x = particle.r; particle.vx = Math.abs(particle.vx) * .9; }
    else if (particle.x > field.width - particle.r) { particle.x = field.width - particle.r; particle.vx = -Math.abs(particle.vx) * .9; }
    if (particle.y < particle.r) { particle.y = particle.r; particle.vy = Math.abs(particle.vy) * .9; }
    else if (particle.y > field.height - particle.r) { particle.y = field.height - particle.r; particle.vy = -Math.abs(particle.vy) * .9; }
  }
  for (let i = 0; i < particles.length; i++) for (let j = i + 1; j < particles.length; j++) {
    const a = particles[i], b = particles[j];
    const dx = b.x - a.x, dy = b.y - a.y, minimum = a.r + b.r;
    const distanceSquared = dx * dx + dy * dy;
    if (distanceSquared > minimum * minimum || distanceSquared === 0) continue;
    const distance = Math.sqrt(distanceSquared) || minimum;
    const nx = dx / distance, ny = dy / distance;
    const overlap = minimum - distance, shift = overlap / 2;
    a.x -= nx * shift; a.y -= ny * shift; b.x += nx * shift; b.y += ny * shift;
    const approach = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
    if (approach < 0) {
      const impulse = -(1 + .9) * approach / 2;
      a.vx -= impulse * nx; a.vy -= impulse * ny;
      b.vx += impulse * nx; b.vy += impulse * ny;
    }
    if (field.flashes.length < 40) field.flashes.push({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, life: .28, max: .28 });
  }
  for (const flash of field.flashes) flash.life -= dt;
  field.flashes = field.flashes.filter((flash) => flash.life > 0);
  return field;
}

// Index pairs closer than the link distance, nearest first (used for drawing
// and for tests of the constellation look).
export function linkPairs(field, distance = LINK_DISTANCE) {
  const pairs = [];
  const { particles } = field;
  for (let i = 0; i < particles.length; i++) for (let j = i + 1; j < particles.length; j++) {
    const dx = particles[j].x - particles[i].x, dy = particles[j].y - particles[i].y;
    const gap = Math.hypot(dx, dy);
    if (gap <= distance) pairs.push({ i, j, gap });
  }
  return pairs.sort((left, right) => left.gap - right.gap);
}

const channel = (value) => {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/.exec(String(value || '').toLowerCase());
  return match ? [parseInt(match[1], 16), parseInt(match[2], 16), parseInt(match[3], 16)] : [32, 32, 31];
};

export function drawField(ctx, field, { ink = INK, pointer } = {}) {
  if (!ctx || !field) return false;
  const { particles } = field, [red, green, blue] = channel(ink);
  // Faint links, bucketed by strength so each level is a single stroke path.
  const buckets = new Map();
  const addLink = (ax, ay, bx, by, level) => {
    const list = buckets.get(level) || [];
    list.push([ax, ay, bx, by]); buckets.set(level, list);
  };
  for (const { i, j, gap } of linkPairs(field)) {
    const level = Math.max(1, Math.min(4, Math.round((1 - gap / LINK_DISTANCE) * 4)));
    addLink(particles[i].x, particles[i].y, particles[j].x, particles[j].y, level);
  }
  if (pointer) for (const particle of particles) {
    const gap = Math.hypot(particle.x - pointer.x, particle.y - pointer.y);
    if (gap <= LINK_DISTANCE) addLink(pointer.x, pointer.y, particle.x, particle.y, 1);
  }
  ctx.lineWidth = 1;
  for (const [level, segments] of buckets) {
    ctx.strokeStyle = `rgba(${red},${green},${blue},${(level * .085).toFixed(3)})`;
    ctx.beginPath();
    for (const [ax, ay, bx, by] of segments) { ctx.moveTo(Math.round(ax) + .5, Math.round(ay) + .5); ctx.lineTo(Math.round(bx) + .5, Math.round(by) + .5); }
    ctx.stroke();
  }
  // Dots.
  ctx.fillStyle = `rgba(${red},${green},${blue},.85)`;
  for (const particle of particles) {
    const size = Math.max(1, Math.round(particle.r));
    ctx.fillRect(Math.round(particle.x), Math.round(particle.y), size, size);
  }
  // Collision flashes: a small square ring that expands as it fades.
  for (const flash of field.flashes) {
    const progress = 1 - flash.life / flash.max;
    const size = Math.max(3, Math.round(3 + progress * 7));
    ctx.strokeStyle = `rgba(${red},${green},${blue},${(.55 * (1 - progress)).toFixed(3)})`;
    ctx.strokeRect(Math.round(flash.x - size / 2), Math.round(flash.y - size / 2), size, size);
  }
  return true;
}

// Turns a sampled photo into the reference site's point cloud: 7 floats per
// point (x, y, z, r, g, b, a), centred like the site's world space (Y up), with
// points picked on a stable grid over the dithered ink so density is even.
export function photoCloud(sample, { max = PHOTO_POINTS, random = Math.random } = {}) {
  if (!sample || !sample.data || !sample.width || !sample.height) return { count: 0, points: new Float32Array(0) };
  const { data, width, height } = sample;
  const ink = ditherPhoto(data, width, height);
  let inked = 0;
  for (let index = 0; index < ink.length; index++) if (ink[index]) inked++;
  // Decimate by count, not by a coordinate grid: a stride would alias against
  // the ordered dither and drop most of the image.
  const stride = Math.max(1, Math.ceil(inked / Math.max(1, Math.floor(max))));
  const values = [];
  let seen = 0;
  for (let index = 0; index < ink.length && values.length / 7 < max; index++) {
    if (!ink[index]) continue;
    if (seen++ % stride) continue;
    const x = index % width, y = (index - x) / width, at = index * 4;
    values.push(x + .5 - width / 2 + (random() - .5) * .8, height / 2 - (y + .5) + (random() - .5) * .8, (random() - .5) * 2,
      data[at] / 255, data[at + 1] / 255, data[at + 2] / 255, 1);
  }
  return { count: values.length / 7, points: Float32Array.from(values) };
}

// A pool of particles ready to fly to the cloud, starting scattered like the
// site's (random box, small depth, faded out) so the cloud forms visibly.
export function createPhotoPool(count, width, height, random = Math.random) {
  const pool = [];
  const total = Math.max(0, Math.min(PHOTO_POINTS, Math.floor(Number(count) || 0)));
  for (let index = 0; index < total; index++) {
    pool.push({
      pointIdx: index, speed: PHOTO_SPEED[0] + random() * (PHOTO_SPEED[1] - PHOTO_SPEED[0]),
      x: (random() - .5) * width, y: (random() - .5) * height, z: (random() - .5) * 2,
      r: .5, g: .5, b: .5, a: -1,
    });
  }
  return pool;
}

// One frame of the reference site's motion: ease toward the assigned point with
// s = 1/speed, plus the signed pointer force strength * (pointer - p) / (1+d)².
export function stepPhotoCloud(pool, cloud, { pointer, strength = PHOTO_STRENGTH.spread } = {}) {
  const count = cloud?.count ?? 0, points = cloud?.points;
  for (const particle of pool) {
    const ease = 1 / particle.speed;
    if (particle.pointIdx >= count || !points) { particle.a += (-1 - particle.a) * ease; continue; }
    const at = particle.pointIdx * 7;
    const targetX = points[at], targetY = points[at + 1], targetZ = points[at + 2];
    let forceX = 0, forceY = 0;
    if (pointer) {
      const gapX = pointer.x - particle.x, gapY = pointer.y - particle.y;
      const distance = Math.hypot(gapX, gapY);
      const falloff = 1 / (1 + distance) / (1 + distance);
      forceX = strength * gapX * falloff;
      forceY = strength * gapY * falloff;
    }
    particle.x += (targetX - particle.x) * ease + forceX;
    particle.y += (targetY - particle.y) * ease + forceY;
    particle.z += (targetZ - particle.z) * ease;
    particle.r += (points[at + 3] - particle.r) * ease;
    particle.g += (points[at + 4] - particle.g) * ease;
    particle.b += (points[at + 5] - particle.b) * ease;
    particle.a += (points[at + 6] - particle.a) * ease;
  }
  return pool;
}

// Draws the pool as pixel dots tinted by the sampled photo colour, with a light
// depth parallax so the cloud tilts toward the pointer like the site's view.
export function drawPhotoCloud(ctx, pool, cloud, { pointer, centerX = 0, centerY = 0, size = 2 } = {}) {
  if (!ctx || !pool) return false;
  const count = cloud?.count ?? 0;
  const tiltX = pointer ? (pointer.x - centerX) * .02 : 0;
  const tiltY = pointer ? (pointer.y - centerY) * .02 : 0;
  for (const particle of pool) {
    if (particle.a <= .01 || particle.pointIdx >= count) continue;
    const alpha = Math.min(1, particle.a);
    const red = Math.round(Math.max(0, Math.min(1, particle.r)) * 255);
    const green = Math.round(Math.max(0, Math.min(1, particle.g)) * 255);
    const blue = Math.round(Math.max(0, Math.min(1, particle.b)) * 255);
    ctx.fillStyle = `rgba(${red},${green},${blue},${alpha.toFixed(3)})`;
    ctx.fillRect(Math.round(particle.x + tiltX * particle.z - size / 2), Math.round(particle.y + tiltY * particle.z - size / 2), size, size);
  }
  return true;
}

// Renders only; owns the one animation frame loop, pauses when hidden or when
// the system asks for reduced motion, and stops entirely when switched off.
// `photo(width, height)` supplies the image sample for the point-cloud modes.
export function createParticles({ canvas, storage, photo, document: doc = canvas?.ownerDocument ?? globalThis.document, random } = {}) {
  const view = () => doc?.defaultView ?? globalThis;
  const media = view()?.matchMedia?.('(prefers-reduced-motion: reduce)');
  const source = typeof random === 'function' ? random : Math.random;
  let mode = readParticles(storage), field = null, pool = null, cloud = null;
  let frame = null, lastTime = 0, accumulator = 0, pointer = null, inside = false, disposed = false;
  const ctx = canvas?.getContext?.('2d');
  const now = () => view()?.performance?.now?.() ?? Date.now();
  const suspended = () => disposed || mode === 'off' || Boolean(doc?.hidden) || Boolean(media?.matches);

  function rebuildCloud() {
    if (!canvas || !isPhotoMode(mode) || typeof photo !== 'function') { cloud = null; return; }
    try { cloud = photoCloud(photo(canvas.width, canvas.height), { max: PHOTO_POINTS, random: source }); }
    catch { cloud = null; }
  }

  function resize() {
    if (!canvas) return;
    const { width, height } = backgroundSize(view()?.innerWidth ?? canvas.clientWidth, view()?.innerHeight ?? canvas.clientHeight);
    const changed = canvas.width !== width || canvas.height !== height;
    if (changed) { canvas.width = width; canvas.height = height; }
    if (isPhotoMode(mode)) {
      if (!pool || changed) pool = createPhotoPool(particleCount(mode), width, height, source);
      rebuildCloud();
    } else {
      field = createField(width, height, particleCount(mode), source);
      pool = null; cloud = null;
    }
  }

  function draw() {
    if (!ctx || !canvas) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (mode === 'off') return;
    if (isPhotoMode(mode)) drawPhotoCloud(ctx, pool, cloud, { pointer: inside ? pointer : null, centerX: canvas.width / 2, centerY: canvas.height / 2 });
    else if (field) drawField(ctx, field, { pointer: inside ? pointer : null });
  }

  const schedule = (callback) => (typeof view()?.requestAnimationFrame === 'function'
    ? view().requestAnimationFrame(callback)
    : setTimeout(() => callback(now()), 33));
  const unschedule = (id) => {
    if (id == null) return;
    if (typeof view()?.cancelAnimationFrame === 'function') view().cancelAnimationFrame(id);
    else clearTimeout(id);
  };

  function tick(time) {
    frame = null;
    if (suspended()) { draw(); return; }
    const current = Number.isFinite(time) ? time : now();
    const seconds = Math.min(.05, Math.max(0, (current - lastTime) / 1000));
    lastTime = current;
    if (isPhotoMode(mode)) {
      // The reference site steps its cloud on a ~60fps queue with frame-based
      // easing, so keep that cadence even on a 120Hz display.
      accumulator = Math.min(.1, accumulator + seconds);
      while (accumulator >= 1 / 60) { stepPhotoCloud(pool, cloud, { pointer: inside ? pointer : null, strength: PHOTO_STRENGTH[PHOTO_MODES[mode]] }); accumulator -= 1 / 60; }
    } else if (field) {
      stepField(field, { width: canvas.width, height: canvas.height, seconds, pointer: inside ? pointer : null });
    }
    draw();
    frame = schedule(tick);
  }

  function wake() {
    if (frame != null || disposed) return;
    lastTime = now(); accumulator = 0;
    frame = schedule(tick);
  }

  const onPointerMove = (event) => {
    const x = Number(event?.clientX), y = Number(event?.clientY);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    pointer = { x, y }; inside = true;
    if (!suspended()) wake();
  };
  const onPointerLeave = () => { inside = false; };
  const onVisibility = () => { if (suspended()) { unschedule(frame); frame = null; draw(); } else wake(); };
  const onMotion = () => { unschedule(frame); frame = null; draw(); if (!suspended()) wake(); };

  doc?.addEventListener?.('pointermove', onPointerMove, { passive: true });
  doc?.addEventListener?.('pointerleave', onPointerLeave, { passive: true });
  doc?.addEventListener?.('visibilitychange', onVisibility);
  view()?.addEventListener?.('blur', onPointerLeave);
  view()?.addEventListener?.('resize', resize);
  if (media?.addEventListener) media.addEventListener('change', onMotion);
  else if (media?.addListener) media.addListener(onMotion);

  const controller = {
    get mode() { return mode; },
    setMode(value) {
      mode = writeParticles(storage, value);
      resize();
      unschedule(frame); frame = null;
      draw();
      if (!suspended()) wake();
      return mode;
    },
    // Rebuild the point cloud in place (particles keep flying to the new targets).
    refreshPhoto() {
      if (!isPhotoMode(mode)) return false;
      rebuildCloud(); draw();
      return true;
    },
    destroy() {
      disposed = true;
      unschedule(frame); frame = null;
      doc?.removeEventListener?.('pointermove', onPointerMove);
      doc?.removeEventListener?.('pointerleave', onPointerLeave);
      doc?.removeEventListener?.('visibilitychange', onVisibility);
      view()?.removeEventListener?.('blur', onPointerLeave);
      view()?.removeEventListener?.('resize', resize);
      if (media?.removeEventListener) media.removeEventListener('change', onMotion);
      else if (media?.removeListener) media.removeListener(onMotion);
      if (ctx && canvas) ctx.clearRect(0, 0, canvas.width, canvas.height);
    },
  };
  resize();
  draw();
  if (!suspended()) wake();
  return controller;
}
