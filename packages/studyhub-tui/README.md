# StudyHub TUI (`@ericwang1358/studyhub-tui`)

[StudyHub](../../README.md) 的高性能全功能交互式终端客户端（TUI），参考 [dsh-TUI](https://github.com/ccch1mneyyy/dsh-TUI) 的技术栈与交互美学设计，完整复刻 StudyHub 16 个核心与进阶功能视图，同时原生支持 **Linux bash** 与 **Windows PowerShell / Windows Terminal**。

## 核心特性

- **与 DSH-TUI 同源技术栈**：React 19.3 + Ink 8 + TypeScript + Chalk 6 + Marked 18 + cli-highlight + `get-east-asian-width`（中英混排零错位）+ Zustand 5 + Zod 4 + esbuild 代码分割打包 + `@xterm/headless` 真实终端 E2E 测试。
- **双模型引擎（`agy` 主 + OpenAI 副）**：
  - **主模型（默认）**：自动探测本机 `agy` CLI 并优先启用，支持从 `agy models` 直接切换模型、调节思考强度（`low` / `medium` / `high` / `xhigh` / `max`）与逐 Token 流式输出。
  - **副模型（DSH-TUI 风格）**：内置 8 套 OpenAI 兼容预设（DeepSeek / OpenAI / 硅基流动 SiliconFlow / 智谱 GLM / OpenRouter / Groq / Moonshot Kimi / 自定义 Base URL），支持 `DEEPSEEK_API_KEY` / `OPENAI_API_KEY` 环境变量自动检测（密钥仅驻留内存，不落盘）与一键测连。
- **全功能终端复刻（16 大视图）**：
  - **全局导航与检索**：`Ctrl+K` / `/` 命令面板支持实时全文搜题与搜原文（命中直达刷题或资料原页），`I` 打开全局收件箱与通知中心，支持 Vim 风格翻页（`Ctrl+D/U`、`Ctrl+F/B`、`g/G`）。
  - **每日学习**：`1` 学习库（`p` 今日计划 / `C` 课程设置 / `o` 题组 JSON 导入、合并与拆分 / 语音学习包导出）、`r` FSRS-6 全题型刷题（单选 / 多选 / 判断 / 填空 / 简答 / 闪卡 + 实时流式 AI「帮我理解」+ `T` 翻译 / `S` 同类题对比 / `D` 卡片工具 / `F` 费曼复述 / `G` AI 评分标准批改 + 原页溯源）、`2` 资料库与分页文本阅读器（本地路径 Tab 补全导入 PDF/PPTX/DOCX/MD/LaTeX/HTML/TXT、`F`/`m` 文件夹筛选与移动、`C` 伴学页面、`O` 目录大纲、`B` 书签与批注、页内搜索、按页提问与翻译）、`3` 创建题组与草稿工作台、`4` 错题本与 0-token 错题分流。
  - **考试与进阶**：`5` 模拟考试（选择题卷 / 案例卷 / 口试 + 倒计时 + 交卷批改报告）、`6` 学习统计（12 周 Unicode 热力图 / 掌握度柱状图 / 薄弱点排行）、`7` 复习全书、`8` 知识骨架交互树、`9` 考试教练、`0` 备考补习（支持粘贴考纲或传入本地截图路径）。
  - **整理与工具**：`n` 学习笔记（支持每日复盘与 Markdown 导出）、`b` 三列终端待办看板（原子化持久化 + 顶部内置番茄钟 `P`/`Space` 专注计时器）、`t` 后台任务实时监控、`a` 音频文件导入转写（纯终端下自动禁用麦克风现场录音并提示）、`,` 设置中心（模型 / 工作区 / `x` 导出学习库 JSON 备份 / 4 套 WCAG 审计主题与双语切换）。
- **面向终端的优雅降级与 NFR 保障**：
  - 内置 **LaTeX → Unicode 数学公式渲染器**（`m` 键随时切换原始 LaTeX），带 LRU 有界缓存，且代码高亮（`cli-highlight`）按需懒加载；
  - 启动即渲染首帧加载框（`ShellBootFrame`）并结合 esbuild 代码分割按需懒加载视图，冷启动更快、稳态内存更低；
  - 4 套通过 WCAG 2.1 对比度审计的主题（`dsh-dark`、`warm-paper`、`nord`、`high-contrast`），并通过 `--ascii` 或 `STUDYHUB_TUI_ASCII=1`（及 `TERM=dumb` 自动检测）兼容旧版 Windows PowerShell 5.1；
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

# 旧版 Windows PowerShell 5.1 / 无 Unicode 字体终端可启用纯 ASCII 边框与图表模式（或设置 $env:STUDYHUB_TUI_ASCII = "1"）
node .\packages\studyhub-tui\bin\studyhub-tui.mjs --ascii
```

## 常用快捷键

| 范围 | 按键 | 功能 |
| --- | --- | --- |
| 全局 | `1–9`, `0`, `n`, `b`, `t`, `a`, `,` | 快速切换全部 15 个导航页面 |
| 全局 | `r` | 继续/进入 FSRS-6 刷题复习 |
| 全局 | `Ctrl+K` / `/` | 命令面板与实时全文搜题 / 搜原文 |
| 全局 | `I` | 打开全局收件箱与通知 |
| 全局 | `c` | 切换当前课程 / 新建课程 |
| 全局 | `[` / `]` | 切换到上/下一页面 |
| 全局 | `\` | 折叠或展开左侧导航栏（宽度 `< 100` 自动折叠） |
| 全局 | `j/k` / `Ctrl+D/U` / `Ctrl+F/B` / `g/G` | 列表移动、半页/整页翻页与首尾跳转 |
| 全局 | `?` | 上下文快捷键速查 |
| 全局 | `Ctrl+R` | 强制刷新学习库快照 |
| 全局 | `q` / `Ctrl+C` | 安全退出并自动恢复终端 |
| 学习库 (`1`) | `p` / `C` / `o` | 今日计划 / 课程设置 / 题组 JSON 导入·合并·拆分 |
| 刷题复习 (`r`) | `T` / `S` / `D` / `F` / `G` / `m` | 翻译 / 同类题 / 卡片工具 / 费曼复述 / AI 评分批改 / LaTeX 切换 |
| 资料与阅读 (`2`) | `F` / `m` / `C` / `O` / `B` | 文件夹筛选 / 移至文件夹（列表）或切换 LaTeX（阅读）/ 伴学 / 大纲 / 书签批注 |
| 待办看板 (`b`) | `P` / `Space` / `M` / `+/-` / `R` | 番茄钟启停 / 专注与休息切换 / 调整时长 / 重置计时 |
| 设置 (`,`) | `x` | 导出学习库 JSON 备份 |

## 开发与验证

```bash
cd packages/studyhub-tui
npx tsc --noEmit          # TypeScript 严格类型检查
npm run build             # esbuild 代码分割构建 dist/
npm test                  # 运行全部单测、跨平台审计与 @xterm/headless E2E 测试
npm run bench             # 测量包体积与冷启动延迟
STUDYHUB_TUI_LIVE=1 node --test tests/host.test.mjs  # 可选：针对本机真实 agy CLI 的端到端测试
```
