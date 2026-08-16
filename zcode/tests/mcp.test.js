import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { createInterface } from 'node:readline';
import { PassThrough, Writable } from 'node:stream';
import { handleRequest, executeTool, importCore, resolveImagePath, runServer, TOOLS, PROTOCOL_VERSION } from '../mcp/server.js';
import { makeQuadrant, makeChartRgba, pngFromRgba } from './fixtures.mjs';

/** Write fixture bytes to a temp dir and return its path. */
function makeTempImage(bytes, name = 'a.png') {
  const dir = mkdtempSync(join(tmpdir(), 'picturereader-test-'));
  const file = join(dir, name);
  writeFileSync(file, bytes);
  return { dir, file };
}

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

test('resolveImagePath: absolute paths pass through, relative resolves against PICTUREREADER_CWD', async () => {
  const absolute = 'D:\\abs\\shot.png';
  assert.equal(resolveImagePath(absolute), absolute);
  const dir = mkdtempSync(join(tmpdir(), 'picturereader-cwd-'));
  const prev = process.env.PICTUREREADER_CWD;
  process.env.PICTUREREADER_CWD = dir;
  try {
    assert.equal(resolveImagePath('shot.png'), join(dir, 'shot.png'));
    assert.equal(resolveImagePath('nested/shot.png'), join(dir, 'nested', 'shot.png'));
  } finally {
    if (prev === undefined) delete process.env.PICTUREREADER_CWD;
    else process.env.PICTUREREADER_CWD = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('image_scan tool executes end to end', async () => {
  const { buffer } = makeQuadrant(100, 100, 'png');
  const { dir, file } = makeTempImage(buffer);
  try {
    const result = await executeTool('image_scan', { file_path: file });
    assert.equal(result.path, file);
    assert.equal(result.width, 100);
    assert.equal(result.height, 100);
    assert.equal(result.gridWidth, 32);
    assert.equal(result.gridHeight, 32);
    assert.equal(result.mode, 'color');
    assert.ok(result.ascii.length > 0);
    assert.ok(result.colorGrid !== undefined);
    const names = result.colors.map((c) => c.name);
    for (const color of ['red', 'green', 'blue', 'yellow']) assert.ok(names.includes(color));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('image_scan: file not found gives a clear error', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'picturereader-empty-'));
  const prev = process.env.PICTUREREADER_CWD;
  process.env.PICTUREREADER_CWD = dir;
  try {
    await assert.rejects(() => executeTool('image_scan', { file_path: 'missing.png' }), /file not found/);
  } finally {
    if (prev === undefined) delete process.env.PICTUREREADER_CWD;
    else process.env.PICTUREREADER_CWD = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('image_scan: WebP gives a friendly conversion hint', async () => {
  await assert.rejects(() => executeTool('image_scan', { file_path: 'photo.webp' }), /WebP is not supported yet/);
});

test('image_scan: unsupported extension rejected', async () => {
  await assert.rejects(() => executeTool('image_scan', { file_path: 'notes.txt' }), /unsupported image type/);
});

test('image_scan: argument validation', async () => {
  const { buffer } = makeQuadrant(100, 100, 'png');
  const { dir, file } = makeTempImage(buffer);
  try {
    await assert.rejects(() => executeTool('image_scan', { file_path: '   ' }), /non-empty/);
    await assert.rejects(() => executeTool('image_scan', { file_path: file, size: 4 }), /size must be an integer between 8 and 64/);
    await assert.rejects(() => executeTool('image_scan', { file_path: file, size: 128 }), /size must be an integer between 8 and 64/);
    await assert.rejects(() => executeTool('image_scan', { file_path: file, size: 16.5 }), /size must be an integer/);
    await assert.rejects(() => executeTool('image_scan', { file_path: file, mode: 'fancy' }), /mode must be one of/);
    await assert.rejects(() => executeTool('image_scan', { file_path: file, palette: 'neon' }), /palette must be one of/);
    await assert.rejects(() => executeTool('image_scan', { file_path: file, region: [0, 0, 0.2] }), /region must be/);
    await assert.rejects(() => executeTool('image_scan', { file_path: file, px_per_cell: 0 }), /px_per_cell must be an integer between 1 and 512/);
    await assert.rejects(() => executeTool('image_scan', { file_path: file, px_per_cell: 2.5 }), /px_per_cell must be an integer/);
    await assert.rejects(() => executeTool('image_scan', { file_path: file, size: 32, px_per_cell: 4 }), /size and px_per_cell are mutually exclusive/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('image_scan: px_per_cell drives fine-grained grid density', async () => {
  const { buffer } = makeQuadrant(100, 100, 'png');
  const { dir, file } = makeTempImage(buffer);
  try {
    // left half 50x100 px at 5 px/cell -> 10x20 grid
    const result = await executeTool('image_scan', { file_path: file, region: [0, 0, 0.5, 1], px_per_cell: 5 });
    assert.equal(result.gridWidth, 10);
    assert.equal(result.gridHeight, 20);
    assert.equal(result.regionWidth / result.gridWidth, 5);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('image_scan: palette argument is validated and passed through', async () => {
  const { buffer } = makeQuadrant(100, 100, 'png');
  const { dir, file } = makeTempImage(buffer);
  try {
    const full = await executeTool('image_scan', { file_path: file, palette: 'auto' });
    assert.equal(full.palette, 'full'); // quadrant is colorful -> auto resolves to full
    const gray = await executeTool('image_scan', { file_path: file, palette: 'gray', mode: 'color' });
    assert.equal(gray.palette, 'gray');
    assert.ok([...new Set(gray.colorGrid.replace(/\s/g, ''))].every((code) => 'KWG'.includes(code)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('image_scan: focus zooms using grid coordinates', async () => {
  const { buffer } = makeQuadrant(100, 100, 'png');
  const { dir, file } = makeTempImage(buffer);
  try {
    // quadrant 100x100, size=16 -> full grid 16x16; focus top-left 8x8 block -> red only
    const result = await executeTool('image_scan', { file_path: file, size: 16, focus: [0, 0, 7, 7] });
    assert.equal(result.region, 'focus [0,0,7,7]');
    const names = result.colors.map((c) => c.name);
    assert.deepEqual(names, ['red'], `top-left focus should be only red, got ${names.join(',')}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('image_scan: focus and region are mutually exclusive', async () => {
  const { buffer } = makeQuadrant(100, 100, 'png');
  const { dir, file } = makeTempImage(buffer);
  try {
    await assert.rejects(
      () => executeTool('image_scan', { file_path: file, region: [0, 0, 0.5, 0.5], focus: [0, 0, 4, 4] }),
      /region and focus are mutually exclusive/
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('image_scan: focus out of range gives the grid dimensions', async () => {
  const { buffer } = makeQuadrant(100, 100, 'png');
  const { dir, file } = makeTempImage(buffer);
  try {
    await assert.rejects(
      () => executeTool('image_scan', { file_path: file, size: 16, focus: [0, 0, 20, 4] }),
      /grid is 16x16/
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('image_scan: region zoom works through the tool', async () => {
  const { buffer } = makeQuadrant(100, 100, 'png');
  const { dir, file } = makeTempImage(buffer);
  try {
    const result = await executeTool('image_scan', { file_path: file, region: [0, 0, 0.5, 1] });
    assert.match(result.region, /^0,0,0\.5,1$/);
    const names = result.colors.map((c) => c.name);
    assert.ok(names.includes('red') && names.includes('blue'));
    assert.ok(!names.includes('green'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('image_scan: gif and bmp files decode through the tool', async () => {
  for (const format of ['gif', 'bmp']) {
    const { buffer } = makeQuadrant(100, 100, format);
    const { dir, file } = makeTempImage(buffer, `a.${format}`);
    try {
      const result = await executeTool('image_scan', { file_path: file });
      assert.equal(result.width, 100, `${format} width`);
      assert.equal(result.height, 100, `${format} height`);
      assert.ok(result.ascii.length > 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('image_scan: chart png works through the tool', async () => {
  const rgba = makeChartRgba();
  const buffer = pngFromRgba(600, 400, rgba);
  const { dir, file } = makeTempImage(buffer, 'chart.png');
  try {
    const result = await executeTool('image_scan', { file_path: file });
    assert.equal(result.gridWidth, 32);
    assert.equal(result.gridHeight, Math.round(32 * (400 / 600)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('handleRequest: initialize returns server info', async () => {
  const response = await handleRequest({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'test', version: '1' } }
  });
  assert.equal(response.id, 1);
  assert.equal(response.result.protocolVersion, PROTOCOL_VERSION);
  assert.equal(response.result.serverInfo.name, 'picturereader');
  assert.ok(response.result.capabilities.tools, 'tools capability declared');
});

test('handleRequest: tools/list exposes the three image tools with schemas', async () => {
  const response = await handleRequest({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const tools = response.result.tools;
  assert.equal(tools.length, 3);
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, ['image_ocr', 'image_sample', 'image_scan']);
  for (const tool of tools) {
    assert.ok(tool.description.length > 100, `${tool.name} has a real description`);
    assert.equal(tool.inputSchema.type, 'object');
    assert.ok(tool.inputSchema.properties.file_path, `${tool.name} requires file_path`);
    assert.ok(Array.isArray(tool.inputSchema.required));
  }
  assert.equal(TOOLS.length, 3, 'exported TOOLS matches the served list');
});

test('handleRequest: tools/call renders text content plus structured result', async () => {
  const { buffer } = makeQuadrant(100, 100, 'png');
  const { dir, file } = makeTempImage(buffer);
  try {
    const response = await handleRequest({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'image_scan', arguments: { file_path: file } }
    });
    assert.equal(response.result.isError, false);
    assert.equal(response.result.content[0].type, 'text');
    assert.match(response.result.content[0].text, /colors by area:/);
    assert.match(response.result.content[0].text, /luminance grid/);
    assert.equal(response.result.structuredContent.gridWidth, 32);
    assert.equal(response.result.structuredContent.width, 100);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('handleRequest: tools/call errors are reported in-band with isError', async () => {
  const response = await handleRequest({
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    params: { name: 'image_scan', arguments: { file_path: 'nope.webp' } }
  });
  assert.equal(response.result.isError, true);
  assert.match(response.result.content[0].text, /WebP is not supported/);
});

test('handleRequest: notifications get no response', async () => {
  const response = await handleRequest({ jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.equal(response, null);
  const ping = await handleRequest({ jsonrpc: '2.0', method: 'ping' });
  assert.equal(ping, null, 'notification-like messages (no id) are ignored');
});

test('handleRequest: unknown methods get a JSON-RPC error', async () => {
  const response = await handleRequest({ jsonrpc: '2.0', id: 5, method: 'resources/list' });
  assert.equal(response.error.code, -32601);
  assert.match(response.error.message, /method not found/);
});

test('handleRequest: ping request returns an empty result', async () => {
  const response = await handleRequest({ jsonrpc: '2.0', id: 6, method: 'ping' });
  assert.deepEqual(response.result, {});
});

test('MCP server: end-to-end protocol over a stream pair', async () => {
  const { buffer } = makeQuadrant(100, 100, 'png');
  const { dir, file } = makeTempImage(buffer);
  const clientIn = new PassThrough();
  const clientOut = new PassThrough();
  // The client writes JSON-RPC lines into clientIn; the server reads them and
  // writes its responses onto clientOut, which the client reads back.
  const dispose = runServer(clientIn, clientOut, new Writable({ write(_chunk, _enc, cb) { cb(); } }));
  const pending = new Map();
  const rl = createInterface({ input: clientOut, crlfDelay: Infinity });
  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      return;
    }
    const resolve = pending.get(msg.id);
    if (resolve !== undefined) {
      pending.delete(msg.id);
      resolve(msg);
    }
  });
  const request = (method, params, id) => new Promise((resolve) => {
    pending.set(id, resolve);
    clientIn.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) })}\n`);
  });
  try {
    const init = await request('initialize', { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'test', version: '1' } }, 1);
    assert.equal(init.result.serverInfo.name, 'picturereader');
    const list = await request('tools/list', undefined, 2);
    assert.equal(list.result.tools.length, 3);
    const call = await request('tools/call', { name: 'image_scan', arguments: { file_path: file } }, 3);
    assert.equal(call.result.isError, false);
    assert.match(call.result.content[0].text, /image: .* \(100x100 -> 32x32 cells/);
  } finally {
    dispose();
    rl.close();
    clientIn.destroy();
    clientOut.destroy();
    rmSync(dir, { recursive: true, force: true });
  }
});
