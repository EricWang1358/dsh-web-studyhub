# S6-0：迁移覆盖与例外清单复核

核验日期：2026-10-07。分支 `codex/runtime-s60-coverage`，基于 main（含 #315、#317）。工作包文本见 [U35](sprints-2-6.md#u35-s6-0)；清单文件 [`s1-7-legacy-exceptions.json`](s1-7-legacy-exceptions.json)（本步升到 schemaVersion 2）。

> **状态更新（S4-10 的 PR，2026-10-07）**：S2-6（课堂保存，`audioLiveSave`）、S3-4（选区补题）、S4-10（`note.generate`，`noteGenerate`）已合并或随本 PR 合并，下面凡写"迁移 S2-6 / S3-4 / S4-10"的行都已完成并改成了现状；现在全开后仍在运行时之外的后台路径只剩两条：发布草稿（S3-6）和后台修题（S3-5）。清单（`s1-7-legacy-exceptions.json`）已按此更新，主表里改过的行标了"（已更新）"。

本步**只读、只登记**：不删除任何旧执行器（那是 S6-2），不改任何运行时行为。产物是：全开状态下仍在运行时之外的后台路径清单（§3）、对原有 33 条例外的逐条复核（§4）、新增的守卫测试（§6）、以及复核中发现的缺口（§5）。

## 1. 方法与"全开"的含义

**"全开"**＝`MIGRATION_SWITCHES` 的 21 个开关全部打开（`lib/runtime-config.js`）。一条后台路径"全开后仍在运行时之外"，指它在全开时仍会被某个入口启动，而启动它的执行者不是统一运行时的 Job。

**怎么找**：不靠名字，靠 AST 找"后台工作从哪里开始"的调用（`tests/helpers/runtime-architecture.mjs` 的 `inspectStarts`）：

- 往旧任务表登记的 `ownWork(...)`、`jobs.set`、`retryable.set`、`generationControllers.set`；
- 宿主子代理 `subagents.start / startContinuable`；
- 本地进程 `spawn / execFile / fork / runLocalCommand` 与 `new Worker`；
- 重复计时器 `setInterval`；
- 模块级的"活跃运行登记表"（`runs / setups / live* / inflight / active / persisters` 这几个名字的 `Map/Set`）。

这与既有的"模型调用点"清单（`inspectCalls`，`entries`）互补：后者找谁向模型发请求，前者找谁**启动了会在请求之后继续运行的工作**。独立的 `void promise.catch(...)` 不单列（它们延续的是上述某个启动点启动的工作）。

**怎么判定"全开后是否还走"**：读开关的分派点（每行给出 file:line）+ 该开关对应的孪生测试套件（`*.runtime.test.mjs`、`unified-runtime-*.test.mjs`）在运行时一侧通过。**限制**：没有一次"全开"的进程把每个入口都真实跑一遍；§6 的守卫用一个"全开服务能启动并读快照"的测试和逐行登记来约束，而不是穷举执行（见 §5 缺口 11）。

**处置词汇**（计划 U35 的分类落成三种处置）：

| 处置 | 含义 | 清单字段 |
|---|---|---|
| **迁移（migrate）** | 全开后仍在运行时之外运行；写明负责的步骤 | `step`（`S2-6`、`S3-4`、`S4-10` …） |
| **保留例外（exception）** | 有意保留；写明属于哪一类、为什么 | `kind` |
| **S6-2 删除（delete-s6-2）** | 对应开关打开后不可达的旧执行实现 | `switches`（旁路它的开关） |

例外的类别（`kind`）：只读历史适配（read-adapter）、合法 provider 实现（provider-leaf）、共享流水线（shared-pipeline，自己不发请求，模型由调用方传入）、领域缓存/单飞/写队列（domain-structure）、即时请求（foreground-request）、会话子系统（session-subsystem）、控制适配（control-adapter）、公开 API（public-api）、内核本身（kernel）、匹配误报（not-a-job）。

## 2. 21 个开关与它们旁路的旧路径

