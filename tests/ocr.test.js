import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cropRgba, encodePng, buildOcrCommand, ocrImage, decodeImage, paddleAvailable } from '../src/core.js';
import { createImageOcrTool } from '../src/tool.js';
import { makeQuadrantRgba, pngFromRgba } from './fixtures.mjs';

const OUT = join(dirname(fileURLToPath(import.meta.url)), 'fixtures-out', 'ocr-test.png');

/** Generate the text-bearing test image once (PowerShell System.Drawing). */
function ensureOcrTestImage() {
  mkdirSync(dirname(OUT), { recursive: true });
  if (existsSync(OUT)) return;
  const ps = [
    'Add-Type -AssemblyName System.Drawing',
    '$bmp = New-Object System.Drawing.Bitmap 900, 220',
    '$g = [System.Drawing.Graphics]::FromImage($bmp)',
    '$g.Clear([System.Drawing.Color]::White)',
    "$font = New-Object System.Drawing.Font('Microsoft YaHei', 48)",
    "$g.DrawString('Hello OCR 123 你好世界', $font, [System.Drawing.Brushes]::Black, 30, 60)",
    '$g.Dispose()',
    `$bmp.Save('${OUT.replaceAll("'", "''")}', [System.Drawing.Imaging.ImageFormat]::Png)`,
    '$bmp.Dispose()'
  ].join('; ');
  const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`cannot generate ocr test image: ${result.stderr}`);
}

test('cropRgba: crops a fraction region', () => {
  const rgba = makeQuadrantRgba();
  const cropped = cropRgba(rgba, 100, 100, [0, 0, 0.5, 0.5]);
  assert.equal(cropped.width, 50);
  assert.equal(cropped.height, 50);
  // top-left pixel of the crop is the red quadrant
  assert.deepEqual([cropped.data[0], cropped.data[1], cropped.data[2]], [216, 27, 27]);
});

test('cropRgba: full region returns the whole image', () => {
  const rgba = makeQuadrantRgba();
  const cropped = cropRgba(rgba, 100, 100, undefined);
  assert.equal(cropped.width, 100);
  assert.equal(cropped.height, 100);
  assert.deepEqual([cropped.data[0], cropped.data[1], cropped.data[2]], [216, 27, 27]);
});

test('encodePng: roundtrips through the PNG decoder', () => {
  const rgba = makeQuadrantRgba();
  const bytes = encodePng(rgba, 100, 100);
  const decoded = decodeImage(bytes, '.png');
  assert.equal(decoded.width, 100);
  assert.equal(decoded.height, 100);
  assert.deepEqual([decoded.data[0], decoded.data[1], decoded.data[2]], [216, 27, 27]);
});

test('buildOcrCommand: inlines the path with single-quote escaping', () => {
  const command = buildOcrCommand("C:\\tmp\\it's.png", undefined);
  assert.ok(command.includes("$path = 'C:\\tmp\\it''s.png'"));
  assert.ok(command.includes('TryCreateFromUserProfileLanguages'));
  const zh = buildOcrCommand('C:\\tmp\\a.png', 'zh-Hans');
  assert.ok(zh.includes("TryCreateFromLanguage([Windows.Globalization.Language]::new('zh-Hans'))"));
});

test('ocrImage: recognizes English and Chinese text end to end', async () => {
  ensureOcrTestImage();
  const { readFileSync } = await import('node:fs');
  const buffer = readFileSync(OUT);
  const result = await ocrImage(buffer, '.png');
  assert.ok(result.width > 0 && result.height > 0);
  const allText = result.lines.map((l) => l.text).join(' ');
  assert.match(allText, /OCR/, 'should recognize the English word OCR');
  assert.match(allText, /世/, 'should recognize Chinese characters');
  assert.ok(result.lines[0].x >= 0 && result.lines[0].width > 0, 'line box should be populated');
});

