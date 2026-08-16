# picturereader（ZCode 版）

> ZCode 插件（`zcode-plugin`）— 给纯文本模型（如 deepseek-v4-flash）的"读图"能力。
> 把图片**降分辨率 + 降色深 + 结构/色彩指纹提取**，渲染成文本网格喂回对话，
> 让模型像多模态模型一样"看"图：描述场景、主体、环境、光线与语义内容。
> **纯本地、零外部模型依赖、零 API key、零 Python（PaddleOCR 为可选增强）**。

本仓库是原 [picturereader](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) DSH 插件的 ZCode 移植版：
三个工具通过 **MCP server**（`mcp/server.js`，stdio）暴露给 ZCode，读图方法论作为
**skill**（`skills/image-reading/`）随插件分发。业务逻辑 `src/core.js` 与源插件完全一致。

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

`skills/image-reading/SKILL.md` 是一套**经大量真实图片场景迭代验证**的读图方法论
（按 experience / skill / principle / insight 分层，教训有据可依、找主导模式），
安装后模型自动掌握：
- **hue 场景指纹**：cyan 高=水/雾/湖泊，green 高=森林，orange/red 高=暖色人物/火光，
  blue 高=夜晚科幻，achromatic+rough=废墟，green+yellow=翠绿能量/浮空仙境
- **多模态模型校验规则**：游戏名/品牌等文字必须 OCR 实读（多模态模型会猜错）；
  发光元素颜色以 hue 实测为准（多模态模型对发光色的描述系统性不可靠）
- **主动验证**：低对比主体（暗色人物/小色块）必须放大确认

## 安装

本目录**同时是一个本地插件市场**（根目录 `marketplace.json` 声明了 `picturereader`
插件，`source: "."` 指向本目录自身），插件自带 `.zcode-plugin/plugin.json` 清单
（声明 `skills` 与 `mcpServers`）。

```sh
# ZCode 桌面端 Settings → Plugin Management → Discover → 「+」→ 本地目录
# 选择 D:\coding\picturereader_zcode → 市场列表出现 picturereader → 安装
```

安装并启用后（重启 ZCode 或按提示重连）：

1. **MCP server `picturereader` 自动连接**（stdio 子进程 `node mcp/server.js`），
   模型工具列表出现 `image_scan` / `image_ocr` / `image_sample`；
2. **skill `image-reading` 自动出现**在技能列表（图片任务自动触发）；
3. **（可选）PaddleOCR 增强引擎**：`node scripts/setup-ocr.mjs`。

**关于安装后的运行位置**：市场安装会把插件目录拷贝到 ZCode 插件缓存
（`~/.zcode/cli/plugins/cache/...`），但 `.zcode-plugin/plugin.json` 里 MCP server
的 `args` 是**具体绝对路径**，指向本目录的 `mcp/server.js`——因此 MCP server 始终
从**本目录**运行：改 `src/core.js` 下次调用即生效（热加载）。skill / 工具定义变更
需在 Discover 里卸载后重装生效（或手动同步缓存副本）。若插件目录移动，请同步更新
`plugin.json` 里的 `args` 路径。

### 路径解析

工具参数 `file_path` 支持绝对路径，也支持相对路径——相对路径以**当前工作区根目录**
为基准解析（插件通过 `PICTUREREADER_CWD` 环境变量从 ZCode 拿到项目根）。

### 可选环境变量

| 变量 | 默认值 | 作用 |
|---|---|---|
| `DSH_PADDLE_PYTHON` | `C:\Users\Administrator\paddle_venv\Scripts\python.exe` | PaddleOCR 解释器路径（与原插件同名，便于直接迁移） |
| `DSH_PADDLE_CACHE` | `<插件目录>\.paddlex-cache` | PaddleX 模型缓存目录 |

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
npm test            # node:test，83 个测试（core 管线 + MCP 协议 + OCR 全链路）
node scripts/setup-ocr.mjs   # 可选：装 PaddleOCR
node scripts/preview.mjs     # 生成 fixtures 并预览渲染
```

**热插拔**：业务逻辑全在 `src/core.js` 单文件，MCP server 每次执行按 mtime 动态
加载（cache-bust，见 `importCore`），**改 core.js 下次调用即生效**；工具定义
（schema/描述）改动需重连 MCP server。

## 移植说明（相对 DSH 原版）

- `ctx.tools.register` 工具注册 → `mcp/server.js` 的 MCP `tools/list` / `tools/call`
- `ctx.fs` / `exec` 文件能力 → 直接 `node:fs` + 工作区根目录路径解析（`resolveImagePath`）
- `cordis.patch.yml` / `src/tool.js`（Cordis 专属）已移除；`src/index.js` 插件入口不再需要
- `skills/image-reading.md` → `skills/image-reading/SKILL.md`（zcode skill 目录格式）
- 工具名、参数、输出格式、错误消息与 DSH 原版完全一致

**注意**：`.zcode-plugin/plugin.json` 的 `mcpServers` 与内置插件一致使用**具体绝对路径**
（`command` = node.exe，`args` = 本目录的 `mcp/server.js`），不依赖变量展开；若把插件目录
移动到别处，需同步更新这两个路径。

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
  token 随 size 增长（64×64 color ≈ 3–5K tokens）。PaddleOCR 引擎输入**自动降采样**
  到长边 ≤1600px（否则 4K 截图识别可达 15–18s，会超过客户端工具超时）；需要精细
  小字时用 `region`/`focus` 裁剪后再 OCR（裁剪后不再降采样）
- **WebP 不支持**（提示转 PNG/JPEG）；GIF 只读首帧
- **多模态模型的描述不可全信**（本插件可交叉验证，但最终语义仍需人工判断关键场景）

## License

MIT
