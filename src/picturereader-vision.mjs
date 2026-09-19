/**
 * picturereader 视觉孪生 adapter
 *
 * 用 Proxy 把已注册的 adapter（如 PiAiAdapter，它服务 opencode-go / deepseek
 * / xiaomi / qiu 等多个 provider）包装成"孪生"：
 *
 *  - listModels / resolveModel：将被勾选的模型标成 inputModalities:['text',
 *    'image'] + 名称加「(视觉)」后缀 → DSH 原生缩略图/图片块进会话。
 *  - stream：拦截请求里的 image block → 用 picturereader 本地工具链分析 → 替换
 *    成文本 → 再转发给原始 adapter（pi-ai 收到纯文本，不会 UNSUPPORTED_CONTENT）。
 *
 * @module picturereader/picturereader-vision
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { contentHasImage } from '@deepseek-ai/dsh-llm';
import webpWasm from 'webp-wasm';
// webp-wasm 是 callback API（内部依赖 this=模块对象）。手写 callback→Promise
// 包装（勿用 util.promisify：其启发式对纯 callback 函数误报 DEP0174 噪音）。
let decoderReady = false;
function loadWebpDecoder() {
  if (decoderReady) return Promise.resolve();
  return new Promise((resolve, reject) => {
    webpWasm.loadDecoder.call(webpWasm, (err) => {
      if (err) return reject(err);
      decoderReady = true;
      resolve();
    });
  });
}
function decodeWebp(bytes) {
  return new Promise((resolve, reject) => {
    webpWasm.decode.call(webpWasm, bytes, (err, img) => (err ? reject(err) : resolve(img)));
  });
}
import { PNG } from 'pngjs';

const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh');
const IMAGE_DIR = join(DSH_HOME, 'picturereader-vision', 'images');

/** 从配置读取被勾选的模型 Map<provider/id, entry>。 */
function selectedMap(getConfig) {
  try {
    const cfg = getConfig?.();
    const list = cfg?.vision_models;
    if (!Array.isArray(list)) return new Map();
    const map = new Map();
    for (const m of list) {
      const id = typeof m === 'string' ? m : m.id;
      const provider = (typeof m === 'object' ? m.provider : '') || '';
      if (id) map.set(provider + '/' + id, m);
    }
    return map;
  } catch { return new Map(); }
}

function isSelected(getConfig, provider, id) {
  const map = selectedMap(getConfig);
  return map.has(provider + '/' + id);
}

function noteOf(getConfig, provider, id) {
  const map = selectedMap(getConfig);
  const entry = map.get(provider + '/' + id);
  return entry && typeof entry === 'object' ? (entry.note || '') : '';
}

/** 给被勾选模型注入视觉元数据（inputModalities / pi-ai 的 input）。 */
function applyVisionMeta(model, provider, getConfig) {
  if (!model || !isSelected(getConfig, provider, model.id)) return model;
  const note = noteOf(getConfig, provider, model.id);
  const suffix = note ? ` (${note})` : ' (视觉)';
  const out = { ...model, name: (model.name || model.id) + suffix, inputModalities: ['text', 'image'] };
  // pi-ai 系列用 `input` 数组；一并注入，保证 resolveModel 也通过。
  if ('input' in model) out.input = [...model.input, 'image'];
  return out;
}

/** 把图片字节落盘为临时文件，返回工具链可读的路径。 */
async function saveImageBytes(bytes, mediaType) {
  await mkdir(IMAGE_DIR, { recursive: true });
  const hash = createHash('sha1').update(bytes).digest('hex').slice(0, 24);
  const ext = mediaType === 'image/jpeg' ? '.jpg'
    : mediaType === 'image/webp' ? '.png'   // 工具链不支持 webp：落盘转 png
      : mediaType === 'image/gif' ? '.gif' : '.png';
  const path = join(IMAGE_DIR, hash + ext);
  // dsh 0.1.2 附件归一化常产出 webp（PNG 带 alpha → webp），而本地工具链
  // （image_scan/OCR）只读 png/jpg/gif/bmp。webp 需转 png 再落盘，否则分析链
  // 断在格式。用 libwebp→WASM（webp-wasm，纯字节码全平台一致）解码成 RGBA，
  // 再经项目已有依赖 pngjs 编码为 PNG——零额外原生依赖、零用户操作。
  if (mediaType === 'image/webp') {
    try {
      await loadWebpDecoder();
      const rgba = await decodeWebp(bytes);
      const png = new PNG({ width: rgba.width, height: rgba.height });
      Buffer.from(rgba.data).copy(png.data);
      await writeFile(path, PNG.sync.write(png), { flag: 'wx' }).catch((e) => { if (e?.code !== 'EEXIST') throw e; });
      return path;
    } catch (e) {
      console.error('[picturereader] webp decode failed, falling back to raw bytes:', e?.message || e);
    }
  }
  try { await writeFile(path, bytes, { flag: 'wx' }); } catch (e) { if (e?.code !== 'EEXIST') throw e; }
  return path;
}