| 开关 | 旁路什么（开关打开后不再被启动） | 分派点 | 运行时一侧的证据 |
|---|---|---|---|
| `audioSingle` | 单文件导入/重试的旧执行器 | `lib/contexts/audio/worker.js:181`（`runsOnRuntime`） | `audio-retry.runtime`、`unified-runtime-audio-pilot` |
| `audioBatch` | 批次导入/重试的旧执行器 | `worker.js:149` | `audio-batch.runtime`、`unified-runtime-audio-batch` |
| `audioSubtitles` | 字幕导入的旧执行器 | `lib/contexts/audio/operations.js:164` | `subtitle-review-flow.runtime`、`unified-runtime-subtitles` |
| `audioReview` | 转写复查的旧执行器 | `operations.js:176` | `subtitle-review-flow.runtime`、`unified-runtime-review` |
| `audioLiveSave` | 课堂"校对并保存"的旧执行器（`startAudioJob` + `executeLiveSaveJob`，S2-6 #325） | `lib/contexts/audio/operations.js`（`live.save`） | `audio-family-baseline-live.runtime`、`unified-runtime-live-save` |
| `audioLiveCorrection` | 课堂滚动校正的旧计时器与旧校正调用 | `operations.js:211,257,270`；`lib/live-correction.js:127` | `unified-runtime-live-correction` |
| `generation` | 出题/补题的旧任务表与旧执行器 | `lib/contexts/generation/jobs/submit-generation.js:9`（`startLegacy`） | `generation-family-baseline-queue.runtime`、`unified-runtime-generation-*` |
| `generationPublish` | 发布草稿的旧路径（`startLegacy`，需要 `generation`；没有 `generation` 时此开关不起作用） | `lib/contexts/generation/jobs/submit-generation.js:9`（`startLegacy`） | `draft-publish.runtime`、`unified-runtime-publish` |
| `generationRepair` | 后台修题的旧路径（`startLegacy`，需要 `generation`；没有 `generation` 时此开关不起作用） | `lib/contexts/generation/jobs/submit-generation.js:9`（`startLegacy`） | `draft-repair.runtime`、`unified-runtime-repair` |
| `generationRestart` | 重启后只靠草稿标记恢复（仍保留，见 §3 `coverage.recover`） | `lib/contexts/generation/operations.js:73` | `unified-runtime-recovery`（本开关的 S3-3 记录） |
| `translation` | 翻译卡的旧任务表与旧执行器 | `lib/contexts/generation/translation-jobs.js:38,124` | `translation-jobs.runtime`、`unified-runtime-translation` |
| `audioLiveSave` | 课堂保存（校对）的旧执行器（原先经 `startAudioJob`） | `lib/contexts/audio/operations.js:336` | `unified-runtime-live-save` |
| `dailyRecapAgent` | 不是旁路旧路径，而是策略：每日总结向宿主子代理提问（S4-8，经网关） | `lib/contexts/notes/jobs/submit-daily-recap.js:17` | `unified-runtime-agent-policy` |
| `workflowAgent` | 不是旁路旧路径，而是策略：学习流向宿主子代理提问（S4-8，经网关） | `lib/contexts/workflows/jobs/submit-workflow.js:23` | 同上 |
| `noteGenerate` | 笔记 AI 起草的进程内执行 | `lib/contexts/notes/jobs/submit-note-generate.js:14` | `blog-notes.runtime`、`unified-runtime-note-generate` |
| `translationParallel` | 不是旁路旧路径，而是策略：翻译离开整库出题的队列链（`translation/lane.js`），仍在 `work.queues` 里排队 | `translation-jobs.js:39` | `translation-jobs.runtime-parallel`、`unified-runtime-translation-scheduling` |
| `coach` | 为你定制备题批次的进程内执行 | `lib/contexts/coach/jobs/submit-coach-prep.js:12` | `coach.runtime`、`unified-runtime-coach` |
| `dailyRecap` | 每日总结的进程内执行 | `lib/contexts/notes/jobs/submit-daily-recap.js:13` | `daily-recap.runtime`、`unified-runtime-daily-recap` |
| `workflow` | 讲解与骨架的进程内执行 | `lib/contexts/workflows/jobs/submit-workflow.js:21` | `workflow-teaching.runtime`、`unified-runtime-workflows` |
| `dailyRecapAgent` | 不是旁路旧路径，而是策略（登记在清单 `policySwitches`）：每日总结的模型调用改问宿主子代理，没有时回落直连并记原因（S4-8 #321） | `lib/contexts/notes/jobs/submit-daily-recap.js`（绑定里的 `agent`） | `unified-runtime-agent-policy` |
| `examBlueprint` | 不是旁路旧路径，也没有旧路径：考点清单构建（备考补习，3.1 步骤 2；代码名 blueprint）是新增的 Job 种类，开关只决定是否接纳新的构建（登记在清单 `policySwitches`） | `lib/contexts/generation/blueprint/start.js` | `exam-blueprint-job` |
| `workflowAgent` | 同上：讲解与骨架的模型调用改问宿主子代理（S4-8 #321） | `lib/contexts/workflows/jobs/submit-workflow.js`（绑定里的 `agent`） | `unified-runtime-agent-policy` |
| `assist` | 助教请求的进程内执行 | `lib/contexts/study/jobs/submit-assist.js:15` | `assist-host.runtime`、`unified-runtime-assist` |
| `pdfConvert` | PDF 云端/本地转换的旧后台运行 | `lib/contexts/audio/convert.js:49` | `mineru-service.runtime` 等 4 个孪生、`unified-runtime-pdf-convert` |
| `markerInstall` | Marker 安装的旧后台运行 | `lib/contexts/audio/install/marker-install-runs.js:13` | `marker-install-service.runtime`、`unified-runtime-marker-install` |
| `mineruSetup` | MinerU 本地配置的旧后台运行 | `lib/contexts/audio/setup/mineru-setup-runs.js:47` | `mineru-local-service.runtime`、`unified-runtime-mineru-setup` |
| `retrievalIndex` | 检索索引构建的旧后台运行 | `lib/contexts/generation/retrieval/runtime-port.js:4`（`index-runs.js`） | `wp28b-index.runtime`、`unified-runtime-retrieval-index` |

