import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { rapidAvailable, rapidPython, runRapidOcr, ocrImage } from '../src/core.js';
import { createImageOcrTool } from '../src/tool.js';

const OUT = join(dirname(fileURLToPath(import.meta.url)), 'fixtures-out', 'ocr-test.png');
const CHECKED_IN_FIXTURE = join(dirname(OUT), '..', 'fixtures', 'ocr-text.png');

// Native-engine readiness (see ocr.test.js): degrade tests need a working
// fallback engine on the current platform.
const IS_DARWIN = process.platform === 'darwin';
const MAC_OCR_READY = IS_DARWIN && (process.env.DSH_MACOS_OCR_BIN !== undefined || existsSync(join(homedir(), '.dsh', 'cache', 'picturereader', 'macos-ocr')));
const NATIVE_ENGINE = IS_DARWIN ? 'macos' : 'windows';
const NEED_MAC_BIN = IS_DARWIN && !MAC_OCR_READY ? 'macOS OCR binary not built — run: node scripts/setup-macos.mjs' : false;
const RAPID_VENV = 'C:/Users/Administrator/rapid_venv/Scripts/python.exe';

/** Whether the real rapid_venv is present on this machine (tests degrade otherwise). */
function haveRapidVenv() {
  return existsSync(RAPID_VENV) || existsSync('C:\\Users\\Administrator\\rapid_venv\\Scripts\\python.exe');
}

/**
 * Provide the text-bearing test image. Cross-platform: reuse the checked-in
 * CoreText fixture when present; fall back to PowerShell generation on Windows.
 */
function ensureOcrTestImage() {
  mkdirSync(dirname(OUT), { recursive: true });
  if (existsSync(OUT)) return;
  if (existsSync(CHECKED_IN_FIXTURE)) {
    copyFileSync(CHECKED_IN_FIXTURE, OUT);
    return;
  }
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

test('rapidAvailable: false for a missing interpreter', async () => {
  assert.equal(await rapidAvailable('C:/nonexistent/python-xyz.exe'), false);
});

test('rapidPython: defaults to the configured rapid_venv interpreter', () => {
  const prev = process.env.DSH_RAPID_PYTHON;
  try {
    delete process.env.DSH_RAPID_PYTHON;
    assert.equal(rapidPython(), 'C:/Users/Administrator/rapid_venv/Scripts/python.exe');
    process.env.DSH_RAPID_PYTHON = 'C:/custom/rapid/python.exe';
    assert.equal(rapidPython(), 'C:/custom/rapid/python.exe');
  } finally {
    if (prev === undefined) delete process.env.DSH_RAPID_PYTHON;
    else process.env.DSH_RAPID_PYTHON = prev;
  }
});

test('rapidAvailable: true for the configured interpreter when rapidocr is importable', { skip: !haveRapidVenv() }, async () => {
  assert.equal(await rapidAvailable(), true);
});

test('runRapidOcr: recognizes a text-bearing PNG', { skip: !haveRapidVenv() }, async () => {
  ensureOcrTestImage();
  const result = await runRapidOcr(OUT.replace(/\\/g, '/'));
  assert.ok(Array.isArray(result.lines));
  assert.ok(result.lines.length > 0, 'should return at least one line');
  const allText = result.lines.map((l) => l.text).join(' ');
  assert.match(allText, /OCR/, 'should recognize the English word OCR');
  assert.ok(result.lines.every((l) => l.score !== undefined), 'rapid lines carry confidence scores');
  const first = result.lines[0];
  assert.ok(first.x >= 0 && first.y >= 0 && first.width > 0 && first.height > 0, 'line box should be populated');
});

test('ocrImage: engine="rapid" runs the rapid pipeline end to end', { skip: !haveRapidVenv() }, async () => {
  ensureOcrTestImage();
  const buffer = readFileSync(OUT);
  const result = await ocrImage(buffer, '.png', { engine: 'rapid' });
  assert.ok(result.width > 0 && result.height > 0);
  assert.ok(result.lines.length > 0, 'should recognize text');
  const allText = result.lines.map((l) => l.text).join(' ');
  assert.match(allText, /OCR/);
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

test('image_ocr tool: engine="rapid" degrades gracefully when RapidOCR is missing', { skip: NEED_MAC_BIN }, async () => {
  ensureOcrTestImage();
  const bytes = readFileSync(OUT);
  const { ctx } = makeFakeCtx(bytes);
  const tool = createImageOcrTool(ctx);
  const prev = process.env.DSH_RAPID_PYTHON;
  process.env.DSH_RAPID_PYTHON = 'C:/definitely/not/here/python.exe';
  try {
    const result = await tool.execute({ file_path: 'ui.png', engine: 'rapid' }, EXEC);
    assert.equal(result.engine, NATIVE_ENGINE, 'must degrade to the platform-native engine');
    assert.match(result.note, /RapidOCR is not installed/);
    assert.match(result.note, /setup-rapid\.mjs/);
    const allText = result.lines.map((l) => l.text).join(' ');
    assert.match(allText, /OCR/);
  } finally {
    if (prev === undefined) delete process.env.DSH_RAPID_PYTHON;
    else process.env.DSH_RAPID_PYTHON = prev;
  }
});

test('image_ocr tool: engine="rapid" runs through execute when available', { skip: !haveRapidVenv() }, async () => {
  ensureOcrTestImage();
  const bytes = readFileSync(OUT);
  const { ctx } = makeFakeCtx(bytes);
  const tool = createImageOcrTool(ctx);
  const result = await tool.execute({ file_path: 'ui.png', engine: 'rapid' }, EXEC);
  assert.equal(result.engine, 'rapid');
  const allText = result.lines.map((l) => l.text).join(' ');
  assert.match(allText, /OCR/);
  assert.ok(result.lines.every((l) => l.score !== undefined), 'rapid lines carry confidence scores');
});
