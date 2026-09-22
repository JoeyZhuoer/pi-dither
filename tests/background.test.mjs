import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_GROUND, DEFAULT_THEME, GROUND_KEY, MAX_CELLS, MAX_EDGE, MAX_PHOTO_CHARS, PHOTO_KEY, RIPPLE_LINK, RIPPLE_LINK_GAP, RIPPLE_RADIUS, RIPPLE_SPREAD, RIPPLE_SWIRL, THEME_KEY,
  backgroundSize, ditherPhoto, normalizeColor, paintBackground, readBackground, removePhoto, rippleLinks, rippleMask, rippleRegion, writeColor, writePhoto,
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
  const paints = [];
  const ctx = {
    createImageData(width, height) { return { width, height, data: new Uint8ClampedArray(width * height * 4) }; },
    putImageData(image, x, y) { paints.push({ image, x, y }); },
  };
  return { canvas: { width: 0, height: 0, getContext: () => ctx }, paints };
}
const pixel = (image, x, y) => Array.from(image.data.slice((y * image.width + x) * 4, (y * image.width + x) * 4 + 4));
const blank = (width, height) => new Uint8Array(width * height);
const dot = (mask, width, x, y) => { mask[y * width + x] = 1; return mask; };

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

test('photo dithering is deterministic ordered dithering in the ink', () => {
  assert.ok(ditherPhoto(rgba(8, 8, [255, 255, 255]), 8, 8).every((cell) => cell === 0), 'white stays ground');
  assert.ok(ditherPhoto(rgba(8, 8, [0, 0, 0]), 8, 8).every((cell) => cell === 1), 'black turns to ink');
  const mid = ditherPhoto(rgba(8, 8, [128, 128, 128]), 8, 8);
  const inked = mid.reduce((sum, cell) => sum + cell, 0);
  assert.ok(inked > 20 && inked < 44, `mid grey dithers near half (${inked}/64)`);
  assert.deepEqual([...mid], [...ditherPhoto(rgba(8, 8, [128, 128, 128]), 8, 8)], 'deterministic');
  assert.notDeepEqual([...ditherPhoto(rgba(8, 8, [128, 0, 0]), 8, 8)], [...mid], 'luminance weighting matters');
});

test('painting writes one precise pixel buffer with ground and ink colours', () => {
  const { canvas, paints } = frame();
  paintBackground(canvas, { ground: '#112233', width: 4, height: 2, ink: Uint8Array.from([1, 0, 1, 0, 0, 1, 0, 1]) });
  assert.equal(canvas.width, 4); assert.equal(canvas.height, 2);
  assert.equal(paints.length, 1, 'a single ImageData paint');
  assert.deepEqual([paints[0].x, paints[0].y], [0, 0]);
  const image = paints[0].image;
  assert.deepEqual(pixel(image, 0, 0), [32, 32, 31, 255], 'ink pixel');
  assert.deepEqual(pixel(image, 1, 0), [17, 34, 51, 255], 'ground pixel');
  assert.deepEqual(pixel(image, 2, 0), [32, 32, 31, 255]);
  assert.deepEqual(pixel(image, 1, 1), [32, 32, 31, 255]);
  assert.deepEqual(pixel(image, 3, 1), [32, 32, 31, 255]);
  assert.deepEqual(pixel(image, 0, 1), [17, 34, 51, 255]);
  const plain = frame();
  paintBackground(plain.canvas, { ground: '#445566', width: 3, height: 3 });
  assert.equal(plain.paints.length, 1);
  assert.deepEqual(pixel(plain.paints[0].image, 2, 2), [68, 85, 102, 255], 'flat ground');
  // A region paint writes a smaller buffer at its own offset.
  const region = { x: 1, y: 1, width: 2, height: 1 };
  paintBackground(canvas, { ground: '#112233', width: 4, height: 2, ink: Uint8Array.from([1, 0]), region });
  const last = paints.at(-1);
  assert.deepEqual([last.x, last.y, last.image.width, last.image.height], [1, 1, 2, 1]);
  assert.deepEqual(pixel(last.image, 0, 0), [32, 32, 31, 255], 'region ink pixel');
  assert.deepEqual(pixel(last.image, 1, 0), [17, 34, 51, 255], 'region ground pixel');
  assert.equal(paintBackground(null, { ground: '#000000', width: 1, height: 1 }), false);
  assert.equal(paintBackground({ width: 0, height: 0, getContext: () => ({}) }, { ground: '#000000', width: 1, height: 1 }), false);
});

