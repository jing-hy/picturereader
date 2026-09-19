/**
 * picturereader 模型视觉能力判定 (vision-capability.js)
 *
 * 判定「当前模型能否原生识图」——与 DSH 内核**同源**：内核用适配器元数据
 * `inputModalities`（'text' | 'image'）做图片能力门控（@deepseek-ai/dsh-llm：
 * 该字段显式不含 image 时，把请求里的图片历史投影成文本占位）。三态语义
 * （官方注释：*absent means unknown, while an explicit omission is negative
 * capability*）：
 *
 *  - native    显式含 'image' → 模型自己能看图：提示词应说明"不要用
 *              image_scan / image_sample 这类伪多模态替代路径（粗网格信息损失
 *              大），但 image_ocr 仍应正常使用（原生视觉对小字/发光字会幻觉）"。
 *  - text-only 显式不含        → 维持既有本地工具链引导（零变化）。
 *  - unknown   元数据缺失      → 不注入任何新提示，行为等同改动前。
 *
 * ⚠️ 关键约束：本插件的「视觉孪生」(picturereader-vision.mjs) 会用 Proxy 把被
 * 勾选模型的 inputModalities 改写成 ['text','image']，因此能力判定**绝不能**走
 * `llm.listModels()` / `llm.resolveModel()`——那会把「伪识图（孪生）」误判成
 * 「真·原生识图」。判定必须由调用方传入**未包装的原始 adapter**（见
 * realAdapterOf）。
 *
 * 本模块为纯逻辑 + 进程内缓存（无 ctx 依赖），便于单测。
 * @module picturereader/vision-capability
 */

/** 三态判定取值。 */
export const VERDICTS = Object.freeze({
  native: 'native',
  textOnly: 'text-only',
  unknown: 'unknown',
});

/** 注入到系统提示词的 section 名（与内核 deployment:persona 等不冲突）。 */
export const CAPABILITY_SECTION_NAME = 'picturereader:image-capability';

/**
 * section 排序位：内核 SECTION_ORDERS 只占用 -1000..2900（工具段）、5000
 * (TOOLS_SDK)、9000/9900；3000 未被占用，位于工具说明之后、SDK 说明之前。
 */
export const CAPABILITY_SECTION_ORDER = 3000;

/**
 * 把适配器上报的 inputModalities 归一化成三态判定。
 * @param {readonly string[]|undefined|null} modalities - 模型声明的输入模态。
 * @returns {'native'|'text-only'|'unknown'}
 */
export function verdictFromModalities(modalities) {
  if (!Array.isArray(modalities)) return VERDICTS.unknown;
  return modalities.includes('image') ? VERDICTS.native : VERDICTS.textOnly;
}

/** 能力缓存的键。 */
export function modelKey(provider, model) {
  return `${provider ?? ''}/${model ?? ''}`;
}

/** provider/model → { verdict, at, source }；进程内缓存，重启即重建。 */
const capabilities = new Map();

/**
 * 写入一条能力判定。
 * @param {string} provider
 * @param {string} model
 * @param {'native'|'text-only'|'unknown'} verdict
 * @param {string} [source] - 判定来源，便于调试（listModels / resolveModel / error）。
 */
export function setCapability(provider, model, verdict, source = '') {
  if (!model) return;
  capabilities.set(modelKey(provider, model), { verdict, at: Date.now(), source });
}

/**
 * 读取能力判定。
 * @returns {'native'|'text-only'|'unknown'|undefined} undefined = 尚未探测到。
 */
export function capabilityOf(provider, model) {
  const hit = capabilities.get(modelKey(provider, model));
  return hit === undefined ? undefined : hit.verdict;
}

/** 清空能力缓存（测试 / 诊断用）。 */
export function clearCapabilities() {
  capabilities.clear();
}

/** 重置进程级状态（能力缓存 + 最近活动模型）。测试用。 */
export function resetVisionCapabilityState() {
  capabilities.clear();
  lastActive = null;
}

/** 当前缓存条数（诊断用）。 */
export function capabilityCount() {
  return capabilities.size;
}

/**
 * 用**未包装的原始 adapter** 探测一个精确 provider/model 的能力并写入缓存。
 * 供 llm/stream 冷启动补种（异步、尽力而为，失败按 unknown 处理）。
 * @param {object|null} adapter - realAdapterOf() 返回的原始 adapter。
 * @param {string} provider
 * @param {string} model
 * @returns {Promise<'native'|'text-only'|'unknown'>}
 */
export async function seedCapabilityFromAdapter(adapter, provider, model) {
  if (!adapter || !model) return VERDICTS.unknown;
  try {
    if (typeof adapter.resolveModel === 'function') {
      const info = await adapter.resolveModel(provider, model);
      const verdict = verdictFromModalities(info?.inputModalities);
      setCapability(provider, model, verdict, 'resolveModel');
      return verdict;
    }
    if (typeof adapter.listModels === 'function') {
      const list = await adapter.listModels(provider);
      const hit = (list ?? []).find((entry) => entry?.id === model);
      const verdict = hit === undefined ? VERDICTS.unknown : verdictFromModalities(hit.inputModalities);
      setCapability(provider, model, verdict, 'listModels');
      return verdict;
    }
  } catch {
    setCapability(provider, model, VERDICTS.unknown, 'error');
    return VERDICTS.unknown;
  }
  return VERDICTS.unknown;
}

