# StudyHub 体验重构计划（2026-10-01）

用户反馈“可用性太差、跟 DSH 绑死”。本计划先通过新用户逐步走查找全痛点，再按工作包交给子代理以测试先行（TDD）实现。

## 0. 结论摘要

- **一核两壳。** 全部学习功能和体验修复都在插件本体里：DSH 老用户继续用轻量插件。独立端基于 DSH 二次开发，只在外壳和重心上不同：StudyHub 作为落地页、品牌、学习模式预设、预置服务商卡片和启动器。**独立端安排在 3.0.0；本轮只修插件版，并遵守第 8 节的解耦护栏。当务之急是降低插件装好后的上手成本、提高指引质量。**
- **DSH 0.2.0-rc.2 已证明能承载独立端**（R1 实测）：
  - 插件可以自带「学习模式」预设；
  - 学习库路径用 `libraryRoot: !!js dshHomePath('study','library')` 即可脱离工作区；
  - 可以通过补丁预置服务商卡片、隐藏编程界面；
  - 可以做顶级落地页；
  - 桌面版自带的运行时能直接跑独立的 studyhub profile，无需另装 Node。
- **新用户卡在四处。**
  - 找不到入口：Study 标签要等发出第一条消息才出现。
  - 主路径被引向 JSON 导入。
  - 缺少密钥时没有任何提示，失败信息也落在视口外。
  - 资料导入体验差：PDF 按页拆分、导入后无反馈、导入控件不统一、拖进来的文件被 DSH 对话框截走。
  - 此外，17 处 AI 功能只能在 DSH 对话里用。
- **验证工具本身要先修**：预览服务器每个请求都新建服务，模拟模型过于简陋。否则 TDD 子代理没法在浏览器里验证改动。

## 1. 原则

1. **一核两壳。** 新功能和修复只写进共享插件。独立端专属代码仅限 profile/bundle 补丁、外壳包里的品牌代码和启动器。插件通过“外壳配置行”（独立端 bundle 才会插入）识别自己处在哪种外壳，不分叉 UI。
2. **复用 DSH 的能力。** 需要 AI 代理的功能交给 DSH 子代理和预设，不另写直连模型的路径。
3. **防蠢设计。**
   - 依赖服务商的功能，要在用户投入之前就挡住（SetupRequired 门槛）。
   - 每个操作都有可见反馈。
   - 错误显示在用户正在看的位置，用人话写，并附带修复按钮。
   - 不要求用户去敲命令行。
4. **风格统一。** 同一类操作只用一个组件，样式全部来自设计令牌。
5. **TDD。** 每个工作包先写失败测试（必须看到红），再实现；`npm run verify` 全绿；界面改动要附旅程脚本截图。
6. **国际化。** 所有应用文案都走 `ui()`，中英同步；不翻译用户内容。
7. **国内可用。** 首选国内直连的免费服务商（硅基流动），清楚标注“国内直连”还是“需海外网络”。不接入非官方逆向接口。

## 2. 痛点清单（去重合并）

来源缩写：
- O = 你直接报告的条目（`audit/OWNER`）；
- A1 = 新用户安装上手走查（`audit/A1/shots`）；
- A2 = 核心学习闭环走查（`audit/A2/shots`）；
- A3 = 次要功能与视觉审计（`audit/A3/shots`）；
- R1 = DSH 二次开发调研。

证据目录位于会话临时目录 `scratchpad/audit/`。严重度：B = 阻塞，H = 高，M = 中，L = 低。

### A. 安装与发现