test('pointer ripples spread dots outward and fade back to the exact base', () => {
  const width = 40, height = 40, mask = blank(width, height);
  dot(mask, width, 20, 20); dot(mask, width, 22, 20); dot(mask, width, 20, 23); dot(mask, width, 16, 16);
  const base = Uint8Array.from(mask);
  const region = rippleRegion(width, height, { x: 20.5, y: 20.5 });
  assert.ok(region.width > 0 && region.height > 0 && region.x >= 0 && region.y >= 0 && region.x + region.width <= width && region.y + region.height <= height);
  // Strength 0 restores the base inside the region exactly.
  const restored = rippleMask(base, width, region, { x: 20.5, y: 20.5, strength: 0 });
  for (let y = 0; y < region.height; y++) for (let x = 0; x < region.width; x++) {
    assert.equal(restored[y * region.width + x], base[(region.y + y) * width + region.x + x], 'base copy');
  }
  // A full-strength ripple pushes the neighbours outward, growing their
  // distance from the pointer; the exact centre stays as the fixed point of the
  // radial spread.
  const spread = rippleMask(base, width, region, { x: 20.5, y: 20.5, strength: 1 });
  const at = (maskToRead, x, y) => maskToRead[(y - region.y) * region.width + (x - region.x)];
  assert.equal(at(spread, 20, 20), 1, 'the exact centre stays put');
  // Each neighbour lands exactly where the radial spread puts it.
  const landing = (px, py) => {
    const dx = px + .5 - 20.5, dy = py + .5 - 20.5, distance = Math.hypot(dx, dy);
    const falloff = 1 - distance / RIPPLE_RADIUS;
    const angle = RIPPLE_SWIRL * falloff;
    const cos = Math.cos(angle), sin = Math.sin(angle);
    const scale = 1 + RIPPLE_SPREAD * falloff;
    return [Math.round(20.5 + (dx * cos - dy * sin) * scale - .5), Math.round(20.5 + (dx * sin + dy * cos) * scale - .5)];
  };
  for (const from of [[22, 20], [20, 23], [16, 16]]) {
    const to = landing(...from);
    assert.notDeepEqual(to, from, `dot ${from} moves`);
    assert.equal(at(spread, ...from), 0, `dot ${from} left its cell`);
    assert.equal(at(spread, ...to), 1, `dot ${from} landed at ${to}`);
    assert.ok(Math.hypot(to[0] + .5 - 20.5, to[1] + .5 - 20.5) > Math.hypot(from[0] + .5 - 20.5, from[1] + .5 - 20.5), `dot ${from} moved outward`);
  }
  // Collectively the dots inside the radius spread away from the pointer.
  const meanDistance = (read) => {
    let total = 0, count = 0;
    for (let y = region.y; y < region.y + region.height; y++) for (let x = region.x; x < region.x + region.width; x++) {
      if (!read(x, y)) continue;
      const distance = Math.hypot(x + .5 - 20.5, y + .5 - 20.5);
      if (distance >= RIPPLE_RADIUS) continue;
      total += distance; count++;
    }
    return count ? total / count : 0;
  };
  const baseMean = meanDistance((x, y) => base[y * width + x]);
  const spreadMean = meanDistance((x, y) => spread[(y - region.y) * region.width + (x - region.x)]);
  assert.ok(spreadMean > baseMean, `mean dot distance grows (${spreadMean.toFixed(1)} > ${baseMean.toFixed(1)})`);
  // Ripple cells never leak outside the region bounding box.
  assert.equal(spread.length, region.width * region.height);
  assert.deepEqual(rippleMask(base, width, rippleRegion(width, height, { x: 0, y: 0 }), { x: 0, y: 0, strength: 1 }).length, rippleRegion(width, height, { x: 0, y: 0 }).width * rippleRegion(width, height, { x: 0, y: 0 }).height);
  assert.ok(RIPPLE_RADIUS > 0 && RIPPLE_RADIUS <= 32, `interaction radius stays moderate (${RIPPLE_RADIUS}px)`);
});

test('pointer links fan out to distinct nearby dots like the reference field', () => {
  const width = 80, height = 80, mask = blank(width, height);
  // A dense 2px grid plus one isolated dot: spacing must keep the fan readable.
  for (let y = 30; y < 50; y += 2) for (let x = 30; x < 50; x += 2) dot(mask, width, x, y);
  dot(mask, width, 40, 12);
  const region = { x: 0, y: 0, width, height };
  const links = rippleLinks(mask, width, region, { x: 40.5, y: 40.5 });
  assert.ok(links.length > 0 && links.length <= 20, `a bounded fan of links (${links.length})`);
  assert.ok(links.every((link) => link[0] === 40.5 && link[1] === 40.5), 'all links start at the pointer');
  assert.ok(links.every((link) => Math.hypot(link[2] - 40.5, link[3] - 40.5) <= RIPPLE_LINK), 'links stay inside the radius');
  assert.ok(links.every((link) => link[4] > 0 && link[4] <= .32), 'alpha fades with distance');
  for (let i = 0; i < links.length; i++) for (let j = i + 1; j < links.length; j++) {
    assert.ok(Math.hypot(links[i][2] - links[j][2], links[i][3] - links[j][3]) >= RIPPLE_LINK_GAP, 'kept dots are spaced apart');
  }
  assert.deepEqual(rippleLinks(mask, width, region, { x: 40.5, y: 40.5 }), links, 'deterministic');
  assert.deepEqual(rippleLinks(mask, width, region, { x: 400, y: 400 }), [], 'nothing to link far away');
  // Blending a link into the painted region darkens the ground along the line.
  const { canvas, paints } = frame();
  paintBackground(canvas, { ground: '#ffffff', width: 8, height: 8, ink: blank(8, 8), links: [[0, 0, 7, 7, .3]] });
  const image = paints[0].image;
  const line = pixel(image, 0, 0), ground = pixel(image, 7, 0);
  assert.ok(line[0] < ground[0], `the linked pixel is darker (${line[0]} < ${ground[0]})`);
  assert.equal(line[3], 255, 'links stay opaque');
});
