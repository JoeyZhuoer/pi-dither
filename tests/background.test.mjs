import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_GROUND, DEFAULT_THEME, GROUND_KEY, MAX_CELLS, MAX_EDGE, MAX_PHOTO_CHARS, PHOTO_KEY, THEME_KEY,
  backgroundSize, ditherPhoto, normalizeColor, readBackground, removePhoto, writeColor, writePhoto,
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

test('colours are normalized and invalid input falls back to the default', () => {
  assert.equal(normalizeColor('#AABBCC'), '#aabbcc');
  assert.equal(normalizeColor('#aBc'), '#aabbcc');
  assert.equal(normalizeColor(' #123456 '), '#123456');
  for (const bad of ['', null, undefined, 'red', '#12345', '#1234567', 'javascript:alert(1)', 42, {}]) assert.equal(normalizeColor(bad), null);
  const storage = fakeStorage();
  assert.equal(writeColor(storage, GROUND_KEY, 'nonsense', DEFAULT_GROUND), DEFAULT_GROUND);
  assert.equal(storage.map.get(GROUND_KEY), DEFAULT_GROUND);
  assert.equal(writeColor(storage, GROUND_KEY, '#102030', DEFAULT_GROUND), '#102030');
  assert.equal(writeColor(storage, THEME_KEY, '#0a0b0c', DEFAULT_THEME), '#0a0b0c');
  assert.equal(writeColor(fakeStorage({}, true), THEME_KEY, '#0a0b0c', DEFAULT_THEME), '#0a0b0c', 'denied storage still reports the applied colour');
});

test('stored appearance settings are validated and optional storage never throws', () => {
  const stored = fakeStorage({ [THEME_KEY]: '#203040', [GROUND_KEY]: '#203040', [PHOTO_KEY]: 'data:image/png;base64,iVBORw0KGgo=' });
  assert.deepEqual(readBackground(stored), { theme: '#203040', ground: '#203040', photo: 'data:image/png;base64,iVBORw0KGgo=' });
  assert.deepEqual(readBackground(fakeStorage({ [THEME_KEY]: 'purple', [GROUND_KEY]: 'purple', [PHOTO_KEY]: 'javascript:x' })), { theme: DEFAULT_THEME, ground: DEFAULT_GROUND, photo: '' });
  assert.deepEqual(readBackground(fakeStorage({ [PHOTO_KEY]: 'data:image/png;base64,' + 'A'.repeat(MAX_PHOTO_CHARS) })), { theme: DEFAULT_THEME, ground: DEFAULT_GROUND, photo: '' });
  assert.deepEqual(readBackground(null), { theme: DEFAULT_THEME, ground: DEFAULT_GROUND, photo: '' });
  assert.deepEqual(readBackground(fakeStorage({}, true)), { theme: DEFAULT_THEME, ground: DEFAULT_GROUND, photo: '' });
  assert.equal(writePhoto(fakeStorage(), 'data:image/png;base64,AAA'), true);
  assert.equal(writePhoto(fakeStorage(), 'nope'), false);
  const denied = fakeStorage({}, true);
  assert.equal(writePhoto(denied, 'data:image/png;base64,AAA'), false);
  assert.doesNotThrow(() => removePhoto(denied));
});

test('bitmap size is pixel-precise for normal windows and bounded for huge ones', () => {
  assert.deepEqual(backgroundSize(480, 300), { width: 480, height: 300 }, 'one cell per CSS pixel');
  assert.deepEqual(backgroundSize(1440, 940), { width: 1440, height: 940 }, 'typical app window stays 1:1');
  assert.deepEqual(backgroundSize(1920, 1080), { width: 1920, height: 1080 }, 'full HD stays 1:1');
  for (const [width, height] of [[1e9, 1e9], [1e9, 1], [0, NaN], [-5, -5]]) {
    const size = backgroundSize(width, height);
    assert.ok(size.width >= 1 && size.height >= 1 && size.width * size.height <= MAX_CELLS && size.width <= MAX_EDGE && size.height <= MAX_EDGE);
  }
});

// The mask decides which photo pixels become cloud points, so tonality has to
// survive: dark areas carry points, light areas stay bare.
test('dither sampling keeps photo tonality and is deterministic', () => {
  assert.ok(ditherPhoto(rgba(8, 8, [255, 255, 255]), 8, 8).every((cell) => cell === 0), 'white stays bare');
  assert.ok(ditherPhoto(rgba(8, 8, [0, 0, 0]), 8, 8).every((cell) => cell === 1), 'black carries points');
  const mid = ditherPhoto(rgba(8, 8, [128, 128, 128]), 8, 8);
  const inked = mid.reduce((sum, cell) => sum + cell, 0);
  assert.ok(inked > 20 && inked < 44, `mid grey samples near half (${inked}/64)`);
  assert.deepEqual([...mid], [...ditherPhoto(rgba(8, 8, [128, 128, 128]), 8, 8)], 'deterministic');
  assert.notDeepEqual([...ditherPhoto(rgba(8, 8, [128, 0, 0]), 8, 8)], [...mid], 'luminance weighting matters');
});