| ID | 问题 | 来源 | 级 | 代码 / 方向 |
|---|---|---|---|---|
| P01 | Study 难找。新会话没有 Study 标签，要等发出第一条消息才出现；唯一入口是右上角一个无文字图标 → 右侧栏 → Study 卡片，文档也没写。 | A1 D8, R1 | B | `ui/host/workspace.jsx`。改为：顶级 StudyHub 页面加侧栏入口；首次启用插件时自动打开。 |
| P02 | 安装和启用文档与界面对不上。“workbench”这个词在界面里不存在；组件只显示包路径；更新说明与 DSH 的提示相互矛盾；文档让粘贴 tgz 链接，而输入框只提到包名、仓库地址或本地路径。 | A1 D6, D7, I2 | M | 改文档，并给组件起人能读懂的名字。 |
| P03 | 工作区概念劝退新用户。默认工作区在 Documents 下；换工作区就换学习库；看不到学习库在哪。 | O-7, A1 D9, R1 | H | 个人学习库（配置项 `libraryRoot`）；页头显示“学习库：位置 · 更改”。 |
| P04 | DSH 的编程外壳在干扰。对话 / 轨迹标签、写权限、终端都露在外面；对话输入框浮在 Study 页面上，盖住页面底部和模态框底部，“保存资料”按钮点不到。 | A1 S5, S6, M3, R1 | H | Study 主视图给输入框留出空间（或隐藏它）；模态框统一用 `showModal()`。 |
| P05 | 拖进 Study 的文件被 DSH 对话框截走。 | A1 M5 | H | 一个统一的投放区，并在投放时阻止事件继续冒泡（`stopPropagation`）。 |
| P06 | 一个产品五个名字：StudyHub / DSH Daily Flashcard / Daily Flashcard / Study / study-suite-*。 | A1 D1, A2 F-13 | M | 统一为 StudyHub。 |
| P07 | 文档问题：中文 README 链到英文文档和不存在的锚点；2.0.3 发布链接 404，latest 指向 2.0.2；内容过长、过技术，没有费用说明；`127.0.0.1:3080` 打开时还需要令牌。 | A1 D2–D5 | H | 重写快速上手；把链接检查加进 verify。 |

### B. 首屏与上手

| ID | 问题 | 来源 | 级 | 代码 / 方向 |
|---|---|---|---|---|
| P08 | 空库首页的主按钮是“导入 JSON 题组”；已有资料后仍显示“还没有卡片”；“在对话中用工作区文件出题”这个入口只在 DSH 里有效。 | A1 S2, A2 F-01, A3-19 | B | `ui/StudyMap.jsx:425,459,693`。**见决定 D1。** |
| P09 | 创建题组默认停在“导入 JSON · 推荐”；用资料出题排在第三个标签，名为“从资料补题”。 | A1 N3, A2 F-01 | B | `ui/Generate.jsx:49-51`。**见决定 D1。** |
| P10 | 上手指引挤在侧栏里：侧栏被撑到约 2000px，“设置”被挤出屏幕；还被对话框遮挡；步骤以 JSON 为中心，完成判定也不对；含 `/study-spar` 等术语；没有导览，也没有示例数据。 | O, A1 S3, A2 F-18, A3-19 | H | `ui/Guide.jsx`。用功能切换导览 + 示例数据 + 主区欢迎页替换。 |
| P11 | 导航顺序：课堂实录、音频转录排第 3、4 位，资料和创建题组被放在下方分组。 | O-5, all | H | `ui/App.jsx:41-44` |
| P12 | 空库也显示高级区块，如“全局笔记本”、面试模式切换。 | A1 O4, A2 F-02, A3-20 | M | 有内容后再显示；仅 DSH 适用的放到最后。 |
| P13 | “为你定制”藏在设置深处的一个勾选项里。 | A3-17 | M | 在结果页征求同意（已有 `coach.consent` 接口）。 |

### C. 模型与密钥门槛

| ID | 问题 | 来源 | 级 | 代码 / 方向 |
|---|---|---|---|---|
| P14 | 没配模型时毫无提示：选择器照常显示模型名，生成按钮也可以点。 | A1 N1 | H | 宿主侧做模型就绪检查，再加 SetupRequired 门槛。 |
| P15 | 生成失败约 20 秒后才出现，位置在页面最底部，措辞是开发者语言（`llm-deepseek: no API key…`），也没有“去设置”按钮。 | A1 N2 | H | `ui/StudyMap.jsx:893-939`；任务状态移到页面顶部，错误映射成人话。 |
| P16 | DSH 模型设置：假 Key 不校验，Key 无法删除，没有获取 Key 的链接，没有硅基流动。 | A1 N4, R1 | M | 预置服务商卡片 + 测试按钮；无法删除 Key 报给 DSH 上游。 |
| P17 | 设置页“学习库与模型”离开 DSH 语境就看不懂：“跟随当前会话”、手填 Provider / Model ID、裸露的原始路径；英文版还漏了一个空格。 | A3-22 | H | 改为“AI 模型”区：读取 DSH 模型注册表，显示状态，提供测试。 |

### D. 资料导入

