# S2 进度与交接（音频完整迁移）

> 负责人：Claude（内核负责人，2026-10-06 所有者授权自行合并合格 PR、落 main、开关默认关）。字段按 [sprints-2-6 交接字段](sprints-2-6.md#verification-contract)。完成只认已合并 PR。

| S | 状态 | 分支 / PR | 基线 SHA | 范围 | 验证 | 未确认 / 下一步 |
|---|---|---|---|---|---|---|
| S2-0a | 已合并 | `codex/runtime-s20-baseline` / #282 | `8d661f4` | 内核分层（零行为变化）、`limits.js`、布局护栏、[架构约定](s2-architecture.md) | verify 5875 / 5872 通过 / 0 失败 / 3 跳过；双平台 CI | — |
| S2-0 | 已合并 | `codex/runtime-s20-audio-baseline` / #283 | `8d661f4` | [音频基线与所有权表](s2-0-audio-baseline.md)、特征测试 | 新增 27 项；双平台 CI | 缺陷 D-1…D-12 由 S2-1…S2-6 消除 |
| S2-1a | 已合并 | `codex/runtime-s21a-kernel` / #287 | `fd5c5a1` | 观察到的失败为已知结果（只有 `sideEffect:true` 保持未知）、`context.persistence`、持久化夹具、开关矩阵工具 | 红灯 2 项 → 绿；定向 285/0 | — |
| S2-1 | 已合并 | `codex/runtime-s21-audio-import` / #290 | `fd5c5a1` + #287 | 单文件导入/重试完整接入（见下） | verify 5947（2 项已修）；合并后整套 3 次 5984/0；双平台 CI | S2-2 批次（A 道） |
| S2-1b | 已合并 | `codex/runtime-kernel-model-host` / #294 | `8a66375` | 网关用 `preparedModelHost`（语言/清理准备）、轻量通道 `{ model: 'light' }`、无持久化定义的结算通知 | 定向 334/0；双平台 CI | — |
| S2-2 | PR 中 | `codex/runtime-s22-audio-batch` | `2573b58`（#295 后的 main） | 批次导入/重试、成员协调（`audio-batch` 定义）、共享持久化与展示模块 | verify 6152 项 / 6140 通过 / 0 失败 / 12 跳过；lint 与 build 绿 | S2-3 窗口与许可（A 道） |
| S2-3 | PR 中 | `codex/runtime-s23-audio-windows` | S2-2 之上 | 窗口与重复许可责任收敛 | 见 S2-3 记录 | S2-4 字幕（A 道） |
| S2-4 | PR 中 | `codex/runtime-s24-audio-subtitles` | S2-3 之上 | 字幕导入（`audio-subtitles`）、`audio-gateway-calls`、内核增量一处 | 见 S2-4 记录 | S2-5 复查与课堂校正（A 道） |

## S2-1 记录

**改动**

- 试点 `lib/contexts/audio/pilot.js` 拆为 `lib/contexts/audio/jobs/`：`single-import.js`（定义，attempt 状态挂在 admission lease 上、端口经 `context.persistence`，不再写 bindings）、`single-view.js`（展示读取器与旧字段）、`single-notifications.js`（信箱/会话/输入清理）、`submit-single.js`（提交、恢复、重试入口，拒绝码转学习者文案）。
- `lib/audio-messages.js`：音频家族文案唯一来源（旧执行器、运行时、`audio-batch.js` 共用）；`audioRefusal()` 把 `input-changed`/`input-unavailable`/`not-retryable`/`attempt-active` 转成与旧路径一致的提示。
- `assertImportSettings()`（`lib/audio-settings.js`）：三处重复的导入设置检查收成一处；运行时 admit 也用当前设置检查（修复「移除密钥后重试，走到翻译才失败」）。
- 单文件任务保留的上传副本随任务文件夹一起移除（`keptUploadDir`、`retireAudioBatch`/`removeAudioBatch`），新旧路径共用；修复运行时任务关闭后上传副本残留。
- D-3：`job.control retry` 回包的 `attemptId` 指向新尝试（音频、出题、PDF 转换的重试共用）。

**开关矩阵**：`tests/audio-retry.runtime.test.mjs` 以运行时模式重跑整套 `audio-retry` 特征测试（`SWITCH_MODE`）。改动前运行时侧红灯 5 项：录音变化后报错码而非提示、宿主模型调用失败被判为远端未知而拒绝重试、旧字段缺失、移除密钥后重试未在入口拒绝、关闭失败卡片不清理上传副本。改动后两侧 25 通过 / 1 跳过（「宿主执行钩子」仅旧路径：运行时由网关启动子代理，见 `unified-runtime-gateway`）。逐请求清单在运行时侧来自控制台调用时间线 `contract.calls`，与旧 `tasks` 同为 4 次请求。

**新增测试**：`unified-runtime-audio-relink`（旧路径失败、开关打开后重启重试：转写与校对复用，只重做翻译与标题，同一文件夹改存运行时记录）、`audio-kept-upload`（上传副本引用校验与随任务移除）。

**去留**

| 字段 / 调用点 | 处置 |
|---|---|
| `pilot.js` 的 `binding.view/settings/pipeline/persistence/controlValues` 写入 | 移除；改为 lease `state` 与 `context.persistence` |
| 旧字段 `tasks` | 运行时不产生（调用进网关时间线），不再列入旧字段 |
| `preparedAudioSettings` / `operations.js prepare()` / 运行时 admit 三份检查 | 收成 `assertImportSettings` |
| 音频文案字面量（排队、读取、复用、已存、取消、重试拒绝、录音变化） | 收入 `lib/audio-messages.js` |
| `retryable` 内存占位（旧路径） | 保留至 S2-6 全部迁完；运行时任务不使用 |


## S2-2 记录（批次）

**改动**

- 新定义 `audio-batch`（scope `audio.v1`，开关 `runtime.pilot.audioBatch`，默认关，只影响新提交；旧记录仍按记录自带的 `runtimeJob` 走运行时）。文件在 `lib/contexts/audio/jobs/`：`batch-import.js`（定义，admit/run）、`batch-member.js`（一个文件：转写槽→复用/运行→提交）、`batch-view.js`（展示读取器、旧字段、汇总）；与单文件共用 `view.js`（展示骨架）、`notifications.js`（信箱/会话/清理）、`controls.js`（控制台控制）、`submit-audio.js`（提交/恢复/重试入口，`AUDIO_PATHS` 登记各路径的 kind/开关/输入）。
- 持久化：沿用 `audio-batches/<id>/manifest.json`，经 `createManifestJobStore`。端口 `lib/audio-batch-runtime-store.js`；与单文件共用 `lib/audio-runtime-common.js`（摘要、检查点文件、设置/控制白名单、旧卡投影、账本端口）与 `lib/audio-runtime-artifacts.js`（准备/核对/发布来源）。成员结果 `result-N.json` 是成员提交（步骤键 `member:N`，`commitArtifact` 先记 pending 再写文件）；合并后的资料是唯一的 `assemble:1` 提交。成员复用/孤儿结果校验/分卷/来源 ID/`batchDocuments` 搬到 `lib/audio-batch-members.js`，旧执行器与运行时共用，不复制。
- 并发：批次本身不占转写槽；每个文件按提交顺序逐个取宿主 `audioGate` 的槽（无"父占槽等子"死锁）；一个批次一个文字池；同内容 hash 仍由 `exclusive` 串行。
- 暂停：`pauseMode: 'checkpoint'`，在文件边界结束本次尝试（见"评审过的行为差异"）。
- D-5 已修：批次合同的 `usage.tokens` 来自网关的全部调用；每个文件的 `tokenUsage` 由其调用（步骤键前缀 `member:N:`）汇总。D-10 已修：带 skip 的重试在启动失败时撤回 skipped 标记（旧路径同样）。
- 重试：`audio.retry` 也认合同的 `attemptId`/`jobId`（控制台「跳过此文件」发的是它）。
- 常量/文案：`partMinutes || 59` 四处回退收成 `partSecondsOf()`；title/subject/course/terms/50 个文件的限制收成 `lib/contexts/audio/input-limits.js`（四个入口共用）；400 字阶段文本、"排队中"、"上次导入已中断"、批次预检/变化/重复文案收入 `lib/audio-messages.js`。
- 控制台把音频当一个家族：`lib/job-status.js` 的 `AUDIO_JOB_TYPES`/`isAudioJob`（登记一行，新音频 kind 只加这里），音频页、控制台列表/卡片/用量行/删除对话框、`api.js`、`contracts.js` 都读它，没有新增 `type === '<kind>'` 分支。

**开关矩阵**：`tests/helpers/audio-switch.mjs` + 四个孪生文件（`audio-batch`、`audio-family-baseline-batch`、`job-control-audio`、`audio-family-baseline-archive` 的 `.runtime.test.mjs`）以运行时模式重跑同一套特征测试；运行时独有的行为在 `tests/unified-runtime-audio-batch.test.mjs`（10 项：kind/能力/家族、文件边界暂停与继续、skip 撤回、开关只管新提交、崩溃恢复各变体、孤儿结果校验、录音变化）。

**评审过的行为差异**（运行时侧；测试按模式分支并写明原因）

1. 暂停在文件边界：旧批次是原地软暂停（不再发新调用，在途调用跑完，文字步骤停住）；运行时在已开始的文件全部提交后结束本次尝试，已开始的文件会把文字步骤也做完，不再开始新文件，继续时是新的一次尝试。
2. 进程在请求发出后被杀：运行时拒绝恢复（`remote-result-unknown`，S1-6 合同），旧路径盲目重试。6 个旧进程测试在运行时侧跳过，等价场景（崩在最后一个文件提交处、坏结果、录音变化）在新测试里。
3. 终态清单写不进去：运行时报 `failed`（"Job outcome could not be saved"），资料已入库、输入保留，重试会核对；旧路径报完成并带警告。
4. 录音在重试前变化：运行时在重试调用时拒绝并点名文件，旧路径开出一次新尝试再失败。
5. 回包形状：`job.control` 回 `{ jobId, attemptId, action, status }`；重试的新尝试在 `attemptId`；`contract.jobId` 是运行时的 job id（不再是批次 id）；重试原因码 `not-retryable`（旧 `not-ended`）。
6. 归档后取消归档：运行时记录回来是历史（没有重试），沿用 S2-1 的设计（`unified-runtime-archive-read` 固定了它）；旧路径仍从文件夹回来可重试。孪生测试在运行时侧改为断言历史并清理文件夹。
7. 批次的文字窗口与单文件一样 `refusals: 0`（运行时没有 429 自适应降额/退避）：由 S2-3 收敛为唯一一层。

**发现（给内核负责人，本 PR 不改）**

- 恢复/重启时 `preflight → validateInput` 与开始重试共用：批次对每个未完成批次的全部成员做全量 hash（单文件只一个），开机恢复多个失败的大批次会慢。建议 `preflight(version, { phase })`，恢复时只做廉价检查。
- 取消后立即重试可能撞上结算通知还在写的 `revision-conflict`（测试用 `settleJob` 等到通知投递完才重试）。

**去留**

| 字段 / 调用点 | 处置 |
|---|---|
| `executeAudioBatch` 的 `admit` + 共享文字池 | 旧路径保留（开关关）；运行时由 `batch-member.js` 逐文件取宿主槽、一个批次一个池 |
| `batchDocuments`、成员指纹、result digest（`readMemberResult`）、skip、部分失败 | 保留并搬到 `audio-batch-members.js` 共用 |
| `job.members[]`、`usage/usageRun/parallel` | 保留成员级；批次级 token 汇总是新增（D-5） |
| `holdForBlockedMember` | 保留，旧/新共用 |
| `retryable` 内存占位（批次） | 旧路径保留至 S2-6；运行时批次不用 |
| `persisters`/`liveControls`（`onPaused`） | 旧路径保留；运行时用 `controls.js` |
| `syncAudioGate` | 旧路径保留；运行时 admit 里 `applyTranscribeLimit`（S2-3 统一） |

## S2-3 记录（窗口与重复许可）

**结论先行**：路径上每一类"许可/重试"只剩一个负责层；运行时与旧路径的文字窗口策略对齐。

| 事 | 唯一负责层 | 说明 |
|---|---|---|
| 转写并发 | 宿主 `audioGate` | 单文件持槽、批次逐文件取槽；`applyTranscribeLimit`（`jobs/controls.js`）是改 limit 的唯一函数，旧路径 `syncAudioGate`/控制台改并发也用它 |
| 文字窗口的许可与 429（降额/退避/回升） | 文字池 `createPool`（`audio-pool.js`） | 运行时不再 `refusals: 0`：网关只观察，每次尝试是独立的 Call；开共享配额时由配额域负责（池 `refusals: 0`、`providerOwnsRetry`），与基线一致 |
| 瞬时失败（503、空回复）的重试 | `withModelRetry` | 与旧路径相同，只管池不处理的那一类错误（限流类被 `skip: isLimitError` 让给池） |
| 同一录音同时导入 | `exclusive(hash)` | 键控的领域互斥（同内容不付两次钱），等待时任务卡 `phase: queued` 可见；不是调度器，不登记例外 |
| 窗口派发顺序/上下文 | `orderedWindows` | 保留：只决定"谁先开始、读到哪些已完成的修正、按源序收集、取消时收尾"；它读的是池的上限这个同一个数，不自己授予许可 |

**改动**：`audio-job.js` 里 `providerOwnsRetry`/`refusals: 0` 只在共享配额时设（原来网关路径也设，运行时因此没有 429 自适应和瞬时重试）；批次文字池同样不再 `refusals: 0`；运行时批次在共享配额开启时与旧路径一样拒绝（`capability-unverified`，`quotaSingleOnly` 一处措辞）——S2-2 漏了这一道，此处补上并有新旧两侧测试。

**测试**：`tests/unified-runtime-audio-windows.test.mjs`（单文件/批次：模型只允许两路时被池独自接住——降额、退避、完成、不超并发、每次被拒是一个 Call；瞬时失败重试一次且是新 Call；批次共享配额拒绝）；`audio-pool.test.mjs` 加开关孪生。先红后绿：改前三项红（一次 429/503 直接让任务失败），改后绿。
注意：运行时每个调用先落一个"意图"（逐个写入），假模型要慢过它调用才会重叠，测试里用 120–150 ms。

**D-11**：核对后不是缺陷——音频设置在 `DSH_HOME` 下（用户级，`audio-settings.js`），不随库变，所以"最近启动者所在库的设置"就是同一份设置。`syncAudioGate` 保留（旧路径入口），不再有第二份写 limit 的代码。

| 字段 / 调用点 | 处置 |
|---|---|
| `orderedWindows` | 保留（排序/上下文/收尾）；不另有许可 |
| `createPool`、`withModelRetry`、`exclusive` | 保留，各管各的错误类别/键 |
| `syncAudioGate`、`liveControls.setTranscribeLimit`、定义里的 `holdTranscriptionSlot` | 共用 `applyTranscribeLimit` |

## S2-4 记录（字幕导入）

**改动**

- 新定义 `audio-subtitles`（scope `audio.v1`，开关 `runtime.pilot.audioSubtitles`，默认关）：`jobs/subtitles.js`（定义）、`subtitles-run.js`（一次尝试）、`subtitle-view.js`（展示与旧字段）、`submit-subtitles.js`（提交 / 进程内重试）。无持久化：字幕文本只在内存里，重启后任务消失（D-9 如实保留，未新增输入持久化）；能取消、能在进程内重试（已校对/翻译的窗口仍在 `audio-cache`，重试只做剩下的），不能暂停、不能恢复，`capabilities` 如实声明。
- `lib/subtitle-job.js` 拆成 `subtitlePlan` / `existingSubtitleSources` / `translateSubtitle` / `storeSubtitle`，旧 `executeSubtitleJob` 与运行时共用，不复制。
- `lib/audio-gateway-calls.js`：音频任务经网关的请求（策略、标签、实时输出桥、宿主/Gemini 文本）收成一处，`importAudio` 与字幕共用（以后复查、课堂保存也用）。
- 发布：`store.publishSources(sources, { assertCurrent })`，尝试已被取消就拒绝写入；同样的字幕（同文本同设置）已存在时复用并并入课程，不请求模型。
- 结算通知：定义上的 `notifications`（进程内、结算后投递一次），信箱信与会话提示由提交者自己的服务写（见内核小增量）。
- **内核增量（单独一次提交 `kernel:`）**：无持久化定义的结算接收器多收一个参数 `bindings`（提交时给的），`deliver(event, view, bindings)`；红绿测试在 `unified-runtime-model-host`。原因：接收器要用提交者自己的信箱和通知服务，静态定义拿不到。
- `lib/contexts/jobs/operations.js` 与 `domain-contracts.js`：`job.control retry` 走运行时时也撤回上一次失败的信（原来只有 `audio.retry` 撤回；单文件/批次也受益），并给 `job.control` 写 `inbox` 的授权。

**缺陷（运行时侧已修，旧路径不变）**：D-1（重试保留字幕标记且不再排在转写闸门后面）、D-2（会话提示用字幕自己的措辞：「字幕「x」已校对并译成中英对照逐字稿」）、D-6/D-7（用量与 `textProvider` 在任务卡上，`usageRun` 有值）、D-8（重复判断改按"同样的字幕内容+设置"，同名不同内容不再被拒，提示语也不再说"音频"）。D-9（重启后信箱旧信仍提示「接着做」）未改：没有输入持久化就没有可点的卡，另开策略时再处理。

**评审过的行为差异**：窗口的 429 / 瞬时重试与批次同（见 S2-3）；信箱信仍是 `audio-result` / `audio-failed` 两种（改信箱类型要动前端）。

**测试**：`audio-family-baseline-subtitles` 加孪生（运行时侧上述缺陷的期望按模式分支并写明原因）；新增 `unified-runtime-subtitles`（3 项：kind/能力/家族/调用、失败的信与提示 + 用合同 id 重试、开关关则走旧路径）。

| 字段 / 调用点 | 处置 |
|---|---|
| `startAudioJob`（`orchestrates`、`fields.subtitle`、`retryable` 闭包） | 旧路径保留（开关关）；运行时无闭包，输入在任务里 |
| `jobTextModel` / `taskTracker` / `withJobUsage`（字幕） | 旧路径保留；运行时用网关调用与用量 |
| `subtitleSourceId`、`storeDocuments`、`prepareSubtitles`、缓存键 | 保留，两路共用 |
