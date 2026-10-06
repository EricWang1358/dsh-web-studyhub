# S3-3：普通出题与覆盖运行的重启继续

> 前置：S3-1（运行时接入）、S3-2（Step 身份、冻结输入、检查点引用）已合并。本步让出题运行在**自己的开关** `runtime.pilot.generationRestart`（默认关；需要 `generation` 同时开）下经得起重启：进程退出后任务以同一个逻辑 Job 回来、显示"已中断"、不自动调用模型，学习者点「重试」得到同一逻辑 Job 的新 Attempt，沿着草稿接着做。选区补题、修题、发布仍是旧路径（S3-4/5/6）。

## 1. 它怎么工作

| 部件 | 位置 | 职责 |
|---|---|---|
| 定义声明 `retry: true`、`recoveryMode: 'retry-from-start'` | `jobs/generation.js` | 重试 = 新 Attempt 按**已保存的参数重新准备**（`binding.prepare`），不复用第一次的闭包；草稿就是检查点 |
| `resumeArgs` | `jobs/resume-args.js` | 新 Attempt 的参数：草稿被本次运行保存过（草稿上有 `editorial.generation.runId` = 逻辑 Job id）→ 沿同一草稿接着做（覆盖运行带 `coverage.run`，定向补题保留 `deckId`）；还没保存任何东西 → 原请求再问一次（续补仍写原来的 `draftVersion`，草稿被改过则照旧拒绝） |
| 运行记录 | `lib/generation-run-store.js`（落盘）、`<库>/generation-runs/<id>.json` | 只有运行时的 store（`createManifestJobStore`）写它：原始参数 `args` + 运行时对该 Job 的记录。库里没有别的任务表 |
| 检查点 | `jobs/checkpoint-ref.js` | 每次保存草稿后 `context.saveCheckpoint(checkpointOf(draft))`：`draft:<id>:n<题数>` + 前 n 道题（id 与内容）和冻结输入的摘要。运行**自己**之后追加的题不会让它失效；学习者改过或删掉已保存的题会 |
| 恢复 | `jobs/recover-runs.js`，挂在 `coverage.recover`（快照 / 任务列表读取时调用） | 每个运行时每个库只扫描一次磁盘：未结束的记录经运行时 `restore` 变成同一个逻辑 Job（已中断）；已结束或超过 7 天（`RUN_RECORD_WINDOW_MS`）的记录删除；读不出来的记录原样留着 |
| 与旧覆盖恢复并存 | `coverage.recover` | 草稿里的覆盖运行标记仍会还原成旧式"已中断"记录，但已被运行时还原的运行（`marker.jobId` 与运行记录同 id）不再重复 |

首次提交（`startManaged`）把 `{ kind, args }` 作为输入，开关关时持久化适配器返回 `null`（内核新增能力，见 §4）：这是一个只在本进程里的普通 Job，重试仍然可用（沿着草稿接着做），只是进程退出后不会回来。

## 2. 拒绝恢复（`validateInput` / `validateCheckpoint`，在新 Attempt 之前判断）

| 情形 | 结果 |
|---|---|
| 旧执行者可能仍在运行（`inspect` = alive / unknown） | 不显示为中断，重试被拒（`executor-alive` / `executor-unknown`） |
| 出题用的资料被删除 / 目标题组被删除或归档 / 续补的草稿不存在 | `input-unavailable` |
| 草稿所依据的资料内容变了（用 S3-2 的 `inputRef` 与当前资料哈希比较，`checkpointStatus`） | `input-changed` |
| 定义版本变了 | `definition-version-mismatch`（内核） |
| 已保存的题被学习者改过 / 删掉 / 草稿被删 | `checkpoint-invalid` |
| 运行记录损坏 | 不还原，不报错；草稿仍在，学习者可从草稿页接着做 |
| 同时点两次重试 | 内核保证只有一个活动 Attempt |

「交接点」：继续时**保留**草稿原有的 `inputRef`（不被"还剩多少题"的新请求覆盖），所以之后任何一次恢复都是拿"最初被问了什么"去比对当前资料；定向补题 / `extraSourceIds` 追加了资料，则重新冻结。

