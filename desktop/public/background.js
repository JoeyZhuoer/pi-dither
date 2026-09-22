// User-controlled appearance: a theme (accent) colour, a ground colour and an
// optional photo rendered as an ordered dither in the same ink as the rest of
// the desktop. The base image is static; the only animation is the short
// pointer ripple over the dots, which repaints just the affected region.
// Exported helpers are pure so they can be tested without a browser.
export const THEME_KEY = 'pi-desktop:theme:v1';
export const GROUND_KEY = 'pi-desktop:ground:v1';
export const PHOTO_KEY = 'pi-desktop:photo:v1';
export const DEFAULT_THEME = '#e58da5';
export const DEFAULT_GROUND = '#e58da5';
export const INK = '#20201f';
export const MAX_PHOTO_CHARS = 900_000;
export const RIPPLE_RADIUS = 26;
export const RIPPLE_SPREAD = 1.6;
export const RIPPLE_SWIRL = .45;
export const RIPPLE_LINK = 90;
export const RIPPLE_LINKS = 20;
export const RIPPLE_LINK_GAP = 7;
export const RIPPLE_MS = 1000;
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
// One cell per CSS pixel keeps the dither dots small and the photo precise; the
// budget still bounds very large windows. Painting is a single static buffer.
const CELL = 1;
export const MAX_CELLS = 4_000_000, MAX_EDGE = 4096;

export function normalizeColor(value) {
  const text = String(value ?? '').trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(text)) return text;
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(text);
  return short ? `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}` : null;
}

// Bitmap size: one cell per CSS pixel (dot size ~1px), bounded for huge windows.
export function backgroundSize(viewportWidth, viewportHeight) {
  const cols = Math.ceil(Math.max(1, Number(viewportWidth) || 1) / CELL);
  const rows = Math.ceil(Math.max(1, Number(viewportHeight) || 1) / CELL);
  const scale = Math.min(1, Math.sqrt(MAX_CELLS / cols / rows), MAX_EDGE / cols, MAX_EDGE / rows);
  return { width: Math.max(1, Math.floor(cols * scale)), height: Math.max(1, Math.floor(rows * scale)) };
}

// Ordered-dither mask for one photo sample: 1 = ink, 0 = ground. Darker pixels
// cross the Bayer threshold more often, so photos read as dithered shading.
export function ditherPhoto(pixels, width, height) {
  const ink = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const at = (y * width + x) * 4;
    const luminance = .2126 * pixels[at] + .7152 * pixels[at + 1] + .0722 * pixels[at + 2];
    // A slight gamma lift keeps mid-tones from going muddy under a hard threshold.
    const level = Math.min(255, Math.max(0, (luminance / 255) ** .9 * 255));
    ink[y * width + x] = level < (BAYER[(y % 4) * 4 + x % 4] + .5) / 16 * 255 ? 1 : 0;
  }
  return ink;
}

const rgb = (hex) => {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/.exec(String(hex || '').toLowerCase());
  return match ? [parseInt(match[1], 16), parseInt(match[2], 16), parseInt(match[3], 16)] : [0, 0, 0];
};

// Ground fill plus ink pixels written as one ImageData buffer, so the dither
// stays pixel-precise. `region` paints only that sub-rectangle (used by the
// pointer ripple); `ink` is then region-sized, otherwise full-bitmap sized.
export function paintBackground(canvas, { ground, width, height, ink, region, links }) {
  const ctx = canvas?.getContext?.('2d');
  if (!ctx || typeof ctx.createImageData !== 'function' || typeof ctx.putImageData !== 'function') return false;
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  const area = region && region.width > 0 && region.height > 0 ? region : { x: 0, y: 0, width, height };
  const [groundRed, groundGreen, groundBlue] = rgb(ground), [inkRed, inkGreen, inkBlue] = rgb(INK);
  const image = ctx.createImageData(area.width, area.height), data = image.data;
  for (let index = 0, at = 0; index < area.width * area.height; index++, at += 4) {
    const useInk = ink && ink[index];
    data[at] = useInk ? inkRed : groundRed;
    data[at + 1] = useInk ? inkGreen : groundGreen;
    data[at + 2] = useInk ? inkBlue : groundBlue;
    data[at + 3] = 255;
  }
  if (links) for (const [fromX, fromY, toX, toY, alpha] of links) {
    const strength = Math.max(0, Math.min(1, Number(alpha) || 0));
    if (strength > 0) blendLine(data, area, fromX, fromY, toX, toY, inkRed, inkGreen, inkBlue, strength);
  }
  ctx.putImageData(image, area.x, area.y);
  return true;
}

