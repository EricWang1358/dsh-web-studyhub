# S6-1：旧契约、ID 与扩展消费方兼容核对

核验日期：2026-10-07。分支 `codex/runtime-s61-compat`，基于 main（含 #326、#330）。工作包文本见 [U36](sprints-2-6.md#u36-s6-1)；前序：[S6-0 覆盖复核](s6-0-coverage.md)。

本步是**核对与登记**，只改了一处真问题（§2 的 `audio.v1` 取消）。结论先说：

1. 九个 `job.*` 门里，有**一个**对运行时任务不工作：已公开的 `audio.v1 job.cancel`（聊天工具 `study_audio` 调的就是它）对运行时任务**回答成功却不停任务**。已修，红灯→绿灯（§2）。
2. 任务有多个名字，各门接受的名字不一样（§3）；差异登记为缺口，**没有**悄悄统一。
3. 扩展任务服务（`context.work`）此前**没有直接的测试**，现在有 6 条（§5），之后任何"迁移/删除"它的改动都会红。
4. 持久化文件里的 `version` 字段多数**只写不校验**（§4）：未知版本不会被明确拒绝，而是被当作 v1 读、再被改写成 v1。这是 S6-6（最终读兼容与回退）要补的，本步只登记。
5. 固定回退版本的证据目前**只有非模型家族**（S5-7）；音频、出题、模型家族的回退演练分别属 S2-7、S3-7、S4-9（§6）。

## 1. 公开的门与它们读的东西

| 门 | 谁在用 | 怎么找任务 | 对运行时任务 | 证据 |
|---|---|---|---|---|
| `job.status`、`job.wait`（jobs 上下文，`lib/contexts/jobs/operations.js:333,350`） | 聊天工具 `study_workspace`、面板 | 列表 id；`contract.jobId`；`job.wait` 另认 `singleId` | 经 `ports.runtimeJobs.compatible(id)` 委托内核 | `job-contract`、`unified-runtime-lifecycle`、S4-10 测试 |
| `job.control`（`:227`） | 任务控制台（`contract.jobId`）、聊天工具 | 列表 id、`batchId`、`singleId`、`contract.jobId`（取最新一条） | 运行时任务经内核 `control`；其余经 `checkAction` | `job-control-*`、`job-archive-ops` |
| `job.output`（`:279`） | 控制台的"实时输出" | 同上 | 读 `jobOutputs`，不是内核的第二张表 | `job-output*` |
| `job.cancel`、`job.dismiss`、`job.archive`、`job.unarchive`、`job.delete`、`job.message`（`:72,108,138,167,197,307`） | 控制台、列表卡、聊天工具 | **只认列表 id**（`archive/dismiss/delete` 另认 `batchId/singleId/restoredArchive.ids`） | `job.cancel` 经 `compatible`；其余只动旧任务表与归档文件 | `job-archive-*`、`job-dismiss`、`unified-runtime-archive-read` |
| **`audio.v1`：`jobs`、`job.wait`、`job.cancel`**（`lib/contexts/audio/api.js`；工具 `study_audio` 的 `jobs/job.wait/job.cancel`，`lib/runtime/tools.js:28`） | 不装工作台的音频独立使用、聊天里的音频工具 | 列表 id（本步起也认 `contract.jobId`） | **本步修复**：运行时任务经内核停止；此前只试旧控制器，什么也停不了 | `tests/runtime-public-audio-api.test.mjs`（3 条，先红） |
| `snapshot.jobs` / `snapshot.archivedJobs`（`lib/runtime/builtins.js:131`、`lib/contexts/library/operations.js`） | 任务控制台、首页活动、各卡片 | 整个任务表 / 归档文件 | 运行时任务是同一张表里的一行（`work.jobs`），归档记录带 v2 合同 | `job-archive-service`、`unified-runtime-live-read` |
| 任务深链接（`ui/app/use-navigation.js:46` → `ui/tasks/TaskConsole.jsx:213`） | 信箱信、"看接着做的任务"、卡片 | `contract.jobId` 或列表 id；找不到再找归档 | 同一行 | `task-console-browser` |
| 信箱信（`audio-failed`、`audio-result`、`translate-*`、`note` …，字段 `jobId`） | 信箱、会话通知 | 信里的 `jobId`＝列表 id；重试后旧信被新信取代（`pruneLetters`） | 运行时任务的结算通知写同一类信 | 各家族的信测试、`job-archive-ops` |
| **扩展任务服务** `context.work`（`lib/runtime/tasks.js`） | 第三方扩展（`type:'extension'`） | 任务 id；owner＋domain 隔离 | 它**不是**统一运行时：没有网关、没有 Attempt，只是共享任务表里的一行 | `tests/runtime-extension-tasks.test.mjs`（6 条，本步新增）、S1-2 基线 |

## 2. 本步修的真问题：`audio.v1 job.cancel`

