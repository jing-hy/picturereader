/**
 * picturereader 三模式 / 配置 / 运行时 / 图片桥 单测。
 * 覆盖 privacy(隐私)/smart(智能)/strict(严谨) 的路由语义与硬 gate。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';

import {
  MODES, normalizeMode, vlmAllowed, isPrivacy, visionAnalyzeDefaults, routePolicyText, routeModeTag,
} from '../src/routing.js';
import { modeOf, vlmConfigOf, ocrEngineOf, resolveVlmApiKey, MODE_KEYS, OCR_ENGINE_KEYS } from '../src/config.js';
import { setRuntimeConfig, setRuntimeSource, getRuntimeConfig, currentMode, vlmAllowedByRuntime } from '../src/runtime.js';
import { hasImageBlock, hasShaAttachmentReference, deepFreeze, bridgeMessages } from '../src/bridge.js';

test('normalizeMode 容错', () => {
  assert.equal(normalizeMode('privacy'), 'privacy');
  assert.equal(normalizeMode('smart'), 'smart');
  assert.equal(normalizeMode('strict'), 'strict');
  assert.equal(normalizeMode(''), 'smart');
  assert.equal(normalizeMode(undefined), 'smart');
  assert.equal(normalizeMode('bogus'), 'smart');
  assert.equal(normalizeMode('  PRIVACY  '), 'smart'); // 大小写/空白不匹配
});

test('vlmAllowed：隐私禁用，其余启用', () => {
  assert.equal(vlmAllowed('privacy'), false);
  assert.equal(vlmAllowed('smart'), true);
  assert.equal(vlmAllowed('strict'), true);
  assert.equal(isPrivacy('privacy'), true);
  assert.equal(isPrivacy('smart'), false);
});

test('visionAnalyzeDefaults 三种模式', () => {
  const privacy = visionAnalyzeDefaults('privacy');
  assert.equal(privacy.includeVlm, false, '隐私模式 VLM 必须禁用');
  assert.equal(privacy.includeScan, true);
  const smart = visionAnalyzeDefaults('smart');
  assert.equal(smart.includeVlm, true);
  assert.equal(smart.includeScan, true);
  const strict = visionAnalyzeDefaults('strict');
  assert.equal(strict.includeVlm, true);
  assert.equal(strict.includeOcr, true);
});

test('routePolicyText 包含模式策略关键词', () => {
  assert.match(routePolicyText('privacy'), /绝不调用任何外部视觉 API/);
  assert.match(routePolicyText('privacy'), /本地工具/);
  assert.match(routePolicyText('smart'), /image_scan/);
  assert.match(routePolicyText('smart'), /减少调用轮数/);
  assert.match(routePolicyText('strict'), /交叉验证/);
  assert.match(routeModeTag('privacy'), /隐私模式/);
});

test('config.modeOf / vlmConfigOf / ocrEngineOf', () => {
  assert.equal(modeOf({ mode: 'strict' }), 'strict');
  assert.equal(modeOf({ mode: 'nope' }), 'smart');
  const vlm = vlmConfigOf({ vlm_base: 'http://x', vlm_model: 'm', vlm_key: 'k', vlm_key_env: 'E' });
  assert.deepEqual(vlm, { baseUrl: 'http://x', model: 'm', apiKey: 'k', apiKeyEnv: 'E' });
  assert.equal(ocrEngineOf({ ocr_engine: 'rapid' }), 'rapid');
  assert.equal(ocrEngineOf({}), 'windows');
  assert.equal(ocrEngineOf({ ocr_engine: 'x' }), 'windows');
});

test('resolveVlmApiKey：优先 apiKey，其次环境变量', () => {
  process.env.__PR_TEST_KEY__ = 'from-env';
  try {
    assert.equal(resolveVlmApiKey({ apiKey: 'direct' }), 'direct');
    assert.equal(resolveVlmApiKey({ apiKey: '', apiKeyEnv: '__PR_TEST_KEY__' }), 'from-env');
    assert.equal(resolveVlmApiKey({}), '');
  } finally {
    delete process.env.__PR_TEST_KEY__;
  }
});

test('runtime：setRuntimeConfig 与 mode gate', () => {
  setRuntimeConfig({ mode: 'privacy', vlm: { baseUrl: 'http://ext', model: 'm', apiKey: 'k' } });
  assert.equal(currentMode(), 'privacy');
  assert.equal(vlmAllowedByRuntime(), false);
  assert.equal(getRuntimeConfig().mode, 'privacy');
});

test('runtime：setRuntimeSource 惰性刷新', () => {
  let cfg = { mode: 'smart', vlm_base: 'http://a', vlm_key: 'ka' };
  setRuntimeSource(() => cfg);
  assert.equal(currentMode(), 'smart');
  assert.equal(getRuntimeConfig().vlm.baseUrl, 'http://a');
  cfg = { mode: 'privacy', vlm_base: 'http://b' };
  assert.equal(currentMode(), 'privacy', '改源后应热更');
  assert.equal(getRuntimeConfig().vlm.baseUrl, 'http://b');
  setRuntimeSource(null);
});

test('vlm privacy 硬 gate：即使配了外部 API 也返回 false', async () => {
  const { isVlmConfigured } = await import('../src/vlm.js');
  setRuntimeConfig({ mode: 'privacy', vlm: { baseUrl: 'http://127.0.0.1:9999/v1', model: 'm', apiKey: 'k' } });
  assert.equal(isVlmConfigured(), false, '隐私模式下配置了外部 API 也不可用');
  setRuntimeConfig({ mode: 'smart', vlm: { baseUrl: '', model: '', apiKey: '' } });
});

test('bridge.hasImageBlock / deepFreeze', () => {
  const msg = { role: 'user', content: [{ type: 'image', attachment: { attachmentId: 'a' } }] };
  assert.equal(hasImageBlock([msg]), true);
  assert.equal(hasImageBlock([{ role: 'user', content: [{ type: 'text', text: 'x' }] }]), false);
  const frozen = deepFreeze({ content: [{ type: 'text', text: 'y' }] });
  assert.equal(Object.isFrozen(frozen), true);
});

test('bridgeMessages：图片消息降级为本地工具引导（隐私模式）', async () => {
  setRuntimeConfig({ mode: 'privacy' });
  const dir = await mkdtemp(join(tmpdir(), 'pr-test-'));
  const attachment = { attachmentId: 'abc123', mediaType: 'image/png', name: 'shot.png' };
  const ctx = {
    attachments: { readImage: async () => ({ data: Buffer.from([1, 2, 3]) }) },
  };
  const messages = [
    { role: 'user', content: [
      { type: 'text', text: '请看' },
      { type: 'image', attachment },
    ] },
    { role: 'user', content: [{ type: 'text', text: '单独文本' }] },
  ];
  try {
    const out = await bridgeMessages(messages, ctx, dir);
    assert.equal(out.length, 2);
    const bridged = out[0];
    assert.notEqual(bridged, messages[0], '图片消息应换成新对象');
    // 第二个文本消息应保持引用不变
    assert.equal(out[1], messages[1]);
    const textBlocks = bridged.content.filter((b) => b.type === 'text');
    assert.ok(textBlocks.some((b) => b.text.includes('隐私模式')), '含模式标签');
    assert.ok(textBlocks.some((b) => b.text.includes('绝不调用任何外部视觉 API')), '隐私策略注入');
    assert.ok(textBlocks.some((b) => b.text.includes('.png')), '导出路径写出');
  } finally {
    await rm(dir, { recursive: true, force: true });
    setRuntimeConfig({ mode: 'smart' });
  }
});

test('bridgeMessages：smart 模式 hint 不含隐私限制但含智能策略', async () => {
  setRuntimeConfig({ mode: 'smart' });
  const dir = await mkdtemp(join(tmpdir(), 'pr-test2-'));
  const ctx = { attachments: { readImage: async () => ({ data: Buffer.from([9]) }) } };
  const messages = [{ role: 'user', content: [{ type: 'image', attachment: { attachmentId: 'xyz', mediaType: 'image/jpeg', name: null } }] }];
  try {
    const [out] = await bridgeMessages(messages, ctx, dir);
    const text = out.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
    assert.ok(!text.includes('绝不调用任何外部视觉 API'));
    assert.match(text, /智能模式/);
    assert.match(text, /image_scan/);
  } finally {
    await rm(dir, { recursive: true, force: true });
    setRuntimeConfig({ mode: 'smart' });
  }
});

test('导出常量完整性', () => {
  assert.ok(MODE_KEYS.includes('privacy'));
  assert.ok(OCR_ENGINE_KEYS.includes('rapid'));
  assert.ok(Object.keys(MODES).length >= 3);
});

test('vlm_enabled 选配：未勾选 → 外部 VLM 不可用', async () => {
  const { isVlmConfigured } = await import('../src/vlm.js');
  // 未启用（显式 false）即使配了端点/Key 也不可用
  setRuntimeConfig({ mode: 'smart', vlm_enabled: false, vlm_base: 'http://ext/v1', vlm_key: 'k' });
  assert.equal(isVlmConfigured(), false, '未勾选举配 → 外部 VLM 禁用');
  // 勾选启用 → 可用（端点与 Key 齐备）
  setRuntimeConfig({ mode: 'smart', vlm_enabled: true, vlm_base: 'http://ext/v1', vlm_key: 'k' });
  assert.equal(isVlmConfigured(), true, '勾选举配 + 端点/Key 齐 → 可用');
  // 向后兼容：扁平 config 手写 vlm_base（未给 vlm_enabled）视为启用
  setRuntimeConfig({ mode: 'smart', vlm_base: 'http://ext/v1', vlm_key: 'k' });
  assert.equal(isVlmConfigured(), true, '手写 vlm_base 未给 enabled → 视为启用');
  setRuntimeConfig({ mode: 'smart', vlm: { baseUrl: '', model: '', apiKey: '' } });
});

test('bridgeMessages：SHA 降级提示从附件对象库导出 PNG 并注入工具引导', async () => {
  setRuntimeConfig({ mode: 'smart' });
  const root = await mkdtemp(join(tmpdir(), 'pr-objects-'));
  const dir = await mkdtemp(join(tmpdir(), 'pr-bridge-'));
  const hash = 'df7f126dcfac220d8eaeb99173f98f9383445eca3f2e9c6dd4dffb86e9273a86';
  const objectDir = join(root, hash.slice(0, 2));
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  const messages = [{
    role: 'user',
    content: [{ type: 'text', text: '[image omitted because this model accepts text only; attachment sha256:df7f126d]' }],
  }];
  try {
    await mkdir(objectDir, { recursive: true });
    await writeFile(join(objectDir, hash), png);
    assert.equal(hasShaAttachmentReference(messages), true);
    const [out] = await bridgeMessages(messages, {}, dir, { attachmentObjectsDir: root });
    assert.notEqual(out, messages[0], 'SHA 附件消息应替换为新对象');
    const text = out.content[0].text;
    assert.match(text, /image_scan/);
    assert.match(text, /attachment_df7f126dcfac\.png/);
    const exported = join(dir, 'attachment_df7f126dcfac.png');
    assert.deepEqual(await readFile(exported), png, '应写出原始图片字节');
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
    setRuntimeConfig({ mode: 'smart' });
  }
});

test('bridgeMessages：无效或有歧义的 SHA 提示保持原始文本', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pr-objects-'));
  const dir = await mkdtemp(join(tmpdir(), 'pr-bridge-'));
  const text = '[image omitted because this model accepts text only; attachment sha256:df7f126d]';
  const messages = [{ role: 'user', content: [{ type: 'text', text }] }];
  try {
    const [out] = await bridgeMessages(messages, {}, dir, { attachmentObjectsDir: root });
    assert.equal(out, messages[0]);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
  }
});
