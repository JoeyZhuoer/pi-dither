export function drawBackdrop(canvas) {
  const scale = 3;
  const width = Math.ceil(innerWidth / scale), height = Math.ceil(innerHeight / scale);
  canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = '#20201f';
  const bayer = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const u = x / width, v = y / height;
    const a = Math.exp(-(((u + .04) / .25) ** 2 + ((v - 1.02) / .31) ** 2));
    const b = Math.exp(-(((u - .52) / .19) ** 2 + ((v - 1.05) / .22) ** 2));
    const c = Math.exp(-(((u - 1.01) / .20) ** 2 + ((v - .55) / .23) ** 2));
    const wave = .65 + .35 * Math.sin(x * .41 + y * .27 + Math.sin(y * .073) * 9);
    const density = Math.max(a, b, c) * wave * .88;
    const threshold = bayer[(y % 4) * 4 + x % 4] / 16;
    if (density > threshold + .06) ctx.fillRect(x, y, 1, 1);
    else if (x % 3 === 0 && y % 3 === 0) ctx.fillRect(x, y, .45, .45);
  }
}