| ID | 问题 | 来源 | 级 | 代码 / 方向 |
|---|---|---|---|---|
| P18 | PDF 按页拆成多条资料（6 页 = 6 条，“查看 6 份资料”）。 | O-6, A1 M1, A2 F-04 | H | `lib/documents.js:75`、`ui/Sources.jsx`、`ui/Generate.jsx:150-170`。按文档分组显示，页只作为可展开的明细。 |
| P19 | 导入原文件后没有反馈：弹窗不关，输入框被重置，也没有指向新资料的链接。 | O-3, all | H | `DocumentImport.jsx:16-27` |
| P20 | 文件入口有 6 种：文档只能用原生单选输入框，只有音频支持拖放和多选；原生控件的文字跟着浏览器语言走。 | O-4, all | H | FileDrop 组件 + ImportHub |
| P21 | 添加资料弹窗：音频区喧宾夺主；课程字段在要用它的导入控件下方；`.txt` 被三个入口同时接受；内容高约 1430px。 | O-5, all | H | `ui/App.jsx:1213-1270` |
| P22 | 刚导入的 Markdown 被标成“旧版提取，建议重新导入”。 | A1 M8, A2 F-05 | M | `ui/Generate.jsx:163` 缺少 `format !== 'pdf'` 判断；改为共用一个辅助函数。 |
| P23 | 资料按日期分组且默认全部折叠；显示“排版提取 v2”之类的术语。 | A1 M9, A2 F-06 | L | 最新一组默认展开 |
| P24 | JSON 导入：原始 JSON 被存成一份资料；缺字段的卡片没有警告；“AI 建议”实际没有改动任何内容。 | A2 F-20 | M | |
| P25 | PdfImport 的文案自相矛盾。 | A2 F-19 | L | `ui/PdfImport.jsx:53,57` |

### E. 出题、任务与草稿

| ID | 问题 | 来源 | 级 | 代码 / 方向 |
|---|---|---|---|---|
| P26 | 点生成后跳回学习库，仍显示“还没有卡片”；任务进度和草稿在页面最底部，排在“全局笔记本”下面，容易让人重复点生成。 | A1 N2, A2 F-02 | H | `ui/StudyMap.jsx:835,868-960` |
| P27 | 生成表单保留上一次的标题、题型和题数。 | A2 F-16 | M | |
| P28 | 任务卡：不显示题组名；两个停止按钮功能重复；取消后的文案不对。 | A2 F-17 | M | `ui/StudyMap.jsx:905-960` |
| P29 | 中文界面里混入英文进度文案，并暴露“子代理”“直接模型调用”等工程术语。 | A2 F-11 | M | 后端发阶段码，前端负责翻译（`lib/generation.js:233`、`lib/contexts/jobs/operations.js:28,31`）。 |
| P30 | 草稿编辑器粗糙：选项行布局、sticky 栏遮挡内容、单张卡约 2400px 高、“答案”和“正确选项”重复、只能添加闪卡、保存后没有反馈。 | A2 F-14 | M | `ui/Draft.jsx:395-415` |
| P31 | 发布后自动开一轮练习，但没有“结束本轮”；轮次进行中不能改名或编辑；题组管理页粗糙（复选框错位、显示原始的 `flashcard`、文件夹和课程概念重叠）。 | A2 F-10, F-22 | H | `ui/Manage.jsx`、`ui/Draft.jsx:217` |
| P32 | 在应用内跳转页面时，新页面停在上一页的滚动位置。 | A2 F-15 | M | 页面切换时统一重置滚动 |
| P33 | 学习库的题组列表有 4 个只显示 3 个。 | A2 F-23 | L | |

### F. 练习与复习

| ID | 问题 | 来源 | 级 | 代码 / 方向 |
|---|---|---|---|---|
| P34 | 👎 托盘 1.2 秒就自动关闭并提交笼统反馈；题目随后被原地改写，没有任何提示。 | A2 F-08 | M | `ui/ThumbFeedback.jsx:17,91-103` |
| P35 | 填空题按 Enter 不提交；多选题用鼠标点完选项后按 Enter 反而取消选择。 | A2 F-09 | M | `ui/Cloze.jsx:90`、`ui/App.jsx:957` |
| P36 | 复习细节问题：一轮的总题数会增长；斩题后撤销，题不回到本轮；翻回正面仍显示评分；0–5 评分对闪卡过重；填空题字号偏小；420px 宽度下计数换行。 | A2 F-28, F-29 | L | |
| P37 | 考试页头写“10 题”，实际只有 7 题；有时限的考试计时器却是正计时。 | A2 F-24 | L | `ui/Exam.jsx:338` |
| P38 | 口头模拟其实要打字作答；“1 题回答扎实”的标题误导；追问的校验太弱。 | A2 F-25 | M | `lib/oral-exam-service.js:15-26` |
| P39 | 错题本的“练”按钮要悬停才出现；快捷键说明表的字太小、会遮挡内容；确认交互不一致（有的用原生 `confirm`，有的没有确认）。 | A2 F-21, F-26, F-27 | L | |
| P40 | 知识图谱默认全屏打开，Esc 退不出，文字过小。 | A3-14, A2 F-32 | M | `ui/App.jsx:1783-1787` |

