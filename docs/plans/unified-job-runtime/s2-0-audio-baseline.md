# S2-0：音频家族基线与所有权表

> 源码基线：`origin/main` `8d661f4`（S1-7 已合并，package 2.7.1）。本步**没有改任何生产代码**：只补特征测试、写本记录。单文件导入已由 [s1-0-audio-behavior.md](s1-0-audio-behavior.md) 与 [s1-6-audio-contract.md](s1-6-audio-contract.md) 记录，这里只在与其余入口对照时引用，不重做。
>
> 证据三类：**测试断言**（本步新增或既有，已在基线 SHA 上执行）、**源码观察**（只读代码，附 file:line）、**待核验**（没有动态证据，写明原因）。引用行号为 `8d661f4` 的行号。

## 1. 入口与读法

| 入口 | 公开动作 | 记录创建者 | 备注 |
|---|---|---|---|
| E1 单文件导入 | `audio.import {path\|uploadId}` | `startSingleAudio`（`worker.js:164`）或试点 `startManagedSingle` | 见 S1，不在本表 |
| E2 批次导入 | `audio.import {files}` | `startBatch`（`worker.js:142`）→ `startAudioJob` | manifest 在 `audio-batches/<batchId>/` |
| E3 重试 | `audio.retry`、`job.control retry` | 旧记录换新 job id，复用 manifest 或内存闭包 | `operations.js:124-158`，`jobs/operations.js:256` |
| E4 字幕导入 | `audio.subtitles.import` | `startAudioJob`，`orchestrates:true` | `operations.js:159-175` |
| E5 校对复查 | `audio.corrections.review` | `startAudioJob`，`orchestrates:true` | `operations.js:176-187` |
| E6 课堂校正 | `live.correct`、`live.correct.background` | **没有任务记录** | `operations.js:252-270`，`lib/live-correction.js:81` |
| E7 课堂保存（校对） | `live.save {proofread:true}` | `startAudioJob`，**不** orchestrates（等转写闸门） | `operations.js:316-335` |
| E8 课堂保存（快速） | `live.save` | 同步，**没有任务记录** | `operations.js:336-345` |

公共骨架 `startAudioJob`（`lib/contexts/audio/worker.js:46-132`）：创建 `type:'audio-import'` 记录并放进 `work.jobs`（:55-61），`retryable` 内存表放 `{filename, work, cleanup}`（:63），`generationControllers` 放 AbortController（:64-65）；`orchestrates:true` 时不进闸门（:125）；结束时在 `finally` 里依次关闭控制/输出、持久化（`persist`，仅 manifest 类）、写信箱、`announceJob`（:96-122）。

## 2. 所有权表

### 2.1 资源、模型调用与用量

