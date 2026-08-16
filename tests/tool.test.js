import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { createImageScanTool, importCore } from '../src/tool.js';
import { makeQuadrant, makeChartRgba, pngFromRgba } from './fixtures.mjs';

function makeFakeCtx({ statResult = { version: 'v1', type: 'file', size: 100 }, bytes, emit = true } = {}) {
  const registered = [];
  const emitted = [];
  const ctx = {
    tools: {
      register(def) {
        registered.push(def);
      }
    },
    emit(...args) {
      emitted.push(args);
    },
    fs: {
      async resolve(path, opts) {
        assert.ok(opts.signal !== undefined || opts.signal === null || opts.signal === undefined);
        return { targetKey: `C:\\img\\${path}`, displayPath: `C:\\img\\${path}` };
      },
      async stat(target) {
        return statResult;
      },
      async readBytes(target, signal, maxBytes) {
        assert.ok(maxBytes > 0);
        return bytes;
      }
    }
  };
  return { ctx, registered, emitted };
}

const EXEC = { signal: undefined, agent: { session: { header: { cwd: 'C:\\work' } } } };

test('image_scan tool registers and executes end to end', async () => {
  const { buffer } = makeQuadrant(100, 100, 'png');
  const { ctx, registered, emitted } = makeFakeCtx({ bytes: buffer });
  const tool = createImageScanTool(ctx);
  assert.equal(tool.name, 'image_scan');
  assert.equal(registered.length, 0, 'registration happens via ctx.tools.register in apply()');

  const result = await tool.execute({ file_path: 'shot.png' }, EXEC);
  assert.equal(result.path, 'C:\\img\\shot.png');
  assert.equal(result.width, 100);
  assert.equal(result.height, 100);
  assert.equal(result.gridWidth, 32);
  assert.equal(result.gridHeight, 32);
  assert.equal(result.mode, 'color');
  assert.ok(result.ascii.length > 0);
  assert.ok(result.colorGrid !== undefined);
  const names = result.colors.map((c) => c.name);
  for (const color of ['red', 'green', 'blue', 'yellow']) assert.ok(names.includes(color));
  // observation event recorded like other fs tools
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0][0], 'fs/observed');
  assert.deepEqual(emitted[0][2], { kind: 'present', version: 'v1' });

  // render output is a text block
  const rendered = tool.output.render({}, result);
  assert.ok(rendered.some((part) => part.type === 'text' && part.text.includes('colors by area:')));
});

test('image_scan: file not found gives a clear error', async () => {
  const { ctx } = makeFakeCtx({ statResult: null, bytes: Buffer.alloc(0) });
  const tool = createImageScanTool(ctx);
  await assert.rejects(() => tool.execute({ file_path: 'missing.png' }, EXEC), /file not found/);
});

test('image_scan: WebP gives a friendly conversion hint', async () => {
  const { ctx } = makeFakeCtx({ bytes: Buffer.alloc(0) });
  const tool = createImageScanTool(ctx);
  await assert.rejects(() => tool.execute({ file_path: 'photo.webp' }, EXEC), /WebP is not supported yet/);
});

test('image_scan: unsupported extension rejected', async () => {
  const { ctx } = makeFakeCtx({ bytes: Buffer.alloc(0) });
  const tool = createImageScanTool(ctx);
  await assert.rejects(() => tool.execute({ file_path: 'notes.txt' }, EXEC), /unsupported image type/);
});

test('image_scan: argument validation', async () => {
  const { buffer } = makeQuadrant(100, 100, 'png');
  const { ctx } = makeFakeCtx({ bytes: buffer });
  const tool = createImageScanTool(ctx);
  await assert.rejects(() => tool.execute({ file_path: '   ' }, EXEC), /non-empty/);
  await assert.rejects(() => tool.execute({ file_path: 'a.png', size: 4 }, EXEC), /size must be an integer between 8 and 64/);
  await assert.rejects(() => tool.execute({ file_path: 'a.png', size: 128 }, EXEC), /size must be an integer between 8 and 64/);
  await assert.rejects(() => tool.execute({ file_path: 'a.png', size: 16.5 }, EXEC), /size must be an integer/);
  await assert.rejects(() => tool.execute({ file_path: 'a.png', mode: 'fancy' }, EXEC), /mode must be one of/);
  await assert.rejects(() => tool.execute({ file_path: 'a.png', palette: 'neon' }, EXEC), /palette must be one of/);
  await assert.rejects(() => tool.execute({ file_path: 'a.png', region: [0, 0, 0.2] }, EXEC), /region must be/);
  await assert.rejects(() => tool.execute({ file_path: 'a.png', px_per_cell: 0 }, EXEC), /px_per_cell must be an integer between 1 and 512/);
  await assert.rejects(() => tool.execute({ file_path: 'a.png', px_per_cell: 2.5 }, EXEC), /px_per_cell must be an integer/);
  await assert.rejects(() => tool.execute({ file_path: 'a.png', size: 32, px_per_cell: 4 }, EXEC), /size and px_per_cell are mutually exclusive/);
});

test('image_scan: px_per_cell drives fine-grained grid density', async () => {
  const { buffer } = makeQuadrant(100, 100, 'png');
  const { ctx } = makeFakeCtx({ bytes: buffer });
  const tool = createImageScanTool(ctx);
  // left half 50x100 px at 5 px/cell -> 10x20 grid
  const result = await tool.execute({ file_path: 'a.png', region: [0, 0, 0.5, 1], px_per_cell: 5 }, EXEC);
  assert.equal(result.gridWidth, 10);
  assert.equal(result.gridHeight, 20);
  assert.equal(result.regionWidth / result.gridWidth, 5);
  const text = tool.output.render({}, result).map((p) => p.text).join('\n');
  assert.match(text, /~5x5px per cell/);
});

