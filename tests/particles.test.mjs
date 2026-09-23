import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CLOUD_CHOICES, CLOUD_POINTER_KEY, CLOUD_POINTERS, LINK_DISTANCE, PARTICLE_CHOICES, PARTICLE_MODES, PHOTO_POINTS, PHOTO_SIZE, PHOTO_SPEED,
  cloudPointer, cloudStrength, createField, createPhotoPool, drawField, drawPhotoCloud, linkPairs, particleCount, particleMode, photoCloud,
  readCloudPointer, readParticles, stepField, stepPhotoCloud, writeCloudPointer, writeParticles,
} from '../desktop/public/particles.js';

// Small deterministic PRNG so physics tests never flake.
function sequence(seed = 1) {
  let state = seed >>> 0;
  return () => ((state = (state * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

function frame() {
  const calls = { clearRect: 0, beginPath: 0, stroke: 0, fillRect: 0, strokeRect: 0, moveTo: 0, lineTo: 0, styles: [] };
  const ctx = {
    lineWidth: 1, strokeStyle: '', fillStyle: '',
    clearRect() { calls.clearRect++; },
    beginPath() { calls.beginPath++; },
    moveTo() { calls.moveTo++; }, lineTo() { calls.lineTo++; },
    stroke() { calls.stroke++; calls.styles.push(ctx.strokeStyle); },
    fillRect(x, y) { calls.fillRect++; (calls.rects ||= []).push([ctx.fillStyle, x, y]); },
    strokeRect() { calls.strokeRect++; },
  };
  return { ctx, calls };
}

test('particle modes normalize and persist safely', () => {
  assert.equal(particleMode('dense'), 'dense');
  assert.equal(particleMode(' DENSE '), 'dense');
  for (const bad of ['', null, undefined, 'lots', 42, {}]) assert.equal(particleMode(bad), 'off');
  assert.equal(particleCount('sparse'), PARTICLE_MODES.sparse);
  assert.equal(particleCount('nonsense'), 0);
  const map = new Map();
  const storage = { getItem: (key) => map.get(key) ?? null, setItem: (key, value) => map.set(key, String(value)) };
  assert.equal(readParticles(storage), 'off');
  assert.equal(writeParticles(storage, 'normal'), 'normal');
  assert.equal(readParticles(storage), 'normal');
  assert.equal(writeParticles(storage, 'nonsense'), 'off', 'invalid input falls back to off');
  const denied = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
  assert.equal(readParticles(denied), 'off');
  assert.doesNotThrow(() => writeParticles(denied, 'dense'));
});

test('fields are deterministic, bounded and stay inside the canvas', () => {
  const field = createField(200, 120, PARTICLE_MODES.sparse, sequence(7));
  assert.equal(field.particles.length, PARTICLE_MODES.sparse);
  assert.ok(field.particles.every((p) => p.x >= 0 && p.x <= 200 && p.y >= 0 && p.y <= 120 && p.r >= .9));
  const again = createField(200, 120, PARTICLE_MODES.sparse, sequence(7));
  assert.deepEqual(field.particles, again.particles, 'same seed, same field');
  assert.equal(createField(10, 10, 10_000, sequence(2)).particles.length, 400, 'count is capped');
  const random = sequence(11);
  for (let step = 0; step < 600; step++) stepField(field, { width: 200, height: 120, seconds: 1 / 60 });
  for (const particle of field.particles) {
    assert.ok(particle.x >= 0 && particle.x <= 200 && particle.y >= 0 && particle.y <= 120, 'bounced back inside');
    assert.ok(Math.hypot(particle.vx, particle.vy) <= 60.1, 'speed stays capped');
  }
});

test('particles collide elastically and leave a short flash', () => {
  const field = { width: 200, height: 100, particles: [
    { x: 60, y: 50, vx: 30, vy: 0, r: 1 },
    { x: 66, y: 50, vx: -30, vy: 0, r: 1 },
    { x: 5, y: 90, vx: 0, vy: 0, r: 1 },
  ], flashes: [] };
  const before = field.particles[2].vx;
  for (let step = 0; step < 6; step++) stepField(field, { width: 200, height: 100, seconds: 1 / 60 });
  const [a, b, distant] = field.particles;
  assert.ok(a.x < b.x, 'the pair separates');
  assert.ok(a.vx < 0 && b.vx > 0, 'velocities exchange along the normal');
  assert.equal(distant.vx, before, 'a distant particle is untouched');
  assert.ok(field.flashes.length >= 1, 'a collision flash is recorded');
  assert.ok(field.flashes.every((flash) => flash.life > 0 && flash.life <= flash.max));
  // Flashes age out.
  const flashes = field.flashes.length;
  assert.ok(flashes > 0);
  for (let step = 0; step < 40; step++) stepField(field, { width: 200, height: 100, seconds: 1 / 60 });
  assert.equal(field.flashes.length, 0, 'flashes expire');
});

test('links and drawing follow the constellation rules', () => {
  const field = { width: 300, height: 200, particles: [
    { x: 10, y: 10, vx: 0, vy: 0, r: 1 },
    { x: 10 + LINK_DISTANCE - 10, y: 10, vx: 0, vy: 0, r: 1 },
    { x: 250, y: 180, vx: 0, vy: 0, r: 1 },
  ], flashes: [{ x: 50, y: 50, life: .2, max: .28 }] };
  const pairs = linkPairs(field);
  assert.equal(pairs.length, 1);
  assert.deepEqual([pairs[0].i, pairs[0].j], [0, 1]);
  const { ctx, calls } = frame();
  assert.equal(drawField(ctx, field), true);
  assert.equal(calls.fillRect, 3, 'one dot per particle');
  assert.equal(calls.lineTo, 1, 'only the close pair is linked');
  assert.equal(calls.moveTo, 1);
  assert.equal(calls.strokeRect, 1, 'one collision flash');
  assert.ok(calls.styles.some((style) => style.startsWith('rgba(')), 'links fade with distance');
  assert.ok(calls.styles.every((style) => !style.includes('NaN')));
  assert.equal(drawField(null, field), false);
});

// A synthetic photo sample: a dark disc on white, plus a tinted half, so both
// the ink mask and the sampled colours can be checked.
function photoSample(size = 40) {
  const data = new Uint8ClampedArray(size * size * 4);
  const center = size / 2;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const at = (y * size + x) * 4;
    const inside = Math.hypot(x + .5 - center, y + .5 - center) < size * .3;
    data[at] = inside ? (x < center ? 10 : 200) : 255;
    data[at + 1] = inside ? 20 : 255;
    data[at + 2] = inside ? 30 : 255;
    data[at + 3] = 255;
  }
  return { data, width: size, height: size };
}

test('particle modes and the cloud pointer keep the reference constants', () => {
  assert.deepEqual(PARTICLE_CHOICES.map(([value]) => value), ['off', 'sparse', 'normal', 'dense']);
  assert.deepEqual(CLOUD_CHOICES.map(([value]) => value), ['push', 'pull']);
  assert.equal(particleMode('photo'), 'off', 'legacy photo modes are no longer particle modes');
  assert.equal(PHOTO_POINTS, 20000, '20k point cloud');
  assert.equal(PHOTO_SIZE, 3, '3px dots');
  assert.equal(CLOUD_POINTERS.push, -100, 'the site default spread');
  assert.equal(CLOUD_POINTERS.pull, 40, 'the site gather');
  assert.deepEqual(PHOTO_SPEED, [20, 30], 'the site easing range');
  assert.equal(cloudPointer('pull'), 'pull'); assert.equal(cloudPointer(' PULL '), 'pull');
  assert.equal(cloudPointer('nonsense'), 'push'); assert.equal(cloudPointer(null), 'push');
  assert.equal(cloudStrength('pull'), 40); assert.equal(cloudStrength('push'), -100);
  const map = new Map();
  const storage = { getItem: (key) => map.get(key) ?? null, setItem: (key, value) => map.set(key, String(value)) };
  assert.equal(readCloudPointer(storage), 'push', 'defaults to the site behaviour');
  assert.equal(writeCloudPointer(storage, 'pull'), 'pull');
  assert.equal(map.get(CLOUD_POINTER_KEY), 'pull');
  assert.equal(readCloudPointer(storage), 'pull');
  assert.equal(writeCloudPointer(storage, 'nonsense'), 'push');
  // Older installs stored the photo modes here; migrate instead of losing them.
  map.clear(); map.set('pi-desktop:particles:v1', 'photo-gather');
  assert.equal(readCloudPointer(storage), 'pull');
  map.clear(); map.set('pi-desktop:particles:v1', 'photo');
  assert.equal(readCloudPointer(storage), 'push');
  assert.equal(readCloudPointer({ getItem() { throw new Error('denied'); } }), 'push');
});

test('the photo becomes a centred, deterministic point cloud with sampled colours', () => {
  const sample = photoSample();
  const cloud = photoCloud(sample, { max: 200, random: sequence(9) });
  assert.ok(cloud.count > 20 && cloud.count <= 200, `bounded point count (${cloud.count})`);
  assert.equal(cloud.points.length, cloud.count * 7, 'seven floats per point');
  for (let index = 0; index < cloud.count; index++) {
    const at = index * 7;
    assert.ok(cloud.points[at] >= -20 && cloud.points[at] <= 20, 'x is centred');
    assert.ok(cloud.points[at + 1] >= -20 && cloud.points[at + 1] <= 20, 'y is centred and Y-up');
    assert.ok(Math.abs(cloud.points[at + 2]) <= 1, 'small depth');
    assert.equal(cloud.points[at + 6], 1, 'opaque targets');
    const red = cloud.points[at + 3], green = cloud.points[at + 4], blue = cloud.points[at + 5];
    // Float32 storage rounds a hair above the double-precision fraction; compare bytes.
    assert.ok(Math.round(red * 255) <= 200 && Math.round(green * 255) <= 20 && Math.round(blue * 255) <= 30, 'colours come from the photo');
  }
  assert.deepEqual(photoCloud(sample, { max: 200, random: sequence(9) }), cloud, 'deterministic');
  assert.equal(photoCloud({ data: new Uint8ClampedArray(16 * 16 * 4).fill(255), width: 16, height: 16 }, { max: 50 }).count, 0, 'a white photo has no cloud');
  assert.equal(photoCloud(null).count, 0);
  assert.ok(photoCloud(sample, { max: 40 }).count <= 40, 'max is respected');
});

test('stepPhotoCloud mirrors the site: spring home plus a signed 1/(1+d)^2 force', () => {
  const cloud = { count: 1, points: Float32Array.from([100, 0, 0, .25, .5, .75, 1]) };
  const make = () => [{ pointIdx: 0, speed: 20, x: 0, y: 0, z: 0, r: .5, g: .5, b: .5, a: -1 }];
  const home = make();
  stepPhotoCloud(home, cloud);
  assert.ok(Math.abs(home[0].x - 5) < 1e-9, 'eases 1/speed toward the target');
  assert.ok(Math.abs(home[0].r - (.5 + (.25 - .5) / 20)) < 1e-9, 'colour eases too');
  assert.ok(home[0].a > -1 && home[0].a < 1, 'alpha eases toward the target');
  // Spread pushes away from the pointer (negative strength), gather pulls to it.
  const spread = make(), gather = make();
  stepPhotoCloud(spread, cloud, { pointer: { x: 10, y: 0 }, strength: CLOUD_POINTERS.push });
  stepPhotoCloud(gather, cloud, { pointer: { x: 10, y: 0 }, strength: CLOUD_POINTERS.pull });
  assert.ok(spread[0].x < 0, `spread pushes away (${spread[0].x.toFixed(2)})`);
  assert.ok(gather[0].x > home[0].x, `gather pulls past the spring (${gather[0].x.toFixed(2)})`);
  for (let step = 0; step < 400; step++) stepPhotoCloud(gather, cloud, { pointer: null });
  assert.ok(Math.abs(gather[0].x - 100) < .01 && Math.abs(gather[0].a - 1) < 1e-6, 'the cloud settles exactly');
  // Surplus particles fade out to alpha -1 like the site's unused pool.
  const pool = make(); pool.push({ pointIdx: 1, speed: 20, x: 0, y: 0, z: 0, r: .5, g: .5, b: .5, a: 1 });
  stepPhotoCloud(pool, cloud);
  assert.ok(pool[1].a < 1, 'the extra particle fades out');
  for (let step = 0; step < 400; step++) stepPhotoCloud(pool, cloud);
  assert.ok(pool[1].a < -.99, 'and reaches invisible');
});

test('drawPhotoCloud paints tinted pixel dots with a pointer parallax', () => {
  const { ctx, calls } = frame();
  const pool = [
    { pointIdx: 0, speed: 20, x: 10, y: 20, z: 0, r: 1, g: 0, b: 0, a: 1 },
    { pointIdx: 1, speed: 20, x: 30, y: 40, z: 0, r: 0, g: 1, b: 0, a: 0 },
  ];
  const cloud = { count: 1, points: new Float32Array(7) };
  assert.equal(drawPhotoCloud(ctx, pool, cloud), true);
  assert.equal(calls.fillRect, 1, 'invisible and surplus dots are skipped');
  // Colours are cached in 32-level buckets, so the red dot lands near pure red.
  const [drawnRed, drawnGreen, drawnBlue, drawnAlpha] = ctx.fillStyle.match(/[\d.]+/g).map(Number);
  assert.ok(drawnRed >= 248 && drawnGreen <= 8 && drawnBlue <= 8 && drawnAlpha === 1, `quantized red dot (${ctx.fillStyle})`);
  const offset = (pointer) => {
    const local = frame();
    drawPhotoCloud(local.ctx, [{ pointIdx: 0, speed: 20, x: 10, y: 20, z: 1, r: 1, g: 1, b: 1, a: 1 }], cloud, { pointer, centerX: 0, centerY: 0 });
    const [, x, y] = local.calls.rects[0];
    return [x, y];
  };
  const neutral = offset(null), shifted = offset({ x: 100, y: 50 });
  assert.ok(shifted[0] > neutral[0] && shifted[1] > neutral[1], 'depth parallax follows the pointer');
  assert.equal(drawPhotoCloud(null, pool, cloud), false);
});
