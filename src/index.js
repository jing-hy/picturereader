/**
 * picturereader — pixel-to-text image reading for text-only DeepSeek Harness
 * models. One plugin row registers the `image_scan` tool: decode the image,
 * downscale it into a coarse cell grid, quantize colors against a small named
 * palette, and feed the rendered grids back into the conversation so DeepSeek
 * can describe layout, colors and rough shapes without a vision model.
 *
 * Mount with one row:
 *
 * ```yaml
 * - id: picturereader
 *   name: 'picturereader'
 * ```
 * @module picturereader
 */

import { createImageScanTool, createImageOcrTool, createImageSampleTool } from './tool.js';

export const name = 'picturereader';

/** Services required at runtime: the tool registry and the filesystem seam. */
export const inject = ['tools', 'fs'];

export function apply(ctx) {
  ctx.effect(() => {
    ctx.tools.register(createImageScanTool(ctx));
    ctx.tools.register(createImageOcrTool(ctx));
    ctx.tools.register(createImageSampleTool(ctx));
  });
}
