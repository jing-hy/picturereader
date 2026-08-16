import test from 'node:test';
import assert from 'node:assert/strict';
import { samplePixels, renderSample } from '../src/core.js';
import { createImageSampleTool } from '../src/tool.js';
import { makeQuadrantRgba, makePhotoishRgba, pngFromRgba } from './fixtures.mjs';

test('samplePixels: returns an NxN grid of exact pixels', () => {
  const rgba = makeQuadrantRgba(); // 100x100: red|green / blue|yellow
  const sample = samplePixels(rgba, 100, 100, [0, 0, 0.5, 0.5], 4);
  assert.equal(sample.points.length, 4);
  assert.equal(sample.points[0].length, 4);
  assert.equal(sample.width, 50);
  assert.equal(sample.height, 50);
  // top-left corner sample is the red quadrant
  assert.deepEqual(sample.points[0][0], [216, 27, 27]);
  // top-right of the sample is still red (region is only the top-left quadrant)
  assert.deepEqual(sample.points[0][3], [216, 27, 27]);
  assert.equal(sample.distinct, 1);
  assert.equal(sample.contrast, 0);
});

test('samplePixels: smooth region has low contrast, textured region high', () => {
  const flat = makeQuadrantRgba();
  const smooth = samplePixels(flat, 100, 100, [0, 0, 0.5, 0.5], 8);
  assert.equal(smooth.contrast, 0);
  const photo = makePhotoishRgba();
  const rough = samplePixels(photo, 600, 500, [0.3, 0.2, 0.7, 0.6], 8);
  assert.ok(rough.contrast > 0.05, `photo-like sample should have contrast, got ${rough.contrast}`);
  assert.ok(rough.distinct > 1);
});

test('samplePixels: rejects regions smaller than the grid', () => {
  const rgba = makeQuadrantRgba();
  assert.throws(() => samplePixels(rgba, 100, 100, [0, 0, 0.05, 0.05], 8), /too small for a 8x8 sample/);
});

test('renderSample: prints exact RGB rows with stats', () => {
  const rgba = makeQuadrantRgba();
  const sample = samplePixels(rgba, 100, 100, [0, 0, 0.5, 0.5], 4);
  const text = renderSample({
    path: 'C:\\img\\a.png',
    region: '0,0,0.5,0.5',
    width: sample.width,
    height: sample.height,
    stepX: sample.stepX,
    stepY: sample.stepY,
    points: sample.points,
    contrast: sample.contrast,
    distinct: sample.distinct
  });
  assert.match(text, /texture sample: C:\\img\\a\.png region 0,0,0\.5,0\.5 \(50x50 px, 4x4 exact pixels/);
  assert.match(text, /\(216,27,27\)/);
  assert.match(text, /stats: local contrast 0 -> smooth/);
});

function makeFakeCtx(bytes) {
  const emitted = [];
  const ctx = {
    tools: { register() {} },
    emit(...args) { emitted.push(args); },
    fs: {
      async resolve(path) { return { targetKey: `C:\\img\\${path}`, displayPath: `C:\\img\\${path}` }; },
      async stat() { return { version: 'v1', type: 'file', size: bytes.length }; },
      async readBytes() { return bytes; }
    }
  };
  return { ctx, emitted };
}

const EXEC = { signal: undefined, agent: { session: { header: { cwd: 'C:\\work' } } } };

test('image_sample tool: executes and renders', async () => {
  const rgba = makeQuadrantRgba();
  const bytes = pngFromRgba(100, 100, rgba);
  const { ctx, emitted } = makeFakeCtx(bytes);
  const tool = createImageSampleTool(ctx);
  const result = await tool.execute({ file_path: 'a.png', region: [0, 0, 0.5, 0.5], size: 4 }, EXEC);
  assert.equal(result.points.length, 4);
  assert.deepEqual(result.points[0][0], [216, 27, 27]);
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0][0], 'fs/observed');
  const text = tool.output.render({}, result).map((p) => p.text).join('\n');
  assert.match(text, /texture sample: C:\\img\\a\.png/);
});

test('image_sample tool: validation', async () => {
  const rgba = makeQuadrantRgba();
  const bytes = pngFromRgba(100, 100, rgba);
  const { ctx } = makeFakeCtx(bytes);
  const tool = createImageSampleTool(ctx);
  await assert.rejects(() => tool.execute({ file_path: 'a.png' }, EXEC), /region is required/);
  await assert.rejects(() => tool.execute({ file_path: 'a.png', region: [0, 0, 0.5, 0.5], size: 1 }, EXEC), /size must be an integer between 2 and 16/);
  await assert.rejects(() => tool.execute({ file_path: 'a.png', region: [0, 0, 0.5, 0.5], size: 20 }, EXEC), /size must be an integer between 2 and 16/);
  await assert.rejects(() => tool.execute({ file_path: 'a.webp', region: [0, 0, 0.5, 0.5] }, EXEC), /WebP is not supported/);
});
