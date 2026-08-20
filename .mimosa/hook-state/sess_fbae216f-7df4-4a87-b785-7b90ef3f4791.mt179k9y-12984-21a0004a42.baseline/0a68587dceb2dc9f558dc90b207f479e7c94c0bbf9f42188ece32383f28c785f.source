/**
 * picturereader MCP server — exposes the image-reading tools to ZCode as a
 * Model Context Protocol stdio server.
 *
 * Three tools, identical in behavior to the original DSH plugin:
 * - `image_scan`    coarse pixel grid + hue/color/structure analysis
 * - `image_ocr`     text recognition (Windows OCR default, PaddleOCR optional)
 * - `image_sample`  exact-pixel texture sampling for material judgment
 *
 * The entire business logic lives in `src/core.js`, loaded dynamically with a
 * cache-busting query keyed on the file's mtime (see `importCore`), so editing
 * `core.js` takes effect on the NEXT tool call without restarting the server.
 *
 * The transport is minimal newline-delimited JSON-RPC 2.0 over stdio, as
 * specified by MCP: every line on stdin is one JSON-RPC message; responses are
 * written as single JSON lines on stdout. Diagnostics go to stderr only, so
 * they never corrupt the protocol stream. No MCP SDK dependency is needed.
 * @module picturereader/mcp/server
 */

