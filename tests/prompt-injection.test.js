/**
 * picturereader 集成冒烟测试：apply() 的接线是否真的生效。
 *
 * 用最小 ctx / services 桩跑一遍 apply()，断言三件事：
 *  1. 能力扫描用**未包装的原始 adapter**，把 inputModalities 写进能力缓存；
 *  2. system-prompt/assemble → section 注入：原生识图模型注入"不建议 image_scan
 *     但 image_ocr 照用"的段落，纯文本模型不注入；
 *  3. llm/stream 图片桥：原生识图模型的消息**原样放行**（不降级），纯文本模型
 *     仍降级成"请用 image_scan"的文本引导（零回归）。
 *
 * 注意扫描只在发现「非 image 模型的文本模型列表」时才写
 * ~/.dsh/picturereader-models.json，本测试的 provider 只暴露 image 模型，
 * 因此不会污染真实缓存文件。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { apply } from '../src/index.js';
import { VERDICTS, capabilityOf, resetVisionCapabilityState, setCapability } from '../src/vision-capability.js';

/** 最小 Cordis ctx / services 桩，收集 apply() 注册的监听器、section 与工具。 */
function makeHarness({ providers = [], adapters = {}, config = {} } = {}) {
  const listeners = new Map();
  const sections = [];
  const tools = [];
  let services;

  const ctx = {
    logger: { warn() {}, info() {}, error() {}, debug() {} },
    effect(fn) {
      const disposer = fn();
      return typeof disposer === 'function' ? disposer : () => {};
    },
    on(event, handler) {
      const list = listeners.get(event) ?? [];
      list.push(handler);
      listeners.set(event, list);
      return () => {};
    },
    inject(names, cb) {
      if (names.every((name) => services?.[name] !== undefined)) cb(services);
    },
    get(name) {
      return services?.[name];
    },
    tools: { register(def) { tools.push(def); } },
    skills: { register() { return () => {}; } },
  };

  services = {
    tools: ctx.tools,
    fs: {
      resolve: async (path) => ({ displayPath: path }),
      stat: async () => ({ type: 'file', version: '1' }),
      readBytes: async () => Buffer.alloc(0),
    },
    llm: {
      listProviders: () => providers.map((id) => ({ id, name: id })),
      listModels: async (id) => adapters[id]?.models ?? [],
      registration: (id) => ({ provider: { id }, adapter: adapters[id]?.adapter }),
    },
    attachments: {
      // 图片桥只落盘不解析，任意字节即可
      readImage: async () => ({ data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) }),
    },
    settings: {
      register() {
        return { get: () => ({ ...config }), watch() { return () => {}; } };
      },
    },
    systemPrompt: {
      section(def) { sections.push(def); return () => {}; },
    },
  };

  return { ctx, listeners, sections, tools };
}

const IMAGE_MODEL = { provider: 'provA', id: 'vision-model', name: 'Vision Model', inputModalities: ['text', 'image'] };

function imageMessage() {
  return {
    role: 'user',
    content: [{ type: 'image', attachment: { attachmentId: 'a1', mediaType: 'image/png', name: 'shot.png' } }],
  };
}

/** 跑一遍 stream 监听器，返回它交给下游的 options（undefined = 原样放行）。 */
async function runStreamHandler(handler, options) {
  let passedOptions;
  const iterable = handler(options, (next) => {
    passedOptions = next;
    return (async function* () {
      yield { type: 'text', text: 'downstream' };
    })();
  });
  const chunks = [];
  for await (const chunk of iterable) chunks.push(chunk);
  return { passedOptions, chunks };
}

