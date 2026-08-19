# picturereader — monorepo 容器根

本目录是 git 主仓库的容器根（container 分支），实际代码分居两个 worktree 子目录：

- **dsh/** — DSH 版（main 分支）。DeepSeek Harness 插件：统一图像理解（pixel scan + OCR + VLM bridge），带设置卡、三模式路由、文档转图片等。web-desktop / web profile 的 
ode_modules\picturereader Junction 指向此目录。
- **zcode/** — zcode 版（zcode 分支）。MCP 服务版。headless profile 的 Junction 指向此目录。

请勿在根目录直接改代码；请进入对应子目录的 worktree 开发。
