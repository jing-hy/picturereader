import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeImage, normalizeRegion, renderImageScan, resolveFocus, RAMP, SIZE_RANGE, classify, buildBlobs, shadeFor, structuralHints } from '../src/core.js';
import {
  makeQuadrantRgba,
  makeChartRgba,
  makeGradientRgba,
  makeTransparentRgba,
  makeFlatTreeRgba,
  makePhotoishRgba,
  makeThinLineRgba
} from './fixtures.mjs';

const QUADRANT_COLORS = ['red', 'green', 'blue', 'yellow'];

test('analyzeImage: four quadrants yield ~25% each and color mode', () => {
  const rgba = makeQuadrantRgba();
  const result = analyzeImage(rgba, 100, 100, { size: 32, mode: 'auto', region: undefined });
  assert.equal(result.gridWidth, 32);
  assert.equal(result.gridHeight, 32);
  assert.equal(result.mode, 'color');
  const byName = Object.fromEntries(result.colors.map((c) => [c.name, c.pct]));
  for (const color of QUADRANT_COLORS) {
    assert.ok(byName[color] >= 20 && byName[color] <= 30, `${color} should be ~25%, got ${byName[color]}`);
  }
  assert.ok(result.colorGrid !== undefined, 'color mode should include colorGrid');
  assert.ok(result.colorLegend !== undefined);
});

test('analyzeImage: grid height follows aspect ratio', () => {
  const rgba = makeQuadrantRgba();
  const result = analyzeImage(rgba, 200, 100, { size: 32, mode: 'ascii', region: undefined });
  assert.equal(result.gridWidth, 32);
  assert.equal(result.gridHeight, 16);
});

test('analyzeImage: region crops to the left half', () => {
  const rgba = makeQuadrantRgba();
  const result = analyzeImage(rgba, 100, 100, { size: 16, mode: 'auto', region: [0, 0, 0.5, 1] });
  const names = result.colors.map((c) => c.name);
  assert.ok(names.includes('red') && names.includes('blue'), 'left half should be red+blue');
  assert.ok(!names.includes('green') && !names.includes('yellow'), 'right half colors must not appear');
});

test('analyzeImage: fully transparent image renders blank cells', () => {
  const rgba = makeTransparentRgba();
  const result = analyzeImage(rgba, 64, 64, { size: 16, mode: 'auto', region: undefined });
  assert.equal(result.colors.length, 0);
  assert.equal(result.ascii.trim(), '');
  assert.equal(result.mode, 'ascii');
});

test('analyzeImage: gray gradient stays ascii mode and spans the ramp', () => {
  const rgba = makeGradientRgba();
  const result = analyzeImage(rgba, 256, 16, { size: 32, mode: 'auto', region: undefined });
  assert.equal(result.mode, 'ascii');
  assert.ok(result.colorGrid === undefined);
  const firstRow = result.ascii.split('\n')[0];
  assert.equal(firstRow[0], RAMP[0], 'darkest cell should be the first ramp char');
  assert.equal(firstRow[firstRow.length - 1], RAMP[RAMP.length - 1], 'brightest cell should be the last ramp char');
});

test('analyzeImage: thin red line survives via accent color in color mode', () => {
  const rgba = makeThinLineRgba();
  const result = analyzeImage(rgba, 200, 100, { size: 16, mode: 'color', region: undefined });
  const rows = result.colorGrid.split('\n');
  // x=100/200 -> cell column 8 (cells 8 covers x 100..112)
  for (const row of rows) {
    assert.equal(row[8], 'R', `column 8 of every row should be red, got row "${row}"`);
  }
  // area stats still dominated by white (the average)
  const white = result.colors.find((c) => c.name === 'white');
  assert.ok(white.pct > 90, `white should dominate area, got ${white.pct}%`);
});

test('analyzeImage: explicit ascii mode never emits color grid', () => {
  const rgba = makeQuadrantRgba();
  const result = analyzeImage(rgba, 100, 100, { size: 16, mode: 'ascii', region: undefined });
  assert.equal(result.mode, 'ascii');
  assert.ok(result.colorGrid === undefined);
  assert.ok(result.colors.length > 0, 'color statistics are still reported');
});