## 3. S3-0 恢复矩阵中本步负责的行

| 行 | 现在 | 证据 |
|---|---|---|
| plain / mixed 首份草稿前 | 同一逻辑 Job 已中断；重试 = 原请求再问一次，最终一份草稿 | `generation-restart` #2 |
| case 首份草稿前 | 同上；情景材料 id 由逻辑 Job 决定（`scenario-<runId>`），上次中断留下的同 id 孤立材料被替换而不是重复（D-5） | 既有 `wp12-case-generation` 全绿；孤立材料替换逻辑未单测（V4 仍待核验） |
| plain / case 首个 part 之后 | 同一逻辑 Job，重试沿同一草稿，已通过的题 id 不动，只写缺的 | `generation-restart` #1 |
| `resumeDraftId` 续补 | 同上 | #1 |
| `extraSourceIds` 补题 | 首批保存后沿草稿继续，种子题不动、只补还缺的数量 | #3 |
| target supplement | 沿检查点草稿继续，发布到同一题组，原题卡 id 与复习计划不变，无遗留草稿 | #4 |
| coverage | 同一逻辑 Job（不再是新 id，D-4）；只重跑在途的轮，已完成轮保留，不翻倍 | #9 |
| 拒绝 / 执行者仍活 / 损坏 / 双重试 | 见 §2 | #5–#8 |
| selection / repair / publish | 不变 | S3-4 / S3-5 / S3-6 |

## 4. 内核改动（各自独立提交，各有红→绿测试）

1. `store` / `durability` / `gateway`：请求意图记录是否有副作用（默认有）。宿主模型调用声明无副作用；进程在这样的请求中途退出后，它的意图被标为 `abandoned`，恢复继续（再问一次），而不是永远 `remote-result-unknown`。⚠ 这也改变音频的行为：音频文本调用中途崩溃现在也可恢复。`tests/unified-runtime-unknown-request.test.mjs`。
2. `scoped` / `recovery`：持久化适配器 `open` 可对某次提交返回 `null`＝该 Job 不持久（家族把"是否落盘"做成自己的开关）。`tests/unified-runtime-optional-persistence.test.mjs`。

## 5. 开关打开后的差异

- 已中断的任务在控制台只有"已中断"状态与重试，没有旧式覆盖运行恢复时的说明文字与 `run-interrupted` 事件（内核的中断记录没有说明文字）；旧的 `coverage-run-exec` "a restart does not lose a run" 因此在 `generationRestart` 矩阵里不适用，由 `generation-restart` #9 覆盖同一场景。
- 重试会换新的 legacy id（内核行为），逻辑 Job id 不变（契约 `jobId`）。
- 重试在每次模型调用后刷新卡片，覆盖运行很长时刷新成本随调用数增长（每次整份契约校验）。

## 6. 开关矩阵

`STUDY_RUNTIME_MATRIX=generation` / `generationRestart`（43 个出题套件，慢文件 300 s 超时）：`generation` 34 个全绿、`generationRestart` 32 个全绿；其余是已评审的差异，分类同 S3-1，另加：重试现在存在，`failed-continue-exec` 剩下的是"旧语义 = 新建一个 Job 接着做、旧记录标 continued"（现在是同一逻辑 Job 的新 Attempt）和读旧逐调用上下文的假模型；`honest-run-exec` #4 用重试前的 legacy id 再查（重试换 id）；`small-target-weights`（`generationRestart`）是"50 ms 后取消再数轻模型调用"的计时断言，落盘后每次调用更慢；`restart-plain` / `restart-supplement` 断言"重启后没有任务"，正是本步改变的行为（开关关时它们照常通过）。

## 7. 未决问题

- `job.dismiss` 之后记录仍在磁盘上，下次重启会再回来一次（7 天后清理）：需要 jobs 上下文在忽略 / 删除任务时通知家族（S3-7 / S6）。
- 已完成任务的记录在下次重启时才被删除。
- 中断任务的说明文字：是否让内核的 `markInterrupted` 留下可由定义提供的文字？
- 孤立情景材料的替换（case）没有单测：需要在 `source.add` 与 `draft.save` 之间注入故障的夹具。
