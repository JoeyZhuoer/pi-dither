import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_GROUND, GROUND_KEY, INK, MAX_PHOTO_CHARS, PHOTO_KEY,
  backgroundSize, ditherPhoto, normalizeGround, paintBackground, readBackground, removePhoto, writeGround, writePhoto,
} from '../desktop/public/background.js';

function fakeStorage(initial = {}, deny = false) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (key) => { if (deny) throw new Error('denied'); return map.has(key) ? map.get(key) : null; },
    setItem: (key, value) => { if (deny) throw new Error('denied'); map.set(key, String(value)); },
    removeItem: (key) => { if (deny) throw new Error('denied'); map.delete(key); },
  };
}

function rgba(width, height, [r, g, b, a = 255]) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let index = 0; index < width * height; index++) { data[index * 4] = r; data[index * 4 + 1] = g; data[index * 4 + 2] = b; data[index * 4 + 3] = a; }
  return data;
}

function frame() {
  const fills = [];
  const ctx = { fillStyle: '', fillRect(x, y, w, h) { fills.push({ style: ctx.fillStyle, x, y, w, h }); } };
  return { canvas: { width: 0, height: 0, getContext: () => ctx }, fills };
}

test('ground colours are normalized and invalid input falls back to the default', () => {
  assert.equal(normalizeGround('#AABBCC'), '#aabbcc');
  assert.equal(normalizeGround('#aBc'), '#aabbcc');
  assert.equal(normalizeGround(' #123456 '), '#123456');
  for (const bad of ['', null, undefined, 'red', '#12345', '#1234567', 'javascript:alert(1)', 42, {}]) assert.equal(normalizeGround(bad), null);
  const storage = fakeStorage();
  assert.equal(writeGround(storage, 'nonsense'), DEFAULT_GROUND);
  assert.equal(storage.map.get(GROUND_KEY), DEFAULT_GROUND);
  assert.equal(writeGround(storage, '#102030'), '#102030');
});

test('stored background settings are validated and optional storage never throws', () => {
  const stored = fakeStorage({ [GROUND_KEY]: '#203040', [PHOTO_KEY]: 'data:image/png;base64,iVBORw0KGgo=' });
  assert.deepEqual(readBackground(stored), { ground: '#203040', photo: 'data:image/png;base64,iVBORw0KGgo=' });
  assert.deepEqual(readBackground(fakeStorage({ [GROUND_KEY]: 'purple', [PHOTO_KEY]: 'javascript:x' })), { ground: DEFAULT_GROUND, photo: '' });
  assert.deepEqual(readBackground(fakeStorage({ [PHOTO_KEY]: 'data:image/png;base64,' + 'A'.repeat(MAX_PHOTO_CHARS) })), { ground: DEFAULT_GROUND, photo: '' });
  assert.deepEqual(readBackground(null), { ground: DEFAULT_GROUND, photo: '' });
  assert.deepEqual(readBackground(fakeStorage({}, true)), { ground: DEFAULT_GROUND, photo: '' });
  assert.equal(writePhoto(fakeStorage(), 'data:image/png;base64,AAA'), true);
  assert.equal(writePhoto(fakeStorage(), 'nope'), false);
  const denied = fakeStorage({}, true);
  assert.equal(writePhoto(denied, 'data:image/png;base64,AAA'), false);
  assert.doesNotThrow(() => removePhoto(denied));
});

test('bitmap size is bounded independently of the viewport', () => {
  assert.deepEqual(backgroundSize(480, 300), { width: 160, height: 100 });
  for (const [width, height] of [[1e9, 1e9], [1e9, 1], [0, NaN], [-5, -5]]) {
    const size = backgroundSize(width, height);
    assert.ok(size.width >= 1 && size.height >= 1 && size.width * size.height <= 100_000 && size.width <= 2048 && size.height <= 2048);
  }
});

test('photo dithering is deterministic ordered dithering in the ink', () => {
  assert.ok(ditherPhoto(rgba(8, 8, [255, 255, 255]), 8, 8).every((cell) => cell === 0), 'white stays ground');
  assert.ok(ditherPhoto(rgba(8, 8, [0, 0, 0]), 8, 8).every((cell) => cell === 1), 'black turns to ink');
  const mid = ditherPhoto(rgba(8, 8, [128, 128, 128]), 8, 8);
  const inked = mid.reduce((sum, cell) => sum + cell, 0);
  assert.ok(inked > 20 && inked < 44, `mid grey dithers near half (${inked}/64)`);
  assert.deepEqual([...mid], [...ditherPhoto(rgba(8, 8, [128, 128, 128]), 8, 8)], 'deterministic');
  assert.notDeepEqual([...ditherPhoto(rgba(8, 8, [128, 0, 0]), 8, 8)], [...mid], 'luminance weighting matters');
});

test('painting fills the ground first and then the dither cells', () => {
  const { canvas, fills } = frame();
  paintBackground(canvas, { ground: '#112233', width: 4, height: 2, ink: Uint8Array.from([1, 0, 1, 0, 0, 1, 0, 1]) });
  assert.equal(canvas.width, 4); assert.equal(canvas.height, 2);
  assert.deepEqual(fills[0], { style: '#112233', x: 0, y: 0, w: 4, h: 2 });
  const ink = fills.slice(1);
  assert.equal(ink.length, 4);
  assert.ok(ink.every((fill) => fill.style === INK && fill.w === 1 && fill.h === 1));
  assert.deepEqual(ink.map((fill) => `${fill.x},${fill.y}`), ['0,0', '2,0', '1,1', '3,1']);
  const plain = frame();
  paintBackground(plain.canvas, { ground: '#445566', width: 3, height: 3 });
  assert.equal(plain.fills.length, 1);
  assert.equal(paintBackground(null, { ground: '#000000', width: 1, height: 1 }), false);
});