// Bounding box of the dots a ripple can touch, with room for outward motion.
export function rippleRegion(width, height, { x, y, radius = RIPPLE_RADIUS }) {
  const reach = Math.ceil(radius * (1 + RIPPLE_SPREAD * .35)) + 2;
  const x0 = Math.max(0, Math.floor(x - reach)), y0 = Math.max(0, Math.floor(y - reach));
  const x1 = Math.min(width, Math.ceil(x + reach)), y1 = Math.min(height, Math.ceil(y + reach));
  return { x: x0, y: y0, width: Math.max(0, x1 - x0), height: Math.max(0, y1 - y0) };
}

// Region-local mask for one ripple frame: dots inside the radius slide outward
// and swirl around the pointer, so the field stirs like the site's particles;
// everything else copies the base. `strength` in [0,1] fades back exactly.
export function rippleMask(baseInk, width, region, { x, y, radius = RIPPLE_RADIUS, strength = 1 } = {}) {
  const mask = new Uint8Array(region.width * region.height);
  if (!baseInk || region.width <= 0 || region.height <= 0) return mask;
  for (let row = 0; row < region.height; row++) for (let col = 0; col < region.width; col++) {
    if (baseInk[(region.y + row) * width + region.x + col]) mask[row * region.width + col] = 1;
  }
  if (!(strength > 0)) return mask;
  for (let row = 0; row < region.height; row++) for (let col = 0; col < region.width; col++) {
    const px = region.x + col, py = region.y + row, source = py * width + px;
    if (!baseInk[source]) continue;
    const dx = px + .5 - x, dy = py + .5 - y, distance = Math.hypot(dx, dy);
    if (distance >= radius) continue;
    mask[row * region.width + col] = 0;
    const falloff = 1 - distance / radius;
    const angle = strength * RIPPLE_SWIRL * falloff;
    const cos = Math.cos(angle), sin = Math.sin(angle);
    const rotatedX = dx * cos - dy * sin, rotatedY = dx * sin + dy * cos;
    const scale = 1 + strength * RIPPLE_SPREAD * falloff;
    const targetX = Math.round(x + rotatedX * scale - .5), targetY = Math.round(y + rotatedY * scale - .5);
    if (targetX < region.x || targetY < region.y || targetX >= region.x + region.width || targetY >= region.y + region.height) continue;
    mask[(targetY - region.y) * region.width + (targetX - region.x)] = 1;
  }
  return mask;
}

// Faint pointer links in the site's constellation style: the nearest inked
// dots around the cursor, spaced apart so the lines fan out instead of piling
// on one dense patch. Returned as [fromX, fromY, toX, toY, alpha] segments.
export function rippleLinks(baseInk, width, region, { x, y, radius = RIPPLE_LINK, limit = RIPPLE_LINKS, spacing = RIPPLE_LINK_GAP } = {}) {
  if (!baseInk || !(radius > 0)) return [];
  const candidates = [];
  for (let row = 0; row < region.height; row++) for (let col = 0; col < region.width; col++) {
    const px = region.x + col, py = region.y + row;
    if (!baseInk[py * width + px]) continue;
    const distance = Math.hypot(px + .5 - x, py + .5 - y);
    if (distance <= radius) candidates.push({ x: px + .5, y: py + .5, distance });
  }
  candidates.sort((left, right) => left.distance - right.distance);
  const kept = [];
  for (const dot of candidates) {
    if (kept.length >= Math.max(1, limit)) break;
    if (kept.some((other) => Math.hypot(other.x - dot.x, other.y - dot.y) < spacing)) continue;
    kept.push(dot);
  }
  return kept.map((dot) => [x, y, dot.x, dot.y, .32 * (1 - dot.distance / radius)]);
}