`audio.v1` 的 `job.cancel` 只做 `generationControllers.get(job.id)?.abort(...)`。旧音频任务在那张表里登记了取消控制器，**统一运行时的任务没有**（它的取消走内核）。所以只要某个音频开关打开：

- 聊天里的 `study_audio {operation: 'job.cancel'}`、不装工作台时的 `audio.v1 job.cancel` **回答成功、返回任务行，但模型请求照常继续、任务照常跑完**；
- 与之相对，jobs 上下文的 `job.cancel` 一直经 `ports.runtimeJobs.compatible(...)` 委托内核，面板上的"停止"是好的，所以这个缺陷在面板里看不到。

红灯：`tests/runtime-public-audio-api.test.mjs` 在 `audioSubtitles` 打开时 `runtime: audio.v1 lists a running audio job and job.cancel stops its request` 等不到"停止到达模型请求"而超时；旧路径一侧（`legacy:`）一直通过。

修法（`lib/contexts/audio/api.js`）：运行时任务（`job.contract.contractVersion === 2`）经本上下文自己的内核端口 `context.jobs.control(job.id, 'cancel')` 停止，原任务仍走控制器；顺带 `job.wait` 与 `job.cancel` 也认 `contract.jobId`（`job.status/wait/control/output` 本来就认）。不改内核。

## 3. 一个任务的名字

| 名字 | 是什么 | 谁认 |
|---|---|---|
| 列表 id（`id`，运行时任务的 `legacyId`；没有 `legacyId` 的定义是新 UUID，重试会换） | 旧任务表的键、卡片上的 id | 全部 `job.*` 与 `audio.v1` |
| `contract.jobId` | "跨重试不变"的逻辑名；运行时任务的内核 id | `job.status/wait/control/output`、内核端口、`audio.v1`（本步起）、控制台深链接 |
| `batchId` / `singleId` | 音频批次/单文件跨重试的名字（`lineage`） | `job.control/output/archive/dismiss/delete`、`job.wait`（`singleId`） |
| `restoredArchive.ids`、`restoredContract.jobId` | 归档/解除归档后的别名 | `archive/dismiss/delete/unarchive` |
| `convertId`（PDF 转换的 `legacyId`） | 转换的稳定名字，重试不变 | 同列表 id（S5-2 的 `legacyId(input)`） |
| `coach:YYYY-MM-DD` | 为你定制按天的一行 | `job.control/dismiss/delete`（专门分支），不归档 |

**缺口 A（登记，未改）**：`job.cancel`、`job.dismiss`、`job.archive`、`job.delete`、`job.message` **不认 `contract.jobId`**。对没有 `legacyId` 的运行时任务它与列表 id 不同，把合同里读到的 `jobId` 传给这五个动作会得到"找不到"。控制台是自洽的（`control/output` 用 `contract.jobId`，`cancel/archive/dismiss` 用列表 id），`docs/job-contract.md` 也只承诺 `job.control` 认 `contract.jobId`，所以这不是回归；但对聊天工具里的智能体是个坑。建议在 S6-5 把 `matching()` 一处扩成认 `contract.jobId`（加法，不影响现有名字）。

## 4. 持久化的旧记录：谁读、版本怎么校验

| 记录 | 读取处 | 文件/记录里的版本 | 遇到未知版本 |
|---|---|---|---|
| 内核任务存储（`lib/jobs/store.js`） | `store.js:34` | `schemaVersion: 1` | **明确拒绝**（`unsupported-store-version`），保留为只读记录，不恢复执行 |
| 音频批次/单文件 manifest 的 `runtimeJob` | `lib/contexts/audio/worker.js:226` | `runtimeJob.schemaVersion: 1` | 明确拒绝，保留为只读（`kernel-recovery-required`），不能被旧执行器恢复 |
| 归档里的任务合同 | `readJobContract`（`lib/jobs/contract.js`）经 `job.unarchive` | `contractVersion` 1 或 2，v2 另有 `runtime.schemaVersion` | **明确拒绝，且先于任何改动**（`unified-runtime-archive-read` 的 7 组用例） |
| `<库>/job-archive.json` 文件本身 | `lib/job-archive.js` `clean()` | `{ version: 1, records }` | **不校验**：`version: 2` 的文件被当 v1 读，下一次写入改写成 `version: 1` 并丢掉未知字段（本步探针证实）。缺口 B |
| PDF 转换 manifest | `lib/mineru-job.js` `readManifest` | `version: 1` | **不校验**。缺口 B |
| `marker-install.json` | `lib/marker-install.js` | `version: 1` | **不校验**。缺口 B |
| 转换历史 `<库>/conversion-history/<id>.json` | `lib/mineru-history.js` | 无文件版本；字段逐项清洗 | 损坏的单条被丢弃，不影响其他 |
| 出题运行存储（`generationRestart`） | `lib/generation-run-store.js`（输入与定义版本） | `definition-version-mismatch` 拒绝恢复 | 明确拒绝 |
| 信箱信（旧失败卡） | `recoverAudioBatches`（`worker.js:245`） | 无 | 只做"恢复卡"，不猜原路径 |
| 覆盖运行标记（草稿里） | `coverage.recover`（`generation/operations.js`） | 草稿即检查点 | 按草稿计划恢复 |