| 入口 | 队列/闸门/池与真实实例 | 模型调用路径 | 用量登记点 |
|---|---|---|---|
| E2 批次 | 主机级转写闸门 `audioGate`（`lib/host.js:43`，默认 limit 1；开始批次/单文件时 `syncAudioGate` 用当前库设置改写它 `worker.js:28-34`）；每成员 `admit(`${job.id}-${index}`)`（`audio-batch.js:264`）；**每个批次一个文字池** `createPool`（:249，上限=设置 1–6）；同内容 hash 串行 `exclusive`（`audio-job.js:206-236`，进程级 Map） | 转写：`tiersFromSettings`（`gemini.js:507`）经 `audioUsageFetch`；文字：Gemini `tiers.complete` 或 host `complete`（`audio-job.js` importAudio 内 provider）。无网关（网关只在试点单文件） | ① 成员 `job.usage/usageRun`，批次求和（`audio-batch.js:296-298`，去重 hash）；② 音频账本每次 HTTP 尝试（`audio-dashboard.js:52,147`）；③ host 文字：成员 `tokenUsage`（`withJobUsage`，`audio-job.js:304`）+ 每日账本（`builtins.js:98` `recordedModels`，feature=audio）。**批次任务自身没有 `tokenUsage`**（测试） |
| E3 重试 | 同 E1/E2；重试时 `syncAudioGate` 再取一次 | 同被重试的入口 | 同被重试的入口；`usage` 累计、`usageRun` 本次（`audio-job.js:345-346`） |
| E4 字幕 | **不进闸门**（`orchestrates:true`）；无池；无 `exclusive` | `jobTextModel`（`audio-job.js:135-151`）：host `complete` 或 Gemini；每次调用是任务内 `tasks[]` 条目 | host：`withJobUsage`→`job.tokenUsage` 与每日账本一致（测试：300/30/3 次）；Gemini：`tiers.summary()`→`job.usage`（`subtitle-job.js:48`），`usageRun`/`tokenUsage`/`textProvider` 不设；另有音频账本 `stage` 事件（`audio-job.js:124`） |
| E5 复查 | 不进闸门；无池；每批顺序请求 | `jobTextModel` 的 `model`（`operations.js:184`），外加 `withModelRetry`（`audio-review.js:90`，传输重试层，800/2000 ms） | host：同 E4；**Gemini：`tiers` 被丢弃，job 上没有任何用量**（测试）；Gemini HTTP 仍进音频账本（源码观察） |
| E6 课堂校正 | 无闸门/池；`RollingCorrection` 自带 30 s 间隔、20 s 超时（`live-correction.js:4,82`） | `liveCorrector`（`worker.js:262-275`）：host `light\|\|complete`（maxTokens 4096，推理 `settings.liveCorrectionReasoning`，默认 low），后台任务优先 `spawnCorrection` | **只有每日账本**（`recordedModels`，测试：1 次）；Gemini 路径的 `tiers.summary` 放在会话快照里；无任务、无 `tasks[]` |
| E7 保存（校对） | **进转写闸门**（等 `audioGate`，测试：闸门被占时 `queuedBehind:1`、`queued`）；无池 | `executeLiveSaveJob`（`live-job.js:17`）自带 provider（:37-45），**host 调用没有 `withJobUsage`**；Gemini 用 `tiersFromSettings` | host：**任务无 token，只有每日账本**（测试：账本 3 次、`contract.usage.tokens=null`、calls 3 条且 `tokens:null`）；Gemini：`tiers.summary()`→`job.usage`（:55,64） |
| E8 保存（快速） | 无 | 无模型请求 | 无（测试：账本空、无信箱、无通知） |

### 2.2 输入持久、提交、通知、清理、取消