// Blends one 1px segment into an already-filled region buffer.
function blendLine(data, area, x0, y0, x1, y1, red, green, blue, alpha) {
  let x = Math.round(x0), y = Math.round(y0);
  const endX = Math.round(x1), endY = Math.round(y1);
  const spanX = Math.abs(endX - x), spanY = Math.abs(endY - y);
  const stepX = x < endX ? 1 : -1, stepY = y < endY ? 1 : -1;
  let error = spanX - spanY;
  for (;;) {
    const localX = x - area.x, localY = y - area.y;
    if (localX >= 0 && localY >= 0 && localX < area.width && localY < area.height) {
      const at = (localY * area.width + localX) * 4;
      data[at] = data[at] * (1 - alpha) + red * alpha;
      data[at + 1] = data[at + 1] * (1 - alpha) + green * alpha;
      data[at + 2] = data[at + 2] * (1 - alpha) + blue * alpha;
    }
    if (x === endX && y === endY) break;
    const doubled = 2 * error;
    if (doubled > -spanY) { error -= spanY; x += stepX; }
    if (doubled < spanX) { error += spanX; y += stepY; }
  }
}

export function readBackground(storage) {
  const state = { theme: DEFAULT_THEME, ground: DEFAULT_GROUND, photo: '' };
  try {
    state.theme = normalizeColor(storage?.getItem(THEME_KEY)) || DEFAULT_THEME;
    state.ground = normalizeColor(storage?.getItem(GROUND_KEY)) || DEFAULT_GROUND;
    const photo = String(storage?.getItem(PHOTO_KEY) ?? '');
    if (/^data:image\/(?:png|jpeg|webp);base64,/.test(photo) && photo.length <= MAX_PHOTO_CHARS) state.photo = photo;
  } catch { /* Storage is optional; defaults are fine. */ }
  return state;
}

export function writeColor(storage, key, value, fallback) {
  const color = normalizeColor(value) || fallback;
  try { storage?.setItem(key, color); } catch { /* Optional storage. */ }
  return color;
}

export function writePhoto(storage, dataUrl) {
  if (!/^data:image\/(?:png|jpeg|webp);base64,/.test(String(dataUrl || '')) || dataUrl.length > MAX_PHOTO_CHARS) return false;
  try { storage.setItem(PHOTO_KEY, dataUrl); return true; } catch { return false; }
}

export function removePhoto(storage) {
  try { storage?.removeItem(PHOTO_KEY); } catch { /* Optional storage. */ }
}

const readFile = (file, doc) => new Promise((resolve, reject) => {
  const reader = new doc.defaultView.FileReader();
  reader.onerror = () => reject(new Error('The photo could not be read.'));
  reader.onload = () => resolve(String(reader.result || ''));
  reader.readAsDataURL(file);
});

const decodeImage = (dataUrl, doc) => new Promise((resolve, reject) => {
  const image = doc.createElement('img');
  image.onload = () => resolve(image);
  image.onerror = () => reject(new Error('That file is not a readable image.'));
  image.src = dataUrl;
});

// Re-encode at a bounded edge so a normal photo fits in local storage.
function encodeImage(image, maxEdge, quality, doc) {
  const scale = Math.min(1, maxEdge / Math.max(image.naturalWidth, image.naturalHeight));
  const width = Math.max(1, Math.round(image.naturalWidth * scale));
  const height = Math.max(1, Math.round(image.naturalHeight * scale));
  const scratch = doc.createElement('canvas');
  scratch.width = width; scratch.height = height;
  scratch.getContext('2d').drawImage(image, 0, 0, width, height);
  return scratch.toDataURL('image/jpeg', quality);
}