### G. 只能在 DSH 对话里用的 AI 功能

| ID | 问题 | 来源 | 级 | 代码 / 方向 |
|---|---|---|---|---|
| P41 | 17 处 `askInChat`：知识骨架**只能**在对话中生成；主题归并、学习流设计 / 调整 / 讲解、录题、“在对话中分析 / 讲解”、工作区出题、“问”都依赖对话。在 DSH 之外，它们只会复制一段带工具名和英文系统前言的提示词。 | A3 §7, A2 F-07 | B | 改为 DSH 子代理后台任务，结果通过信箱交付（沿用做题页 `assistCard` 已跑通的模式）。 |
| P42 | “帮我弄懂”在预览里报 `Unknown study action: assist.start`，因为这个动作只由宿主处理。 | A2 F-07 | H | 预览和所有外壳都要支持。 |
| P43 | 录题横幅一直显示“在对话里直接贴题目”，但没有任何东西会处理它。 | A2 F-07 | M | |

### H. 音频与课堂

| ID | 问题 | 来源 | 级 | 代码 / 方向 |
|---|---|---|---|---|
| P44 | 没有密钥时音频导入不设门槛：文件完整上传后才失败；错误渲染在视口外或模态框后面；报错里出现环境变量名。 | O-2, A1 A2, A3-01/02 | B | `ui/AudioImport.jsx:343-385,465`、`lib/audio-job.js:127`、`ui/App.jsx:1684` |
| P45 | 没有国内可用的免费服务商；密钥配置复杂（两个不同 Google 项目的 Gemini Key、外加 Groq）；没有获取链接，也没有地区说明。 | O, A3-03, A1 A3 | H | 新增硅基流动 SenseVoice 层，中文用户默认推荐；音频密钥改走 DSH 凭据。 |
| P46 | 超过 1 小时的 m4a 要求用户手动用 ffmpeg 转码；同批次一个文件失败，其余显示“已取消”且不说原因；页脚费用提示出现的时机不对。 | O-1 | H | `lib/audio-file.js:248-253`、`lib/audio-batch.js:189-247` |
| P47 | 音频高级设置太多（模型 ID、并发、推理矩阵、10–11px 小字）；用量控制台对所有人展示。 | A3-04/05 | M | |
| P48 | 课堂实录：先申请麦克风再检查密钥；原样显示英文 “Not supported”；只支持 Gemini；总是译成简体中文。 | A3-09/10 | H | `ui/live-client.js:42-57`、`ui/LiveClass.jsx:120-127` |
| P49 | 音频失败信息泄露内部字段名（`titleZh` / `titleEn`）；设置里写的密钥存放路径不对。 | A3-08, A1 A4 | M | |

### I. 设置

| ID | 问题 | 来源 | 级 | 代码 / 方向 |
|---|---|---|---|---|
| P50 | 设置是一整页堆叠：学习库、模型、音频、推理矩阵、陪学、study-lib-spar 导入、SM-2 参数、备份全在一起；页面标题和导航名称不一致；导出文件名不带日期，导出后也没有提示。 | A2 F-31, A3-22..26 | M | 分区重组；不常用的放进“高级”。 |

### J. 视觉与设计系统

| ID | 问题 | 来源 | 级 | 代码 / 方向 |
|---|---|---|---|---|
| P51 | 设计系统碎片化：约 45 种按钮类名、5 种选中态写法、7 种页头、4 种页宽、8 种以上空状态、约 45 种字号、30 种圆角；没有“成功”提示样式；75 处原生 `details`；图标混用 unicode 和 emoji。 | A3 B | H | 设计令牌 v2 + 统一组件库 |
| P52 | 对比度不够：`--text-faint` 被用于正文，深色 3.34:1、浅色 2.57:1；还有 10–11px 的小字。 | A3-29 | M | `ui/style.css:37-38,95-96` |
| P53 | 全局提示固定在 main 顶部，5 秒后消失，还会残留到别的页面；不跟随视口。 | A3-02, A3-21 | H | 改为视口内的页面级 Toast |
| P54 | 模态框有两套实现，层级被限制在 Study 区内，会被 DSH 界面盖住。 | A1 M3, A3 B | H | 统一的 Dialog |
| P55 | 加载屏总是深色；主题循环按钮要看提示框才知道下一个状态；语言切换的选中态看起来是反的。 | A3-28/30/31 | L | |

### K. 文案、术语与多语言

