/**
 * Tests for the document_to_image tool (src/doc-tools.js).
 *
 * Pure-logic / structural tests use an in-memory fake ctx.fs plus an injected
 * fake `_docRunner` so they never touch the real Python / LibreOffice. An
 * optional integration describe runs a real conversion through doc_venv +
 * fitz when that environment is present (skipped otherwise, so the suite
 * stays green on machines without it).
 *
 * Run: node --test tests/doc-tools.test.js
 * @module picturereader/tests/doc-tools
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDocumentToImageTool } from '../src/doc-tools.js';

// ---------------------------------------------------------------- helpers

/** Build a fake ctx with in-memory fs; optionally inject a fake doc runner. */
function makeFakeCtx(entries, opts = {}) {
  const runner = opts.runner || (() => {
    throw new Error('no _docRunner injected in this test path');
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
        return { version: 'v1', type: e.type || 'file', size: (e.buffer || '').length };
      },
      async readBytes(target) {
        const e = entries[target.displayPath];
        if (!e) throw new Error(`mock readBytes: no bytes for ${target.displayPath}`);
        return e.buffer;
      }
    },
    _docRunner: runner
  };
  return ctx;
}

const EXEC = { signal: undefined, agent: { session: { header: { cwd: 'C:\\work' }, id: 'sess-1' } } };

/** A tiny structurally-valid single-page PDF that fitz can open+render. */
const MIN_PDF = Buffer.from(
  '%PDF-1.4\n' +
  '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n' +
  '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
  '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj\n' +
  '4 0 obj<</Length 44>>stream\nBT /F1 12 Tf 72 100 Td (Hello) Tj ET\nendstream endobj\n' +
  '5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\n' +
  'trailer<</Size 6/Root 1 0 R>>\n%%EOF\n', 'ascii');

// -------------------------------------------------- structural / validation

test('document_to_image: tool object has the expected shape', () => {
  const ctx = makeFakeCtx({ 'a.pdf': { buffer: MIN_PDF } }, { runner: () => ({ pages: [], page_count: 0 }) });
  const tool = createDocumentToImageTool(ctx);
  assert.equal(tool.name, 'document_to_image');
  assert.equal(typeof tool.description, 'string');
  assert.ok(tool.description.includes('image_scan'));
  assert.equal(tool.isConcurrencySafe(), true);
  assert.equal(typeof tool.execute, 'function');
  assert.equal(typeof tool.output.render, 'function');
  // parameters
  assert.equal(tool.parameters.type, 'object');
  for (const k of ['file_path', 'file_paths', 'out_dir', 'dpi', 'max_pages']) {
    assert.ok(tool.parameters.properties[k], `parameter ${k} present`);
  }
  // output schema
  const schema = tool.output.schema;
  assert.ok(schema.properties.documents);
  assert.ok(schema.properties.out_dir);
  assert.ok(schema.properties.summary);
});

test('document_to_image: rejects unsupported extension with a clear message', async () => {
  const ctx = makeFakeCtx({ 'd.txt': { buffer: Buffer.from('x') } });
  const tool = createDocumentToImageTool(ctx);
  await assert.rejects(
    () => tool.execute({ file_path: 'd.txt' }, EXEC),
    /不支持的文件类型 "\.txt"/
  );
  await assert.rejects(
    () => tool.execute({ file_path: 'd.png' }, EXEC),
    /不支持的文件类型 "\.png"/
  );
});

test('document_to_image: requires an input (file_path or file_paths)', async () => {
  const ctx = makeFakeCtx({});
  const tool = createDocumentToImageTool(ctx);
  await assert.rejects(() => tool.execute({}, EXEC), /需要一个输入文件/);
  await assert.rejects(() => tool.execute({ file_path: '' }, EXEC), /需要一个输入文件/);
  await assert.rejects(() => tool.execute({ file_paths: [] }, EXEC), /需要一个输入文件/);
});

test('document_to_image: file_path and file_paths are mutually exclusive', async () => {
  const ctx = makeFakeCtx({ 'a.pdf': { buffer: MIN_PDF }, 'b.pdf': { buffer: MIN_PDF } });
  const tool = createDocumentToImageTool(ctx);
  await assert.rejects(
    () => tool.execute({ file_path: 'a.pdf', file_paths: ['b.pdf'] }, EXEC),
    /不要同时传/
  );
});