test('image_scan: palette argument is validated and passed through', async () => {
  const { buffer } = makeQuadrant(100, 100, 'png');
  const { ctx } = makeFakeCtx({ bytes: buffer });
  const tool = createImageScanTool(ctx);
  const full = await tool.execute({ file_path: 'a.png', palette: 'auto' }, EXEC);
  assert.equal(full.palette, 'full'); // quadrant is colorful -> auto resolves to full
  const gray = await tool.execute({ file_path: 'a.png', palette: 'gray', mode: 'color' }, EXEC);
  assert.equal(gray.palette, 'gray');
  assert.ok([...new Set(gray.colorGrid.replace(/\s/g, ''))].every((code) => 'KWG'.includes(code)));
});

test('image_scan: focus zooms using grid coordinates', async () => {
  const { buffer } = makeQuadrant(100, 100, 'png');
  const { ctx } = makeFakeCtx({ bytes: buffer });
  const tool = createImageScanTool(ctx);
  // quadrant 100x100, size=16 -> full grid 16x16; focus top-left 8x8 block -> red only
  const result = await tool.execute({ file_path: 'a.png', size: 16, focus: [0, 0, 7, 7] }, EXEC);
  assert.equal(result.region, 'focus [0,0,7,7]');
  const names = result.colors.map((c) => c.name);
  assert.deepEqual(names, ['red'], `top-left focus should be only red, got ${names.join(',')}`);
});

test('image_scan: focus and region are mutually exclusive', async () => {
  const { buffer } = makeQuadrant(100, 100, 'png');
  const { ctx } = makeFakeCtx({ bytes: buffer });
  const tool = createImageScanTool(ctx);
  await assert.rejects(
    () => tool.execute({ file_path: 'a.png', region: [0, 0, 0.5, 0.5], focus: [0, 0, 4, 4] }, EXEC),
    /region and focus are mutually exclusive/
  );
});

test('image_scan: focus out of range gives the grid dimensions', async () => {
  const { buffer } = makeQuadrant(100, 100, 'png');
  const { ctx } = makeFakeCtx({ bytes: buffer });
  const tool = createImageScanTool(ctx);
  await assert.rejects(
    () => tool.execute({ file_path: 'a.png', size: 16, focus: [0, 0, 20, 4] }, EXEC),
    /grid is 16x16/
  );
});

test('image_scan: render includes the grid coords zoom hint', async () => {
  const { buffer } = makeQuadrant(100, 100, 'png');
  const { ctx } = makeFakeCtx({ bytes: buffer });
  const tool = createImageScanTool(ctx);
  const result = await tool.execute({ file_path: 'a.png', size: 16 }, EXEC);
  const text = tool.output.render({}, result).map((p) => p.text).join('\n');
  assert.match(text, /grid coords: rows 0\.\.15, cols 0\.\.15/);
  assert.match(text, /zoom with focus/);
});

test('image_scan: aborted signal cancels early', async () => {
  const { ctx } = makeFakeCtx({ bytes: Buffer.alloc(0) });
  const tool = createImageScanTool(ctx);
  await assert.rejects(
    () => tool.execute({ file_path: 'a.png' }, { signal: { aborted: true } }),
    /cancelled/
  );
});

test('image_scan: region zoom works through the tool', async () => {
  const { buffer } = makeQuadrant(100, 100, 'png');
  const { ctx } = makeFakeCtx({ bytes: buffer });
  const tool = createImageScanTool(ctx);
  const result = await tool.execute({ file_path: 'a.png', region: [0, 0, 0.5, 1] }, EXEC);
  assert.match(result.region, /^0,0,0\.5,1$/);
  const names = result.colors.map((c) => c.name);
  assert.ok(names.includes('red') && names.includes('blue'));
  assert.ok(!names.includes('green'));
});

test('image_scan: gif and bmp files decode through the tool', async () => {
  for (const format of ['gif', 'bmp']) {
    const { buffer } = makeQuadrant(100, 100, format);
    const { ctx } = makeFakeCtx({ bytes: buffer });
    const tool = createImageScanTool(ctx);
    const result = await tool.execute({ file_path: `a.${format}` }, EXEC);
    assert.equal(result.width, 100, `${format} width`);
    assert.equal(result.height, 100, `${format} height`);
    assert.ok(result.ascii.length > 0);
  }
});

test('image_scan: chart png works through the tool with a mock fs', async () => {
  const rgba = makeChartRgba();
  const buffer = pngFromRgba(600, 400, rgba);
  const { ctx } = makeFakeCtx({ bytes: buffer });
  const tool = createImageScanTool(ctx);
  const result = await tool.execute({ file_path: 'chart.png' }, EXEC);
  assert.equal(result.gridWidth, 32);
  assert.equal(result.gridHeight, Math.round(32 * (400 / 600)));
  const text = tool.output.render({}, result).map((p) => p.text).join('\n');
  assert.match(text, /chart\.png \(600x400 -> 32x\d+ cells/);
});

test('importCore: hot reloads the module when the file changes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'picturereader-hot-'));
  const file = join(dir, 'core.js');
  try {
    writeFileSync(file, 'export const VERSION = "v1";\n');
    await sleep(5);
    const url = pathToFileURL(file).href;
    const first = await importCore(url);
    assert.equal(first.VERSION, 'v1');
    const cached = await importCore(url);
    assert.equal(cached, first, 'unchanged file must reuse the cached module');
    await sleep(5);
    writeFileSync(file, 'export const VERSION = "v2";\n');
    const second = await importCore(url);
    assert.equal(second.VERSION, 'v2');
    assert.notEqual(second, first, 'changed file must produce a fresh module');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
