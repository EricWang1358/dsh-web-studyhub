---
artifact_contract: "ce-handoff/v1"
created_at: "2026-09-12T21:02:01Z"
title: "dsh-daily-flashcard 0.2.0 study workspace progress and future visualization ideas"
summary: "DSH 原生学习插件 feat/study-workspace 已完成 0.2.0（学习目录、学习地图、跨题组前置题、录题与恢复），19 测试通过；下一段畅想是为单个/合并题库生成横向分叉的思维导图与学习路径顺序图。"
keywords: ["dsh-daily-flashcard", "study-workspace", "sm2", "prerequisite", "study-map", "mindmap", "learning-path", "handoff"]
cwd: "D:\\A\\1NUS\\1Sem\\dsh-daily-flashcard"
resume_focus: "在 0.2.0 稳定基础上，规划并实现题库级/跨题库的思维导图与横向分叉学习路径图"
repository: "dsh-daily-flashcard"
repo_root_sha: "f19192d5e3e91e93a78501e007d48abfee6699b6"
branch: "feat/study-workspace"
head: "56d41b1"
worktree_path: "D:\\A\\1NUS\\1Sem\\dsh-daily-flashcard"
---

# Handoff: dsh-daily-flashcard — 0.2.0 研究工作区进度与未来可视化畅想

## 目标与用户最新意图

项目是 DSH（DeepSeek Harness）原生 npm 学习插件，把 `study-lib-spar` 的内容质量规则与 SM-2 调度落成可持久化的闪卡/测验工作区。当前分支 `feat/study-workspace` 上 0.2.0 的学习工作区功能已完成并验证。用户（明确 expressed）在本 session 的诉求是：

1. 写一份 handoff 记录当前项目进度（本文档）。
2. 把用户的未来功能畅想写进去，核心一条：**对工作区某一个题库、或某几个题库合并起来，生成思维导图 / 学习路径顺序图（用户描述为“横着的分叉的那种”）**。用户用“比如”开头并说“等也写进去”，说明这是畅想清单的第一条、后续可能继续补充——下次会话应先问用户是否还有新想法要并入清单。

## 已完成的工作（0.2.0，已提交至 HEAD 56d41b1）

分支最近 5 个提交勾勒出完整脉络（`git log --oneline`）：

- `f19192d` source-grounded study engine 与持久复习状态（SM-2、尝试日志、单文件工作区存储）。
- `9b02799` 原生学习工作区：受控生成 + 审题发布流程（author → editor → repair → re-review）。
- `91bf209` 题组维护与可恢复学习流程（暂停/归档/错题重练/编辑冲突检测/中断恢复）。
- `616835d` 学习地图、对话工作流（`/study-spar`、现场对话录题、问 AI、提升质量）与宿主原生默认值。
- `56d41b1` 跨题组前置题链接（`lib/prereq.js`，75 行）与学习地图细化。

功能全貌以 [README.md](README.md) 为准（中文，与实现同步维护）：首页学习目录（今日学习、目录树掌握度、掌握度推算）、现场对话录题、前置题体系（`requiredBy`/`card.link`、循环依赖拒绝、答对连带记通过）、资料→生成→草稿→学习→复习→逐步讲解六段流程、0.2.0 的手工建卡/已发布题组编辑/归档暂停。

## 当前状态

- 工作树 clean；`feat/study-workspace` 跟踪 `origin/main` 且两者同指 `56d41b1`——即分支内容实际上已在 origin/main 上，**分支命名与追踪关系不一致**，下次会话值得确认是合并/推送方式造成的，还是需要理顺分支策略。
- 验证状态：[docs/verification.md](docs/verification.md)（2026-09-12）记录 `npm test` 19 通过 0 失败，覆盖 SM-2 公式、原文引用校验、并发写、草稿冲突、归档暂停等；`npm run build` 产出 DSH classic-module client + 独立浏览器预览。浏览器端用 Playwright 验证过桌面与窄屏布局（详情见该文档）。
- 打包产物在仓库根：`ericwang1358-dsh-daily-flashcard-0.2.0.tgz`（已通过 `npm pack` 产出）。
- 结构速览：核心逻辑在 `lib/`（`service.js`、`store.js`、`mastery.js`、`prereq.js`、`generation.js`、`ingest.js`、`legacy.js`、`batch.js` 等），UI 在 `ui/`（`App.jsx`、`StudyMap.jsx` 665 行、`Ingest.jsx`、`Guide.jsx`），测试在 `tests/`（core/host/integration/transport 四个文件），领域参考文档原样保留在 `references/`（content-quality、library-schema、sm2-scheduling、recruitment-prep）。
- 本地预览：`node scripts/seed-demo.mjs .\output\preview-library` 后 `npm run dev -- --library=.\output\preview-library`，打开 http://127.0.0.1:4178 。

