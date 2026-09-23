// The background particle layer.
//
// It renders the photo as a point cloud using the reference site's motion — a
// spring back to each point's home position plus a signed 1/(1+d)² pointer
// force — and, optionally, a free drifting field on top. There is no other
// background mouse interaction: the pointer only ever feeds the site's force,
// and everything springs home when it leaves.
// Physics helpers are pure (randomness is injected) so tests need no browser.
import { backgroundSize, ditherPhoto } from './background.js';

export const PARTICLES_KEY = 'pi-desktop:particles:v1';
export const CLOUD_POINTER_KEY = 'pi-desktop:cloud-pointer:v1';
export const PARTICLE_MODES = { off: 0, sparse: 70, normal: 130, dense: 220 };
export const PARTICLE_CHOICES = [['off', 'Off'], ['sparse', 'Sparse'], ['normal', 'Normal'], ['dense', 'Dense']];
// The reference site's signed force: its default SPREAD pushes, its GATHER pulls.
export const CLOUD_POINTERS = { push: -100, pull: 40 };
export const CLOUD_CHOICES = [['push', 'Push (site default)'], ['pull', 'Pull']];
export const PHOTO_POINTS = 200_000;
export const PHOTO_SIZE = 1;
export const PHOTO_SPEED = [20, 30];
// The site's force is 1/(1+d)² with no limit, which keeps tugging the whole
// canvas. Window it with (1 - d/r)² so the pull/push is strongest at the cursor,
// matches the site's curve up close, then fades smoothly to exactly nothing at
// CLOUD_RADIUS instead of reaching across the desk.
export const CLOUD_RADIUS = 480;
export const CLOUD_FALLOFF = 2;
// Cap the force per pixel of distance. The site's 1/(1+d)² term is 40x stiffer
// than the spring right at the cursor, so the gather overshoots every frame and
// never settles; 1.5 keeps the push/drift feel and makes both modes converge.
export const CLOUD_STIFFNESS = 1.5;
export const LINK_DISTANCE = 90;
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

export function cloudPointer(value) {
  return String(value ?? '').trim().toLowerCase() === 'pull' ? 'pull' : 'push';
}

export function cloudStrength(value) {
  return CLOUD_POINTERS[cloudPointer(value)];
}

// The cloud pointer is its own setting; older installs stored the photo modes in
// the particle-mode key, so migrate those choices instead of losing them.
export function readCloudPointer(storage) {
  try {
    const stored = storage?.getItem(CLOUD_POINTER_KEY);
    if (stored === 'pull' || stored === 'push') return stored;
    const legacy = String(storage?.getItem(PARTICLES_KEY) ?? '');
    if (legacy === 'photo-gather') return 'pull';
    if (legacy === 'photo') return 'push';
  } catch { /* Optional storage. */ }
  return 'push';
}