**没有开关的新 Job 种类。** 课程总纲的整理任务 `course-outline-build`（2026-10-09，总纲步骤 2，`lib/contexts/generation/outline/`）和考点清单一样是新增的种类，没有旧路径可旁路，所以也不加开关：它登记在清单的 `managedDefinitions`（守卫逐个审计），没有新的模型调用点或启动点（每次调用都是网关的 Step，复用 `blueprint/jobs/ask.js`），操作是 `generation.courseOutline.build`（写入为空，总纲经资料上下文的 `sources.ingest` 入库）。证据：`course-outline-job.test.mjs`。复习全书的生成任务 `course-book-build`（2026-10-09，`lib/contexts/generation/book/`）同理：登记在 `managedDefinitions`，没有新的模型调用点或启动点（复用同一个 `ask.js`；没有总纲时，它在同一个 Job 里直接调用总纲的阶段 `organiseOutline`，不另起任务），操作是 `generation.courseBook.build`（写入为空，全书和它整理出的总纲在最后一步经 `sources.ingest` 一次入库）。证据：`course-book-job.test.mjs`。

## 3. 全部后台启动点（`starts`，33 个文件 48 处）

读法：**全开后**列写"仍走"表示这一处在全开时仍可能被启动。三种处置的数量（启动点，S3-6 合并后）：迁移 0、保留例外 31、S6-2 删除 15（§7 给删除清单）。**答案**：全开后已经没有自己起后台任务的旧路径；全开后没有要迁移的模型调用（发布前审阅已是即时请求，S3-6d）。课堂保存 S2-6、选区补题 S3-4、后台修题 S3-5、发布草稿 S3-6、`note.generate` S4-10 已迁完；其余都是有类别、有理由的保留，或被开关旁路的旧实现。

### 3.1 音频

| 启动点（file:line） | 启动什么 | 全开后 | 处置 |
|---|---|---|---|
| `lib/contexts/audio/worker.js:50-68`（`startAudioJob`：`ownWork`、`jobs.set`、`retryable.set`、`generationControllers.set`） | 旧音频执行器 | 不走：单文件、批次、字幕、复查、课堂保存（`audioLiveSave`，`operations.js:336`）五个调用点都已被开关旁路（已更新） | S6-2 删除 |
| `lib/contexts/audio/operations.js:147-148`（`audio.retry` 的旧重试与回放） | 旧重试路径 | 不走（已更新：课堂保存也已在运行时） | S6-2 删除 |
| `lib/contexts/audio/worker.js:229-245`（`recoverAudioBatches`） | 上次进程遗留的文件夹和信件变成只读/可重试记录 | 仍走（开关打开前的遗留；重试一律进运行时） | 保留例外：只读历史适配 |
| `lib/contexts/audio/worker.js:274`（`spawnCorrection`） | 旧校正的宿主子代理调用 | 不走（`audioLiveCorrection` 打开后由 Job 校正） | S6-2 删除 |
| `lib/live-correction.js:127`（`setInterval`） | 旧滚动校正计时器 | 不走（`managed` 时 `start()` 直接返回） | S6-2 删除 |
| `lib/contexts/audio/operations.js:214`（`ownWork(session)`）、`lib/live.js:134`（看门狗 `setInterval`） | 一场实时课堂（连接与它的生命周期） | 仍走 | 保留例外：会话子系统（计划：实时连接留在会话子系统；它的校正和保存是任务） |
| `lib/groq.js:67,81`（`spawn` ffmpeg） | 音频窗口的解码与切分，在音频 Job 内部 | 仍走（Job 内的叶子工作） | 保留例外：provider 实现；**不记为 Call**（缺口 7） |

