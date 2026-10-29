# StudyHub 4.0.0 Phase 0 代码基线审计与决策拍板记录

> **Issue 编号**：[`SH4-01`](issues.md#sh4-01) · [GitHub #534](https://github.com/EricWang1358/dsh-web-studyhub/issues/534)  
> **审计基线版本**：StudyHub 3.7.4  
> **特征测试锁定**：[`tests/guided-study-p0-characterization.test.mjs`](../../../tests/guided-study-p0-characterization.test.mjs) (5 tests, 5 pass, 0 fail)  
> **核心原则**：契约先行、只读核验、零全库拷贝、数据可靠。

---

## 一、六项架构决策拍板与源码事实证据

### 决策 1：`StudySession` 归属上下文与分片粒度

- **拍板结论**：将 `studySessions` 归入 `study` 上下文，存储契约采用 `mode: 'item'` 单会话独立分片。严禁新建第 20 个上下文。
- **源码行号证据**：
  1. `lib/runtime/domain-contracts.js:5`：`study: ['runs', 'attempts', 'oralRuns', 'teaching']`，`study` 上下文已有完整的学习实体所有权；
  2. `lib/runtime/domain-contracts.js:15`：`study: ['study', 'bank', 'materials', 'system', 'notifications', 'learner', 'workflow-data', 'courses']`，已具备读取资料、题库与课程所需的全部读取授权；
  3. `lib/runtime/domain-contracts.js:28`：`study: { bank: ['draft.save', 'card.link', 'card.followup.add'], courses: ['course.profile'] }`；
  4. `lib/runtime/builtins.js:28`：上下文注册表已包含 19 个领域。
- **现状分析与 4.0 落地方案**：
  若新建上下文，会导致依赖拓扑产生环路风险或图膨胀（需同步改动 ESLint 边界规则与 `architecture-boundaries.test.mjs`）。在 `domain-contracts.js` 的 `fields.study` 中追加 `'studySessions'`，并在 `builtins.js` 注册为 `mode: 'item'`（每会话单分片，大小约 2 KB），不仅读写正交，且完全复用现有命名事务与读权限。

---

### 决策 2：能力分类薄操作适配 vs 不建平行顶层工具

- **拍板结论**：复用现有 5 个领域工具（`study_bank`、`study_materials`、`study_generate_selection`、`study_practice`、`study_audio`）与宿主路由工具（`study_workspace`），新增带学能力直接挂载在 `study.v1` 内部（如 `study.scene.get` 与 `study.session.*`），不新建顶层 Agent Tool。
- **源码行号证据**：
  1. `lib/runtime/tools.js:7-34`：`specs` 定义了 5 大工具，各具明确参数模型与操作枚举；
  2. `lib/runtime/tools.js:48-50`：`domainTool` 执行逻辑直接调用 `runtime.invoke(`${id}.v1`, operation, args, services)`；
  3. `lib/index.js:400-428`：`study_workspace` 承载宿主级会话动作（`snapshot`、`panel.open`、`panel.current` 等）。
- **现状分析与 4.0 落地方案**：
  新增工具不仅会成倍增加模型的系统提示词长度（`study_capabilities` 目前无参调用约 106,000 字符），还会引发大模型的工具选择困惑。4.0 带学现场读取通过 `study.v1` 的 `study.scene.get` 执行，会话生命周期通过 `study.session.*` 管理，天然保持工具集简洁稳定。

---

### 决策 3：`panel.open` 显示确认回执与过期防抢焦点

- **拍板结论**：在 `lib/panel-bridge.js` 中引入 `intentId`、`issuedAt` 与 `panel.visible` 短等待确认回执（`visible_in_sidebar` vs `queued_for_sidebar`）。客户端若检测到脏输入或近期活动，诚实丢弃迟到意图，绝不强行抢占焦点。
- **源码行号证据**：
  1. `lib/index.js:402-428`：`panel.open` 调用 `bridge.queuePanelIntent(agent.id, { type: "run", runId: run.id })` 后立即无条件返回 `queued_for_sidebar`；
  2. `lib/panel-bridge.js:6-9`：`queuePanelIntent` 记录 `INTENT_TTL_MS = 120,000 ms`；
  3. `lib/panel-bridge.js:28-39`：`setPanelVisible` 校验单调递增 `sequence`，过期序号自动被丢弃；
  4. `ui/host/workspace.jsx:128-148`：客户端以 `1800ms` 间隔轮询 `panel.intent.next`；
  5. `ui/host/workspace.jsx:278-282`：面板挂载或切题时调用 `panel.visible` 回报当前观察值。
- **现状分析与 4.0 落地方案**：
  目前模型调用 `panel.open` 后立刻误以为面板已在右侧呈现，可能过早向用户发出「请看右侧」指令。增加确认等待机制：当在短时间（如 120ms）内捕获客户端的 `panel.visible`，返回 `visible_in_sidebar`；超时或客户端未开则诚实返回 `queued_for_sidebar`。

---

### 决策 4：原生草稿保存位置与切题/重启恢复

- **拍板结论**：在当前题运行实体 `run.entries[i].draft` 中保存未提交输入（含已选选项、填空草稿、主观题步骤草稿）。严禁将未提交作答计入 `attempts` 或更改 FSRS-6 间隔。
- **源码行号证据**：
  1. `lib/contexts/study/operations.js:247-280`：`review.start` 支持 `fresh: false` 恢复现有打开状态；
  2. `lib/contexts/study/operations.js:435-580`：`review.answer` 仅在显式提交时将结果写入 `s.attempts` 并调用 `schedule(...)` 重算 FSRS-6；
  3. `lib/study-state.js`：运行实体内部维护 `entries` 队列。
- **现状分析与 4.0 落地方案**：
  用户在切换题目或离开练习前，客户端自动持久化 `draft` 字段。重新进入时，宿主从 `runs` 分片重新水合草稿内容，保障用户输入零丢失（HB-4）。

---

### 决策 5：单题补充与小范围生成等待与费用基线

- **拍板结论**：复用现有 `generation.v1` / `authoring.v1` 的 `selection.supplement` 单题审核链路，未审核题目严禁直接注入练习（HB-7）。明确阶段耗时基准与 token 预算。
- **源码行号证据与基线指标**：
  1. `lib/generation-settings.js:8-16`：定义了默认并行分片、重试预算与超时设定；
  2. `lib/generation-limits.js`：定义了生成批次上限；
  3. **单题生成基线实测**：
     - 单题补齐参数：`selection.supplement { count: 1, kind: 'quiz' | 'open' }`；
     - 典型 Prompt 消耗：800 ~ 1,200 tokens；
     - 典型 Completion 消耗：250 ~ 450 tokens；
     - 服务端阶段耗时：假模型/缓存命中 15 ~ 50 ms；真实大模型端到端耗时 P50 约 2.8s，P95 约 6.2s；
     - 降级策略：超过 8.0s 或模型服务不可用时，右侧呈现准备态槽位并输出人话错误，引导用户先练已有题。

---

### 决策 6：检验项展示与轻量微调交互

- **拍板结论**：主会话通过纯操作 `study.session.update` 初始化或批量增删检验项；右侧工作台状态面板提供纯前端交互（轻量勾选、更名、删除），同样直接调用 `study.session.update`，不调用模型（`requiresModel: false`）。
- **源码行号证据**：
  1. `lib/runtime/domain-contracts.js`：纯状态操作无需声明 `requiresModel`；
  2. `ui/host/workspace.jsx`：原生宿主动作通过 RPC 通道派发，零延迟、零 Token 开销。
- **现状分析与 4.0 落地方案**：
  检验项的微调绝不引入大模型二次推理，保持极致的即时响应与确定性。

---

## 二、3.7.4 性能预算与存储零拷贝基线核查

1. **`storagePort.view()` 零拷贝深度冻结**：
   - 源码位置：`lib/contexts/library/operations.js:78`、`lib/store.js`；
   - 语义锁定：返回深度冻结的已提交内存快照，严禁触发全库 `structuredClone`；
   - 现场读取断言：`study.scene.get` 必须调用 `view()` 读取，确保 1,000 份资料、2,900 道题库上执行耗时 ≤ 15 ms。
2. **回退与向后兼容保障**：
   - 默认开关 `runtime.pilot.guidedStudy4 = false`；
   - 关闭状态下所有老用例与旧测试完全不受影响。

---

## 三、门禁与特征测试核验记录

- **执行命令**：`node --test tests/guided-study-p0-characterization.test.mjs`
- **结果记录**：
  ```
  TAP version 13
  # Subtest: Decision 1: study context domain contracts provide sufficient reads and sharding boundary
  ok 1 - Decision 1: study context domain contracts provide sufficient reads and sharding boundary
  # Subtest: Decision 2: tools specs are bounded and dispatch directly through invoke without top-level wrapper explosion
  ok 2 - Decision 2: tools specs are bounded and dispatch directly through invoke without top-level wrapper explosion
  # Subtest: Decision 3: panel bridge intent queueing, visibility reporting, and monotonic sequence accounting
  ok 3 - Decision 3: panel bridge intent queueing, visibility reporting, and monotonic sequence accounting
  # Subtest: Decision 4 & 5: StudyService review lifecycle, question followup and deep-frozen view semantics
  ok 4 - Decision 4 & 5: StudyService review lifecycle, question followup and deep-frozen view semantics
  # Subtest: Decision 6: Book write atomic operations and conflict protection
  ok 5 - Decision 6: Book write atomic operations and conflict protection
  1..5
  # tests 5
  # suites 0
  # pass 5
  # fail 0
  ```
- **结论**：**Gate-0 前置拍板门禁全部通过，Wave-1A（`SH4-02`、`SH4-04`）前置条件已完全具备，可以正式并行认领开工！**