| 入口 | 重启后输入能否恢复 | 产物提交点 | 通知路径 | archive / dismiss / 清理责任 | 取消路径 |
|---|---|---|---|---|---|
| E2 批次 | **能**：manifest 保存成员 path/hash/size，上传文件复制到 `inputs/`（`audio-batch.js:138-179`）；重启读成「失败+可重试」（`worker.js:227-231`），不自动调用模型（既有测试） | 每成员 `result-N.json`（`atomicJson`，:279）→ 全部完成后 `storeDocuments`（:307），id `audio-batch-<batchId>[-pN]`（:305） | `finally` 写信箱 `audio-result/audio-failed` 并 `announceJob`（`worker.js:114-122`）；批次**没有**分阶段信件（测试） | archive 按 `batchId` 谱系（`jobs/operations.js:22,137`），文件夹不动；dismiss/delete→`removeLive`→`jobCleanup.dismissBatch`（`jobs/operations.js:34-41`；`audio-batch.js:81-100` 先改名 `.retired-*` 再后台删）；超过 100 条完成记录自动归档（`runtime/jobs.js:31`） | `job.cancel`→`generationControllers.abort`（`jobs/operations.js:71-104`）；排队中立即 `cancelled`，运行中保留已完成成员 |
| E3 重试 | 取决于被重试的类型：v2 单文件/单文件/批次读 manifest；**其余走内存闭包** `retryable`（`operations.js:153`） | 同被重试入口 | 新任务结束时撤销旧 `audio-failed` 信（`operations.js:155-156`） | 旧记录 `jobs.delete`；失败则 `jobs.set` 还原（`operations.js:146,154`） | 同上 |
| E4 字幕 | **不能**：字幕文本只在 `entry.work` 闭包里（`operations.js:170`，`worker.js:63`）；无 manifest。重启后任务消失，信箱旧 `audio-failed` 信仍在（测试）。已存的校对/翻译检查点 `audio-cache/subtitle-<digest16>`（`subtitle-job.js:41`）只能靠**重新提交同一文本**复用（测试） | `storeDocuments`（`subtitle-job.js:56`），id `subtitle-<digest8>[-pN]`（:13）；同内容同设置直接复用并加课程（:31-36，测试 `reused`） | 同公共 finally；一条 `audio-result`，措辞为音频转写（测试） | 无工作目录；archive 只存合同记录，unarchive 回到「已结束且不可重试」（测试）；dismiss 直接删记录 | 同公共路径（测试：取消→`cancelled`、`retryable`、信箱归入 `audio-failed`） |
| E5 复查 | **输入就是库里已存的逐字稿**（`reviewTarget`，`audio-review.js:107`）；任务记录丢失但剩余待复核项由库状态重算（测试：重启后新请求只问剩下 1 批） | 每批在 `store.update` 内写回文本与校对记录（`audio-review.js:149-160`）；先提交的批在失败/取消后保留（既有测试） | 同公共 finally；`sourceIds=target.ids`（所有分卷）；`filename="复核 · <title>"` | 同 E4 | 同公共路径 |
| E6 课堂校正 | 会话快照 `<root>/live/<id>.json` 含 `correction`（游标、记忆、笔记、任务）；排队/运行中的后台任务重载后标为 failed（`live-correction.js:99`） | 改写同一会话的 segment（`applyChanges`），不产生资料 | 无信箱、无通知 | `live.archive/delete` 是**会话**的，不是任务的（`operations.js:273-291`） | 无任务取消；超时 20 s 内部中止 |
| E7 保存（校对） | **任务不能**，输入（会话快照）**能**：`liveSessionOf` 重读（`worker.js:277`）；检查点 `audio-cache/live-<id16>`（`live-job.js:48`），再次点保存复用（测试） | `storeDocuments`（`live-job.js:63`）→ `storeLiveNotes`（:65-66，id `live-<id8>-notes-<digest>`）；id `live-<id8>-<digest>[-pN]`（:15） | 同公共 finally，文字同 E4 | 同 E4（测试覆盖 archive→重启→unarchive→dismiss） | 同公共路径 |
| E8 保存（快速） | 会话快照 | `storeDocuments` + `storeLiveNotes`（`operations.js:339-343`），同步返回 `{sourceIds, noteSourceId, proofread:false}` | 无 | 无任务 | 无 |

## 3. 验收项与测试对应

新增测试都不改生产代码，在 `8d661f4` 上通过；共享夹具 `tests/helpers/audio-family.mjs`（假 Gemini 转写/文字、假 host 模型、私有库与「重启」）。

| 验收项 | 既有测试已覆盖 | 本步新增 |
|---|---|---|
| 无效输入在 job/模型请求前拒绝 | 单文件：`audio.test`、`audio-upload`；字幕无时间戳：`subtitle-review-flow`；复查无待复核：同；跳过编号：`wp6-preflight` | 批次（10 种坏输入+无密钥/paidOnly/无 host 模型，并验证上传被释放可再提交）：`audio-family-baseline-batch`；字幕 7 种+无模型/无密钥：`-subtitles`；复查 6 种+无模型：`-review`；课堂保存无内容/未知/无模型：`-live`。每例同时断言 jobs=[]、请求=[]、信箱=[]、账本空、目录空 |
| 同输入的 source ID、顺序、请求数、用量、通知 | 批次顺序/来源/去重：`audio-batch`；单文件通知：`audio.test`、`audio-retry`；单文件账本：`audio-ledger` | 批次逐文件请求顺序+usage/合同+一信一通知，及 host 文字路径：`-batch`；字幕三请求/三处登记/复用/Gemini 路径：`-subtitles`；复查 15+1 批、per-batch 提交、用量：`-review`；课堂保存（等闸门、账本 vs 任务、复用）、快速保存、课堂校正无任务：`-live` |
| 旧/公共 retry ID 与 archive/unarchive/dismiss fixture | 单文件 archive/delete：`job-archive-service`；store 与操作：`job-archive*`；旧信件恢复卡：`audio-retry`；批次 control：`job-control-audio` | 批次 skip 重试保持 batchId、旧 attempt 消失、`job.control` 的 `attemptId`=旧、`jobId`=新：`-batch`；批次 archive（batchId 与别名）→重启→unarchive→重试→dismiss 清文件夹，字幕/复查/课堂保存三类仅记录型任务同一流程：`-archive`；字幕闭包重试：`-subtitles` |
| 不可恢复的 subtitle/review/live 输入如实记录 | — | 字幕/复查/课堂保存重启后任务消失、`audio.retry` 拒绝、只剩信箱信与检查点，重新提交才复用：`-subtitles`/`-review`/`-live`；未观察的 token 为 `null`/`undefined`，不是 0（`-live`、`-batch`、`-review`） |