test('normalizeRegion validates input', () => {
  assert.deepEqual(normalizeRegion(undefined), [0, 0, 1, 1]);
  assert.deepEqual(normalizeRegion([0.1, 0.2, 0.6, 0.9]), [0.1, 0.2, 0.6, 0.9]);
  assert.throws(() => normalizeRegion([0, 0, 1]), /region must be \[x0, y0, x1, y1\]/);
  assert.throws(() => normalizeRegion([-0.1, 0, 1, 1]), /numbers in 0\.\.1/);
  assert.throws(() => normalizeRegion([0.5, 0, 0.4, 1]), /x1 > x0/);
  assert.throws(() => normalizeRegion(['a', 0, 1, 1]), /numbers in 0\.\.1/);
});

test('classify maps pure colors to the nearest named entry', () => {
  assert.equal(classify(216, 27, 27).name, 'red');
  assert.equal(classify(46, 158, 68).name, 'green');
  assert.equal(classify(27, 95, 216).name, 'blue');
  assert.equal(classify(245, 245, 245).name, 'white');
  assert.equal(classify(16, 16, 16).name, 'black');
  assert.equal(classify(200, 122, 27).name, 'orange');
  assert.equal(classify(240, 208, 36).name, 'yellow');
});

test('classify: achromatic gate keeps grays in the gray family', () => {
  // mid-dark grays would otherwise land closer to brown / darkblue by pure distance
  assert.equal(classify(76, 76, 76).name, 'gray');
  assert.equal(classify(140, 140, 140).name, 'gray');
  assert.equal(classify(58, 58, 58).name, 'black'); // below the black stop
  assert.equal(classify(30, 30, 30).name, 'black');
  assert.equal(classify(230, 230, 230).name, 'white');
  // saturated colors are unaffected by the gate
  assert.equal(classify(200, 60, 60).name, 'red');
});

