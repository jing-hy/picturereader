# picturereader

> DSH 插件（`dsh-plugin`）— 给纯文本模型（如 deepseek-v4-flash）的"读图"能力。
> 把图片**降分辨率 + 降色深 + 结构/色彩指纹提取**，渲染成文本网格喂回对话，
> 让模型像多模态模型一样"看"图：描述场景、主体、环境、光线与语义内容。
> **纯本地、零外部模型依赖、零 API key、零 Python（PaddleOCR 为可选增强）**。

[![dsh-plugin](https://awesome-dsh-plugin.com/badge.svg)](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)

## 这是什么

DeepSeek 等纯文本模型没有视觉编码器，无法直接看图。picturereader 把"看图"翻译成
模型能理解的**结构化文本证据**，并提供一套经过大量真实图片迭代验证的**读图方法论
skill（image-reading）**，让模型像人一样分步看图：

1. **全局定调**：hue families（纯色相指纹）→ structure（条带/对称）→ texture（写实度）→ regions（色块结构）
2. **主动找主体**：px_per_cell 定向放大（深色/低对比/小色块不会漏）
3. **文字验证**：PaddleOCR 实读（防多模态幻觉）
4. **材质判断**：image_sample 像素取样
5. **综合描述**：带证据等级的连贯画面描述

## 工具

| 工具 | 作用 |
|---|---|
| `image_scan` | 全局/区域扫描：亮度/颜色网格 + regions 色块 + shade diversity + texture mix + structure（条带/对称）+ **像素级 colors** + **hue families 纯色相指纹**；支持 `focus`/`region` 局部放大、`px_per_cell` 像素密度定向放大 |
| `image_ocr` | 文字识别双引擎：`windows`（内置，默认）/ `paddle`（选装，发光/弯曲/游戏字远强），失败自动降级不崩溃 |
| `image_sample` | 8×8 精确像素取样，判断材质/纹理（金属/木纹/织物/皮肤/雾） |

### 读图方法论 skill（image-reading）

`skills/image-reading.md` 是一套**经大量真实图片场景迭代验证**的读图方法论
（按 experience / skill / principle / insight 分层，教训有据可依、找主导模式），
安装后模型自动掌握：
- **hue 场景指纹**：cyan 高=水/雾/湖泊，green 高=森林，orange/red 高=暖色人物/火光，
  blue 高=夜晚科幻，achromatic+rough=废墟，green+yellow=翠绿能量/浮空仙境
- **多模态模型校验规则**：游戏名/品牌等文字必须 OCR 实读（多模态模型会猜错）；
  发光元素颜色以 hue 实测为准（多模态模型对发光色的描述系统性不可靠）
- **主动验证**：低对比主体（暗色人物/小色块）必须放大确认

## 安装

```sh
# 1. 插件
dsh plugin --profile web add picturereader        # 或从源码: dsh plugin --profile web add .
dsh plugin --profile headless add picturereader

# 2. 读图方法论 skill（推荐）
copy skills\image-reading.md %USERPROFILE%\.dsh\skills\   # Windows
# macOS/Linux: cp skills/image-reading.md ~/.dsh/skills/

# 3.（可选）PaddleOCR 增强引擎：node scripts/setup-ocr.mjs
```

重启 DSH Desktop 后，模型工具列表出现 `image_scan` / `image_ocr` / `image_sample`，
技能目录出现 `image-reading`。

## 使用

直接对模型说：

> 用 image_scan 看一下 <路径> 这张图，细看感兴趣的部分

模型会加载 `image-reading` 方法论自动执行完整流程（定调 → 找主体 → 验证 → 描述）。

## 输出示例

```
image: chart.png (600x400 -> 32x21 cells, ~18.8x19px per cell, region=full, palette=full, mode=color)
shade diversity: 10 distinct shades | texture: smooth 24.2%, medium 19.3%, rough 56.5%
structure: 6 vertical stripes (4 alternating colors) at cols 4..7; left-right symmetry 45%
hue families: cyan 88.2%, green 4.5%, yellow 1%          ← 真实主调（colors 灰白占比是假象）
regions: ...（色块结构）
colors by area: ...（像素级真实占比）
luminance grid / color grid
```

## 开发

```sh
npm install
npm test            # node:test，76 个测试全绿
node scripts/setup-ocr.mjs   # 可选：装 PaddleOCR
node scripts/preview.mjs     # 生成 fixtures 并预览渲染
```

**热插拔**：DSH 本身不支持代码热重载，但本插件自带执行层热加载——业务逻辑全在
`src/core.js` 单文件，工具每次执行按 mtime 动态加载（cache-bust），**改 core.js
下次调用即生效**；工具定义（schema/描述）改动需重启桌面端。

## 优势

- **零外部模型依赖**：核心链路（扫描/取样/解码）纯本地纯 JS，不调任何视觉 API；
  语义理解完全交给主模型（DeepSeek），不依赖 YOLO 等固定类别检测器（遇未知物体不失效）
- **可追溯、可验证**：每个结论都有数据支撑（hue 占比、色块坐标、OCR 文本+置信度），
  能主动识别并纠正多模态模型的幻觉（游戏名乱猜、发光颜色误标、小字脑补）
- **隐私友好**：原始图片不出本机，只有降采样文本进模型上下文
- **成本低**：一次扫描 ≈0.6–2.2K tokens；PaddleOCR 本地跑，无 API 费用
- **可选增强**：PaddleOCR 一键安装（`scripts/setup-ocr.mjs`），缺失自动降级不崩溃
- **方法论沉淀**：附带的 image-reading skill 把读图经验固化（场景指纹/校验规则），
  模型每次看图都带着经过大量图片验证的经验

## 局限性（重要）

- **不是真正的视觉模型**：文本网格信息量有限，**人脸/表情/花纹等像素级细节读不出**；
  这是文本模态的硬上限，放大（px_per_cell）只能缩小差距，不能消除
- **语义推断依赖主模型能力**：物体识别（"这是树/空间站"）是 LLM 基于结构证据的推测，
  不是视觉模型的确证——复杂/罕见物体可能推断错误
- **OCR 引擎边界**：Windows OCR 对发光/弯曲/艺术字失效；PaddleOCR 强很多但需选装，
  且对极小文字/极端艺术字仍可能失败（可配合放大）
- **性能**：4K 图解码 ~230ms；PaddleOCR 每次调用需 ~2s 加载模型；大图网格渲染
  token 随 size 增长（64×64 color ≈ 3–5K tokens）
- **WebP 不支持**（提示转 PNG/JPEG）；GIF 只读首帧
- **多模态模型的描述不可全信**（本插件可交叉验证，但最终语义仍需人工判断关键场景）

## License

MIT

---

**DSH 插件生态**：GitHub topic `dsh-plugin` 会被 [dsh-plugin-marketplace](https://github.com/AwesomeHou/dsh-plugin-marketplace)
自动同步识别；精选列表见 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)。
