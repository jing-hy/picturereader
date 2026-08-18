# picturereader

> **v2.0.0** —— 给纯文本模型（如 deepseek-v4-flash）的**全能"读图"能力**。
> 融合 **独立伪多模态识图** 与 **外部视觉 API 接口**，一个插件搞定全部，**无需另装任何插件**。

> - **DSH 版**：DeepSeek Harness 插件（`dsh-plugin`，含 DSH EAC 桌面端）—— 本分支（main）
> - **ZCode 版**：ZCode 桌面端插件（`zcode-plugin`，经 MCP 暴露工具）—— [zcode 分支](https://github.com/jing-hy/picturereader/tree/zcode)

[![dsh-plugin](https://awesome-dsh-plugin.com/badge.svg)](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)

## 本轮工作（v2.0.0 新增）

在原有的**本地伪多模态识图**（像素扫描 + OCR + 取样，零外部依赖）之上，融合了社区 `dsh-universal-vision` 的优势，形成一套**统一、可交叉验证的完整识图栈**：

1. **新增外部视觉 API 接口**（`vlm.js`）：桥接任意 OpenAI 兼容的视觉端点（本地 llama-server / LM Studio / vLLM / 云端网关），让模型获得真正的**语义理解**能力（场景、角色、界面、风格）。
2. **新增统一分析工具 `vision_analyze`**（`vision-analyze.js`）：一次调用即可取回「低信息拦截 + 像素扫描 + OCR + VLM」多路证据。
3. **新增低信息量拦截**（`guard.js`）：自动识别空白/未渲染/简单图片，避免小 VLM 在空图上幻觉，也节省调用成本。
4. **证据交叉验证**：VLM 描述与像素/OCR 实测冲突时，以实测为准——伪多模态与真 VLM 互为印证，抑制幻觉。
5. **多次提问**：可对同一张图用 `vision_analyze` 以不同 `prompt` 反复提问，从多角度复核同一内容。

> **核心优势一句话**：**独立伪多模态识图（零依赖、可离线） + 外部 API 语义接口（可选、即插即用）** —— 简单图用像素就够，复杂图一键接 VLM，一个插件全包含，不需要再装 `dsh-universal-vision` 或任何其他读图插件。

## 版本总览

| 版本 | 平台 | 形态 | 源码 | 安装 |
|---|---|---|---|---|
| **DSH 版** | DeepSeek Harness（含 EAC 桌面端） | npm 插件（`dsh.bundle`） | 本仓库（main） | `dsh plugin --profile web add picturereader` |
| **ZCode 版** | ZCode 桌面端 | 本地 marketplace 插件（MCP server + skill） | [zcode 分支](https://github.com/jing-hy/picturereader/tree/zcode) | `npm install picturereader-zcode` |

两个版本共用同一套业务核心（`src/core.js`）与读图方法论 skill（`image-reading`），
四个工具行为完全一致：`image_scan` / `image_ocr` / `image_sample` / `vision_analyze`。

> **兼容性**：DSH 版已验证兼容 **DeepSeek Harness EAC 4.2.0** 及 `@deepseek-ai/dsh-client-ui-workspace` **rc.7**（4.2.0 配套的官方工作区插件版本）。

> **ZCode 版性能说明**：ZCode 版通过 MCP（stdio 子进程）暴露工具，每次调用都要
> 经历进程通信与序列化开销，**速度明显慢于 DSH 版**（DSH 版为插件内直接调用）。
> 高频看图、批量看图任务请优先使用 DSH 版；ZCode 版适合轻量、偶发看图。

## 这是什么

DeepSeek 等纯文本模型没有视觉编码器，无法直接看图。picturereader 把"看图"翻译成**模型能理解的结构化文本证据**，并提供一套经过大量真实图片迭代验证的**读图方法论 skill（image-reading）**，让模型像人一样分步看图：

1. **全局定调**：hue families（纯色指纹）→ structure（条纹/对称）→ texture（写实度）→ regions（色块结构）
2. **主动找主体**：px_per_cell 定向放大（深色/低对比/小色块不会漏）
3. **文字验证**：PaddleOCR 实读（防多模态幻觉）
4. **材质判断**：image_sample 像素取样
5. **（可选）VLM 语义理解**：外部视觉 API 提供场景/角色/界面/风格的自然语言描述
6. **综合描述**：带证据等级的连贯画面描述，伪多模态与 VLM 交叉验证

## 工具

| 工具 | 作用 |
|---|---|
| `image_scan` | 全局/区域扫描：亮度/颜色网格 + regions 色块 + shade diversity + texture mix + structure（条纹/对称） + **像素级 colors** + **hue families 纯色指纹**；支持 `focus`/`region` 局部放大、`px_per_cell` 像素密度定向放大 |
| `image_ocr` | 文字识别双引擎：`windows`（内置，默认）/ `paddle`（选装，发光/弯曲/游戏字更强），失败自动降级不崩溃 |
| `image_sample` | 8×8 精确像素取样，判断材质/纹理（金属/木纹/织物/皮肤/噪点） |
| `vision_analyze` | **统一入口（v2.0.0 新增）**：低信息拦截 + 可选像素扫描/OCR/VLM，组合证据返回；VLM 可选配置 |

### 读图方法论 skill（image-reading）

`skills/image-reading.md`（DSH 版）/ `skills/image-reading/SKILL.md`（ZCode 版）是一套**经大量真实图片场景迭代验证**的读图方法论
（按 experience / skill / principle / insight 分层，教训有据可依、找得到主模型模式），
安装后模型自动掌握：
- **hue 场景指纹**：cyan 高=水/雾/湖泊，green 高=森林，orange/red 高=暖色人物/火光，blue 高=夜空科幻，achromatic+rough=废墟，green+yellow=翠绿能量/浮空仙境
- **多模态模型校验规则**：游戏名/品牌等文字必须 OCR 实读（多模态模型会猜错）；发光元素颜色以 hue 实测为准（多模态模型对发光色的描述系统性不可靠）；低对比主体（暗色人物/小色块）必须放大确认
- **主动验证**：低对比主体（暗色人物/小色块）必须放大确认
- **vision_analyze 使用**（v2.0.0）：先 image_scan 自己看，简单图用像素，复杂图再调 VLM；描述与实测冲突时以实测为准

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

重启 DSH Desktop 后，模型工具列表出现 `image_scan` / `image_ocr` / `image_sample` / `vision_analyze`，
技能目录出现 `image-reading`。

### ZCode 版

ZCode 版位于本仓库的 **[zcode 分支](https://github.com/jing-hy/picturereader/tree/zcode)**。

ZCode 版通过 **MCP server**（`mcp/server.js`，stdio）把四个工具暴露给 ZCode，
读图方法论作为 **skill**（`skills/image-reading/`）随插件分发，业务逻辑 `src/core.js`
与 DSH 版完全一致。安装：`npm install picturereader-zcode`。

## 使用

直接对模型说：

> 用 image_scan 看一下 <路径> 这张图，细看感兴趣的部分
> （复杂场景可接着用 vision_analyze 获取语义描述并交叉验证）

模型会加载 `image-reading` 方法论自动执行完整流程（定调 → 找主体 → 验证 → 描述）。

### vision_analyze 用法（v2.0.0）

```
vision_analyze(
  file_path="C:/shot.png",
  prompt="描述这个界面，有哪些元素？布局是否正常？",
  include_scan=true,    # 像素扫描证据（默认 true）
  include_ocr=true,     # OCR 文字证据（默认 false）
  include_vlm=true,     # 外部 VLM 语义描述（默认 true，但未配置 SEE_BASE 时自动跳过）
  allow_low_info=false, # 空白/简单图是否强制调 VLM（默认 false）
  stop_after=false      # 调用后是否关闭本插件启动的本地服务器
)
```

- **先自己看，再决定**：建议先用 `image_scan` 了解图片，简单图用像素就够；复杂/精密场景再开 VLM。
- **多次提问**：对同一张图换不同 `prompt` 反复调用，从多角度复核。
- **交叉验证**：VLM 描述与像素/OCR 冲突时，以实测为准。

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

## 环境变量

### PaddleOCR（可选）

| 变量 | 默认值 | 作用 |
|---|---|---|
| `DSH_PADDLE_PYTHON` | `C:\Users\Administrator\paddle_venv\Scripts\python.exe` | PaddleOCR 解释器路径（与原插件同名，便于直接迁移） |
| `DSH_PADDLE_CACHE` | `<插件目录>\.paddlex-cache` | PaddleX 模型缓存目录 |

### 外部视觉 API / VLM（可选，**默认不配置**）

| 变量 | 默认值 | 作用 |
|---|---|---|
| `SEE_BASE` | `（空）` | OpenAI 兼容视觉端点（留空 = VLM 禁用；本地 llama-server / LM Studio / vLLM / 云端网关） |
| `SEE_MODEL` | `（空）` | 视觉模型名（如 `google/gemma-4-12b-qat`） |
| `SEE_API_KEY` | `（空）` | API key（本地端点可随便填，云端需要真实 key） |
| `SEE_SERVER_EXE` / `SEE_SERVER_MODEL` / `SEE_SERVER_MMPROJ` | `（空）` | 本地 llama-server 自启路径（可选，配置后插件可自动拉起本地视觉服务器） |
| `SEE_SERVER_PORT` / `SEE_SERVER_NGL` / `SEE_SERVER_CTX` | `8080` / `20` / `16384` | 本地服务器参数 |

> **VLM 配置说明**：默认不配置 VLM，`vision_analyze` 会跳过 VLM 调用，只返回像素扫描和 OCR 证据（保持零外部依赖）。需要语义理解时，设置 `SEE_BASE` + `SEE_MODEL` 即可，例如指向本地 LM Studio（`http://127.0.0.1:1234/v1`）。

## 开发

```sh
# DSH 版（本仓库）
npm install
npm test            # node:test
node scripts/setup-ocr.mjs   # 可选：装 PaddleOCR
node scripts/preview.mjs     # 生成 fixtures 并预览渲染

# ZCode 版（本仓库 zcode 分支）
git checkout zcode
npm install
npm test            # node:test
node scripts/setup-ocr.mjs   # 可选
```

**热插拔（DSH 版）**：DSH 本身不支持代码热重载，但本插件自带执行层热加载——业务逻辑全在
`src/core.js` 单文件，工具每次执行按 mtime 动态加载（cache-bust），**改 core.js
下次调用即生效**；工具定义（schema/描述）改动需重启桌面端。

**热插拔（ZCode 版）**：MCP server 从所选目录运行，改 `src/core.js` 下次调用即生效
（详见 zcode 分支 README）。

## 优势

- **一个插件全包含，无需另装**：独立的伪多模态识图 + 可选外部视觉 API，融合在一个包里，不需要再装 `dsh-universal-vision` 或其他任何读图插件
- **核心链路零外部依赖**：扫描/取样/解码纯本地纯 JS，不调任何视觉 API；语义理解要么交给主模型，要么按需桥接你自己的 VLM
- **双版本独立分发，互不污染**：DSH 用 `picturereader`（本页），ZCode 用 `picturereader-zcode`（zcode 分支）；DSH 版带 `dsh.bundle`、ZCode 版带 `mcp` + `.zcode-plugin`，各装各的宿主，**不会把 ZCode 版误装进 DSH，也不会把 DSH 版误装进 ZCode**
- **外部 API 可选、即插即用**：默认不配置 `SEE_BASE` 保持纯本地；配了即接入语义理解，本地 llama-server / LM Studio / vLLM / 云端 OpenAI 兼容端点通吃
- **低信息量拦截**（v2.0.0）：自动识别空白/未渲染/简单图，避免小 VLM 幻觉、省调用成本
- **证据交叉验证**（v2.0.0）：VLM 描述与像素/OCR 实测冲突时以实测为准——伪多模态与真 VLM 互为印证，抑制幻觉
- **多次提问**（v2.0.0）：同一张图可换不同 `prompt` 反复 `vision_analyze`，从多角度复核
- **可追溯、可验证**：每个结论都有数据支撑（hue 占比、色块坐标、OCR 文本+置信度）
- **成本低**：一次扫描 ≈0.6–2.2K tokens；PaddleOCR 本地跑，无 API 费用
- **方法论沉淀**：附带的 image-reading skill 把读图经验固化（场景指纹/校验规则），模型每次看图都带着经过大量图片验证的经验

## License

MIT
