import test from 'node:test';
import assert from 'node:assert/strict';
import { createImageBatchTool, classifyType } from '../src/image-batch.js';
import { decodeImage } from '../src/core.js';
import {
  makeQuadrantRgba,
  makePhotoishRgba,
  createRgba,
  pngFromRgba,
  makeChartRgba
} from './fixtures.mjs';

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

/** 100x100 quadrant PNG — stands in for a "text page" (OCR injected anyway). */
const TEXT_PNG = pngFromRgba(100, 100, makeQuadrantRgba());
/** 600x500 noisy photo PNG — classified as photo by pixel stats (no OCR). */
const PHOTO_PNG = pngFromRgba(600, 500, makePhotoishRgba());
/** 600x400 chart PNG — several color blobs -> chart (no OCR). */
const CHART_PNG = pngFromRgba(600, 400, makeChartRgba());
/** 64x64 solid grey — low information -> blank. */
const BLANK_PNG = pngFromRgba(64, 64, createRgba(64, 64, () => [245, 245, 245]));

const TEXT_LINES = [
  { text: 'Title of the page', x: 0, y: 0, width: 100, height: 20 },
  { text: 'Some body sentence one', x: 0, y: 22, width: 150, height: 20 },
  { text: 'Another body sentence two', x: 0, y: 44, width: 150, height: 20 }
];

/**
 * Deterministic OCR stand-in: short/narrow images (<300px wide) count as
 * text-dense, large ones (photos/charts) return no text. Replaces core.ocrImage
 * via the ctx.ocrImage seam so no real OCR engine is needed.
 */
async function fakeOcr(data, ext) {
  const img = decodeImage(data, ext);
  const lines = img.width < 300 ? TEXT_LINES : [];
  return { width: img.width, height: img.height, lines };
}

// ---------------------------------------------------------------------------
// mock ctx.fs (per-basename byte store; null -> missing file)
// ---------------------------------------------------------------------------
function makeFakeCtx(store, { ocr = fakeOcr, emit = true } = {}) {
  const emitted = [];
  const ctx = {
    tools: { register() {} },
    emit(...args) { emitted.push(args); },
    ...(ocr ? { ocrImage: ocr } : {}),
    fs: {
      async resolve(path, opts) {
        const base = String(path).split(/[\\/]/).pop();
        return { targetKey: `C:\\img\\${base}`, displayPath: `C:\\img\\${base}` };
      },
      async stat(target) {
        const base = String(target.displayPath).split(/[\\/]/).pop();
        if (store[base] === undefined || store[base] === null) return undefined;
        return { version: 'v1', type: 'file', size: store[base].length };
      },
      async readBytes(target, signal, maxBytes) {
        const base = String(target.displayPath).split(/[\\/]/).pop();
        return store[base];
      }
    }
  };
  return { ctx, emitted };
}

const EXEC = { signal: undefined, agent: { session: { header: { cwd: 'C:\\work' } } } };

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

test('classifyType: text / photo / chart / blank thresholds', () => {
  // blank: single shade, low texture
  assert.equal(classifyType({ distinctShades: 1, texture: { rough: 0 } }, 0), 'blank');
  // text: 2+ OCR lines, no ruling -> text; with ruling -> table
  assert.equal(classifyType({ distinctShades: 5, texture: { rough: 5 }, regions: [] }, 2), 'text');
  assert.equal(classifyType({ distinctShades: 5, texture: { rough: 5 }, regions: [] }, 3, true), 'table');
  // photo: high rough texture even without OCR
  assert.equal(classifyType({ distinctShades: 12, texture: { rough: 40 }, hues: [{ name: 'green', pct: 60 }, { name: 'achromatic', pct: 40 }] }, 0), 'photo');
  // chart: several color blobs
  assert.equal(classifyType({ distinctShades: 6, texture: { rough: 10 }, regions: [{}, {}, {}, {}, {}, {}], hues: [{ name: 'red', pct: 30 }, { name: 'blue', pct: 30 }, { name: 'achromatic', pct: 40 }] }, 0), 'chart');
});

test('image_batch: 3 text images trigger full OCR (auto probe)', async () => {
  const store = { 'a.png': TEXT_PNG, 'b.png': TEXT_PNG, 'c.png': TEXT_PNG };
  const { ctx, emitted } = makeFakeCtx(store);
  const tool = createImageBatchTool(ctx);

  const result = await tool.execute(
    { file_paths: ['a.png', 'b.png', 'c.png'], auto_ocr: 'auto' },
    EXEC
  );

  assert.equal(result.processed, 3);
  assert.equal(result.errors, 0);
  assert.equal(result.items.length, 3);
  assert.match(result.summary, /Full OCR was run/);
  for (const item of result.items) {
    assert.equal(item.type, 'text');
    assert.equal(item.has_text, true);
    assert.ok(item.ocr_excerpt.length > 0, `item ${item.index} should carry an OCR excerpt`);
    assert.ok(item.scan_preview.length > 0);
    assert.ok(item.recommendation.length > 0);
    assert.match(item.recommendation, /image_ocr/);
    // required output fields present
    for (const key of ['index', 'basename', 'width', 'height', 'type', 'recommendation']) {
      assert.ok(item[key] !== undefined, `item.${key} should be present`);
    }
  }
  // fs observed events for each decoded file
  assert.equal(emitted.length, 3);
  assert.ok(emitted.every((e) => e[0] === 'fs/observed'));
});

