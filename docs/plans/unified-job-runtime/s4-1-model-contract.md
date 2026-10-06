# S4-1：模型任务契约差额与共享接线门禁

> 本步只增加本文与 `tests/unified-runtime-model-definitions.test.mjs`，不改生产代码、不新增接口。基于合并了 #286（S4-0）与 #287（S2-1a 内核支持）的 origin/main；
> 家族基线见 [s4-0-model-baseline.md](s4-0-model-baseline.md)。
> 结论依据是已发布内核 `lib/jobs/**` 的源码与上述测试（全部用假执行者、假模型宿主，不碰真实 DSH、模型或密钥）。
> DSH 能力行：DSH-01（注册/作用域）、02（校验）、04（模型）、05（子代理）、07（用量）、09（事件/通知）；实际宿主证据仍待 S4-9。

## 1. 结论

- **已发布内核足够**表达五个家族的目的、功能、可用动作、owner、执行方式与结果引用；测试 1–9 逐项证明，没有为它们新增空壳接口。
- 内核**不足**的 G1、G2 已由 #294 解决；G3–G5 是家族/共享接线层的约束或映射（第 6 节），已给出做法。
- 家族注册、`Config` 开关、布局护栏、例外清单、`application-messages-en.js` 仍是共享接线，由各 S 步骤以最小改动合入（第 7 节）。

## 2. 定义对照表（目标定义；`kind` 为将来注册名）

| kind | 域（owner 用 `services.workOwner`） | purpose / feature / effort | executionMode | 能力（cancel/pause/retry/set/recovery） | 结果引用 | 负责步骤 |
|---|---|---|---|---|---|---|
| `translation` | `generation.v1` | `translate` / `other` / default | `agent-preferred`（现状=有子代理就用一次性 child，否则直连） | ✓ / checkpoint（波边界）/ ✗ / ✓（并发）/ none | `source`（沿用） | S4-2、S4-3 |
| `coach-prep` | `coach.v1` | `prep` / `coach` / lowest | `direct` | ✓（新增，旧版无）/ unsupported / ✗ / ✗ / none | 无（卡片在 `prepared`，不加引用） | S4-4 |
| `daily-recap` | `notes.v1` | `other` / `other` / default | `direct`（子代理优先是 S4-8 的独立开关） | ✓ / unsupported / ✗ / ✗ / none | `note` | S4-5 |
| `workflow-teaching` | `workflows.v1` | `author`、`review` / `flow` / default | `direct`（同上） | ✓（新增真取消）/ unsupported / ✗ / ✗ / none | 无 | S4-6 |
| `workflow-skeleton` | `workflows.v1` | `plan` / `flow` / default | `direct`（同上） | ✓（新增）/ unsupported / ✗ / ✗ / none | `skeleton` | S4-6 |
| `assist` | `study.v1`（与 `assist.commit` 同域） | `other` / `coach` / default | `direct`；已有 child 复用走 `observe`（第 5 节） | ✓ / unsupported / ✗ / ✗ / none | `card` | S4-7 |

- purpose 取现有调用种类（`lib/job-calls.js` 的 KINDS），不新增种类；feature 取现有用量桶（`USAGE_FEATURES`）。**feature 为 `other` 的翻译与总结沿用现状**；助手今天不入账（D4），迁移后入账，桶选 `coach`（与 `featureOf('study', …)` 一致）——这会改变用量面板的数字，列为所有者待定项。
- 所有家族 `recoveryMode: 'none'`（S4-0 §6.10：重启后任务不恢复，不得顺带承诺）；`set` 只有翻译（并发）真实可用；`retry` 一律不声明（重做 = 重新提交）。
- 结果引用只写领域已有稳定 id 的产物；`ui/tasks` 不认识的 kind 被忽略，不需要新增分支。

## 3. 旧动作 → 公共能力