结果（`node scripts/test.mjs`，已清凭据环境、私有 TEMP）：新增 5 文件 + 1 夹具共 27 项通过；既有 13 个相关文件（`audio-batch`、`audio-retry`、`job-control-audio`、`subtitle-review-flow`、`audio-review`、`live`、`live-correction`、`job-archive`、`-ops`、`-service`、`-contract`、`audio-single-characterization`、`subtitles`）124 项通过。新增测试不起外部程序（WAV 走纯 JS 路径，`audio-file.js:9`），未登记 `slow-tests.json`。

## 4. 字段 / 调用点去留表（S2-1…S2-6 的责任）

| 字段 / 调用点 | 现状（file:line） | 去留 | 归属 |
|---|---|---|---|
| `startAudioJob` 的 `orchestrates` | `worker.js:46,125`；字幕/复查为 true，批次为 true，保存（校对）为 false | 迁移：由公共执行器的资源声明（是否需要转写许可）表达，不再是布尔旁路 | S2-4/5/6，批次 S2-2 |
| `startAudioJob` 的 `fields`（`subtitle`、`review` 初值、`singleId`、`batchId`） | `worker.js:46`、`operations.js:170,189` | 迁移：进公共记录的领域字段；**重试必须带回**（见 D-1） | S2-1（重试）、S2-4/5 |
| `retryable` 内存闭包 | `worker.js:63,107`；`operations.js:153` | 迁移：manifest/领域事实恢复；闭包类（字幕、复查、保存）要么有可持久输入要么如实标「不可恢复」 | S2-1（总去留）、S2-4/5/6 |
| manifest `audio-batches/*` | `audio-batch.js:47-59` | 保留格式与 `runtimeJob` 写入者规则；批次合同化时用公共 store | S2-2 |
| `job.members[]`、`job.usage/usageRun`、`job.parallel` | `audio-batch.js:234-298` | 保留成员级事实；批次级 token 汇总作为新增字段而非替换 | S2-2 |
| 批次 `executeAudioBatch` 的 `admit`+共享文字池 | `audio-batch.js:249,264` | 迁移：委托公共许可与资源；`batchDocuments`、成员指纹、result digest、skip、部分失败保留 | S2-2/S2-3 |
| `exclusive(hash)` 进程级 Map | `audio-job.js:206-236` | 迁移或登记例外：改为公共资源互斥并在任务上可见 | S2-3 |
| `syncAudioGate` 改写主机闸门 limit | `worker.js:28-34`；`pilot.js:59` | 迁移：由主机资源层按设置统一管理 | S2-3 |
| `taskTracker`/`jobTextModel`/`withJobUsage` | `audio-job.js:107-151` | 迁移：模型网关的 Call 与用量；保留 `tasks[]` 作兼容读 | S2-4/5 |
| `executeLiveSaveJob` 的 provider | `live-job.js:37-45` | 迁移：改走与字幕相同的文字模型入口，补任务级用量 | S2-6 |
| `storeDocuments`、`storeLiveNotes`、`liveSourceId`、`subtitleSourceId` | `audio-job.js:72`、`live-job.js:15,69`、`subtitle-job.js:13` | **保留**（领域提交与 ID 稳定性） | 各步复用 |
| `RollingCorrection` 游标/版本/任务 | `live-correction.js:81-` | 保留；只把其后台请求接到会话域协调，连接仍归 `LiveSession` | S2-5 |
| `inbox` 的 `audio-result/audio-failed` 与 `announceJob` 文案 | `worker.js:114-122`；`runtime/job-notice.js` | 迁移通知；文案分类见 D-2 | S2-1（通用）、S2-4/5/6（各自措辞） |
| archive/dismiss/cleanup 责任（`removeLive`、`releaseRecord`、`recoverAudioBatches`） | `jobs/operations.js:34-47`；`worker.js:186-250` | 保留命名与行为（fixture 已固定）；公共存储接管后仍按 batchId/singleId 谱系 | S2-1、S2-2 |
| `job.control retry` 回包形状 | `jobs/operations.js:226-259` | 保留（`jobId`=新、`attemptId`=旧），见 D-3 | S2-1 |