import { extname, isAbsolute, resolve as resolvePath } from 'node:path';
import { stat, readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';

/** The MCP protocol version this server speaks. */
export const PROTOCOL_VERSION = '2025-06-18';

/** Hard cap on file bytes we are willing to read for a scan. */
export const BYTE_CAP = 50 * 1024 * 1024;
/** Hard cap on decoded pixel count (pure-JS decoders are slow on huge images). */
export const MAX_PIXELS = 24_000_000;

const CORE_URL = new URL('../src/core.js', import.meta.url).href;

let coreCache = { url: null, mtime: -1, module: null };

/**
 * Load the latest `core.js`, refreshing the module whenever the file changes.
 * Exported for tests; the optional `target` overrides the module URL.
 * @param target - module URL to load (defaults to this package's core.js).
 * @returns the core module namespace.
 */
export async function importCore(target = CORE_URL) {
  const url = new URL(target);
  const info = await stat(url);
  if (coreCache.module !== null && coreCache.url === target && info.mtimeMs === coreCache.mtime) {
    return coreCache.module;
  }
  const module = await import(`${url.href}?t=${info.mtimeMs}`);
  coreCache = { url: target, mtime: info.mtimeMs, module };
  return module;
}

/**
 * Resolve a model-supplied path to an absolute path. Absolute paths are used
 * as-is; relative paths resolve against the workspace root (the
 * `PICTUREREADER_CWD` env var, set by the plugin config, or the server's
 * process cwd when launched manually).
 * @param filePath - the raw path argument.
 * @returns the absolute path.
 */
export function resolveImagePath(filePath) {
  const base = process.env.PICTUREREADER_CWD || process.cwd();
  return isAbsolute(filePath) ? filePath : resolvePath(base, filePath);
}

/**
 * Read and validate an image file from disk.
 * @param filePath - absolute path.
 * @param toolName - used in error messages ('image_scan' etc.).
 * @returns the file bytes.
 */
export async function readImageFile(filePath, toolName = 'image_scan') {
  let info;
  try {
    info = await stat(filePath);
  } catch {
    throw new Error(`${toolName}: cannot read "${filePath}": file not found`);
  }
  if (!info.isFile()) {
    throw new Error(`${toolName}: cannot read "${filePath}": not a regular file`);
  }
  const data = await readFile(filePath);
  if (data.byteLength > BYTE_CAP) {
    throw new Error(`${toolName}: file exceeds the ${BYTE_CAP}-byte read limit`);
  }
  return data;
}

/** Coerce the size argument into a bounded integer. */
function parseSize(raw) {
  const size = Number(raw ?? 32);
  if (!Number.isInteger(size) || size < 8 || size > 64) {
    throw new Error('image_scan: size must be an integer between 8 and 64');
  }
  return size;
}

function parseMode(raw) {
  const mode = String(raw ?? 'auto');
  if (mode !== 'auto' && mode !== 'ascii' && mode !== 'color') {
    throw new Error("image_scan: mode must be one of 'auto', 'ascii', 'color'");
  }
  return mode;
}

/**
 * Validate a file_path argument and load the latest core module.
 * @param args - tool arguments.
 * @param toolName - used in error messages.
 * @returns `{ core, filePath, ext }`.
 */
async function loadImageArgs(args, toolName) {
  const filePath = String(args.file_path ?? '').trim();
  if (filePath.length === 0) throw new Error(`${toolName}: file_path must be a non-empty string`);
  const core = await importCore();
  const ext = extname(filePath).toLowerCase();
  if (core.UNSUPPORTED_EXTENSIONS.has(ext)) {
    throw new Error(`${toolName}: WebP is not supported yet — convert the file to PNG or JPEG first`);
  }
  if (!core.IMAGE_EXTENSIONS.has(ext)) {
    throw new Error(`${toolName}: unsupported image type "${ext}" (supported: PNG, JPEG, GIF, BMP)`);
  }
  return { core, filePath, ext };
}

/**
 * Decode the file and enforce the pixel-count limit.
 * @param core - the core module.
 * @param data - file bytes.
 * @param ext - lowercase extension including the dot.
 * @param toolName - used in error messages.
 * @returns `{ image, width, height }`.
 */
function decodeBounded(core, data, ext, toolName) {
  const image = core.decodeImage(data, ext);
  if (image.width * image.height > MAX_PIXELS) {
    throw new Error(
      `${toolName}: ${image.width}x${image.height} exceeds the ${MAX_PIXELS}-pixel decode limit — downscale or crop the file first`
    );
  }
  return image;
}

// ---------------------------------------------------------------------------
// tool implementations
// ---------------------------------------------------------------------------

/**
 * `image_scan`: read a local image as a coarse pixel grid (downscaled +
 * color-quantized) so a text-only model can "see" layout, colors and shapes.
 * @param args - tool arguments.
 * @returns the analysis result (rendered by {@link renderScanResult}).
 */
export async function executeScan(args) {
  const { core, filePath, ext } = await loadImageArgs(args, 'image_scan');
  if (args.region !== undefined && args.focus !== undefined) {
    throw new Error('image_scan: region and focus are mutually exclusive — pass only one');
  }
  const mode = parseMode(args.mode);
  const palette = core.resolvePaletteArgument(args.palette);
  let pxPerCell;
  if (args.px_per_cell !== undefined) {
    pxPerCell = Number(args.px_per_cell);
    if (!Number.isInteger(pxPerCell) || pxPerCell < 1 || pxPerCell > 512) {
      throw new Error('image_scan: px_per_cell must be an integer between 1 and 512');
    }
    if (args.size !== undefined) {
      throw new Error('image_scan: size and px_per_cell are mutually exclusive — pass only one');
    }
  }
  const size = pxPerCell !== undefined ? 32 : parseSize(args.size);

  const absolutePath = resolveImagePath(filePath);
  const data = await readImageFile(absolutePath, 'image_scan');
  const image = decodeBounded(core, data, ext, 'image_scan');

  // focus uses grid coordinates against the full-image grid this size
  // produces; region and focus are resolved after decode.
  let regionArray;
  let regionDisplay;
  if (args.focus !== undefined) {
    const fullGridHeight = Math.max(1, Math.round(size * (image.height / image.width)));
    regionArray = core.resolveFocus(args.focus, size, fullGridHeight);
    regionDisplay = `focus [${args.focus.map(String).join(',')}]`;
  } else if (args.region !== undefined) {
    regionArray = core.normalizeRegion(args.region);
    regionDisplay = regionArray.map((v) => Math.round(v * 1000) / 1000).join(',');
  } else {
    regionDisplay = 'full';
  }

  const analysis = core.analyzeImage(image.data, image.width, image.height, { size, mode, region: regionArray, palette, pxPerCell });
  return {
    path: absolutePath,
    width: image.width,
    height: image.height,
    region: regionDisplay,
    ...analysis
  };
}

/**
 * `image_ocr`: recognize text in a local image (optionally within a
 * region/focus). Windows OCR by default; PaddleOCR optional, with graceful
 * fallback so it never crashes.
 * @param args - tool arguments.
 * @returns the OCR result (rendered by {@link renderOcrResult}).
 */
export async function executeOcr(args) {
  const { core, filePath, ext } = await loadImageArgs(args, 'image_ocr');
  if (args.region !== undefined && args.focus !== undefined) {
    throw new Error('image_ocr: region and focus are mutually exclusive — pass only one');
  }
  if (args.language !== undefined && String(args.language).trim().length === 0) {
    throw new Error('image_ocr: language must be a non-empty BCP-47 tag');
  }
  const engine = args.engine === undefined ? 'windows' : String(args.engine);
  if (engine !== 'windows' && engine !== 'paddle') {
    throw new Error("image_ocr: engine must be 'windows' (default) or 'paddle'");
  }

  const absolutePath = resolveImagePath(filePath);
  const data = await readImageFile(absolutePath, 'image_ocr');
  const image = decodeBounded(core, data, ext, 'image_ocr');

  let regionArray;
  let regionDisplay;
  if (args.focus !== undefined) {
    const fullGridHeight = Math.max(1, Math.round(32 * (image.height / image.width)));
    regionArray = core.resolveFocus(args.focus, 32, fullGridHeight);
    regionDisplay = `focus [${args.focus.map(String).join(',')}]`;
  } else if (args.region !== undefined) {
    regionArray = core.normalizeRegion(args.region);
    regionDisplay = regionArray.map((v) => Math.round(v * 1000) / 1000).join(',');
  } else {
    regionDisplay = 'full';
  }

  // PaddleOCR is an optional engine: degrade gracefully to the Windows
  // engine (with a note) when it is missing or fails — never crash.
  let effectiveEngine = engine;
  let note;
  if (engine === 'paddle' && !(await core.paddleAvailable())) {
    effectiveEngine = 'windows';
    note = 'PaddleOCR is not installed (engine="paddle" requested) — fell back to Windows OCR. To install it, run: node scripts/setup-ocr.mjs (see README).';
  }
  let result;
  try {
    result = await core.ocrImage(data, ext, {
      region: regionArray,
      language: args.language === undefined ? undefined : String(args.language).trim(),
      engine: effectiveEngine
    });
  } catch (error) {
    if (engine === 'paddle' && effectiveEngine === 'paddle') {
      effectiveEngine = 'windows';
      note = `PaddleOCR failed (${error.message.slice(0, 140)}) — fell back to Windows OCR.`;
      result = await core.ocrImage(data, ext, {
        region: regionArray,
        language: args.language === undefined ? undefined : String(args.language).trim(),
        engine: 'windows'
      });
    } else {
      throw error;
    }
  }
  if (result.downscaled === true) {
    const capNote = `image downscaled to ${result.width}x${result.height} for PaddleOCR (long side capped at ${core.PADDLE_MAX_LONG_SIDE}px to keep calls fast); use region/focus for fine text`;
    note = note === undefined ? capNote : `${note} ${capNote}`;
  }
  return {
    path: absolutePath,
    width: result.width,
    height: result.height,
    region: regionDisplay,
    engine: effectiveEngine,
    ...(note !== undefined ? { note } : {}),
    lines: result.lines
  };
}

/**
 * `image_sample`: sample a small region as an NxN grid of EXACT pixels plus a
 * local-contrast statistic, for material/texture judgment.
 * @param args - tool arguments.
 * @returns the sample result (rendered by {@link renderSampleResult}).
 */
export async function executeSample(args) {
  const { core, filePath, ext } = await loadImageArgs(args, 'image_sample');
  if (args.region === undefined) throw new Error('image_sample: region is required ([x0, y0, x1, y1] fractions)');
  const size = args.size === undefined ? 8 : Number(args.size);
  if (!Number.isInteger(size) || size < 2 || size > 16) {
    throw new Error('image_sample: size must be an integer between 2 and 16');
  }
  const regionArray = core.normalizeRegion(args.region);

  const absolutePath = resolveImagePath(filePath);
  const data = await readImageFile(absolutePath, 'image_sample');
  const image = decodeBounded(core, data, ext, 'image_sample');

  const sample = core.samplePixels(image.data, image.width, image.height, regionArray, size);
  return {
    path: absolutePath,
    width: sample.width,
    height: sample.height,
    region: regionArray.map((v) => Math.round(v * 1000) / 1000).join(','),
    contrast: sample.contrast,
    distinct: sample.distinct,
    stepX: sample.stepX,
    stepY: sample.stepY,
    points: sample.points
  };
}

/**
 * Dispatch a tool call to its implementation.
 * @param name - tool name ('image_scan' | 'image_ocr' | 'image_sample').
 * @param args - tool arguments object.
 * @returns the structured tool result.
 */
export async function executeTool(name, args) {
  const cleanArgs = args === undefined || args === null ? {} : args;
  switch (name) {
    case 'image_scan': return executeScan(cleanArgs);
    case 'image_ocr': return executeOcr(cleanArgs);
    case 'image_sample': return executeSample(cleanArgs);
    default: throw new Error(`unknown tool: ${name}`);
  }
}

// ---------------------------------------------------------------------------
// tool registry (schema + descriptions for tools/list)
// ---------------------------------------------------------------------------

const IMAGE_PATH_DESCRIPTION = 'Path to the image file (PNG/JPEG/GIF/BMP). Absolute path, or relative to the project workspace (resolved against the workspace root).';

/** The MCP tool definitions, one per model-facing tool. */
export const TOOLS = [
  {
    name: 'image_scan',
    description: [
      'Read a local image file as a coarse pixel grid (downscaled + color-quantized) so a text-only model can see layout, colors and rough shapes.',
      'Use it to inspect charts, screenshots, diagrams, UI mockups or photos: report dominant colors with percentages, relative positions of regions, coarse structure and luminance patterns.',
      'The result includes a luminance grid (rows top->bottom, columns left->right; " "=transparent, "." darkest, "@" brightest), a color grid for colorful images (one letter per cell, see legend), a "grid coords" line giving the row/col range, and a regions list: connected color blobs with position (grid rows/cols), size, aspect and texture density.',
      'Semantic reading: use the regions list plus your world knowledge to infer WHAT the image contains, not just raw colors — e.g. a large rough round green blob above a thin brown stem reads as a tree; a dense cluster of small bright blobs near the center with a dark smooth frame reads as a screen with content. Combine regions with the grids and zoom (focus/region) to verify.',
      'Realism judgment: the "shade diversity" line and each region\'s "N shade(s)" mix tell you how many hue+brightness variations an area has — 1-2 shades means flat/synthetic artwork (a sticker or diagram), many shades means photo-like content with lighting and gradients. Use this to say whether something looks drawn vs photographed.',
      'Structural hints are listed too: parallel stripes (alternating color bands) suggest panels/grilles/blades (e.g. solar panels, louvres, ribs); left-right symmetry suggests manufactured/constructed objects; smooth bright-to-dark gradients across a blob suggest curved surfaces (cylinders, spheres — e.g. a round module). Use these shape cues to identify objects, then verify with px_per_cell or image_sample on the area.',
      'To inspect details, work iteratively: first scan the full image (any size, default 32), identify the region you care about, then call image_scan again with focus: [row0, col0, row1, col1] — rows/cols are read from the "grid coords" line of that full scan, and you MUST keep size the SAME as that scan (focus itself provides the zoom: the same grid then covers only the focused area, so each cell shows finer detail). If you want even more detail, zoom again into a smaller focus inside the previous focused result, still with the same size. Alternatively pass region: [x0, y0, x1, y1] (0..1 fractions) which works with any size.',
      'For fine detail on a specific subject (a person, an object, a face): request a pixel density with px_per_cell — the number of source pixels each cell represents (e.g. px_per_cell: 4 makes every cell show a 4x4 pixel area). The tool clamps to 64 cells per side and reports the actual density in the header ("~XxYpx per cell"); if the region is too large for your requested density, shrink the region (zoom the focus) and retry. Use px_per_cell with region/focus, never for a whole huge image (too many cells).',
      'palette sets the color depth: auto (default, picks by content), full (14 colors), basic (8 colors) or gray (black/gray/white only).',
      'Note: "colors by area" reports TRUE pixel-level color shares (small colored details are never diluted away), and the "hue families" line breaks colors down by hue regardless of darkness — use it to spot pink/cyan/green content that a dark palette would otherwise hide (e.g. blossoms, water, vegetation).',
      'Limitation: no OCR/text recognition and no fine detail — thin lines and small glyphs may disappear at coarse sizes; zoom into a region to inspect details.',
      'size = target cells on the longer side (8..64, default 32). mode auto picks the color grid when the image is colorful.'
    ].join(' '),
    inputSchema: {
      type: 'object',
      additionalProperties: true,
      properties: {
        file_path: { type: 'string', description: IMAGE_PATH_DESCRIPTION },
        size: {
          type: 'integer',
          description: 'Target cell count on the longer side (8..64, default 32). Mutually exclusive with px_per_cell.'
        },
        px_per_cell: {
          type: 'integer',
          description: 'Requested source pixels per cell for fine detail (e.g. 2-16); clamped to 64 cells per side, actual density reported in the header. Use with region/focus on a small area, mutually exclusive with size.'
        },
        mode: {
          type: 'string',
          enum: ['auto', 'ascii', 'color'],
          description: 'auto = color grid when colorful, else luminance grid (default); ascii = luminance only; color = include color grid.'
        },
        palette: {
          type: 'string',
          enum: ['auto', 'full', 'basic', 'gray'],
          description: 'Color depth: auto (default) = pick by content, full = 14 colors, basic = 8 colors, gray = black/gray/white only.'
        },
        region: {
          type: 'array',
          description: 'Optional [x0, y0, x1, y1] fractions in 0..1 to zoom into part of the image. Mutually exclusive with focus.',
          items: { type: 'number' }
        },
        focus: {
          type: 'array',
          description: 'Zoom target as grid coordinates [row0, col0, row1, col1] (inclusive, based on the full-image grid the current size produces — read rows/cols from the "grid coords" line of a previous image_scan output). Mutually exclusive with region.',
          items: { type: 'integer' }
        }
      },
      required: ['file_path']
    }
  },
  {
    name: 'image_ocr',
    description: [
      'Recognize text in a local image. Two engines: engine="windows" (default) uses the Windows built-in OCR (no install, good for printed/UI text); engine="paddle" uses PaddleOCR via the local paddle_venv (much better for glowing, curved, stylized or game-rendered text and complex backgrounds, Chinese-friendly; ~2s model load per call).',
      'Use it together with image_scan: when the pixel grid shows a dense, regular, high-contrast structure that looks like text (e.g. titles, labels, buttons, dialogs, glowing banners), call image_ocr on that region and read the actual characters. If the Windows engine returns nothing but text is expected, retry with engine="paddle".',
      'Parameters: file_path (required), region: [x0, y0, x1, y1] (0..1 fractions) or focus: [row0, col0, row1, col1] (grid coordinates) to restrict recognition to an area, language (optional BCP-47 tag like "zh-Hans" or "en-US", Windows engine only), engine ("windows" default, "paddle").',
      'Large images are automatically downscaled (long side capped at 1600px) for the paddle engine so calls stay fast; the result notes the downscale — crop with region/focus when you need fine text from a big image.',
      'The result lists each recognized line with its pixel bounding box and confidence score (paddle).'
    ].join(' '),
    inputSchema: {
      type: 'object',
      additionalProperties: true,
      properties: {
        file_path: { type: 'string', description: IMAGE_PATH_DESCRIPTION },
        region: {
          type: 'array',
          description: 'Optional [x0, y0, x1, y1] fractions in 0..1 to restrict recognition to part of the image. Mutually exclusive with focus.',
          items: { type: 'number' }
        },
        focus: {
          type: 'array',
          description: 'Optional [row0, col0, row1, col1] grid coordinates (inclusive) to restrict recognition to part of the image. Mutually exclusive with region.',
          items: { type: 'integer' }
        },
        language: {
          type: 'string',
          description: 'Optional BCP-47 language tag (e.g. "zh-Hans", "en-US"); defaults to the user languages. Windows engine only.'
        },
        engine: {
          type: 'string',
          enum: ['windows', 'paddle'],
          description: '"windows" (default) = Windows built-in OCR; "paddle" = PaddleOCR via local paddle_venv (better for glowing/curved/game text).'
        }
      },
      required: ['file_path']
    }
  },
  {
    name: 'image_sample',
    description: [
      'Sample a small region of a local image as an NxN grid of EXACT pixels (one real pixel per cell, not an average) plus a local-contrast statistic.',
      'Use it to judge MATERIAL or TEXTURE where a coarse grid is not enough: smooth color gradients (skin, sky, water), high-contrast stripes (metal, wood grain, brushed surfaces), periodic repeats (fabric, brick), high-frequency noise (foliage, gravel), sharp edges (screen content, UI).',
      'Workflow: first use image_scan to locate the area, then call image_sample with a SMALL region (e.g. [x0, y0, x1, y1] fractions covering roughly 30-400 px per side) and an optional size (2..16, default 8). The region must be at least `size` pixels in each direction.',
      'Interpret the returned RGB grid: row 0 is the top, left to right. High contrast with stripes suggests metal/wood/rough material; smooth low-contrast transitions suggest skin/sky/uniform surfaces; repetitive patterns suggest fabric/texture.'
    ].join(' '),
    inputSchema: {
      type: 'object',
      additionalProperties: true,
      properties: {
        file_path: { type: 'string', description: IMAGE_PATH_DESCRIPTION },
        region: {
          type: 'array',
          description: 'Required [x0, y0, x1, y1] fractions in 0..1: the small area to sample. Must cover at least `size` pixels in each direction.',
          items: { type: 'number' }
        },
        size: {
          type: 'integer',
          description: 'Sample grid side length (2..16, default 8); the output is size x size exact pixels.'
        }
      },
      required: ['file_path', 'region']
    }
  }
];

/** Render a structured tool result as the text block fed back to the model. */
async function renderResult(name, value) {
  const core = await importCore();
  const renderer =
    name === 'image_scan' ? core.renderImageScan
      : name === 'image_ocr' ? core.renderOcr
        : name === 'image_sample' ? core.renderSample
          : null;
  if (renderer === null || renderer === undefined) {
    return `${name} result for ${value.path}: ${JSON.stringify(value)}`;
  }
  return renderer(value);
}

// ---------------------------------------------------------------------------
// MCP JSON-RPC plumbing
// ---------------------------------------------------------------------------

function rpcError(message, code = -32603) {
  return { jsonrpc: '2.0', error: { code, message } };
}

/**
 * Handle one decoded JSON-RPC message and produce the response (null for
 * notifications, which never get a response).
 * @param msg - parsed JSON-RPC message.
 * @returns the response object, or null.
 */
export async function handleRequest(msg) {
  const id = msg?.id;
  if (id === undefined || id === null) return null; // notification
  try {
    switch (msg.method) {
      case 'initialize': {
        return {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: msg.params?.protocolVersion ?? PROTOCOL_VERSION,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: 'picturereader', version: '0.1.0' }
          }
        };
      }
      case 'ping':
        return { jsonrpc: '2.0', id, result: {} };
      case 'tools/list':
        return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
      case 'tools/call': {
        const name = String(msg.params?.name ?? '');
        const value = await executeTool(name, msg.params?.arguments);
        const text = await renderResult(name, value);
        return {
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text }],
            structuredContent: value,
            isError: false
          }
        };
      }
      default:
        return { jsonrpc: '2.0', id, ...rpcError(`method not found: ${msg.method}`, -32601) };
    }
  } catch (error) {
    // Tool failures are reported in-band (isError) so the client can surface
    // the message to the model; protocol errors use JSON-RPC error codes.
    if (msg.method === 'tools/call') {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: `error: ${error.message}` }],
          isError: true
        }
      };
    }
    return { jsonrpc: '2.0', id, ...rpcError(error.message) };
  }
}

