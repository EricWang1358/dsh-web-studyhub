# 交互伴学与搭配工具

[English](companions.md)

StudyHub 内置了跨学科**交互伴学**逐句舞台与编译器（`studyhub-lesson/1`），可以为任意学科生成自包含的交互式 HTML 课程；同时，遇到别处已经做得很好、又很重的事，StudyHub 会推荐成熟的开源工具，并给它留一个干净的沙箱进出口，不会复制或重做它们的代码，也和它们的作者没有合作关系。

## 交互伴学：跨学科逐句舞台生成与本地伴学包联动

StudyHub 内置了**交互伴学**（Interactive Companions）沙箱舞台与跨学科编译器（`studyhub-lesson/1`），既能直接为任意学科生成零依赖、自包含的交互式 HTML 伴学材料，也能原位挂载本地伴学目录（例如包含 `pages/*.html`、`lessons/*.json`、`projects/` 与 `feedback/questions.json` 的实验仓库）。

### 跨学科交互 HTML 生成任务（`generation.companion.build`）

在「课程总纲」或「资料」页点击**交互伴学**（或按 `Ctrl/⌘ K` 搜索「伴学」），即可按四阶段流水线（分镜蓝图 → 上半场精写 → 下半场精写 → 公式求值与 18 项教学不变量校验）生成 16–20 页单文件 `.html`（面板提供数学、哲学、机械工程、计算机四大跨学科一键示例）：

- **四大跨学科交互母版与舞台积木**共用同一套「单舞台 + 底部老师逐句口语领读」引擎（零外部网络请求）：
  - **数理参数与相平面沙盒（`sandbox`）**：纯 AST 确定性求值（零 `eval`），既支持 **1D 多曲线参数函数**（`expr`）与水平阈值带（`threshold`），也支持 **2D 参数轨迹**（`xExpr` / `yExpr`）、归一化**相平面方向向量场 / 箭图**（`field`）以及随滑块实时移动的**平衡点 / 工作点标记**（`markers`），适合微积分、常微分方程、理论与控制力学、热力学循环及宏观经济学（内置一键典型工况预设 `presets`、`Reset` 归零按钮、`Shift + ←/→` 精细调参与十字准星精确读数）。
  - **思辨反例矩阵（`dialectic`）**：思想实验反例矩阵（`matrix`，支持 `predictBeforeReveal` 先猜后看、`Reveal all` / `Reset` 全局对比与方向键单元格聚焦）及双立场苏格拉底交锋泳道（`lanes`）。
  - **闭环矢量框图与力流路径（`mechanism`）**：支持闭环反馈二次贝塞尔曲线绕行（避免控制回路或力流穿过中间模块）、节点点击详情以及 `Step trace` / `Reset` 逐步因果推演的分步矢量框图（`schematic`）。
  - **代码实证、前提找茬、诊断自测与实操演练（`empirical`、`spot`、`quiz`、`try`）**：逐行聚焦走读、并发交错时间轴（`inside`）、支持全键盘操作与无行号纯净划选的前提/证明/代码找茬（`spot`）、逐干扰项揭示错因 `why` 且严格守护首次作答 `self-check` 真实性的边界自测（`quiz`），以及带可勾选步骤、持久化草稿板、提示与参考解法的 `try` / `workshop` 实操积木。
- **基于 `temml` 的编译期 W3C MathML Core 渲染（`lib/companion-template/mathml.js`）**：离线货币安全 `$...$` / `$$...$$` 编译器，底层采用纯 JS 零依赖的 `temml`（MIT，`{ xml: true, throwOnError: false, trust: false }`），在编译期将公式转为标准 XML `<math>` 存入 `lesson._math` 侧表，完整覆盖分段函数 `\begin{cases}`、矩阵与行列式 `bmatrix` / `vmatrix`、定积分与环路积分 `\int_a^b` / `\oint`、求和与极限 `\sum` / `\lim`、上下花括号、范数与内积 `\|x\|` / `\langle u, v \rangle`、牛顿/拉格朗日时间导数 `\dot{x}` / `\ddot{x}`、`\operatorname{...}` 以及形式与模态逻辑符号（`\vdash`、`\models`、`\Box`、`\Diamond`、`\forall`、`\exists`、`\implies`、`\iff`），浏览器端正文保持纯 `textNode` 渲染。
- **模块化运行时与 Sandpack 式 `ready` 握手队列（`lib/companion-template/runtime/`、`ui/diagram-frame.js`）**：伴学运行时拆分为独立模块（`dom.js`、`blocks-core.js`、`blocks-visual.js`、`math-sandbox.js`、`renderer.js`、`bridge.js`、`i18n-*.js`）。宿主与 iframe 之间通过带令牌校验的 `studyhub-companion/1` 协议进行 `ready` / `ping` 握手，在 iframe 就绪前将 `theme`、`goto`、`labels` 等消息按 FIFO 排队并去重合并，就绪后原子冲刷，杜绝首屏主题同步或页码跳转竞态丢失。
- **双落盘、主会话零密钥直编与诚实溯源**：生成结果同时明文写入 `<工作区>/companions/<课程>/<slug>.html` 与 `.lesson.json` 并自动挂载到课程（主对话亦可加载内置 `study-companion` 技能，无需单独配置模型密钥直接调用 `companion.compile` 编译并挂载交互课）。勾选讲义时智能提取高信号结构化摘录；无资料自由命题时正常出课并诚实标注为 `AI 推演`（`grounded: false`）。