| ID | 问题 | 来源 | 级 | 代码 / 方向 |
|---|---|---|---|---|
| P56 | 术语不友好：斩、陪学、自动驾驶、未自动审阅、单选 MQ；学习流 / 学习库 / 学习目录 / 知识骨架 / 知识图谱容易混淆。 | A2 F-12 | M | 术语表 + 重命名 |
| P57 | 国际化缺陷：硬编码的英文小标题（如 ACROSS WORKSPACES）；“· 前”被误译成“Previous”；存在三套 i18n 机制；浏览器原生错误直接显示。 | A3-27 | M | |

### L. 开发与验证工具

| ID | 问题 | 来源 | 级 | 代码 / 方向 |
|---|---|---|---|---|
| P58 | 预览服务器每个请求都新建 StudyService，所以看不到任务卡片，上传总是失效，也不支持 `assist.start`。 | A2 D-1, A3 | H | `scripts/dev.mjs:124` |
| P59 | 模拟模型太简单：单选 / 多选 / 填空的生成必然失败；没有口头模拟的追问。 | A2 D-2 | M | 移植 `audit/A2/server.mjs` 里按题型生成的模拟作者 |
| P60 | 没有自动化旅程回归脚本，也没有 DSH 0.2 端到端脚本；版本需要锁定（npx 缓存是 0.1）。 | R1, A1 | H | |

### M. 独立端与 DSH 二次开发（新能力）

| ID | 内容 | 来源 |
|---|---|---|
| P61 | 学习模式预设（插件自带）+ 个人学习库 | O-7, R1 |
| P62 | 顶级 StudyHub 页面 + 不依赖会话的学习库通道 + 外壳配置行 | R1 |
| P63 | 独立外壳包：默认预设 / 个人学习库 / 服务商卡片 / 隐藏编程界面 / 品牌；启动器优先使用桌面版运行时，否则用便携 Node | R1 |
| P64 | 音频密钥改走 DSH 凭据，一个硅基流动 Key 同时供对话和转写使用 | R1 |

**值得保留的**（各走查共同确认）：
- 发布后直接进入一轮练习；
- 选择题反馈出色（漏选 / 错选、逐项解析）；
- 后台帮助 + 信箱交付 + 撤销的模式；
- 学习流能在应用内完整跑通；
- 斩题可以撤销；
- 考试报告清晰；
- 恢复备份前有预览和自动备份；
- 颜色已全部令牌化，深浅色一致；
- 420px 窄屏布局良好；
- 英文覆盖基本完整；
- 原始 PDF 查看器可以选中原文并关联题目；
- 音频导入器本身（多文件排序、字幕捷径）。

## 3. 已拍板的决定（用户，2026-10-01）

- **D1 新用户主路径：资料 → 内置出题为主。**
  - 首页和创建题组默认引导“添加资料 → 用资料出题”，配合示例数据演示效果。
  - JSON 导入保留为醒目的第二入口（“已有题目 / 外部 AI 生成的题”）。
  - 这条取代 F-009，记为 F-024。
- **D2 独立端数据目录（3.0.0）：独立的 `~/.studyhub`。** 会话、工作区和凭据都与 DSH 的编程会话隔离；模型 Key 需要单独配置一次。插件版继续使用 `~/.dsh`。
- **D3 实现方式：worktree 分支并行 + 本地集成。** 每个子代理在独立的 worktree 分支上测试先行并提交；在本地集成分支 `codex/studyhub-overhaul` 上逐个合并、跑全量验证；全程不推送远端。
- **D4 示例数据：设计模式示例，跟随界面语言。**
  - 复用体验版的 Memento / Bridge 内容，并补写中文版。
  - 载入时按当前界面语言选择版本。
  - 内容包括资料原文、题组、学习记录、错题、知识骨架、学习流和笔记，可以一键移除。

## 4. 共享契约（所有工作包遵守）

- **C1 组件库（WP1 提供）。**
  - 组件放在 `ui/components/`：Button / IconButton、SegmentedControl、PageHeader、EmptyState、InlineMessage、Toast（视口内、页面级、支持成功色）、Banner、SetupRequired、FileDrop、Dialog（基于 `showModal()`）、Disclosure、Panel，以及扩充后的 Icon。
  - 组件 CSS 放在 `ui/components/*.css`，由 `useInjectCss` 注入；`ui/style.css` 只由 WP1 修改令牌区块。
