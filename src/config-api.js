/**
 * picturereader 配置通道（host 半）—— dsh 0.2.x 适配层。
 *
 * 0.2.x 移除了「插件注册 settings 命名空间」的整套模型：host 侧
 * `settings.register(ns, Config, opts)` 与客户端服务 `settingsScope` 都不再存在，
 * 插件改为直接读自身 entry 的 Config、表单由内核按 Config schema 生成。
 *
 * 但本插件的设置卡需要内核表单表达不了的交互（视觉桥模型勾选、能力徽章、
 * 密钥只写不读），因此保留自绘卡片，并自建一条 host ↔ browser 通道：
 *
 *   GET /picturereader/config → 当前生效配置
 *   PUT /picturereader/config → 增量合并写入用户级覆盖层
 *
 * 生效优先级：entry config（profile patch，部署级）< 覆盖层（用户级）< schema 默认。
 * 覆盖层是 `$DSH_HOME/picturereader-config.json`（JSON 天然支持 vision_models 这类
 * 对象数组，不必把结构塞进 profile patch 的 YAML 子集）。
 *
 * 安全：与 `/api` 网关同契约的 loopback 信任围栏 —— 非本机 Host、跨站请求一律 403。
 *
 * @module picturereader/config-api
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** 配置路由前缀（client 侧同源 fetch）。 */
export const CONFIG_ROUTE = '/picturereader/config';

/** 允许写入的字段与类型（与 client.js 的 FIELDS 一一对应；新增字段必须同步）。 */
const FIELD_TYPES = {
  mode: 'string',
  vision_models: 'models',
  vlm_enabled: 'boolean',
  vlm_base: 'string',
  vlm_model: 'string',
  vlm_key: 'string',
  vlm_key_env: 'string',
  ocr_engine: 'string',
  vlm_timeout_ms: 'number',
  vlm_max_tokens: 'number',
  bridge_export_dir: 'string',
  debug: 'boolean',
  max_image_bytes: 'number',
  scan_default_size: 'number',
  scan_palette: 'string',
  scan_mode: 'string',
  ocr_language: 'string',
  multimodal_models: 'string',
  native_vision_auto: 'boolean',
  request_guard: 'boolean',
  batch_probe_first: 'number',
  batch_ocr_limit_chars: 'number',
  doc_dpi: 'number',
  doc_max_pages: 'number',
};

/** 单字段字符串长度上限（防止把巨型内容写进配置文件）。 */
const MAX_STRING = 8192;
/** vision_models 条目数上限。 */
const MAX_MODELS = 500;

/** 用户级覆盖层路径。 */
export function overrideFile() {
  const home = process.env.DSH_HOME;
  const base = typeof home === 'string' && home !== '' ? home : join(homedir(), '.dsh');
  return join(base, 'picturereader-config.json');
}

/**
 * 读取用户级覆盖层。
 * @returns {Promise<object>} 覆盖层对象；文件不存在/不可读/非法时返回空对象。
 */
export async function readOverride() {
  try {
    const parsed = JSON.parse(await readFile(overrideFile(), 'utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed;
  } catch {
    return {};
  }
}

/**
 * 原子写入用户级覆盖层。
 * @param {object} next - 完整覆盖层内容。
 */
export async function writeOverride(next) {
  const file = overrideFile();
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  await rename(tmp, file);
}

/** 单字段规范化：类型不符或超限一律返回 undefined（该键被忽略，不落盘）。 */
function normalizeValue(key, raw) {
  const type = FIELD_TYPES[key];
  if (type === undefined) return undefined;
  if (type === 'boolean') return typeof raw === 'boolean' ? raw : undefined;
  if (type === 'number') {
    if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
    if (typeof raw === 'string' && raw.trim() !== '' && Number.isFinite(Number(raw))) return Number(raw);
    return undefined;
  }
  if (type === 'models') {
    if (!Array.isArray(raw)) return undefined;
    const out = [];
    for (const entry of raw.slice(0, MAX_MODELS)) {
      const item = typeof entry === 'string' ? { id: entry } : entry;
      if (item === null || typeof item !== 'object') continue;
      const id = typeof item.id === 'string' ? item.id.slice(0, MAX_STRING) : '';
      if (id === '') continue;
      out.push({
        id,
        provider: typeof item.provider === 'string' ? item.provider.slice(0, MAX_STRING) : '',
        note: typeof item.note === 'string' ? item.note.slice(0, MAX_STRING) : '',
      });
    }
    return out;
  }
  if (typeof raw === 'string') return raw.length > MAX_STRING ? raw.slice(0, MAX_STRING) : raw;
  return undefined;
}

/**
 * 请求体 → 增量操作。请求体形如 `{ set: { key: value, … }, unset: ['key', …] }`；
 * 只接受白名单字段，非法键/值被静默丢弃（返回 undefined 表示整体非法）。
 * @param {unknown} payload - 已解析的 JSON 请求体。
 * @returns {{set: object, unset: string[]}|undefined}
 */
export function normalizePatch(payload) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
  const rawSet = payload.set ?? {};
  const rawUnset = payload.unset ?? [];
  if (rawSet === null || typeof rawSet !== 'object' || Array.isArray(rawSet)) return undefined;
  if (!Array.isArray(rawUnset)) return undefined;
  const set = {};
  for (const [key, value] of Object.entries(rawSet)) {
    const normalized = normalizeValue(key, value);
    if (normalized !== undefined) set[key] = normalized;
  }
  const unset = rawUnset.filter((key) => typeof key === 'string' && key in FIELD_TYPES);
  if (Object.keys(set).length === 0 && unset.length === 0) return undefined;
  return { set, unset };
}

/**
 * 把增量操作合并进覆盖层（纯函数，便于测试）。
 * @param {object} base - 当前覆盖层。
 * @param {{set: object, unset: string[]}} patch - 规范化后的增量。
 * @returns {object} 新的覆盖层。
 */
export function mergeOverride(base, patch) {
  const next = { ...base };
  for (const [key, value] of Object.entries(patch.set)) next[key] = value;
  for (const key of patch.unset) delete next[key];
  return next;
}

// ── loopback 信任围栏（与 /api 网关同一契约）──────────────────────────────
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]']);
/** 127.0.0.0/8 的完整四段写法（挡住 `127.0.0.1.evil.com` 这类伪装前缀）。 */
const LOOPBACK_IPV4 = /^127(?:\.\d{1,3}){3}$/;

