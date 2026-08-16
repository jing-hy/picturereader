/**
 * In-memory test fixture images (PNG / JPEG / GIF / BMP) built with the same
 * pure-JS codecs the plugin decodes with. All images are generated, never
 * downloaded, so the test suite runs offline.
 * @module picturereader/tests/fixtures
 */

import { PNG } from 'pngjs';
import * as jpeg from 'jpeg-js';
import { GifWriter } from 'omggif';

export function createRgba(width, height, pixelFn) {
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b, a = 255] = pixelFn(x, y);
      const o = (y * width + x) * 4;
      data[o] = r;
      data[o + 1] = g;
      data[o + 2] = b;
      data[o + 3] = a;
    }
  }
  return data;
}

export function pngFromRgba(width, height, data) {
  const png = new PNG({ width, height });
  data.copy(png.data);
  return PNG.sync.write(png);
}

export function jpegFromRgba(width, height, data) {
  const rgb = Buffer.alloc(width * height * 3);
  for (let i = 0; i < width * height; i += 1) {
    rgb[i * 3] = data[i * 4];
    rgb[i * 3 + 1] = data[i * 4 + 1];
    rgb[i * 3 + 2] = data[i * 4 + 2];
  }
  return jpeg.encode({ width, height, data: rgb }, 92).data;
}

export function gifFromRgba(width, height, data) {
  const map = new Map();
  const order = [];
  for (let i = 0; i < width * height; i += 1) {
    const key = (data[i * 4] << 16) | (data[i * 4 + 1] << 8) | data[i * 4 + 2];
    if (!map.has(key)) {
      map.set(key, order.length);
      order.push([data[i * 4], data[i * 4 + 1], data[i * 4 + 2]]);
    }
  }
  let palette = order.map(([r, g, b]) => (r << 16) | (g << 8) | b);
  let colorCount = 1;
  while (colorCount < order.length) colorCount *= 2;
  while (palette.length < colorCount) palette.push(0);
  const frame = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i += 1) {
    frame[i] = map.get((data[i * 4] << 16) | (data[i * 4 + 1] << 8) | data[i * 4 + 2]) ?? 0;
  }
  const buffer = new Uint8Array(1024 * 1024);
  const writer = new GifWriter(buffer, width, height, { palette });
  writer.addFrame(0, 0, width, height, frame, { palette });
  return Buffer.from(buffer.subarray(0, writer.end()));
}

export function bmpFromRgba(width, height, data, bpp = 24) {
  if (bpp !== 24 && bpp !== 32) throw new Error(`fixture bmp: unsupported bpp ${bpp}`);
  const bytesPerPixel = bpp / 8;
  const rowBytes = Math.ceil((width * bpp) / 32) * 4;
  const pixelBytes = rowBytes * height;
  const fileSize = 14 + 40 + pixelBytes;
  const buffer = Buffer.alloc(fileSize);
  buffer.write('BM', 0, 'ascii');
  buffer.writeUInt32LE(fileSize, 2);
  buffer.writeUInt32LE(54, 10);
  buffer.writeUInt32LE(40, 14);
  buffer.writeInt32LE(width, 18);
  buffer.writeInt32LE(height, 22); // positive = bottom-up
  buffer.writeUInt16LE(1, 26);
  buffer.writeUInt16LE(bpp, 28);
  buffer.writeUInt32LE(0, 30);
  buffer.writeUInt32LE(pixelBytes, 34);
  buffer.writeInt32LE(2835, 38);
  buffer.writeInt32LE(2835, 42);
  for (let y = 0; y < height; y += 1) {
    const srcRow = height - 1 - y;
    let rowOffset = 54 + y * rowBytes;
    for (let x = 0; x < width; x += 1) {
      const o = (srcRow * width + x) * 4;
      buffer[rowOffset] = data[o + 2]; // B
      buffer[rowOffset + 1] = data[o + 1]; // G
      buffer[rowOffset + 2] = data[o]; // R
      if (bpp === 32) buffer[rowOffset + 3] = 0;
      rowOffset += bytesPerPixel;
    }
  }
  return buffer;
}