| 家族 | 旧入口（面板 / 工具） | 公共能力或处理 |
|---|---|---|
| 翻译 | `generation.translation.start/status/jobs`；`job.control` cancel/pause/resume/set；`job.wait/status/output/cancel/dismiss/archive/delete` | `submit` / `status` / `list`；`control` 的五个动作；wait/output 与归档读契约，不变。pause 在波边界（`context.checkpoint`），retry → `capability-unsupported`。`materials.translation.translate/cancel`（无任务的即时请求）不是 Job 动作，保留 |
| 为你定制 | `coach.variants/prepare/flush/queue/status/activity/idle`；日行 `job.control`（`coach:YYYY-MM-DD`）pause/resume/set | 每批 = 一个 `coach-prep` Job；队列合并（3 张 / 20 s）仍在 coach。日行仍由 `coach-daily` 投影，日行的 pause/resume/set 仍走日账本（今天的设置，不是某批的设置）；日行 cancel 仍是 `capability-unsupported`（日是记录不是运行）；批 Job 可 cancel（新增） |
| 每日总结 | `note.daily.generate/advance/cancel/status/reconcile` | generate/advance → `submit`（在途则合并为 `generation.next`，那是 notes 的领域逻辑，在提交前判断，不需要内核）；cancel → `control cancel`；reconcile 的 supersede → G3 |
| 学习流 | `workflow.teaching.start`、`workflow.skeleton.generate`（`estimate`/`undo` 不是任务） | `submit`；cancel 为新增（解决 D2/D3 需要同时让 signal 到达网关，S4-6 实现） |
| 助手 | 面板处理器 `assist.start`（唯一入口）、运行时 `assist.commit` | 迁移后 `assist.start` 须成为 study 域的运行时动作，面板与工具同权限，禁止仅 UI 可控的任务（S4-0 §3）；清理（`clearAssist`）= 取消该库的助手 Job |

不支持的动作一律由内核给出原因码（测试 1 逐家族逐动作断言抛出的 `error.code` 与 `actions.*.reason.code` 一致）：`pause` → `capability-unsupported`；`resume` → `not-paused`（该类任务永不进入 paused）；`retry`/`set` → `capability-unsupported`。翻译运行中 `pause` 可用，`retry` 不可用。

## 4. 范围与隔离（不扩大）

内核用「插件 work owner + 域」授权；work owner 是**宿主级**（`servicesForHost` 的 `workOwner`），不是会话：同一库的不同会话经 `lifecycle.compatible(id, owner, services)` 得到同一个 Job，查看与控制范围与现在的库级范围一致（`scopedJobs()` 另按库根过滤）。停止命令发给**接纳该 Attempt 的执行者**，而不是发起控制的会话的执行者（测试 3）。另一个 work owner（扩展）：`visible=false`，`compatible`/端口 `status` 抛 `job-not-found`；另一个域（例如 coach 域读翻译 Job）同样 `job-not-found`，向它提交别的家族的 kind 抛 "Job definition unavailable"。S4 各步骤不得为方便而放宽 `authorize`。

## 5. 执行归属（直连 / 现有 child / agent-preferred）

测试 4 在**同一个 Job、同一个 Attempt** 里依次做三种调用：直连 `step.complete`；`agent-preferred` 在宿主有原生父代理时启动一次性 child；已有可复用 child 用 `step.run → step.observe({ boundary: 'host-attempt', runner: 'subagent' })`，由宿主服务自己持有 child，结果带 `childId/parentId` 与用量。三者的 Call 都带同一 `jobId/attemptId`，`stepRunId` 指向 `runtime.steps` 中同一 Attempt 下同 `stepKey` 的运行；`execution.mode` 汇总为 `mixed`。

- `agent-preferred` 是**策略**，不是定义里的第三种模式；定义 `executionModes` 必须同时声明 `direct`、`subagent`，否则有原生父代理时步骤失败为 `execution-mode-unsupported`（不会静默降级）。S4-0 §6.5 的"缺定义级 agent-preferred"因此**不是内核差额**：S4-8 只需把定义声明为两种并在步骤上用 `agent-preferred`，由独立开关控制。
- 助手一个 child 跨多个任务：Job 只**观测**宿主的那次尝试，child 的生命周期仍归 `assist-child`。其清理放进接纳租约的 `finish()`：内核在结算和通知前等待它（测试 5），所以"cleanup 未完成时公共 wait 不提前宣告收尾"（S4-0 §6.6）已满足。

## 6. 内核差额与其余 S4-0 §6 条目复核

