import fs from 'node:fs/promises';
import path from 'node:path';
import { PNG } from 'pngjs';

function colorDistanceSq(a, b) {
  const dr = a[0] - b[0];
  const dg = a[1] - b[1];
  const db = a[2] - b[2];
  return dr * dr + dg * dg + db * db;
}

function parseHexRgb(value, fallback = [255, 0, 255]) {
  const raw = String(value || '').trim();
  const match = raw.match(/^#?([0-9a-f]{6})$/i);
  if (!match) return fallback;
  const hex = match[1];
  return [
    Number.parseInt(hex.slice(0, 2), 16),
    Number.parseInt(hex.slice(2, 4), 16),
    Number.parseInt(hex.slice(4, 6), 16)
  ];
}

function rgbToHex(rgb) {
  return `#${rgb.map((v) => Math.max(0, Math.min(255, Number(v) || 0)).toString(16).padStart(2, '0')).join('')}`.toUpperCase();
}

function isTransparentLike(r, g, b, alpha, palettes) {
  if (alpha <= 16) return true;
  for (const item of palettes) {
    if (colorDistanceSq([r, g, b], item.rgb) <= item.thresholdSq) return true;
  }
  return false;
}

function detectEdgePalettes(png) {
  const counts = new Map();
  const add = (x, y) => {
    const idx = (png.width * y + x) << 2;
    const r = png.data[idx];
    const g = png.data[idx + 1];
    const b = png.data[idx + 2];
    const a = png.data[idx + 3];
    if (a < 240) return;
    const bright = r >= 215 && g >= 215 && b >= 215;
    const neutral = Math.max(r, g, b) - Math.min(r, g, b) <= 18;
    if (!bright || !neutral) return;
    const bucket = (v) => Math.max(0, Math.min(255, Math.round(v / 8) * 8));
    const key = `${bucket(r)},${bucket(g)},${bucket(b)}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  };

  for (let x = 0; x < png.width; x++) {
    add(x, 0);
    add(x, png.height - 1);
  }
  for (let y = 1; y < png.height - 1; y++) {
    add(0, y);
    add(png.width - 1, y);
  }

  const detected = Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([key]) => ({ rgb: key.split(',').map((v) => Number(v)), thresholdSq: 32 * 32 }));

  return detected.length
    ? detected
    : [
        { rgb: [255, 255, 255], thresholdSq: 34 * 34 },
        { rgb: [238, 238, 238], thresholdSq: 34 * 34 },
        { rgb: [229, 229, 229], thresholdSq: 34 * 34 }
      ];
}

export async function removeCheckerboardBackground(inputPath, { outputPath = null } = {}) {
  const source = await fs.readFile(inputPath);
  const png = PNG.sync.read(source);
  const palettes = detectEdgePalettes(png);
  const total = png.width * png.height;
  const visited = new Uint8Array(total);
  const queue = [];

  const enqueue = (x, y) => {
    if (x < 0 || y < 0 || x >= png.width || y >= png.height) return;
    const pos = y * png.width + x;
    if (visited[pos]) return;
    const idx = pos << 2;
    if (!isTransparentLike(png.data[idx], png.data[idx + 1], png.data[idx + 2], png.data[idx + 3], palettes)) return;
    visited[pos] = 1;
    queue.push(pos);
  };

  for (let x = 0; x < png.width; x++) {
    enqueue(x, 0);
    enqueue(x, png.height - 1);
  }
  for (let y = 1; y < png.height - 1; y++) {
    enqueue(0, y);
    enqueue(png.width - 1, y);
  }

  for (let i = 0; i < queue.length; i++) {
    const pos = queue[i];
    const x = pos % png.width;
    const y = Math.floor(pos / png.width);
    enqueue(x + 1, y);
    enqueue(x - 1, y);
    enqueue(x, y + 1);
    enqueue(x, y - 1);
  }

  let transparentPixels = 0;
  for (let pos = 0; pos < visited.length; pos++) {
    if (!visited[pos]) continue;
    const idx = pos << 2;
    png.data[idx] = 0;
    png.data[idx + 1] = 0;
    png.data[idx + 2] = 0;
    png.data[idx + 3] = 0;
    transparentPixels += 1;
  }

  const ratio = total > 0 ? transparentPixels / total : 0;
  const shouldWrite = transparentPixels > 0 && ratio >= 0.02 && ratio <= 0.98;
  const finalOutputPath = outputPath || inputPath.replace(/\.(png)$/i, '.alpha.png');

  if (shouldWrite) {
    await fs.mkdir(path.dirname(finalOutputPath), { recursive: true });
    await fs.writeFile(finalOutputPath, PNG.sync.write(png));
  }

  return {
    ok: shouldWrite,
    inputPath,
    outputPath: shouldWrite ? finalOutputPath : null,
    transparentPixels,
    totalPixels: total,
    transparentRatio: ratio,
    palettes: palettes.map((item) => item.rgb)
  };
}

export async function removeChromaKeyBackground(
  inputPath,
  {
    outputPath = null,
    chromaKey = '#FF00FF',
    tolerance = 86,
    alphaCutoff = 24,
    snapAlpha = true
  } = {}
) {
  const source = await fs.readFile(inputPath);
  const png = PNG.sync.read(source);
  const keyRgb = parseHexRgb(chromaKey);
  const thresholdSq = Math.max(0, Number(tolerance) || 86) ** 2;
  const alphaMin = Math.max(0, Math.min(255, Math.floor(Number(alphaCutoff) || 24)));
  const total = png.width * png.height;
  let transparentPixels = 0;
  let chromaPixels = 0;

  for (let pos = 0; pos < total; pos++) {
    const idx = pos << 2;
    const r = png.data[idx];
    const g = png.data[idx + 1];
    const b = png.data[idx + 2];
    const a = png.data[idx + 3];
    const isKey = colorDistanceSq([r, g, b], keyRgb) <= thresholdSq;
    if (a <= alphaMin || isKey) {
      png.data[idx] = 0;
      png.data[idx + 1] = 0;
      png.data[idx + 2] = 0;
      png.data[idx + 3] = 0;
      transparentPixels += 1;
      if (isKey) chromaPixels += 1;
    } else if (snapAlpha) {
      // Pixel-art assets should not keep semi-transparent haze around edges.
      png.data[idx + 3] = 255;
    }
  }

  const ratio = total > 0 ? transparentPixels / total : 0;
  const chromaRatio = total > 0 ? chromaPixels / total : 0;
  const shouldWrite = transparentPixels > 0 && ratio >= 0.02 && ratio <= 0.98 && chromaRatio >= 0.02;
  const finalOutputPath = outputPath || inputPath.replace(/\.(png)$/i, '.alpha.png');

  if (shouldWrite) {
    await fs.mkdir(path.dirname(finalOutputPath), { recursive: true });
    await fs.writeFile(finalOutputPath, PNG.sync.write(png));
  }

  return {
    ok: shouldWrite,
    kind: 'chroma_key_to_alpha',
    inputPath,
    outputPath: shouldWrite ? finalOutputPath : null,
    chromaKey: rgbToHex(keyRgb),
    tolerance: Math.max(0, Number(tolerance) || 86),
    transparentPixels,
    chromaPixels,
    totalPixels: total,
    transparentRatio: ratio,
    chromaRatio
  };
}

export async function normalizeLcdInkGrid(
  inputPath,
  {
    outputPath = null,
    columns = 4,
    rows = 4,
    cellSize = 256,
    inkThreshold = 150,
    alphaThreshold = 32
  } = {}
) {
  const source = await fs.readFile(inputPath);
  const png = PNG.sync.read(source);
  const safeColumns = Math.max(1, Math.min(32, Math.floor(Number(columns) || 4)));
  const safeRows = Math.max(1, Math.min(32, Math.floor(Number(rows) || 4)));
  const safeCellSize = Math.max(8, Math.min(2048, Math.floor(Number(cellSize) || 256)));
  const out = new PNG({ width: safeColumns * safeCellSize, height: safeRows * safeCellSize, colorType: 6 });

  for (let i = 0; i < out.data.length; i += 4) {
    out.data[i] = 0;
    out.data[i + 1] = 0;
    out.data[i + 2] = 0;
    out.data[i + 3] = 0;
  }

  let inkPixels = 0;
  for (let row = 0; row < safeRows; row++) {
    for (let col = 0; col < safeColumns; col++) {
      const sx0 = Math.round((col * png.width) / safeColumns);
      const sy0 = Math.round((row * png.height) / safeRows);
      const sx1 = Math.round(((col + 1) * png.width) / safeColumns);
      const sy1 = Math.round(((row + 1) * png.height) / safeRows);
      const sw = Math.max(1, sx1 - sx0);
      const sh = Math.max(1, sy1 - sy0);

      for (let y = 0; y < safeCellSize; y++) {
        for (let x = 0; x < safeCellSize; x++) {
          const sx = Math.min(sx1 - 1, sx0 + Math.floor((x * sw) / safeCellSize));
          const sy = Math.min(sy1 - 1, sy0 + Math.floor((y * sh) / safeCellSize));
          const si = (sy * png.width + sx) << 2;
          const oi = ((row * safeCellSize + y) * out.width + (col * safeCellSize + x)) << 2;
          const alpha = png.data[si + 3];
          if (alpha < alphaThreshold) continue;
          const r = png.data[si];
          const g = png.data[si + 1];
          const b = png.data[si + 2];
          const lum = (r * 299 + g * 587 + b * 114) / 1000;
          if (lum >= inkThreshold) continue;
          out.data[oi] = 0;
          out.data[oi + 1] = 0;
          out.data[oi + 2] = 0;
          out.data[oi + 3] = 255;
          inkPixels += 1;
        }
      }
    }
  }

  const finalOutputPath = outputPath || inputPath.replace(/\.(png)$/i, `.ink-${safeColumns}x${safeRows}-${safeCellSize}.png`);
  await fs.mkdir(path.dirname(finalOutputPath), { recursive: true });
  await fs.writeFile(finalOutputPath, PNG.sync.write(out));

  return {
    ok: true,
    inputPath,
    outputPath: finalOutputPath,
    columns: safeColumns,
    rows: safeRows,
    cellSize: safeCellSize,
    width: out.width,
    height: out.height,
    inkPixels,
    transparentPixels: out.width * out.height - inkPixels,
    palette: ['transparent', 'black']
  };
}