export function createBackground({ canvas, storage, onPhotoChange, document: doc = canvas?.ownerDocument ?? globalThis.document } = {}) {
  const state = readBackground(storage);
  let image = null, baseInk = null, bitmapWidth = 0, bitmapHeight = 0;
  let resizeTimer = null, frame = null, lastFrame = 0, lastRegion = null, pointer = null, ripple = 0, disposed = false;
  const view = () => doc?.defaultView ?? globalThis;
  const size = () => backgroundSize(view()?.innerWidth ?? canvas?.clientWidth, view()?.innerHeight ?? canvas?.clientHeight);

  // Cover-fits the current photo into a scratch canvas and reads it back, so
  // both the dither and the particle point cloud sample the same pixels.
  function readPhoto(width, height) {
    if (!image || !image.naturalWidth) return null;
    const scratch = doc.createElement('canvas');
    scratch.width = width; scratch.height = height;
    const ctx = scratch.getContext('2d');
    if (!ctx) return null;
    const scale = Math.max(width / image.naturalWidth, height / image.naturalHeight);
    const drawWidth = image.naturalWidth * scale, drawHeight = image.naturalHeight * scale;
    ctx.drawImage(image, (width - drawWidth) / 2, (height - drawHeight) / 2, drawWidth, drawHeight);
    return ctx.getImageData(0, 0, width, height);
  }

  function sample(width, height) {
    const photo = readPhoto(width, height);
    return photo ? ditherPhoto(photo.data, width, height) : null;
  }

  function paint() {
    if (disposed) return;
    const { width, height } = size();
    bitmapWidth = width; bitmapHeight = height;
    baseInk = sample(width, height);
    lastRegion = null; ripple = 0; pointer = null;
    paintBackground(canvas, { ground: state.ground, width, height, ink: baseInk });
  }

  function regionMask(region, strength) {
    return rippleMask(baseInk, bitmapWidth, region, { x: pointer.x, y: pointer.y, radius: RIPPLE_RADIUS, strength });
  }

  // Repaint the union of the previous and current ripple boxes so dragging the
  // pointer leaves no trail.
  function drawRipple(strength) {
    if (!baseInk || !pointer) return;
    const next = rippleRegion(bitmapWidth, bitmapHeight, { x: pointer.x, y: pointer.y });
    let region = next;
    if (lastRegion) {
      const x0 = Math.min(lastRegion.x, next.x), y0 = Math.min(lastRegion.y, next.y);
      const x1 = Math.max(lastRegion.x + lastRegion.width, next.x + next.width);
      const y1 = Math.max(lastRegion.y + lastRegion.height, next.y + next.height);
      region = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
    }
    const links = strength > .1
      ? rippleLinks(baseInk, bitmapWidth, region, { x: pointer.x, y: pointer.y }).map((link) => [...link.slice(0, 4), link[4] * strength])
      : null;
    paintBackground(canvas, { ground: state.ground, width: bitmapWidth, height: bitmapHeight, ink: regionMask(region, strength), region, links });
    lastRegion = region;
  }

  function restoreRegion() {
    if (!baseInk || !lastRegion) return;
    paintBackground(canvas, { ground: state.ground, width: bitmapWidth, height: bitmapHeight, ink: regionMask(lastRegion, 0), region: lastRegion });
    lastRegion = null;
  }

  const schedule = (callback) => (typeof view()?.requestAnimationFrame === 'function'
    ? view().requestAnimationFrame(callback)
    : setTimeout(() => callback(Date.now()), 33));
  const unschedule = (id) => {
    if (id == null) return;
    if (typeof view()?.cancelAnimationFrame === 'function') view().cancelAnimationFrame(id);
    else clearTimeout(id);
  };

  function step(now) {
    frame = null;
    if (disposed) return;
    const current = Number.isFinite(now) ? now : Date.now();
    const delta = Math.min(.1, Math.max(0, (current - lastFrame) / 1000));
    lastFrame = current;
    ripple = Math.max(0, ripple - delta * 1000 / RIPPLE_MS);
    if (ripple > 0 && pointer) { drawRipple(ripple); frame = schedule(step); }
    else { restoreRegion(); ripple = 0; }
  }

  function wake() {
    if (frame != null || disposed) return;
    lastFrame = Date.now();
    frame = schedule(step);
  }

  const onPointerMove = (event) => {
    if (disposed || !baseInk) return;
    const x = Number(event?.clientX), y = Number(event?.clientY);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    pointer = { x, y };
    ripple = 1;
    wake();
  };
  const onPointerLeave = () => { pointer = null; ripple = 0; };

  function repaint() {
    try {
      const style = doc?.documentElement?.style;
      style?.setProperty('--pink', state.theme);
      style?.setProperty('--ground', state.ground);
    } catch { /* Optional DOM. */ }
    paint();
  }

  const onResize = () => {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { resizeTimer = null; paint(); }, 150);
  };
  view()?.addEventListener?.('resize', onResize);
  doc?.addEventListener?.('pointermove', onPointerMove, { passive: true });
  doc?.addEventListener?.('pointerleave', onPointerLeave, { passive: true });
  view()?.addEventListener?.('blur', onPointerLeave);

  const controller = {
    state,
    repaint,
    setTheme(value) { state.theme = writeColor(storage, THEME_KEY, value, DEFAULT_THEME); repaint(); return state.theme; },
    setGround(value) { state.ground = writeColor(storage, GROUND_KEY, value, DEFAULT_GROUND); repaint(); return state.ground; },
    async setPhotoFile(file) {
      if (!file) return { ok: false, message: 'Choose an image first.' };
      const original = await decodeImage(await readFile(file, doc), doc);
      let dataUrl = encodeImage(original, 1280, .82, doc);
      if (dataUrl.length > MAX_PHOTO_CHARS) dataUrl = encodeImage(original, 720, .72, doc);
      const stored = dataUrl.length <= MAX_PHOTO_CHARS;
      state.photo = stored ? dataUrl : '';
      if (stored) writePhoto(storage, dataUrl);
      image = stored ? await decodeImage(dataUrl, doc) : original;
      repaint();
      onPhotoChange?.();
      return { ok: true, stored, message: stored ? 'Photo dithered into the background.' : 'Photo is too large to remember; it shows until the app restarts.' };
    },
    async setPhotoDataUrl(dataUrl) {
      if (!dataUrl) { controller.clearPhoto(); return false; }
      image = await decodeImage(dataUrl, doc);
      state.photo = dataUrl;
      repaint();
      onPhotoChange?.();
      return true;
    },
    // A sampled copy of the current photo (or null), for the point cloud.
    photoSample(width, height) {
      const photo = readPhoto(Math.max(1, Math.floor(width)), Math.max(1, Math.floor(height)));
      return photo ? { data: photo.data, width: photo.width, height: photo.height } : null;
    },
    clearPhoto() { state.photo = ''; image = null; removePhoto(storage); repaint(); onPhotoChange?.(); },
    destroy() {
      disposed = true;
      if (resizeTimer) clearTimeout(resizeTimer);
      unschedule(frame); frame = null;
      view()?.removeEventListener?.('resize', onResize);
      doc?.removeEventListener?.('pointermove', onPointerMove);
      doc?.removeEventListener?.('pointerleave', onPointerLeave);
      view()?.removeEventListener?.('blur', onPointerLeave);
    },
  };
  if (state.photo) void controller.setPhotoDataUrl(state.photo);
  else repaint();
  return controller;
}