### 3.2 PDF 与非模型任务

| 启动点（file:line） | 启动什么 | 全开后 | 处置 |
|---|---|---|---|
| `lib/contexts/audio/convert.js:52-56`（`ownWork`、`jobs.set`、`retryable.set`、`generationControllers.set`） | 旧转换后台运行 | 不走（`:49` 分派到 `startPdfConvert`） | S6-2 删除 |
| `lib/contexts/audio/convert.js:93-95`（`recoverConvertJobs`）、`:320`（重试失败时放回） | 重启遗留的转换变成"已中断，可接着做"的记录；「接着做」开一个 Job | 仍走（只读适配；执行进运行时） | 保留例外：只读历史适配 |
| `lib/contexts/audio/setup/legacy-setup-run.js:7`（`setups` 登记） | 旧 MinerU 配置后台运行 | 不走 | S6-2 删除 |
| `lib/contexts/generation/retrieval/legacy-index-run.js:9`（`runs` 登记） | 旧索引构建后台运行 | 不走 | S6-2 删除 |
| `lib/marker-install.js:391`（旧 `start/cancel`）、`:250`（`live` 安装槽）、`:114,197,345`（阶段里的 `runLocalCommand`） | 旧安装器；DSH_HOME 唯一安装槽；安装阶段的进程 | 旧安装器不走；安装槽与阶段仍走（Job 经 `claim/begin` 用同一套） | 旧安装器 S6-2 删除；槽与阶段保留（领域结构、provider 实现） |
| `lib/marker-local.js:36`（`detectMarker`）、`:75`（一个 Marker 转换窗口） | 即时的"Marker 是否可用"（最长 2 分钟，调用方在等）；转换窗口在转换 Job 内 | 仍走 | 保留例外：即时请求 / provider 实现 |
| `lib/mineru-local.js:81`（`runCli`） | 本地 MinerU 的状态、启服务、解析窗口 | 仍走 | 保留例外：provider 实现 |
| `lib/local-command.js:14,30`（`spawn`） | 唯一的本地程序运行器（进程树停止、`KILL_WAIT_MS`） | 仍走 | 保留例外：provider 实现 |

### 3.3 出题、补题、翻译

| 启动点（file:line） | 启动什么 | 全开后 | 处置 |
|---|---|---|---|
| `lib/contexts/generation/jobs/submit-generation.js:9-14`（`startLegacy`） | 旧出题执行器 | 不走（`generation`） | S6-2 删除 |
| `lib/contexts/generation/draft-publish.js`（`draft.publish.start`，经 `startGeneration`） | 发布草稿的后台任务 | 不走（`generation` + `generationPublish`；旧实现 = 上一行的 `startLegacy`） | S6-2 删除 `startLegacy` 时一并 |
| `lib/contexts/generation/draft-repair.js`（`draft.repair`，经 `startGeneration`） | 后台修题 | 不走（`generation` + `generationRepair`；旧实现 = 上一行的 `startLegacy`） | S6-2 删除 `startLegacy` 时一并 |
| `lib/contexts/generation/selection-jobs.js`（S3-4 #324 后不再自起任务） | 选区补题经 `submit-generation.js` 的 `startGeneration` 分派，旧一侧即上一行的 `startLegacy` | 不走（`generation`） | 随 `startLegacy` 在 S6-2 删除；清单里本文件的 starts 行已删 |
| `lib/contexts/generation/selection.js:91` | 选区操作的单飞表（同一 operationId 只答一次） | 仍走 | 保留例外：领域单飞结构 |
| `lib/contexts/generation/operations.js:998-999`（`coverage.recover`） | 上次进程中断的覆盖运行，从草稿标记恢复成"已中断"记录 | 仍走（开关打开前的遗留；`generationRestart` 打开后的新运行由内核恢复） | 保留例外：只读历史适配 |
| `lib/contexts/generation/jobs/generation.js:42`、`lib/contexts/generation/translation/jobs/translation.js:40` | Job 把取消控制器登记进旧表，控制台控件读它 | 仍走 | 保留例外：控制适配（S6-5 改读内核） |
| `lib/job-control.js:43`（`setInterval`） | 暂停边界轮询 | 仍走 | 保留例外：控制适配（S6-5） |
| `lib/contexts/generation/translation-jobs.js:132-134` | 旧翻译卡运行 | 不走（`:38,124` 分派） | S6-2 删除 |
| `lib/contexts/materials/translation-operations.js:30`（`inflight`） | 读者翻译调用的取消句柄 | 仍走 | 保留例外：领域结构 |

### 3.4 为你定制、每日总结、学习流、助教、笔记

