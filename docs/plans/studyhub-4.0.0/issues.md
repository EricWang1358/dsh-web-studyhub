# StudyHub 4.0.0 Kanban Issue 详细规格与具体实现思路

> 本文件定义 `SH4-01` 至 `SH4-12` 共 12 个可由不同 Agent 认领的 Kanban Issue。
> 每个 Issue 均遵循「高内聚、低耦合、契约先行、测试守门」原则，明确标注修改文件边界与具体代码实现思路。

---

<a id="sh4-01"></a>
## SH4-01 · [Phase 0] 宿主与现有链路核实、手动原型与 Phase 0 决策拍板

> **GitHub Issue**：[#534](https://github.com/EricWang1358/dsh-web-studyhub/issues/534)（`CLOSED` · Gate-0 已达成）
> **验收产物**：[`docs/plans/studyhub-4.0.0/p0-baseline-audit.md`](p0-baseline-audit.md) · [`tests/guided-study-p0-characterization.test.mjs`](../../../tests/guided-study-p0-characterization.test.mjs) (5/5 PASS)

- **阶段**：Phase 0（所有后续阶段的前置门禁）
- **覆盖范围**：第 5 章 Phase 0、第 10 章 6 项需拍板决策
- **前置依赖**：无
- **文件范围（只读核验 + 文档与特征测试，不改生产逻辑）**：
  - 新增：`docs/plans/studyhub-4.0.0/p0-baseline-audit.md`
  - 新增：`tests/guided-study-p0-characterization.test.mjs`

### 具体实现思路

1. **六项源码事实核验与结论固化**（已在 3.7.4 代码库初步定位，需由认领 Agent 用特征测试锁定）：
   - **决策 1（`StudySession` 归属上下文）**：核验 `lib/runtime/domain-contracts.js`。`study` 上下文已拥有 `['runs', 'attempts', 'oralRuns', 'teaching']` 且读取 `['study', 'bank', 'materials', 'system', 'notifications', 'learner', 'workflow-data', 'courses']`，无需新增跨上下文依赖即可完成有界现场聚合。拍板将 `studySessions` 归入 `study` 上下文（`mode: 'item'` 独立分片），避免新建第 20 个上下文造成图膨胀。
   - **决策 2（薄封装 vs 现有工具）**：核验 `lib/runtime/tools.js` 与 `lib/index.js`。现有 `study_workspace`、`study_bank`、`study_materials`、`study_practice`、`study_generate_selection` 保持不变；仅在 `study.v1`（及 `study_workspace` 路由）补齐紧凑现场读取 `study.scene.get` 与会话生命周期 `study.session.*`，不新建顶层 Agent Tool。
   - **决策 3（`panel.open` 显示确认与措辞规则）**：核验 `lib/index.js:402-428`、`lib/panel-bridge.js` 与 `ui/host/workspace.jsx:128-148, 278-282`。目前 `panel.open` 仅调用 `queuePanelIntent` 并立即返回 `queued_for_sidebar`，客户端每 `1800ms` 轮询 `panel.intent.next` 并通过 `panel.visible` 回报。确认可通过 `intentId` + `panel.visible` 序列号对账实现「有限等待确认（`visible_in_sidebar`）+ 超时诚实降级（`queued_for_sidebar`）」。
   - **决策 4（原生草稿保存位置与恢复路径）**：核验 `lib/study-state.js` 与题卡组件。确认在 `run.entries[i].draft` 保存未提交输入（选项草稿/开放题文本草稿/步骤草稿），切题与重启均可从 `runs` 分片恢复。
   - **决策 5（单题 + 小范围生成等待与费用基线）**：用可控假模型与真实链路测量 `selection.supplement { count: 1 }` 的阶段耗时与 token 开销，记录在 `p0-baseline-audit.md`。
   - **决策 6（检验项展示与调整交互）**：主会话通过 `study.session.update` 提出/调整检验项；右侧状态面板提供轻量勾选/重命名/删除微调（直接调用同一动作，不调模型）。
2. **编写特征测试 `tests/guided-study-p0-characterization.test.mjs`**：
   - 锁定 3.7.4 现有的 `panel.open`、`panel.current`、`card.followup.add`、`book.write`、`review.start` 行为基线，确保后续改动向下兼容。

### 质量与验收门禁
- `node --test tests/guided-study-p0-characterization.test.mjs` 全绿；
- `p0-baseline-audit.md` 完整记录 6 项决策的源码行号证据与基线指标。

---

<a id="sh4-02"></a>
## SH4-02 · [Phase 1 · 领域模型与存储] `StudySession` 纯领域模块、分片契约与 `guidedStudy4` 开关

> **GitHub Issue**：[#535](https://github.com/EricWang1358/dsh-web-studyhub/issues/535)

- **阶段**：Phase 1
- **覆盖用例**：UC-01（开始一段带学）、UC-11（临时问答不建记录）
- **前置依赖**：`SH4-01`
- **文件范围（独占修改）**：
  - 新增：`lib/study-session.js`（高内聚纯领域模块）
  - 修改：`lib/runtime-config.js`（新增默认关闭开关 `guidedStudy4`）
  - 修改：`lib/runtime/domain-contracts.js`（`fields.study` 增加 `'studySessions'`，登记 `study.session.*` 写集）
  - 修改：`lib/runtime/builtins.js`（确保 `studySessions` 以 `mode: 'item'` 分片持久化）
  - 修改：`lib/assistant-boundary.js`（强制 HB-1：拒绝主会话工具代答或直接写掌握状态）
  - 新增：`tests/study-session.test.mjs`

### 具体实现思路

1. **数据结构与纯函数校验（`lib/study-session.js`）**：
   - 定义并校验 `StudySession` 结构：
     ```js
     // StudySession schema
     {
       id: string,
       courseId: string,
       scope: Array<{ kind: 'source' | 'document' | 'deck' | 'chapter', id: string, revision?: string }>,
       goal: {
         title: string,
         checkItems: Array<{
           id: string,
           title: string,
           weight: number, // 默认 1
           targetCardIds?: string[],
           topic?: string,
         }>,
         scopeNote?: string,
       } | null,
       settings: {
         allowNewQuestions: boolean,
         autoOrganizeQA: boolean,
         allowNoteEdits: boolean,
       },
       focus: { kind: 'card' | 'source' | 'bookPoint' | 'artifact', id: string, deckId?: string, runId?: string, anchor?: object } | null,
       returnPath: Array<{ kind: 'card', runId: string, deckId: string, cardId: string, index: number, reason?: string }>, // 上限 MAX_RETURN_DEPTH = 5
       artifactRefs: Array<{ id: string, kind: 'explanation' | 'derivation' | 'comparison' | 'diagram', title: string, topic?: string, sourceAnchors: Array<{ sourceId: string, page?: number, quote?: string }>, markdown: string, updatedAt: number }>, // 上限每会话 20 个，单个 <= 12000 字符
       predictions: Array<{ at: number, reason: string, minMinutes: number, maxMinutes: number, remainingItems: number }>, // 目标明显变化时追加，上限 10 条
       status: 'active' | 'paused' | 'ended',
       version: number,
       createdAt: number,
       updatedAt: number,
     }
     ```
   - 实现纯函数：
     - `createStudySession(state, input)`：校验 `courseId` 与 `scope` 必须存在于用户当前学习库的已授权课程/资料中（不存在或越权则抛 `study-scope-denied`）；初始化 `version: 1`；**绝不写入任何掌握率或完成标记**。
     - `updateStudySession(state, input)`：强制校验 `expectedVersion === session.version`（冲突抛 `study-session-version-conflict`）；若修改 `settings` 扩大权限，必须带有显式用户授权标记；若修改 `goal.checkItems` 导致分母变化，强制记录 `goal.scopeNote`。
     - `upsertTeachingArtifact(session, artifactInput)`：支持 `operationId` 幂等重放（在 `session.receipts` 保留最近 32 条操作回执）；校验 `markdown` 不含 `<script>`、内联事件或外部可执行脚本。
     - `assertScopeAllowed(session, targetRef, state)`：供后续 QA、出题、笔记动作统一调用的范围守卫纯函数。
2. **上下文操作注册（`lib/contexts/study/operations.js`）**：
   - 新增动作：`study.session.start`、`study.session.get`、`study.session.list`、`study.session.update`、`study.session.artifact.save`、`study.session.pause`、`study.session.end`。
   - 临时问答（UC-11）：普通 `source.get`、`selection.ask`、`card.get` 不自动创建 `StudySession`。

### 解耦与性能设计
- `lib/study-session.js` 为零 I/O 纯模块，所有函数接收纯数据对象并返回新状态或抛出带 `code` 的领域错误。
- `studySessions` 采用 `mode: 'item'`，每次更新仅写入当前会话对应的单个 ~2 KB JSON 分片。

### 质量保证与验收测试
- `tests/study-session.test.mjs`：
  - 测试越权 `scope`（引用不存在或非本课程资料）被拒绝；
  - 测试版本冲突（`expectedVersion` 不匹配）被拒绝；
  - 测试 `operationId` 重复调用 `study.session.artifact.save` 幂等返回原回执，不产生重复教学块；
  - 测试 `tests/architecture-boundaries.test.mjs` 与 `tests/unified-runtime-rollback-read.test.mjs` 保持全绿。

---

<a id="sh4-03"></a>
## SH4-03 · [Phase 1 · 现场读取] 有界紧凑现场读取 `study.scene.get` 与快照指纹复用

> **GitHub Issue**：[#536](https://github.com/EricWang1358/dsh-web-studyhub/issues/536)

- **阶段**：Phase 1
- **覆盖用例**：UC-01、UC-04（作答后求助读取现场）
- **前置依赖**：`SH4-02`
- **文件范围（独占修改）**：
  - 新增：`lib/study-scene.js`（高内聚有界现场投影纯模块）
  - 修改：`lib/contexts/study/operations.js`（接入 `study.scene.get`）
  - 新增：`tests/study-scene.test.mjs`

### 具体实现思路

1. **有界现场聚合纯函数 `buildCompactScene(viewState, options)`（`lib/study-scene.js`）**：
   - 输入：`storagePort.view()` 提供的冻结视图（零拷贝）、`{ sessionId?, includePrompt?: boolean, sinceFingerprint?: string }` + 来自 `panelBridge` 的当前可见观察值 `panelObservation`。
   - 聚合内容（严格有界）：
     - `session`：当前活动 `StudySession` 的摘要（`id`、`courseId`、`scope` 引用列表、`goal`、`settings`、`status`、`version`、`returnPath`）；
     - `focusObject`：当前聚焦题目或教学块摘要：
       - 若为题目：返回 `{ deckId, cardId, runId, kind, topic, prompt (截断至 600 字符，附 truncated 标记), options, revealed, draft, hintUsed }`；**未揭示（`revealed === false`）时，面向学习者侧视图隐藏标准答案，面向主会话教学诊断提供 `answerSummary` 与错因辅助上下文，但严禁暴露代答接口**；
     - `recentAttempts`：限定当前会话范围或当前题最近 ≤ 5 条真实作答记录（含 `at`、`correct`、`grade`、`selected`、`assistance` 提示/揭示使用标记）；
     - `relatedQARefs`：当前题关联的 QA 条目摘要（仅 `id`、`question`、`source`、`updatedAt`，正文按需通过引用展开）；
     - `progressSummary`：若已接入 `lib/study-progress.js` 则返回紧凑分子分母摘要；
     - `fingerprint`：基于 `(session.version, focusRun.queueVersion, latestAttemptAt, panelObservation.signature)` 计算的轻量确定性哈希。
   - **指纹短路**：若调用方传入 `sinceFingerprint === fingerprint`，立即返回 `{ unchanged: true, fingerprint }`，节省主会话上下文 token。

### 解耦与性能设计
- **严禁全库扫描与全库克隆**：通过索引/ID 直接定位 `session`、`run` 和最近尾部 `attempts` 分块（`attempts` 是 chunked 存储，只读最后一个 chunk），时间复杂度 $O(1)$ / $O(k)$。
- 性能守卫：在 1,000 份资料、2,900 道题的基准测试中断言单次 `study.scene.get` < 10 ms，序列化 JSON 大小 ≤ 4,096 bytes。

### 质量保证与验收测试
- `tests/study-scene.test.mjs`：
  - 验证返回体积上限（长题干、大量历史 QA、1000 份资料库下输出仍 ≤ 4 KB）；
  - 验证 `sinceFingerprint` 命中时返回 `{ unchanged: true }`；
  - 验证最新提交、提示使用、揭示状态与草稿在现场中准确反映。

---

<a id="sh4-04"></a>
## SH4-04 · [Phase 1 · 桥接与输入保护] `panel.open` 显示确认回执、过期请求防抢焦点与切题草稿持久化

> **GitHub Issue**：[#537](https://github.com/EricWang1358/dsh-web-studyhub/issues/537)

- **阶段**：Phase 1
- **覆盖用例**：UC-03（定位已有练习）、UC-05（切题草稿保护）、UC-10（无法确认右侧显示时诚实降级）
- **前置依赖**：`SH4-01`
- **文件范围（独占修改）**：
  - 修改：`lib/panel-bridge.js`
  - 修改：`lib/index.js`（`panel.open` 与 `panel.current` 扩展）
  - 修改：`lib/study-state.js` 与 `lib/contexts/study/operations.js`（新增 `review.draft.save` 与 `entry.draft` 恢复）
  - 修改：`ui/host/workspace.jsx`（意图消费序列号、脏输入草稿自动保存与防抢焦点）
  - 新增：`tests/panel-bridge-confirm.test.mjs`、`tests/review-draft-persistence.test.mjs`

### 具体实现思路

1. **`lib/panel-bridge.js` 显示确认与防过期机制**：
   - 为每个 `queuePanelIntent(sessionId, intent, now)` 分配单调递增的 `intentSeq` 与唯一 `intentId`，记录 `issuedAt` 及可选的 `expectedFocus`。
   - 新增 `ackPanelIntent(sessionId, { intentId, status: 'displayed' | 'deferred_by_user_activity', placement, runId })`：
     - 当右侧面板成功消费 `panel.intent.next` 并渲染目标对象后，客户端立即回调 `panel.visible`（携带 `ackIntentId`）。
     - `bridge.waitForIntentAck(sessionId, intentId, timeoutMs = 2200)`：在服务端等待客户端确认（基于事件 Promise，无忙轮询）。
     - 若在窗口内收到 `displayed` 确认：`panel.open` 返回 `{ status: 'visible_in_sidebar', confirmed: true, intentId, ... }`（主会话可诚实说"已在右侧打开"）；
     - 若超时未收到确认（如右侧栏未挂载或宿主不支持）：返回 `{ status: 'queued_for_sidebar', confirmed: false, intentId, ... }`（主会话按 UC-10 只能说"已请求在右侧打开"）；
     - 若客户端检测到用户在 `issuedAt` 之后主动切换了其他视图或正在高频输入且无法中断，客户端先自动保存草稿或将意图挂为顶部非侵入提示条，返回 `{ status: 'deferred_by_user_activity', confirmed: false }`，绝不强行抢走焦点！
2. **原生题卡未提交草稿持久化（`review.draft.save`）**：
   - 在 `run.entries[i]` 上支持可选字段 `draft: { selected?: string[], text?: string, stepInputs?: Record<string, string>, updatedAt: number }`，以及 `assistance: { hintUsed?: boolean, revealedBeforeAnswer?: boolean, askedTutorBeforeAnswer?: boolean }`。
   - 在 `lib/contexts/study/operations.js` 新增轻量动作 `review.draft.save { runId, cardId, draft, assistance }`（写入 `runs` 分片）。
   - 当主会话调用 `panel.open` 或支线切换前，以及用户在题卡输入防抖（或失焦/卸载）时，自动将未提交输入落盘到 `run.entries[i].draft`。宿主重启后重新打开该 `run`，题卡自动从 `entry.draft` 恢复未提交文本与选项！

### 解耦与性能设计
- `waitForIntentAck` 使用内存 Resolver Map，确认到达时 0 ms 唤醒；测试中可注入 `ackTimeoutMs: 50` 避免慢测试。
- `review.draft.save` 仅更新当前单个 `run` 分片（`mode: 'item'`），耗时 < 5 ms。

### 质量保证与验收测试
- `tests/panel-bridge-confirm.test.mjs`：
  - 测试客户端回报 `ackIntentId` 时返回 `visible_in_sidebar`；
  - 测试客户端未挂载时返回 `queued_for_sidebar`；
  - 测试旧 `intentSeq` 迟到到达时被丢弃，不覆盖新焦点。
- `tests/review-draft-persistence.test.mjs`：
  - 测试用户在开放题输入一半文字、未提交时切换题目并模拟宿主重启，恢复后草稿文字与已展开提示状态 100% 保留。

---

<a id="sh4-05"></a>
## SH4-05 · [Phase 1 · 右侧工作台 UI] 右侧带学工作台容器、安全富文本教学块与按动作自适应布局

> **GitHub Issue**：[#538](https://github.com/EricWang1358/dsh-web-studyhub/issues/538)

- **阶段**：Phase 1
- **覆盖用例**：UC-01、UC-02（讲解在右侧呈现）、UC-10（模型不可用开场降级）
- **前置依赖**：`SH4-02`、`SH4-04`
- **文件范围（独占修改）**：
  - 新增：`ui/guided-study/GuidedStudyWorkbench.jsx`
  - 新增：`ui/guided-study/TeachingArtifactBlock.jsx`
  - 新增：`ui/guided-study/guided-study.css`
  - 修改：`ui/workspace-views.jsx`（注册懒加载视图）
  - 新增：`tests/guided-study-workbench-ui.test.mjs`

### 具体实现思路

1. **四区域单工作台容器（`ui/guided-study/GuidedStudyWorkbench.jsx`）**：
   - 围绕当前 `StudySession` 组织四个逻辑区域，消除多页管理跳转：
     1. **顶部紧凑目标栏**：显示本次学习范围、当前知识点、暂停/结束按钮；若 `modelReady === false`（UC-10），顶部明确提示"当前模型不可用：AI 带学讲解与出题已暂停，你仍可正常阅读资料、做已有练习、复习与查看 QA"。
     2. **当前教学内容区（`TeachingArtifactBlock.jsx`）**：渲染 `StudySession.artifactRefs` 中的当前教学块（原文锚点跳转按钮、公式推演、概念对照表、受控 SVG/Mermaid 图示）。
     3. **当前练习区**：内嵌复用现有的原生题卡渲染器（保持一致的客观题判分、填空、开放题自评与提示揭示体验）。
     4. **本题 QA / 笔记与底部状态折叠栏**：展示当前关联 QA 与简要状态。
2. **按当前动作自适应主次布局（纯状态驱动，零CLS跳动）**：
   - 根据 `session.focus.kind` 自动切换折叠权重：
     - `focus.kind === 'artifact' | 'source'`（正在讲推导/看原文）：教学内容区展开为主视图，练习区收起为紧凑卡片入口；
     - `focus.kind === 'card'`（正在做题/支线练习）：原生题卡占主空间，教学内容收起为顶部可展开参考条（点击可随时对照公式，不丢答题输入）；
     - 查看状态时：展开进度与检验项详情。
3. **严格安全渲染（HB-8）**：
   - `TeachingArtifactBlock` 直接复用项目现有的 Markdown + KaTeX 公式渲染与 HTML/SVG 白名单清洗器，禁止 `dangerouslySetInnerHTML` 执行未清洗内容，禁止外链脚本与网络请求，且组件不接收任何修改 `attempts` / `runs` 成绩的回调。

### 解耦与性能设计
- 整个 `ui/guided-study/` 作为独立懒加载 chunk 挂载在 `ui/workspace-views.jsx`，不增加首屏包体积。
- 样式遵循现有 CSS 变量主题（深浅色兼容），预留固定骨架高度避免 CLS 布局偏移。

### 质量保证与验收测试
- `tests/guided-study-workbench-ui.test.mjs`：
  - 验证 `focus.kind` 在讲解与做题间切换时四区域正确折叠/展开；
  - 验证恶意脚本输入（`<script>`、`onerror=`、`javascript:` 链接）被完全剥离；
  - 验证 `modelReady: false` 时降级横幅准确显示且已有题练习按钮可正常交互。

---

<a id="sh4-06"></a>
## SH4-06 · [Phase 2 · 求助与支线导航] 作答后求助现场、有限返回栈 `returnPath` 与题卡「请教」预填

> **GitHub Issue**：[#539](https://github.com/EricWang1358/dsh-web-studyhub/issues/539)

- **阶段**：Phase 2
- **覆盖用例**：UC-04（作答后求助）、UC-05（补前置/对照支线并返回原题）、UC-10（面板不能主动发消息时预填）
- **前置依赖**：`SH4-03`、`SH4-04`
- **文件范围（独占修改）**：
  - 新增：`lib/study-branch.js`（支线压栈与返回纯模块）
  - 新增：`ui/agent-prompts/guided-study.js`（题卡「请教主会话」预填消息纯函数）
  - 修改：`lib/contexts/study/operations.js`（新增 `study.branch.open`、`study.branch.return`）
  - 新增：`tests/study-branch.test.mjs`、`tests/guided-study-ask-chat.test.mjs`

### 具体实现思路

1. **有限支线返回栈 `lib/study-branch.js`（UC-05）**：
   - 实现 `openBranchCard(state, { sessionId, targetDeckId, targetCardId, reason, branchKind: 'prerequisite' | 'contrast' | 'variation' })`：
     1. 自动保存当前原题的草稿状态（若存在未提交输入）并记录原题位置 `{ runId, deckId, cardId, index, reason, branchKind }`；
     2. 压入 `session.returnPath`（若深度达到上限 5，拒绝继续嵌套并提示先返回上一层，防止无限迷航）；
     3. 为支线题创建独立的单题练习轮次 `run`（`mode: 'path'`, `branchOf: { sessionId, parentRunId, parentCardId }`），**绝不修改或重置原题所在的 `run` 和历史 `attempts` 成绩**；
     4. 更新 `session.focus` 指向支线题，并通过 `panelBridge` 请求右侧打开。
   - 实现 `returnFromBranch(state, { sessionId, targetStepIndex? })`：
     1. 从 `session.returnPath` 弹出顶层（或指定层）原题引用；
     2. 恢复 `session.focus` 到原题 `runId` 与 `cardId`；原题保存的 `entry.draft`、`revealed`、轮次状态原样重现。
2. **原生题卡「请教主会话」预填（`ui/agent-prompts/guided-study.js`，UC-04 & UC-10）**：
   - 沿用复习全书 `ui/agent-prompts/book.js` 与 `useSendToChat` 的成熟模式：
   - 当用户在右侧题卡点击「请教主会话」时：
     - 先记录本题 `assistance.askedTutorBeforeAnswer = true`（若尚未提交答案）；
     - 生成结构化短消息：第一行是用户可读的自然语言（如"我在这道题卡住了，想请教一下思路"），下方附带紧凑围栏元数据 `[StudyHub Context: sessionId=..., runId=..., deckId=..., cardId=...]`（不塞入整篇讲义原文，让主会话按需调用 `study.scene.get`）；
     - 调用 `host.askInChat(prompt)`：若填入成功显示「已填入主会话输入框，请确认后发送」；若输入框已有用户草稿则保留原字并复制到剪贴板；**绝不声称已自动发送**。

### 解耦与性能设计
- `lib/study-branch.js` 与原题判分完全解耦：支线 `run` 与原题 `run` 是两个独立的 `runs` 分片记录，互不污染。
- `ui/agent-prompts/guided-study.js` 为双语纯函数，不依赖 DOM。

### 质量保证与验收测试
- `tests/study-branch.test.mjs`：
  - 验证「原题输入草稿 → 开前置支线 → 完成支线作答 → 返回原题（含模拟宿主重启后返回）」全链路：原题草稿、揭示状态、历史成绩 100% 完好，支线作答独立记入 `attempts`。
- `tests/guided-study-ask-chat.test.mjs`：
  - 验证「请教」按钮预填格式、已有输入框文字保护与剪贴板降级回执。

---

<a id="sh4-07"></a>
## SH4-07 · [Phase 2 · QA 与笔记归位] 幂等 QA/笔记归位、来源标注、题级—知识点级引用关联与版本保护

> **GitHub Issue**：[#540](https://github.com/EricWang1358/dsh-web-studyhub/issues/540)

- **阶段**：Phase 2
- **覆盖用例**：UC-06（QA 与笔记归位）
- **前置依赖**：`SH4-02`
- **文件范围（独占修改）**：
  - 新增：`lib/guided-qa.js`（高内聚 QA 归位与引用核对模块）
  - 修改：`lib/contexts/study/operations.js` 及 `lib/contexts/bank/operations.js`（扩展 `card.followup.add` 幂等与元数据支持，新增 `study.qa.organize`）
  - 新增：`tests/guided-qa.test.mjs`

### 具体实现思路

1. **题级 QA 幂等写入与来源溯源（`lib/guided-qa.js`）**：
   - 实现 `saveGuidedQA(state, { sessionId, operationId, target: { kind: 'card' | 'topic', deckId?, cardId?, course?, hid? }, question, answerMarkdown, citations?, linkToTopic?: { course, hid }, allowOverwriteUser?: boolean, expectedVersion? })`：
     - **授权检查（HB-3 & HB-6）**：校验目标属于 `session.scope`；若用户未开启 `autoOrganizeQA` 且本次调用未带 `explicitUserCommand: true`，拒绝自动写入；
     - **幂等去重（HB-5）**：检查目标对象的 `qaReceipts` 中是否已存在相同的 `operationId`。若存在且内容摘要一致，直接返回原保存回执（防止模型重试产生两条重复 QA）；若 `operationId` 相同但内容不同，抛出 `qa-idempotency-conflict`；
     - **来源与修订标注**：写入的 QA 条目强制带上 `{ id, operationId, author: 'ai-organized', sessionId, createdAt, updatedAt, revision: 1, citations, history: [] }`；
     - **引文轻量比对**：若 `answerMarkdown` 或 `citations` 声明引用了课程资料，调用现有的 `lib/quote-match.js` 做零成本逐字核对；匹配成功的保留精确资料锚点，未匹配上的剥离伪造引文并在返回值 `warnings` 中如实告知主会话；
     - **用户内容保护（HB-6）**：默认只追加新 QA 或更新 `author === 'ai-organized'` 的条目；当用户明确要求"重新组织我这段笔记"（`allowOverwriteUser: true` 且 `session.settings.allowNoteEdits === true`）时，强制检查 `expectedVersion`，将用户原内容压入 `history` 修订栈后再更新，支持随时一键回退。
2. **知识点级引用关联（不复制多份）**：
   - 当 `linkToTopic: { course, hid }` 传入时，在对应知识点笔记/书页 QA 区只写入一条轻量引用指针 `{ kind: 'card-qa-ref', deckId, cardId, qaId, summary }`，渲染时动态读取题级 QA 单一事实源，消除多处副本不一致。
3. **出题隔离边界**：
   - 标记 `author: 'ai-organized'` 的 QA 默认不进入 `generation.v1` 的出题事实源列表；除非用户主动将个人笔记导入为正式材料。

### 解耦与性能设计
- 复用现有 `lib/quote-match.js` 纯函数进行引文比对，不启动任何额外模型调用。

### 质量保证与验收测试
- `tests/guided-qa.test.mjs`：
  - 验证相同 `operationId` 重试 3 次只生成 1 条 QA；
  - 验证未授权覆盖用户手写笔记被拒绝；授权修改时 `expectedVersion` 冲突被拒绝，且修改后可通过 `history` 完整回退到用户原话；
  - 验证知识点级关联只存引用指针，修改题级 QA 后知识点视图同步反映最新内容。

---

<a id="sh4-08"></a>
## SH4-08 · [Phase 2 · 单题审核生成接入] 小范围单题生成审核接入与右侧准备态/失败人话反馈

> **GitHub Issue**：[#541](https://github.com/EricWang1358/dsh-web-studyhub/issues/541)

- **阶段**：Phase 2
- **覆盖用例**：UC-07（准备一道经审核的新题）、UC-10（无法生成新题时降级）
- **前置依赖**：`SH4-04`、`SH4-05`
- **文件范围（独占修改）**：
  - 新增：`lib/guided-question-prep.js`（单题准备编排与状态投影）
  - 新增：`ui/guided-study/QuestionPrepSlot.jsx`（右侧题卡准备态/失败态/取消组件）
  - 修改：`lib/contexts/study/operations.js`（新增 `study.question.prepare`）
  - 新增：`tests/guided-question-prep.test.mjs`

### 具体实现思路

1. **复用现有生成审核链路（绝不造第二套快速未审核通道，HB-7）**：
   - 实现 `study.question.prepare { sessionId, operationId, sourceIds, selection?, kind?, focus?, targetDeckId? }`：
     - **权限与能力门禁**：
       1. 检查 `session.settings.allowNewQuestions === true`（否则拒绝并提示只复用已有题）；
       2. 检查 `sourceIds` 落在 `session.scope` 内，且请求的 `count` 强制限定为 `1`（小范围单题）；
       3. 检查当前模型可用性（无模型时按 ADR-04 立即返回 `{ available: false, reason: 'model_unavailable', fallback: 'reuse_existing' }`）。
     - **委托现有 `generation.v1`**：
       - 调用现有的 `selection.supplement`（或单题生成作业契约），传入 `count: 1`、`operationId`、目标课程内部的会话专属题组（默认不公开、不发布到外部）；
       - 在 `StudySession.focus` 记录 `{ kind: 'preparing-card', jobId, operationId, startedAt }`；
       - 生成过程经过既有的「规划 → 答案蓝图 → 编写 → 代码引文核对 → 独立审核」完整守卫，费用单独计入 `generation` 特性账本。
2. **右侧真实准备状态与失败人话说明（`ui/guided-study/QuestionPrepSlot.jsx`）**：
   - 当 `focus.kind === 'preparing-card'` 时，右侧练习区展示真实的作业状态（复用 `jobs.v1` 状态与 `lib/generation-failure.js` 的人话分类）：
     - `queued / running`：显示当前阶段（规划/编写/独立审核中）、预计等待提示与「取消准备」按钮；期间主会话可继续在左侧讲解，不锁死界面；
     - `complete`：审核通过落盘后，自动切换为可作答的原生题卡；
     - `partial / failed / cancelled`：按 `lib/generation-failure.js` 显示人话原因（如"所选段落未能核对出可作答引文"或"模型响应超时"），并提供「改用已有题练习」按钮，绝不把未通过审核的残次草稿或聊天文本塞进正式题卡。

### 解耦与性能设计
- 100% 复用 `generation.v1`、`jobs.v1` 和 `lib/generation-failure.js`，零重复建设后台队列或重试器。

### 质量保证与验收测试
- `tests/guided-question-prep.test.mjs`：
  - 验证未审核通过的候选卡绝不能进入 `runs` 作答；
  - 验证 `allowNewQuestions: false` 或越权 `sourceIds` 时直接拒绝；
  - 验证生成中途点击「取消准备」幂等停止作业并清理准备槽位；
  - 验证审核失败时返回结构化人话原因且主会话能无缝降级到已有题。

---

<a id="sh4-09"></a>
## SH4-09 · [Phase 3 · 证据与进度纯函数] 作答辅助证据记录（`assistance`）与检验项状态推导纯函数

> **GitHub Issue**：[#542](https://github.com/EricWang1358/dsh-web-studyhub/issues/542)

- **阶段**：Phase 3（可在 Wave-1B / Wave-2A 期间与 Phase 2 并行开发）
- **覆盖用例**：UC-08（查看学习状态与进度）
- **前置依赖**：`SH4-02`
- **文件范围（独占修改）**：
  - 新增：`lib/study-progress.js`（100% 纯函数模块）
  - 修改：`lib/study-state.js`（在 `review.answer` / `card.grade` 生成 `attempt` 时落盘 `assistance` 证据字段）
  - 新增：`tests/study-progress.test.mjs`

### 具体实现思路

1. **作答辅助证据落盘（`lib/study-state.js`）**：
   - 当用户在原生题卡揭示提示、提前翻看答案或点击「请教主会话」后才提交答案时，`attempt` 记录不可篡改的客观证据：
     ```js
     assistance: {
       used: boolean,              // hintUsed || revealedBeforeAnswer || askedTutorBeforeAnswer || isGuidedStep
       hintUsed: boolean,
       revealedBeforeAnswer: boolean,
       askedTutorBeforeAnswer: boolean,
     }
     ```
   - 若为开放题且使用了 AI 语义反馈/批改，记录 `gradingSource: 'ai-rubric' | 'self-grade' | 'deterministic'`，并保留用户原始作答文本 `rawAnswer`。
2. **检验项状态推导纯函数 `computeSessionProgress(session, attempts, runs)`（`lib/study-progress.js`）**：
   - 对 `session.goal.checkItems` 中的每一项 `item`，筛选关联到该检验项（按 `targetCardIds` 或 `topic` 匹配，且发生在本次学习或授权范围内）的真实 `attempts` 按时间排序：
     - **无相关作答** → `status: 'pending'`（待检验；界面文案明确写"待检验"，不写"不会"或"0分"）；
     - **最新有效通过（`correct === true` 或 `grade >= 3`）但 `attempt.assistance.used === true`**，且尚无后续独立通过 → `status: 'assisted'`（借助提示完成）；
     - **至少有一次独立通过（`correct === true && !attempt.assistance.used`），且之后无失败反证** → `status: 'passed'`（已独立通过；**同一检验项重复独立通过只计 1 次权重，不重复加分**）；
     - **曾达到 `passed`，但后续在同检验项的变化题/复测中出现失败（`correct === false`）** → `status: 'needs_review'`（需复核，从已独立通过分子中撤下，拒绝"进度永远只涨不跌"的虚假繁荣）。
3. **聚合口径与防分母操纵（Section 4.6）**：
   - 返回结构：
     ```js
     {
       independentPassedCount: number,
       assistedCount: number,
       pendingCount: number,
       needsReviewCount: number,
       totalCount: number,
       independentRatio: number, // independentWeight / totalWeight
       displayLine: string,      // 例："独立检验 2/5（40%）；另 1 项借助提示完成，2 项待检验"
       lectureCoveredCount: number, // 仅统计 artifactRefs 覆盖，与掌握率严格分列
       nextDayDueCount: number,     // FSRS-6 隔日到期巩固数，单独显示，不混入今日目标分母
       scopeChangedNote: string | null,
       items: Array<{ id, title, status, evidenceAttemptIds: string[], gradingSource?: string }>
     }
     ```
   - **硬规则验证**：临时开一道前置支线题（`branchKind: 'prerequisite'`）不自动修改 `checkItems` 分母；只有用户明确调整目标范围时才更新 `checkItems` 并强制保留 `scopeChangedNote`。

### 解耦与性能设计
- `lib/study-progress.js` 是完全无副作用的纯函数，不读写磁盘、不调模型、不依赖 React，单次计算 < 1 ms。

### 质量保证与验收测试
- `tests/study-progress.test.mjs`：
  - 验证只看讲解（`artifactRefs` 增加但无 `attempts`）时，`independentPassedCount` 恒为 0；
  - 验证借助提示答对只计入 `assistedCount`，`independentPassedCount` 不变；
  - 验证同一检验项连续答对 3 道题不重复累加分子；
  - 验证独立通过后又答错同检验项题目时，状态降为 `needs_review`；
  - 验证每个状态变化都能精确追溯到 `evidenceAttemptIds`。

---

<a id="sh4-10"></a>
## SH4-10 · [Phase 3 · 时间区间与状态 UI] 剩余时间区间纯函数估算、预测变更记录与右侧状态/依据展开组件

> **GitHub Issue**：[#543](https://github.com/EricWang1358/dsh-web-studyhub/issues/543)

- **阶段**：Phase 3
- **覆盖用例**：UC-08（学习状态、进度与剩余时间）
- **前置依赖**：`SH4-05`、`SH4-09`
- **文件范围（独占修改）**：
  - 新增：`lib/study-time-estimate.js`（纯函数模块）
  - 新增：`ui/guided-study/StudyProgressPanel.jsx`（右侧学习状态与依据展开组件）
  - 新增：`tests/study-time-estimate.test.mjs`

### 具体实现思路

1. **有效学习时间过滤与区间估算纯函数 `estimateRemainingTime(session, progress, activityLog)`（`lib/study-time-estimate.js`）**：
   - **目标定义**：明确估算目标是"完成本次剩余检验项"，绝不承诺"彻底学会"。
   - **时间类型剥离**：
     - 将活动时长拆分为：`activeStudyMs`（真实做题与互动求助用时，单题封顶防止挂机膨胀）、`generationWaitMs`（后台单题生成等待时间）、`pausedMs`（暂停时间）、`readingMs`（纯阅读时间）。**严禁把打开题目到提交的墙钟时间（wall-clock）直接当有效学习时间**。
   - **区间计算逻辑**：
     - 若尚无任何已完成检验项且缺乏近期同类活动样本：返回 `{ status: 'estimating', message: '尚在估计，完成首个检验后更新' }`；
     - 若有初步样本或经验基线：
       - 每个 `pending` 检验项基准区间 `[4, 8]` 分钟，每个 `assisted` / `needs_review` 检验项（需补一次独立验证）基准区间 `[3, 6]` 分钟，每个激活的未完成前置支线缺口增加 `[3, 5]` 分钟；
       - 结合用户当前会话已观测到的单题有效中位耗时做温和加权（上下界保留合理宽度，不输出如 `13.4 分钟` 的假精确数字，始终输出整数区间如 `10–18 分钟`）。
   - **预测变更记录**：
     - 提供 `shouldRecordPrediction(prevPrediction, nextEstimate, reason)` 纯判断：仅当目标范围变更或发现新前置缺口导致区间明显变化时，才向 `session.predictions` 追加一条轻量记录 `{ at, reason, minMinutes, maxMinutes, remainingItems }`，不在每次轮询渲染时写账本。
2. **右侧状态与证据展开组件（`ui/guided-study/StudyProgressPanel.jsx`）**：
   - 首屏紧凑展示：
     - 主行：`独立检验 2/5（40%）；另 1 项借助提示完成，2 项待检验`；
     - 次级信息（分开展示）：`讲解已覆盖 3 点` · `隔日巩固待复习 4 题`；
     - 时间行：`预计达到本次检验目标还需 10–16 分钟（初步估计）` 或 `尚在估计，完成首个检验后更新`；
   - 点击「展开依据」：列出每个检验项的状态标签、触发该状态的具体作答记录链接（点击可回看当时答了什么、是否用了提示、若是开放题则标明「AI 语义判断 · 保留原话」），并提供轻量交互让用户增删或调整检验项标题。

### 解耦与性能设计
- 计算逻辑 100% 在 `lib/study-time-estimate.js` 纯函数中完成，UI 组件只做纯展示与事件派发。

### 质量保证与验收测试
- `tests/study-time-estimate.test.mjs`：
  - 验证零证据时返回 `estimating`（"尚在估计，完成首个检验后更新"）；
  - 验证后台生成等待 3 分钟或用户挂机暂停 30 分钟不会污染有效解题速度；
  - 验证出现前置支线缺口时区间合理拉宽并给出原因说明。

---

<a id="sh4-11"></a>
## SH4-11 · [Phase 4 · 跨日恢复与降级收口] 次日/新会话继续、资料与题目修订差异检测、临时问答零副作用与分项成本账本

> **GitHub Issue**：[#544](https://github.com/EricWang1358/dsh-web-studyhub/issues/544)

- **阶段**：Phase 4
- **覆盖用例**：UC-09（暂停、次日或新会话继续）、UC-10（完整降级矩阵收口）、UC-11（临时问答保持零副作用）、4.7（分项成本口径）
- **前置依赖**：`SH4-06`、`SH4-07`、`SH4-10`
- **文件范围（独占修改）**：
  - 新增：`lib/study-resume.js`（跨日/新会话恢复与修订差异检测模块）
  - 修改：`lib/model-usage.js`（或新增 `lib/study-session-cost.js` 分项费用与单检验项成本汇总纯函数）
  - 修改：`skills/study-guide/SKILL.md`（更新主会话带学指导策略，遵循第 2–3 章边界与默认策略）
  - 新增：`tests/study-resume.test.mjs`、`tests/study-session-cost.test.mjs`

### 具体实现思路

1. **次日/新会话恢复与修订差异检测（`lib/study-resume.js`，UC-09）**：
   - 实现 `resumeStudySession(viewState, { sessionId?, courseId? })`：
     - **零私有聊天依赖**：仅从已持久化的 `StudySession`、`runs`、`attempts`、`decks`、`sources` 恢复学习现场，**绝不读取其他会话的私有完整聊天记录**；
     - **资料与题目修订诚实检测**：
       - 比对 `session.scope` 中记录的 `source.revision` 与当前 `sources` 分片中的最新 `revision`；
       - 比对 `session.focus` / `returnPath` / `checkItems` 关联题目的内容摘要（`digest`）与当前 `decks` 中的题目；
       - 若发现讲义已重新导入/修订或原题已被修改/删除，在恢复现场中显式返回 `staleWarnings: Array<{ kind: 'source_revised' | 'card_modified' | 'card_removed', id, detail }>`，供右侧横幅与主会话明确提示用户，不把旧依据当作当前事实；
     - **暂停后台安静保证**：`study.session.pause` 将状态置为 `paused`，确认不触发任何后台自动补题或预热任务。
2. **分项成本与单检验项效率报告（`lib/study-session-cost.js`，Section 4.7）**：
   - 纯函数聚合本次学习期间的账本条目，分行报告四项：
     1. 教学对话与现场读取推理（提示主会话自身推理计入模型用量，导航/保存/进度重算本身为 0 模型调用）；
     2. 复用已有题（0 模型调用）；
     3. 新题生成与独立审核（单列 token 与费用）；
     4. QA 整理（默认复用本轮讲解为 0 额外模型调用；若长篇跨题整理发生了额外调用则如实单列）。
   - 计算并输出 `costPerIndependentCheckItem`（总成本 / 已独立通过检验项数；若分子为 0 则标为 `pending_first_pass`）。
3. **更新 `skills/study-guide/SKILL.md`**：
   - 将第 2.5 节「用户随时可改变策略」、第 3.3 节「按需读现场（纯讨论不调工具）」、以及「打开结果未确认时只说已请求打开」写入主会话技能说明。

### 解耦与性能设计
- 恢复与差异检测全部基于已提交分片的元数据（`revision`、`digest`）比对，无需全文 diff，耗时 < 5 ms。

### 质量保证与验收测试
- `tests/study-resume.test.mjs`：
  - 验证新开会话（无历史聊天上下文）仅凭 `study.session.resume` 即可完整恢复上次未完成题、草稿、返回链、已存 QA 与检验项进度；
  - 验证资料修订或题目修改后恢复时准确产出 `staleWarnings`；
  - 验证普通临时问答（`selection.ask` / `source.get`）全程不创建 `StudySession`、不写 QA、不产生进度记录（UC-11）。
- `tests/study-session-cost.test.mjs`：
  - 验证四分项成本汇总与每个独立通过检验项成本计算的准确性。

---

<a id="sh4-12"></a>
## SH4-12 · [Phase 4 · 端到端质量门禁] 假模型脚本化教学循环测试、故意破坏（Chaos）测试套件与性能预算守卫

> **GitHub Issue**：[#545](https://github.com/EricWang1358/dsh-web-studyhub/issues/545)

- **阶段**：Phase 4（4.0.0 对外发布总门禁）
- **覆盖范围**：第 6 章发布门槛、第 7 章验证与度量
- **前置依赖**：`SH4-08`、`SH4-11`
- **文件范围（独占修改）**：
  - 新增：`tests/guided-study-loop.test.mjs`（脚本化假模型完整主路径端到端测试）
  - 新增：`tests/guided-study-chaos.test.mjs`（故意破坏与异常注入测试套件）
  - 修改：`tests/perf-budget.test.mjs`（加入 `study.scene.get` 与 `study.session.*` 性能预算守卫）
  - 修改：`scripts/case-study/facts.mjs` 与 `docs/case-study/facts.snapshot.json`（若涉及结构性常量更新，同步通过 `tests/case-study.test.mjs`）

### 具体实现思路

1. **脚本化假模型完整主路径测试（`tests/guided-study-loop.test.mjs`）**：
   - 使用确定性脚本化用户语句驱动假模型，从头到尾跑通第 6 章发布门槛的 10 个环节：
     1. 用户发起带学（UC-01）→ 建立 `StudySession`；
     2. 讲解知识点并落盘右侧安全教学块（UC-02）→ 断言讲解覆盖 +1，但独立掌握进度仍为 `0/n`；
     3. 定位已有题（UC-03）并准备一道经审核新题（UC-07）→ 断言显示确认与审核门禁；
     4. 用户在原生面板作答第一题（使用提示后答对）→ 断言状态为 `借助提示完成`，主进度仍为 `0/n`；
     5. 用户求助（UC-04）→ 主会话有界读取现场（断言 payload ≤ 4 KB）；
     6. 主会话打开对照支线题（UC-05）→ 断言原题未提交草稿保留，支线独立记录；
     7. 补讲内容幂等归位到原题 QA 并关联知识点笔记（UC-06）→ 断言来源标注、引文核对与幂等；
     8. 返回原题并独立完成变化题检验 → 断言进度更新为 `独立检验 1/n` 且可追溯到具体 `attemptId`，时间区间从 `尚在估计` 更新为合理区间（UC-08）；
     9. 用户随时改变策略（如"跳过这题""不要再补基础了，回原题"）→ 断言系统无死板流程阻拦；
     10. 暂停并在模拟次日新会话恢复（UC-09）→ 断言完整恢复且后台零多余调用。
2. **故意破坏测试套件（`tests/guided-study-chaos.test.mjs`）**：
   - 逐项注入第 7.1 节列出的 6 类破坏场景：
     - **故障 1**：模型调用中途超时 / 无响应 → 验证带学不崩溃，右侧保留已有状态并给出人话提示；
     - **故障 2**：单题生成独立审核未通过 → 验证残次题绝不进入练习，主会话收到明确原因并降级复用旧题；
     - **故障 3**：面板在导航途中关闭 / 未挂载 → 验证 `panel.open` 诚实返回 `queued_for_sidebar`，绝不谎报已显示；
     - **故障 4**：迟到的异步 `panel.open` 到达（此时用户已切到别的题并输入了草稿）→ 验证迟到请求被拦截，用户当前焦点与草稿零丢失；
     - **故障 5**：用户在会话中撤销 `autoOrganizeQA` 或 `allowNoteEdits` 权限后，迟到的模型工具调用仍尝试写 QA / 改笔记 → 验证被 `study-setting-disabled` 强行拒绝；
     - **故障 6**：主会话工具尝试直接调用 `review.answer` 代答或直接篡改 `checkItem` 状态 → 验证被 `lib/assistant-boundary.js` 拦截拒绝。
3. **性能回归守卫（`tests/perf-budget.test.mjs`）**：
   - 在 1,000 份资料库基准上断言：`study.scene.get` 不触发全库 `structuredClone`，内存增量与响应耗时符合 2.4.0 预算。

### 质量与发布门禁
- `npm run test:fast`、`npm run lint`、`tests/architecture-boundaries.test.mjs`、`tests/unified-runtime-rollback-read.test.mjs`、`tests/perf-budget.test.mjs`、`tests/case-study.test.mjs` 全部通过。