## 未来功能畅想（用户意图，未开工）

1. **思维导图 / 学习路径顺序图（横向分叉）**：对工作区内选定的**一个题库，或多选题库合并后的范围**，生成可视化图谱。用户明确描述为“横着的分叉的那种”（根在左、子分支向右展开的横向树/路径图）。
   - 现有可复用地基：`ui/StudyMap.jsx` 已有学习地图（目录树 + 掌握度颜色），`lib/prereq.js` 已有前置题有向图（含循环依赖检测），掌握度由 `lib/mastery.js` 从 SM-2 间隔推算——图的数据来源（目录层级、前置边、掌握度）都已存在，缺的是“选定单个/多个题库 → 构图 → 横向分叉渲染”这一层。
   - 待定的设计问题（下次会话需与用户确认，属用户决策）：多题库合并时跨库前置边如何取；思维导图节点粒度（目录/题组/主题/单题）；是否要“学习路径顺序”与“知识结构”两种视图；是否支持导出（SVG/图片）；掌握度是否映射为节点颜色。
2. **用户已确认想做的更多功能**（2026-09-13 由 agent 基于现有数据与地基提出、用户逐条筛选确认，范围 2/3/4/6/7/8；未排期）：
   - **学习统计仪表盘**：GitHub 风格连续学习热力图、掌握度趋势曲线、薄弱主题榜；数据全部已存在于尝试日志，缺的是可视化。
   - **模拟考试模式**：跨题库抽题组限时卷，交卷出成绩单与薄弱点分布，错题直接回流学习路径；与 `references/recruitment-prep.md` 的备考定位契合。
   - **跨题库错题本**：聚合所有题库最近答错的题、一键重练；现有「错题重练」是按题组的，跨库只差一个视图。
   - **源文高亮回链**：点击题目引用跳到原文并高亮该段；引用逐字比对已提供定位信息，纯 UI 工作。
   - **跨工作区笔记本联合视图**：在跨工作区笔记本 registry（未提交的 `lib/notebooks.js` 工作，全局目录 `~/.dsh/study/notebooks.json`）之上做全局到期队列、跨库搜索，并承接第 1 条——多题库合并学习路径图可直接跑在 registry 之上，两条线在此汇合。
   - **完形填空 / 挖空卡**：对资料自动生成挖空题，作为第五种题型；复用现有生成→审题→发布管线的 kind 参数。
3. **明确不做的（用户筛掉）**：考试倒计时/备考计划、导出互通（Anki/CSV/Markdown）——agent 曾提议，用户未选。
4. **开放项**：用户说“等也写进去”，此清单 intentionally 留白，下次会话先收集新增畅想再排期。

## 约束与易踩的坑

- `study-workspace.json` 是版本化单文件唯一事实源，跨进程文件锁 + 原子替换；不要引入第二存储或就地改旧 Markdown。
- 质量约束硬编码：单选恰好一个正确项、多选不允许全对、干扰项必须有解析、逐字原文引用由代码检查——任何生成/编辑路径都要过同一校验。
- 生成任务在宿主进程内排队，宿主重启会中断未完成任务；单次生成 1–30 题、60,000 字符自动分段、合计上限 600,000 字符。
- 不解析 PDF/图片/网页，只收提取后的文字。
- 判分语义：选择题代码判分，开放问答/闪卡自评，两者不可混。
- 宿主 SDK peer deps（`@deepseek-ai/dsh-tools`、`dsh-llm`）不可解析时核心测试仍可跑，host 测试显式跳过。

## 建议的下一步（推荐一条连续路径）

先与用户确认畅想清单是否还有新增，然后针对“横向分叉学习路径图”做一次设计确认（数据源：目录树 + 前置边 + 掌握度；渲染：复用/扩展 `ui/StudyMap.jsx` 还是新组件），再实现。它自然延续 `56d41b1` 的跨题组前置与学习地图工作，不需要先还任何技术债；验证沿用 `npm run verify`（test + build）+ seed-demo 预览。