## 5. 路径上的硬编码常量

| 值 | 位置 | 含义 | 建议归属 |
|---|---|---|---|
| 200 / 300 / 200 / 64 字 | `operations.js:75,90,160,189`（同一校验复制 4 次） | title/subject/course/filename/resumeId 上限 | 共享的音频输入 schema 常量（`lib/contexts/audio/` 内一处） |
| 50 个文件 | `operations.js:55` | preflight 文件数 | 同上 |
| 512 MB | `audio-file.js:MAX_AUDIO_BYTES` | 单文件上限 | 音频限额模块 |
| `partMinutes || 59` | `operations.js:105`、`audio-batch.js:215`、`audio-job.js` | 默认分段分钟 | 设置默认值（`audio-settings.js:30` 已有 59，三处回退应删） |
| 转写 1–3、文字 1–6（默认 1/3） | `audio-pool.js:14-15` | 并发范围 | 设置（已在）；主机闸门默认 `lib/host.js:43` |
| 池退避 `min(8000, 1000·2^n)`、`refusals=8`、`probeAfter=4` | `audio-pool.js:35,46` | 429 退避 | 网关策略（S1-4） |
| 模型重试 800/2000 ms | `model-retry.js:MODEL_RETRY_DELAYS_MS` | 复查等的传输重试层 | 网关策略，只留一层 |
| 复查 `BATCH=15`、`EXCERPT=700`、`vocabulary.slice(0,100)` | `audio-review.js:21,32` | 每批条数/摘录 | 复查策略常量（领域，保留） |
| 课堂校正 30 s / 20 s / 8 新句 / 2 重叠 / 4096 | `live-correction.js:4,5,82`；`worker.js:267` | 校正节奏 | 课堂校正设置（领域），超时进网关策略 |
| `MAX_LISTED=300`、`MAX_TASKS=150`、`SLOW_ITEM_MS=1500` | `audio-job.js:26,44,46` | 记录体量/估时 | 任务记录保留策略 |
| 400_000 字/卷、`room<1000` | `audio-batch.js:183,190` | 合并卷拆分 | 领域常量（保留） |
| 完成记录保留 100、归档 200/90 天/12000 字符/批 100 | `runtime/jobs.js:31-35`、`job-archive.js:15` | 保留与归档 | 公共记录保留策略 |
| 失败信 `slice(-50)`、stage 截断 400/90 字 | `worker.js:239,95,119` | 恢复/展示 | 通知与恢复策略 |
| 退役目录重命名重试 3 次、20·2^n ms | `audio-batch.js:89-90` | Windows 重命名 | 文件层策略（保留） |
| 课堂保存 `<120` 字符、≤400 句、出题 1–15 | `operations.js:295-304` | 非本步路径（live.generate），仅登记 | S2 之外 |

## 6. 缺陷与观察（只记录，未修）

