# S3-0：出题家族基线、恢复范围与契约差额

> **早期只读基线，基于 origin/main 8d661f4（8d661f4a5ab62337ceadc4040396a32bafaa2df1，S1-7 #281 之后）；S3 开工时须在当时 main 上复核。** 此时 S2（U1–U8）尚未合并，本记录不依赖其结果；文中行号是该 SHA 上的行号，源码变动后以符号名为准。

本步只增加特征测试与本文，不改生产代码。特征测试描述**当前行为**，在 origin/main 上通过；发现的缺陷只登记（第 7 节），不在测试里修复或扩大预期。所有测试只用假模型，不访问网络与真实学习库。

## 1. 入口与实际执行路径

共同点：所有入口都在 `lib/contexts/generation/operations.js`（selection 在 `selection-jobs.js`）里**直接**往 `work.jobs`（Map）写一条旧式 job 记录，再把 `run` 接在 `work.queues` 的按库根链上；没有任何入口使用 `lib/jobs/**` 的注册表、Attempt、Step 或网关。`queues` 是一个 `Map<root, Promise>`（不是函数 `queues(root)`）：`const done = (queues.get(root) || Promise.resolve()).then(run); queues.set(root, done)`。`queuedBehind` 数的是库内**活动 job 数**（`activeJob`），不是队列长度。

