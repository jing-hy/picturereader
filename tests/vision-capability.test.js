/**
 * picturereader 模型视觉能力判定单测（src/vision-capability.js）。
 *
 * 覆盖：三态判定（native / text-only / unknown）与内核 inputModalities 语义
 * 一致、能力缓存与补种、agent 级当前模型跟踪、白名单覆盖、提示词文案（原生
 * 识图时"不建议 image_scan，但 image_ocr 照用"；其余三态不注入）。
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  VERDICTS,
  CAPABILITY_SECTION_NAME,
  CAPABILITY_SECTION_ORDER,
  verdictFromModalities,
  modelKey,
  setCapability,
  capabilityOf,
  capabilityCount,
  clearCapabilities,
  resetVisionCapabilityState,
  seedCapabilityFromAdapter,
  noteAgentModel,
  agentModel,
  noteActiveModel,
  activeModel,
  resolveActiveModel,
  parseWhitelist,
  isDeclaredNative,
  hintText,
  capabilitySectionText,
} from '../src/vision-capability.js';

beforeEach(() => {
  resetVisionCapabilityState();
});

test('verdictFromModalities：三态语义与内核一致', () => {
  assert.equal(verdictFromModalities(['text', 'image']), VERDICTS.native);
  assert.equal(verdictFromModalities(['image']), VERDICTS.native);
  // 显式不含 image = 负向能力（negative capability）
  assert.equal(verdictFromModalities(['text']), VERDICTS.textOnly);
  assert.equal(verdictFromModalities([]), VERDICTS.textOnly);
  // 缺失/非法 = 未知
  assert.equal(verdictFromModalities(undefined), VERDICTS.unknown);
  assert.equal(verdictFromModalities(null), VERDICTS.unknown);
  assert.equal(verdictFromModalities('image'), VERDICTS.unknown);
});

test('modelKey / 能力缓存读写', () => {
  assert.equal(modelKey('deepseek', 'v4'), 'deepseek/v4');
  assert.equal(capabilityOf('deepseek', 'v4'), undefined);
  setCapability('deepseek', 'v4', VERDICTS.textOnly, 'test');
  assert.equal(capabilityOf('deepseek', 'v4'), VERDICTS.textOnly);
  assert.equal(capabilityCount(), 1);
  // 同名模型不同 provider 互不干扰
  assert.equal(capabilityOf('other', 'v4'), undefined);
  clearCapabilities();
  assert.equal(capabilityOf('deepseek', 'v4'), undefined);
  assert.equal(capabilityCount(), 0);
});

test('seedCapabilityFromAdapter：resolveModel 路径', async () => {
  const adapter = {
    resolveModel: async (provider, model) => ({
      provider, id: model, name: model, inputModalities: ['text', 'image'],
    }),
  };
  assert.equal(await seedCapabilityFromAdapter(adapter, 'prov', 'vision-model'), VERDICTS.native);
  assert.equal(capabilityOf('prov', 'vision-model'), VERDICTS.native);
});

test('seedCapabilityFromAdapter：listModels 回退路径', async () => {
  const adapter = {
    listModels: async (provider) => [
      { provider, id: 'text-model', name: 'text-model', inputModalities: ['text'] },
      { provider, id: 'vision-model', name: 'vision-model', inputModalities: ['text', 'image'] },
    ],
  };
  assert.equal(await seedCapabilityFromAdapter(adapter, 'prov', 'vision-model'), VERDICTS.native);
  assert.equal(await seedCapabilityFromAdapter(adapter, 'prov', 'text-model'), VERDICTS.textOnly);
  // 列表里没有的模型 → 未知
  assert.equal(await seedCapabilityFromAdapter(adapter, 'prov', 'ghost'), VERDICTS.unknown);
});

test('seedCapabilityFromAdapter：无 adapter / 抛错都退化为未知且不抛', async () => {
  assert.equal(await seedCapabilityFromAdapter(null, 'prov', 'm'), VERDICTS.unknown);
  assert.equal(await seedCapabilityFromAdapter(undefined, 'prov', 'm'), VERDICTS.unknown);
  const broken = { resolveModel: async () => { throw new Error('boom'); } };
  assert.equal(await seedCapabilityFromAdapter(broken, 'prov', 'm'), VERDICTS.unknown);
  assert.equal(capabilityOf('prov', 'm'), VERDICTS.unknown);
});

test('当前模型跟踪：agent 级缓存优先于进程级兜底，再退到 agent.options', () => {
  const agentA = {};
  const agentB = { options: { provider: 'opt-prov', model: 'opt-model' } };

  // 只有 agent.options 时用 options
  assert.deepEqual(resolveActiveModel(agentB, agentB.options), { provider: 'opt-prov', model: 'opt-model' });
  // 进程级兜底优先于 options
  noteActiveModel('sink-prov', 'sink-model');
  assert.equal(activeModel().model, 'sink-model');
  assert.deepEqual(resolveActiveModel(agentB, agentB.options), { provider: 'sink-prov', model: 'sink-model' });
  // agent 级优先于进程级
  noteAgentModel(agentA, 'agent-prov', 'agent-model');
  assert.deepEqual(agentModel(agentA), { provider: 'agent-prov', model: 'agent-model', at: agentModel(agentA).at });
  assert.deepEqual(resolveActiveModel(agentA, undefined), { provider: 'agent-prov', model: 'agent-model' });
  // 另一个 agent 不受影响
  assert.deepEqual(resolveActiveModel(agentB, agentB.options), { provider: 'sink-prov', model: 'sink-model' });
  // 无任何信息（重置进程级状态后）
  resetVisionCapabilityState();
  assert.equal(activeModel(), undefined);
  assert.equal(resolveActiveModel({}, undefined), undefined);
});

test('parseWhitelist：逗号分隔 + 去空白 + 去空项', () => {
  assert.deepEqual(parseWhitelist('a, b ,,c'), ['a', 'b', 'c']);
  assert.deepEqual(parseWhitelist(''), []);
  assert.deepEqual(parseWhitelist(undefined), []);
});

test('isDeclaredNative：元数据 native 或白名单声明', () => {
  setCapability('p', 'native-model', VERDICTS.native);
  setCapability('p', 'text-model', VERDICTS.textOnly);
  assert.equal(isDeclaredNative('p', 'native-model'), true);
  assert.equal(isDeclaredNative('p', 'text-model'), false);
  // 白名单人工覆盖（含元数据缺失的 unknown）
  assert.equal(isDeclaredNative('p', 'text-model', ['text-model']), true);
  assert.equal(isDeclaredNative('p', 'unscanned', ['unscanned']), true);
  assert.equal(isDeclaredNative('p', 'unscanned'), false);
});

test('hintText：原生识图才注入，且明确"不用 scan、ocr 照用"', () => {
  const text = hintText(VERDICTS.native, { model: 'gpt-4o' });
  assert.match(text, /原生支持图像输入/);
  assert.match(text, /gpt-4o/);
  assert.match(text, /不要/);
  assert.match(text, /image_scan/);
  assert.match(text, /image_sample/);
  assert.match(text, /image_ocr/);
  assert.match(text, /仍应正常使用/);
  assert.match(text, /image-reading/);
  // 其余两态不注入
  assert.equal(hintText(VERDICTS.textOnly, { model: 'x' }), '');
  assert.equal(hintText(VERDICTS.unknown, { model: 'x' }), '');
});

test('capabilitySectionText：native 注入 / text-only 与 unknown 不注入 / 开关可关', () => {
  const agent = {};
  noteAgentModel(agent, 'prov', 'vision-model');
  setCapability('prov', 'vision-model', VERDICTS.native);
  assert.match(capabilitySectionText(agent, undefined, {}), /原生支持图像输入/);
  // 开关关闭 → 完全回退
  assert.equal(capabilitySectionText(agent, undefined, { native_vision_auto: false }), '');

  const textAgent = {};
  noteAgentModel(textAgent, 'prov', 'text-model');
  setCapability('prov', 'text-model', VERDICTS.textOnly);
  assert.equal(capabilitySectionText(textAgent, undefined, {}), '');
  // 但用户白名单显式声明时按原生识图处理
  assert.match(capabilitySectionText(textAgent, undefined, { multimodal_models: 'text-model' }), /原生支持图像输入/);

  const unknownAgent = {};
  noteAgentModel(unknownAgent, 'prov', 'ghost-model');
  assert.equal(capabilitySectionText(unknownAgent, undefined, {}), '');
  assert.equal(capabilitySectionText(undefined, undefined, {}), '');
});

test('capabilitySectionText：section 名与 order 稳定（3 个常量不得漂移）', () => {
  assert.equal(CAPABILITY_SECTION_NAME, 'picturereader:image-capability');
  assert.equal(CAPABILITY_SECTION_ORDER, 3000);
});