/** 读取 header（大小写不敏感的 node 对象；数组取首值）。 */
function headerValue(headers, name) {
  if (headers === null || typeof headers !== 'object') return undefined;
  const raw = headers[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' ? value : undefined;
}

/** host header → hostname（IPv6 保留方括号；IPv4 去掉端口）。 */
function hostnameOf(host) {
  if (host.startsWith('[')) {
    const end = host.indexOf(']');
    return end === -1 ? '' : host.slice(0, end + 1);
  }
  const colon = host.indexOf(':');
  return colon === -1 ? host : host.slice(0, colon);
}

/**
 * 是否为可信（本机）请求。
 * @param {import('node:http').IncomingMessage} request - 原始请求。
 * @returns {boolean} 非 loopback host 或跨站请求返回 false。
 */
export function isTrustedRequest(request) {
  const host = headerValue(request.headers, 'host');
  if (host === undefined) return false;
  const hostname = hostnameOf(host);
  if (!LOOPBACK_HOSTNAMES.has(hostname) && !LOOPBACK_IPV4.test(hostname)) return false;
  if (headerValue(request.headers, 'sec-fetch-site') === 'cross-site') return false;
  const origin = headerValue(request.headers, 'origin');
  if (origin === undefined) return true;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/** 写 JSON 响应。 */
function writeJson(response, status, value) {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-cache' });
  response.end(JSON.stringify(value));
}

/** 读取请求体并解析 JSON（空 body / 非法 JSON → 抛错）。 */
async function readJson(request) {
  let body = '';
  for await (const chunk of request) body += chunk;
  return JSON.parse(body);
}

/**
 * 构造配置路由 handler（GET 读 / PUT 写）。
 * @param {() => object} read - 读取当前生效配置。
 * @param {(patch: {set: object, unset: string[]}) => Promise<object>} write - 应用增量并返回新配置。
 * @returns {(request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse) => Promise<void>}
 */
export function createConfigHandler(read, write) {
  return async (request, response) => {
    try {
      await handleConfigRequest(request, response, read, write);
    } catch (error) {
      // 兜底：未预期异常必须带原因返回，否则 webServer 只会回一个无信息的 400。
      const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
      if (response.headersSent) {
        response.destroy();
        return;
      }
      writeJson(response, 500, { ok: false, error: { message: `config handler failed: ${message}` } });
    }
  };
}

async function handleConfigRequest(request, response, read, write) {
  if (!isTrustedRequest(request)) {
    writeJson(response, 403, { ok: false, error: { code: 'forbidden', message: 'forbidden' } });
    return;
  }
  if (request.method === 'GET') {
    writeJson(response, 200, { ok: true, value: read() });
    return;
  }
  if (request.method !== 'PUT') {
    writeJson(response, 405, { ok: false, error: { message: 'method not allowed' } });
    return;
  }
  let patch;
  try {
    patch = normalizePatch(await readJson(request));
  } catch {
    patch = undefined;
  }
  if (patch === undefined) {
    writeJson(response, 400, { ok: false, error: { message: 'invalid config' } });
    return;
  }
  try {
    writeJson(response, 200, { ok: true, value: await write(patch) });
  } catch (error) {
    // 落盘失败绝不当成功：client 据此提示「保存失败」，内存生效值保持原样。
    writeJson(response, 500, { ok: false, error: { message: `config write failed: ${String(error)}` } });
  }
}

/**
 * 注册配置路由（经 webServer 局部注入）。
 *
 * 注意两点（沿用上游 think-zh-expand 的踩坑结论）：
 *  1. 必须 `ctx.inject(['webServer'], …)` 局部等待，不能用 `ctx.get('webServer')` —— 服务晚于
 *     插件启动时不重试，会拿到 undefined；
 *  2. 顶层 `inject` 不声明 webServer，否则无 webServer 的 profile（如 headless）整个插件不加载。
 *
 * @param {object} ctx - 插件上下文。
 * @param {{read: () => object, write: (patch: object) => Promise<object>}} ops - 读写实现。
 * @param {(message: string) => void} [warn] - 失败告警。
 */
export function mountConfigRoute(ctx, ops, warn) {
  try {
    ctx.inject(['webServer'], (scope) => {
      const webServer = scope.webServer;
      if (!webServer || typeof webServer.register !== 'function') return;
      ctx.effect(
        () => webServer.register({ kind: 'exact', path: CONFIG_ROUTE, handler: createConfigHandler(ops.read, ops.write) }),
        'picturereader: config route',
      );
    });
  } catch (error) {
    warn?.(`config route not registered: ${String(error?.message || error)}`);
  }
}
