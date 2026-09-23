import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CLOUD_CHOICES, CLOUD_FALLOFF, CLOUD_POINTER_KEY, CLOUD_POINTERS, CLOUD_RADIUS, CLOUD_STIFFNESS, LINK_DISTANCE, PARTICLE_CHOICES, PARTICLE_MODES, PHOTO_POINTS, PHOTO_SIZE, PHOTO_SPEED,
  cloudPointer, cloudStrength, createField, createPhotoPool, drawField, drawPhotoCloud, linkPairs, particleCount, particleMode, photoCloud,
  readCloudPointer, readParticles, stepField, stepPhotoCloud, writeCloudPointer, writeParticles,
} from '../desktop/public/particles.js';

// Small deterministic PRNG so physics tests never flake.
function sequence(seed = 1) {
  let state = seed >>> 0;
  return () => ((state = (state * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

function frame() {
  const calls = { clearRect: 0, beginPath: 0, stroke: 0, fillRect: 0, strokeRect: 0, moveTo: 0, lineTo: 0, putImageData: 0, styles: [] };
  const ctx = {
    lineWidth: 1, strokeStyle: '', fillStyle: '',
    createImageData(width, height) { return { width, height, data: new Uint8ClampedArray(width * height * 4) }; },
    putImageData(image, x = 0, y = 0) { calls.putImageData++; calls.image = image; calls.x = x; calls.y = y; },
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
  assert.equal(PHOTO_POINTS, 200_000, '200k point cloud');
  assert.equal(PHOTO_SIZE, 1, 'a 1px dot');
  assert.equal(CLOUD_RADIUS, 480, 'the pointer only reaches CLOUD_RADIUS');
  assert.equal(CLOUD_FALLOFF, 2, 'smooth quadratic window');
  assert.equal(CLOUD_STIFFNESS, 1.5, 'the force per pixel of distance is capped');
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
    // Float32 storage rounds a hair above the double-precision fraction; compare bytes.
    const red = cloud.points[at + 3], green = cloud.points[at + 4], blue = cloud.points[at + 5];
    assert.ok(Math.round(red * 255) <= 200 && Math.round(green * 255) <= 20 && Math.round(blue * 255) <= 30, 'colours come from the photo');
  }
  assert.deepEqual(photoCloud(sample, { max: 200, random: sequence(9) }), cloud, 'deterministic');
  assert.equal(photoCloud({ data: new Uint8ClampedArray(16 * 16 * 4).fill(255), width: 16, height: 16 }, { max: 50 }).count, 0, 'a white photo has no cloud');
  assert.equal(photoCloud(null).count, 0);
  assert.ok(photoCloud(sample, { max: 40 }).count <= 40, 'max is respected');
  assert.ok(PHOTO_POINTS > 100_000, 'the default sampling target is large');
});

test('stepPhotoCloud mirrors the site: spring home plus a signed 1/(1+d)^2 force', () => {
  const cloud = { count: 1, points: Float32Array.from([100, 0, 0, .25, .5, .75, 1]) };
  // A deterministic one-particle pool at the origin (z -1), speed 20, faded out.
  const make = () => createPhotoPool(1, 0, 0, () => 0);
  const home = make();
  stepPhotoCloud(home, cloud);
  assert.ok(Math.abs(home.positions[0] - 5) < 1e-9, 'eases 1/speed toward the target');
  assert.ok(Math.abs(home.colors[0] - (.5 + (.25 - .5) / 20)) < 1e-6, 'colour eases too'); // float32 buffer
  assert.ok(home.colors[3] > -1 && home.colors[3] < 1, 'alpha eases toward the target');
  // Spread pushes away from the pointer (negative strength), gather pulls to it.
  const spread = make(), gather = make();
  stepPhotoCloud(spread, cloud, { pointer: { x: 10, y: 0 }, strength: CLOUD_POINTERS.push });
  stepPhotoCloud(gather, cloud, { pointer: { x: 10, y: 0 }, strength: CLOUD_POINTERS.pull });
  assert.ok(spread.positions[0] < 0, `spread pushes away (${spread.positions[0].toFixed(2)})`);
  assert.ok(gather.positions[0] > home.positions[0], `gather pulls past the spring (${gather.positions[0].toFixed(2)})`);
  for (let step = 0; step < 400; step++) stepPhotoCloud(gather, cloud, { pointer: null });
  assert.ok(Math.abs(gather.positions[0] - 100) < .01 && Math.abs(gather.colors[3] - 1) < 1e-6, 'the cloud settles exactly');
  // Surplus particles fade out to alpha -1 like the site's unused pool.
  const pool = createPhotoPool(2, 0, 0, () => 0);
  stepPhotoCloud(pool, cloud);
  assert.ok(pool.colors[7] < 1, 'the extra particle fades out');
  for (let step = 0; step < 400; step++) stepPhotoCloud(pool, cloud);
  assert.ok(pool.colors[7] < -.99, 'and reaches invisible');
  // The canvas pointer is measured in the cloud's centred, Y-up frame, so the
  // push direction is right no matter where the canvas sits on screen.
  const corner = make(), home2 = make();
  stepPhotoCloud(corner, cloud, { pointer: { x: 0, y: 0 }, centerX: 100, centerY: 100, strength: CLOUD_POINTERS.push });
  stepPhotoCloud(home2, cloud, { pointer: { x: 100, y: 100 }, centerX: 100, centerY: 100, strength: CLOUD_POINTERS.push });
  assert.ok(corner.positions[0] > home2.positions[0], 'a top-left pointer pushes right of the centred pointer');
  assert.ok(corner.positions[1] < home2.positions[1], 'and downward in cloud space (Y-up)');
});

test('the pointer force decays smoothly and stops at CLOUD_RADIUS', () => {
  const cloud = { count: 1, points: Float32Array.from([0, 0, 0, .5, .5, .5, 1]) };
  const settle = (x, pointer) => {
    const pool = createPhotoPool(1, 0, 0, () => 0);
    pool.positions[0] = x;
    stepPhotoCloud(pool, cloud, pointer ? { pointer: { x: 0, y: 0 }, strength: CLOUD_POINTERS.pull } : {});
    return pool.positions[0];
  };
  // Beyond the radius the step is exactly the pointer-free step: no far-field tug.
  for (const gap of [CLOUD_RADIUS + 1, 900]) {
    assert.equal(settle(-gap, true), settle(-gap, false), `no force at ${gap}px`);
  }
  // The step is the site's spring + force damped by (1 + k), so the measured
  // per-frame displacement is gap * k * (1 - ease) / (1 + k) with ease = 1/20.
  const ease = 1 / 20;
  const pullAt = (gap) => settle(-gap, true) - settle(-gap, false);
  const windowAt = (gap) => (1 - gap / CLOUD_RADIUS) ** CLOUD_FALLOFF;
  const stiffnessAt = (gap) => Math.min(CLOUD_STIFFNESS, CLOUD_POINTERS.pull * windowAt(gap) / (1 + gap) ** 2);
  const dampedAt = (gap, k = stiffnessAt(gap)) => gap * k * (1 - ease) / (1 + k);
  const siteForce = (gap) => CLOUD_POINTERS.pull * gap / (1 + gap) ** 2;
  assert.ok(Math.abs(pullAt(40) - dampedAt(40)) < .02, `the damped site curve at 40px (${pullAt(40).toFixed(4)} vs ${dampedAt(40).toFixed(4)})`);
  assert.ok(Math.abs(pullAt(200) - dampedAt(200)) < .02, `and at 200px (${pullAt(200).toFixed(4)})`);
  // The stiffness cap softens the cursor itself: k is 10 there without it.
  const uncapped = dampedAt(1, CLOUD_POINTERS.pull * windowAt(1) / 4);
  assert.ok(pullAt(1) < uncapped * .8, `the stiffness cap softens the cursor (${pullAt(1).toFixed(3)} < ${uncapped.toFixed(3)})`);
  // The window only ever reduces the site's force, and the decay is monotonic.
  const gaps = [40, 120, 300, 460];
  let previous = Infinity;
  for (const gap of gaps) {
    const force = pullAt(gap);
    assert.ok(force > 0 && force < siteForce(gap), `windowed at ${gap}px (${force.toFixed(4)} < ${siteForce(gap).toFixed(4)})`);
    assert.ok(force < previous, `decays from the previous gap (${gap}px)`);
    previous = force;
  }
  // The gather's fixed point attracts instead of oscillating forever.
  const heldCloud = { count: 1, points: Float32Array.from([100, 0, 0, .5, .5, .5, 1]) };   // home 100px right of the cursor
  const held = createPhotoPool(1, 0, 0, () => 0);
  held.positions[0] = 4;
  const gatherTo = () => stepPhotoCloud(held, heldCloud, { pointer: { x: 0, y: 0 }, strength: CLOUD_POINTERS.pull });
  for (let step = 0; step < 600; step++) gatherTo();
  const resting = held.positions[0];
  const wobble = [];
  for (let step = 0; step < 20; step++) { gatherTo(); wobble.push(Math.abs(held.positions[0] - resting)); }
  assert.ok(resting > 0 && resting < 20, `the gather stops between the cursor and home (${resting.toFixed(2)})`);
  assert.ok(Math.max(...wobble) < .01, `the fixed point attracts instead of oscillating (${Math.max(...wobble).toFixed(5)} px)`);
});

test('drawPhotoCloud writes tinted dots into a reusable frame buffer', () => {
  const { ctx, calls } = frame();
  const cloud = { count: 1, points: new Float32Array(7) };
  const pixel = (image, x, y) => Array.from(image.data.slice((y * image.width + x) * 4, (y * image.width + x) * 4 + 4));
  const pool = createPhotoPool(2, 0, 0, () => 0);
  pool.colors.set([1, 0, 0, 1, 0, 1, 0, 0]);
  const buffer = { width: 8, height: 6, image: ctx.createImageData(8, 6) };
  assert.equal(drawPhotoCloud(ctx, pool, cloud, { width: 8, height: 6, size: 3, buffer }), true);
  assert.equal(calls.putImageData, 1, 'one buffer upload per frame');
  assert.deepEqual(pixel(buffer.image, 0, 0), [255, 0, 0, 255], 'the opaque dot is painted');
  assert.deepEqual(pixel(buffer.image, 5, 3), [0, 0, 0, 0], 'surplus/transparent points are skipped');
  // The depth parallax shifts dots with the pointer.
  const parallax = createPhotoPool(1, 0, 0, () => 0);
  parallax.colors[3] = 1; parallax.positions[2] = 1;
  const shift = { width: 20, height: 20, image: ctx.createImageData(20, 20) };
  drawPhotoCloud(ctx, parallax, cloud, { width: 20, height: 20, size: 3, buffer: shift, centerX: 0, centerY: 0, pointer: { x: 100, y: 50 } });
  assert.deepEqual(pixel(shift.image, 3, 2), [128, 128, 128, 255], 'the pointer depth parallax shifts the dot');
  drawPhotoCloud(ctx, parallax, cloud, { width: 20, height: 20, size: 3, buffer: shift, centerX: 0, centerY: 0 });
  assert.deepEqual(pixel(shift.image, 3, 2), [0, 0, 0, 0], 'without the pointer it sits at its home pixel');
  assert.equal(drawPhotoCloud(null, pool, cloud), false);
  assert.equal(drawPhotoCloud({}, pool, cloud), false, 'no 2D context means no work');
});

test('the default dot is a single pixel', () => {
  const { ctx } = frame();
  const cloud = { count: 2, points: new Float32Array(14) };
  const pool = createPhotoPool(2, 0, 0, () => 0);
  pool.colors.set([1, 1, 1, 1, 1, 1, 1, 1]);
  pool.positions.set([0, 0, 0, 5, 3, 0]);
  const buffer = { width: 20, height: 12, image: ctx.createImageData(20, 12) };
  drawPhotoCloud(ctx, pool, cloud, { width: 20, height: 12, buffer, centerX: 10, centerY: 6 });
  let inked = 0;
  for (let i = 3; i < buffer.image.data.length; i += 4) if (buffer.image.data[i] > 8) inked++;
  assert.equal(inked, 2, 'exactly one pixel per visible point');
  const pixel = (x, y) => Array.from(buffer.image.data.slice((y * 20 + x) * 4, (y * 20 + x) * 4 + 3));
  assert.deepEqual(pixel(10, 6), [255, 255, 255], 'the point at the centre is one pixel');
  assert.deepEqual(pixel(15, 3), [255, 255, 255], 'so is the second point');
});

test('the cloud is centred on the canvas with the photo the right way up', () => {
  const { ctx } = frame();
  const cloud = { count: 1, points: new Float32Array(7) };
  const pixel = (image, x, y) => Array.from(image.data.slice((y * image.width + x) * 4, (y * image.width + x) * 4 + 4));
  const centre = { width: 40, height: 30, image: ctx.createImageData(40, 30) };
  const pool = createPhotoPool(1, 0, 0, () => 0);   // one dot at cloud (0, 0), z -1
  pool.colors.set([1, 1, 1, 1]);
  drawPhotoCloud(ctx, pool, cloud, { width: 40, height: 30, size: 3, buffer: centre, centerX: 20, centerY: 15 });
  assert.deepEqual(pixel(centre.image, 19, 14), [255, 255, 255, 255], 'the cloud lands on the canvas centre');
  // Cloud space is Y-up, so a point above the middle is drawn above the middle.
  const above = createPhotoPool(1, 0, 0, () => 0);
  above.colors[3] = 1; above.positions[1] = 5;
  const upright = { width: 40, height: 30, image: ctx.createImageData(40, 30) };
  drawPhotoCloud(ctx, above, cloud, { width: 40, height: 30, size: 3, buffer: upright, centerX: 20, centerY: 15 });
  assert.deepEqual(pixel(upright.image, 19, 10), [128, 128, 128, 255], 'a Y-up point is drawn above the centre');
  assert.deepEqual(pixel(upright.image, 19, 22), [0, 0, 0, 0], 'and never below it');
});
