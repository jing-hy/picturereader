/**
 * Tests for the extra picturereader tools (image_crop / image_palette /
 * image_compare) in src/more-tools.js. Uses the same in-memory fake ctx.fs
 * seams as tool.test.js, plus real temp files for output verification.
 * Run: node --test tests/more-tools.test.js
 * @module picturereader/tests/more-tools
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createImageCropTool, createImagePaletteTool, createImageCompareTool, tools } from '../src/more-tools.js';
import { importCore } from '../src/tool.js';
import { createRgba, pngFromRgba } from './fixtures.mjs';

const CORE_URL = new URL('../src/core.js', import.meta.url).href;

function makeFakeCtx(entries) {
  // entries: { displayPath -> { buffer } }
  const emitted = [];
  const ctx = {
    tools: { register() {} },
    emit(...args) { emitted.push(args); },
    fs: {
      async resolve(path, opts) {
        return { targetKey: `k:${path}`, displayPath: path };
      },
      async stat(target) {
        const e = entries[target.displayPath];
        if (!e) return null;
        return { version: e.version ?? 'v1', type: 'file', size: e.buffer.length };
      },
      async readBytes(target, signal, maxBytes) {
        assert.ok(maxBytes > 0);
        const e = entries[target.displayPath];
        if (!e) throw new Error(`mock readBytes: no bytes for ${target.displayPath}`);
        return e.buffer;
      }
    }
  };
  return { ctx, emitted };
}

const EXEC = { signal: undefined, agent: { session: { header: { cwd: 'C:\\work' } } } };

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'picturereader-more-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const RED = [216, 27, 27];
const BLUE = [27, 95, 216];

// ---------------------------------------------------------------- image_crop

test('image_crop: crops to half width and content matches source', async (t) => {
  const dir = tempDir(t);
  const outPath = join(dir, 'crop-left.png');
  const rgba = createRgba(100, 100, (x, y) => (x < 50 ? RED : BLUE));
  const buf = pngFromRgba(100, 100, rgba);
  const { ctx, emitted } = makeFakeCtx({ 'shot.png': { buffer: buf } });
  const tool = createImageCropTool(ctx);
  const result = await tool.execute({ file_path: 'shot.png', region: [0, 0, 0.5, 1], out_path: outPath }, EXEC);

  assert.equal(tool.name, 'image_crop');
  assert.equal(result.width, 50);
  assert.equal(result.height, 100);
  assert.equal(result.generated, false);
  assert.equal(result.outPath, outPath);
  assert.ok(existsSync(outPath));
  // emitted exactly one observation for the source
  assert.equal(emitted.length, 1);
  assert.deepEqual(emitted[0][2], { kind: 'present', version: 'v1' });

  // decode written PNG and verify left edge is red, middle is the boundary
  const core = await importCore(CORE_URL);
  const cropped = core.decodeImage(readFileSync(outPath), '.png');
  assert.equal(cropped.width, 50);
  assert.equal(cropped.height, 100);
  const topLeft = (cropped.data[0] << 16) | (cropped.data[1] << 8) | cropped.data[2];
  const redInt = (RED[0] << 16) | (RED[1] << 8) | RED[2];
  assert.equal(topLeft >>> 0, redInt >>> 0, 'crop should keep red source pixels');
});

test('image_crop: quarter region halves both dimensions and pixels', async (t) => {
  const dir = tempDir(t);
  const outPath = join(dir, 'crop-q.png');
  const rgba = createRgba(100, 100, () => [255, 0, 0]);
  const buf = pngFromRgba(100, 100, rgba);
  const { ctx } = makeFakeCtx({ 'a.png': { buffer: buf } });
  const tool = createImageCropTool(ctx);
  const result = await tool.execute({ file_path: 'a.png', region: [0, 0, 0.5, 0.5], out_path: outPath }, EXEC);
  assert.equal(result.width, 50);
  assert.equal(result.height, 50);
  assert.equal(result.width * result.height, 2500, 'quarter of 100x100 = 2500 px');
});

test('image_crop: default writes to a generated temp file', async (t) => {
  const rgba = createRgba(10, 10, () => [0, 255, 0]);
  const buf = pngFromRgba(10, 10, rgba);
  const { ctx } = makeFakeCtx({ 'a.png': { buffer: buf } });
  const tool = createImageCropTool(ctx);
  const result = await tool.execute({ file_path: 'a.png', region: [0, 0, 1, 1] }, EXEC);
  assert.equal(result.generated, true);
  assert.ok(result.outPath.includes('picturereader'));
  assert.match(result.outPath, /crop-[\d]+-[0-9a-f]+\.png$/);
  assert.ok(existsSync(result.outPath));
  t.after(() => { try { rmSync(result.outPath, { force: true }); } catch {} });
});

test('image_crop: invalid region throws a clear error', async (t) => {
  const rgba = createRgba(10, 10, () => [0, 0, 0]);
  const buf = pngFromRgba(10, 10, rgba);
  const { ctx } = makeFakeCtx({ 'a.png': { buffer: buf } });
  const tool = createImageCropTool(ctx);
  await assert.rejects(() => tool.execute({ file_path: 'a.png', region: [0, 0, 0.2] }, EXEC), /region must be \[x0, y0, x1, y1\]/);
  await assert.rejects(() => tool.execute({ file_path: 'a.png', region: [0.5, 0, 0.2, 1] }, EXEC), /x1 > x0/);
  await assert.rejects(() => tool.execute({ file_path: 'a.png', region: [0, 0, 1.5, 1] }, EXEC), /0\.\.1/);
  await assert.rejects(() => tool.execute({ file_path: 'a.png' }, EXEC), /region is required/);
  await assert.rejects(() => tool.execute({ file_path: '', region: [0, 0, 1, 1] }, EXEC), /non-empty/);
});

// ------------------------------------------------------------- image_palette

test('image_palette: solid color reports that color at 100%', async (t) => {
  const rgba = createRgba(20, 20, () => RED);
  const buf = pngFromRgba(20, 20, rgba);
  const { ctx, emitted } = makeFakeCtx({ 'red.png': { buffer: buf } });
  const tool = createImagePaletteTool(ctx);
  const result = await tool.execute({ file_path: 'red.png' }, EXEC);

  assert.equal(tool.name, 'image_palette');
  assert.equal(result.width, 20);
  assert.equal(result.height, 20);
  assert.equal(result.top.length, 1, 'one dominant color for a solid image');
  assert.equal(result.top[0].name, 'red');
  assert.equal(result.top[0].pct, 100);
  assert.equal(result.top[0].rgb.r, RED[0]);
  assert.equal(result.top[0].rgb.g, RED[1]);
  assert.equal(result.top[0].rgb.b, RED[2]);
  assert.ok(result.distinct >= 1);
  // hue family must be chromatic red at 100%
  const redHue = result.hue_families.find((h) => h.family === 'red');
  assert.equal(redHue.pct, 100);
  assert.equal(emitted.length, 1);
});

test('image_palette: top limit trims the returned colors', async (t) => {
  // 3 vertical stripes red / green / blue, equal area
  const rgba = createRgba(60, 10, (x) => (x < 20 ? RED : x < 40 ? [46, 158, 68] : BLUE));
  const buf = pngFromRgba(60, 10, rgba);
  const { ctx } = makeFakeCtx({ 's.png': { buffer: buf } });
  const tool = createImagePaletteTool(ctx);
  const one = await tool.execute({ file_path: 's.png', top: 1 }, EXEC);
  assert.equal(one.top.length, 1);
  const three = await tool.execute({ file_path: 's.png', top: 10 }, EXEC);
  assert.ok(three.top.length >= 3, `expected >=3 dominant colors, got ${three.top.length}`);
});

test('image_palette: region restricts the palette', async (t) => {
  // left half red, right half blue; palette of left half = only red
  const rgba = createRgba(60, 10, (x) => (x < 30 ? RED : BLUE));
  const buf = pngFromRgba(60, 10, rgba);
  const { ctx } = makeFakeCtx({ 's.png': { buffer: buf } });
  const tool = createImagePaletteTool(ctx);
  const result = await tool.execute({ file_path: 's.png', region: [0, 0, 0.5, 1] }, EXEC);
  const names = result.top.map((c) => c.name);
  assert.ok(names.includes('red'));
  assert.ok(!names.includes('blue'), 'right-half blue must be excluded from the left-half region');
});

// ------------------------------------------------------------ image_compare

test('image_compare: identical images -> verdict same', async (t) => {
  const rgba = createRgba(32, 24, () => RED);
  const buf = pngFromRgba(32, 24, rgba);
  const { ctx, emitted } = makeFakeCtx({ 'a.png': { buffer: buf }, 'b.png': { buffer: buf } });
  const tool = createImageCompareTool(ctx);
  const result = await tool.execute({ file_path_a: 'a.png', file_path_b: 'b.png' }, EXEC);

  assert.equal(tool.name, 'image_compare');
  assert.equal(result.width_a, 32);
  assert.equal(result.height_a, 24);
  assert.equal(result.width_b, 32);
  assert.equal(result.height_b, 24);
  assert.equal(result.size_diff, undefined, 'same-size images should omit size_diff');
  assert.equal(result.mean_diff, 0);
  assert.equal(result.diff_ratio, 0);
  assert.equal(result.max_diff, 0);
  assert.equal(result.diff_box, undefined, 'same images should omit diff_box');
  assert.equal(result.verdict, 'same');
  assert.equal(emitted.length, 2, 'observe both images');
});

test('image_compare: clearly different images -> verdict different', async (t) => {
  const redBuf = pngFromRgba(32, 24, createRgba(32, 24, () => RED));
  const blueBuf = pngFromRgba(32, 24, createRgba(32, 24, () => BLUE));
  const { ctx } = makeFakeCtx({ 'a.png': { buffer: redBuf }, 'b.png': { buffer: blueBuf } });
  const tool = createImageCompareTool(ctx);
  const result = await tool.execute({ file_path_a: 'a.png', file_path_b: 'b.png' }, EXEC);
  assert.equal(result.verdict, 'different');
  assert.ok(result.mean_diff > 0.5, `mean_diff should be large, got ${result.mean_diff}`);
  assert.equal(result.diff_ratio, 1, 'all pixels differ');
  assert.ok(Array.isArray(result.diff_box), 'a difference box should exist');
  const [bx0, by0, bx1, by1] = result.diff_box;
  assert.ok(by0 >= 0 && by0 < by1 && by1 <= 1, 'box y range valid');
  assert.ok(bx0 >= 0 && bx0 < bx1 && bx1 <= 1, 'box x range valid');
  assert.ok(bx1 - bx0 > 0.8, 'box should cover nearly the full width');
  assert.ok(by1 - by0 > 0.8, 'box should cover nearly the full height');
});

test('image_compare: size mismatch -> verdict size-diff and note', async (t) => {
  const small = pngFromRgba(20, 20, createRgba(20, 20, () => RED));
  const big = pngFromRgba(40, 40, createRgba(40, 40, () => RED));
  const { ctx } = makeFakeCtx({ 'a.png': { buffer: small }, 'b.png': { buffer: big } });
  const tool = createImageCompareTool(ctx);
  const result = await tool.execute({ file_path_a: 'a.png', file_path_b: 'b.png' }, EXEC);
  assert.equal(result.verdict, 'size-diff');
  assert.deepEqual(result.size_diff, { w: 20, h: 20 });
  assert.ok(result.note.includes('size'), 'note should mention the size difference');
  // overlapping region (20x20 red vs red) identical -> 0 diff
  assert.equal(result.mean_diff, 0);
});

test('image_compare: writes a difference preview PNG', async (t) => {
  const dir = tempDir(t);
  const preview = join(dir, 'diff.png');
  const redBuf = pngFromRgba(16, 16, createRgba(16, 16, () => RED));
  const blueBuf = pngFromRgba(16, 16, createRgba(16, 16, () => BLUE));
  const { ctx } = makeFakeCtx({ 'a.png': { buffer: redBuf }, 'b.png': { buffer: blueBuf } });
  const tool = createImageCompareTool(ctx);
  const result = await tool.execute({ file_path_a: 'a.png', file_path_b: 'b.png', preview_path: preview }, EXEC);
  assert.equal(result.preview_path, preview);
  assert.ok(existsSync(preview));
  const core = await importCore(CORE_URL);
  const img = core.decodeImage(readFileSync(preview), '.png');
  assert.ok(img.width > 0 && img.height > 0);
  // all cells differing -> preview should be all red
  const r = img.data[0];
  const g = img.data[1];
  const b = img.data[2];
  assert.deepEqual([r, g, b], [255, 0, 0], 'differing preview should be red');
});

test('image_compare: high threshold can make a difference read as same', async (t) => {
  // tiny single-channel value change below the 0.1 per-pixel threshold + high ratio threshold
  const a = createRgba(16, 16, () => [200, 200, 200]);
  const b = createRgba(16, 16, () => [205, 205, 205]);
  const ab = pngFromRgba(16, 16, a);
  const bb = pngFromRgba(16, 16, b);
  const { ctx } = makeFakeCtx({ 'a.png': { buffer: ab }, 'b.png': { buffer: bb } });
  const tool = createImageCompareTool(ctx);
  const strict = await tool.execute({ file_path_a: 'a.png', file_path_b: 'b.png', max_diff_threshold: 0.001 }, EXEC);
  assert.equal(strict.verdict, 'different');
  const lenient = await tool.execute({ file_path_a: 'a.png', file_path_b: 'b.png', max_diff_threshold: 0.05 }, EXEC);
  assert.equal(lenient.verdict, 'same', 'tiny 5/255 delta below default ratio threshold');
});

test('exported tools array exposes three factories', () => {
  assert.equal(tools.length, 3);
  for (const factory of tools) {
    assert.equal(typeof factory, 'function');
    assert.equal(typeof factory({ tools: { register() {} }, fs: {}, emit() {} }), 'object');
  }
});
