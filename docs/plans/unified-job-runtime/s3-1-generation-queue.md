# S3-1：出题接入统一运行时（先接现有队列、生命周期与模型入口）

> 范围：`generate`（含接着做 / 补题 / 覆盖运行 / 案例）与 `supplement`（定向补题）在开关 `runtime.pilot.generation`（默认关）打开时，作为统一运行时的任务提交；选区补题、修题、发布仍走旧路径，但与新路径共用同一条库级队列。基线与缺口见 [s3-0-generation-baseline.md](s3-0-generation-baseline.md)。本步不改草稿检查点语义，不做稳定 Step、重启继续（S3-2/S3-3）。

## 1. 结构（`lib/contexts/generation/jobs/`，每文件 ≤200 行）

| 文件 | 职责 |
|---|---|
| `generation.js` | 两个定义 `generation` / `supplement`：`admit`（等库的轮次，卡片先可展示）→ `run`（调用入口交来的执行器）；尝试内状态放在 admission lease 的 `state`，不写 bindings |
| `library-queue.js` | **唯一**的库级队列：`work.queues`（每库根一条 promise 链）。`run` 给旧入口，`enter` 给运行时；排队中被停止的入口立刻让位，不占后面的轮次 |
| `submit-generation.js` | 入口 `startGeneration`：开关关 = 旧的任务表 + 执行器；开关开 = `jobs.submit`；拒绝码（执行者不可用、卸载中、共享配额未核验）译成学习者可读的话 |
| `gateway-model.js` | 开关开时执行器的模型入口：每次调用 = 一个 gateway step（档位 / 执行方式 / 预算 / 用量由网关记） |
| `legacy-model.js` | 开关关时执行器原有的逐调用记账（step、`withJobUsage`、实时输出、与运行中 worker 的通道），原样从 `operations.js` 迁出 |
| `generation-view.js` | 展示读取器：旧卡片 + 运行时记录 → 控制台契约；旧读取者要的字段（`GENERATION_FIELDS`） |
| `attempt.js` | 联动取消的控制器、`set` 适配、终态翻译（成功 → refs/completeness，其余 → 卡片自己的话） |
| `messages.js` | 家族自己的文案（停止原因、拒绝原因、标题） |

`operations.js`：`generate` 的执行器改为 `execute({ job, control, controller, models })`，其余业务逻辑不动；三处内联的队列链（generate / repair / publish）改用 `libraryQueue`；`generate` 约 47 行净减少。`selection-jobs.js` 仍有自己的一份链式代码（同一个 `work.queues` Map，所以仍是同一条队列），S3-4 再收。

## 2. 开关、回退

- `runtime.pilot.generation`（`lib/index.js` Config，默认 `false`）。只影响**新提交**；已开始的尝试不重提；开→关后已在运行的运行时任务仍由运行时收尾（取消经 `job.cancel` 走内核）。
- 回退：关开关即可，无数据迁移（草稿、题组、用量账本是原来的领域存储；运行时记录本步不持久，重启即消失，与旧路径一致）。
- 开关开且共享服务商配额（`runtime.resources.sharedProviderQuota`）开时，出题**拒绝启动**并说明原因（出题调用尚未接入配额观测，S3-2），不会逐次调用失败。

## 3. 模型调用归属（每个调用点，唯一归属）

| 调用点 | 开关关（旧） | 开关开（运行时） |
|---|---|---|
| 流水线各阶段（规划 / 答案蓝图 / 写题 / 复审 / 修补，含复审重问、补位轮） | `providedComplete` → `modelCompletion` → 出题 worker；档位 `stageEffortRoute`；用量 `withJobUsage`（内存）+ `recordedModels` 日账本 | `gateway.step(stepKey, policy).complete`：`purpose` = 调用种类，`feature` = `generate` / `case`（`case.drills` 为 `case`），`requestedEffort` = 学习者设的该阶段档位，没有或 `follow` 则 `follow`（取会话 + 出题设置里的级别），`executionMode: 'agent-preferred'`，预算 = 单次调用上限；用量与日账本由网关记一次 |
| 覆盖运行的小节权重 | `providedLight`（轻模型、15 s 对冲、`withModelRetry`） | gateway step `plan`，轻模型通道（`{ model: 'light' }`，宿主的对冲与一次瞬时重试，由宿主负责），`executionMode: direct`，预算 45 s（`SECTION_WEIGHT_TIMEOUT_MS`）；失败照旧退回按长度加权 |
| 修题逐卡调用 / 发布前逐题复审 / 选区补题 | 旧路径 | **不变**（S3-5 / S3-6 / S3-4），仍在同一条队列里 |
| 估算、`generate.suggest`、`generate.path.suggest`、检索 | 非任务调用 | 不变（不是后台任务） |