test('renderImageScan produces a model-readable payload', () => {
  const rgba = makeChartRgba();
  const analysis = analyzeImage(rgba, 600, 400, { size: 24, mode: 'auto', region: undefined });
  const value = { path: 'C:\\shots\\chart.png', width: 600, height: 400, region: 'full', ...analysis };
  const text = renderImageScan(value);
  assert.match(text, /chart\.png \(600x400 -> \d+x\d+ cells/);
  assert.match(text, /colors by area:/);
  assert.match(text, /luminance grid/);
  assert.ok(text.includes('@'), 'bright cells should appear for the white background');
  assert.ok(text.includes('.'), 'dark cells should appear for the red line');
});

test('analyzeImage: size bounds are enforced by the caller range', () => {
  assert.equal(SIZE_RANGE.min, 8);
  assert.equal(SIZE_RANGE.max, 64);
});

test('analyzeImage: palette=basic quantizes to the 8-color set', () => {
  const rgba = makeQuadrantRgba();
  const result = analyzeImage(rgba, 100, 100, { size: 16, mode: 'color', region: undefined, palette: 'basic' });
  assert.equal(result.palette, 'basic');
  const names = result.colors.map((c) => c.name);
  for (const color of ['red', 'green', 'blue', 'yellow']) assert.ok(names.includes(color));
  const codes = new Set(result.colorGrid.replace(/\s/g, '').split(''));
  for (const code of codes) assert.ok('KWGRNBYC'.includes(code), `unexpected basic code ${code}`);
});

test('analyzeImage: palette=gray renders achromatic grid but reports true colors', () => {
  const rgba = makeQuadrantRgba();
  const result = analyzeImage(rgba, 100, 100, { size: 16, mode: 'color', region: undefined, palette: 'gray' });
  assert.equal(result.palette, 'gray');
  // colors are pixel-level TRUE colors (never diluted by the render palette)
  const names = result.colors.map((c) => c.name);
  for (const color of ['red', 'green', 'blue', 'yellow']) assert.ok(names.includes(color), `missing ${color} in ${names.join(',')}`);
  // the color grid itself is achromatic
  const codes = new Set(result.colorGrid.replace(/\s/g, '').split(''));
  for (const code of codes) assert.ok('KWG'.includes(code), `unexpected gray code ${code}`);
});

test('analyzeImage: palette=auto picks full for colorful, gray for monochrome', () => {
  const quadrant = makeQuadrantRgba();
  assert.equal(analyzeImage(quadrant, 100, 100, { size: 16, mode: 'auto', region: undefined, palette: 'auto' }).palette, 'full');
  const gradient = makeGradientRgba();
  const gradientResult = analyzeImage(gradient, 256, 16, { size: 32, mode: 'auto', region: undefined, palette: 'auto' });
  assert.equal(gradientResult.palette, 'gray');
  assert.equal(gradientResult.mode, 'ascii');
});

test('analyzeImage: invalid palette rejected', () => {
  assert.throws(
    () => analyzeImage(makeQuadrantRgba(), 100, 100, { size: 16, mode: 'auto', palette: 'neon' }),
    /palette must be one of/
  );
});

test('classify: palette key changes depth', () => {
  assert.equal(classify(216, 27, 27, 'full').name, 'red');
  assert.equal(classify(216, 27, 27, 'basic').name, 'red');
  assert.equal(classify(216, 27, 27, 'gray').name, 'gray'); // red luminance ~84 -> gray stop
  assert.equal(classify(242, 208, 36, 'gray').name, 'white'); // yellow is bright
  assert.equal(classify(200, 122, 27, 'basic').name, 'yellow'); // orange falls to nearest basic color
});

test('resolveFocus: converts grid coords to fraction region', () => {
  // top-left 2x2 block of a 32x18 grid
  const r = resolveFocus([0, 0, 1, 1], 32, 18);
  assert.ok(Math.abs(r[0] - 0) < 1e-12 && Math.abs(r[1] - 0) < 1e-12);
  assert.ok(Math.abs(r[2] - 2 / 32) < 1e-12);
  assert.ok(Math.abs(r[3] - 2 / 18) < 1e-12);
  // full image
  assert.deepEqual(resolveFocus([0, 0, 17, 31], 32, 18), [0, 0, 1, 1]);
  // mid region rows 5-9, cols 10-19 -> x 10/32..20/32, y 5/18..10/18
  const mid = resolveFocus([5, 10, 9, 19], 32, 18);
  assert.deepEqual(mid, [10 / 32, 5 / 18, 20 / 32, 10 / 18]);
});

test('resolveFocus: rejects invalid input', () => {
  assert.throws(() => resolveFocus([0, 0, 1], 32, 18), /focus must be \[row0, col0, row1, col1\]/);
  assert.throws(() => resolveFocus([0, 0, 1, 1.5], 32, 18), /non-negative integers/);
  assert.throws(() => resolveFocus([0, 0, 0, 1], 32, 18), /at least 2 rows/);
  assert.throws(() => resolveFocus([0, 0, 1, 0], 32, 18), /at least 2 rows/);
  assert.throws(() => resolveFocus([0, 0, 18, 31], 32, 18), /out of range/);
  assert.throws(() => resolveFocus([0, 0, 17, 32], 32, 18), /out of range/);
});

test('analyzeImage: focus-derived region crops correctly', () => {
  const rgba = makeQuadrantRgba();
  // focus on the top-left quadrant of the full 16x16 grid -> only red remains
  const region = resolveFocus([0, 0, 7, 7], 16, 16);
  const result = analyzeImage(rgba, 100, 100, { size: 16, mode: 'auto', region, palette: 'auto' });
  const names = result.colors.map((c) => c.name);
  assert.deepEqual(names, ['red'], `top-left focus should be only red, got ${names.join(',')}`);
});

test('analyzeImage: regions find the four quadrant blobs', () => {
  const rgba = makeQuadrantRgba();
  const result = analyzeImage(rgba, 100, 100, { size: 32, mode: 'auto', region: undefined, palette: 'auto' });
  assert.equal(result.regions.length, 4, `expected 4 blobs, got ${result.regions.length}`);
  const byColor = Object.fromEntries(result.regions.map((r) => [r.color, r]));
  for (const color of ['red', 'green', 'blue', 'yellow']) {
    assert.ok(byColor[color], `missing ${color} blob`);
    assert.ok(byColor[color].pct >= 20 && byColor[color].pct <= 30, `${color} pct ${byColor[color].pct}`);
    assert.ok(byColor[color].aspect >= 0.9 && byColor[color].aspect <= 1.1, `${color} aspect ${byColor[color].aspect}`);
  }
  // red blob sits in the top-left
  assert.deepEqual(byColor.red.rows, [0, 15]);
  assert.deepEqual(byColor.red.cols, [0, 15]);
});

test('analyzeImage: regions capture the chart line and bars', () => {
  const rgba = makeChartRgba();
  const result = analyzeImage(rgba, 600, 400, { size: 32, mode: 'auto', region: undefined, palette: 'auto' });
  const colors = result.regions.map((r) => r.color);
  assert.ok(colors.includes('white'), 'background blob');
  assert.ok(colors.includes('red'), 'diagonal line blob');
  assert.ok(colors.includes('blue'), 'bars blob');
  // the diagonal line is one 8-connected blob spanning many rows, sparse inside its box
  const red = result.regions.find((r) => r.color === 'red');
  assert.ok(red.h >= 12, `red line blob should be tall, got h=${red.h}`);
  assert.ok(red.cells / (red.w * red.h) < 0.3, `red blob should be a sparse line, fill=${red.cells / (red.w * red.h)}`);
  // bars blob is wide and flat
  const blue = result.regions.find((r) => r.color === 'blue');
  assert.ok(blue.aspect > 2, `bars blob should be wide, aspect=${blue.aspect}`);
});

test('analyzeImage: regions on a gradient are smooth and segmented by gray stop', () => {
  const rgba = makeGradientRgba();
  const result = analyzeImage(rgba, 256, 16, { size: 32, mode: 'auto', region: undefined, palette: 'auto' });
  const names = result.regions.map((r) => r.color).sort();
  assert.deepEqual(names, ['black', 'gray', 'white']);
  for (const region of result.regions) {
    assert.equal(region.density, 'smooth');
  }
});

test('buildBlobs: transparent holes never merge', () => {
  const rgba = makeTransparentRgba();
  const result = analyzeImage(rgba, 64, 64, { size: 16, mode: 'auto', region: undefined, palette: 'auto' });
  assert.equal(result.regions.length, 0);
});

test('shadeFor: buckets hue + brightness, grays by luminance', () => {
  assert.equal(shadeFor(216, 27, 27), 'red-dark');
  assert.equal(shadeFor(46, 158, 68), 'green-mid');
  assert.equal(shadeFor(140, 220, 100), 'green-light');
  assert.equal(shadeFor(27, 95, 216), 'blue-mid');
  assert.equal(shadeFor(245, 245, 245), 'white');
  assert.equal(shadeFor(16, 16, 16), 'black');
  assert.equal(shadeFor(128, 128, 128), 'gray');
});

test('analyzeImage: pxPerCell sets explicit pixel density per cell', () => {
  const rgba = makeQuadrantRgba();
  // region [0,0,0.5,1] is 50x100 px; pxPerCell=5 -> 10x20 cells
  const result = analyzeImage(rgba, 100, 100, { mode: 'auto', region: [0, 0, 0.5, 1], palette: 'auto', pxPerCell: 5 });
  assert.equal(result.gridWidth, 10);
  assert.equal(result.gridHeight, 20);
  assert.equal(result.regionWidth, 50);
  assert.equal(result.regionHeight, 100);
  // actual density is exactly 5 px/cell
  assert.equal(result.regionWidth / result.gridWidth, 5);
  const names = result.colors.map((c) => c.name);
  assert.deepEqual(names, ['red', 'blue'], 'left half should be red+blue');
});

test('analyzeImage: pxPerCell clamps to 64 cells and reports actual density', () => {
  const rgba = makeQuadrantRgba();
  // region 100x100 px, pxPerCell=1 -> wants 100 cells -> clamped to 64
  const result = analyzeImage(rgba, 100, 100, { mode: 'auto', region: [0, 0, 1, 1], palette: 'auto', pxPerCell: 1 });
  assert.equal(result.gridWidth, 64);
  assert.equal(result.gridHeight, 64);
  assert.equal(result.regionWidth / result.gridWidth, 100 / 64, 'actual density is coarser than requested');
});

test('renderImageScan: px per cell uses the region size, not the full image', () => {
  const rgba = makeQuadrantRgba();
  const full = analyzeImage(rgba, 100, 100, { size: 32, mode: 'auto', region: undefined, palette: 'auto' });
  const textFull = renderImageScan({ path: 'x.png', width: 100, height: 100, region: 'full', ...full });
  assert.match(textFull, /~3\.1x3\.1px per cell/);
  const zoomed = analyzeImage(rgba, 100, 100, { mode: 'auto', region: [0, 0, 0.5, 0.5], palette: 'auto', pxPerCell: 2 });
  const textZoom = renderImageScan({ path: 'x.png', width: 100, height: 100, region: '0,0,0.5,0.5', ...zoomed });
  // region is 50x50 px over a 25x25 grid -> 2px per cell
  assert.match(textZoom, /~2x2px per cell/);
});

test('shade diversity + texture: flat cartoon vs photo-like', () => {
  const flat = analyzeImage(makeFlatTreeRgba(), 600, 500, { size: 24, mode: 'auto', region: undefined, palette: 'auto' });
  const photo = analyzeImage(makePhotoishRgba(), 600, 500, { size: 24, mode: 'auto', region: undefined, palette: 'auto' });
  // flat artwork is dominated by smooth cells with almost no rough texture
  assert.ok(flat.texture.smooth >= 85, `flat should be mostly smooth, got ${flat.texture.smooth}%`);
  assert.ok(flat.texture.rough <= 15, `flat should have little rough texture, got ${flat.texture.rough}%`);
  // photo-like content has substantial rough texture
  assert.ok(photo.texture.rough >= 20, `photo-like should have rough texture, got ${photo.texture.rough}%`);
  assert.ok(photo.texture.rough >= flat.texture.rough * 1.5, 'photo should be clearly rougher than flat');
  // the flat crown is one dominant solid color; the photo crown mixes many
  const flatCrown = flat.regions.find((r) => r.color === 'green');
  const photoCrown = photo.regions.find((r) => r.color === 'green');
  assert.ok(flatCrown.shades[0].pct >= 70, `flat crown should be a dominant solid color, top shade ${flatCrown.shades[0].pct}%`);
  assert.ok(photoCrown.shades.length >= 3, `photo crown should mix shades, got ${photoCrown.shades.length}`);
  assert.ok(photoCrown.shades[0].pct < flatCrown.shades[0].pct, 'photo crown colors should be more spread than flat');
});

test('structuralHints: detects parallel stripes and symmetry', () => {
  // synthetic grid: 12 columns fully alternating red/blue
  const cells = [];
  for (let r = 0; r < 12; r += 1) {
    for (let c = 0; c < 12; c += 1) {
      cells.push({ avgR: c % 2 === 0 ? 216 : 27, avgG: 27, avgB: c % 2 === 0 ? 27 : 95, accentSat: 0, accentR: 0, accentG: 0, accentB: 0, detail: 0.5, shade: 'x' });
    }
  }
  const hints = structuralHints(cells, 12, 12, 'full');
  const stripe = hints.find((h) => h.includes('vertical stripes'));
  assert.ok(stripe, `expected vertical stripes, got ${hints.join(' | ')}`);
  assert.match(stripe, /12 vertical stripes \(2 alternating colors\)/);
});

test('structuralHints: no false stripes on a flat image', () => {
  const flat = analyzeImage(makeFlatTreeRgba(), 600, 500, { size: 24, mode: 'auto', region: undefined, palette: 'auto' });
  const stripes = flat.structure.filter((h) => h.includes('stripes'));
  assert.equal(stripes.length, 0, `flat tree should not report stripes, got ${flat.structure.join(' | ')}`);
});

test('structuralHints: render includes structure line', () => {
  // the centered tree is left-right symmetric -> structure hint appears
  const result = analyzeImage(makeFlatTreeRgba(), 600, 500, { size: 24, mode: 'auto', region: undefined, palette: 'auto' });
  const text = renderImageScan({ path: 'x.png', width: 600, height: 500, region: 'full', ...result });
  assert.match(text, /structure: .*symmetry/);
});
