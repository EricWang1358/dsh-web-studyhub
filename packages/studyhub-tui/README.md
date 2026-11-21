# StudyHub TUI (`@ericwang1358/studyhub-tui`)

[StudyHub](../../README.md) 的高性能全功能交互式终端客户端（TUI），参考 [dsh-TUI](https://github.com/ccch1mneyyy/dsh-TUI) 的技术栈与交互美学设计，完整复刻 StudyHub 16 个核心与进阶功能视图，同时原生支持 **Linux bash** 与 **Windows PowerShell / Windows Terminal**。

## 核心特性

- **与 DSH-TUI 同源技术栈**：React 19.3 + Ink 8 + TypeScript + Chalk 6 + Marked 18 + cli-highlight + `get-east-asian-width`（中英混排零错位）+ Zustand 5 + Zod 4 + esbuild 代码分割打包 + `@xterm/headless` 真实终端 E2E 测试。
- **双模型引擎（`agy` 主 + OpenAI 副）**：
  - **主模型（默认）**：自动探测本机 `agy` CLI 并优先启用，支持从 `agy models` 直接切换模型、调节思考强度（`low` / `medium` / `high` / `xhigh` / `max`）与逐 Token 流式输出。
  - **副模型（DSH-TUI 风格）**：内置 8 套 OpenAI 兼容预设（DeepSeek / OpenAI / 硅基流动 SiliconFlow / 智谱 GLM / OpenRouter / Groq / Moonshot Kimi / 自定义 Base URL），支持 `DEEPSEEK_API_KEY` / `OPENAI_API_KEY` 环境变量自动检测（密钥仅驻留内存，不落盘）与一键测连。
- **全功能终端复刻（16 大视图）**：
  - **每日学习**：`1` 学习库（今日计划 / 题组管理 / 语音学习包导出）、`r` FSRS-6 全题型刷题（单选 / 多选 / 判断 / 填空 / 简答 / 闪卡 + 实时流式 AI「帮我理解」+ 原页溯源 + 每日复盘）、`2` 资料库与分页文本阅读器（本地路径 Tab 补全导入 PDF/PPTX/DOCX/MD/LaTeX/HTML/TXT、页内搜索、按页提问与翻译）、`3` 创建题组与草稿工作台、`4` 错题本与 0-token 错题分流。
  - **考试与进阶**：`5` 模拟考试（选择题卷 / 案例卷 / 口试 + 倒计时 + 交卷批改报告）、`6` 学习统计（12 周 Unicode 热力图 / 掌握度柱状图 / 薄弱点排行）、`7` 复习全书、`8` 知识骨架交互树、`9` 考试教练、`0` 备考补习（支持粘贴考纲或传入本地截图路径）。
  - **整理与工具**：`n` 学习笔记（支持每日复盘与 Markdown 导出）、`b` 三列终端待办看板（原子化持久化）、`t` 后台任务实时监控、`a` 音频文件导入转写（纯终端下自动禁用麦克风现场录音并提示）、`,` 设置中心（模型 / 工作区 / 练习偏好 / 4 套主题与双语切换）。
- **面向终端的优雅降级与 NFR 保障**：
  - 内置 **LaTeX → Unicode 数学公式渲染器**（`m` 键随时切换原始 LaTeX），带 LRU 有界缓存；
  - esbuild 代码分割按需懒加载视图，冷启动 CLI 响应 `< 60ms`，首帧渲染 `< 150ms`；
  - 虚拟滚动列表（`VirtualList`）与单页窗口阅读器控制稳态内存，交替屏幕缓冲 + `signal-exit` 确保异常退出自动恢复终端状态。

## 快速开始

### Linux (bash / zsh)

```bash
# 在仓库根目录
npm --prefix packages/studyhub-tui install
npm run tui:build
npm run tui

# 或指定学习库目录 / 主题 / 语言
node packages/studyhub-tui/bin/studyhub-tui.mjs --root /path/to/.dsh-study --theme dsh-dark --lang zh
```

### Windows (PowerShell / Windows Terminal)

```powershell
# 在仓库根目录（需要 Node.js >= 22.19）
npm --prefix packages/studyhub-tui install
npm run tui:build
npm run tui

# 也可通过环境变量提供副模型密钥（不写入磁盘）
$env:DEEPSEEK_API_KEY = "sk-..."
node .\packages\studyhub-tui\bin\studyhub-tui.mjs --root C:\Users\You\Documents\StudyHub
```

## 常用快捷键

| 按键 | 功能 |
| --- | --- |
| `1–9`, `0`, `n`, `b`, `t`, `a`, `,` | 快速切换全部 15 个导航页面 |
| `r` | 继续/进入 FSRS-6 刷题复习 |
| `Ctrl+K` 或 `/` | 全局模糊搜索与命令面板（页面、课程、题组、动作） |
| `c` | 切换当前课程 / 新建课程 |
| `[` | 折叠或展开左侧导航栏（宽度 `< 100` 自动折叠） |
| `?` | 上下文快捷键速查 |
| `Ctrl+R` | 强制刷新学习库快照 |
| `m` | 在刷题/阅读/全书/笔记中切换 Unicode 数学公式与原始 LaTeX |
| `q` / `Ctrl+C` | 安全退出并自动恢复终端 |

## 开发与验证

```bash
cd packages/studyhub-tui
npx tsc --noEmit          # TypeScript 严格类型检查
npm run build             # esbuild 代码分割构建 dist/
npm test                  # 运行全部单测、跨平台审计与 @xterm/headless E2E 测试
npm run bench             # 测量包体积与冷启动延迟
STUDYHUB_TUI_LIVE=1 node --test tests/host.test.mjs  # 可选：针对本机真实 agy CLI 的端到端测试
```