// ── 当前模型跟踪 ────────────────────────────────────────────────────────────
// 提示词 section 的 text 提供者是**同步**函数，而能力探测是异步的，因此当前
// 模型的来源分三层（后写覆盖前写）：
//   1. system-prompt/assemble 的 variables.provider/model（内核/入口每轮写入，
//      最权威）；
//   2. agent.options（创建时快照，会话内切模型后可能过时，作兜底）；
//   3. llm/stream 的 options.provider/model（每轮请求，进程级兜底）。
// agent 级缓存用 WeakMap 隔离，避免多会话/子代理互相污染。

/** agent → { provider, model, at }。 */
const agentModels = new WeakMap();

/** 进程级最近一次实际请求的模型（无 agent 信息时的兜底）。 */
let lastActive = null;

/** 记录某 agent 当前使用的模型。 */
export function noteAgentModel(agent, provider, model) {
  if (!agent || typeof agent !== 'object') return;
  if (!model && !provider) return;
  const prev = agentModels.get(agent);
  if (prev && prev.provider === provider && prev.model === model) return;
  agentModels.set(agent, { provider: provider ?? '', model: model ?? '', at: Date.now() });
}

/** 读取某 agent 记录的模型（可能为 undefined）。 */
export function agentModel(agent) {
  if (!agent || typeof agent !== 'object') return undefined;
  return agentModels.get(agent);
}

/** 记录进程级最近一次请求的模型。 */
export function noteActiveModel(provider, model) {
  if (!model && !provider) return;
  lastActive = { provider: provider ?? '', model: model ?? '', at: Date.now() };
}

/** 进程级最近一次请求的模型。 */
export function activeModel() {
  return lastActive ?? undefined;
}

/**
 * 解析"当前模型"：agent 级缓存 → 进程级兜底 → agent.options。
 * @param {object} [agent] - AssembleContext.agent。
 * @param {object} [options] - agent.options（{provider, model}）。
 * @returns {{provider: string, model: string}|undefined}
 */
export function resolveActiveModel(agent, options) {
  const fromAgent = agentModel(agent);
  if (fromAgent !== undefined && fromAgent.model) {
    return { provider: fromAgent.provider, model: fromAgent.model };
  }
  const fromSink = activeModel();
  if (fromSink !== undefined && fromSink.model) {
    return { provider: fromSink.provider, model: fromSink.model };
  }
  if (options !== undefined && options !== null && options.model) {
    return { provider: options.provider ?? '', model: options.model };
  }
  return undefined;
}

// ── 白名单 / 提示词 ─────────────────────────────────────────────────────────

/** 解析 multimodal_models（逗号分隔）为数组。 */
export function parseWhitelist(raw) {
  return String(raw ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * 该 provider/model 是否应被当作"原生识图"：底层元数据判定为 native，或用户
 * 在 multimodal_models 白名单里显式声明（人工覆盖元数据，含元数据缺失的场景）。
 * @param {string} provider
 * @param {string} model
 * @param {readonly string[]} [whitelist]
 * @returns {boolean}
 */
export function isDeclaredNative(provider, model, whitelist = []) {
  if (model && whitelist.includes(model)) return true;
  return capabilityOf(provider, model) === VERDICTS.native;
}

/**
 * 生成注入系统提示词的能力说明（纯函数）。
 * @param {'native'|'text-only'|'unknown'} verdict
 * @param {{model?: string}} [opts]
 * @returns {string} 空串表示不注入（renderPrompt 会丢弃空 section）。
 */
export function hintText(verdict, opts = {}) {
  if (verdict !== VERDICTS.native) return '';
  const model = opts.model ? ` \`${opts.model}\`` : '';
  return [
    `【图像能力】当前模型${model}**原生支持图像输入**：你可以直接看图，请直接依据你看到的画面作答。`,
    '—— **不要**用 `image_scan` / `image_sample` 这类把图片降采样成像素网格、色彩分块的手段来代替视觉：它们是为**没有视觉能力**的纯文本模型准备的"伪多模态"替代路径，信息损失大，容易把结论建立在残缺数据上。你自己就能看图时，用它们只会更慢更不准。',
    '—— **`image_ocr` 仍应正常使用**：原生视觉对小字、发光字、艺术字、游戏 HUD 文字会幻觉或猜错，凡涉及具体文字（标题/按钮/参数/水印/标识），一律以 `image_ocr` 实读为准；必要时先 `image_crop` 裁剪放大再 OCR。',
    '—— `vision_analyze` 的外部 VLM 分支对你是多余的（你自己就是视觉模型）；需要像素统计或 OCR 证据时，仍可用它的 `include_scan` / `include_ocr`。',
    '—— 若已加载 `image-reading` skill：该 skill 是给无视觉模型的 5 步扫描方法论，本会话不必遵循其流程，直接看图即可。',
  ].join('\n');
}

/**
 * 组装 system prompt section 文本（同步，供 ctx.systemPrompt.section 的 text 调用）。
 * @param {object} [agent] - AssembleContext.agent。
 * @param {object} [options] - agent.options。
 * @param {object} [cfg] - 插件配置（扁平）。
 * @returns {string} 空串 = 不注入。
 */
export function capabilitySectionText(agent, options, cfg) {
  try {
    if (cfg?.native_vision_auto === false) return '';
    const active = resolveActiveModel(agent, options);
    if (active === undefined || !active.model) return '';
    const whitelist = parseWhitelist(cfg?.multimodal_models);
    if (!isDeclaredNative(active.provider, active.model, whitelist)) return '';
    return hintText(VERDICTS.native, { model: active.model });
  } catch {
    return '';
  }
}