- **C2 文案分片。** `ui/i18n.js` 会合并 `ui/locales/en.json` 和 `ui/locales/en.*.json`。每个工作包只写自己的分片：`en.import.json`、`en.generate.json`、`en.audio.json`、`en.practice.json`、`en.agent.json`、`en.host.json`、`en.shell.json`、`en.onboarding.json`、`en.copy.json`。
- **C3 宿主能力（WP7 提供）。** `binding.get` 和快照返回：
  ```text
  host: { edition: 'plugin'|'standalone'|'preview', chat: boolean, agentTasks: boolean, landing: boolean }
  model: { ready, reason: 'ok'|'no-route'|'no-credential'|'unknown', label, provider, model }
  ```
  前端只依据这些字段显示或隐藏功能，不再靠 `host.askInChat` 是否存在来猜。
- **C4 AI 后台任务（WP6 提供）。**
  - 动作 `agent.task.start {kind, args}` → 返回任务；结果进入信箱。
  - kind 包括：`skeleton.generate | skeleton.update | topics.group | workflow.design | workflow.step.help | deck.analyze | weak.explain | ingest.parse`。
  - DSH 宿主用子代理执行，子代理可以调用学习库工具；不具备该能力的外壳隐藏这些入口。
- **C5 资料分组（WP2 提供）。** `lib/source-groups.js` 的 `groupSourcesByDocument(sources)`，资料页、出题页和导览共用。
- **C6 示例数据（WP9 提供）。** 动作 `sample.status | sample.load {language} | sample.remove`；示例数据 id 带 `sample-` 前缀或 `sample:true` 标记。
- **C7 导览（WP9 提供）。** 页面上的目标元素用 `data-tour="<id>"` 标注；各工作包新建页面时要保留或添加稳定的 `data-tour` 锚点。
- **C8 测试文件。** 每个工作包只新建自己前缀的测试文件（如 `tests/import-*.test.mjs`），修改已有测试时要在报告里说明。

## 5. 工作包与波次

> **范围与优先级调整（用户，2026-10-01）。**
> - 独立端属于 **3.0.0**；本轮只修插件版，并保证不妨碍后续解耦（见第 8 节）。
> - **当务之急是降低插件装好后的上手成本、提高指引质量**，所以第 1 波只做上手关键路径。

每个工作包都要：
1. 先写失败测试，并记录红灯输出；
2. 实现；
3. `npm run verify` 全绿；
4. 界面改动用 WP0 的旅程脚本截图（中英文、深浅色、1440 和 420 宽）；
5. 在独立的 worktree 分支上提交，并在最终回复里报告：改了什么、测试结果、截图路径、遗留问题。