### 本地伴学包挂载、未构建 JSON 即时编译与学习交互体验（`companion.attach`、`companion.sync`）

1. **支持单文件、目录与原始 `lessons/*.json` 伴学包（`companion.attach`）**：
   - 在面板选择**挂载本地目录 / HTML**，可挂载单个 `.html` 或整个伴学目录。
   - 若目录内包含尚未构建成 HTML 的 `lessons/<slug>.json`（包括引用 `<目录>/projects/` 或 `src/` 下 `of: "<pkg>.<Class>"` 源码片段的实验配置，路径严格限制在已授权目录内），StudyHub 会自动解析源码并在打开时实时编译出完整交互 HTML 舞台。
   - 伴学页超过 6 节（如百节规模伴学包）时，课程伴学栏自动提供即时关键词搜索与「全部 / 学习中 / 已学完」进度筛选。
2. **智能双模导题、全工作台双向深链与一键磁盘重同步（`companion.sync`）**：
   - 已有题组的课程自动走**增强挂载（`enrich-existing`）**：零 Token 高置信关联现有卡片（`card.companionRef`）并挂载精确 `#页码` 锚点，同时补充开口复述题（`say`），绝不产生重复闪卡。
   - 空白课程自动走**全量导题（`full-pack`）**：零 Token 确定性编译带走闪卡、边界自测、情境案例题、口述题与实操 `task` 评分卡；扎实走完伴学页后授予**首学采信（First-Pass Credit）**，避免当天重复抽考。
   - **全场景双向深链跳转**：凡关联伴学课的卡片或投影讲义，在**闪卡练习揭晓页**、**错题与薄弱项**、**管理题组**、**本轮回顾**及**资料阅读器**（`src-companion-<id>`）中均提供一键**打开伴学课第 N 页** / **打开交互伴学**入口，无需重载已挂载舞台即可直达对应页码。
   - 当外部原位挂载文件在磁盘更新（`changedOnDisk`）时，阅读器顶栏提供一键**同步讲义与卡片**（`companion.sync`），自动刷新 SHA-256、投影讲义与关联卡片，并完整保留已有 FSRS-6 复习进度。
3. **内置阅读器与独立 HTML 伴学体验**：
   - **沉浸展开模式、一键导出 HTML、底部快速跳页与深浅色实时联动**：窄侧栏（`360px–480px`）下可点**展开舞台**全幅浏览相平面与框图，支持一键**导出 HTML** 下载完全离线的单文件课程，并通过令牌校验的 `postMessage` 快速跳页及实时同步深浅色主题。
   - **`#toc-pop` 全课页码目录、`?` 快捷键帮助与 `@media print` 讲义打印导出**：点击底部页码（`N / Total`）或按 `g` 键即可呼出带节拍标签与访问状态的**全课目录（Slide Map）**，按 `?` 查看键盘操控说明；直接打印或导出 PDF 时自动切换为多页**讲义模式（Study-Sheet Mode）**（浅色纸面墨色、自动展开卡片与参考答案、无 `100vh` 截断）。
   - **页内划词秒问与 `feedback/questions.json` 双向同步**：划选句子自动展开右侧抽屉并聚焦提问框；支持零消耗查本课术语与前置题、秒问导师（`companion.ask`）、一键**存入「伴学拾遗」**（次日复习），以及双向原子同步外部目录的 `feedback/questions.json`（可在抽屉折叠面板直接浏览待解决疑问并一键跳回对应页）。
4. **零备份膨胀**：目录挂载模式（`linked`）在便携备份中占用 **0 字节**额外体积，同时保留离线可读的完整投影讲义；单文件托管模式（`managed`）随便携备份完整导出与恢复。

## Archify：把知识骨架画成可交互的图