| 入口 | 队列与互斥 | 模型调用路径 | 用量记账 | 检查点 | 提交点 | 通知 | 取消路径 |
|---|---|---|---|---|---|---|---|
| `generate` 普通 / mixed 首份草稿（无 `resumeDraftId`） | `queues` 链 `operations.js:935-941`；同库全部入口共用；`:476` 同草稿只允许一个活动 job | `step()`→`providedComplete`（`recordedModels`→`lib/index.js modelCompletion`）`:608-645`；`batch.js limitedComplete` 自带并发/429 退避 `:221-247` | `withJobUsage(job, step)` 写内存 `job.tokenUsage`（`:622`）+ `recordedModels` 的日账本 sink（`runtime/builtins.js:98`） | **草稿即检查点**：每个 part 通过复审后 `saveProgress`→`draft.save`（`:650-683`，`batch.js:467` 触发）；`generation.js:576/597` 为 part 内先存首轮再补位 | `draft.save`（草稿，不是发布）；草稿 ID 在首次保存时才存在 | `providedAnnounceJob(job)` `:932`（`runtime/job-notice.js`）；终态后才发 | `job.cancel`（`contexts/jobs/operations.js:71`）置 `cancelRequestedAt` 并 abort `generationControllers`；总时限 timer `:517`→`GENERATION_BUDGET` |
| `generate` + `resumeDraftId`（接着做/补齐） | 同上；`:244-252` 校验 `draftVersion`、`:476` 单草稿单活动 job | 同上；请求取自 `previous.editorial.generation` `:279-293` | 同上 | 同上，基于 `base` 草稿合并 `mergeContinuedDraft` `:653` | 同一草稿 `draft.save`（`requireExisting`） | 同上 | 同上；失败/取消且留有草稿则 `job.retryable=true` `:905` |
| `generate` + `resumeDraftId` + `extraSourceIds`（用未覆盖资料补题） | 同上 | 同上；只给新资料 `:279-283` | 同上 | 首次 `saveProgress` 才把新资料记入 `generation.sourceIds`、`requested += count`（本步测试固定） | 同一草稿 | 同上 | 同上 |
| `supplement`（target supplement，`deckId`） | 同上；`publishTarget` 路径 `:199-203` | 同上 | 同上；发布复审用 `publication.js:87-89`（`withJobUsage(publish job)`） | 草稿为检查点，带 `mergeTargetId` | `publish()` `:525-535`→`draft.publish`（`requireReviewed`），目标题组 ID/卡 ID/学习进度不变；预算到期走 `supplementBudgetPublication` 只回执发布 `:908-919` | 同上 | 同上；用户取消优先于预算收尾（`runtime/jobs.js` `checkSupplementPublication`） |
| `generate` + `coverageLevel` / `coverage.run` / `documentId`（覆盖运行、接着做、为资料补题） | 同上；一个计划的轮次在一个 job 里串行 `:735-841`；`:271` 同资料一份补题草稿 | 同上；另有 `sectionWeights` 轻模型 `:568-583` | 同上；`tokensUsed`/`tokenBudget` 在草稿标记里持久 | `editorial.coverageSpec`（每轮 status）+ `editorial.coverageRun`（标记）每个轮边界 `persist()` `:539` | 同草稿；`stepOf`（`coverage-run.js:121`）决定下一轮/补位/停止 | 同上 | 同上；暂停在轮边界 `:815-826` |
| `generate` + `kind: 'case'` | 同上；不可续补/并入 `:340` | `generateCaseDeck`（`generation.js:746`）一个 part，并发 1 | 同上 | **只在结束时存一次** `generation.js:810`；情景材料先 `source.add` 再 `draft.save` `operations.js:659-674` | 草稿；带答案时 `draft.publish.quick` + `card.grade` 循环 `:854-867` | 同上 | 同上 |
| `generation.selection.start`（选区补题） | 同一 `queues` 链 `selection-jobs.js:196`；同段落同题组拒绝重复 `:101-103`；operationId 幂等 `:86-92` | `core.supplement`→`generateDeck`，模型经 `model()` 包装 `:126-135` | `withJobUsage(job, step)` `:130` | 选区记录 `state.selectionJobs`：`preparing→reviewing`（候选 `onAuthored` `selection.js:135`）→`reviewed` | `bank.append`（`selection.js:70`，`bank/api.js:34-75` 的 `appendOperations` 回执按 operationId 重放）→记录 `complete` | `finish()` `selection-jobs.js:158-167`：收件箱 + `announce` | `job.cancel`；固定 20 分钟总时限 `:175-178` |
| `draft.repair` | 同一 `queues` 链 `operations.js:1165`；`:1032` 同草稿单活动 job | `stageCall`→`providedComplete` `:1057-1078`（无阶段推理档位参数） | `withJobUsage` | **逐卡**：通过独立复审才 `draft.save` 并写 `reviewedCards` 指纹 `:1126-1134`；失败卡写回 `rejectedIssues` `:1144` | 每卡一次 `draft.save`；状态 `complete/partial/failed` `:1149` | `:1162` | `job.cancel`（abort 理由「已修好的题目会保留」）；`GENERATION_JOB_TIMEOUT_MS` `:1053` |
| `draft.publish.start` | 同一 `queues` 链 `:124`；`:76` 同草稿单活动 job；`assertDraftWritable`（`runtime/jobs.js:66`）阻止写草稿 | 发布前逐卡复审在 `authoring/publication.js:87-89`（`jobId` 存在时带信号） | 同上 | 无（复审标记 `marks` 在同一次 `draft.publish` 内） | `draft.publish` 一次原子 `state.update`（`authoring/operations.js:51-195`） | `:121` | **不可取消**（`job.cancel` 拒绝 `draft-publish` `contexts/jobs/operations.js:77`），但插件卸载可 abort |

## 2. 重启恢复矩阵（U9 要求）

当前**唯一**的重启恢复是覆盖运行：`coverage.recover`（`operations.js:1001-1021`，由 `runtime/builtins.js:205` 在 snapshot/jobs 读取时调用），读 `editorial.coverageRun.state ∈ {running,paused}` 且计划里有未完成轮的草稿（`coverage-runs.js:30-40`），还原为 `interrupted` job（沿用 `marker.jobId`），再由 `job.control retry`→`generate{coverage:{run:true}}` 接着做。其余路径**没有**任何重启恢复：job 只在内存 `work.jobs`，终态历史也不持久（除非 `job.archive`）；磁盘上只剩领域产物。下表“当前表现”均有测试（见第 3 节），“目标”是 U9 要求每行交付的“重启可见且可继续”，缺口由所列步骤补齐，不得用 coverage 样本代替。