step 键：`[round<n>:]<种类>:<part|all>`（S3-2 才定稳定身份与轮次/补位/储备语义）。step 标签：`stage`、`part`、`slot`、`round`、`retry`、`queuedMs`（后三项为本步新增的内核标签）。

## 4. 旧重试 / 计量包装去留表

| 包装 | 位置 | 处理 | 理由 |
|---|---|---|---|
| 429 退避、自适应并发、调用槽位 `slot`、`onWait/onThrottle` | `lib/batch.js` `limitedComplete` | **保留**，是运行时路径上**唯一**的传输重试层 | 网关不重试；并发/429 与服务商许可的合并是 S3-2 的事，本步不叠第二层 |
| 格式错误再问（`completeJson`、复审重问 `retry`） | `lib/generation.js` | 保留 | 业务格式修复，不是传输重试；重问作为带 `retry` 标签的新调用记录 |
| 拒绝档位后降档再问一次 | `lib/index.js` `modelCompletion` | 保留 | 两条路径共用同一个下层函数，没有新增 |
| 内存用量 `withJobUsage` + step 记账 | `operations.js` → 现 `legacy-model.js` | 开关关：保留；开关开：**迁走**（卡片的 steps / tokenUsage 由网关调用记录派生） | 用量一处记账 |
| `step.runtime ||= 'direct'`、`onEvent` 合并 | 同上 | 开关开：迁到网关调用的 `runner`/`appliedEffort`/`childId` | 执行方式归属唯一 |
| 轻模型对冲 + `withModelRetry` | `lib/index.js`、`runtime/models.js` | 开关开：权重调用经网关的轻模型通道，对冲与一次瞬时重试仍由宿主做（唯一重试层） | 与旧路径等价 |
| `generationMessengers`（向运行中 worker 发补充要求） | `operations.js` | 开关开：**不接入网关**（内核缺口，见 §6） | 网关子代理是一次性、由插件收结果；`job.message` 仍存入 `messages`，对**后续**调用生效 |

## 5. 字段 / 调用点去留（S3-0 §4 中本步负责的行）

| 字段 / 调用点 | 处理 |
|---|---|
| job 记录直接写 `work.jobs` | `generate`/`supplement`：内核记录（旧字段经 `legacyFields` 读取）；repair/publish/selection 不变 |
| `work.queues` 承诺链 | 统一到 `libraryQueue`；选区仍有一份内联代码（同一 Map），S3-4 |
| `generationControllers` | 保留为执行器自己的时限控制器，与尝试信号联动；用户取消 / 卸载同时标记记录的 `cancelRequestedAt`（与其他路径一致） |
| `jobControls` | 开关开：经 `context.controls`（`set`）；暂停声明 `unsupported`（S3-2） |
| `jobOutputs` | 保留（观测存储），按记录 id 与调用 id 写入 |
| `job.retryable` / `continuedBy` | 开关开：`retry` 能力**不声明**（S3-3 才有"同逻辑 Job 新 attempt"）；字段仍可读 |
| `announceJob`、`calibrationFor` | 保留在执行器里（S3-6 / S3-3） |

## 6. 开关打开后的差异（已评审，逐项）

1. **没有「接着做 / 重试」按钮与 `job.control retry`**（`failed-continue-exec`、`honest-run-exec`）：内核 retry = 同输入再来一次，不等于"从草稿继续"。草稿页的接着做、`generate{resumeDraftId}` 不受影响。S3-3 恢复。
2. **覆盖运行不能暂停**（`job.control pause` 被拒；`自动补到完整` 开关仍可调）：S3-2 随检查点身份一起做。
3. **运行中的补充要求不送达当前调用**：`job.message` 的文字保存并用于之后每次调用，不再推给正在跑的子代理（旧路径只有宿主具备"可续接子代理"全部能力时才推，且插件收结果的阶段本来就一次性）。内核缺口：网关没有信使通道。
4. 排队中的任务 `startedAt` 为空（旧路径创建时就有）；`startedAt` 在真正开始时由运行时写。
5. 控制台契约 `jobId` 是逻辑身份，`legacyId` 才是工具与学习者看到的 id（与音频试点相同）。
6. 模型调用选项里没有旧的 `jobId / stage / slot / stageEffort / onEvent / resultOwner`：这些信息在网关调用记录里（`stage`、`slot`、`requestedEffort`、`runner`、`childId`）。

