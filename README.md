# picturereader

> 给纯文本模型（如 deepseek-v4-flash）的"读图"能力——**双版本发布**：
> - **DSH 版**：DeepSeek Harness 插件（`dsh-plugin`，含 DSH EAC 桌面端）
> - **ZCode 版**：ZCode 桌面端插件（`zcode-plugin`，经 MCP 暴露工具）

> 把图片 **降分辨率 + 降色深 + 结构/色彩指纹提取**，渲染成文本网格喂回对话，
> 让模型像多模态模型一样"看"图：描述场景、主体、环境、光线与语义内容。
> **纯本地、零外部模型依赖、零 API key、零 Python（PaddleOCR 为可选增强）**。

[![dsh-plugin](https://awesome-dsh-plugin.com/badge.svg)](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)

## 版本总览

| 版本 | 平台 | 形态 | 源码 | 安装 |
|---|---|---|---|---|
| **DSH 版** | DeepSeek Harness（含 EAC 桌面端） | npm 插件（`dsh.bundle`） | 仓库根目录 | `dsh plugin --profile web add picturereader` |
| **ZCode 版** | ZCode 桌面端 | 本地 marketplace 插件（MCP server + skill） | [jing-hy/picturereader-zcode](https://github.com/jing-hy/picturereader-zcode)（独立仓库） | 见其 README |

两个版本共用同一套业务核心（`src/core.js`）与读图方法论 skill（`image-reading`），
三个工具行为完全一致：`image_scan` / `image_ocr` / `image_sample`。

> **ZCode 版性能说明**：ZCode 版通过 MCP（stdio 子进程）暴露工具，每次调用都要
> 经历进程通信与序列化开销，**速度明显慢于 DSH 版**（DSH 版为插件内直接调用）。
> 高频看图、批量看图任务请优先使用 DSH 版；ZCode 版适合轻量、偶发看图。

## 这是什么

DeepSeek 等纯文本模型没有视觉编码器，无法直接看图。picturereader 把"看图"翻译成**模型能理解的结构化文本证据**，并提供一套经过大量真实图片迭代验证的**读图方法论 skill（image-reading）**，让模型像人一样分步看图：

1. **全局定调**：hue families（纯色指纹）→ structure（条纹/对称）→ texture（写实度）→ regions（色块结构）
2. **主动找主体**：px_per_cell 定向放大（深色/低对比/小色块不会漏）
3. **文字验证**：PaddleOCR 实读（防多模态幻觉）
4. **材质判断**：image_sample 像素取样
5. **综合描述**：带证据等级的连贯画面描述

## 工具

| 工具 | 作用 |
|---|---|
| `image_scan` | 全局/区域扫描：亮度/颜色网格 + regions 色块 + shade diversity + texture mix + structure（条纹/对称） + **像素级 colors** + **hue families 纯色指纹**；支持 `focus`/`region` 局部放大、`px_per_cell` 像素密度定向放大 |
| `image_ocr` | 文字识别双引擎：`windows`（内置，默认）/ `paddle`（选装，发光/弯曲/游戏字更强），失败自动降级不崩溃 |
| `image_sample` | 8×8 精确像素取样，判断材质/纹理（金属/木纹/织物/皮肤/噪点） |

### 读图方法论 skill（image-reading）

`skills/image-reading.md`（DSH 版）/ `skills/image-reading/SKILL.md`（ZCode 版）是一套**经大量真实图片场景迭代验证**的读图方法论
（按 experience / skill / principle / insight 分层，教训有据可依、找得到主模型模式），
安装后模型自动掌握：
- **hue 场景指纹**：cyan 高=水/雾/湖泊，green 高=森林，orange/red 高=暖色人物/火光，blue 高=夜空科幻，achromatic+rough=废墟，green+yellow=翠绿能量/浮空仙境
- **多模态模型校验规则**：游戏名/品牌等文字必须 OCR 实读（多模态模型会猜错）；发光元素颜色以 hue 实测为准（多模态模型对发光色的描述系统性不可靠）；低对比主体（暗色人物/小色块）必须放大确认
- **主动验证**：低对比主体（暗色人物/小色块）必须放大确认

## 安装

### DSH 版

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

### ZCode 版

ZCode 版是**独立仓库**：[jing-hy/picturereader-zcode](https://github.com/jing-hy/picturereader-zcode)。

ZCode 版通过 **MCP server**（`mcp/server.js`，stdio）把三个工具暴露给 ZCode，
读图方法论作为 **skill**（`skills/image-reading/`）随插件分发，业务逻辑 `src/core.js`
与本仓库完全一致。安装与使用请见其 README。

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

## 环境变量（ZCode 版）

| 变量 | 默认值 | 作用 |
|---|---|---|
| `DSH_PADDLE_PYTHON` | `C:\Users\Administrator\paddle_venv\Scripts\python.exe` | PaddleOCR 解释器路径（与原插件同名，便于直接迁移） |
| `DSH_PADDLE_CACHE` | `<插件目录>\.paddlex-cache` | PaddleX 模型缓存目录 |

## 开发

```sh
# DSH 版（本仓库）
npm install
npm test            # node:test，76 个测试全绿
node scripts/setup-ocr.mjs   # 可选：装 PaddleOCR
node scripts/preview.mjs     # 生成 fixtures 并预览渲染

# ZCode 版（独立仓库 jing-hy/picturereader-zcode）
git clone https://github.com/jing-hy/picturereader-zcode.git
cd picturereader-zcode
npm install
npm test            # node:test
node scripts/setup-ocr.mjs   # 可选
```

**热插拔（DSH 版）**：DSH 本身不支持代码热重载，但本插件自带执行层热加载——业务逻辑全在
`src/core.js` 单文件，工具每次执行按 mtime 动态加载（cache-bust），**改 core.js
下次调用即生效**；工具定义（schema/描述）改动需重启桌面端。

**热插拔（ZCode 版）**：MCP server 从所选目录运行，改 `src/core.js` 下次调用即生效
（详见 picturereader-zcode 仓库 README）。

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
- **ZCode 版 MCP 开销**：ZCode 版工具经 MCP stdio 子进程通信，单次调用比 DSH 版慢
  （进程启动 + JSON-RPC 序列化）；高频/批量看图建议用 DSH 版
- **WebP 不支持**（提示转 PNG/JPEG）；GIF 只读首帧
- **多模态模型的描述不可全信**（本插件可交叉验证，但最终语义仍需人工判断关键场景）

## License

MIT
