# S1-1：v1 兼容边界与 v2 目标投影

**状态：契约草案，未实现兼容 facade。** 基线是已合并 [PR #241](https://github.com/EricWang1358/dsh-web-studyhub/pull/241) 的 `f091f09f830c226bfebc9af22344896733893a10`；S1-0 的已验证范围和限制按所有者本轮接受记录保留。本文区分发布版事实、待评审目标和后续实现验收。JSON fixture 只锁定合成记录的形状与投影，不证明真实生产者已兼容。

## 1. 唯一事实来源、权限与写入者

沿用 [字段与资源审计](s1-0-runtime-audit.md#4-字段操作与唯一责任者清单)；当前 `runtime.work.jobs` 是共享业务记录，`tasks.js` 的 entry、controller 和 owner/domain queue 是执行索引。v2 必须演进同一来源，facade 只读取、转换和委托，不能增加独立 jobs 表、状态机、结算或通知层。

| 字段 / 操作 | 当前事实 | 迁移后唯一写入者 / 约束 |
|---|---|---|
| Job 身份、状态、当前 Attempt、起止、取消、终态、checkpoint 关联 | 各领域 worker / tasks executor 写；v1 adapter 只读 | 内核生命周期责任者；DSH 执行 handle 是关联，不允许另一层独立决定同一次结算 |
| Attempt 执行 handle、停止/完成回调 | 现有 controller；宿主 jobs 有真实 owner/controller 条件 | 经审定的唯一执行责任者；回调须校验 Job / Attempt 身份，底层未收尾不提前释放实际占用 |
| manifest 输入引用、指纹、参数、逐段业务 checkpoint、产物内容 | `audio-batch`、音频领域 writer | 保留领域 writer；内核授权当前 Attempt 提交；元字段和业务字段不能彼此覆盖 |
| progress / detail / result refs | 领域执行者报告，v1 投影 | 领域受控提交，经当前 Attempt 权限校验；结果成功提交和终态不得由 facade 猜测 |
| Call / provider observation / usage | taskTracker、usage sink、audio meter / ledger | 模型网关为迁移路径唯一 Call writer；账本沿用既有 writer、稳定 Call 去重；旧路径按例外保留 |
| 实际许可、429、传输 retry | `audioGate`、录音/批次 pool、既有 retry/provider 包装 | 复用同一资源与唯一责任层；去留表在 S1-3/4 定稿，不在契约 PR 新增实现 |
| 完成事件与通知 | worker finally；notifier 对当前对象用 WeakSet | 生命周期只产生一次稳定完成事件；业务通知适配读取事件和旧可见身份，投递失败不改终态 |
| v1 lean record / `contract` / 控制回复 / UI link | published projector / operations / UI | 只读 legacy facade 与已发布 projector；不能成为第二个 writer 或伪造生产者观测 |

旧 extension 的 fence 是 `Symbol.for('studyhub.worker.owner.v1')` 保存的对象/Symbol 身份，加 `entry.domain === domain`。队列键为每个 owner / domain / queue 的私有 Symbol；同名 queue 不能跨 owner 共用。`workOwnedBy(work, undefined)` 在旧内部 helper 中是通配，而不是新公共 API 的授权规则。目标接口必须携带真实受控 scope，禁止把 owner 丢成 undefined 来绕过隔离。证据：[ownership](https://github.com/EricWang1358/dsh-web-studyhub/blob/f091f09f830c226bfebc9af22344896733893a10/lib/runtime/work-ownership.js#L1-L8)、[tasks owner/domain 与队列](https://github.com/EricWang1358/dsh-web-studyhub/blob/f091f09f830c226bfebc9af22344896733893a10/lib/runtime/tasks.js#L14-L44)。

DSH owner 是注册表内**精确、仍存活的 Agent / session**，不能以一个看起来相同的 ID 或旧 Symbol 代替；controller 必须服务该 Agent composition。S1-0 的 bare `agents.create` 被拒绝，显式官方 `dsh-tool-jobs` preset 组合通过；不是所有默认会话自动有 controller。宿主状态 `running/stopping/completed/killed/failed` 是执行状态，不能直接写成九种业务状态。最终 StudyHub fiber 与 Agent/controller 绑定仍是 S1-2 宿主验收，禁止 unowned bypass 或手写宿主替身。引用 [DSH-01/03/05/08/09 及 H 探针](s1-0-dsh-capabilities.md#固定行-id-能力对照)。

## 2. 旧入口逐项兼容

| 已发布入口 / 消费者 | v1 查询与身份事实 | 目标兼容要求（尚未实现） |
|---|---|---|
| `audio.import` / `audio.retry` 回复 | `jobId` 是 `job.id` 的可见执行记录 ID；单文件另有稳定 `singleId`，批次另有 `batchId` | 返回 legacy facade ID；显式 retry 才更换 facade ID。不能把内部 physical Attempt ID 直接替换回复 |
| panel `snapshot` / `snapshotJob` | `job.id` 保留旧 ID；音频有 single/batch 时 `contract.jobId = batchId || singleId`、`contract.attemptId = job.id`；其他 kind 是 `contract.jobId = job.id` | v1 snapshot 保持同样形状与身份；v2 canonical 另按版本读取。PDF 虽支持 retry，当前 v1 没有稳定 lineage / attemptId，不能擅自补成已知 |
| `job.status` | 无 ID 列当前库；有 ID 仅精确匹配 `job.id`；返回 lean record，无 `contract` | 保留精确 facade ID 查询、库边界与 `not-found`，不扩大成逻辑 Job 查询 |
| `job.wait` | 有 ID 仅精确匹配；无 ID 取当前库最后记录，空库 `{status:'none'}`；1–60 秒观察者上限，缺省 60 秒；等待 worker 收尾 bookkeeping，超时返回 lean snapshot，不取消 | 等待 facade 所代表的逻辑执行完成及 bookkeeping；内部暂停结束 physical Attempt 不得使旧 wait 提前完成。超时仍只结束观察 |
| `job.cancel` | 精确 ID 或当前库 `all:true`；两者互斥。发布检查拒绝；已终结/已请求取消通常不再修改；排队直接 cancelled、运行 cancelling | 保留旧 idempotent 行为及库范围；不是 `checkAction` 的别名。实际执行停止另走唯一生命周期协议 |
| `job.dismiss` | 精确 `jobId` / `jobIds` / `all:true` 三选一；活动任务拒绝，先从列表删除再清理；有 coach day 独立 ledger 分支 | 保留当前 facade 与历史折叠行的精确删除；不将尚未结束的 logical pause 当可 dismiss |
| `job.control` | 当前库 exact `job.id` 优先，否则取最后一个匹配 `batchId` / `singleId`；coach day 独立分支；回复 `jobId` 回显请求、`attemptId = job.id` | 保留查找顺序、请求回显、当前 facade ID 和拒绝顺序；动作委托唯一内核，不建立 facade controller |
| `job.output` | 同 control 的 ID 查找；`callId` 必须在保留的 `jobCalls` 内；回复 `jobId = job.id` | 保留 facade / Call 关联与遗失记录拒绝。跨 physical pause 的 Call 归属和有界保留须实现测试，不保证无限历史读取 |
| `audio.retry` | exact ID、库、kind、retryable entry 检查后执行；成功移除旧 record/旧失败信箱，返回新 ID；失败恢复旧 record | 保留显式触发、新 facade ID、无永久旧 alias；不自动启动恢复，不用未知输入构造请求 |
| `work.start/get/list/cancel/wait` extension API | owner + domain scope；`wait(timeoutMs)` 到期返回快照、不 cancel；key 去重仅相同 scope 中活动任务；已结束最多保留 100 个 | 保持 Symbol+domain fence 与 observer wait；宿主 handle 通过合法 scope 关联，不能映射成 unowned 任务 |
| 信箱 / session 通知 | 保存并使用旧 `job.id`；音频完成只是资料，没有自动出题；WeakSet 仅当前进程对象去重 | 投影 facade ID 与旧 prose/产物语义；physical checkpoint pause 不发旧终态通知；持久投递去重在 S1-5 另测 |
| 控制台 / 卡片 / 子代理链接 | 控制台选 `contract.jobId`，deep link 同时接受当前 `task.id`；dismiss / 音频重试用旧 ID；host AgentLink 读真实 childId/parentId | 保留两种当前可见链接，retry 后旧 ID 不强加永久 alias；缺失 childId 不造会话链接，真实 host 导航权限在 S1-6 验证 |

证据：[ID 与操作](https://github.com/EricWang1358/dsh-web-studyhub/blob/f091f09f830c226bfebc9af22344896733893a10/lib/contexts/jobs/operations.js#L37-L141)、[status/wait](https://github.com/EricWang1358/dsh-web-studyhub/blob/f091f09f830c226bfebc9af22344896733893a10/lib/contexts/jobs/operations.js#L170-L227)、[exact get 与 not-found](https://github.com/EricWang1358/dsh-web-studyhub/blob/f091f09f830c226bfebc9af22344896733893a10/lib/util.js#L15-L23)、[audio retry](https://github.com/EricWang1358/dsh-web-studyhub/blob/f091f09f830c226bfebc9af22344896733893a10/lib/contexts/audio/operations.js#L124-L151)、[contract identity](https://github.com/EricWang1358/dsh-web-studyhub/blob/f091f09f830c226bfebc9af22344896733893a10/lib/job-contract.js#L316-L329)、[通知](https://github.com/EricWang1358/dsh-web-studyhub/blob/f091f09f830c226bfebc9af22344896733893a10/lib/runtime/job-notice.js#L17-L26)、[UI](https://github.com/EricWang1358/dsh-web-studyhub/blob/f091f09f830c226bfebc9af22344896733893a10/ui/tasks/TaskConsole.jsx#L120-L130)、[卡片](https://github.com/EricWang1358/dsh-web-studyhub/blob/f091f09f830c226bfebc9af22344896733893a10/ui/tasks/CompactJobCard.jsx#L55-L57)、[输出链接](https://github.com/EricWang1358/dsh-web-studyhub/blob/f091f09f830c226bfebc9af22344896733893a10/ui/tasks/OutputPanel.jsx#L61)。

## 3. checkpoint pause 与 legacy facade

已批准 [plan.md 的暂停语义](plan.md#3-暂停) 是：检查点保存、实际在途执行收尾后，结束当前 physical Attempt、Job paused；resume 创建新 Attempt。发布版 `createJobControl` 只是同一执行器内暂停 dispatch：`job.status` 仍 running，`paused/pausedAt` 由 adapter 投影 pausing/paused，恢复不换 `job.id`。这两个身份语义不能直接合并。

目标保留同一 Job 元记录上的 legacy facade 元数据：可见 ID、当前 physical Attempt 关联及需要投影的旧字段；它不是第二张任务表，不能保留独立控制器、queue、settlement promise 或 lifecycle writer。facade 在正常 pause/resume 链中保持旧可见 ID，旧 `contract.attemptId` 因而不等于 v2 physical `attemptId`；显式 retry 才换 facade ID。canonical Call 保持产生它的真实 physical Attempt 关联，v1 Call 投影回 facade ID。旧 wait 观察 logical Job 和最终 bookkeeping，不能委托“当前 physical handle settled”作为完成判据。

canonical `attemptId` 指最近一次 physical Attempt，不单独表示它仍活动；`runtime.activeAttemptId` 单独指向活动 Attempt，没有时为 null。暂停后最近 Attempt 的状态为 complete、`endReason:'checkpoint-pause'`，有真实 checkpoint 引用，`activeAttemptId=null`；resume 后创建新 ID 并关联为 active，保留旧 Attempt 的观测记录。`runtime.legacyId` 是同一元记录上的可见 facade ID。不会为了满足 fixture 编造旧执行者 ID、结束时间或有效 checkpoint；缺少 runtime admission 证据的旧记录仍只返回 v1，不凭空升成 canonical。若 S1-2 无法实现上述无第二状态机的 facade 委托，试点必须保持关闭；新增可见身份/暂停行为只能单独提出默认关闭的策略评审。

旧恢复 `[queued,running,cancelling]` 记录被 worker 改为 `failed + retryable` 并显示「上次导入已中断」。目标仅在**确认原执行者丢失**时写 `interrupted`；v1 facade 对这类已确认中断仍投影原 failed/retryable 卡片与 explicit retry。任意 failed 不等于 interrupted；输入缺失、版本不兼容、原执行者仍活着或远端结果未知均不能自动发起新 Attempt。单文件持久 manifest 继续使用 `kind:'single'`，先验证原输入指纹。证据：[旧 pause](https://github.com/EricWang1358/dsh-web-studyhub/blob/f091f09f830c226bfebc9af22344896733893a10/lib/job-control.js#L25-L93)、[重试与恢复](https://github.com/EricWang1358/dsh-web-studyhub/blob/f091f09f830c226bfebc9af22344896733893a10/lib/contexts/audio/worker.js#L185-L211)、[S1-0 行为](s1-0-audio-behavior.md)。

## 4. 状态与动作

旧读映射保持 `done → complete`、`partial → complete + result.completeness:'partial'`、`superseded → cancelled + endReason:'superseded'`；未知 raw status 在有 `finishedAt` 时 failed，否则 running。v2 新写入只接受九种契约状态；未知旧值可保留原值作来源说明，不能按未知值启动执行器。v1 的 `queued/running + paused` flag 投影保持不变，不能把规范化后的 paused 字符串直接写回旧 record，因为旧 active/action 判断读 raw status。

| 目标 Job 变化（待实现） | 条件 / physical Attempt 语义 |
|---|---|
| submit → queued → running | 合法 scope 和定义版本；只有一次实际 admission；最多一个活动 Attempt |
| running → pausing → paused | 支持 checkpoint；停止新 dispatch，在途到安全边界、checkpoint 保存成功、实际占用释放后结束 Attempt；保存失败不能声称安全 paused |
| paused → queued/running | 支持 resume，验证 checkpoint / 输入 / 定义版本；创建新 physical Attempt，保留 Job 与 facade ID |
| queued → cancelled | 取消前未启动执行器；不能调 run |
| running/pausing/paused → cancelling → cancelled | 停止及领域收尾完成后结算；底层未知停止明确保留状态/占用限制 |
| running → complete / failed | 当前 Attempt 的受控业务结果；迟到旧 Attempt 的状态/产物提交被拒绝 |
| lost executor → interrupted | 确认丢失后识别；无自动恢复 |
| failed/cancelled/interrupted → queued/running | 声明且合法的 explicit retry；新 Attempt、新 facade ID、同一逻辑音频 Job |

以下是 **v1 正常音频 producer 记录**的动作矩阵（`control` 存在、`retryable=true`；paused/pausing 是 raw running + flags）。`—` 后的 code 是拒绝原因。其他 kind 必须先按能力与下面的顺序判断，不能套表。

| 视图状态 | cancel | pause | resume | retry | set |
|---|---|---|---|---|---|
| queued / running（未暂停） | 可用 | 可用 | — not-paused | — not-ended | 可用 |
| pausing / paused | 可用 | — already-paused | 可用 | — not-ended | 可用 |
| cancelling（未暂停） | — already-cancelling | — already-cancelling | — not-paused | — not-ended | 可用 |
| complete | — job-ended | — job-ended | — job-ended | — not-retryable | — job-ended |
| failed / cancelled / interrupted | — job-ended | — job-ended | — job-ended | 可用 | — job-ended |

queued audio 还没有 control 时，pause/set 为 `no-control-yet`；不会显示假按钮。cancelling + paused 的旧异常组合，resume 的判定没有 cancelling 分支，仍按 paused 判断；应保留事实，不能偷偷以新拒绝覆盖。旧 direct `job.cancel` 对终态和重复请求通常成功返回，不返回这个矩阵的 `job-ended`。

拒绝优先级逐项保留 [唯一 judge](https://github.com/EricWang1358/dsh-web-studyhub/blob/f091f09f830c226bfebc9af22344896733893a10/lib/job-contract.js#L161-L201)：

1. 查找先于 action：`job.control` 找不到 record 先报无记录；找到后缺少 action 单独报错；非法 action 是 `unknown-action`。
2. cancel：coach day `capability-unsupported` → cancelling `already-cancelling` → 非 active `job-ended` → capability；pause：非 active → cancelling → paused `already-paused` → unsupported → queued-only `no-safe-checkpoint` → control `no-control-yet`。
3. resume：非 active `job-ended` → unsupported → paused / `not-paused`；retry：unsupported → active `not-ended` → 可重试状态且 `retryable===true` / `not-retryable`。
4. set：非 active → capability → control；动作获准后才校验 patch。整包 patch 必须先全部验证；`set` 中 paused 报 `unknown-setting`。未知键/非法值不会部分应用。

## 5. 缺失、计量和 live output

| 字段 | v1 事实 / v2 约束 |
|---|---|
| progress | 未知 total / percent 为 null；音频单文件的 files total=1 和 save segment 是结构事实，不能拿它推断文本窗口数或转写总页数 |
| time | Job startedAt 缺失为 null，finishedAt 只在 terminal 且实际有值时出现；Call startedAt/endedAt 缺失为 null，queuedAt 仅由实测 queuedMs 与有效 startedAt 推导；未观测 firstOutputAt 不填 |
| usage | tokenUsage/tokens 未观测为 null；旧 usage.calls 优先 tokenUsage.calls，否则统计非 wait 的 producer 记录。这个数字不是全部 HTTP attempt 数；新 observation 的 boundary/requestCount 要如实表明可观测边界，未知请求数为 null，不从 records 推算 |
| token buckets | uncached input / cache read / cache write / output 按来源计；reasoning 是 output 子集，不再相加；缺失不补 0，真实观测 0 才是 0；估算成本标来源且不混入实际请求计数 |
| execution / IDs | 没有 runner 时 execution.mode=null；无 parentId/childId 不伪造；宿主内部 retry 看不到就不生造 Call |
| v1 read compatibility | 当前 coach/detail/音频用量投影有历史默认 0 等语义，fixture 按实际发布代码保留；它们不是 v2 新观测为零的证据，不能反推已知 |
| live output | limit=8192，最多 24 个活动 buffer；`unit:'chars'` / cursor / reasoningChars 都是 JavaScript UTF-16 code units（String.length/slice），不是 Unicode 字符数或字节数。输出在内存，非持久日志 |
| output refusal / expiry | 先找 Job，再验证 callId，再验证保留 Call；没有 buffer 时以 wasOpened 判 supported，非 live 返回 ended。过旧或超前 cursor 返回保留尾部并 truncated，客户端替换显示；结束后的增量被丢弃，不复活 buffer |

证据：[投影与时间](https://github.com/EricWang1358/dsh-web-studyhub/blob/f091f09f830c226bfebc9af22344896733893a10/lib/job-contract.js#L324-L353)、[Call 观测](https://github.com/EricWang1358/dsh-web-studyhub/blob/f091f09f830c226bfebc9af22344896733893a10/lib/job-calls.js#L34-L56)、[token buckets](https://github.com/EricWang1358/dsh-web-studyhub/blob/f091f09f830c226bfebc9af22344896733893a10/lib/token-usage.js#L22-L43)、[输出 buffer](https://github.com/EricWang1358/dsh-web-studyhub/blob/f091f09f830c226bfebc9af22344896733893a10/lib/job-output.js#L12-L69)。

## 6. Fixture 与后续门禁

[golden compatibility data](../../../tests/fixtures/unified-runtime-compatibility.json) 保存小组合同向量：同一合成旧记录的真实 `jobContract` v1 输出和待实现 v2 canonical 形状，尤其是 pause/resume 的 facade 不变与 physical Attempt 更换、中断 old failed/new interrupted、缺失观测。v2 physical ID/checkpoint/丢失证据是明确写入的**目标合成前提**，不是从旧 record 猜出，更不是生产者实测结果。v1 status alias / 非法版本 / 不支持能力由契约 fixture 补充。

本 PR 的 executable fixtures 可以证明 shape、拒绝规则与 published projector 的稳定向量；不能证明真正公共旧操作、manifest writer、owner/controller、Call 归属、跨 Attempt wait / output 或 browser link 已连接到目标内核。

后续必须提交实现证据：S1-1 的版本读边界和 facade 委托；S1-2 真正 owner/controller 绑定、停止/一次结算/迟到产物保护；S1-3 新旧混跑共享实际资源；S1-4 唯一 gateway 和真实观测；S1-5 checkpoint / 崩溃 / 通知去重；S1-6 同一特征测试开/关各跑、UI 与 DSH 权限流程。恢复、并发、子代理选择等新的可见政策保持各自默认关闭，不能随 audioSingle 试点一并启用。