/**
 * Run the server loop over an input/output stream pair (defaults to
 * stdin/stdout). Returns a dispose function that tears down the listeners.
 * @param input - readable stream of newline-delimited JSON-RPC messages.
 * @param output - writable stream for JSON-RPC responses.
 * @param log - writable stream for diagnostics (stderr by default).
 * @returns a function that closes the server.
 */
export function runServer(input = process.stdin, output = process.stdout, log = process.stderr) {
  const rl = createInterface({ input, crlfDelay: Infinity });
  const onLine = (line) => {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      log.write('picturereader: ignoring invalid JSON-RPC line\n');
      return;
    }
    handleRequest(msg).then((response) => {
      if (response !== null && response !== undefined) {
        output.write(`${JSON.stringify(response)}\n`);
      }
    }).catch((error) => {
      log.write(`picturereader: ${error.stack ?? error.message}\n`);
    });
  };
  const onError = (error) => {
    log.write(`picturereader: input error: ${error.message}\n`);
  };
  rl.on('line', onLine);
  rl.on('error', onError);
  log.write('picturereader MCP server ready (image_scan / image_ocr / image_sample)\n');
  return () => {
    rl.off('line', onLine);
    rl.off('error', onError);
    rl.close();
  };
}

/**
 * Run the stdio server. Only executes when this file is the entry point, so
 * tests can import the functions above without starting a server.
 */
export function main() {
  const dispose = runServer();
  process.stdin.on('end', dispose);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