const RED = [216, 27, 27];
const GREEN = [46, 158, 68];
const BLUE = [27, 95, 216];
const YELLOW = [242, 208, 36];

/** 100x100 four-quadrant image: red | green / blue | yellow. */
export function makeQuadrantRgba() {
  return createRgba(100, 100, (x, y) => {
    if (x < 50 && y < 50) return RED;
    if (x >= 50 && y < 50) return GREEN;
    if (x < 50 && y >= 50) return BLUE;
    return YELLOW;
  });
}

export function makeQuadrant(width = 100, height = 100, format = 'png') {
  const rgba = makeQuadrantRgba();
  const buffer =
    format === 'png' ? pngFromRgba(width, height, rgba)
      : format === 'jpeg' ? jpegFromRgba(width, height, rgba)
        : format === 'gif' ? gifFromRgba(width, height, rgba)
          : bmpFromRgba(width, height, rgba, 24);
  return { name: `quadrant.${format}`, buffer, width, height };
}

/** 600x400 white background, red diagonal line, blue bars at the bottom. */
export function makeChartRgba() {
  return createRgba(600, 400, (x, y) => {
    // red diagonal from (20, 360) to (560, 80), ~6px thick
    const lineX = 20 + (x - 20) * (540 / 460);
    const dist = Math.abs(y - (360 - (x - 20) * (280 / 460)));
    if (x >= 20 && x <= 560 && dist < 4) return RED;
    // blue bars at the bottom
    if (y > 360 && y < 380 && x % 60 < 30) return BLUE;
    return [245, 245, 245];
  });
}

/** 256x16 horizontal gray gradient 0..255. */
export function makeGradientRgba() {
  return createRgba(256, 16, (x) => {
    const v = Math.round((x / 255) * 255);
    return [v, v, v];
  });
}

/** 64x64 fully transparent. */
export function makeTransparentRgba() {
  return createRgba(64, 64, () => [0, 0, 0, 0]);
}

/** 200x100 white background with a single 1px vertical red line at x=100. */
export function makeThinLineRgba() {
  return createRgba(200, 100, (x) => (x === 100 ? RED : [245, 245, 245]));
}

/** 600x500 flat cartoon tree: solid green ellipse crown + solid brown trunk, no anti-aliasing. */
export function makeFlatTreeRgba() {
  const GREEN_SOLID = [46, 158, 68];
  const BROWN_SOLID = [122, 74, 33];
  return createRgba(600, 500, (x, y) => {
    // crown: ellipse centered (300,200) radius 140x120
    const dx = (x - 300) / 140;
    const dy = (y - 200) / 120;
    if (dx * dx + dy * dy <= 1) return GREEN_SOLID;
    // trunk: rectangle x 285..315, y 320..450
    if (x >= 285 && x < 315 && y >= 320 && y < 450) return BROWN_SOLID;
    return [255, 255, 255];
  });
}

/**
 * 600x500 photo-like scene: green blob lit from the center (bright core,
 * dark rim) with strong deterministic noise, so it uses many shades even
 * after downsampling — the lighting gradient survives cell averaging.
 */
export function makePhotoishRgba() {
  return createRgba(600, 500, (x, y) => {
    const dx = (x - 300) / 150;
    const dy = (y - 200) / 130;
    if (dx * dx + dy * dy <= 1) {
      const t = Math.min(1, Math.max(0, 1 - Math.sqrt(dx * dx + dy * dy) / 1.6));
      const r = 20 + t * 160;
      const g = 60 + t * 180;
      const b = 30 + t * 90;
      // two layers of deterministic noise: fine grain + coarse blotches
      const noise = ((x * 31 + y * 17) % 61) - 30;
      const blotch = ((Math.floor(x / 7) * 13 + Math.floor(y / 7) * 29) % 25) - 12;
      return [Math.round(r + noise + blotch), Math.round(g + noise + blotch), Math.round(b + noise + blotch)];
    }
    // sky gradient
    const sky = 200 + Math.floor((y / 500) * 45);
    return [sky, sky + 5, 250];
  });
}