| 行 | 持久输入（磁盘上现有什么） | 输入/产物版本 | 提交引用 | 当前重启表现 | 如何继续（现状→目标） | 负责步骤 | 证据 | 状态 |
|---|---|---|---|---|---|---|---|---|
| plain 首份草稿前 | 无（请求只在内存） | 无 | 无 | 无草稿、无 job、`coverage.recover` 返回 0、无自动模型调用 | 重新提交→需持久化请求+来源指纹，恢复可见 interrupted | S3-2 定输入快照；S3-3 | `…restart-plain` #1 | **缺口** |
| mixed 首份草稿前 | 同上（`kindCounts` 在内存） | 同上 | 同上 | 同 plain（同一路径，仅 `planGeneration` 分 quiz/flashcard） | 同上 | S3-3 | 代码 `batch.js:149-153`；未单测 | **缺口**，mixed 未单独测（待核验 V3） |
| case 首份草稿前 | 无；情景材料 `scenarioSourceId=id()` 在内存 | 无 | 材料在草稿前先 `source.add` | 同 plain；崩溃于 `source.add` 与 `draft.save` 之间会留下孤立材料（D-5，代码阅读） | 重新提交；需稳定情景材料 ID 才能去重 | S3-3 | `operations.js:412,659-674`；未单测 | **缺口**（待核验 V4） |
| plain/case 首个 part 之后（有草稿） | 草稿：已通过题、`editorial.requested`、`editorial.generation`（kind/language/performance 等）；**无** run 标记 | `draftVersion`（继续时要求相等 `:248`） | `draft.save` | 草稿完整保留；**无 job、无 interrupted、无按钮**；接着做只能由用户从草稿页发 `resumeDraftId` | 现状：手动 `generate{resumeDraftId,draftVersion}`（成功，同草稿、同 ID）；目标：interrupted 可见，同 logical job 新 attempt | S3-3 | `…restart-plain` #2；`failed-continue-exec`（进程内继续） | **缺口** |
| `resumeDraftId` 续补（draft 已有计划外题数不足） | 同上 | 同上 | 同上 | 同上 | 同上 | S3-3 | `failed-continue-exec`、`…restart-plain` #2 | **缺口** |
| `extraSourceIds` 补题 | 草稿；新资料**首次保存后**才写入 `generation.sourceIds`、`requested`（=原+count） | `draftVersion` | `draft.save` | 保留首批；不记 job；补题请求本身（count、extraSourceIds）不持久，只有 `requested` 增量 | 需持久化 `extraSourceIds`/count 才能“用原输入而非当前 UI 焦点”恢复 | S3-2 + S3-3 | `…restart-supplement` #1 | **缺口** |
| target supplement | 检查点草稿带 `mergeTargetId`/`generation.mergeTargetId`；目标题组、卡 ID、复习进度、尝试记录不变 | 目标题组 `contentVersion`、草稿版本 | 发布前无；发布=`draft.publish` | 目标题组未动；草稿留存；**自动发布随 job 丢失**，需手动 `draft.publish.start` | 目标：恢复后续做/发布；已发布则不得重复 | S3-3（生成）、S3-6（发布） | `…restart-supplement` #2；`main-context`（进程内全链路） | **缺口** |
| coverage（新建/接着做/为资料补题） | 草稿 `coverageSpec`+`coverageRun` | 草稿版本；资料缺失时拒绝（`:368`） | 每轮 `draft.save` | **已有**：interrupted job（原 jobId）可见，轮在途重跑，done 轮跳过 | 现状：`retry` 新建 job（新 ID，删除 interrupted 记录，D-4）；目标：同 logical job 新 attempt、执行者仍活时拒绝 | S3-3（演进，非重造） | `coverage-run-exec`（`:357`、`:417`） | **已有，有差额**（D-4、V6） |
| selection 补题（active 记录） | `selectionJobs` 记录：候选、review、operationId、fingerprint | `expectedVersion` | `bank.append` 回执（deck.appendOperations） | `status` 返回 `failed/outcome=interrupted/operationState=reviewing`；不在任务列表；无自动调用；再次 `start` **重新写题**，不复用候选（D-1） | 目标：`core.review` 复用候选（现仅对 `review-failed/cancelled` 生效 `selection-jobs.js:150`） | S3-4 | `…restart-selection` #1；`selection-jobs`（已完成重放） | **缺口** |
| selection（回执已提交、记录未标 complete） | 记录 `reviewed`；银行回执在 | 同上 | 银行回执 | `status` 读成 `review-failed`；再 `start` 清记录重写→`payload changed` 冲突，**job 失败但卡已在题组**（D-2） | 目标：先按 operationId 查回执重放 | S3-4 | `…restart-selection` #2 | **缺陷** |
| `draft.repair` | 草稿：已修卡带新 `reviewedCards` 指纹，未修卡仍在 `rejectedIssues` | `draftVersion`（任务开始校验） | 每卡 `draft.save` | 逐卡结果保留；无 job；再次 `draft.repair` 只修剩余卡（新 job `count` 1） | 目标：重启可见 + 同 logical job 新 attempt；“原草稿/卡/缺陷输入”需持久 | S3-5 | `…restart-supplement` #3 | **缺口**（逐卡提交已稳） |
| `draft.publish.start` | 草稿（未变）；`publishJobId` 不持久 | `draftVersion` | `draft.publish` 的一次原子写（deck+draft） | 复审中退出：草稿原样、无题组、无 job、不自动重审；再发一次即可；完成后 job 记录重启即无 | 目标：持久授权/输入版本/提交引用，恢复前核对既有题组 | S3-6 | `…restart-plain` #3；`publication-context`、`generation-lifecycle`（卸载时排队发布被取消） | **缺口**（提交后、通知前窗口未测，V5） |
| case 快速发布+批改（带答案） | 草稿→`draft.publish.quick`→`card.grade` 循环 | — | 发布后 `delete job.draftId`；批改无回执 | 发布后、批改中退出：题组已在，部分批改，无记录 | 目标：批改步骤稳定 key 与提交核对 | S3-6 | `operations.js:854-867`；未单测 | **缺口**（V4） |

