# picturereader v3 到 ZCode 的移植设计

日期：2026-08-20

## 目标与边界

将 `D:\coding\picturereader\dsh` 中 v3.0.2 的可跨宿主图像理解能力移植到当前 ZCode 工作区，使 ZCode MCP 服务提供完整的本地图像工具链、可选 VLM 语义分析和文档转图能力。`dsh` 目录全程只读，不执行安装、格式化、测试写入或其他可能改变其内容的操作。

移植范围包括：

- 现有 `image_scan`、`image_ocr`、`image_sample`、`vision_analyze` 的 v3 行为增强。
- `image_crop`、`image_palette`、`image_compare`、`image_batch`。
- `document_to_image` 及其本地 Python 转换脚本入口。
- RapidOCR 可选引擎及安装脚本。
- 隐私、智能、严谨三种路由模式，以 MCP 进程环境变量配置，不依赖 DSH 设置页。
- VLM 运行时配置的环境变量优先级、隐私硬门禁、OpenAI 兼容端点路径归一化。
- 对应 MCP 工具 schema、README、单元测试和 stdio JSON-RPC 协议测试。

明确不移植 DSH 专属部分：

- DSH `settings` 命名空间、设置卡片和 Web 设置页模型扫描路由。
- DSH `llm/stream` 图片桥和附件服务。
- DSH 视觉孪生适配器以及 `@deepseek-ai/dsh-llm`、`@deepseek-ai/dsh-settings` 等宿主依赖。

## 架构与数据流

ZCode 继续使用现有的无 SDK、逐行 JSON-RPC MCP stdio 服务。`mcp/server.js` 负责协议、路径解析、文件读取、工具分发和结果渲染；`src/core.js` 继续作为动态热加载的纯图像业务核心。新增工具沿用 `executeX` + `TOOLS` schema 的组织方式，避免引入 DSH 的 Cordis 上下文。

每个工具遵循统一的数据流：验证参数和扩展名，按 `PICTUREREADER_CWD` 解析相对路径，执行 50 MB 文件上限和 2400 万像素上限，调用核心算法或本地转换器，返回结构化结果并由 MCP 转换为模型可读文本。外部进程失败时提供明确错误；可选 OCR 引擎缺失或失败时回退 Windows OCR，不让单一增强组件导致服务崩溃。

`vision_analyze` 读取 `PICTUREREADER_MODE`（`privacy`、`smart`、`strict`）及 VLM 环境变量。privacy 永不发送外部请求；smart 使用低信息 guard 和默认的低成本证据组合；strict 默认执行更完整的扫描、OCR 和必要的 VLM。调用前再次检查 VLM 是否启用、端点和密钥是否满足要求。密钥只从环境变量读取，源码、文档和测试不写入真实凭据。

`document_to_image` 通过仓库内 Python 脚本调用本地转换环境。工具验证输入格式、页数、DPI、输出目录和大小限制；缺少 Python/转换依赖时返回可操作的安装提示。输出文件写入系统临时目录或显式配置的目录，不写入 `dsh`。

## 配置

ZCode 侧只增加环境变量配置，避免伪造 DSH 设置接口：

- `PICTUREREADER_CWD`：相对路径解析基目录。
- `PICTUREREADER_MODE`：`privacy`、`smart`、`strict`，默认 `smart`。
- `PICTUREREADER_OCR_ENGINE`：`windows`、`paddle`、`rapid`，默认 `windows`。
- `SEE_BASE`、`SEE_MODEL`、`SEE_API_KEY`：VLM 端点、模型和密钥。
- `SEE_SERVER_*`：可选本地 llama-server 参数。
- `PICTUREREADER_*` 的超时、扫描、文档和批量限制：只提供安全默认值，不包含凭据。

环境变量优先于静态默认值；privacy 模式优先于一切 VLM 配置。云端端点没有密钥时不发起请求；本地端点可按现有实现处理认证。

## 错误处理

- 所有工具拒绝空路径、目录、未知扩展名、WebP、超大文件和超大像素图，并保留清晰的工具名前缀。
- `image_ocr` 的 PaddleOCR/RapidOCR 缺失、启动失败或超时均回退 Windows OCR并返回 note。
- 批量工具单张失败时记录该项错误并继续其余文件，整体结果标出失败计数。
- 文档转换依赖缺失或子进程失败时返回 stderr 摘要，不泄露密钥。
- VLM 请求超时、HTTP 错误或响应格式异常时不吞错；若本次还有本地证据，仍返回本地证据和错误说明。
- MCP `tools/call` 以 `isError` 结果返回工具错误，不能污染 stdout 协议流；诊断只写 stderr。

## 测试与验收

1. 运行 `npm test`，覆盖现有核心/工具/管线测试以及新增工具、模式、RapidOCR、文档转换测试。
2. 使用临时 fixture 验证每个新增 MCP 工具的成功路径、参数校验、路径解析、限制和错误降级。
3. 启动 `node mcp/server.js`，发送 `initialize`、`tools/list` 和至少一个 `tools/call` JSON-RPC 请求，确认 stdout 只有合法 JSON-RPC 响应，stderr 仅有诊断信息。
4. 运行包入口导入检查，确认不存在 DSH 专属包的运行时导入。
5. 设置不存在的 VLM 密钥变量或空值进行配置测试，确认源码、测试和文档没有真实凭据字面量。
6. 对 `D:\coding\picturereader\dsh` 执行只读 `git status --short`，结果保持为空；对当前 `zcode` 检查变更只包含本次移植和已有 `src/vlm.js` 修改。

## 交付物

- 更新后的 ZCode MCP 服务和可移植 v3 源码。
- 可选 RapidOCR、文档转换安装脚本及必要文档。
- 新增/更新测试。
- `npm test` 与 MCP 协议调用的实际输出摘要。
- 明确说明未移植的 DSH 专属能力和 `dsh` 工作区未被修改的证据。