test('image_batch: photo-first batch does NOT trigger full OCR (auto probe)', async () => {
  const store = { 'photo.png': PHOTO_PNG, 'doc.png': TEXT_PNG };
  const { ctx } = makeFakeCtx(store);
  const tool = createImageBatchTool(ctx);

  // probe only the first (photo) image; ocr -> 0 lines -> not text-dense
  const result = await tool.execute(
    { file_paths: ['photo.png', 'doc.png'], auto_ocr: 'auto', probe_first: 1 },
    EXEC
  );

  assert.equal(result.processed, 2);
  assert.match(result.summary, /Full OCR was NOT run/);

  const photo = result.items.find((it) => it.basename === 'photo.png');
  const doc = result.items.find((it) => it.basename === 'doc.png');
  assert.equal(photo.type, 'photo');
  assert.equal(photo.has_text, false);
  assert.equal(photo.ocr_excerpt, undefined, 'non-text image must have no OCR excerpt');
  assert.match(photo.recommendation, /VLM/);

  assert.equal(doc.type, 'text');
  assert.equal(doc.has_text, true);
  assert.ok(doc.ocr_excerpt.length > 0, 'the lone text-dense image still gets OCR');
});

test('image_batch: auto_ocr=never runs no OCR at all', async () => {
  const store = { 'a.png': TEXT_PNG, 'p.png': PHOTO_PNG };
  const { ctx } = makeFakeCtx(store);
  const tool = createImageBatchTool(ctx);

  const result = await tool.execute(
    { file_paths: ['a.png', 'p.png'], auto_ocr: 'never' },
    EXEC
  );

  assert.equal(result.processed, 2);
  assert.ok(result.items.every((it) => it.ocr_excerpt === undefined));
  assert.ok(result.items.every((it) => it.has_text === false));
  assert.match(result.summary, /auto_ocr='never'/);
  // photo still triaged to photo by pixel stats alone
  assert.equal(result.items.find((it) => it.basename === 'p.png').type, 'photo');
});

test('image_batch: ocr_limit_chars truncates the excerpt', async () => {
  const store = { 'a.png': TEXT_PNG };
  const { ctx } = makeFakeCtx(store);
  const tool = createImageBatchTool(ctx);
  const longText = { lines: [{ text: 'x'.repeat(2000), x: 0, y: 0, width: 10, height: 10 }, { text: 'y', x: 0, y: 5, width: 10, height: 10 }] };
  const ctx2 = { ...ctx, ocrImage: async () => longText };

  const result = await tool.execute(
    { file_paths: ['a.png'], auto_ocr: 'always', ocr_limit_chars: 50 },
    EXEC
  );
  assert.equal(result.processed, 1);
  assert.ok(result.items[0].ocr_excerpt.length <= 51, `excerpt should be ~limit, got ${result.items[0].ocr_excerpt.length}`);
  assert.match(result.items[0].ocr_excerpt, /…$/);
});

test('image_batch: missing + invalid files are recorded, not a whole-batch fail', async () => {
  const store = { 'good.png': TEXT_PNG, 'missing.png': undefined, 'bad.txt': Buffer.from('hello') };
  const { ctx } = makeFakeCtx(store);
  const tool = createImageBatchTool(ctx);

  const result = await tool.execute(
    { file_paths: ['good.png', 'missing.png', 'bad.txt'] },
    EXEC
  );

  assert.equal(result.processed, 1, 'only the decodable png counts as processed');
  assert.equal(result.errors, 2);
  assert.equal(result.items.length, 3);

  const missing = result.items.find((it) => it.basename === 'missing.png');
  assert.match(missing.error, /not found/);
  const badExt = result.items.find((it) => it.basename === 'bad.txt');
  assert.match(badExt.error, /unsupported image type/);

  const good = result.items.find((it) => it.basename === 'good.png');
  assert.equal(good.error, undefined);
  assert.equal(good.type, 'text');
});

test('image_batch: max_files cap rejects over-large batches', async () => {
  const { ctx } = makeFakeCtx({ 'a.png': TEXT_PNG });
  const tool = createImageBatchTool(ctx);
  await assert.rejects(
    () => tool.execute({ file_paths: ['a.png', 'b.png'], max_files: 1 }, EXEC),
    /exceeds max_files=1/
  );
  await assert.rejects(
    () => tool.execute({ file_paths: [], auto_ocr: 'auto' }, EXEC),
    /non-empty array/
  );
});

test('image_batch: cancelled signal aborts early', async () => {
  const { ctx } = makeFakeCtx({ 'a.png': TEXT_PNG });
  const tool = createImageBatchTool(ctx);
  await assert.rejects(
    () => tool.execute({ file_paths: ['a.png'] }, { signal: { aborted: true } }),
    /cancelled/
  );
});

test('image_batch: output.render produces a readable manifest', async () => {
  const store = { 'a.png': TEXT_PNG, 'p.png': PHOTO_PNG };
  const { ctx } = makeFakeCtx(store);
  const tool = createImageBatchTool(ctx);
  const result = await tool.execute(
    { file_paths: ['a.png', 'p.png'], auto_ocr: 'auto', probe_first: 1 },
    EXEC
  );
  const parts = tool.output.render({}, result);
  const text = parts.map((p) => p.text).join('\n');
  assert.match(text, /image_batch:/);
  assert.match(text, /\[0\] a\.png /);
  assert.match(text, /\[1\] p\.png /);
  assert.match(text, /type=photo/);
});