[Archify](https://github.com/tt-a1i/archify) 是 tt-a1i 做的开源（MIT 协议）agent 技能。你描述一件事，或让它读一份方案、一个代码库，它会写出**一个自包含的交互式 HTML 文件**：架构图、流程图、时序图、数据流图、生命周期图，还有学习地图。文件离线也能在浏览器里打开（里面的外部链接需要联网）。可以看[项目主页](https://tt-a1i.github.io/archify/)和[在线示例](https://tt-a1i.github.io/archify/gallery.html)。

**为什么推荐。** StudyHub 自带的「知识骨架」页（有「脉络」和「结构图」）能看出概念怎么连起来，但只是朴素的结构视图。Archify 画得更漂亮，还能点着看。所以 StudyHub 推荐它，并且接收它画出来的图。

### 安装

Archify 自己的 README 列出了 DeepSeek Harness 的插件。在终端里运行：

```
dsh plugin --profile web add @tt-a1i/archify-dsh@1.0.0
```

命令里的 `web` 是 DSH 的 profile 名，请换成你正在用的：浏览器里是 `web`，桌面版通常是 `desktop`。「知识骨架」页上的推荐卡片也显示这条命令，旁边有「复制」按钮。要卸载：`dsh plugin --profile web remove @tt-a1i/archify-dsh`。其他 agent 用 `npx skills add tt-a1i/archify -g`。当前版本请看 Archify 的 README；`1.0.0` 是写这页时对照的版本。

### 一步一步，怎么交给它

1. 打开「知识骨架」，再打开一份保存好的骨架。
2. 点「用 Archify 画这门课的知识骨架」。StudyHub 会把一段很短的提示词填进 DSH 对话输入框（对话没有输入框时就复制到剪贴板），你看过再发送。
3. 助手用 `skeleton.get` 读骨架，再用 `archify` 技能画图。它会挑最合适的图类型：概念画成节点，前置关系画成箭头，对比和因果画成带文字的关系。骨架里记的是每个概念挂着哪些题，没有掌握度，所以图上最多标出覆盖情况。
4. 助手把 HTML 写进你的工作目录（例如 `diagrams/<标题>.html`），再用 `skeleton.diagram.attach {id, path, title?}` 登记。
5. StudyHub 把文件复制进学习库，列在骨架下面的「交互图」里：标题、日期、大小；骨架在图之后被改过，会写「骨架已更新，图可能过期」。
6. 「打开」在 StudyHub 里显示它；「删除」只删学习库里的那份副本，不动你工作目录里的原文件。

如果没有装 `archify` 技能，助手会直说，并给你上面的安装命令，不会自己画别的东西来代替。

### 文件存在哪里，StudyHub 怎么处理它

- 副本在 `<学习库>/skeleton-diagrams/<骨架 id>/<图 id>.html`；骨架上有一条很小的记录（标题、日期、大小、文件的 SHA-256、图是照哪一版骨架画的）。两者都在完整的学习库备份里，恢复时一起回来（文件丢了的会被跳过，打开那条记录时会说明）。
- 每份骨架最多 **8 张图**。第 9 张会替换最早的一张，助手会被告知是哪一张。同一个文件再登记一次，什么都不会变。
- StudyHub **不会运行、修改或发送**这个文件，也不会把它交给任何模型调用，它只留在你的学习库里。
- Archify 有一个可选的更新提醒，可能请求一个固定的清单；这个请求是 Archify 自己的，发生在你用 Archify 的时候，StudyHub 不发起，也看不到。

### 威胁说明：显示一份 AI 写的 HTML

这个文件里可能有任何脚本，StudyHub 把它当作不可信的内容。

**登记时接受什么。** 只接受一个普通文件：解析了所有链接之后的真实路径在当前会话的工作目录或学习库里；不超过 5 MB；是一份 UTF-8 文档，开头像 HTML 页面（`<!doctype html>` 或 `<html>`）。路径在这两个文件夹之外、链接指到外面、文件夹、二进制文件、JSON 文件、过大的文件，都会被拒绝并说明原因。工作目录由 StudyHub 设定，不由请求给出。

**打开时怎么做。**

- 文档放在 `sandbox="allow-scripts"`、不加其他任何标志的 `iframe` 里。里面的脚本能运行（交互靠它），但它是一个不透明的源：读不到 StudyHub 的页面、存储和 cookie，不能让页面跳转、提交表单、弹出窗口、下载文件或弹对话框；里面访问 `parent.document` 会直接报错。
- 用 `srcdoc` 传入，不是网址；除了 `referrerpolicy="no-referrer"` 和 iframe 的 `csp` 属性外，还在 `srcdoc` `<head>` 内注入 `<meta http-equiv="Content-Security-Policy">`，确保 Chromium、Firefox 与 Safari 均一致挡住 `fetch`、XHR、WebSocket 和表单提交。图里从网络加载图片或字体仍然可以，这类请求不带你的任何信息。
- 在文档头部最前面加了一小段脚本，让点链接时图停在原处（指向别的页面的链接不会在应用里打开；页内的 `#` 链接照常）。这只是方便，真正的保护是沙箱。
- 窗口里有一行提示：这是外部生成的图，在隔离窗口里显示。

它挡不住的：一个页面占用你的 CPU，或者画出误导人的内容。不信任的图，删掉就好。

## 其他外部搭配

重型的 PDF 转换和检索各有独立指南：[大教材](large-documents.zh-CN.md)和[用 MinerU 转换 PDF](mineru-conversion.zh-CN.md)（MinerU 可在 StudyHub 内通过「一键安装」装到本机）。