## 7. 开关矩阵与红灯清单

命令：`STUDY_RUNTIME_MATRIX=generation node --import ./scripts/qa/test-network.mjs --import ./tests/helpers/runtime-matrix-preload.mjs --test <套件>`（把任意套件的出题新提交路由到运行时，套件自己的 `complete` 是模型）。43 个出题相关套件：开关关全部通过；开关开 **33 个套件全绿**，10 个套件有红灯，全部归入下面的已评审类别。新增 `unified-runtime-generation-queue` 的红灯证据：把运行时路由关掉（`managed: false`）时 6 条中 3 条红（运行时记录、网关调用、开关翻转），恢复后全绿；第一次孪生运行（队列基线）因假模型按 `jobId` 记归属先红，改为按完成顺序断言后两边都绿。

| 类别 | 红灯 | 处理 |
|---|---|---|
| A. 假模型读旧的逐调用上下文 | `generation-stage-effort` #4（`stageEffort`）、`generation-settings-runtime` #1–5（`slot` / 并发观察）、`job-output-ended` #4–7（`onEvent` 的 `childId`）、`generation-family-baseline-restart-plain` #2（`context.part` 门）、`small-target-weights` #4（数轻模型调用）、`main-context` #5/#9（`resultOwner`） | 同一意图在运行时用调用记录断言：`tests/unified-runtime-generation-queue.test.mjs`（档位 / 执行方式 / 用量）；`main-context` 做了孪生套件（`resultOwner` 在运行时按构造即为插件收结果） |
| B. retry 未声明 | `failed-continue-exec` #1 #2 #3 #7 #8、`honest-run-exec` #4 | S3-3 |
| C. 内核错误码 | `job-control` #12（暂停原因码）、#13（`set` 错误文案） | 码由内核给出，已评审 |
| D. 逻辑身份 | `job-calls-service` #1（`call.jobId` 是逻辑 id） | 已评审 |
| E. 测试替身计时器 | `main-context` #7 #8（`mock.timers` 下运行时的零延迟启动需要一次 tick） | `main-context.runtime.test.mjs` 孪生通过（15+15 全绿，含预算收尾、用户取消优先、目标归档、过期回执） |

孪生套件（`SWITCH_MODE`，两边都跑）：`generation-family-baseline-queue`（五个入口共一条队列）、`main-context`（补题 / 预算 / 取消）。

## 8. 内核改动（三个独立提交，各有红→绿测试）

1. `gateway`：`requestedEffort: 'follow'`（取宿主路由上学习者设的出题级别）；已选定的级别以**不带学习者偏好标记**的路由发出，避免被下游再次替换；步骤标签增加 `round` / `retry` / `queuedMs`。⚠ 第二点也影响音频试点：此前网关选定的档位会被宿主路由上的学习者出题级别二次替换（`tests/unified-runtime-gateway-effort.test.mjs`）。
2. `gateway`：`step(…, { signal })`（与 #294 的 `model` 选项并存；策略校验与档位解析拆到 `lib/jobs/gateway-policy.js`） 接受所有者更窄的信号（出题的"轮预算"到时要停掉在途调用，而不只在尝试结束时）。
3. `lifecycle`（`presented` 处注明约束：一次展示在同一同步轮内复用，在同一轮内既改领域视图又重读记录的读取者会看到前一次展示；执行器写视图、读取者在别的轮读记录，`unified-runtime-record-reads` 钉住）：读取 `work.jobs` 记录的任一字段都会整份展示 + 全量 schema 校验，且 `assertCurrent` 也走这条路径（一次 4 调用的出题慢约 8 倍）。现在内部检查直接读权威契约，同一轮读取记录的多个字段只展示一次（`tests/unified-runtime-record-reads.test.mjs`）。

## 9. 未决问题

- 网关缺信使通道：运行中的补充要求是否要送达在途子代理？（需要内核能力；目前不做。）
- 记录字段读取仍是"每轮一次整份展示 + 校验"：控制台轮询多个大 `detail.legacy` 的任务时仍有成本，是否把校验改为增量？
- `selection-jobs.js` 内联队列链与 `libraryQueue` 并存（同一 Map）：S3-4 合并。
- `input` 现在只存请求参数（`{ args }`）；S3-2 / S3-3 把它冻结成可恢复的持久输入。