| # | 差额 | 影响 | 建议（内核负责人决定） |
|---|---|---|---|
| **G1** | 网关 `complete` 不经 `modelServices`（语言/图片/脚注准备、轻量路径的对冲与重试） | 所有家族 | **已解决（#294）**：网关用 `preparedModelHost`（未入账），步骤用 `{ model: 'light' }` 选轻量路径；较高推理档由网关交给轻量路径（S4-4）。本节原先的 `step.observe` 包装方案已被取代，仅保留测试 8 作为内核对「宿主自带重试的服务 = 一次观测」的证明 |
| **G2** | 无持久化定义没有结算事件接收器 | S4-2、S4-7 | **已解决（#294）**：定义级 `notifications: [{ channel, deliver(event, view) }]`，进程内投递一次，失败记 `detail.notificationError`，不改终态 |
| **G3** | **终态映射**：到期（`executionTimeoutMs`/步骤预算）的 Job 结局是 `cancelled` + `detail.stopReason: 'execution-timeout'`、`error: null`（测试 7），旧翻译是 `failed`/`budget`；`superseded` 作为 `endReason` 只在契约里，内核停止路径固定写 `user-cancel` | 翻译到期展示、总结 supersede 的展示 | 先在家族 `present` 里用 stage/detail 映射并登记；若体验不可接受，内核增加"带原因的停止"。S4-2、S4-5 各自决定 |
| **G4** | **用量桶**：`USAGE_FEATURES` 没有翻译/总结/助手 | 面板数字归类 | 所有者决定；默认沿用第 2 节 |
| **G5** | **批次 Job 与日行重复**：Job 一律进 `work.jobs`，而 `library.snapshot`、`pruneJobs`/自动归档、`job.cancel all` 都把每个 Job 当一行。为你定制要保持"一天一行" | S4-4 | 家族给批 Job 一个遗留字段（如 `listedIn: 'coach:<date>'`），共享接线处用一个与 kind 无关的过滤判断；不加 `type ===` 分支 |

S4-0 §6 其余条目：①排队——`definition.admit` 委托现有 `queues(root)` 即可，Job 在 admit 期间为 `queued`，取消立即结算且不抢后继位置（测试 6，顺带解决 D8）；②日聚合——批各为 Job，日行继续由 `coach-daily` 投影（G5）；④真取消——网关给每个 Step 一个 signal，步骤预算会真正中止请求；⑦账本——内核按 `callId` 幂等入账；迁移路径上的模型**必须未经 `recordedModels` 包装**（G1）；⑨预算——步骤 `budget.timeoutMs/maxOutputTokens` 已有，总结原本无预算，是否新增属 S4-5 决定；⑩恢复——全部 `none`。

## 7. 共享接线归属

| 共享文件 | 每个家族的最小改动 | 谁合并 |
|---|---|---|
| `lib/index.js` `Config` | `runtime.pilot.<键>`，默认 false：`translation`、`coach`、`dailyRecap`、`workflow`、`assist`；策略改进另设独立键（翻译并行、子代理优先） | 各步骤的 PR 加一行，内核负责人合并 |
| `lib/runtime/builtins.js` | 在该家族的 `install(id)` 里 `runtime.registerJob(scope, '<id>.v1', definition)`（音频的写法）；开关只在家族**一处**读（`services.runtimePilot`） | 同上 |
| `tests/unified-runtime-layout.test.mjs` | 新增 `lib/contexts/<family>/jobs` 到 `RULES` | 同上 |
| `docs/plans/unified-job-runtime/s1-7-legacy-exceptions.json` | 新定义进 `managedDefinitions`，改动的调用点更新条目 | 同上 |
| `lib/application-messages-en.js` | 家族 `messages.js` 的英文 | 同上 |
| `lib/host-capabilities.js` | 不改；子代理、对冲、重试都不在这里加 | 内核负责人 |

## 8. 验证

- `node scripts/test.mjs tests/unified-runtime-model-definitions.test.mjs`：10 例（含本文档与测试的 kind/G 编号同步检查）。
- 本 PR 没有生产代码改动，旧实现行为不变；回退 = 回退本 PR。