| 波次 | 工作包 | 范围（拥有的文件） | 先写的失败测试（示例） | 覆盖痛点 |
|---|---|---|---|---|
| 0 | **WP0 验证工具** | `scripts/dev.mjs`、`scripts/fake-model.mjs`、`scripts/qa/*`（新） | 同一个学习库跨请求复用同一运行时，任务卡可见；`assist.start` 可用；模拟模型能为每种题型返回合法结构；旅程脚本能跑通“空库 → 添加资料 → 出题 → 发布 → 练习”的关键步骤并截图。 | P58–P60, P42 |
| 0 | **WP1 上手所需组件** | `ui/components/*`（新）：FileDrop、SetupRequired、Toast（视口内、页面级、成功色）、InlineMessage、Dialog（`showModal()`）、EmptyState、PageHeader、Button 变体；`ui/ModalFrame.jsx`、`ui/ActionFeedback.jsx`（改为用新组件实现）；`ui/i18n.js`（文案分片）；`ui/style.css` 只改令牌区块（对比度、字号下限） | 组件的服务端渲染结构和 ARIA 属性；FileDrop 在 drop 时调用 `stopPropagation`、支持多文件和键盘操作；Dialog 使用 top layer；对比度令牌 ≥ 4.5:1；文案分片能被合并。 | P05, P53, P54, P52（部分）, C1, C2 |
| 1 | **WP2 入口与宿主** | `lib/index.js`、`lib/host.js`（能力标记、模型就绪、学习库位置）、`ui/host/*`、`presets/study.patch.yml`（新）、`cordis.patch.yml`、`package.json` 的 `dsh` 字段；`ui/App.jsx` 顶栏和学习库位置提示 | 学习模式预设能被加载（DSH 0.2 隔离端到端测试）；模型就绪的各种原因（无路由 / 无凭据）；能力标记（C3）；Study 首次启用后自动打开、加入可发现的入口（顶级页面或侧栏卡片）；Study 主视图给 DSH 输入框让出空间；标签名改为 StudyHub。 | P01, P03（可见性）, P04, P06, P14, P15, P61 |
| 1 | **WP3 资料与导入** | `ui/ImportHub.jsx`（新）、`ui/SourcePicker.jsx`（新）、`ui/Sources.jsx`、`ui/document-preview/DocumentImport.jsx`、`ui/PdfImport.jsx`、`ui/JsonImport.jsx`、`lib/source-groups.js`（新）；`ui/App.jsx` 中 sourceForm 的接线 | 按文档分组（PDF 合成一项、可展开到页）；Markdown 不再被标成“旧版”；导入后关闭弹窗、显示 Toast 并高亮新项；课程字段放在最前；按文件类型自动路由；音频入口降为次要。 | P18–P23, P21 |
| 1 | **WP4 出题与首页流程** | `ui/Generate.jsx`、`ui/StudyMap.jsx`（首页英雄区、任务 / 待发布区）、`ui/GenerationTrace.jsx`、`lib/generation.js` 与 `lib/contexts/jobs`（阶段码） | 默认标签为“用资料出题”（D1）；英雄区按状态给出主操作（无资料时添加资料，有资料时用资料出题）；任务和待发布草稿出现在顶部；生成表单在提交后重置；阶段码能被翻译；失败时给出人话加“去设置模型”按钮。 | P08, P09, P12, P15, P26–P29 |
| 1 | **WP5 导览、示例数据与欢迎页** | `ui/tour/*`（新）、`lib/sample-library.js`（新）；删除 `ui/Guide.jsx`；`ui/App.jsx` 的导航顺序、欢迎页和导览接线；各页面的 `data-tour` 锚点（第 4 节的锚点清单） | 示例数据通过真实的存储操作载入，并能干净地移除；导览每一步都能切到对应页面并找到目标元素；导航顺序；欢迎页显示在主区；中英文导览文案齐全。 | P10, P11, P13, D4 |
| 1 | **WP6 音频上手门槛** | `lib/audio-settings.js`、`lib/groq.js`、`lib/gemini.js`（新增硅基流动层）、`ui/AudioImport.jsx`、`ui/AudioSettings.jsx`、`ui/AudioDashboard.jsx`、`ui/LiveClass.jsx`、`ui/live-client.js` | 硅基流动转写层（只返回 `{text}`、限 50MB / 1h、按顺序回退）；没有服务商时先显示门槛、不开始上传；错误在原位显示、用人话写、附“打开音频设置”；麦克风前先检查密钥；中文用户默认推荐硅基流动，并附获取步骤与链接；用量控制台在首次转写后才显示。已有的密钥必须继续可用。 | P44, P45, P47, P48, P49 |
| 2 | **WP12 案例分析训练（终极考察）**（第 1 波合并后立即开始，第 2 波最先做） | 新题型（案例场景 + 多个子问题 + 分值 + 结构化评分标准 + 参考答案）；来源：课程资料出新案例 / 仿照粘贴的真题出同类题 / 粘贴现成题目与答案直接批改；长文本作答与可选计时；DSH 后台助手按评分标准逐条给分、引用原句、列遗漏要点和改写建议，结果进信箱，参考答案在批改后揭晓；薄弱评分项转成针对性练习并进入间隔复习；模拟考试新增“案例分析卷” | 结构化评分标准的校验；按题型和分值生成案例的结构；阅卷结果的结构、每项分数不超过分值；薄弱项转练习；案例考卷计时与结果页 | F-031 |
| 2 | **WP7 长音频与批次** | `lib/audio-file.js`、`lib/audio-batch.js`、`lib/audio-job.js` | 用真实 m4a 样本验证无损切分；提交前预检；一键“分段并继续”；兄弟文件不再无故被取消；页脚费用提示只在执行过文本步骤时显示。 | P46 |
| 2 | **WP8 练习打磨** | `ui/Review.jsx`、`ui/Cloze.jsx`、`ui/ThumbFeedback.jsx`、`ui/Exam.jsx`、`ui/OralExam.jsx`、`ui/WrongBook.jsx`、`ui/ShortcutHelp.jsx`、`ui/Graph.jsx`、`ui/Draft.jsx`、`ui/Manage.jsx` | 填空和多选按 Enter 提交；托盘直到用户选择或按 Esc 才关闭，改写后有提示；考试题数正确；图谱默认内嵌显示；可以结束本轮；改题组名不需要先建草稿；页面切换时重置滚动。 | P30–P40 |
| 2 | **WP9 AI 后台任务** | `lib/agent-tasks.js`（新）、`lib/assist*.js`；`lib/host.js` 中 `agent.task.start` 一段；`ui/Skeleton.jsx`、`ui/SkeletonCanvas.jsx`、`ui/Workflows.jsx`、`ui/WorkflowPortal.jsx`、`ui/Ingest.jsx`、`ui/topic-group-prompt.js` | 每种 kind 都能启动、取消，结果写进信箱；不再复制含系统前言的提示词。 | P41–P43 |
| 2 | **WP10 文案、术语、设置与令牌** | `ui/locales/*`、`ui/Settings.jsx`、`ui/style.css`、各处文案 | 中英对照扫描（禁止硬编码 JSX 文本）；术语表；设置分区；令牌 v2 全面替换。 | P50–P57 |
| 2 | **WP11 文档**（由我负责） | `README*.md`、`docs/install*.md`；链接检查脚本 | 快速上手只有 5 步；有费用表；所有链接返回 200。 | P02, P07 |
| 3 | **整体验收** | 重跑 A1 / A2 / A3 的旅程脚本，在 DSH 0.2 隔离环境里端到端测试插件版 | 新用户从装好插件到做第一道题的步骤数显著下降；第 2 节中的阻塞级和高优先级问题全部关闭。 | 全部 |
| 3.0.0 | 独立外壳与启动器 | `packages/studyhub-shell/*`、`packages/studyhub-launcher/*` | 见 `docs/plans/2026-10-01-studyhub-3.0-standalone-notes.md` | P62–P64 |

