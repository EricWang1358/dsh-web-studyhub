# S3-5：后台修题（draft repair）

> 前置：S3-1（队列）、S3-3（落盘与重启，开关 `generationRestart`）、S3-4（`startGeneration` 的无控制入口）。本步让 `draft.repair` 成为统一运行时里的任务，开关 `runtime.pilot.generationRepair`（默认关；**需要 `generation`，没有它这个开关什么也不做**，开关说明里写明）。重启后接着做仍由 `generationRestart` 控制。

## 1. 它怎么工作

| 部件 | 位置 | 职责 |
|---|---|---|
| 修题本身 | `draft-repair.js`（从 `operations.js` 搬出，逻辑不变） | `prepare(args)`：早期拒绝、任务卡、执行器，不排队；`start` = `prepare` + `startGeneration`；`prepareAgain` 给重试 / 重启用 |
| 一条库队列 | `jobs/submit-generation.js` | 与出题、补题共用 `libraryQueue`；排队中被停止的修题不会启动、不碰模型 |
| 定义 | `jobs/generation.js` `repairDefinition`（kind `draft-repair`，与旧任务 `type` 一致） | 与出题同一组 admit / run / 能力声明；检查点由任务自带的 `checkpointOf` 决定 |
| 模型调用 | `execute` 里的 `models.call` | 开关开：网关一步（`stepKey` = `k<卡片 id>[:a2]:repair|review[:x<n>]`，新增坐标 `card`，同一张卡无论待修列表怎么缩短都是同一个单元）；开关关：`legacyModels`，步骤、用量与原来一致 |
| 检查点 | `jobs/repair-checkpoint.js` | 草稿本身：每修好一张（或写回一张失败原因）就 `draft.save`，随后 `saveCheckpoint(repair:<草稿>:v<版本>` + 摘要）。草稿之后被学习者改过 / 删掉 → 不自动继续 |
| 重试 / 重启后 | `repairResumeArgs` | 新 Attempt 用草稿**现在**的版本重新修题：已修好的卡不在 `rejectedIssues` 里，不会再问 |
| 落盘 | `lib/generation-run-store.js`（S3-3 的同一个） | `draft-repair` 只要求草稿还在（`input-unavailable`）；检查点用 `repair:` 前缀判断（`checkpoint-invalid`） |

## 2. S3-0 恢复矩阵中本步负责的行

| 行 | 开关关（原样） | `generation` + `generationRepair` + `generationRestart` |
|---|---|---|
| 修到第二张时退出 | 第一张已修好并复审后保存，其余仍待处理；没有任务；再点修题只做剩下的（新任务 `count` 1） | 同一个逻辑任务回来（已中断，不自动调用模型）；重试只问剩下的那张，第一张不重修、不重复 `Fixed:` |
| 重启前学习者改过已存的卡 | — | 重试被拒：`checkpoint-invalid` |
| 重启前草稿被删 | — | 重试被拒：`input-unavailable` |
| 进程内停止后重试（不要重启开关） | 没有重试 | 重试继续剩下的卡 |
| 还没保存任何东西就退出 | 没有任务 | 重试用草稿现在的版本再修一次 |

## 3. 内核没改

`lib/jobs/**` 本步未改。`stepKeyOf` 增加 `card` 坐标（家族内）。

## 4. 开关打开后的差异

- 修题结果「部分修好」（`partial`）在运行时里是「完成，`completeness: partial`」，任务台显示完成并写明已修好 m/n 题。
- 修题没有实时可调的设置（并发、各阶段推理档位的「实时」调整），用 `NO_CONTROL`；推理档位仍按出题设置 `effortRepair`，开关开时由网关解析（旧路径不传，保持原样）。
- 重试换新的 legacy id，逻辑 Job id 不变（同 S3-3）。
- 修题的运行记录只在 `generationRestart` 开着时落盘。

## 5. 开关矩阵

`STUDY_RUNTIME_MATRIX=generationRepair` 与 `generationRepairRestart`（新增两档，`tests/helpers/runtime-matrix-preload.mjs`），`draft.repair` 相关套件（9 个）：

| 套件 | `generationRepair` | `generationRepairRestart` | 说明 |
|---|---|---|---|
| restart-supplement | 全绿 | 3 条不适用 | 它们断言「重启后没有任务回来」，正是本开关要改变的行为（同 S3-3 的已评审差异）；`unified-runtime-repair` 覆盖新行为 |
| queue / fill-ui / yield / task-console-nav / lib-registries | 全绿 | 全绿 | |
| terminals #2、review-integrity #25 | 失败 1+1 | 同 | `partial` 在运行时里是「完成 + completeness partial」（§4，已评审差异） |
| main-context | 同 `generation` 档的 S3-1 已评审差异 | 同 | |

review-integrity #22「修题时删除草稿」在第一次矩阵里失败（任务变成 failed 而不是 cancelled）：删除草稿只在任务表记录上打标记并中止执行器的控制器，运行时不知道。已修：执行器的控制器被外部中止（非预算）且记录有 `cancelRequestedAt` 时，`generation.js` 通知运行时 `control(cancel)`，任务以「已停止」结束；出题任务同样受益。

新增套件：`tests/draft-repair.test.mjs` 与 `draft-repair.runtime.test.mjs`（同一套件两侧，4 条）、`tests/unified-runtime-repair.test.mjs`（8 条，运行时特有）。红灯记录：把 `generationRepair` 去掉后 8 条里 5 条失败（任务契约 kind、进程内重试、三条重启用例）。