| 启动点（file:line） | 启动什么 | 全开后 | 处置 |
|---|---|---|---|
| `lib/contexts/coach/worker.js:63`（`coachTask`）、`:109`（`queuePrep`）、`:129`（`flushPrep`） | 备题批次的库内队列与延时合并；改题 `rewrite` 也经 `coachTask` | 队列仍走；批次本体是 Job | 保留例外：领域队列；进程内批次本体（`coach` 关闭时）S6-2 删除 |
| `lib/contexts/notes/daily.js:95`、`:10`（`liveGenerations`） | 每日总结的待办记录（替换/追赶语义）；进程内执行（`dailyRecap` 关闭时） | 待办记录仍走；执行是 Job | 领域结构保留；进程内执行 S6-2 删除 |
| `lib/workflow-skeleton.js:139-140`、`lib/workflow-teaching.js:185-186` | 骨架/讲解的单飞表；进程内执行（`workflow` 关闭时） | 单飞表仍走；执行是 Job | 领域结构保留；进程内执行 S6-2 删除 |
| `lib/assist.js`（`tasks` 表与进程内请求，见 §4） | 助教请求列表；进程内执行 | 列表仍走；执行是 Job | 列表保留；进程内执行 S6-2 删除 |
| `lib/contexts/notes/operations.js:66`（`note.generate`）、`lib/contexts/notes/note-generation.js` | 后台起草一篇博客笔记。已更新（S4-10）：本体是 Job `note-generate`（`noteGenerate`）；`pending` 记录（保存/删除/卸载靠它停止）仍在；进程内执行在开关关闭时由同一个本体承担 | pending 仍走；进程内执行不走 | pending：保留例外（领域结构）；进程内执行：S6-2 删除 |

### 3.5 平台与内核

| 启动点（file:line） | 启动什么 | 全开后 | 处置 |
|---|---|---|---|
| `lib/runtime/tasks.js:41-44` | 第三方扩展任务（`type:'extension'`） | 仍走 | 保留例外：公开 API（S6-1 核对兼容；它没有模型网关） |
| `lib/contexts/jobs/operations.js:179` | `job.*` 把运行时的历史行恢复进任务表（只读） | 仍走 | 保留例外：只读历史适配 |
| `lib/host-capabilities.js:123`（`subagents.start`）、`lib/generation-continuable.js:30` | 宿主子代理：网关与（旧）助教/出题/校正代理共用的唯一启动处 | 仍走（网关的 agent 模式） | 保留例外：provider 实现 |
| `lib/jobs/lifecycle/control.js:37,49`、`lib/jobs/lifecycle/scoped.js:55,77`、`lib/jobs/lifecycle/job-record.js:30` | 内核把自己的 Job 写进任务表、挂到 owner | 仍走 | 保留例外：内核 |

## 4. 模型调用点清单（`entries`，原 33 条 + 本步新增 5 条）的复核

结论：**原 33 条全部仍存在**（守卫是逐文件逐调用精确比对，缺一或多一都失败），**没有一条因为已过时而可删**；其中 2 条是匹配误报，随匹配器的收紧离开清单。但：

- 33 条里有 21 条的理由是同一句话"Registered legacy/shared pipeline call boundary; not a newly migrated definition"，**并不说明它是什么**；本步已逐条改成实际职责与去向。
- 复核后共 43 处登记（36 条，含新增 5 条）；随 S2-6、S4-10 更新后：迁移 2、保留例外 35、S6-2 删除 6。
- 2 条是匹配误报（`lib/contexts/materials/translation-operations.js` 的局部数组 `tasks`、`lib/workflow-skeleton.js` 的局部数组 `queues`，不是任务表）：所有者决定后匹配器不再数"嵌套函数里的局部变量"（§5 决定 3），这两条随之从清单消失，原 33 条变为 31 条，加新增 5 条共 36 条。
- 另有 5 条目录/静态数组类（`audio-files.js`、`library-usage.js`、`sample-library.js`、`lib/runtime/builtins.js`、`lib/runtime/domain-contracts.js`）确认不是任务调度。

