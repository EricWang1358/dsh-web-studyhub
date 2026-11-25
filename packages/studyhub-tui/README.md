# StudyHub TUI (`@ericwang1358/studyhub-tui`)

> 📖 **新手请先看：[完整中文使用教程（docs/GUIDE.md）](./docs/GUIDE.md)** — 按任务讲清楚每个功能「在哪、干什么、怎么用」；也可在应用内按 `?` 切到「使用教程」或 `Ctrl+K` 输入 `/guide` 直接阅读。纯按键对照表见 [docs/KEYBINDINGS.md](./docs/KEYBINDINGS.md)，常驻 AI 助手设计规范见 [docs/ASSISTANT-UX.md](./docs/ASSISTANT-UX.md)。

[StudyHub](../../README.md) 的高性能全功能交互式终端客户端（TUI），参考 [dsh-TUI](https://github.com/ccch1mneyyy/dsh-TUI) 的技术栈与交互美学设计，完整复刻 StudyHub 16 个核心与进阶功能视图，同时原生支持 **Linux bash** 与 **Windows PowerShell / Windows Terminal**。

## 核心特性

- **与 DSH-TUI 同源技术栈**：React 19.3 + Ink 8 + TypeScript + Chalk 6 + Marked 18 + cli-highlight + `get-east-asian-width`（中英混排零错位）+ Zustand 5 + 零依赖严格运行时校验 + esbuild 代码分割打包 + `@xterm/headless` 真实终端 E2E 测试。
- **双模型引擎（`agy` 主 + OpenAI 副）**：
  - **主模型（默认）**：自动探测本机 `agy` CLI 并优先启用，支持从 `agy models` 直接切换模型、调节思考强度（`low` / `medium` / `high` / `xhigh` / `max`）与逐 Token 流式输出。
  - **副模型（DSH-TUI 风格）**：内置 8 套 OpenAI 兼容预设（DeepSeek / OpenAI / 硅基流动 SiliconFlow / 智谱 GLM / OpenRouter / Groq / Moonshot Kimi / 自定义 Base URL），支持 `DEEPSEEK_API_KEY` / `OPENAI_API_KEY` 环境变量自动检测（密钥仅驻留内存，不落盘）与一键测连。
- **全功能终端复刻（16 大视图）**：
  - **全局导航、常驻助手与通知**：`Ctrl+K` / `/` 命令面板支持实时全文搜题与搜原文（命中直达刷题或资料原页），`Ctrl+Space` / `Ctrl+G` 随时唤出右侧停靠 AI 助手与统一带学面板（所有停靠页统一二次 `Esc`：先还键盘、再收起），`I` 打开全局收件箱与通知中心（按 `h` 切至「近期提示」回看最近 50 条多行提示），支持 Vim 风格翻页（`Ctrl+D/U`、`Ctrl+F/B`、`g/G`）。
  - **每日学习**：`1` 学习库（`p` 今日计划 / `g` AI 带学工作台 / `C` 课程设置 / `o` 题组 JSON 导入·合并·拆分 / `R` 定制本轮 / `m: + / k / Space / F / S` 题组补题·转换·批量管理 / 语音学习包导出）、`r` FSRS-6 全题型刷题（`0-5` 六级自评 + `u` 撤销上一题评分 + `X` 二次确认结束本轮 + 单选 / 多选 / 判断 / 填空逐空 diff / 简答 + `h` 实时流式 AI「帮我理解」+ `t` 常驻带学与复述 / `L` 苏格拉底带学 / `A` 答题卡与案例强化 / `*` 标记重点 / `W` 翻译 / `S` 同类题对比 / `D` 卡片工具 / `Q` 队列编辑 / `F` 费曼复述 / `G` AI 评分标准批改 + 原页溯源）、`2` 资料库与分页文本阅读器（本地路径 Tab 补全导入 PDF/PPTX/DOCX/MD/LaTeX/HTML/TXT、`G` AI 课程归类、`V` 引用覆盖率分析、`F`/`m` 文件夹筛选与移动、`M` MinerU PDF、`C` 伴学页面、`O` 目录大纲、`B` 书签与批注、页内搜索、按页提问与翻译）、`3` 创建题组与草稿工作台（`i` 录题 / `S`/`R` 草稿查重与修复 / `u` 撤销移除草稿题）、`4` 错题本与 0-token 错题分流（`Space` / `B` 批量练习）。
  - **考试与进阶**：`5` 模拟考试（选择题卷 / 案例卷 / 口试 + 倒计时 + 交卷批改报告）、`6` 学习统计（12 周 Unicode/ASCII 热力图 / 掌握度柱状图 / 薄弱点排行 / `f` 7 天预测）、`7` 复习全书（`w` 期末一周冲刺与模考 / `P` 书内精选问答 / `e` 编辑与回退 / `x` 导出 Markdown）、`8` 知识骨架交互树（`R` 课程学习路线 / `G` 主题分组管理 / `E` 编辑骨架节点 / `L` 骨架自检）、`9` 考试教练（`p` 学习画像与长期偏好）、`0` 备考补习（`P` 全周期备考计划与章节就绪度 · 补齐估算，支持粘贴考纲或传入本地截图路径）。
  - **整理与工具**：`n` 学习笔记（支持每日复盘、Markdown 导出与保存后列表选中保持）、`b` 三列终端待办看板（原子化持久化 + 顶部内置番茄钟 `P`/`Space` 专注计时器 + `S` 学习库看板双向同步）、`t` 后台任务实时监控（`w` 历史学习流只读时间线 / `o` 任务实时输出与 JSON/Markdown 切换 / `m` 向运行中任务发送补充要求 / `a` 归档与恢复）、`a` 音频文件导入转写（纯终端下自动禁用麦克风现场录音并提示）、`,` 设置中心（模型 / 工作区 / `x` 导出学习库 JSON 备份 / 6 套 WCAG 审计主题与双语切换）。
- **面向终端的优雅降级与 NFR 保障**：
  - 内置 **LaTeX → Unicode 数学公式渲染器**（`m` 键随时切换原始 LaTeX），带 LRU 有界缓存（≤256 条），且代码高亮（`cli-highlight`）与重型弹窗按需懒加载；
  - 启动即渲染独立首帧加载框（`ShellBootFrame`）并结合 esbuild 代码分割按需懒加载视图与弹窗，冷启动更快、稳态内存更低；
  - 6 套通过 WCAG 2.1 对比度审计的主题（`dsh-dark`、`warm-paper`、`nord`、`high-contrast`、`warm-amber` 夜间暖琥珀、`soft-sage` 护眼浅绿）；支持 `--ascii` / `STUDYHUB_TUI_ASCII=1` 以及 **Windows PowerShell 5.1 / ConPTY / `TERM=dumb` 自动纯 ASCII 降级**，并内置括号粘贴（bracketed paste）分段/残留序列（`200~`/`201~`）清洗与 `NO_COLOR`/`FORCE_COLOR`/`WT_SESSION` 色彩自适应；
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

# 无头 CLI 快路径（不启动 Ink，零模型调用，支持 --json 与 --ascii）
node packages/studyhub-tui/bin/studyhub-tui.mjs --doctor --json
node packages/studyhub-tui/bin/studyhub-tui.mjs --stats --library /path/to/.dsh-study
node packages/studyhub-tui/bin/studyhub-tui.mjs --due --course "设计模式" --json
node packages/studyhub-tui/bin/studyhub-tui.mjs --board --library /path/to/.dsh-study --ascii
node packages/studyhub-tui/bin/studyhub-tui.mjs --search Memento --limit 10
node packages/studyhub-tui/bin/studyhub-tui.mjs --export --json
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
| 全局 | `Ctrl+Space` / `Ctrl+G` | 右侧停靠常驻 AI 助手与带学（二次 `Esc`：先还键盘、再收起） |
| 全局 | `I` | 打开全局收件箱与通知（按 `h` 回看最近 50 条多行「近期提示」） |
| 全局 | `c` | 切换当前课程 / 新建课程 |
| 全局 | `[` / `]` | 切换到上/下一页面 |
| 全局 | `\` | 折叠或展开左侧导航栏（宽度 `< 100` 自动折叠） |
| 全局 | `j/k` / `Ctrl+D/U` / `Ctrl+F/B` / `g/G` | 列表移动、半页/整页翻页与首尾跳转 |
| 全局 | `?` | 上下文快捷键速查与内置使用教程 |
| 全局 | `Ctrl+R` | 强制刷新学习库快照 |
| 全局 | `q` / `Ctrl+C` | 安全退出并自动恢复终端 |
| 多行输入 | `Ctrl+S` / `Ctrl+J` / `Shift+Enter` | 多行编辑器提交（`Ctrl+J` 或 `Shift+Enter` 插入换行） |
| 学习库 (`1`) | `p` / `g` / `C` / `o` / `R` / `m` | 今日计划 / AI 带学 / 课程设置 / 导入·合并·拆分 / 定制本轮 / 补题(`+`)·转换(`k`)·批量(`Space/F/S`) |
| 刷题复习 (`r`) | `0-5` / `u` / `X` / `h` / `t` / `L` / `A` / `*` / `W` / `S` / `D` / `Q` / `F` / `G` | FSRS-6 六级自评 / 撤销评分 / 二次确认结束本轮 / AI 讲解 / 常驻带学复述 / 苏格拉底带学 / 答题卡 / 重点 / 翻译 / 同类 / 工具 / 队列 / 复述 / AI 批改 |
| 资料与阅读 (`2`) | `G` / `V` / `F` / `m` / `M` / `C` / `O` / `B` | AI 归类 / 引用覆盖率 / 文件夹筛选 / 移至文件夹（或切 LaTeX）/ MinerU PDF / 伴学 / 大纲 / 书签 |
| 出题与草稿 (`3`) | `i` / `S` / `R` / `u` | 录题导入 / 草稿查重 / 草稿修复 / 撤销移除草稿题 |
| 复习全书 (`7`) | `w` / `P` / `e` / `x` | 期末一周冲刺与模考 / 书内精选问答 / 编辑与回退 / 导出 Markdown |
| 知识骨架 (`8`) | `R` / `G` / `E` / `L` | 课程学习路线 / 主题分组管理 / 编辑骨架节点 / 骨架自检 |
| 考试教练 (`9`) | `p` | 学习画像与长期偏好 |
| 备考补习 (`0`) | `P` | 全周期备考计划与章节就绪度 |
| 待办看板 (`b`) | `P` / `Space` / `M` / `+/-` / `R` / `S` | 番茄钟启停 / 专注与休息切换 / 调整时长 / 重置计时 / 同步学习库看板 |
| 后台任务 (`t`) | `w` / `o` / `m` / `a` | 历史学习流 / 任务输出弹窗 / 发送补充指令 / 归档与恢复 |
| 设置 (`,`) | `x` | 导出学习库 JSON 备份 |

## 开发与验证

```bash
cd packages/studyhub-tui
npm run lint              # ESLint 校验 TUI TS/TSX 源码（含按键路由与 resize 护栏）
npm run typecheck         # TypeScript 严格类型检查（tsc --noEmit）
npm run build             # esbuild 代码分割构建 dist/
npm test                  # 运行全部单测、热键冲突审计 (key-routing-matrix)、跨平台审计与 @xterm/headless E2E 测试
npm run bench             # 测量包体积与冷启动延迟
STUDYHUB_TUI_LIVE=1 node --test tests/host.test.mjs  # 可选：针对本机真实 agy CLI 的端到端测试
```