**合并顺序：** WP0 → WP1 → WP2 → WP3 → WP4 → WP5 → WP6，然后第 2 波。每合并一个就跑一次全量验证。

- 多个工作包会改 `ui/App.jsx`、`ui/StudyMap.jsx` 和 `lib/host.js`。各自只改自己负责的那几段，冲突在集成时由我解决。
- **WP5 负责的导览锚点：** WP3 和 WP4 在自己的文件里按锚点清单添加 `data-tour`；其余页面的锚点由 WP5 添加。

**导览锚点清单（`data-tour`）：**
- `nav`、`nav-library`、`nav-sources`、`nav-generate`、`nav-wrongbook`、`nav-exam`、`nav-dashboard`、`nav-skeleton`、`nav-workflows`、`nav-settings`、`tour-reopen`
- `home-hero`、`home-today`、`home-catalog`
- `sources-list`、`sources-add`
- `import-drop`
- `generate-from-sources`、`generate-submit`
- `review-question`、`review-help`
- `wrongbook-list`、`exam-start`、`dashboard-summary`、`skeleton-main`、`workflows-main`
- `settings-model`、`settings-audio`、`settings-sample`

## 6. 子代理安全规则

见 `scratchpad/audit/BRIEF.md` 中的“MANDATORY isolation recipe”：
- 清除所有继承的 `*_API_KEY` / `*_TOKEN` / `*BASE_URL` 环境变量；
- 设置 `SSH_TTY`，让文件夹选择在浏览器内完成；
- 使用本地安装的 DSH 0.2.0-rc.2 和模拟模型；
- 不碰 `~/.dsh`，不推送远端。

## 7. 风险

- **DSH 0.x 接口变化快。** 锁定版本，并在 CI 里跑 dump-config 快照和端到端测试。
- **有几处不能通过配置修改：** 页面标题、首页文案、模型的身份行。预设名称也不支持多语言。
- **多个工作包都要改 `ui/App.jsx`**，存在合并冲突。
- **m4a 切分需要真实样本**，并验证各服务商是否接受切出的片段。

## 8. 为 3.0.0 独立端预留的解耦护栏（本轮必须遵守）

1. **宿主相关代码只放在宿主适配层**：`lib/index.js`、`lib/host.js`、`ui/host/*`。`ui/` 中其余组件只读宿主能力标记（C3）和 `host` 属性，不直接访问 DSH 的 `ctx`、slots、sessions 等接口。由 `tests/architecture-boundaries.test.mjs` 扩展规则来守住。
2. **不新增“把提示词塞进对话框”的写法。** 新的 AI 功能一律走 C4 动作，由宿主实现。
3. **学习库路径只在一处解析**（`binding`）。3.0 的个人学习库通过配置项 `libraryRoot` 提供；本轮不改变现有插件用户的默认位置，只让位置在界面上可见，并提供明确的“改用个人学习库”选项。
4. **学习模式预设和工具注册都由插件 bundle 提供。** 3.0 的外壳只把它设为默认。
5. **面向用户的品牌名统一为 StudyHub**，不在界面上写死“DSH”。确实只有 DSH 才有的功能，用能力标记控制显示与否。
6. **R1 实测跑通的 3.0 方案**（profile、外壳 bundle、启动器、桌面版运行时、服务商卡片、隐藏编程界面）记录在 `docs/plans/2026-10-01-studyhub-3.0-standalone-notes.md`，避免调研成果丢失。