| 文件 | 全开后 | 处置 / 类别 | 说明 |
|---|---|---|---|
| `lib/assist.js:64,119` | 列表仍走；进程内请求不走 | 列表保留；进程内 S6-2 删除（`assist`） | `inProcess` 只在 `assistExecutor` 取不到 Job 路径时用 |
| `lib/audio-files.js:16` | 仍走 | 例外：误报（目录遍历队列） | |
| `lib/audio-gateway-calls.js:40,43` | 仍走 | 例外：provider 实现 | 网关步骤里的 Gemini 文字调用 |
| `lib/contexts/audio/jobs/live-correction-models.js:23,24` | 仍走 | 例外：provider 实现 | 同上，课堂校正 |
| `lib/audio-import.js:56,79,102,313` | 仍走 | 例外：共享流水线 | 校对/翻译/标题的模型由调用方传入：运行时传网关步骤 |
| `lib/audio-job.js:142,145,295,301` | `importAudio` 原提供者分支不走；`jobTextModel` 仍走 | 原分支与 `jobTextModel` 都在开关旁路之后不可达：S6-2 删除（已更新：课堂保存已迁） | |
| `lib/audio-review.js:90` | 仍走 | 例外：共享流水线 | |
| `lib/batch.js:171,234` | 仍走 | 例外：共享流水线 | 出题流水线，模型由调用方传入 |
| `lib/capture.js:114,211,222` | 仍走 | 例外：即时请求 | 决定 S4-0：即时模型请求保持即时 |
| `lib/coach.js:161,192,215,251,403` | 仍走 | 例外：即时请求（nudge/debrief/rewrite）+ 共享流水线（备题） | 同上 |
| `lib/contexts/audio/worker.js:262,272` | 实时翻译仍走；旧校正调用不走 | 翻译：会话子系统；旧校正 S6-2 删除（`audioLiveCorrection`） | |
| `lib/contexts/notes/daily-generation.js:39,48`、`lib/daily-recap.js:256` | 仍走 | 例外：共享流水线 | 每日总结的模型由调用方传入 |
| `lib/followup.js:50`、`lib/ingest.js:59`、`lib/oral-exam-service.js:36`、`lib/rubric-grading.js:29` | 仍走 | 例外：即时请求 | 单次等待的请求，无任务记录 |
| `lib/generation.js:96,101,142,272,273,756` | 仍走 | 例外：共享流水线 | |
| `lib/index.js:168,214,218,227,237,248,251,257` | 仍走 | 例外：provider 实现 | DSH `ctx.llm.stream` 与宿主子代理路由；网关经它到模型 |
| `lib/jobs/gateway.js:138` | 仍走 | 例外：内核 | 批准的模型网关 |
| `lib/library-usage.js:46`、`lib/sample-library.js:89` | 仍走 | 例外：误报 | |
| `lib/live-job.js:39,42` | 不走（已更新：`audioLiveSave`） | S6-2 删除 | 原课堂保存运行器；Job 共用 `translateLive` |
| `lib/live.js:553` | 仍走 | 例外：会话子系统 | 逐句实时翻译 |
| `lib/runtime/builtins.js`、`lib/runtime/domain-contracts.js` | — | 例外：误报（静态数组） | |
| `lib/runtime/models.js:30` | 仍走 | 例外：provider 实现 | 宿主模型适配 |
| `lib/runtime/tasks.js:9` | 仍走 | 例外：公开 API | 扩展任务队列 |
| `lib/runtime/work.js:11-30` | 仍走 | 例外：内核（`jobs`，控制台读的表）+ 领域单飞/队列表；`queues`/`settled` 仍被出题与翻译 Job 排队使用（S3-1 保留，S6-5 由内核调度取代） | |
| `lib/translation.js:80` | 仍走 | 例外：共享流水线 | 读者直接翻译与翻译卡共用 |
| `lib/workflow-teaching.js:115` | 不走（`workflow` 打开后由 Job 执行） | S6-2 删除 | 进程内讲解调用 |
| **新增** `lib/contexts/authoring/publication.js:87` | 仍走（学习者或助手自己调 `draft.publish` 的那次审阅） | 保留例外：即时请求（`draft.publish.review`，经 `lib/runtime/instant.js`：用量记一次、`instant-text` 租约，S3-6d）；任务里的审阅走网关（`a.ask`）或随旧任务的 `startLegacy` 在 S6-2 删除 | 发布前审阅，随 `draft.publish` |
| **新增** `lib/contexts/generation/operations.js:161` | 仍走 | `generate.suggest` 即时请求（例外）；`draft.repair` 的模型调用已搬到 `draft-repair.js`，经网关一步（S3-5） | |
| **新增→已更新** `lib/contexts/notes/note-generation.js` | 仍走 | 例外：共享流水线 | S4-10 把 `note.generate` 的模型调用抽到这里，模型由调用方传入（网关步骤 `note:1`） |
| **新增** `lib/contexts/recording/operations.js:54` | 仍走 | 例外：即时请求 | `capture` 的宿主模型调用 |
| **新增** `lib/contexts/study/operations.js:134` | 仍走 | 例外：即时请求 | `card.grade` |

## 5. 发现的缺口（本步不修，登记并给出去向）