/** 读图（经 attachments）并做本地说明，返回一段文本证据（path 供工具续读）。 */
async function analyzeImage(block, attachments) {
  let data;
  try {
    ({ data } = await attachments.readImage(block.attachment));
  } catch (e) {
    return `[图片]（读取失败：${e?.message || e}），请用 image_scan 分析附件`;
  }
  const path = await saveImageBytes(data, block.attachment.mediaType);
  return `[用户粘贴了一张图片]\n图片已导出到：${path}\n请先用 image_scan 分析该图片（如含文字再用 image_ocr），结合内容回答。`;
}

/** 把消息里的 image block 替换成分析文本。 */
async function sanitizeImages(ctx, messages) {
  const attachments = ctx.get?.('attachments') ?? ctx.attachments;
  const next = [];
  for (const message of messages) {
    const content = message?.content;
    if (!Array.isArray(content) || !content.some((b) => b?.type === 'image')) { next.push(message); continue; }
    const blocks = [];
    for (const block of content) {
      if (block?.type !== 'image') { blocks.push(block); continue; }
      blocks.push({ type: 'text', text: await analyzeImage(block, attachments) });
    }
    next.push({ ...message, content: blocks });
  }
  return next;
}

/**
 * 对被选中模型所属的 provider，用 Proxy 包装原始 adapter 成孪生并原位替换
 * registration.adapter（避免 DUPLICATE_ADAPTER）。返回注册数；注册者用 ctx.effect
 * 在卸载时恢复原 adapter。
 */
// 模块级孪生注册状态：wrapped = provider -> 最近一次真实 adapter。
// registerTwinAdapters 可安全重入（第二次起只刷新包装，不重复注册监听/effect）。
let twinState = null;

/**
 * 包装被勾选模型所属 provider 的 adapter（视觉孪生）。
 * 可安全重复调用：仅在首次注册事件监听与卸载钩子，后续调用（含
 * refreshTwinAdapters）只做"当前真实 adapter 的检查式重包装"。
 * @param {import("cordis").Context} ctx
 * @param {object} llm - 宿主注入的 llm 服务（registration/listProviders 等）。
 * @param {() => object} getConfig - 读取当前配置（vision_models 等）。
 * @returns {number} 已包装的 provider 数。
 */
export function registerTwinAdapters(ctx, llm, getConfig) {
  if (!llm || !getConfig) return 0;
  if (!twinState) {
    twinState = { wrapped: new Map() };
    // 运行时 provider/adapter 变更（添加供应商、插件更新等）会替换 reg.adapter，
    // 导致既有孪生 proxy 失效（模型名丢失「(视觉)」后缀）。监听
    // llm/adapters-updated 重新包装，避免依赖 DSH 重启恢复。
    const onAdaptersUpdated = () => refreshTwinAdapters(ctx, llm, getConfig);
    ctx.on('llm/adapters-updated', onAdaptersUpdated);
    // 卸载时恢复：解绑事件 + 各 provider 还原为最近一次的真实 adapter。
    ctx.effect(() => () => {
      ctx.off('llm/adapters-updated', onAdaptersUpdated);
      for (const [provider, orig] of twinState.wrapped) {
        try {
          const reg = llm.registration(provider);
          if (reg) reg.adapter = orig;
        } catch { /* provider no longer registered; ignore */ }
      }
      twinState = null;
    });
  }
  return refreshTwinAdapters(ctx, llm, getConfig);
}

/**
 * 检查式刷新孪生包装（可随时调用，幂等）：
 * - 当前 reg.adapter 已是我们 proxy → 跳过（防套娃）；
 * - 否则取其真实 adapter 重新包装（覆盖 DSH 替换 adapter 的场景）。
 * 供 registerTwinAdapters 重入、llm/adapters-updated 事件与设置热更新（scope.watch）调用。
 * @param {object} llm
 * @param {() => object} getConfig
 * @returns {number} 当前已包装的 provider 数。
 */
