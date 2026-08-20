/**
 * New tool execute functions for the MCP server.
 * @module picturereader/mcp/new-tools
 */

import { extname } from 'node:path';

export async function executeCrop(args, ctx) {
  const { core, absolutePath, data, ext } = ctx;
  const image = core.decodeImage(data, ext);
  if (args.region === undefined) throw new Error('image_crop: region is required');
  const region = core.normalizeRegion(args.region);
  const cropped = core.cropRgba(image.data, image.width, image.height, region);
  const pngBytes = core.encodePng(cropped.data, cropped.width, cropped.height);
  const { writeFile, mkdir } = await import('node:fs/promises');
  const { join, dirname } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const { randomBytes } = await import('node:crypto');
  let outPath = args.out_path ? args.out_path : null;
  let generated = false;
  let tempDir;
  if (outPath) { await mkdir(dirname(outPath), { recursive: true }); }
  else { tempDir = join(tmpdir(), 'picturereader'); outPath = join(tempDir, `crop-${Date.now()}-${randomBytes(4).toString('hex')}.png`); generated = true; await mkdir(tempDir, { recursive: true }); }
  await writeFile(outPath, pngBytes);
  return { path: absolutePath, width: cropped.width, height: cropped.height, generated, outPath, ...(tempDir ? { tempDir } : {}), note: '可用 image_scan / image_ocr 对裁剪结果做进一步分析' };
}

export async function executePalette(args, ctx) {
  const { core, absolutePath, data, ext } = ctx;
  const image = core.decodeImage(data, ext);
  const region = args.region === undefined ? [0, 0, 1, 1] : core.normalizeRegion(args.region);
  const top = args.top === undefined ? 12 : Number(args.top);
  const sampleStep = args.sample_step === undefined ? 1 : Number(args.sample_step);
  const SHIFT = 5;
  const topList = [], hueCounts = new Map(), buckets = new Map();
  const [rx0, ry0, rx1, ry1] = region;
  const px0 = Math.max(0, Math.floor(rx0 * image.width)), px1 = Math.min(image.width, Math.ceil(rx1 * image.width));
  const py0 = Math.max(0, Math.floor(ry0 * image.height)), py1 = Math.min(image.height, Math.ceil(ry1 * image.height));
  let total = 0;
  for (let y = py0; y < py1; y += sampleStep) {
    for (let x = px0; x < px1; x += sampleStep) {
      const p = (y * image.width + x) * 4;
      if (image.data[p + 3] < 128) continue;
      const r = image.data[p], g = image.data[p + 1], b = image.data[p + 2];
      const key = (r >> SHIFT) << 6 | (g >> SHIFT) << 3 | (b >> SHIFT);
      let bucket = buckets.get(key);
      if (!bucket) { bucket = { r: 0, g: 0, b: 0, count: 0 }; buckets.set(key, bucket); }
      bucket.r += r; bucket.g += g; bucket.b += b; bucket.count += 1;
      const fam = core.hueFamilyFor(r, g, b);
      hueCounts.set(fam, (hueCounts.get(fam) ?? 0) + 1);
      total += 1;
    }
  }
  if (total > 0) {
    for (const bucket of buckets.values()) {
      const ar = Math.round(bucket.r / bucket.count), ag = Math.round(bucket.g / bucket.count), ab = Math.round(bucket.b / bucket.count);
      topList.push({ hex: `#${ar.toString(16).padStart(2, '0')}${ag.toString(16).padStart(2, '0')}${ab.toString(16).padStart(2, '0')}`, name: core.classify(ar, ag, ab, 'full').name, pct: Math.round((bucket.count / total) * 1000) / 10, rgb: { r: ar, g: ag, b: ab }, count: bucket.count });
    }
    topList.sort((a, b) => b.count - a.count);
    for (const item of topList) delete item.count;
  }
  const hueFamilies = [...hueCounts.entries()].map(([f, c]) => ({ family: f, pct: Math.round((c / total) * 1000) / 10 })).sort((a, b) => b.pct - a.pct);
  return { path: absolutePath, width: image.width, height: image.height, region: region.map((v) => Math.round(v * 1000) / 1000).join(','), top: topList.slice(0, top), hue_families: hueFamilies, distinct: buckets.size };
}

