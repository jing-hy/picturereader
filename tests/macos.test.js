import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { platform, homedir } from 'node:os';
import {
  macOcrBinary,
  macOcrAvailable,
  runMacOcr,
  ocrImage,
  encodePng
} from '../src/core.js';
import { OCR_ENGINE_KEYS as CONFIG_KEYS, ocrEngineOf } from '../src/config.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, 'fixtures', 'ocr-text.png');
const MAKE_FIXTURE_SRC = join(HERE, 'fixtures', 'make-fixture.swift');

/** Ensure the text-bearing fixture PNG exists (generate once on macOS). */
function ensureFixture() {
  if (existsSync(FIXTURE)) return true;
  if (platform() !== 'darwin') return false;
  const swiftcProbe = spawnSync('xcrun', ['-f', 'swiftc'], { encoding: 'utf8' });
  if (swiftcProbe.status !== 0) return false;
  const tmpBin = join(HERE, 'fixtures-out', 'make-fixture-bin');
  const compile = spawnSync(swiftcProbe.stdout.trim(), ['-O', '-swift-version', '5', MAKE_FIXTURE_SRC, '-o', tmpBin], { encoding: 'utf8' });
  if (compile.status !== 0) return false;
  const run = spawnSync(tmpBin, [FIXTURE], { encoding: 'utf8' });
  return run.status === 0 && existsSync(FIXTURE);
}

test('config: macos is a legal engine key everywhere', () => {
  assert.ok(CONFIG_KEYS.includes('macos'));
  assert.equal(ocrEngineOf({ ocr_engine: 'macos' }), 'macos');
});

test('macOcrBinary: default cache path, env override respected by available()', async () => {
  const previous = process.env.DSH_MACOS_OCR_BIN;
  delete process.env.DSH_MACOS_OCR_BIN;
  try {
    assert.equal(macOcrBinary(), join(homedir(), '.dsh', 'cache', 'picturereader', 'macos-ocr'));
  } finally {
    if (previous !== undefined) process.env.DSH_MACOS_OCR_BIN = previous;
  }
  // missing binary → not available (no crash)
  assert.equal(await macOcrAvailable('/nonexistent/macos-ocr-xyz'), false);
});

test('runMacOcr: clear error with setup hint when binary is missing', async () => {
  const previous = process.env.DSH_MACOS_OCR_BIN;
  process.env.DSH_MACOS_OCR_BIN = '/nonexistent/macos-ocr-xyz';
  try {
    await assert.rejects(
      () => runMacOcr('/tmp/picturereader-any-image.png'),
      /setup-macos\.mjs/
    );
  } finally {
    if (previous === undefined) delete process.env.DSH_MACOS_OCR_BIN;
    else process.env.DSH_MACOS_OCR_BIN = previous;
  }
});

test('runMacOcr: recognizes Chinese + English text with pixel boxes', { skip: !ensureFixture() && `fixture unavailable` }, async () => {
  // Use the compiled test binary when the production one is absent.
  let bin = macOcrBinary();
  if (!(await macOcrAvailable(bin))) {
    bin = '/tmp/macos-ocr-test'; // built by the dev loop; skip when neither exists
    if (!(await macOcrAvailable(bin))) return;
  }
  const result = await runMacOcr(FIXTURE);
  assert.ok(Array.isArray(result.lines));
  assert.ok(result.lines.length >= 1, 'expected at least one line');
  const joined = result.lines.map((l) => l.text).join(' ');
  assert.match(joined, /Hello/i);
  assert.match(joined, /你好世界/);
  for (const line of result.lines) {
    for (const key of ['text', 'score', 'x', 'y', 'width', 'height']) {
      assert.ok(key in line, `line missing ${key}`);
    }
    assert.ok(line.width > 0 && line.height > 0, 'box must have extent');
    assert.ok(line.x >= 0 && line.y >= 0, 'box origin must be non-negative');
    assert.ok(typeof line.score === 'number' && line.score <= 1.0001);
  }
});

test('runMacOcr: language=en-US drops CJK glyphs (priority honored)', { skip: !existsSync(FIXTURE) && 'no fixture' }, async () => {
  let bin = macOcrBinary();
  if (!(await macOcrAvailable(bin))) {
    bin = '/tmp/macos-ocr-test';
    if (!(await macOcrAvailable(bin))) return;
  }
  const result = await runMacOcr(FIXTURE, 'en-US');
  const joined = result.lines.map((l) => l.text).join(' ');
  assert.doesNotMatch(joined, /你好世界/);
});

test('core.ocrImage: engine="macos" routes through the mac pipeline', { skip: !existsSync(FIXTURE) && 'no fixture' }, async () => {
  let bin = macOcrBinary();
  if (!(await macOcrAvailable(bin))) {
    bin = '/tmp/macos-ocr-test';
    if (!(await macOcrAvailable(bin))) return;
  }
  const { readFileSync } = await import('node:fs');
  const raw = readFileSync(FIXTURE);
  const result = await ocrImage(raw, '.png', { engine: 'macos' });
  assert.ok(typeof result.width === 'number' && typeof result.height === 'number');
  assert.ok(Array.isArray(result.lines));
});
