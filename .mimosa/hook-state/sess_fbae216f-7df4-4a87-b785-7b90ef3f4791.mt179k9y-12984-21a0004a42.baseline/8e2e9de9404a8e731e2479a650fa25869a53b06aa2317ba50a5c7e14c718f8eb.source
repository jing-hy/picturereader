import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeImage, decodeBmp, IMAGE_EXTENSIONS, UNSUPPORTED_EXTENSIONS } from '../src/core.js';
import { makeQuadrant, bmpFromRgba, makeQuadrantRgba } from './fixtures.mjs';

test('decodeImage: PNG quadrant roundtrip preserves dimensions', () => {
  const { buffer, width, height } = makeQuadrant(100, 100, 'png');
  const image = decodeImage(buffer, '.png');
  assert.equal(image.width, width);
  assert.equal(image.height, height);
  assert.equal(image.data.length, width * height * 4);
});

test('decodeImage: JPEG quadrant roundtrip preserves dimensions', () => {
  const { buffer, width, height } = makeQuadrant(100, 100, 'jpeg');
  const image = decodeImage(buffer, '.jpeg');
  assert.equal(image.width, width);
  assert.equal(image.height, height);
});

test('decodeImage: GIF first frame preserves dimensions', () => {
  const { buffer, width, height } = makeQuadrant(100, 100, 'gif');
  const image = decodeImage(buffer, '.gif');
  assert.equal(image.width, width);
  assert.equal(image.height, height);
  // quadrant pixel check: top-left should be near-red after GIF palette mapping
  assert.ok(image.data[0] > 150 && image.data[2] < 100, 'top-left pixel should be red-ish');
});

test('decodeImage: BMP 24-bit and 32-bit roundtrip', () => {
  for (const bpp of [24, 32]) {
    const rgba = makeQuadrantRgba();
    const buffer = bmpFromRgba(100, 100, rgba, bpp);
    const image = decodeImage(buffer, '.bmp');
    assert.equal(image.width, 100);
    assert.equal(image.height, 100);
    assert.deepEqual([image.data[0], image.data[1], image.data[2]], [216, 27, 27], `bpp ${bpp} top-left should be red`);
    assert.equal(image.data[3], 255, `bpp ${bpp} alpha should be opaque`);
  }
});

test('decodeImage: BMP bottom-up row order', () => {
  const rgba = makeQuadrantRgba();
  const buffer = bmpFromRgba(100, 100, rgba, 24);
  const image = decodeImage(buffer, '.bmp');
  // source (x=0, y=99) is the blue quadrant; decoded data is top-down source order
  const bottomLeft = image.data[(99 * 100 + 0) * 4 + 2];
  assert.ok(bottomLeft > 150, 'bottom-left pixel should be blue-ish (B channel high)');
});

test('decodeImage: unsupported extension throws', () => {
  assert.throws(() => decodeImage(Buffer.alloc(8), '.txt'), /unsupported image type/);
  assert.throws(() => decodeImage(Buffer.alloc(8), '.webp'), /unsupported image type/);
});

test('decodeImage: truncated PNG throws a friendly error', () => {
  const { buffer } = makeQuadrant(100, 100, 'png');
  assert.throws(() => decodeImage(buffer.subarray(0, 60), '.png'), /not a valid PNG/);
});

test('decodeImage: JPEG garbage throws a friendly error', () => {
  assert.throws(() => decodeImage(Buffer.alloc(64).fill(0xff), '.jpg'), /not a valid JPEG/);
});

test('decodeBmp: bad magic rejected', () => {
  assert.throws(() => decodeBmp(Buffer.alloc(64)), /bad magic/);
});

test('decodeBmp: 16-bit and RLE rejected', () => {
  const header = Buffer.alloc(58);
  header.write('BM', 0, 'ascii');
  header.writeUInt32LE(58, 10);
  header.writeUInt32LE(40, 14);
  header.writeInt32LE(8, 18);
  header.writeInt32LE(8, 22);
  header.writeUInt16LE(1, 26);
  header.writeUInt16LE(16, 28);
  assert.throws(() => decodeBmp(header), /16-bit BMP is not supported/);
  header.writeUInt16LE(24, 28);
  header.writeUInt32LE(1, 30);
  assert.throws(() => decodeBmp(header), /RLE-compressed/);
});

test('extension sets are consistent', () => {
  assert.ok(IMAGE_EXTENSIONS.has('.png'));
  assert.ok(IMAGE_EXTENSIONS.has('.jpg'));
  assert.ok(IMAGE_EXTENSIONS.has('.jpeg'));
  assert.ok(IMAGE_EXTENSIONS.has('.gif'));
  assert.ok(IMAGE_EXTENSIONS.has('.bmp'));
  assert.ok(UNSUPPORTED_EXTENSIONS.has('.webp'));
});