| ID | 内容 | 证据 |
|---|---|---|
| D-1 | 通过 `audio.retry`/`job.control retry` 重试字幕/复查/课堂保存时，走 `startAudioJob(worker, entry.filename, entry.work, {cleanup})`（`operations.js:153`）：**丢掉 `fields` 与 `orchestrates:true`**。结果：重试的字幕任务没有 `subtitle:true`，且会排在转写闸门后面（闸门被占时 `queued`，首次提交则立即 `running`） | 测试 `-subtitles` 第 3 项 |
| D-2 | 字幕/复查/课堂保存的会话通知与信箱沿用音频措辞：「音频「x」已转写成中英对照逐字稿」，复查的文件名是「复核 · …」；被取消的任务归入 `audio-failed` | 测试 `-subtitles`/`-review`/`-live` |
| D-3 | `job.control retry` 回包 `attemptId` 是**被重试的旧尝试**，`jobId` 是新任务（`done()` 后被 `...started` 覆盖，`jobs/operations.js:240,258`），与 `job.control cancel` 里 `attemptId=当前` 的语义不一致 | 测试 `-subtitles`/`-archive` |
| D-4 | 课堂保存（校对）的 host 文字调用没有 `withJobUsage`：每日账本记了 token，任务卡 `tokenUsage` 为空、`contract.usage.tokens=null`；call 的 `stepKey` 为 `proofread`，其他路径为 `proofread:1`（缺 part/parts） | 测试 `-live` |
| D-5 | 批次任务自身没有 token 汇总（成员有，每日账本有），合同 `usage.tokens=null` | 测试 `-batch` |
| D-6 | Gemini 文字路径下的复查任务没有任何用量字段（`tiers` 被丢，`operations.js:184`）；字幕任务有 `usage` 但无 `usageRun`、`textProvider` | 测试 `-review`/`-subtitles` |
| D-7 | 字幕任务 `job.minutes` 是字幕时间跨度（`subtitle-job.js:26`），不是处理时间；不设 `textProvider`，合同 `detail.textProvider=null` | 测试 `-subtitles` |
| D-8 | 非批次任务的「已在处理」去重只看 `filename`（`worker.js:50-51`）：同名的两份不同字幕、同标题的两场课堂保存会被误拒，提示语却说「这个音频」 | 测试 `-subtitles`（取消用例） |
| D-9 | 重启后字幕/复查/保存任务消失，但信箱里旧的 `audio-failed` 信仍写着「可在『音频转写』页点『接着做』」（`worker.js:119`），而此时没有可点的卡（字幕后缀不被旧信件恢复识别，`worker.js:240`） | 测试 `-subtitles` 第 4 项（信件仍在、jobs 为空） |
| D-10 | 带 `skip` 的重试先写 manifest 的 `skipped`（`operations.js:135-144`）再启动；启动失败只还原任务卡，不还原 manifest 标记 | 源码观察，**待核验**（未构造启动失败） |
| D-11 | `syncAudioGate` 把**主机共享**的 `audioGate.limit` 改成最近启动者所在库的设置（`worker.js:28-34`）；`exclusive` 的 `turns` 是进程级 Map（`audio-job.js:206`），跨库按 hash 互斥且在任务上只表现为 `phase:'queued'` | 源码观察，**待核验**（未做多库混跑） |
| D-12 | 课堂校正（E6）是后台模型调用，没有任务记录，因此不在任务控制台，也不能取消/暂停；只写每日账本 | 测试 `-live` |

## 7. 待核验

- 真实 DSH 宿主下 E4–E7 的 host 模型调用（`resultOwner:'plugin'`、子代理 `childId`、`spawnCorrection`）：本步全部使用假模型，包级 fake 不等于宿主证据。
- Gemini 文字路径对**音频账本**（`audio-dashboard`）的逐次登记：只读过 `gemini.js:507-513` 的接线，未对字幕/复查/课堂保存另做账本断言。
- 多库共享一个主机闸门/`exclusive` 时的实际互相影响（D-11）、带 skip 重试启动失败的回滚（D-10）。
- E6 在真实长课上的 30 s 节奏、超时和后台子代理的取消/用量：测试只验证「不是任务、只记每日账本」。
- 单文件 v2 试点路径与本表各入口混跑的矩阵：属 S2-7。

## 8. 复现

```
node scripts/test.mjs tests/audio-family-baseline-batch.test.mjs tests/audio-family-baseline-subtitles.test.mjs \
  tests/audio-family-baseline-review.test.mjs tests/audio-family-baseline-live.test.mjs tests/audio-family-baseline-archive.test.mjs
```

先清除所有 `*_API_KEY`/`*_TOKEN`/`*BASE_URL` 环境变量，设私有 `TEMP`/`TMP` 与 `SSH_TTY=audit`。夹具：`tests/helpers/audio-family.mjs`。
