import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  LINK_DISTANCE, PARTICLE_MODES, POINTER_RADIUS, createField, drawField, linkPairs, particleCount, particleMode, readParticles, stepField, writeParticles,
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
    fillRect() { calls.fillRect++; },
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

test('the pointer stirs nearby particles only', () => {
  const field = { width: 400, height: 400, particles: [
    { x: 200, y: 200, vx: 0, vy: 0, r: 1 },
    { x: 200 + POINTER_RADIUS + 40, y: 200, vx: 0, vy: 0, r: 1 },
  ], flashes: [] };
  stepField(field, { width: 400, height: 400, seconds: 1 / 30, pointer: { x: 200, y: 200 } });
  assert.ok(Math.hypot(field.particles[0].vx, field.particles[0].vy) > 0, 'the near particle is pushed');
  assert.equal(field.particles[1].vx, 0); assert.equal(field.particles[1].vy, 0, 'the far particle is untouched');
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
  assert.equal(drawField(ctx, field, { pointer: { x: 12, y: 12 } }), true);
  assert.equal(calls.fillRect, 3, 'one dot per particle');
  assert.ok(calls.lineTo >= 2, 'a link and a pointer link are stroked');
  assert.equal(calls.strokeRect, 1, 'one collision flash');
  assert.ok(calls.styles.some((style) => style.startsWith('rgba(')), 'links fade with distance');
  assert.ok(calls.styles.every((style) => !style.includes('NaN')));
  assert.equal(drawField(null, field), false);
});