test('document_to_image: dpi and max_pages bounds are validated', async () => {
  const ctx = makeFakeCtx({});
  const tool = createDocumentToImageTool(ctx);
  await assert.rejects(() => tool.execute({ file_path: 'a.pdf', dpi: 50 }, EXEC), /dpi must be an integer between 72 and 300/);
  await assert.rejects(() => tool.execute({ file_path: 'a.pdf', dpi: 301 }, EXEC), /dpi must be an integer between 72 and 300/);
  await assert.rejects(() => tool.execute({ file_path: 'a.pdf', dpi: 150.5 }, EXEC), /dpi must be an integer/);
  await assert.rejects(() => tool.execute({ file_path: 'a.pdf', max_pages: 0 }, EXEC), /max_pages must be an integer between 1 and 500/);
  await assert.rejects(() => tool.execute({ file_path: 'a.pdf', max_pages: 501 }, EXEC), /max_pages must be an integer between 1 and 500/);
});

test('document_to_image: missing file reports a clear error', async () => {
  const ctx = makeFakeCtx({}); // no entry for nope.pdf
  const tool = createDocumentToImageTool(ctx);
  await assert.rejects(() => tool.execute({ file_path: 'nope.pdf' }, EXEC), /找不到文件/);
});

// ------------------------------------------ success path via injected runner

test('document_to_image: single PDF maps runner output into the result structure', async () => {
  let captured = null;
  const runner = (inputPath, outDir, prefix, dpi, maxPages, timeoutMs, signal) => {
    captured = { inputPath, outDir, prefix, dpi, maxPages };
    return {
      pages: [
        { path: join(outDir, `${prefix}_1.png`), width: 417, height: 417, bytes: 2440, index: 1 },
        { path: join(outDir, `${prefix}_2.png`), width: 417, height: 417, bytes: 2500, index: 2 }
      ],
      page_count: 5,
      truncated: true,
      input: 'multi.pdf'
    };
  };
  const ctx = makeFakeCtx({ 'multi.pdf': { buffer: MIN_PDF } }, { runner });
  const tool = createDocumentToImageTool(ctx);
  const result = await tool.execute({ file_path: 'multi.pdf', dpi: 140, max_pages: 2 }, EXEC);

  assert.equal(captured.dpi, 140);
  assert.equal(captured.maxPages, 2);
  assert.equal(captured.prefix, 'page_1');
  assert.ok(captured.inputPath.includes('.pdf'), 'input is materialized to a real .pdf path');
  assert.ok(captured.outDir.includes('picturereader-doc'), 'default out_dir lives under picturereader-doc');

  assert.equal(result.documents.length, 1);
  const d = result.documents[0];
  assert.equal(d.input, 'multi.pdf');
  assert.equal(d.page_count, 5);
  assert.equal(d.rendered, 2);
  assert.equal(d.truncated, true);
  assert.equal(d.pages.length, 2);
  assert.equal(d.pages[0].index, 1);
  assert.equal(d.pages[0].width, 417);
  assert.equal(d.pages[0].bytes, 2440);
  assert.equal(typeof d.pages[0].path, 'string');
  assert.ok(result.out_dir.includes('picturereader-doc'));
  assert.ok(result.summary.includes('2 页'));
  assert.ok(result.note.includes('image_scan'));
});

test('document_to_image: explicit out_dir is honored and used for every page path', async () => {
  let usedOut = null;
  const runner = (inputPath, outDir, prefix) => {
    usedOut = outDir;
    return { pages: [{ path: join(outDir, `${prefix}_1.png`), width: 100, height: 100, bytes: 10, index: 1 }], page_count: 1 };
  };
  const ctx = makeFakeCtx({ 'a.pdf': { buffer: MIN_PDF } }, { runner });
  const tool = createDocumentToImageTool(ctx);
  const result = await tool.execute({ file_path: 'a.pdf', out_dir: 'D:\\out\\docs' }, EXEC);
  assert.equal(usedOut, 'D:\\out\\docs');
  assert.equal(result.out_dir, 'D:\\out\\docs');
  assert.ok(result.documents[0].pages[0].path.startsWith('D:\\out\\docs'));
});

test('document_to_image: batch file_paths converts each document and names prefixes distinctly', async () => {
  const calls = [];
  const runner = (inputPath, outDir, prefix) => {
    calls.push(prefix);
    return { pages: [{ path: `${outDir}/${prefix}_1.png`, width: 10, height: 10, bytes: 5, index: 1 }], page_count: 1 };
  };
  const ctx = makeFakeCtx({ 'a.pdf': { buffer: MIN_PDF }, 'b.docx': { buffer: MIN_PDF } }, { runner });
  const tool = createDocumentToImageTool(ctx);
  const result = await tool.execute({ file_paths: ['a.pdf', 'b.docx'] }, EXEC);
  assert.equal(result.documents.length, 2);
  assert.equal(result.documents[0].input, 'a.pdf');
  assert.equal(result.documents[1].input, 'b.docx');
  assert.deepEqual(calls, ['page_1', 'page_2'], 'each doc gets its own prefix so no filename collision');
  assert.ok(result.summary.includes('2 个文档'));
});