## 3. 特征测试：已覆盖与本步新增

| U9 验收项 | 既有覆盖（不重复） | 本步新增（`tests/generation-family-baseline-*.test.mjs`，helper `tests/helpers/generation-baseline.mjs`） |
|---|---|---|
| 补题仍同草稿/指定题组；卡 ID、学习进度、mergeTarget 不变 | `generation-fill-service`（同草稿、`mergeTargetId` 保持）、`main-context`（目标题组卡 ID、`review` 进度、尝试、`requires` 不变）、`generation-fill-rounds` | `restart-supplement` #2 补“重启后目标题组逐字节不变、草稿记着目标” |
| fillRounds、reserve、coverage 预算/暂停/停止条件 | `generation-fill-rounds`、`generation-yield`（并行 part 不领同一 reserve）、`generation-rescue`、`coverage-run-exec`（预算、暂停、no-progress、FILL_ROUNDS、停止）、`honest-rounds-core` | `constants`：把各界限的**数值**集中锁定（含 `reserveCount`、停止原因表） |
| 已有重启恢复 vs ordinary 无同等恢复 | coverage：`coverage-run-exec`（`:357` 复制目录、`:417` 卸载宿主） | `restart-plain`（首个 part 前/后、publish）、`restart-supplement`（extraSourceIds、target supplement、repair）、`restart-selection`（active 记录、已提交未标记） |
| partial/complete/失败、budget 收尾、用户取消优先、owner 卸载互不混淆 | `main-context`（budget 收尾、取消/归档/过期回执，用户取消优先）、`failed-continue-exec`（总时限→failed+接着做）、`generation-lifecycle`（卸载取消排队发布） | `terminals`：三种结果的契约值；repair 的 `partial`→`complete`+`completeness:partial`；**学习者停止与插件卸载契约相同（D-3）** |
| 共用一个库队列（U10 先决） | `selection-jobs`（别的段落排队）、`integration` | `queue`：五个入口同链、排队不触模型、按接收顺序逐个执行 |

新增 6 个测试文件 + 1 个 helper，16 条用例，各文件 ≤115 行；单文件命令 `node scripts/test.mjs tests/<file>`。

## 4. 字段/调用点去留表

