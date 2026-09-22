// Optional particle field over the background: drifting dots linked by faint
// lines, a gentle pointer stir, and short flashes where particles collide.
// Physics helpers are pure (randomness is injected) so they can be tested
// without a browser; the controller owns the single animation frame loop.
import { backgroundSize } from './background.js';

export const PARTICLES_KEY = 'pi-desktop:particles:v1';
export const PARTICLE_MODES = { off: 0, sparse: 70, normal: 130, dense: 220 };
export const LINK_DISTANCE = 90;
export const POINTER_RADIUS = 80;
export const INK = '#20201f';
const MAX_PARTICLES = 400;

export function particleMode(value) {
  const mode = String(value ?? '').trim().toLowerCase();
  return Object.hasOwn(PARTICLE_MODES, mode) ? mode : 'off';
}

export function particleCount(value) {
  return PARTICLE_MODES[particleMode(value)];
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

// Renders only; owns the one animation frame loop, pauses when hidden or when
// the system asks for reduced motion, and stops entirely when switched off.
export function createParticles({ canvas, storage, document: doc = canvas?.ownerDocument ?? globalThis.document, random } = {}) {
  const view = () => doc?.defaultView ?? globalThis;
  const media = view()?.matchMedia?.('(prefers-reduced-motion: reduce)');
  const source = typeof random === 'function' ? random : Math.random;
  let mode = readParticles(storage), field = null, frame = null, lastTime = 0, pointer = null, disposed = false;
  const ctx = canvas?.getContext?.('2d');
  const now = () => view()?.performance?.now?.() ?? Date.now();
  const suspended = () => disposed || mode === 'off' || Boolean(doc?.hidden) || Boolean(media?.matches);

  function resize() {
    if (!canvas) return;
    const { width, height } = backgroundSize(view()?.innerWidth ?? canvas.clientWidth, view()?.innerHeight ?? canvas.clientHeight);
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    field = createField(width, height, particleCount(mode), source);
  }

  function draw() {
    if (!ctx || !canvas) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (field && mode !== 'off') drawField(ctx, field, { pointer });
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
    if (field) stepField(field, { width: canvas.width, height: canvas.height, seconds, pointer, random: source });
    draw();
    frame = schedule(tick);
  }

  function wake() {
    if (frame != null || disposed) return;
    lastTime = now();
    frame = schedule(tick);
  }

  const onPointerMove = (event) => {
    const x = Number(event?.clientX), y = Number(event?.clientY);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    pointer = { x, y };
    if (!suspended()) wake();
  };
  const onPointerLeave = () => { pointer = null; };
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