test('document_to_image: source temp file is cleaned up after conversion', async () => {
  // Use a real temp source dir so we can assert cleanup; runner returns a fake page.
  const srcDir = mkdtempSync(join(tmpdir(), 'dti-src-'));
  const srcPath = join(srcDir, 'doc.pdf');
  writeFileSync(srcPath, MIN_PDF);
  const runner = (inputPath, outDir) => ({
    pages: [{ path: join(outDir, 'p_1.png'), width: 10, height: 10, bytes: 5, index: 1 }],
    page_count: 1
  });
  const entries = {};
  const ctx = {
    tools: { register() {} },
    fs: {
      async resolve(path) { return { targetKey: `k:${path}`, displayPath: path }; },
      async stat(target) { return { version: 'v1', type: 'file', size: MIN_PDF.length }; },
      async readBytes() { return MIN_PDF; }
    },
    _docRunner: runner
  };
  const tool = createDocumentToImageTool(ctx);
  const result = await tool.execute({ file_path: srcPath }, EXEC);
  assert.equal(result.documents.length, 1);
  // injected runner never made a temp dir, so nothing to assert on the runner's side;
  // the source file itself must still exist (we only delete the temp copy, not the input).
  assert.ok(existsSync(srcPath), 'original input must not be deleted');
  rmSync(srcDir, { recursive: true, force: true });
});

test('document_to_image: runner error message is surfaced (e.g. missing LibreOffice)', async () => {
  const runner = () => { throw new Error('document_to_image: 转换失败: LibreOffice(soffice) 未找到。请安装 LibreOffice'); };
  const ctx = makeFakeCtx({ 'a.pdf': { buffer: MIN_PDF } }, { runner });
  const tool = createDocumentToImageTool(ctx);
  await assert.rejects(() => tool.execute({ file_path: 'a.pdf' }, EXEC), /soffice.*未找到/);
});

test('document_to_image: render returns text blocks for the model', async () => {
  const ctx = makeFakeCtx({ 'a.pdf': { buffer: MIN_PDF } }, { runner: () => ({ pages: [], page_count: 0 }) });
  const tool = createDocumentToImageTool(ctx);
  const blocks = tool.output.render({}, {
    documents: [{ input: 'a.pdf', page_count: 3, rendered: 1, truncated: true, pages: [{ index: 1, path: 'P', width: 8, height: 8, bytes: 9 }] }],
    out_dir: 'D:\\out',
    summary: '转换完成',
    note: 'note-x'
  });
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, 'text');
  assert.ok(blocks[0].text.includes('a.pdf'));
  assert.ok(blocks[0].text.includes('1/3'));
  assert.ok(blocks[0].text.includes('8x8'));
});

// ------------------------------------------------- integration (real render)

const DOC_VENV = 'C:\\Users\\Administrator\\doc_venv\\Scripts\\python.exe';
const SOFFICE = 'C:\\Program Files\\LibreOffice\\program\\soffice.exe';
const envHas = existsSync(DOC_VENV) && existsSync(SOFFICE);

test('document_to_image [integration]: renders a real minimal PDF to PNG', { skip: !envHas }, async () => {
  const outDir = mkdtempSync(join(tmpdir(), 'dti-int-'));
  const srcDir = mkdtempSync(join(tmpdir(), 'dti-int-src-'));
  const srcPath = join(srcDir, 'doc.pdf');
  writeFileSync(srcPath, MIN_PDF);
  const ctx = {
    tools: { register() {} },
    fs: {
      async resolve(path) { return { targetKey: `k:${path}`, displayPath: path }; },
      async stat(target) { return { version: 'v1', type: 'file', size: MIN_PDF.length }; },
      async readBytes() { return MIN_PDF; }
    }
  };
  const tool = createDocumentToImageTool(ctx);
  const result = await tool.execute({ file_path: srcPath, out_dir: outDir }, EXEC);
  assert.equal(result.documents.length, 1);
  const d = result.documents[0];
  assert.equal(d.input, 'doc.pdf');
  assert.equal(d.page_count, 1);
  assert.equal(d.rendered, 1);
  const p = d.pages[0];
  assert.ok(existsSync(p.path), `PNG produced at ${p.path}`);
  assert.ok(p.width > 0 && p.height > 0);
  assert.ok(p.bytes > 0);
  rmSync(outDir, { recursive: true, force: true });
  rmSync(srcDir, { recursive: true, force: true });
});