| 字段 / 调用点 | 位置 | 处理 | 步骤 |
|---|---|---|---|
| job 记录直接写 `work.jobs` | `operations.js:88,485,1044`；`selection-jobs.js:123` | 迁入内核 Job 记录，旧字段经 `legacyFields` 展示适配 | S3-1 |
| `work.queues` 承诺链 + `settled` | `:124,935,1165`；`selection-jobs.js:196-199` | 委托内核调度，库级互斥保持（U10 验收） | S3-1 |
| `generationControllers` / `cancelRequestedAt` | `:486`；`contexts/jobs/operations.js:85` | 迁到 Attempt 控制器；`cancelRequestedAt` 不再兼作“卸载”标记（D-3） | S3-1 |
| `jobControls`（`generationControl`） | `:489`；`lib/job-control.js` | 保留为领域控制，经 capabilities.set 暴露；暂停声明 `checkpoint` 仅覆盖 coverage | S3-1/S3-2 |
| `jobOutputs` | `:619,630` | 保留（观测存储） | — |
| `job.steps[]` + `withJobUsage` + `step.runtime ||= 'direct'` | `:613,622,640` | 迁到网关 Call 记录与执行方式归属；用量一处记账 | S3-1 |
| `job.retryable` / `continuedBy` / `continued` | `:480-482,905`；`job-contract.js:205-211` | 改为内核 retry 能力 + 同 logical job 新 attempt；保留 `continued` 展示 | S3-3 |
| `editorial.coverageSpec` / `coverageRun` | `coverage-run.js`、`coverage-runs.js` | **保留为领域检查点**，公共侧只存引用（checkpointRef） | S3-2/S3-3 |
| `editorial.generation`（请求快照） | `batch.js:433-448` | 保留为持久输入；补 `extraSourceIds/count` 与哈希进 inputRef | S3-2 |
| `editorial.reviewedCards` 指纹 | `generation.js:566`；repair `:1131` | 保留，作为 repair/publish 的提交核对依据 | S3-5/S3-6 |
| `selectionJobs` 记录 + bank `appendOperations` | `selection.js`；`bank/api.js:34-75` | 保留为领域回执；加“先按回执重放”与候选复用 | S3-4 |
| `coverage.recover` 调用点 | `builtins.js:205` | 并入内核恢复调度；演进 `newMarker/resumedMarker` | S3-3 |
| `announceJob` + `ports.mail` 收件箱 | `:932`；`selection-jobs.js:163` | 改为稳定事件键投递；失败不改终态 | S3-6 |
| `calibrationFor(root).record` | `:930` | 保留；注意重试会重复入账（V7） | S3-3 |
| `generationMessengers` | `:632-637` | 保留（子代理消息通道），经网关 | S3-1 |

## 5. 出题路径上的硬编码常量

| 常量 | 值 | 位置 | 建议归属 |
|---|---|---|---|
| 单次模型调用超时 | 10 分钟 | `lib/generation-limits.js:2` | 出题设置（调用级） |
| 单 job 总时限 | 20 分钟默认（范围 5–180） | `generation-limits.js:5`；`generation-settings.js:9,18` | 已在 `performance.jobTimeoutMinutes`；repair（`:1053`）与 selection（`selection-jobs.js:112,177`，提示串里还写死 “20-minute”）未走设置，应统一 |
| 并发/批大小/part 补位轮数 | 4 / 5 / 2 | `generation-settings.js:9` | 已是设置（`performance`） |
| 覆盖运行补位轮数 | 2（`FILL_ROUNDS`，与上一行**同名不同义**） | `coverage-run.js:19`；`operations.js:261` | 出题设置，改名 `coverageFillRounds` |
| 小节重复失败上限 / attempts 行数 | 2 / 600 | `coverage-run.js:21-22` | 出题设置 |
| 一轮最多题数 / 目标总题数上限 | 30 / 500 | `coverage-round.js:19`；`limits.js:15` | 出题设置 |
| tokenBudget 下限 | 1000 | `operations.js:237,260` | 出题设置 |
| 单次调用字符 / 一次规划目标数 | 60000 / 10 | `limits.js:18-19` | 出题设置 |
| 429 重试 / 回升间隔 / 基础退避 | 4 次 / 4 次成功 / 2000 ms 指数 | `batch.js:35,242` | 内核重试与 provider 许可（S1-3）；避免与传输层叠加（V8） |
| 复审重问次数 | 2 | `generation-failure.js:12` | 出题设置 |
| reserve 比例 | 20%，最多 3，少于 3 题为 0 | `generation-yield.js:68` | 出题设置 |
| repair 每卡轮数 / 其余题上下文 / 截断 | 2 / 150 题 / 160、240 字 / 缺陷最多 5 条 | `operations.js:1089,1098,1146` | 出题设置（repair 策略） |
| selection 题数范围 / 默认类型 | 1–20 / flashcard | `selection.js:100-103` | 出题设置 |
| 补题题数范围 | 1–30 | `operations.js:217,359` | 出题设置（与 `ROUND_LIMIT` 同源） |
| 覆盖百分比刷新节流 | 3000 ms | `operations.js:679` | 内部常量，可保留 |
| 轻模型建议/路径超时 | 45000 ms | `operations.js:148,181` | 非 job 路径，记录即可 |
| 已完成 job 保留数 | 100 | `runtime/jobs.js:35` | 内核存储策略 |

