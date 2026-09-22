// Static, user-controlled background: a ground color with an optional photo
// rendered as an ordered dither in the same ink as the rest of the desktop.
// Nothing here runs on a timer; it repaints only when settings or the viewport
// change. Exported helpers are pure so they can be tested without a browser.
export const GROUND_KEY = 'pi-desktop:ground:v1';
export const PHOTO_KEY = 'pi-desktop:photo:v1';
export const DEFAULT_GROUND = '#e58da5';
export const INK = '#20201f';
export const MAX_PHOTO_CHARS = 900_000;
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
const MAX_CELLS = 100_000, MAX_EDGE = 2048, CELL = 3;

export function normalizeGround(value) {
  const text = String(value ?? '').trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(text)) return text;
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(text);
  return short ? `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}` : null;
}

// Bitmap size independent of devicePixelRatio, bounded like the old backdrop.
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

// Ground fill plus optional ink cells at bitmap resolution; CSS scales it up.
export function paintBackground(canvas, { ground, width, height, ink }) {
  const ctx = canvas?.getContext?.('2d');
  if (!ctx) return false;
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  ctx.fillStyle = ground;
  ctx.fillRect(0, 0, width, height);
  if (!ink) return true;
  ctx.fillStyle = INK;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (ink[y * width + x]) ctx.fillRect(x, y, 1, 1);
  return true;
}

export function readBackground(storage) {
  const state = { ground: DEFAULT_GROUND, photo: '' };
  try {
    const ground = normalizeGround(storage?.getItem(GROUND_KEY));
    if (ground) state.ground = ground;
    const photo = String(storage?.getItem(PHOTO_KEY) ?? '');
    if (/^data:image\/(?:png|jpeg|webp);base64,/.test(photo) && photo.length <= MAX_PHOTO_CHARS) state.photo = photo;
  } catch { /* Storage is optional; defaults are fine. */ }
  return state;
}

export function writeGround(storage, value) {
  const ground = normalizeGround(value) || DEFAULT_GROUND;
  try { storage?.setItem(GROUND_KEY, ground); } catch { /* Optional storage. */ }
  return ground;
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

export function createBackground({ canvas, storage, document: doc = canvas?.ownerDocument ?? globalThis.document } = {}) {
  const state = readBackground(storage);
  let image = null, resizeTimer = null, disposed = false;
  const view = () => doc?.defaultView ?? globalThis;
  const size = () => backgroundSize(view()?.innerWidth ?? canvas?.clientWidth, view()?.innerHeight ?? canvas?.clientHeight);

  function sample(width, height) {
    if (!image || !image.naturalWidth) return null;
    const scratch = doc.createElement('canvas');
    scratch.width = width; scratch.height = height;
    const ctx = scratch.getContext('2d');
    if (!ctx) return null;
    // Cover fit: preserve the aspect ratio and centre-crop.
    const scale = Math.max(width / image.naturalWidth, height / image.naturalHeight);
    const drawWidth = image.naturalWidth * scale, drawHeight = image.naturalHeight * scale;
    ctx.drawImage(image, (width - drawWidth) / 2, (height - drawHeight) / 2, drawWidth, drawHeight);
    return ditherPhoto(ctx.getImageData(0, 0, width, height).data, width, height);
  }

  function paint() {
    if (disposed) return;
    const { width, height } = size();
    paintBackground(canvas, { ground: state.ground, width, height, ink: sample(width, height) });
  }

  function repaint() {
    try { doc?.documentElement?.style?.setProperty('--ground', state.ground); } catch { /* Optional DOM. */ }
    paint();
  }

  const onResize = () => {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { resizeTimer = null; paint(); }, 150);
  };
  view()?.addEventListener?.('resize', onResize);

  const controller = {
    state,
    repaint,
    setGround(value) { state.ground = writeGround(storage, value); repaint(); return state.ground; },
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
      return { ok: true, stored, message: stored ? 'Photo dithered into the background.' : 'Photo is too large to remember; it shows until the app restarts.' };
    },
    async setPhotoDataUrl(dataUrl) {
      if (!dataUrl) { controller.clearPhoto(); return false; }
      image = await decodeImage(dataUrl, doc);
      state.photo = dataUrl;
      repaint();
      return true;
    },
    clearPhoto() { state.photo = ''; image = null; removePhoto(storage); repaint(); },
    destroy() {
      disposed = true;
      if (resizeTimer) clearTimeout(resizeTimer);
      view()?.removeEventListener?.('resize', onResize);
    },
  };
  if (state.photo) void controller.setPhotoDataUrl(state.photo);
  else repaint();
  return controller;
}