test('apply()：原始 adapter 扫描写入能力 + native 模型注入能力段落 + 图片直通', async () => {
  resetVisionCapabilityState();
  const harness = makeHarness({
    providers: ['provA'],
    adapters: {
      provA: {
        models: [IMAGE_MODEL],
        adapter: { listModels: async () => [IMAGE_MODEL], resolveModel: async (p, m) => ({ ...IMAGE_MODEL, id: m }) },
      },
    },
    config: { native_vision_auto: true, multimodal_models: '' },
  });
  apply(harness.ctx, {});
  await new Promise((resolve) => setTimeout(resolve, 30)); // 等启动扫描 IIFE

  // 1. 扫描把原生能力写进缓存（走的是未包装 adapter）
  assert.equal(capabilityOf('provA', 'vision-model'), VERDICTS.native);

  // 2. section 已注册；assemble 监听把本轮模型记到 agent 上
  const section = harness.sections.find((entry) => entry.name === 'picturereader:image-capability');
  assert.ok(section, 'image-capability section 应已注册');
  assert.equal(section.order, 3000);
  const assemble = harness.listeners.get('system-prompt/assemble')?.[0];
  assert.ok(assemble, 'system-prompt/assemble 监听应已注册');
  const agent = {};
  await assemble({ variables: {} }, { agent }, async () => ({
    variables: { provider: 'provA', model: 'vision-model' },
  }));
  const text = section.text({ agent });
  assert.match(text, /原生支持图像输入/);
  assert.match(text, /image_scan/);
  assert.match(text, /image_ocr/);

  // 3. 图片桥：native 模型的消息原样放行，不降级
  const handler = harness.listeners.get('llm/stream')?.[0];
  const options = { provider: 'provA', model: 'vision-model', messages: [imageMessage()] };
  const { passedOptions } = await runStreamHandler(handler, options);
  assert.equal(passedOptions, undefined, 'native 识图模型不应改写消息');
});

test('apply()：纯文本模型不注入段落，图片仍降级为 image_scan 引导（零回归）', async () => {
  resetVisionCapabilityState();
  const exportDir = join(tmpdir(), 'picturereader-test-bridge');
  const harness = makeHarness({
    providers: ['provB'],
    adapters: {
      provB: {
        models: [],
        adapter: { listModels: async () => [] },
      },
    },
    config: { native_vision_auto: true, multimodal_models: '', bridge_export_dir: exportDir },
  });
  setCapability('provB', 'text-model', VERDICTS.textOnly, 'test');
  apply(harness.ctx, {});
  await new Promise((resolve) => setTimeout(resolve, 20));

  const section = harness.sections.find((entry) => entry.name === 'picturereader:image-capability');
  const assemble = harness.listeners.get('system-prompt/assemble')?.[0];
  const agent = {};
  await assemble({ variables: {} }, { agent }, async () => ({
    variables: { provider: 'provB', model: 'text-model' },
  }));
  assert.equal(section.text({ agent }), '', '纯文本模型不应注入能力段落');

  const handler = harness.listeners.get('llm/stream')?.[0];
  const options = { provider: 'provB', model: 'text-model', messages: [imageMessage()] };
  const { passedOptions } = await runStreamHandler(handler, options);
  assert.ok(passedOptions, '纯文本模型应按下游改写后的消息继续');
  assert.equal(passedOptions.messages[0].content[0].type, 'text');
  assert.match(passedOptions.messages[0].content[0].text, /image_scan/);
});

test('apply()：native_vision_auto=false 时完全回退（不注入、仍降级）', async () => {
  resetVisionCapabilityState();
  const harness = makeHarness({
    providers: ['provA'],
    adapters: {
      provA: { models: [IMAGE_MODEL], adapter: { listModels: async () => [IMAGE_MODEL] } },
    },
    config: { native_vision_auto: false, multimodal_models: '', bridge_export_dir: join(tmpdir(), 'picturereader-test-bridge') },
  });
  apply(harness.ctx, {});
  await new Promise((resolve) => setTimeout(resolve, 20));

  const section = harness.sections.find((entry) => entry.name === 'picturereader:image-capability');
  const agent = {};
  assert.equal(section.text({ agent }), '', '开关关闭时不应注入');

  const handler = harness.listeners.get('llm/stream')?.[0];
  const options = { provider: 'provA', model: 'vision-model', messages: [imageMessage()] };
  const { passedOptions } = await runStreamHandler(handler, options);
  assert.ok(passedOptions, '开关关闭时回退到旧行为（按白名单判定 → 仍降级）');
  assert.equal(passedOptions.messages[0].content[0].type, 'text');
});