export function refreshTwinAdapters(ctx, llm, getConfig) {
  if (!twinState || !llm || !getConfig) return 0;
  const map = selectedMap(getConfig);
  for (const key of map.keys()) wrapProvider(twinState, ctx, llm, key.split('/')[0], getConfig);
  return twinState.wrapped.size;
}

/**
 * 返回某 provider 的**未包装原始 adapter**（用于模型能力判定）。
 *
 * 孪生会通过 Proxy 把被勾选模型的 inputModalities 改写成 ['text','image']，
 * 因此 `llm.listModels()` / `llm.resolveModel()` 的结果不能用来判断"模型是否
 * 真的原生识图"——那会把"伪识图（孪生）"误判成原生识图。本函数绕过孪生：
 *  - 已记录原始 adapter（twinState.wrapped）→ 直接返回它；
 *  - 当前 adapter 是**别人的** proxy（带 __picturereaderTwin 但本模块没记录）
 *    → 返回 null，调用方按"未知"处理，绝不猜。
 * @param {object} llm - 宿主 llm 服务（registration）。
 * @param {string} provider - provider 路由键。
 * @returns {object|null} 原始 adapter 或 null。
 */
export function realAdapterOf(llm, provider) {
  if (!llm || !provider) return null;
  const unwrapped = twinState?.wrapped?.get(provider);
  if (unwrapped) return unwrapped;
  let reg;
  try { reg = llm.registration(provider); } catch { return null; }
  const adapter = reg?.adapter;
  if (!adapter) return null;
  if (adapter.__picturereaderTwin) return null;
  return adapter;
}

/** 若 provider 当前 adapter 尚未被包装（非孪生 proxy），则包装之。 */
function wrapProvider(state, ctx, llm, provider, getConfig) {
  let reg;
  try { reg = llm.registration(provider); } catch { return; }
  if (!reg || !reg.adapter) return;
  // dsh-llm 在 provider/adapter 变更时替换 reg.adapter；若当前值已是本插件的
  // 孪生 proxy 则跳过（防嵌套），否则取真实 adapter 重新包装。
  if (reg.adapter?.__picturereaderTwin) return;
  const orig = reg.adapter;
  state.wrapped.set(provider, orig);

  const origList = orig.listModels.bind(orig);
  const origResolve = orig.resolveModel.bind(orig);
  const origPrepare = typeof orig.prepareCall === 'function' ? orig.prepareCall.bind(orig) : null;
  const origStream = orig.stream.bind(orig);

  const twin = new Proxy(orig, {
    get(target, prop, receiver) {
      if (prop === '__picturereaderTwin') return true;
      if (prop === 'listModels') {
        return async (p) => (await origList(p)).map((m) => applyVisionMeta(m, p, getConfig));
      }
      if (prop === 'resolveModel') {
        return async (p, m, signal) => applyVisionMeta(await origResolve(p, m, signal), p, getConfig);
      }
      if (prop === 'prepareCall' && origPrepare) {
        // dsh-llm 的能力判定与流调度都走 prepareCall 返回的对象：
        //   model.inputModalities -> 图片能力判定（缺则图片被省略）
        //   stream               -> 实际流入口（缺图片拦截则 pi-ai 报
        //                            "does not support image input"）
        // 两个都必须包装：注入视觉元数据 + 拦截图片转本地分析文本。
        return async (p, m, signal) => {
          const result = await origPrepare(p, m, signal);
          if (result && result.model) result.model = applyVisionMeta(result.model, p, getConfig);
          if (result && typeof result.stream === 'function') {
            const preparedStream = result.stream.bind(result);
            // 必须是异步生成器：dsh-llm 对 stream() 的返回值做 for await
            // （要求 [Symbol.asyncIterator]）；async 函数返回 Promise 会崩。
            result.stream = async function* (options) {
              if (options?.messages?.some((msg) => contentHasImage(msg?.content))) {
                // 防御：图片分析失败时原样放行，绝不让流中断污染会话
                try {
                  options = { ...options, messages: await sanitizeImages(ctx, options.messages) };
                } catch (e) {
                  console.error('[picturereader] sanitizeImages failed, forwarding original messages:', e?.message || e);
                }
              }
              yield* preparedStream(options);
            };
          }
          return result;
        };
      }
      if (prop === 'stream') {
        return async function* (options) {
          if (options?.messages?.some((msg) => contentHasImage(msg?.content))) {
            try {
              options = { ...options, messages: await sanitizeImages(ctx, options.messages) };
            } catch (e) {
              console.error('[picturereader] sanitizeImages failed, forwarding original messages:', e?.message || e);
            }
          }
          yield* origStream(options);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });

  reg.adapter = twin;
}
