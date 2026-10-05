# S1-0 预备审计：现有任务服务、契约与责任边界

日期：2026-10-05。审计起始源码基线：[PR #239](https://github.com/EricWang1358/dsh-web-studyhub/pull/239) 的 `e024513bb54b1ea0f11de23dac93733c4099e019`。审计期间该 PR 合并，当前正式源码为 `aa0259254bcd587128e583070599a804485c7d06`（package 2.6.0）。已读两 SHA 的文件差异清单：只有发布说明、安装文档和版本元数据，没有 `lib/**`、本审计契约或测试源码变动，因此本文源码证据继续固定到起始 SHA。后续 alpha 必须与正式版本分支隔离；再次变更基线仍须复核。

**状态：预备审计，待评审。** 这是用户允许基于 PR #239 先进行的只读准备，不表示 P0 或 S1-0 已通过。PR 合并与 package 版本不能替代发布证据、控制台宿主验证和评审。未运行测试、未启动 DSH、未调用模型、未修改生产代码。以下“已核对”只表示源码或既有测试的断言已读到；测试文件存在不等于本次测试通过。拟迁移责任均待 S1-1 契约评审。

## 1. 公共契约与 extension 的现有能力

P0 已提供 **公共读取契约 v1**：`lib/job-contract.js` 是公共 `job.contract` 的唯一生产者，读取领域 job 后适配状态、身份、动作、Call、events 等；适配结果不持久化。完整面板 `snapshot` 使用 `snapshotJob`，聊天的 `job.status`、`job.wait` 和 compact snapshot 使用 `publicJob`，仍返回旧记录的精简视图。不能把“已有公共形状”解释为“已有统一执行内核”。证据：[契约说明](https://github.com/EricWang1358/dsh-web-studyhub/blob/e024513bb54b1ea0f11de23dac93733c4099e019/docs/job-contract.md#L1-L38)、[适配实现与版本](https://github.com/EricWang1358/dsh-web-studyhub/blob/e024513bb54b1ea0f11de23dac93733c4099e019/lib/job-contract.js#L7-L46)、[snapshot 生产](https://github.com/EricWang1358/dsh-web-studyhub/blob/e024513bb54b1ea0f11de23dac93733c4099e019/lib/contexts/library/operations.js#L188-L191)、[精简视图](https://github.com/EricWang1358/dsh-web-studyhub/blob/e024513bb54b1ea0f11de23dac93733c4099e019/lib/runtime/jobs.js#L12-L14)。

`StudyRuntime` 创建唯一 `work` 对象和 `createTaskService(root, work)`。extension 的任务记录进入同一 `work.jobs`；`tasks.js` 的私有 `entries`、`owners`、`queues` 保存执行 promise、controller、owner/domain/queue 索引，没有独立公共 job 真相。两类队列用途不同：`tasks.js` 的 FIFO 属于 extension 执行；`work.queues` 供既有领域路径使用。禁止将这些私有索引一概当作第二张任务表，也不能先加一个竞争的公共注册表。证据：[创建入口](https://github.com/EricWang1358/dsh-web-studyhub/blob/e024513bb54b1ea0f11de23dac93733c4099e019/lib/runtime.js#L35-L49)、[work 内容](https://github.com/EricWang1358/dsh-web-studyhub/blob/e024513bb54b1ea0f11de23dac93733c4099e019/lib/runtime/work.js#L4-L30)、[任务注册及队列](https://github.com/EricWang1358/dsh-web-studyhub/blob/e024513bb54b1ea0f11de23dac93733c4099e019/lib/runtime/tasks.js#L8-L61)。

| extension 操作或数据 | 现有行为与限制 | 迁移要求（待评审） |
|---|---|---|
| `context.work.start(options, run)` | `run` 必须为函数；`key` 只对同 owner、domain 的活动任务去重；同 owner/domain/queue 串行，不同作用域不互相串行 | 保留同步返回任务快照、去重和队列隔离；如委托内核，仅保留一份执行与生命周期责任 |
| `run({signal, progress})` | 只给停止信号及进度函数；进度只写 `stage/done/total/phase`，取消后忽略。完成结果克隆到旧记录 `result` | 不默认授予模型、重试、持久化、任意状态或产物提交能力；未来权限须先写契约 |
| `get/list/cancel/wait` | 通过 `entries` 校验 owner 与 domain；对外视图移除 root 并深克隆；结束历史最多保留 100 条 | 保留作用域查找与快照隔离；不得靠仅 root 匹配替代 owner/domain |
| 公共 `kind:'extension'` | v1 只支持状态、阶段、进度、取消；pause/retry/set 不支持；旧 `result` 不自动成为公共 `result.refs` | 维持不支持动作的明确原因；不要因公共 Call 存在而假定 extension 已自动计量或记录调用 |
| `startedAt` | 创建时即写入，排队 extension 后续执行未重写；音频则在开始执行时重写 | 保持旧视图兼容；未来队列/执行时点需明确字段，不能倒推未测时点 |

证据：[extension 全部操作](https://github.com/EricWang1358/dsh-web-studyhub/blob/e024513bb54b1ea0f11de23dac93733c4099e019/lib/runtime/tasks.js#L26-L74)、[extension 能力声明](https://github.com/EricWang1358/dsh-web-studyhub/blob/e024513bb54b1ea0f11de23dac93733c4099e019/lib/job-contract.js#L48-L69)、[公共结果引用](https://github.com/EricWang1358/dsh-web-studyhub/blob/e024513bb54b1ea0f11de23dac93733c4099e019/lib/job-contract.js#L287-L299)。已有断言：[extension FIFO、去重、取消和隔离](https://github.com/EricWang1358/dsh-web-studyhub/blob/e024513bb54b1ea0f11de23dac93733c4099e019/tests/backend-boundaries.test.mjs#L77-L163)。

## 2. 身份、状态、控制与等待兼容

| 接口或字段 | 当前语义 | 对统一运行时的影响 |
|---|---|---|
| audio `contract.jobId/attemptId` | `jobId = batchId || singleId`；`attemptId = job.id`。重试换 `job.id`，旧记录从 jobs 移除，逻辑录音/批次 ID 保留 | v1 已提供逻辑身份；不能再发明一个竞争公共身份。旧 attempt 查询是否长期保留须先评审，当前并无历史 alias 保证 |
| `job.control / job.output` | 同库可用 attempt ID，或逻辑录音/批次 ID 找最新记录 | 继续解析两种 ID；切换期间控制和流输出应找到同一活动执行者 |
| `job.status / job.wait / job.cancel / audio.retry` | 旧入口按 `job.id` 查找；并非所有入口都接受逻辑 ID | 把各入口的兼容范围分别声明，不能引用 control 的实现证明所有查询都支持逻辑 ID |
| `done / partial / superseded` | 公共视图分别映射 complete、complete + partial completeness、cancelled + superseded endReason；领域旧记录仍保留原词汇 | 保留 P0 对外映射；只读旧/写新属于将来的已评审迁移，不是本次更改 |
| 音频重启遗留活动卡片 | 恢复为 `failed + retryable` 并提示中断；不会自动继续；公共 v1 仍显示 failed | 目标 interrupted 状态需与旧卡片、通知、UI 兼容，不得把目标状态当当前行为 |
| `checkAction` | `job.control` 和公共动作视图共享动作合法性；原 `job.cancel/dismiss` 保留历史入口 | 内核接入后维持同一动作判断；不能让控制台和执行入口各自维护矩阵 |
| `tasks.wait({timeoutMs})` | 无参数等执行 promise；有参数 race 到期返回当前快照，清理等待计时器；不取消任务 | 观察者等待上限与任务期限分开；不能升级成执行超时 |
| `job.wait({timeoutSeconds})` | 等 `settled` 或 1–60 秒上限后返回精简 job；终态之后仍等收尾记录（manifest/信箱等） | 不能仅在状态终态时就结束兼容 wait；到期同样不取消任务 |

证据：[身份和 v1 适配](https://github.com/EricWang1358/dsh-web-studyhub/blob/e024513bb54b1ea0f11de23dac93733c4099e019/lib/job-contract.js#L316-L354)、[状态映射](https://github.com/EricWang1358/dsh-web-studyhub/blob/e024513bb54b1ea0f11de23dac93733c4099e019/lib/job-contract.js#L76-L85)、[控制、输出 ID 解析](https://github.com/EricWang1358/dsh-web-studyhub/blob/e024513bb54b1ea0f11de23dac93733c4099e019/lib/contexts/jobs/operations.js#L101-L143)、[旧取消查找](https://github.com/EricWang1358/dsh-web-studyhub/blob/e024513bb54b1ea0f11de23dac93733c4099e019/lib/contexts/jobs/operations.js#L37-L69)、[旧查询与等待](https://github.com/EricWang1358/dsh-web-studyhub/blob/e024513bb54b1ea0f11de23dac93733c4099e019/lib/contexts/jobs/operations.js#L170-L224)、[extension wait](https://github.com/EricWang1358/dsh-web-studyhub/blob/e024513bb54b1ea0f11de23dac93733c4099e019/lib/runtime/tasks.js#L67-L72)、[音频恢复](https://github.com/EricWang1358/dsh-web-studyhub/blob/e024513bb54b1ea0f11de23dac93733c4099e019/lib/contexts/audio/worker.js#L191-L228)、[重试替换](https://github.com/EricWang1358/dsh-web-studyhub/blob/e024513bb54b1ea0f11de23dac93733c4099e019/lib/contexts/audio/operations.js#L124-L150)。已有断言：[契约身份](https://github.com/EricWang1358/dsh-web-studyhub/blob/e024513bb54b1ea0f11de23dac93733c4099e019/tests/job-contract.test.mjs#L59-L68)、[重试新 attempt 与一张卡片](https://github.com/EricWang1358/dsh-web-studyhub/blob/e024513bb54b1ea0f11de23dac93733c4099e019/tests/job-control-audio.test.mjs#L108-L129)。

## 3. owner/domain 与卸载责任

- **runtime 实例边界**：每个 `StudyRuntime` 有独立 work 与 task service。同 root 不表示同一任务所有者；独立 runtime 不能看见对方的 jobs。宿主 `serviceFor` 在相同库/contexts 下复用 runtime，若核心服务提供该 runtime 则跟踪为 shared runtime。证据：[host service 复用](https://github.com/EricWang1358/dsh-web-studyhub/blob/e024513bb54b1ea0f11de23dac93733c4099e019/lib/host.js#L346-L380)、[已有 runtime 隔离断言](https://github.com/EricWang1358/dsh-web-studyhub/blob/e024513bb54b1ea0f11de23dac93733c4099e019/tests/backend-boundaries.test.mjs#L28-L43)。
- **任务作用域**：`context.work` 以 request 的 `workOwner`（否则 domain 的 Symbol）和 domain API 名（如 `extension.v1`）绑定。隐藏 owner Symbol 不作为业务持久字段；`workOwnedBy(work, undefined)` 是内部通配语义，不能对外暴露为绕过隔离的控制参数。证据：[context 注入](https://github.com/EricWang1358/dsh-web-studyhub/blob/e024513bb54b1ea0f11de23dac93733c4099e019/lib/runtime.js#L196-L204)、[owner 标记](https://github.com/EricWang1358/dsh-web-studyhub/blob/e024513bb54b1ea0f11de23dac93733c4099e019/lib/runtime/work-ownership.js#L1-L8)、[owner/domain 查找](https://github.com/EricWang1358/dsh-web-studyhub/blob/e024513bb54b1ea0f11de23dac93733c4099e019/lib/runtime/tasks.js#L14-L17)。
- **撤销后禁派发**：start 和真正 execute 前检查 `assertActive`；domain dispose 删除注册、取消该 domain；owner cancel 记入 revoked owners 并发停止信号。保留的 work handle 不能在撤销后再启动任务。域 state update 在回调前后检查活性。证据：[域卸载](https://github.com/EricWang1358/dsh-web-studyhub/blob/e024513bb54b1ea0f11de23dac93733c4099e019/lib/runtime.js#L130-L145)、[写入活性检查](https://github.com/EricWang1358/dsh-web-studyhub/blob/e024513bb54b1ea0f11de23dac93733c4099e019/lib/runtime.js#L188-L195)、[assertActive](https://github.com/EricWang1358/dsh-web-studyhub/blob/e024513bb54b1ea0f11de23dac93733c4099e019/lib/runtime.js#L232-L235)、[保留 handle 撤销断言](https://github.com/EricWang1358/dsh-web-studyhub/blob/e024513bb54b1ea0f11de23dac93733c4099e019/tests/backend-boundaries.test.mjs#L10-L25)。
- **宿主共享与宿主撤销**：`servicesForHost(owner)` 通过 WeakMap 为宿主提供 workOwner、runtimes、audioGate。owner effect 清 assist/bridge，对 shared runtimes 调 cancelOwner，对自己创建的 runtimes 调 dispose。内核应委托既有 cordis/宿主 effect 的释放边界；DSH 实际安装版本及 effect 最小运行验证另由能力表记录，本文不代填。证据：[宿主生命周期](https://github.com/EricWang1358/dsh-web-studyhub/blob/e024513bb54b1ea0f11de23dac93733c4099e019/lib/host.js#L32-L50)。
- **取消请求不等于实际停止**：extension `cancel` 发 signal，运行中的状态为 cancelling；真正 run settle 才在 finally 清 controller/settled、写 finishedAt。若 run 忽略 signal，取消并不强制结束它。`cancelOwner/dispose` 未等待全部 task promises；宿主 effect 等其返回值不能证明每个请求已停。统一内核不得据此提前释放底层仍占用的资源。证据：[task 停止与 finally](https://github.com/EricWang1358/dsh-web-studyhub/blob/e024513bb54b1ea0f11de23dac93733c4099e019/lib/runtime/tasks.js#L19-L24)、[执行结算](https://github.com/EricWang1358/dsh-web-studyhub/blob/e024513bb54b1ea0f11de23dac93733c4099e019/lib/runtime/tasks.js#L45-L61)、[撤销入口](https://github.com/EricWang1358/dsh-web-studyhub/blob/e024513bb54b1ea0f11de23dac93733c4099e019/lib/runtime/tasks.js#L75-L78)、[runtime cancelOwner](https://github.com/EricWang1358/dsh-web-studyhub/blob/e024513bb54b1ea0f11de23dac93733c4099e019/lib/runtime.js#L51-L71)。

`context.work` 的 owner/domain 隔离与既有库级 `job.*` 控制是两种入口：后者在获得对应 runtime 后按 root 列库内 jobs。S1-1 须分别保持其授权边界，不应将库级控制宣称为 extension 私有作用域控制，也不以本次审计改变既有库内控制权限。

## 4. 字段、操作与唯一责任者清单

下表“拟迁移责任”均为建议、待 S1-1 评审；既有执行者在 S1-6 切换前继续负责，不能提前双写。

| 字段或操作 | 当前写入/操作责任者与证据 | 建议去向 |
|---|---|---|
| extension `id/type/provider/label/queue/startedAt`、共享 jobs 注册 | `tasks.scoped.start` 创建，私有 entry 持 controller/promise；[tasks 27–44](https://github.com/EricWang1358/dsh-web-studyhub/blob/e024513bb54b1ea0f11de23dac93733c4099e019/lib/runtime/tasks.js#L27-L44) | **演进**：将同一入口委托唯一生命周期；保留 extension API 和私有 scope 索引 |
| extension `status/result/finishedAt` | `execute` 写 complete/failed/cancelled，finally 清 controller/settled；[tasks 45–61](https://github.com/EricWang1358/dsh-web-studyhub/blob/e024513bb54b1ea0f11de23dac93733c4099e019/lib/runtime/tasks.js#L45-L61) | **演进**：一次结算与迟到保护归内核；run 的业务结果不能被误当公共 result refs |
| audio `id/singleId/batchId/status/cancelRequestedAt/finishedAt/retryable` | `startAudioJob` 创建/结算，jobs 取消入口写取消请求，恢复与重试分别重建/换 ID；[worker 64–144](https://github.com/EricWang1358/dsh-web-studyhub/blob/e024513bb54b1ea0f11de23dac93733c4099e019/lib/contexts/audio/worker.js#L64-L144) | **演进**：试点生命周期逐步归内核，领域工人以受控回调提交进度/结果；旧视图由适配器读取 |
| 公共 v1 `contractVersion/kind/status/actions/result/usage/execution/calls/events` | `jobContract/snapshotJob` 只读映射，`checkAction` 决定控制合法性；[contract 332–360](https://github.com/EricWang1358/dsh-web-studyhub/blob/e024513bb54b1ea0f11de23dac93733c4099e019/lib/job-contract.js#L332-L360) | **保留并演进**：同一个对外适配边界；契约改动按计划升版本，无第二份形状 |
| audio `phase/done/total/steps/warnings/sourceIds/corrected/usageRun` | `executeAudioJob/runAudioImport` 上报阶段、写领域结果；[进度和保存](https://github.com/EricWang1358/dsh-web-studyhub/blob/e024513bb54b1ea0f11de23dac93733c4099e019/lib/audio-job.js#L311-L342) | **保留**：音频领域仍负责实际业务数据；内核校验所属 attempt 与提交权限 |
| `manifest kind/args/upload/input/job` | `prepareSingleAudioRecord` 建记录并保存；`saveAudioBatch` 复制 job 去掉 root，按文件串行原子替换；[单文件准备](https://github.com/EricWang1358/dsh-web-studyhub/blob/e024513bb54b1ea0f11de23dac93733c4099e019/lib/audio-batch.js#L111-L136)、[保存](https://github.com/EricWang1358/dsh-web-studyhub/blob/e024513bb54b1ea0f11de23dac93733c4099e019/lib/audio-batch.js#L64-L70) | **保留业务字段、演进元字段**：同一存储记录及写入器，生命周期元字段只能有一个 writer；保留旧读取能力 |
| 原子替换、manifest 写入顺序、删除前等待 writer | `atomicJson` 保留 Windows EPERM/EACCES/EBUSY 替换重试，`writing[file]` 保序，remove/retire 等 pending write；[writer 与移除](https://github.com/EricWang1358/dsh-web-studyhub/blob/e024513bb54b1ea0f11de23dac93733c4099e019/lib/audio-batch.js#L15-L109) | **提取/委托既有实现**：不能只抽 rename，丢掉队列、失败后的清理或 Windows 重试 |
| 转写许可 | host audioGate 实例，`admitAudio.release` 幂等；转写完成提早释放，finally 兜底；[admitAudio](https://github.com/EricWang1358/dsh-web-studyhub/blob/e024513bb54b1ea0f11de23dac93733c4099e019/lib/contexts/audio/worker.js#L22-L61) | **保留并委托**：混跑共享同一 gate；不能以整个音频终态作为转写释放点 |
| 文本窗口许可、429 拒绝退避与自适应上限 | `createPool.run` 释放 slot/running 后退避，再重新申请；每池自己的等待者与 effective；[pool](https://github.com/EricWang1358/dsh-web-studyhub/blob/e024513bb54b1ea0f11de23dac93733c4099e019/lib/audio-pool.js#L44-L104) | **保留作用域、演进唯一责任**：宿主/真实配额域策略独立开关；不叠加新的竞争 gate |
| 可调值 `job.control/paused/pausedAt` | `createJobControl` 整包验证后 patch，120ms 检测无在途 calls 的暂停边界，close 清 listener/timer/字段；`audioControl` 改当前池及共享转写上限；[control](https://github.com/EricWang1358/dsh-web-studyhub/blob/e024513bb54b1ea0f11de23dac93733c4099e019/lib/job-control.js#L25-L125) | **保留/演进**：支持的真实 checkpoint 才提供 pause；网关/调度器读下一次 dispatch 的有效值 |
| Call 记录与 events | 音频 `taskTracker` 写 tasks；`recordWait/recordEvent/observeJob` 写有界日志；`jobCalls/jobEvents` 聚合成视图；[tracker](https://github.com/EricWang1358/dsh-web-studyhub/blob/e024513bb54b1ea0f11de23dac93733c4099e019/lib/audio-job.js#L106-L127)、[calls/events](https://github.com/EricWang1358/dsh-web-studyhub/blob/e024513bb54b1ea0f11de23dac93733c4099e019/lib/job-calls.js#L63-L126) | **演进**：网关成为试点可观测请求的唯一 Call writer；视图聚合继续复用。不能把当前业务调用记录当每个 HTTP attempt 的保证 |
| 实时输出、首输出时间、reasoning 字符数 | 音频 host 文本路径开/写/关 `jobOutputs`；8192 字符/24 活动缓冲，关闭后丢弃迟到增量；子代理监听按 child ID 过滤；[音频输出](https://github.com/EricWang1358/dsh-web-studyhub/blob/e024513bb54b1ea0f11de23dac93733c4099e019/lib/audio-job.js#L281-L295)、[输出存储及监听](https://github.com/EricWang1358/dsh-web-studyhub/blob/e024513bb54b1ea0f11de23dac93733c4099e019/lib/job-output.js#L12-L85) | **保留/委托**：Call 所有者控制 open/close；Gemini 无流仍报告不支持；不持久化全文输出 |
| host tokenUsage 与库账本 | `withJobUsage → reportUsage → jobUsageSink` 写 job/step；`recordedModels` 添加 key 去重的 ledger sink；direct 从 assembler usage 报，child 从宿主 projection/本地事件读；[usage scope](https://github.com/EricWang1358/dsh-web-studyhub/blob/e024513bb54b1ea0f11de23dac93733c4099e019/lib/usage-scope.js#L17-L54)、[库账本包装](https://github.com/EricWang1358/dsh-web-studyhub/blob/e024513bb54b1ea0f11de23dac93733c4099e019/lib/model-usage.js#L102-L124)、[child 上报](https://github.com/EricWang1358/dsh-web-studyhub/blob/e024513bb54b1ea0f11de23dac93733c4099e019/lib/generation-agent.js#L13-L31) | **委托宿主、演进唯一入账**：保留真实观测来源；scope key 去重仅防重复包装，不是跨崩溃/恢复的 Call 身份去重 |
| 音频 HTTP 用量、tier 汇总和自检 | `tiersFromSettings` 包 `audioUsageFetch` 写 DSH_HOME 音频账本；GeminiTiers 累加 tier usage，音频 job 组合 earlier/now 并保存 usage checkpoint；[HTTP meter](https://github.com/EricWang1358/dsh-web-studyhub/blob/e024513bb54b1ea0f11de23dac93733c4099e019/lib/audio-dashboard.js#L89-L126)、[meter 注入](https://github.com/EricWang1358/dsh-web-studyhub/blob/e024513bb54b1ea0f11de23dac93733c4099e019/lib/gemini.js#L480-L488)、[job usage](https://github.com/EricWang1358/dsh-web-studyhub/blob/e024513bb54b1ea0f11de23dac93733c4099e019/lib/audio-job.js#L323-L328) | **演进**：试点按网关 Call 汇总时委托/移除旧 meter 一次；旧路径保留。不同计量维度不能盲目相加 |
| 资料产物提交 | `storeDocuments` 通过领域 store update 保存 source，source ID 来自 audio hash + 文本设置 key；终态由外层 worker 随后写；[产物提交](https://github.com/EricWang1358/dsh-web-studyhub/blob/e024513bb54b1ea0f11de23dac93733c4099e019/lib/audio-job.js#L330-L342) | **保留领域提交、演进权限检查**：内核拒绝旧 attempt 提交，领域保留 source 结构/内容去重；需故障窗口测试 |
| 终态持久化、信箱和会话通知 | audio worker finally 先 persist/cleanup，再 update inbox，再 announce；settled 在这之后清除。notifier 的 WeakSet 按当前 job 对象只发一次，失败不阻断；[worker 收尾](https://github.com/EricWang1358/dsh-web-studyhub/blob/e024513bb54b1ea0f11de23dac93733c4099e019/lib/contexts/audio/worker.js#L110-L140)、[notifier 去重](https://github.com/EricWang1358/dsh-web-studyhub/blob/e024513bb54b1ea0f11de23dac93733c4099e019/lib/runtime/job-notice.js#L3-L9)、[发送异常隔离](https://github.com/EricWang1358/dsh-web-studyhub/blob/e024513bb54b1ea0f11de23dac93733c4099e019/lib/runtime/job-notice.js#L100-L102) | **演进**：内核一次完成事件、业务通知适配；持久稳定事件键待评审。当前 WeakSet 不保证跨重启投递恰好一次 |

## 5. 实际资源实例与重试分工

| 实例/互斥/账本 | 当前范围、占用与释放 | 复用边界 |
|---|---|---|
| `servicesForHost.audioGate` | 一个宿主 owner；所有其服务库共享；成员是转写 task ID；转写结束或 work finally 释放 | 同一宿主转写混跑共享此实例；默认 runtime 自带 gate 仅为无宿主注入路径，不代表跨宿主共享 |
| 单录音 `pools.text` | 每录音建池；批次成员共享每批次的另一实例；proofread/translate 窗口占槽，不按 provider/key 汇总 | 保留录音/批次上限；不能用 gate 的转写计数代替文本计数 |
| `audio-job.exclusive` 的 `turns[hash]` | 模块进程级、只以音频 hash 做 key；同内容不同名、不同库/宿主也会串行。取消等待者后 finally release，等后继 tail 的语义保留 | 这是同内容处理/付费互斥，不是 provider quota；迁移先说明其范围，不自行收窄 |
| `audio-batch.writing[file]` | 模块进程级、完整 manifest 路径；每次调用先快照数据，再串行写；后一次在前失败后仍继续 | 业务 writer 保序与原子替换一起复用；跨进程锁/租约未在此模块证明 |
| `usageLedger(root)` | 模块按 library root 共享实例和串行 writer；90 日 feature 聚合 | 日账本不是逐 Call 持久日志；不能从聚合账本重建未知 attempt 身份 |
| `audio-dashboard.writing` | 模块写队列；路径由实际 DSH_HOME 决定；31 日 JSONL 音频请求观测 | 有真实 HTTP 观测，不能拿缺失 token 值冒充已知；并非统一生命周期存储 |

证据：[宿主 gate](https://github.com/EricWang1358/dsh-web-studyhub/blob/e024513bb54b1ea0f11de23dac93733c4099e019/lib/host.js#L35-L48)、[宿主 gate 注入](https://github.com/EricWang1358/dsh-web-studyhub/blob/e024513bb54b1ea0f11de23dac93733c4099e019/lib/runtime/builtins.js#L106-L110)、[单录音池](https://github.com/EricWang1358/dsh-web-studyhub/blob/e024513bb54b1ea0f11de23dac93733c4099e019/lib/audio-job.js#L300-L312)、[批次池](https://github.com/EricWang1358/dsh-web-studyhub/blob/e024513bb54b1ea0f11de23dac93733c4099e019/lib/audio-batch.js#L241-L288)、[hash 互斥](https://github.com/EricWang1358/dsh-web-studyhub/blob/e024513bb54b1ea0f11de23dac93733c4099e019/lib/audio-job.js#L205-L234)、[manifest 队列](https://github.com/EricWang1358/dsh-web-studyhub/blob/e024513bb54b1ea0f11de23dac93733c4099e019/lib/audio-batch.js#L64-L70)、[库 usage writer](https://github.com/EricWang1358/dsh-web-studyhub/blob/e024513bb54b1ea0f11de23dac93733c4099e019/lib/model-usage.js#L45-L107)、[音频账本 writer](https://github.com/EricWang1358/dsh-web-studyhub/blob/e024513bb54b1ea0f11de23dac93733c4099e019/lib/audio-dashboard.js#L8-L36)。

重试至少已有以下分工，S1-4 的去留表须逐一复核：

1. `withModelRetry` 处理暂态模型失败；音频窗口传 `skip:isLimitError`，让 429/并发拒绝交给 pool，避免同一错误重复重试。
2. `createPool.run` 对限流拒绝降低 effective、释放占用、退避后重新申请；这是录音/批次池内策略，未证明宿主/凭据域共享冷却。
3. JSON/格式失败可追加修复提示重新调用；这是领域输出修复，不能被归为同一传输重试。
4. `GeminiTiers.tryTiers`、转写参数/文件投递形式回退拥有现有 provider/tier 行为；`audioUsageFetch` 观测实际 HTTP 请求，但目前一个 taskTracker 记录未必等于一个 provider 内部 HTTP attempt。
5. 宿主 `runGenerationAgent` 根据能力选择 native child 或 direct；child 的停止与 disposal 委托 subagents，模型直调使用 `ctx.llm` 及 AbortSignal；真实宿主的内部 retry 不可由外层 task 数猜测。

证据：[窗口重试/格式修复](https://github.com/EricWang1358/dsh-web-studyhub/blob/e024513bb54b1ea0f11de23dac93733c4099e019/lib/audio-import.js#L68-L108)、[pool 释放与退避](https://github.com/EricWang1358/dsh-web-studyhub/blob/e024513bb54b1ea0f11de23dac93733c4099e019/lib/audio-pool.js#L61-L81)、[tier 分工](https://github.com/EricWang1358/dsh-web-studyhub/blob/e024513bb54b1ea0f11de23dac93733c4099e019/lib/gemini.js#L175-L252)、[转写形式回退](https://github.com/EricWang1358/dsh-web-studyhub/blob/e024513bb54b1ea0f11de23dac93733c4099e019/lib/gemini.js#L323-L423)、[host direct/child](https://github.com/EricWang1358/dsh-web-studyhub/blob/e024513bb54b1ea0f11de23dac93733c4099e019/lib/generation-agent.js#L34-L109)、[ctx.llm 与 direct usage](https://github.com/EricWang1358/dsh-web-studyhub/blob/e024513bb54b1ea0f11de23dac93733c4099e019/lib/index.js#L106-L180)。

## 6. 保留、演进、委托与后续删除建议

并行 DSH 审计已发现 `dsh-jobs` / `ctx.jobs` 与 `dsh-atomic-write` 的现成能力线索；本单元未核验其导出、版本及当前 owner/domain scope，不能据插件源码判定宿主没有任务服务或原子写能力。S1-1/S1-2 应先引用 DSH 能力表 DSH-01/03/08，验证宿主是否足以承接执行/队列/结算与 writer，再确定薄适配边界。alpha 的首选是**让现有 tasks/work 入口委托已验证的唯一执行者**；公共业务 job 的读取投影和宿主执行 handle 要明确关系，不让两边独立推导生命周期。若宿主能力有经验证的缺口，再演进既有插件实现补缺，不能先新建第二队列或 settlement 层。此处是审计建议，不是批准的 alpha 实现方案。

| 对象 | 本次建议 | 允许删除的前提 |
|---|---|---|
| `runtime.work.jobs`、owner/domain 隔离、extension work API、v1 适配入口 | 保留并演进；作为现有统一可见性与兼容边界 | 不删除公共事实来源或已发布入口；内部替换需 S1-1 契约及回归证据 |
| `tasks.js`、`startAudioJob` 当前 lifecycle/FIFO | 演进为委托；先用证据明确一个责任者 | 仅在相应路径已接内核、旧兼容入口委托且释放/结算回归通过后，移除被替代部分 |
| `ctx.llm`、subagents、sessions/query、cordis context effect、待核验的 `ctx.jobs` | 委托宿主；插件只保存 job/attempt 关联与业务策略 | 不另造同功能服务；DSH 能力实际 scope/minimal probe 仍待能力表核验 |
| `audioPool/atomicJson/manifest writing`、待核验的 `dsh-atomic-write` | 核验宿主 writer 后复用或薄适配既有实现，保留真实作用域和平台行为 | 不能在提取前复制新队列/重试层；旧包装移除需混跑/回退证据 |
| 旧 audio HTTP meter、旧 per-task Call 包装 | 网关接入后对试点委托/移除，旧路径按例外保留 | Call 请求数、fallback、账本一次入账与差异表均通过；不能同时旧新计量 |
| 业务 manifest、音频 checkpoints、source 产物、inbox 规则 | 保留领域责任，适配元字段/生命周期/事件 | 不以通用 store 代替已保存业务事实；未知旧记录保持明确限制 |

## 7. 待复核事项、既有边界与门禁

本文没有运行验证，因此不声称发现已复现缺陷，也不把源码可见边界自动升级为生产缺陷。

| ID | 核对结果/风险 | 分类及下一步 |
|---|---|---|
| RA-01 | owner/dispose 只发停止请求，未等待所有 extension run settle；忽略 signal 的执行可长留 cancelling | 既有边界。S1-2 的实际停止/卸载测试需覆盖；不能宣称已有强制停止保证 |
| RA-02 | extension run 返回后先赋 `task.result` 再检查 aborted signal；取消后进度被屏蔽，但旧 result 仍可能被赋值 | 源码可见待复现风险。单独登记；特征测试记录旧行为，S1-0 不修实现；S1-2 明确迟到结果/产物保护 |
| RA-03 | 旧 job 查询接口的 ID 支持不一致；retry 移除旧 attempt，不保留无限历史 alias | 兼容事实。S1-1 明确新操作、旧 ID 查询/通知/UI 约定 |
| RA-04 | pause boundary 的 `onPaused` manifest 保存异常被吞掉；源码不能证明“每次到达 paused 都成功持久化” | 源码可见待复现风险；保留正常暂停行为，故障路径另测，不能把成功恢复保证写成事实 |
| RA-05 | notifications 的 WeakSet 仅按当前对象、当前进程去重；usage scope key 仅防重复 wrapper | 既有保证范围。S1-5 的持久事件/Call 去重待设计评审，不标为已有 exactly-once |
| RA-06 | host/credential 配额域的统一文本计数或共享 429 冷却未在上述模块证明；pool 是窗口池 | 对 S1-3 对应能力核验有影响；不能以“未在插件找到”宣称 DSH 不支持 |
| RA-07 | `docs/job-contract.md` 的初始 shape 示例未列 coach-daily、result document、Call prep，后面的 kind 表/代码已有相关支持 | 文档示例覆盖范围待 P0 负责人复核；不据此重开统一 runtime 决策或升 v1 |
| RA-08 | PR 已合并且当前 package 为 2.6.0；发布证据、DSH 最小宿主验证和完整音频特征测试不属于本单元已完成内容 | P0/S1-0 门禁仍待核验。源码差异已核对，其余 host、发布、测试结果和评审链接仍须补齐，才可进入 S1-1 |

RA-01/02：[execute 与停止入口](https://github.com/EricWang1358/dsh-web-studyhub/blob/e024513bb54b1ea0f11de23dac93733c4099e019/lib/runtime/tasks.js#L45-L78)。RA-04：[pause 回调与异常](https://github.com/EricWang1358/dsh-web-studyhub/blob/e024513bb54b1ea0f11de23dac93733c4099e019/lib/job-control.js#L25-L43)。RA-07：[文档 shape](https://github.com/EricWang1358/dsh-web-studyhub/blob/e024513bb54b1ea0f11de23dac93733c4099e019/docs/job-contract.md#L9-L28)、[kind 表](https://github.com/EricWang1358/dsh-web-studyhub/blob/e024513bb54b1ea0f11de23dac93733c4099e019/docs/job-contract.md#L85-L95)、[代码 kind](https://github.com/EricWang1358/dsh-web-studyhub/blob/e024513bb54b1ea0f11de23dac93733c4099e019/lib/job-contract.js#L18-L27)、[Call prep](https://github.com/EricWang1358/dsh-web-studyhub/blob/e024513bb54b1ea0f11de23dac93733c4099e019/lib/job-calls.js#L13-L26)。

## 8. 已读源码与验证范围

完整或相关区段已读：`docs/job-contract.md`、`lib/job-contract.js`、`lib/runtime/tasks.js`、`lib/runtime/work.js`、`lib/runtime/work-ownership.js`、`lib/runtime.js`、`lib/runtime/builtins.js`、`lib/runtime/jobs.js`、`lib/runtime/job-notice.js`、`lib/host.js`、`lib/service.js`、`lib/contexts/jobs/operations.js`、`lib/contexts/library/operations.js`、`lib/contexts/audio/worker.js`、`lib/contexts/audio/operations.js`、`lib/job-control.js`、`lib/job-output.js`、`lib/job-calls.js`、`lib/audio-job.js`、`lib/audio-batch.js`、`lib/audio-pool.js`、`lib/audio-import.js`、`lib/audio-dashboard.js`、`lib/usage-scope.js`、`lib/model-usage.js`、`lib/token-usage.js`、`lib/index.js`、`lib/generation-agent.js`、`lib/host-capabilities.js`；`lib/gemini.js`、`lib/model-retry.js` 的符号与调用点经检索定位。

已读既有测试的相关断言：`tests/backend-boundaries.test.mjs`、`tests/runtime-contracts.test.mjs`、`tests/host-ownership.test.mjs`、`tests/owned-work-services.test.mjs`、`tests/job-contract.test.mjs`、`tests/job-control-audio.test.mjs`、`tests/job-output-audio.test.mjs`。本单元未执行测试。`lib/runtime/job-services.js` 不存在，实际服务入口已核对为 `lib/runtime/jobs.js`。

未验证：实际 DSH 包版本及 scope（包括 `ctx.jobs`、`dsh-atomic-write`）、native child 实际取消/打开、真正网络/远端停止、生产模型质量、Windows 文件竞争实测、崩溃故障窗口、跨进程恢复/锁、控制台截图、P0 发布证据。当前 HEAD/main 源码差异已核对，不能替代这些运行与发布证据。上述范围必须由相应 S1-0 交付物补证据，本文不能替代。
