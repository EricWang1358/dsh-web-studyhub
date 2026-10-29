# StudyHub 4.0.0 多 Agent 认领与工程质量规范

适用范围：所有认领 `SH4-01` ~ `SH4-12` 的代理（Claude、Codex、Gemini 或其他 Agent）。违反本规范任一硬边界的 PR 不得合并。

---

## 1. 架构解耦与高内聚铁律

1. **遵循 ADR-02 上下文边界（`tests/architecture-boundaries.test.mjs` + ESLint）**：
   - 严禁跨 Context 直接 import 内部文件（如 `lib/contexts/study/` 严禁 import `lib/contexts/bank/` 内部模块）。
   - 跨领域读取与写入必须通过 `lib/runtime/domain-contracts.js` 声明的 `reads`、`actionGrants`、`writesFor` 以及单存储锁下的命名事务参与者（`participants`）完成。
   - 共享纯算法放到 `lib/study-*.js` 纯模块中，不持有状态、不接收 `StudyService` 或未受限的 `store`。
2. **薄操作适配，不建第二套平台**：
   - 4.0 的「读现场、定位/准备对象、保存产物」是能力分类。优先复用已有工具与动作（`panel.current`、`panel.open`、`card.followup.add`、`book.write`、`selection.supplement`），新增动作挂在 `study.v1` 下，不新建平行工具集或通用流程引擎。
3. **单一职责与文件隔离**：
   - 同一核心文件同一时间只允许一个活动 Issue 修改（参见 [`README.md`](README.md) 的文件所有权矩阵）。
   - 每个 `lib/study-*.js` 模块保持高内聚（建议单文件 ≤ 250 行），纯计算函数与状态读写解耦，确保纯函数可在无 store、无宿主、无模型的环境下直接毫秒级单测。
4. **遵循 ADR-04 模型声明与诚实降级**：
   - 现场读取、导航定位、草稿保存、QA 保存、检验项状态推导、时间区间计算均**不调用模型**（`requiresModel: false`）。
   - 需要模型的操作必须显式声明 `requiresModel: true`，无模型时返回 `{ available: false, reason: 'model_unavailable' }`。

---

## 2. 八条代码硬边界（不可妥协）

| 编号 | 硬边界 | 代码强制检查点 |
|---|---|---|
| HB-1 | **作答真实性** | `review.answer` / `review.reveal` 只接受原生面板调用；在 `lib/assistant-boundary.js` 中拒绝主会话工具代答、自填成绩或标记练习完成 |
| HB-2 | **证据驱动状态** | `lib/study-progress.js` 只从 `attempts` 与 `runs` 的真实记录推导检验项状态；没有任何接口允许模型直接传入百分比或改写 `checkItem.status = 'passed'` |
| HB-3 | **范围与授权** | `StudySession.scope`（资料/课程范围）与 `settings`（`allowNewQuestions`、`autoOrganizeQA`、`allowNoteEdits`）在每次写入前校验；越权读写直接拒绝（`study-scope-denied` / `study-setting-disabled`） |
| HB-4 | **输入保护** | 切换题目或进入支线前自动持久化 `entry.draft`；`panel.open` 携带 `intentId` 与 `issuedAt`，过期异步请求不得抢走用户已切换或正在输入的焦点 |
| HB-5 | **写入安全** | QA 与教学块写入支持 `operationId` 幂等重放（沿用 ADR-07 回执机制）；修改已有笔记/QA 强制校验 `expectedVersion`；保留修订历史 |
| HB-6 | **用户内容保护** | 默认只追加 AI 块或新建 AI 来源 QA；仅当 `StudySession.settings.allowNoteEdits === true` 或单次请求显式携带用户编辑授权时才允许修改用户块，且必须写修订历史以支持一键回退 |
| HB-7 | **新题信任** | 正式练习题必须经由现有 `generation.v1` / `authoring.v1` 独立审核链路落盘；严禁把未审核聊天文本注入 `runs` |
| HB-8 | **渲染安全** | 右侧教学块复用现有安全富文本、KaTeX 公式与受控 SVG/图表清洗器；严禁执行任意脚本、外链网络请求或从渲染组件直接写成绩 |

---

## 3. 性能工程与存储预算（守护 2.4.0 成果）

1. **零全库拷贝读取（`storagePort.view()`）**：
   - `study.scene.get`（紧凑现场读取）必须使用 `storagePort.view()` 读取深度冻结的已提交分片，**严禁调用 `storagePort.read()` 触发全库 `structuredClone`**。
2. **有界现场大小**：
   - 单次 `study.scene.get` 默认返回结构化 JSON ≤ 4 KB（约 800–1200 tokens）：只含本次范围摘要、当前对象题干与揭示状态、最近 ≤ 5 次相关作答摘要、返回路径（≤ 5 层）与检验项摘要；长资料正文与历史 QA 仅返回引用 ID。
   - 性能测试断言：在 1,000 份资料、2,900 道题的基准库上，`study.scene.get` 服务端耗时 P50 ≤ 15 ms，且耗时不随总库规模 $O(N)$ 增长（只与当前会话引用对象数 $O(k)$ 成正比）。
3. **分片粒度（`mode: 'item'`）**：
   - `studySessions` 在 `lib/runtime/builtins.js` 中注册为 `mode: 'item'`（每个会话一个独立内容寻址分片），避免 `whole` 模式在每次聚焦切换时重写历史会话。
4. **回退与旧版兼容（`unified-runtime-rollback-*`）**：
   - 默认开关 `runtime.pilot.guidedStudy4 = false`；开关关闭时，行为与 3.7.4 完全一致。
   - 新增分片描述符必须同步登记到回退矩阵测试，确保旧版本读取学习库时不触发写保护。

---

## 4. 质量保证与测试要求

1. **红灯先行（TDD）**：
   - 每个 Issue 必须先编写针对硬边界与契约的失败测试，再写实现代码。
2. **四层测试覆盖**：
   - **纯函数单元测试**：覆盖 `lib/study-session.js`、`lib/study-progress.js`、`lib/study-time-estimate.js`、`lib/study-branch.js` 的所有边界输入。
   - **契约与权限拒绝测试**：覆盖越权资料读取、未开启 `allowNoteEdits` 覆盖用户笔记、主会话尝试调用 `review.answer` 代答、重复 `operationId` 重放幂等、旧 `version` 冲突拒绝。
   - **脚本化假模型教学循环测试（`SH4-12`）**：用确定性假模型驱动 UC-01 → UC-09 完整主路径，断言每一步右侧对象、分片记录、进度分子分母的变化。
   - **故意破坏测试（Chaos）**：模拟模型超时、单题审核失败、切题途中面板关闭、迟到 `panel.open` 到达、宿主进程重启后草稿与 `returnPath` 恢复。
3. **验证命令与环境安全**：
   - 开发期间运行定向测试：`node --test tests/<新增测试>.test.mjs` 及 `npm run test:fast`。
   - 严禁设置 `STUDY_TEST_NO_LOCK`；运行测试前确保清空真实 API Key，使用工作区内临时目录，绝不触碰用户真实学习库。
   - 保持原文件换行符（CRLF/LF），提交前运行 `npm run lint` 以及 `tests/architecture-boundaries.test.mjs`、`tests/case-study.test.mjs`。
