# S3-4：选中文字补题（selection fill）与领域操作回执

> 前置：S3-1（队列与运行时接入）、S3-2（Step 身份）、S3-3（重启继续，开关 `generationRestart`）。本步让「选中一段原文补到某个题组」(`generation.selection.start`) 成为统一运行时里的任务：开关 `runtime.pilot.generation`（默认关）；重启后接着做由 `generationRestart` 控制（默认关）。**操作记录与银行的追加回执仍是领域提交，运行时不另建提交表。**

## 1. 它怎么工作

| 部件 | 位置 | 职责 |
|---|---|---|
| 一条库队列 | `jobs/library-queue.js` | 原来 `selection-jobs.js` 自己的 `(queues.get(root) \|\| Promise.resolve()).then(run)` 链并入 `libraryQueue`：与普通出题、补题共用同一把互斥，排队中被停止的任务不会启动执行器 |
| 入口 | `jobs/submit-generation.js` | `startGeneration(env, task)`：开关关 = 原来的任务表 + 执行器；开关开 = `supplement` 定义的运行时任务。选中补题没有可调的实时控制，用 `NO_CONTROL`（惰性控制），不再要求 `makeControl` |
| 执行器 | `selection-jobs.js` `execute({ job, controller, models })` | 逻辑与原来一致（`proceed` → `core.supplement / review / commit`），模型调用改经 `models.call`：走网关，用量、努力档、信号归到这一个 Job |
| 任务卡字段 | `jobs/generation-view.js` | `GENERATION_FIELDS` 增加 `origin / operationId / semantic / selection / outcome / operationState / written / passed / runStartedAt`，任务台与选中面板读到的字段不变 |
| 进程内重试 | `selection-jobs.js` `prepared` | 重试 = 按原参数重新准备（`take` / `self`：自己不算自己的重复任务），操作记录决定还剩什么：候选题已有则只审，不再写 |

## 2. 领域回执与 Job / Attempt 的对应

| 领域 | 运行时 | 说明 |
|---|---|---|
| `operationId`（调用方给的幂等键） | 逻辑 Job 的标签字段 `operationId`；同一 `operationId` 活动中的任务直接返回同一个 Job | 语义指纹 `semantic`（题组、数量、题型、焦点、原文）不同 → 仍报 "Operation ID was already used for a different request" |
| `state.selectionJobs` 记录（候选题、审阅、`accepted`、`receipt`） | 不变，仍是领域状态；运行时 Job 不复制它 | 没有第二张提交表 |
| 银行 `append` 回执（按 `operationId` + 载荷） | 不变 | 同载荷重放 = 同一批题卡，不重复追加 |
| 运行时 Attempt | 一次执行器运行 | Attempt 结束 ≠ 操作结束：操作结束以记录的 `complete` 为准 |

## 3. S3-0 恢复矩阵中本步负责的行

| 行 | 开关关（原样） | `generation` + `generationRestart` |
|---|---|---|
| D-1：重启时记录仍在 `preparing/writing/reviewing` 且已有候选题 | 用同一 `operationId` 再开始 → 重新写候选题（多花一次钱，不重复追加） | 沿记录继续：候选题只审不再写，一次追加 |
| D-2：银行已提交追加、记录未标 `complete`（状态 `reviewed`、无 `receipt`） | 状态读成 `review-failed`；再开始会重新写，银行拒绝载荷变化，任务失败但题已在题组里 | 状态读成 `interrupted`；再开始 → 直接提交，银行按回执重放同一批题卡，没有模型调用，没有重复 |
| 已完成的操作 | 回放（既有） | 回放（既有） |
| 重启后任务台 | 活动记录读成「失败 / interrupted」，不在任务列表 | 同左（见 §5：选中任务暂不像普通出题那样落盘还原，留给 S3-7） |

## 4. 没有改内核

`lib/jobs/**` 本步未改。

## 5. 开关打开后的差异

- 选中补题的运行记录不写盘（`generation-run-store` 只服务普通出题），所以「重启后在任务台还原为已中断」不适用；接着做靠同一 `operationId` 再开始。是否值得为它落盘，留给 S3-7 评审。
- 重试换新的 legacy id，逻辑 Job id（契约 `jobId`）不变（同 S3-3）。
- 开关开时，`start` 的回包里 `job` 在第一次轮到它之前只含运行时的字段；`operationId / status / deckId` 取自准备好的种子卡。

## 6. 开关矩阵

`STUDY_RUNTIME_MATRIX=generation` 与 `generationRestart`：`selection-jobs`、`selection-runtime`、`generation-family-baseline-restart-selection`、`selection-job-ui`、`selection-learning`、`task-selection`（以及 `generation` 下的 `generation-family-baseline-queue`）全绿；新增 `tests/unified-runtime-selection.test.mjs`（6 个）。

## 7. 保留 / 迁移

| 项 | 处置 |
|---|---|
| 候选题 / 审阅 / `accepted` / `receipt` 记录、银行追加回执 | 保留（领域提交） |
| 选中补题自己的队列链 | 迁移到 `libraryQueue` |
| `withJobUsage` / `failStep` 的手工用量与步骤记账 | 开关开时由网关代替；开关关时由 `legacyModels` 保持旧行为 |
| 选中任务落盘还原、完成记录清理 | S3-7 |
