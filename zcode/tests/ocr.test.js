import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cropRgba, encodePng, buildOcrCommand, ocrImage, decodeImage, paddleAvailable, downscaleRgba, PADDLE_MAX_LONG_SIDE } from '../src/core.js';
import { executeTool } from '../mcp/server.js';
import { makeQuadrantRgba, pngFromRgba, createRgba } from './fixtures.mjs';

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

test('image_ocr tool: full pipeline through execute', async () => {
  ensureOcrTestImage();
  const { readFileSync } = await import('node:fs');
  const bytes = readFileSync(OUT);
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(join(tmpdir(), 'picturereader-ocr-test-'));
  const file = join(dir, 'ui.png');
  writeFileSync(file, bytes);
  try {
    const result = await executeTool('image_ocr', { file_path: file });
    assert.equal(result.path, file);
    assert.equal(result.region, 'full');
    const allText = result.lines.map((l) => l.text).join(' ');
    assert.match(allText, /OCR/);
    assert.match(allText, /世/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('image_ocr tool: focus restriction and validation', async () => {
  ensureOcrTestImage();
  const { readFileSync } = await import('node:fs');
  const bytes = readFileSync(OUT);
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(join(tmpdir(), 'picturereader-ocr-test-'));
  const file = join(dir, 'ui.png');
  writeFileSync(file, bytes);
  try {
    const focused = await executeTool('image_ocr', { file_path: file, focus: [1, 0, 5, 30] });
    assert.equal(focused.region, 'focus [1,0,5,30]');
    const allText = focused.lines.map((l) => l.text).join(' ');
    assert.match(allText, /OCR/);
    await assert.rejects(
      () => executeTool('image_ocr', { file_path: file, region: [0, 0, 0.5, 0.5], focus: [0, 0, 4, 4] }),
      /region and focus are mutually exclusive/
    );
    await assert.rejects(() => executeTool('image_ocr', { file_path: file, language: '   ' }), /language must be a non-empty/);
    await assert.rejects(() => executeTool('image_ocr', { file_path: 'notes.txt' }), /unsupported image type/);
    await assert.rejects(() => executeTool('image_ocr', { file_path: 'x.webp' }), /WebP is not supported/);
    await assert.rejects(() => executeTool('image_ocr', { file_path: file, engine: 'tesseract' }), /engine must be 'windows' \(default\) or 'paddle'/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('image_ocr: paddle engine recognizes the same test image', { skip: !existsSync('C:/Users/Administrator/paddle_venv/Scripts/python.exe') }, async () => {
  ensureOcrTestImage();
  const result = await executeTool('image_ocr', { file_path: OUT, engine: 'paddle' });
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

test('downscaleRgba: caps the longer side with box-averaged colors', () => {
  const rgba = makeQuadrantRgba(); // 100x100 red|green / blue|yellow
  const result = downscaleRgba(rgba, 100, 100, 50);
  assert.equal(result.downscaled, true);
  assert.equal(result.width, 50);
  assert.equal(result.height, 50);
  assert.deepEqual([result.data[0], result.data[1], result.data[2]], [216, 27, 27], 'top-left stays red');
  const topRight = 49 * 4; // cell (row 0, col 49) spans source x 98..100
  assert.deepEqual([result.data[topRight], result.data[topRight + 1], result.data[topRight + 2]], [46, 158, 68], 'top-right stays green');
  // a small image is returned untouched (same buffer, no copy)
  const small = downscaleRgba(rgba, 100, 100, 1000);
  assert.equal(small.downscaled, false);
  assert.equal(small.data, rgba);
  assert.equal(small.width, 100);
});

test('downscaleRgba: keeps aspect ratio at the cap', () => {
  const rgba = createRgba(3000, 1200, () => [255, 0, 0, 255]);
  const result = downscaleRgba(rgba, 3000, 1200, PADDLE_MAX_LONG_SIDE);
  assert.equal(result.width, 1600);
  assert.equal(result.height, 640);
});

test('ocrImage: paddle engine downscales large images to the cap, windows engine does not', { skip: !existsSync('C:/Users/Administrator/paddle_venv/Scripts/python.exe') }, async () => {
  const rgba = createRgba(3000, 1200, () => [250, 250, 250, 255]);
  const buffer = pngFromRgba(3000, 1200, rgba);
  const paddle = await ocrImage(buffer, '.png', { engine: 'paddle' });
  assert.equal(paddle.downscaled, true, 'paddle should report the downscale');
  assert.ok(paddle.width <= PADDLE_MAX_LONG_SIDE && paddle.height <= PADDLE_MAX_LONG_SIDE, `paddle dims ${paddle.width}x${paddle.height} must fit the cap`);
  const windows = await ocrImage(buffer, '.png', { engine: 'windows' });
  assert.equal(windows.width, 3000, 'windows engine keeps the original resolution');
  assert.equal(windows.height, 1200);
});

test('image_ocr: engine="paddle" degrades gracefully when PaddleOCR is missing', async () => {
  ensureOcrTestImage();
  // point the optional paddle env at a path that cannot exist
  const prev = process.env.DSH_PADDLE_PYTHON;
  process.env.DSH_PADDLE_PYTHON = 'C:/definitely/not/here/python.exe';
  try {
    const result = await executeTool('image_ocr', { file_path: OUT, engine: 'paddle' });
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