1. **（已解决：S2-6，`audioLiveSave`）课堂保存（校对）没有开关，仍在旧音频执行器上**（`operations.js:335`、`lib/live-job.js`、`lib/audio-job.js` 的 `jobTextModel`）：它是 S2-6（U7，A 道）；S2-6 迁完才能删 `startAudioJob`（见 §7 顺序）。
2. **`note.generate`（博客笔记后台起草）完全不在计划里**：模型直接调用、自己的表项、没有 Job、不在任务控制台。**已决定（所有者，2026-10-07）并已完成**：成为新工作包 S4-10（`noteGenerate`），见 `s4-10-note-generate.md`。
3. **即时模型请求绕过网关**：capture、card.grade、followup、ingest、oral exam、`generate.suggest`、教练的 nudge/debrief/rewrite、实时翻译等直接调用宿主模型。它们是 S4-0 明确保持即时的请求，但这意味着它们**不进统一的资源许可、用量与观测**（只靠既有每日账本）。**已决定（所有者，2026-10-07）**：保持即时，但 S6-5 必须让它们经网关的计量路径共享 provider 配额与用量账本，见下面"所有者决定"。
   **S6-5a 已做**：这些请求现在经唯一的计量入口 `lib/runtime/instant.js`（共享 provider 配额的 `instant-text` 租约 + 用量账本只记一次）；入口、定义与兼容 getter 之外调用 `modelServices(` 会被守卫拒绝；名单与处置见 `s6-5a-instant.md` 与清单的 `hostModelAccess`。`materials.selection.ask` 今天不记账本，是登记在案的缺口。
4. **模型调用点清单漏掉了别名调用**：旧匹配只认名为 `complete` 的函数，漏了 `providedComplete/providedLight`（上下文操作拿到的宿主模型）。本步把这两个名字加进匹配，新发现 5 个文件（上表"新增"行）。仍然看不到的：经其他名字传递的模型函数（如 `askLight`、`ask`）——它们出现在注入模型的流水线内，由调用方负责，登记为共享流水线。
5. **原清单的理由大面积失真**（33 条里 21 条是同一句套话）、2 条误报：理由已重写；误报已随匹配器收紧消失（决定 3）。
6. **控制适配仍挂着旧表**：托管出题/翻译 Job 仍把控制器登记进 `generationControllers`、控件读 `jobControls`、暂停边界靠 `job-control.js:43` 的轮询、并仍在每库 `work.queues` 里排队（S3-1 的选择）。这些是 S6-5"全家族控制台"要收的。
7. **ffmpeg 与本地程序没有统一观测**：`groq.js` 的 ffmpeg 解码/切分在音频 Job 里，随取消停止，但**不记为 Call**；`marker.local.status` 最长等 2 分钟（`MARKER_DETECT_TIMEOUT_MS`），是即时请求里最长的一个（S5-0 的 V-6 同类问题）。
8. **重启恢复的读适配是三份**：`recoverAudioBatches`、`recoverConvertJobs`、`coverage.recover` 各自把旧状态变成"已中断"记录。全开时只为开关打开**之前**留下的状态创建记录；它们的去留要和 S6-1（旧契约与 ID 兼容）、S6-6（最终读兼容与回退）一起定。
9. **维护类的后台清理没有登记**（`sweepStale`、`sweepRetiredAudioBatches`、`job-cleanup.js`、`atomic-json.js` 的 `void …catch`）：它们是文件清理，不是任务，不属于运行时；这里只记一笔，守卫不覆盖。
10. **守卫的已知盲区**：只认调用表达式；不看动态拼出的函数名、经 `Reflect`/`apply` 的调用、新的宿主子代理 API 名。登记表按名字匹配（`runs/setups/live*/inflight/active/persisters`），换个名字的新登记表要靠评审。
11. **"全开"是读出来的，不是跑出来的**：每个开关有孪生套件在运行时一侧通过，加上"全开服务能启动并读快照"的测试，但没有一个全开进程把全部入口跑一遍。S6-7（alpha 总验收）应补一个全开混跑。

### 所有者决定（2026-10-07，协调者转达）