## 6. 契约与控制台中的 kind 分支、与已发布内核的差额

**kind 分支（这些 kind 的专用代码）**：`lib/job-contract.js`：`CAPABILITIES` 静态表 `:51-63`（generation 声明 `pause:'checkpoint', retry:true`，`capsOf` `:67-72` 对非覆盖运行降为 `unsupported`）、`kindOf` `:75-80`（`type` 缺省=generation）、`stageOf` `:105-111`、`progressOf` `:135-150`、`detailOf` `:322-338`、`resultOf` `:345-360`（`short`/`stoppedEarly` 才算 partial，且只对 `generation`）。`ui/tasks/`：`task-model.js:18`、`task-summary.js:13,43,62,82`、`task-control.js:89`、`TaskBody.jsx:21-22`、`TaskConsole.jsx:142-146`（读草稿 `coverageRun` 判断“当前”）、`Timeline.jsx:13`、`time-limit.js`。S6 前新增同类任务仍要改这些分支；本步不改。

| 内核已发布要求（`lib/jobs/**`） | 出题家族现状 | 差额与步骤 |
|---|---|---|
| 定义注册 `registry.register(ctx,scope,{kind,version,run,capabilities,persistence})` | 无；入口函数内联建 job | S3-1 |
| `recoveryMode` 必须配 `persistence.open`（`registry.js`）；restart 需 inputRef/checkpoint | 无 inputRef；仅 coverage 有领域检查点 | S3-2（输入快照）、S3-3 |
| Attempt 与 Job 分离，同 Job 同刻一个活动 attempt | `job.id` 即 attempt；继续=新 id 并删除旧 interrupted 记录（D-4） | S3-3 |
| Step 带稳定 `stepKey`；Call 归属 Step | `stepKeyOf`=`kind:part`（`job-contract.js:381`），**轮次不在 key 内**，覆盖运行每轮的 `author:1` 冲突（D-6）；`step.id` 随机 | S3-2 |
| `endReason` 区分 `user-cancel/superseded/executor-lost`；`scope-unloaded` 拒绝动作 | 卸载=用户取消（D-3），`hostStopped`→`interrupted` 分支不可达 | S3-3/S3-6 |
| executorWitness 判断执行者是否仍活（`jobs/executor.js`） | `coverage.recover` 只看草稿标记，不检查执行者（V6） | S3-3 |
| 存储信封：commits、requestIntents、deliveries（`jobs/store.js`） | 领域回执分散：草稿版本、`selectionJobs`、`appendOperations`；发布无持久回执；通知无事件键 | S3-4/S3-6（扩展原回执，不建第二份产物表） |
| 网关 `createModelGateway`，档位/执行方式/用量归属唯一 | `providedComplete` 直调；用量两处 sink（内存 `job.tokenUsage` + 日账本）；`step.runtime||='direct'` 写死 | S3-1 |
| 调度/资源（`resources.js` provider 许可） | 库级承诺链 + `batch.js` 自带并发与 429 退避 | S3-1/S3-2 |
| contractVersion 2 | 控制台契约 v1 由 `snapshotJob` 派生（`job-contract.js:44`） | S3-1 经 `legacyFields` 适配 |
| 暂停声明与恢复模式分离 | `generation.retry:true` 同时表示“接着做”；plain 不能暂停 | S3-2/S3-3 |
| 累计用量跨 attempt | 覆盖运行 `tokensBase` 持久；plain 续做的 `job.tokenUsage` 重启即失 | S3-3 |