**缺口 B（登记，未改）**：三份单文件持久化（归档、转换 manifest、安装状态）写了 `version` 却从不校验。统一运行时没有改它们的格式，所以今天没有错读；但**将来**任何一次格式升级，回退到旧版本会把新格式当旧格式读并改写，丢数据而不报错。这属于 S6-6（最终读兼容与指定版本回退）：给这三处加"未知版本只读/拒绝，不改写"，并配回退演练。

## 5. 扩展任务服务的行为（现在有测试）

`tests/runtime-extension-tasks.test.mjs`（6 条，不动生产代码）固定：

1. 扩展任务是共享任务表的一行，合同里 `kind: extension`，只提供取消（没有重试/暂停/set）；
2. 别的 owner、别的 domain 看不到、读不到、停不了它；不存在的任务说同一句话（`Task not found for this owner`）；
3. 同一队列顺序执行、不同队列并行；带 `key` 的任务在还在跑时再启动得到同一个任务；
4. `wait(id, { timeoutMs })` 超时只返回当前样子，不打扰任务；不带超时则等到结束；
5. 取消：排队中的立即 `cancelled` 且从不运行；运行中的先 `cancelling`、等任务放手才 `cancelled`；失败与取消分开说；
6. 卸载：`cancelDomain` 只动那个 domain、`cancelOwner` 只动那个 owner、`dispose` 全停；任务都以 `cancelled` 结算。

## 6. 仍存活的旧/试点 attempt 与固定回退版本

| 情形 | 现状与证据 |
|---|---|
| 开关打开前的旧失败任务，开关打开后重启重试 | 音频：`unified-runtime-audio-relink`（转写与校对复用，只重做翻译与标题，同一文件夹改存运行时记录）；PDF：`recoverConvertJobs` 的"已中断"记录点「接着做」开一个 Job（`mineru-history-service.runtime`） |
| 开关打开期间产生的运行时记录，开关关闭后读取 | 运行时只写内核存储与归档 v2 合同；旧代码（开关关闭）读归档里的 v2 合同走 `readJobContract` 的只读路径（`unified-runtime-live-read` 的"存储的 v2 记录保留观察到的 runtime 与公开扩展"） |
| 固定回退版本 `v2.7.1`：旧版启动、已有产物可读、未完成任务可继续 | **非模型家族有证据**（S5-7 演练，`s5-7-evidence.json`，包括 PDF、安装、配置、索引）；**音频（S2-7）、出题（S3-7）、模型家族（S4-9）的回退演练尚未做**，S6-6 汇总时必须各有一份 |

## 7. S6-2 允许移除的精确入口与不能移除的

可以移除（S6-0 §7 的清单，现在补上兼容核对）：旧音频执行器 `startAudioJob`（已无调用者，`audioLiveSave` 已合并）、旧转换运行、旧出题运行 `startLegacy`、旧翻译卡运行、旧 MinerU 配置/索引后台运行、进程内的讲解/骨架/总结/助教/备题/笔记起草分支。移除前提：对应开关的孪生套件仍在运行时一侧通过，且 §4 的只读读取者保持。

**不能随之移除**（有现役消费方，且旧记录证据尚未穷尽）：

| 保留项 | 消费方 |
|---|---|
| `job.*` 里**旧任务表分支**（`job.cancel` 的控制器分支、`job.control` 的 `checkAction` 分支、`job.dismiss/archive/delete` 对旧行的处理） | 扩展任务（`type:'extension'`）、恢复出来的只读行、归档记录；`generationControllers` 还被托管出题/翻译 Job 的控制适配用（S6-0 缺口 6） |
| `readJobContract` 的 v1 与 v2 分支、`restoredContract/restoredArchive` | 归档里已有的 v1/v2 记录、固定回退版本写出的 v1 记录 |
| `recoverAudioBatches`、`recoverConvertJobs`、`coverage.recover`、信箱"恢复卡" | 开关打开前遗留的状态；回退到旧版本后新版再读 |
| `lib/runtime/tasks.js` | 扩展任务服务（公开 API）；它不是统一运行时的旧实现，S6-2 **不得**当作旧执行实现删除 |
| `audio.v1` 的 `jobs/job.wait/job.cancel` | 聊天工具 `study_audio`；其"控制器分支"在旧音频任务清零后才能删 |

## 8. 本步做了什么

- 修 `lib/contexts/audio/api.js`（§2），测试 `tests/runtime-public-audio-api.test.mjs`（3 条，先红后绿）；
- 新增 `tests/runtime-extension-tasks.test.mjs`（6 条，只固定现有行为）；
- 本文。没有改内核、没有改任何开关、没有删任何兼容层。

缺口 A、B 与"回退演练缺三家"是本步的未决事项；归属：A→S6-5，B→S6-6，回退演练→S2-7/S3-7/S4-9。