test('ocrImage: region crop restricts recognition', async () => {
  ensureOcrTestImage();
  const { readFileSync } = await import('node:fs');
  const buffer = readFileSync(OUT);
  // top 20% has no text (text sits around y 60..122 of 220)
  const empty = await ocrImage(buffer, '.png', { region: [0, 0, 1, 0.2] });
  assert.equal(empty.lines.length, 0);
  // band around the text still recognizes it
  const hit = await ocrImage(buffer, '.png', { region: [0, 0.25, 1, 0.7] });
  assert.ok(hit.lines.length > 0);
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

test('image_ocr tool: full pipeline through execute', async () => {
  ensureOcrTestImage();
  const { readFileSync } = await import('node:fs');
  const bytes = readFileSync(OUT);
  const { ctx, emitted } = makeFakeCtx(bytes);
  const tool = createImageOcrTool(ctx);
  const result = await tool.execute({ file_path: 'ui.png' }, EXEC);
  assert.equal(result.path, 'C:\\img\\ui.png');
  assert.equal(result.region, 'full');
  const allText = result.lines.map((l) => l.text).join(' ');
  assert.match(allText, /OCR/);
  assert.match(allText, /世/);
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0][0], 'fs/observed');
  const rendered = tool.output.render({}, result).map((p) => p.text).join('\n');
  assert.match(rendered, /recognized \d+ line\(s\)/);
  assert.match(rendered, /ocr: C:\\img\\ui\.png/);
});

test('image_ocr tool: focus restriction and validation', async () => {
  ensureOcrTestImage();
  const { readFileSync } = await import('node:fs');
  const bytes = readFileSync(OUT);
  const { ctx } = makeFakeCtx(bytes);
  const tool = createImageOcrTool(ctx);
  const focused = await tool.execute({ file_path: 'ui.png', focus: [1, 0, 5, 30] }, EXEC);
  assert.equal(focused.region, 'focus [1,0,5,30]');
  const allText = focused.lines.map((l) => l.text).join(' ');
  assert.match(allText, /OCR/);
  await assert.rejects(
    () => tool.execute({ file_path: 'ui.png', region: [0, 0, 0.5, 0.5], focus: [0, 0, 4, 4] }, EXEC),
    /region and focus are mutually exclusive/
  );
  await assert.rejects(() => tool.execute({ file_path: 'ui.png', language: '   ' }, EXEC), /language must be a non-empty/);
  await assert.rejects(() => tool.execute({ file_path: 'notes.txt' }, EXEC), /unsupported image type/);
  await assert.rejects(() => tool.execute({ file_path: 'x.webp' }, EXEC), /WebP is not supported/);
  await assert.rejects(() => tool.execute({ file_path: 'ui.png', engine: 'tesseract' }, EXEC), /engine must be 'windows' \(default\) or 'paddle'/);
});

test('image_ocr: paddle engine recognizes the same test image', { skip: !existsSync('C:/Users/Administrator/paddle_venv/Scripts/python.exe') }, async () => {
  ensureOcrTestImage();
  const { readFileSync } = await import('node:fs');
  const bytes = readFileSync(OUT);
  const { ctx } = makeFakeCtx(bytes);
  const tool = createImageOcrTool(ctx);
  const result = await tool.execute({ file_path: 'ui.png', engine: 'paddle' }, EXEC);
  assert.equal(result.engine, 'paddle');
  const allText = result.lines.map((l) => l.text).join(' ');
  assert.match(allText, /OCR/);
  assert.match(allText, /世/);
  assert.ok(result.lines.every((l) => l.score !== undefined), 'paddle lines carry confidence scores');
});

test('paddleAvailable: false for a missing interpreter, true for the configured one', async () => {
  assert.equal(await paddleAvailable('C:/nonexistent/python-xyz.exe'), false);
  if (existsSync('C:/Users/Administrator/paddle_venv/Scripts/python.exe')) {
    assert.equal(await paddleAvailable(), true);
  }
});

test('image_ocr: engine="paddle" degrades gracefully when PaddleOCR is missing', async () => {
  ensureOcrTestImage();
  const { readFileSync } = await import('node:fs');
  const bytes = readFileSync(OUT);
  const { ctx } = makeFakeCtx(bytes);
  const tool = createImageOcrTool(ctx);
  // point the optional paddle env at a path that cannot exist
  const prev = process.env.DSH_PADDLE_PYTHON;
  process.env.DSH_PADDLE_PYTHON = 'C:/definitely/not/here/python.exe';
  try {
    const result = await tool.execute({ file_path: 'ui.png', engine: 'paddle' }, EXEC);
    assert.equal(result.engine, 'windows', 'must degrade to the Windows engine');
    assert.match(result.note, /PaddleOCR is not installed/);
    // degraded result still works (recognizes the control image)
    const allText = result.lines.map((l) => l.text).join(' ');
    assert.match(allText, /OCR/);
  } finally {
    if (prev === undefined) delete process.env.DSH_PADDLE_PYTHON;
    else process.env.DSH_PADDLE_PYTHON = prev;
  }
});
