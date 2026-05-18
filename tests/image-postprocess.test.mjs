import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PNG } from 'pngjs';

import { normalizeLcdInkGrid, removeCheckerboardBackground, removeChromaKeyBackground } from '../image-postprocess.mjs';

async function tempDir() {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-image-'));
}

test('image-postprocess: removes connected checkerboard background and preserves foreground pixels', async () => {
  const dir = await tempDir();
  const input = path.join(dir, 'input.png');
  const output = path.join(dir, 'output.png');
  const png = new PNG({ width: 8, height: 8 });

  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      const idx = (png.width * y + x) << 2;
      const c = (x + y) % 2 === 0 ? 255 : 238;
      png.data[idx] = c;
      png.data[idx + 1] = c;
      png.data[idx + 2] = c;
      png.data[idx + 3] = 255;
    }
  }

  for (let y = 3; y <= 4; y++) {
    for (let x = 3; x <= 4; x++) {
      const idx = (png.width * y + x) << 2;
      png.data[idx] = 80;
      png.data[idx + 1] = 140;
      png.data[idx + 2] = 72;
      png.data[idx + 3] = 255;
    }
  }

  await fs.writeFile(input, PNG.sync.write(png));
  const result = await removeCheckerboardBackground(input, { outputPath: output });
  assert.equal(result.ok, true);
  assert.equal(result.transparentPixels, 60);

  const cleaned = PNG.sync.read(await fs.readFile(output));
  const edgeAlpha = cleaned.data[((cleaned.width * 0 + 0) << 2) + 3];
  const foregroundAlpha = cleaned.data[((cleaned.width * 3 + 3) << 2) + 3];
  assert.equal(edgeAlpha, 0);
  assert.equal(foregroundAlpha, 255);
});

test('image-postprocess: normalizes lcd ink grid image to fixed grid and two-color palette', async () => {
  const dir = await tempDir();
  const input = path.join(dir, 'alpha.png');
  const output = path.join(dir, 'ink.png');
  const png = new PNG({ width: 8, height: 8 });

  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = 255;
    png.data[i + 1] = 255;
    png.data[i + 2] = 255;
    png.data[i + 3] = 0;
  }

  for (let y = 1; y <= 2; y++) {
    for (let x = 1; x <= 2; x++) {
      const idx = (png.width * y + x) << 2;
      png.data[idx] = 0;
      png.data[idx + 1] = 0;
      png.data[idx + 2] = 0;
      png.data[idx + 3] = 255;
    }
  }

  for (let y = 5; y <= 6; y++) {
    for (let x = 5; x <= 6; x++) {
      const idx = (png.width * y + x) << 2;
      png.data[idx] = 245;
      png.data[idx + 1] = 245;
      png.data[idx + 2] = 245;
      png.data[idx + 3] = 255;
    }
  }

  await fs.writeFile(input, PNG.sync.write(png));
  const result = await normalizeLcdInkGrid(input, { outputPath: output, columns: 2, rows: 2, cellSize: 8, inkThreshold: 150 });
  assert.equal(result.ok, true);
  assert.equal(result.width, 16);
  assert.equal(result.height, 16);
  assert.equal(result.columns, 2);
  assert.equal(result.rows, 2);
  assert.equal(result.palette.length, 2);

  const cleaned = PNG.sync.read(await fs.readFile(output));
  const colors = new Set();
  for (let i = 0; i < cleaned.data.length; i += 4) {
    colors.add(`${cleaned.data[i]},${cleaned.data[i + 1]},${cleaned.data[i + 2]},${cleaned.data[i + 3]}`);
  }
  assert.deepEqual(new Set(['0,0,0,0', '0,0,0,255']), colors);
});

test('image-postprocess: removes flat chroma key globally including interior holes', async () => {
  const dir = await tempDir();
  const input = path.join(dir, 'chroma.png');
  const output = path.join(dir, 'alpha.png');
  const png = new PNG({ width: 8, height: 8 });

  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = 255;
    png.data[i + 1] = 0;
    png.data[i + 2] = 255;
    png.data[i + 3] = 255;
  }

  for (let y = 2; y <= 5; y++) {
    for (let x = 2; x <= 5; x++) {
      const idx = (png.width * y + x) << 2;
      png.data[idx] = 92;
      png.data[idx + 1] = 48;
      png.data[idx + 2] = 32;
      png.data[idx + 3] = 210;
    }
  }
  const hole = (png.width * 3 + 3) << 2;
  png.data[hole] = 255;
  png.data[hole + 1] = 0;
  png.data[hole + 2] = 255;
  png.data[hole + 3] = 255;

  await fs.writeFile(input, PNG.sync.write(png));
  const result = await removeChromaKeyBackground(input, { outputPath: output, chromaKey: '#FF00FF' });
  assert.equal(result.ok, true);
  assert.equal(result.kind, 'chroma_key_to_alpha');

  const cleaned = PNG.sync.read(await fs.readFile(output));
  const bgAlpha = cleaned.data[((cleaned.width * 0 + 0) << 2) + 3];
  const holeAlpha = cleaned.data[((cleaned.width * 3 + 3) << 2) + 3];
  const foregroundAlpha = cleaned.data[((cleaned.width * 2 + 2) << 2) + 3];
  assert.equal(bgAlpha, 0);
  assert.equal(holeAlpha, 0);
  assert.equal(foregroundAlpha, 255);
});
