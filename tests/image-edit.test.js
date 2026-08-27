/**
 * Tests for the image_edit tool (src/image-edit.js).
 *
 * Pure-logic / structural tests use an in-memory fake ctx.fs plus an injected
 * fake `_imageEditRunner` so they never touch the real Python / Pillow/OpenCV.
 * The fake runner captures the request JSON the tool builds (action / from /
 * from_extra / out / action params) and returns a canned result, letting us
 * assert the tool's contract without the venv.
 *
 * Run: node --test tests/image-edit.test.js
 * @module picturereader/tests/image-edit
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createImageEditTool } from '../src/image-edit.js';

// ---------------------------------------------------------------- helpers

/**
 * Build a fake ctx with in-memory fs. `captured` is an array that each
 * runner call pushes the parsed request JSON into (plus the timeoutMs).
 */
function makeFakeCtx(entries, captured, opts = {}) {
  const runner =
    opts.runner ||
    ((reqPath, timeoutMs) => {
      captured.push({ req: JSON.parse(readFileSync(reqPath, 'utf8')), timeoutMs });
      return {
        ok: true,
        action: 'resize',
        out_path: 'C:\\out\\resized.png',
        width: 100,
        height: 80,
        bytes: 1234,
        format: 'PNG',
        summary: 'test summary ok'
      };
    });
  const ctx = {
    tools: { register() {} },
    fs: {
      async resolve(path, o) {
        return { targetKey: `k:${path}`, displayPath: path };
      },
      async stat(target) {
        const e = entries[target.displayPath];
        if (!e) return null;
        return { version: 'v1', type: 'file', size: (e.buffer || '').length };
      },
      async readBytes(target) {
        const e = entries[target.displayPath];
        if (!e) throw new Error(`mock readBytes: no bytes for ${target.displayPath}`);
        return e.buffer;
      }
    },
    _imageEditRunner: runner
  };
  return ctx;
}

const EXEC = { signal: undefined, agent: { session: { header: { cwd: 'C:\\work' }, id: 'sess-1' } } };

// ---------------------------------------------------------------- tests

test('image_edit: unknown action throws', async () => {
  const captured = [];
  const ctx = makeFakeCtx({}, captured);
  const tool = createImageEditTool(ctx);
  await assert.rejects(
    tool.execute({ action: 'nope', file_path: 'C:\\in.png' }, EXEC),
    /未知 action/
  );
  assert.equal(captured.length, 0, 'runner should not be called');
});

test('image_edit: missing file_path throws', async () => {
  const captured = [];
  const ctx = makeFakeCtx({}, captured);
  const tool = createImageEditTool(ctx);
  await assert.rejects(
    tool.execute({ action: 'resize', width: 100, height: 100 }, EXEC),
    /需要 file_path/
  );
  assert.equal(captured.length, 0);
});

test('image_edit: resize builds correct request JSON (action/from/out + params)', async () => {
  const captured = [];
  const ctx = makeFakeCtx({ 'C:\\in.png': { buffer: Buffer.from('PNGDATA'), type: 'file' } }, captured);
  const tool = createImageEditTool(ctx);
  const res = await tool.execute(
    { action: 'resize', file_path: 'C:\\in.png', width: 200, height: 150, mode: 'fit' },
    EXEC
  );
  assert.equal(captured.length, 1);
  const { req, timeoutMs } = captured[0];
  assert.equal(req.action, 'resize');
  assert.equal(req.width, 200);
  assert.equal(req.height, 150);
  assert.equal(req.mode, 'fit');
  assert.ok(req.from.endsWith('in.png'), `main input materialized: ${req.from}`);
  assert.ok(req.out.endsWith('.png'), `default out has .png ext: ${req.out}`);
  assert.ok(req.out.includes('picturereader-edit'), 'out under default edit dir');
  // result contract
  assert.equal(res.ok, true);
  assert.equal(res.action, 'resize');
  assert.equal(res.width, 100);
  assert.equal(res.summary, 'test summary ok');
});

test('image_edit: composite passes from_extra (foreground image)', async () => {
  const captured = [];
  const entries = {
    'C:\\bg.png': { buffer: Buffer.from('BG'), type: 'file' },
    'C:\\fg.png': { buffer: Buffer.from('FG'), type: 'file' }
  };
  const ctx = makeFakeCtx(entries, captured);
  const tool = createImageEditTool(ctx);
  const res = await tool.execute(
    { action: 'composite', file_path: 'C:\\bg.png', file_paths: ['C:\\fg.png'], position: 'bottom_right', alpha: 0.5 },
    EXEC
  );
  assert.equal(captured.length, 1);
  const { req } = captured[0];
  assert.equal(req.action, 'composite');
  assert.equal(req.position, 'bottom_right');
  assert.equal(req.alpha, 0.5);
  assert.ok(Array.isArray(req.from_extra) && req.from_extra.length === 1);
  assert.ok(req.from_extra[0].endsWith('fg.png'), 'foreground materialized into from_extra');
  assert.ok(req.from.endsWith('bg.png'));
  assert.equal(res.action, 'composite');
});

test('image_edit: explicit out path honored, defaults resolved against cwd', async () => {
  const captured = [];
  const ctx = makeFakeCtx({ 'C:\\in.png': { buffer: Buffer.from('X'), type: 'file' } }, captured);
  const tool = createImageEditTool(ctx);
  await tool.execute(
    { action: 'thumbnail', file_path: 'C:\\in.png', out: 'sub\\thumb.jpg', out_dir: 'C:\\outdir' },
    EXEC
  );
  const { req } = captured[0];
  assert.equal(req.action, 'thumbnail');
  // out_dir absolute, out relative -> resolved against cwd C:\work
});

test('image_edit: default timeout used', async () => {
  const captured = [];
  const ctx = makeFakeCtx({ 'C:\\in.png': { buffer: Buffer.from('X'), type: 'file' } }, captured);
  const tool = createImageEditTool(ctx);
  await tool.execute({ action: 'flip', file_path: 'C:\\in.png', axis: 'horizontal' }, EXEC);
  assert.equal(captured[0].timeoutMs, 120_000);
});

test('image_edit: remove_background gets longer timeout', async () => {
  const captured = [];
  const ctx = makeFakeCtx(
    { 'a.png': { buffer: Buffer.from('X'), type: 'file' } },
    captured,
    { runner: (reqPath, timeoutMs) => {
        const req = JSON.parse(readFileSync(reqPath, 'utf8'));
        captured.push({ req, timeoutMs });
        return { ok: true, action: req.action, out_path: 'x.png', width: 1, height: 1, bytes: 1, format: 'PNG', summary: 'ok' };
    } }
  );
  const tool = createImageEditTool(ctx);
  await tool.execute({ action: 'remove_background', file_path: 'a.png' }, EXEC);
  assert.equal(captured[0].timeoutMs, 300_000);
});

test('image_edit: python error surfaces as tool error', async () => {
  const captured = [];
  const ctx = makeFakeCtx(
    { 'a.png': { buffer: Buffer.from('X'), type: 'file' } },
    captured,
    { runner: () => { throw new Error('image_edit: 背景移除需要 rembg...'); } }
  );
  const tool = createImageEditTool(ctx);
  await assert.rejects(
    tool.execute({ action: 'remove_background', file_path: 'a.png' }, EXEC),
    /rembg/
  );
});
