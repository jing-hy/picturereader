/**
 * picturereader — pixel-to-text image reading for text-only ZCode models.
 *
 * One plugin row registers a full local image-understanding toolset plus an
 * optional external vision API bridge, governed by the user's chosen usage
 * mode（privacy / smart / strict）：
 *
 *  - 隐私模式（privacy）：绝不调用外部 API，全走本地工具。
 *  - 智能模式（smart）：先简单看图再决定是否外呼，省轮数/时间。
 *  - 严谨模式（strict）：自行选择 + 必要时交叉验证细节。
 *
 * Tools registered:
 *  image_scan / image_ocr / image_sample      — 本地像素理解（原有）
 *  image_crop / image_palette / image_compare — 本地工具链扩充
 *  image_batch                                — 批量规模/上下文验证
 *  vision_analyze                             — 统一图像理解（按模式路由）
 *  document_to_image                          — 文档(pdf/word/excel/ppt)转图片
 *
 * @module picturereader
 */

import { createImageScanTool, createImageOcrTool, createImageSampleTool } from './tool.js';
import { createVisionAnalyzeTool } from './vision-analyze.js';
import { createImageCropTool, createImagePaletteTool, createImageCompareTool } from './more-tools.js';
import { createImageBatchTool } from './image-batch.js';
import { createDocumentToImageTool } from './doc-tools.js';
import { setRuntimeConfig } from './runtime.js';

export const name = 'picturereader';

/** Services required at runtime: the tool registry and the filesystem seam. */
export const inject = ['tools', 'fs'];

export function apply(ctx, config) {
  // ── 运行时快照：工具执行时惰性读最新 mode / VLM 配置 ──
  setRuntimeConfig(config || {});

  // ── 注册工具 ──
  ctx.effect(() => {
    ctx.tools.register(createImageScanTool(ctx));
    ctx.tools.register(createImageOcrTool(ctx));
    ctx.tools.register(createImageSampleTool(ctx));
    ctx.tools.register(createVisionAnalyzeTool(ctx));
    ctx.tools.register(createImageCropTool(ctx));
    ctx.tools.register(createImagePaletteTool(ctx));
    ctx.tools.register(createImageCompareTool(ctx));
    ctx.tools.register(createImageBatchTool(ctx));
    ctx.tools.register(createDocumentToImageTool(ctx));
  });
}
