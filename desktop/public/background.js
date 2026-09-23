// User-controlled appearance: theme (accent) colour, ground colour and an
// optional photo. The photo is no longer painted as a dither — it becomes the
// point cloud rendered by the particle layer, which owns the only background
// mouse interaction (the reference site's spring plus signed pointer force).
// Exported helpers stay pure so they can be tested without a browser.
export const THEME_KEY = 'pi-desktop:theme:v1';
export const GROUND_KEY = 'pi-desktop:ground:v1';
export const PHOTO_KEY = 'pi-desktop:photo:v1';
export const DEFAULT_THEME = '#e58da5';
export const DEFAULT_GROUND = '#e58da5';
export const MAX_PHOTO_CHARS = 900_000;
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
// One cell per CSS pixel keeps the sampled points precise; the budget still
// bounds very large windows.
const CELL = 1;
export const MAX_CELLS = 4_000_000, MAX_EDGE = 4096;

export function normalizeColor(value) {
  const text = String(value ?? '').trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(text)) return text;
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(text);
  return short ? `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}` : null;
}

// Bitmap size: one cell per CSS pixel (point size ~1px), bounded for huge windows.
export function backgroundSize(viewportWidth, viewportHeight) {
  const cols = Math.ceil(Math.max(1, Number(viewportWidth) || 1) / CELL);
  const rows = Math.ceil(Math.max(1, Number(viewportHeight) || 1) / CELL);
  const scale = Math.min(1, Math.sqrt(MAX_CELLS / cols / rows), MAX_EDGE / cols, MAX_EDGE / rows);
  return { width: Math.max(1, Math.floor(cols * scale)), height: Math.max(1, Math.floor(rows * scale)) };
}

// Ordered-dither mask for one photo sample: 1 = a point belongs there, 0 = bare
// ground. Darker pixels cross the Bayer threshold more often, so the point
// cloud keeps the photo's tonality.
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

// Appearance settings and the sampled photo. This module paints nothing: the
// ground colour is a CSS variable and the photo is read out as pixels for the
// particle layer's point cloud.
export function createBackground({ storage, onPhotoChange, document: doc = globalThis.document } = {}) {
  const state = readBackground(storage);
  let image = null, disposed = false;

  // Cover-fits the current photo into a scratch canvas and reads it back.
  function readPhoto(width, height) {
    if (!image || !image.naturalWidth || disposed) return null;
    const scratch = doc.createElement('canvas');
    scratch.width = width; scratch.height = height;
    const ctx = scratch.getContext('2d');
    if (!ctx) return null;
    const scale = Math.max(width / image.naturalWidth, height / image.naturalHeight);
    const drawWidth = image.naturalWidth * scale, drawHeight = image.naturalHeight * scale;
    ctx.drawImage(image, (width - drawWidth) / 2, (height - drawHeight) / 2, drawWidth, drawHeight);
    return ctx.getImageData(0, 0, width, height);
  }

  function applyColors() {
    try {
      const style = doc?.documentElement?.style;
      style?.setProperty('--pink', state.theme);
      style?.setProperty('--ground', state.ground);
    } catch { /* Optional DOM. */ }
  }

  const controller = {
    state,
    applyColors,
    setTheme(value) { state.theme = writeColor(storage, THEME_KEY, value, DEFAULT_THEME); applyColors(); return state.theme; },
    setGround(value) { state.ground = writeColor(storage, GROUND_KEY, value, DEFAULT_GROUND); applyColors(); return state.ground; },
    async setPhotoFile(file) {
      if (!file) return { ok: false, message: 'Choose an image first.' };
      const original = await decodeImage(await readFile(file, doc), doc);
      let dataUrl = encodeImage(original, 1280, .82, doc);
      if (dataUrl.length > MAX_PHOTO_CHARS) dataUrl = encodeImage(original, 720, .72, doc);
      const stored = dataUrl.length <= MAX_PHOTO_CHARS;
      state.photo = stored ? dataUrl : '';
      if (stored) writePhoto(storage, dataUrl);
      image = stored ? await decodeImage(dataUrl, doc) : original;
      onPhotoChange?.();
      return { ok: true, stored, message: stored ? 'Photo becomes a point cloud; the pointer pushes it.' : 'Photo is too large to remember.' };
    },
    async setPhotoDataUrl(dataUrl) {
      if (!dataUrl) { controller.clearPhoto(); return false; }
      image = await decodeImage(dataUrl, doc);
      state.photo = dataUrl;
      onPhotoChange?.();
      return true;
    },
    // A sampled copy of the current photo (or null), for the point cloud.
    photoSample(width, height) {
      const photo = readPhoto(Math.max(1, Math.floor(width)), Math.max(1, Math.floor(height)));
      return photo ? { data: photo.data, width: photo.width, height: photo.height } : null;
    },
    clearPhoto() { state.photo = ''; image = null; removePhoto(storage); onPhotoChange?.(); },
    destroy() { disposed = true; },
  };
  applyColors();
  if (state.photo) void controller.setPhotoDataUrl(state.photo);
  return controller;
}