export async function executeCompare(args, ctxA, ctxB) {
  const core = ctxA.core;
  const imgA = core.decodeImage(ctxA.data, ctxA.ext);
  const imgB = core.decodeImage(ctxB.data, ctxB.ext);
  const region = args.region === undefined ? [0, 0, 1, 1] : core.normalizeRegion(args.region);
  const ds = args.downsample === undefined ? 4 : Number(args.downsample);
  const thr = args.max_diff_threshold === undefined ? 0.05 : Number(args.max_diff_threshold);
  const [rx0, ry0, rx1, ry1] = region;
  const wA = Math.ceil((rx1 - rx0) * imgA.width), hA = Math.ceil((ry1 - ry0) * imgA.height);
  const wB = Math.ceil((rx1 - rx0) * imgB.width), hB = Math.ceil((ry1 - ry0) * imgB.height);
  const gw = Math.min(wA, wB), gh = Math.min(hA, hB);
  if (gw <= 0 || gh <= 0) throw new Error('image_compare: zero area');
  let samples = 0, diffPx = 0, meanSum = 0, maxD = 0;
  for (let gy = 0; gy < gh; gy += ds) {
    for (let gx = 0; gx < gw; gx += ds) {
      const ux = gw === 1 ? 0.5 : (gx + 0.5) / gw, uy = gh === 1 ? 0.5 : (gy + 0.5) / gh;
      const pa = (Math.floor(ry0 * imgA.height + uy * hA) * imgA.width + Math.floor(rx0 * imgA.width + ux * wA)) * 4;
      const pb = (Math.floor(ry0 * imgB.height + uy * hB) * imgB.width + Math.floor(rx0 * imgB.width + ux * wB)) * 4;
      const diff = (Math.abs(ctxA.data[pa] - ctxB.data[pb]) + Math.abs(ctxA.data[pa + 1] - ctxB.data[pb + 1]) + Math.abs(ctxA.data[pa + 2] - ctxB.data[pb + 2])) / 3 / 255;
      meanSum += diff; samples++; if (diff > maxD) maxD = diff; if (diff > 0.1) diffPx++;
    }
  }
  const mDiff = samples ? meanSum / samples : 0, dRatio = samples ? diffPx / samples : 0;
  const same = imgA.width === imgB.width && imgA.height === imgB.height;
  const sDiff = same ? null : { w: Math.abs(imgA.width - imgB.width), h: Math.abs(imgA.height - imgB.height) };
  const verdict = sDiff ? 'size-diff' : (dRatio > thr || mDiff > thr) ? 'different' : 'same';
  const r3 = (v) => Math.round(v * 1000) / 1000;
  return { path_a: ctxA.absolutePath, path_b: ctxB.absolutePath, width_a: imgA.width, height_a: imgA.height, width_b: imgB.width, height_b: imgB.height, ...(sDiff ? { size_diff: sDiff } : {}), mean_diff: r3(mDiff), diff_ratio: r3(dRatio), max_diff: r3(maxD), region_a: region.map(r3).join(','), region_b: region.map(r3).join(','), verdict };
}

export async function executeBatch(args, helpers) {
  const { importCore, readImageFile, decodeBounded, resolveImagePath } = helpers;
  const rawPaths = args.file_paths;
  if (!Array.isArray(rawPaths) || !rawPaths.length) throw new Error('image_batch: file_paths must be non-empty');
  const core = await importCore();
  const paths = rawPaths.map((p) => String(p).trim()).filter(Boolean);
  const items = []; let processed = 0, errors = 0;
  for (let i = 0; i < paths.length; i++) {
    const fp = paths[i]; const entry = { index: i, path: fp, basename: fp.split(/[\\/]/).pop() || fp, type: 'unknown', has_text: false, recommendation: 'quick image_scan to confirm' };
    try {
      const abs = resolveImagePath(fp); const ext2 = extname(abs).toLowerCase();
      const data = await readImageFile(abs, 'image_batch'); const image = decodeBounded(core, data, ext2, 'image_batch');
      const analysis = core.analyzeImage(image.data, image.width, image.height, { size: 16, mode: 'auto', palette: 'auto' });
      entry.width = image.width; entry.height = image.height; entry.path = abs;
      entry.scan_preview = core.renderImageScan({ path: abs, width: image.width, height: image.height, region: 'full', ...analysis }).slice(0, 900);
      processed++; items.push(entry);
    } catch (e) { entry.error = e.message; errors++; items.push(entry); }
  }
  return { summary: `image_batch: ${processed} decoded / ${errors} error(s) out of ${paths.length}`, items, processed, errors };
}