## 7. 发现的缺陷（只登记，未修复）

| 编号 | 描述 | 证据 | 归属 |
|---|---|---|---|
| D-1 | selection active 记录（`reviewing`）重启后再 `start` 重新写题，不复用已持久的候选；`reviewed` 记录更是被 `core.clear` 清掉重来（`selection-jobs.js:152-153`） | `…restart-selection` #1 | S3-4 |
| D-2 | selection 的 `bank.append` 已提交、记录未保存 `complete` 时重启：重写得到新卡 ID，银行拒绝“payload changed”，job 报失败而卡已在题组 | `…restart-selection` #2 | S3-4 |
| D-3 | 学习者停止与插件/owner 卸载在契约上都是 `cancelled`+`endReason:user-cancel`（`builtins.js:308`、`runtime.js:61` 都设 `cancelRequestedAt`）；`operations.js:880` 的 host-stopped→`interrupted` 在这两条卸载路径上不可达，覆盖运行卸载时草稿标记仍为 `running` 只是因为已卸载的 owner 写不进去 | `…terminals` #3 | S3-3/S3-6 |
| D-4 | 覆盖运行重启后“接着做”创建**新** job ID 并删除 interrupted 记录（`operations.js:478-480`、`contexts/jobs/operations.js:245-248`），逻辑 Job 身份丢失 | `coverage-run-exec`（`:357`） | S3-3 |
| D-5 | case 首份草稿：情景材料用 job 级新 ID 先 `source.add` 再 `draft.save`，两步之间退出会留孤立材料，重跑生成新材料 | 代码阅读 `operations.js:412,659-674`，未测 | S3-3 |
| D-6 | `stepKeyOf` 不含轮次/attempt，覆盖运行不同轮的同一 part 共用 stepKey | 代码阅读 `job-contract.js:381` | S3-2 |
| D-7 | plain 续做的 token 用量只在内存 job 上，重启后丢失（日账本不丢） | 代码阅读 `usage-scope.js`、`operations.js:622` | S3-3 |

## 8. 待核验（V）与原因

- V1 重启用“复制目录 + 新服务”模拟，不是真正杀进程；真实 DSH 宿主进程退出（含子代理仍在跑）未验。
- V2 子代理执行方式（`runtime:'subagent'`）下重启后子任务是否仍存活、归属如何，缺宿主证据（DSH 能力表待核验行）。
- V3 mixed 首份草稿前退出未单独测；与 plain 同一路径，仅 `kindCounts`（`batch.js:149`）不持久。
- V4 case 首份草稿检查点（`generation.js:810`）、孤立材料（D-5）与快速发布+批改窗口无便宜的假模型夹具，未测。
- V5 `draft.publish.start` 提交之后、通知之前退出的窗口未测；`draft.publish` 是单次 `state.update`，推断原子，但未用故障注入证实。
- V6 执行者仍活时的重复恢复（同库双进程）：`coverage.recover` 只在本进程跳过已有 job（`:1007`），跨进程未验。
- V7 `calibrationFor().record` 在重试时是否重复入账未测。
- V8 `batch.js` 的 429 退避与 `lib/index.js` 轻模型 hedge（`LIGHT_HEDGE_MS`）、S1-3 provider 许可之间是否叠加重试，需在 S3-1 对照；本步未改变。
- V9 supplement/selection 实际新增少于请求时契约 `completeness` 是否应为 partial（`resultOf` 的 `short` 只对 `generation`），未核。
- V10 S2 各步未合并；真实模型抽检、`npm run test:fast` / `npm run verify` 未在本步执行（仅单文件测试 + eslint）。