export function writeCloudPointer(storage, value) {
  const next = cloudPointer(value);
  try { storage?.setItem(CLOUD_POINTER_KEY, next); } catch { /* Optional storage. */ }
  return next;
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

// One deterministic step: drift, edge bounces and elastic collisions. The field
// has no pointer interaction of its own.
export function stepField(field, { width = field.width, height = field.height, seconds = 1 / 60 } = {}) {
  const dt = Math.min(.05, Math.max(0, Number(seconds) || 0));
  field.width = Math.max(1, width); field.height = Math.max(1, height);
  const { particles } = field;
  for (const particle of particles) {
    // Keep drift lively with a bounded speed band instead of random nudges, so
    // steps stay deterministic.
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

export function drawField(ctx, field, { ink = INK } = {}) {
  if (!ctx || !field) return false;
  const { particles } = field, [red, green, blue] = channel(ink);
  // Faint links, bucketed by strength so each level is a single stroke path.
  const buckets = new Map();
  for (const { i, j, gap } of linkPairs(field)) {
    const level = Math.max(1, Math.min(4, Math.round((1 - gap / LINK_DISTANCE) * 4)));
    const list = buckets.get(level) || [];
    list.push([particles[i].x, particles[i].y, particles[j].x, particles[j].y]);
    buckets.set(level, list);
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
// Struct-of-arrays typed buffers: at 200k points an object per particle would
// cost tens of MB and churn the GC every frame.
export function createPhotoPool(count, width, height, random = Math.random) {
  const total = Math.max(0, Math.min(PHOTO_POINTS, Math.floor(Number(count) || 0)));
  const positions = new Float32Array(total * 3), colors = new Float32Array(total * 4), speeds = new Float32Array(total);
  for (let index = 0; index < total; index++) {
    positions[index * 3] = (random() - .5) * width;
    positions[index * 3 + 1] = (random() - .5) * height;
    positions[index * 3 + 2] = (random() - .5) * 2;
    colors[index * 4] = .5; colors[index * 4 + 1] = .5; colors[index * 4 + 2] = .5; colors[index * 4 + 3] = -1;
    speeds[index] = PHOTO_SPEED[0] + random() * (PHOTO_SPEED[1] - PHOTO_SPEED[0]);
  }
  return { count: total, positions, colors, speeds };
}

// One frame of the reference site's motion: ease toward the assigned point with
// s = 1/speed, plus the signed pointer force strength * (pointer - p) / (1+d)².
export function stepPhotoCloud(pool, cloud, { pointer, centerX = 0, centerY = 0, strength = cloudStrength('push') } = {}) {
  const count = cloud?.count ?? 0, points = cloud?.points;
  const { positions, colors, speeds } = pool;
  // The canvas pointer is Y-down and measured from the top-left; cloud points
  // live in the centred, Y-up frame the photo was sampled in.
  const pointerX = pointer ? pointer.x - centerX : 0;
  const pointerY = pointer ? centerY - pointer.y : 0;
  const reach = CLOUD_RADIUS * CLOUD_RADIUS;
  for (let index = 0; index < pool.count; index++) {
    const ease = 1 / speeds[index];
    const at = index * 3, colorAt = index * 4;
    if (index >= count || !points) { colors[colorAt + 3] += (-1 - colors[colorAt + 3]) * ease; continue; }
    const targetAt = index * 7;
    const targetX = points[targetAt], targetY = points[targetAt + 1], targetZ = points[targetAt + 2];
    let forceX = 0, forceY = 0, stiffness = 0;
    if (pointer) {
      const gapX = pointerX - positions[at], gapY = pointerY - positions[at + 1];
      // Beyond the radius there is no force at all: no far-field drift, and the
      // squared test keeps 200k points cheap.
      const distanceSquared = gapX * gapX + gapY * gapY;
      if (distanceSquared < reach) {
        const distance = Math.sqrt(distanceSquared);
        const window = (1 - distance / CLOUD_RADIUS) ** CLOUD_FALLOFF;
        // The site's curve 1/(1+d)², squared away by the window and pulled in by
        // the stiffness cap, so the pull/push decays smoothly and stays stable.
        stiffness = Math.min(CLOUD_STIFFNESS, Math.abs(strength) * window / (1 + distance) / (1 + distance)) * Math.sign(strength);
        forceX = stiffness * gapX;
        forceY = stiffness * gapY;
      }
    }
    // Damp the whole step by (1 + |k|): the site adds the force undamped, which
    // makes the gather's fixed point repelling (it oscillates forever). Damping
    // leaves every fixed point identical but makes it attracting.
    const damp = 1 + Math.abs(stiffness);
    positions[at] += ((targetX - positions[at]) * ease + forceX) / damp;
    positions[at + 1] += ((targetY - positions[at + 1]) * ease + forceY) / damp;
    positions[at + 2] += (targetZ - positions[at + 2]) * ease;
    colors[colorAt] += (points[targetAt + 3] - colors[colorAt]) * ease;
    colors[colorAt + 1] += (points[targetAt + 4] - colors[colorAt + 1]) * ease;
    colors[colorAt + 2] += (points[targetAt + 5] - colors[colorAt + 2]) * ease;
    colors[colorAt + 3] += (points[targetAt + 6] - colors[colorAt + 3]) * ease;
  }
  return pool;
}

// Draws the pool straight into an ImageData buffer tinted by the sampled photo
// colour, with a light depth parallax so the cloud tilts toward the pointer like
// the site's view. At 200k points per-pixel writes beat one fillRect each by a
// wide margin, and the same buffer is reused (and replaced wholesale, which also
// clears the previous frame). Pass `buffer` = { width, height, image } to reuse.
export function drawPhotoCloud(ctx, pool, cloud, { pointer, centerX = 0, centerY = 0, size = PHOTO_SIZE, width, height, buffer } = {}) {
  if (!ctx || !pool) return false;
  const canvasWidth = Math.max(1, Math.floor(width ?? ctx.canvas?.width ?? 0));
  const canvasHeight = Math.max(1, Math.floor(height ?? ctx.canvas?.height ?? 0));
  const image = buffer && buffer.width === canvasWidth && buffer.height === canvasHeight && buffer.image
    ? buffer.image : ctx.createImageData?.(canvasWidth, canvasHeight);
  if (!image?.data) return false;
  const data = image.data;
  data.fill(0);
  const count = cloud?.count ?? 0, points = cloud?.points;
  const tiltX = pointer ? (pointer.x - centerX) * .02 : 0;
  const tiltY = pointer ? (centerY - pointer.y) * .02 : 0;
  const half = size / 2;
  for (let index = 0; index < pool.count; index++) {
    const alpha = pool.colors[index * 4 + 3];
    if (alpha <= .01 || index >= count) continue;
    const depth = pool.positions[index * 3 + 2];
    // Cloud space is centred and Y-up; canvas space is top-left and Y-down.
    const drawX = Math.round(centerX + pool.positions[index * 3] + tiltX * depth - half);
    const drawY = Math.round(centerY - (pool.positions[index * 3 + 1] + tiltY * depth) - half);
    const fromX = Math.max(0, drawX), fromY = Math.max(0, drawY);
    const toX = Math.min(canvasWidth, drawX + size), toY = Math.min(canvasHeight, drawY + size);
    if (fromX >= toX || fromY >= toY) continue;
    const red = Math.round(Math.max(0, Math.min(1, pool.colors[index * 4])) * 255);
    const green = Math.round(Math.max(0, Math.min(1, pool.colors[index * 4 + 1])) * 255);
    const blue = Math.round(Math.max(0, Math.min(1, pool.colors[index * 4 + 2])) * 255);
    const opacity = Math.round(Math.min(1, alpha) * 255);
    for (let y = fromY; y < toY; y++) {
      let at = (y * canvasWidth + fromX) * 4;
      for (let x = fromX; x < toX; x++, at += 4) { data[at] = red; data[at + 1] = green; data[at + 2] = blue; data[at + 3] = opacity; }
    }
  }
  ctx.putImageData(image, 0, 0);
  return true;
}

// Renders only; owns the one animation frame loop, pauses when hidden or when
// the system asks for reduced motion, and stops entirely when there is nothing
// to draw. `photo(width, height)` supplies the image sample for the point cloud.
export function createParticles({ canvas, storage, photo, document: doc = canvas?.ownerDocument ?? globalThis.document, random } = {}) {
  const view = () => doc?.defaultView ?? globalThis;
  const media = view()?.matchMedia?.('(prefers-reduced-motion: reduce)');
  const source = typeof random === 'function' ? random : Math.random;
  let mode = readParticles(storage), pointerMode = readCloudPointer(storage);
  let field = null, pool = null, cloud = null, resizeTimer = null;
  const frameBuffer = { width: 0, height: 0, image: null };
  let frame = null, lastTime = 0, accumulator = 0, pointer = null, inside = false, disposed = false;
  const ctx = canvas?.getContext?.('2d');
  const now = () => view()?.performance?.now?.() ?? Date.now();
  const active = () => !disposed && (Boolean(cloud) || (mode !== 'off' && Boolean(field)));
  const suspended = () => !active() || Boolean(doc?.hidden) || Boolean(media?.matches);

  // The pool is 4000 slots so a smaller cloud simply leaves the rest fading out
  // (the reference site keeps a fixed pool too). It is recreated on size changes
  // and kept across photo changes, so points fly from the old cloud to the new.
  function rebuildCloud() {
    if (!canvas || typeof photo !== 'function') { cloud = null; return; }
    try { cloud = photoCloud(photo(canvas.width, canvas.height), { max: PHOTO_POINTS, random: source }); }
    catch { cloud = null; }
    if (cloud && !cloud.count) cloud = null;
    if (cloud && !pool) pool = createPhotoPool(PHOTO_POINTS, canvas.width, canvas.height, source);
  }

  function resize() {
    if (!canvas) return;
    const { width, height } = backgroundSize(view()?.innerWidth ?? canvas.clientWidth, view()?.innerHeight ?? canvas.clientHeight);
    const changed = canvas.width !== width || canvas.height !== height;
    if (changed) { canvas.width = width; canvas.height = height; pool = null; }
    field = mode === 'off' ? null : createField(width, height, particleCount(mode), source);
    if (typeof photo === 'function') rebuildCloud();
    else { pool = null; cloud = null; }
  }

  function draw() {
    if (!ctx || !canvas) return;
    // The cloud replaces the whole canvas through putImageData, so it paints
    // first and the field is composited on top; otherwise clear the frame.
    if (cloud) {
      if (frameBuffer.width !== canvas.width || frameBuffer.height !== canvas.height) {
        frameBuffer.width = canvas.width; frameBuffer.height = canvas.height;
        frameBuffer.image = ctx.createImageData?.(canvas.width, canvas.height) ?? null;
      }
      drawPhotoCloud(ctx, pool, cloud, { pointer: inside ? pointer : null, centerX: canvas.width / 2, centerY: canvas.height / 2, width: canvas.width, height: canvas.height, buffer: frameBuffer });
    } else ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (field) drawField(ctx, field);
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
    if (field) stepField(field, { width: canvas.width, height: canvas.height, seconds });
    if (cloud) {
      // The reference site steps its cloud on a ~60fps queue with frame-based
      // easing, so keep that cadence even on a 120Hz display.
      accumulator = Math.min(.1, accumulator + seconds);
      while (accumulator >= 1 / 60) {
        stepPhotoCloud(pool, cloud, { pointer: inside ? pointer : null, centerX: canvas.width / 2, centerY: canvas.height / 2, strength: cloudStrength(pointerMode) });
        accumulator -= 1 / 60;
      }
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
  // Leaving the window drops the force so the cloud springs home.
  const onPointerLeave = () => { inside = false; };
  const onVisibility = () => { if (suspended()) { unschedule(frame); frame = null; draw(); } else wake(); };
  const onMotion = () => { unschedule(frame); frame = null; draw(); if (!suspended()) wake(); };
  const onResize = () => {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      resizeTimer = null;
      resize(); draw();
      if (!suspended()) wake();
    }, 150);
  };

  doc?.addEventListener?.('pointermove', onPointerMove, { passive: true });
  doc?.addEventListener?.('pointerleave', onPointerLeave, { passive: true });
  doc?.addEventListener?.('visibilitychange', onVisibility);
  view()?.addEventListener?.('blur', onPointerLeave);
  view()?.addEventListener?.('resize', onResize);
  if (media?.addEventListener) media.addEventListener('change', onMotion);
  else if (media?.addListener) media.addListener(onMotion);

  const controller = {
    get mode() { return mode; },
    get cloudPointer() { return pointerMode; },
    get hasCloud() { return Boolean(cloud); },
    setMode(value) {
      mode = writeParticles(storage, value);
      resize();
      unschedule(frame); frame = null;
      draw();
      if (!suspended()) wake();
      return mode;
    },
    setCloudPointer(value) {
      pointerMode = writeCloudPointer(storage, value);
      draw();
      if (!suspended()) wake();
      return pointerMode;
    },
    // Rebuild the point cloud in place (particles keep flying to the new targets).
    refreshPhoto() {
      if (!canvas) return false;
      rebuildCloud();
      draw();
      unschedule(frame); frame = null;
      if (!suspended()) wake();
      return Boolean(cloud);
    },
    destroy() {
      disposed = true;
      if (resizeTimer) clearTimeout(resizeTimer);
      unschedule(frame); frame = null;
      doc?.removeEventListener?.('pointermove', onPointerMove);
      doc?.removeEventListener?.('pointerleave', onPointerLeave);
      doc?.removeEventListener?.('visibilitychange', onVisibility);
      view()?.removeEventListener?.('blur', onPointerLeave);
      view()?.removeEventListener?.('resize', onResize);
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