1. **`note.generate` 成为新工作包 S4-10**（模型任务家族，由 D 道负责）：开关 `noteGenerate`（`MIGRATION_SWITCHES` 一行，默认关）；定义放在 `lib/contexts/notes/jobs/note-generate.js`，登记在 `managedDefinitions` 的 `notes` 行；每个模型调用都经 `context.gateway.step`，用 `initialPresentation`（见 `s2-architecture.md` §4.1）让卡片在提交时就是完整的；旧/运行时孪生套件，先取红灯证据。它同时是 S6-4（新增一种任务不改内核）的真实证据，PR 里记录 diff 范围。清单里它的步骤从 `unassigned` 改为 `S4-10`。
2. **即时模型请求保持即时，不建 Job、不出卡片**（S4-0 是有意的决定）。**S6-5 的要求**：它们仍须经网关的计量路径共享 provider 配额与用量账本，不能绕过。现在不实现，只记录为 S6-5 的验收条件（缺口 3）。
3. **匹配器收紧**：所有者要求"只认模块级"。核对后严格的模块级会丢掉清单里绝大多数真实的表（`runtime/work.js` 的全部任务表在工厂函数里，`assist.js` 的 `tasks`、`runtime/tasks.js` 的 `queues` 也是），只剩 2 处静态数组，等于废掉这条守卫。因此实际做法是：**模块级与工厂级的变量、以及对象属性仍然计数；嵌套函数里的局部变量不再计数**（`walk` 现在把"外面包了几层函数"交给访问者）。效果恰好是去掉那 2 条误报，其余全部保留；启动点的红灯探针（`lib/` 下放一个 `ownWork` 调用）依旧失败。

## 6. 守卫测试（`tests/unified-runtime-architecture.test.mjs`，扩展，未新建）

| 测试 | 防什么 |
|---|---|
| `inspectStarts sees real starts, not strings, comments or regular expressions` | 匹配器本身：字符串、注释、正则的 `.exec` 不算启动 |

| `every place background work starts is reviewed…` | **全开状态下出现清单之外的新启动点就失败**：逐文件逐调用精确比对 `starts` |
| `every reviewed site has a disposition that holds…` | 每个文件至少一个登记的 site；`migrate` 写步骤（`S4-10` 这样的编号）、`delete-s6-2` 写旁路它的开关且不可达、`exception` 写类别且已被到达 |
| `every migration switch bypasses something in the inventory, and every inventory row appears in the coverage document` | 每个开关都有被登记的旧路径；清单里的每个文件与每个开关名都在本文出现 |
| `with every migration switch on at once the service starts…` | 全开的服务能启动并读快照 |

既有的三个测试仍然成立；第三个（模型调用点精确清单）现在带 `providedComplete/providedLight`。

## 7. S6-2 删除清单与顺序

> **决定（协调者，2026-10-07）**：每个开关现在都默认关闭，所以下面这些"旧实现"其实是**今天的默认路径**，关开关就是回滚。S6-2 因此**只删任何开关取值下都没有使用者的代码**（被运行时取代、没人再到的包装，迁移留下的死辅助函数，不可达分支）；下表的整体删除**等默认值翻转之后**——那发生在真实模型抽样与 alpha 之后（S6-7，所有者已授权这两道关）。清单里这些行的 `removeAt` 为 `after default flip`，守卫测试要求如此。`lib/runtime/tasks.js`（扩展任务公开 API）保留。S6-2 的实际删除与证明见 `s6-2-dead-only.md`。

只列处置为 S6-2 删除的旧实现（对应开关打开后不可达）；**不在 S6-2 删除，等默认值翻转**。

| 顺序 | 旧实现 | 前置 |
|---|---|---|
| 1 | `lib/contexts/audio/convert.js:52-56`（旧转换运行）、`setup/legacy-setup-run.js`、`retrieval/legacy-index-run.js`、`lib/marker-install.js` 旧 `start/cancel`、`lib/contexts/generation/jobs/submit-generation.js` `startLegacy`、`translation-jobs.js:132-134`、`lib/workflow-skeleton.js`/`workflow-teaching.js` 的进程内执行、`submit-coach-prep`/`submit-daily-recap` 的进程内分支、`lib/assist.js` 进程内请求 | 无（对应开关已合并）；S6-1 先核对兼容 |
| 2 | `lib/live-correction.js:127` 计时器、`worker.js:274` 旧校正调用 | `audioLiveCorrection` 合并后的回退窗口结束 |
| 3 | `lib/contexts/audio/worker.js` `startAudioJob`、`operations.js:147-148` 旧重试、`audio-job.js` 的 `importAudio` 旧提供者分支与 `jobTextModel`、`lib/live-job.js` 的 `executeLiveSaveJob`、`lib/contexts/notes/jobs/submit-note-generate.js` 之外的进程内笔记起草分支 | 已无前置（S2-6 已合并）；S6-1 先核对兼容 |

## 8. 本步未做

- 不删除任何旧执行器（S6-2）；不改任何运行时行为；不改变匹配器的"按名字"规则（缺口 5）。
- 缺口 1、2、3、7、8 的处理属于各自的后续步骤（S2-6、S4-10、S6-5 …），不在本步。
