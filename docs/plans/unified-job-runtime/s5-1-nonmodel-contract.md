# S5-1：非模型执行与能力契约差额

核验日期：2026-10-06。分支 `codex/runtime-s51-nonmodel-contract`，基线 origin/main `fd5c5a1`（S5-0）加内核 PR #287（S2-1a：`gateway.observe` 的 `sideEffect`、`context.persistence`）。依据 [S5-0 基线](s5-0-nonmodel-baseline.md) 的 G-1…G-11 与 D-1…D-13；工作包文本见 [U28](sprints-2-6.md#u28-s5-1)。

本步结论一句话：**非模型任务要用的内核差额很小——4 处增量改动（各自独立提交、先红后绿），其余 G 项由已发布内核加"家族自己的定义"承担，不新增内核类型分支、不新增资源种类、不新增重试层。** 本步不迁移任何生产入口（`lib/index.js`、`builtins.js`、`convert.js` 都没改）。

## 1. G-1…G-11 裁决

"内核改动"列写 K1–K4（见 §2）；"已覆盖"列给出测试证据。测试文件：`tests/unified-runtime-nonmodel-kernel.test.mjs`（内核增量，K 系列）、`tests/unified-runtime-nonmodel-contract.test.mjs`（已覆盖项的契约证据，不改内核）。

| 编号 | 裁决 | 证据与处理 |
|---|---|---|
| G-1 面板无 Agent 发起 | **K4**（只补错误码）；准入规则不变 | `dshJobExecutor.assertAvailable` 在 `submit` 创建 Job 之前执行，所以无存活 Agent 时已经是"先拒绝、后无 Job、无进程"；缺的只是机器可读的拒绝码（原为无码 `Error`，家族入口无法稳定映射成中文提示）。面板入口与音频试点同一条件：`host.js` 以会话 id 取已登记 Agent。无 Agent 的面板在开关打开时**明确拒绝**，不回落旧路径（回落即第二套执行）。测试 `G-1`（内核文件）。宿主侧"无 Agent 的 `jobs.start` 行为"仍是 V-7，本步没有宿主证据，不声称已验证 |
| G-2 记录 Call/请求计数 | **K2**（非模型 Step 策略） | 事实：`context.gateway` 在 `run` 中始终可用，只有 `admit` 内读取才抛 `model-not-admitted`（网关在准入之后创建），`gateway.step().observe()` 对非模型本来就能写 Call。缺口是：Step 策略必须带 `requestedEffort`/`executionMode`，进程 Call 因此被写入"effort default、direct"这类**编造字段**。K2：两者都不写即非模型 Step，只能 `run`/`observe`，`complete` 拒绝 `model-policy-required`；只写其一仍拒绝 `invalid-gateway-policy` |
| G-3 观测边界 | **K1** | 新增 `local-process`（本地子进程或宿主工具调用）：`requestCount` 为 null，不是请求、不是模型请求。云端 HTTP 仍用 `external-request`（计数 1，每次传输重试各一条，保持"一处重试层"）。文件传输走的是 HTTP，不需要新边界 |
| G-4 资源种类 | **不改内核**；用已有准入租约 | `createProviderResources` 只服务音频供应商配额，非音频域 `forDomain` 返回 undefined，非模型任务不会也不应落进去。安装目录互斥、本地进程并发、库级索引互斥用"家族传入的闸门 + `definition.admit` 租约"（音频转写闸门同一模式）。测试 `G-4`：持有者运行时第二个 Job 为 `queued`，取消它从等待队列移除，持有者继续并释放闸门。家族入口的同步单飞检查（`jobs.list()` 内有同类活动 Job 则返回其回执）由各家族在自己的 `submit-<kind>.js` 实现，不是内核资源 |
| G-5 远端操作引用与"先核对后重发" | **不改内核**（本步）；裁决见 §4 | 已覆盖"未知结果阻止盲重发"：声明 `sideEffect: true` 的操作失败或结果未知时，意图保持 `pending`，`retry`/`recover` 以 `remote-result-unknown` 拒绝且不启动 Attempt（测试 `G-5/G-8`，对照无副作用声明时可重试）。**未覆盖**"核对成功后继续"（需要 `reconcileRequest` 钩子）——§4 说明为什么现在不加、何时加 |
| G-6 取消回执与进程清理分开 | **不改内核** | 内核已区分：`cancel` 回执是 `cancelling`，Attempt 只在 `run` 返回且网关 `drain` 完成（被观测操作的清理）后才结算为 `cancelled`；`finalizeAttempt` 在发布终态前等待所有 pending 的观测操作。测试 `G-6`：清理未完成时终态不会发布。因此定义必须把"杀进程树并等退出"放进被观测操作或 `run` 的 `finally`，**不得**像 `runLocalCommand`（D-9）那样 abort 后立刻 reject。这是 S5-2/3/4 迁移时对 `lib/local-command.js` 的要求，不是内核缺口 |
| G-7 执行模式 | **K2 + K3** | `executionModes` 仍只是模型模式，非模型定义保持默认 `['direct']` 不当作能力广告。真正会误导的是 `execution.mode`：此前任何 Call 的 `runner` 都参与计算，只有一次 `local-process` 的任务显示 `direct`，与子代理调用混合时显示 `mixed`。K3：只由模型 Call 决定，无模型 Call 时为 null |
| G-8 恢复语义 | **不改内核** | 与 G-5 同一机制；有 manifest 的路径（PDF）用 `resume-checkpoint` + `persistence`，无状态的路径（安装、setup、索引）声明 `recoveryMode: 'none'`（§3） |
| G-9 不伪造用量 | **已覆盖**（K1 测试一并断言） | 非模型任务 `usage = { tokens: null, tokenUsage: null, calls: 0 }`；`calls` 只数模型请求。已观测请求数、音频时长等按各自单位记在 Call 的 `observation`/家族 `detail`，未知保持 null。测试 `G-9` |
| G-10 任务策略 | **不改内核** | 单步限时已有：`step(..., { budget: { timeoutMs } })` 向被观测操作传递真实 abort 信号并把 Call 记为 `cancelled`（测试 `G-10`）；整任务限时已有 `executionTimeoutMs`/`queueTimeoutMs`。各家族的超时、窗口、批大小常量放家族 settings/defaults 模块（S5-0 §5 的归属表），不进入 `policy` |
| G-11 调用者身份 | **不改内核**；用能力声明表达 Settings-only | 事实：助手只能走 `study_workspace` → `lib/index.js` 的拒绝表（先于任何解析），再到 `job.control`；`job.control` 对运行时 Job 直接调 `scoped.control`，其 `restart` 会用**首次提交时保存的 bindings** 重新准入——内核看不到当前调用者。因此"助手经通用 retry/resume 重启安装"不能靠 `admit` 判断调用者，而要靠**定义不广告这些动作**：安装/卸载/setup 声明 `retry:false`、`pauseMode:'unsupported'`、`recoveryMode:'none'`，则 `retry`/`resume`/`pause`/`recover` 全部在 `control` 的动作判定处被拒绝，发生在任何 Attempt、executor 启动和进程之前（测试 `G-11` 第二条断言了 executor 启动次数与进程次数不变）。再次安装只能由设置页的 `marker.install.start` 重新提交，仍受 `index.js` 拒绝表、`confirm:true` 和目录所有权约束。通用 submit 没有对助手开放的入口（没有 `job.submit` 动作），不新增。需要同时"可重试且仅限面板"的任务出现时再议调用者字段 |

另有一条已在内核里成立、被定义依赖的事实：`admit` 在每次 Attempt（含 `retry`）重新执行，原业务准入（确认、目录所有权）因此在重试时再检查一遍，拒绝发生在 `run` 之前（测试 `G-11` 第一条）。

## 2. 内核增量（各自独立提交，先红后绿）

| 提交 | 改动 | 红灯 → 绿灯 | 文件（行数） |
|---|---|---|---|
| K1 `local-process` 边界 | 边界枚举加一项；网关允许该边界；`requestCount` 沿用"非 external-request/local-wait 为 null"的既有校验 | 红：`invalid-observation-boundary`，任务失败 → 绿：Call 为 `{ boundary:'local-process', requestCount:null }`、存盘可读、伪造 `requestCount:1` 被 `invalid-call-observation` 拒绝 | `contract-schema.js`、`gateway.js` |
| K2 非模型 Step 策略 | `policyOf` 允许"两个模型字段都没有"；`complete` 在无模型策略时拒绝 | 红：`invalid-gateway-policy` → 绿：非模型 Call 不含 `requestedEffort`/`executionMode`；`complete` 拒绝 `model-policy-required`；半个模型策略仍拒绝 | `gateway.js`（190 行） |
| K3 执行模式只描述模型调用 | `refreshUsage` 的 runner 集合取模型 Call | 红：`execution.mode === 'direct'`/`'mixed'` → 绿：无模型 Call 为 null；进程 + 子代理为 `subagent` | `gateway.js` |
| K4 执行者拒绝带码 | `assertAvailable` 的两处拒绝带 `code:'executor-unavailable'`（`submit` 本就以同码拒绝无 executor） | 红：无 `code` → 绿：两种无效 Agent 均拒绝、任务表为空、`run` 未执行 | `executor.js` |

每个提交只触及上述文件加 `docs/job-contract.md` 的一小节；内核文件均 ≤200 行。契约版本仍是 2，音频试点、网关、恢复测试在每个提交后重跑通过（`unified-runtime-gateway/-audio-pilot/-live-execution/-provider-permits/-crash/-recovery/-http-cleanup/-lifecycle/-adapters`）。

## 3. 各路径的能力声明（供 S5-2…S5-5 照此写定义）

| 路径 | cancel | retry | pause/resume | recoveryMode | set | 持久化 | 观测边界 | 准入 |
|---|---|---|---|---|---|---|---|---|
| P1/P2/P3 PDF 与 Marker 转换（S5-2） | 是 | 是（原 `mineru.retry`） | 不支持（原 `CAPABILITIES['pdf-convert']` 不可暂停） | `resume-checkpoint`（manifest 适配器） | 否 | `jobs/<id>/manifest.json` | 云端 `external-request`；本地 mineru/marker `local-process` | 令牌、隐私确认在 `admit`；转换闸门为准入租约（D-11 是否拆成云/本地两个闸门由 S5-2 决定） |
| P4 Marker 安装/卸载（S5-3） | 是 | **否** | 不支持 | `none` | 否 | 无（`marker-install.json` 仍是业务状态） | `local-process`（python/venv/pip/验证） | `confirm:true`、目录所有权、sentinel 在入口与 `admit` 两处；助手拒绝表保持在 `lib/index.js` |
| P5 MinerU 本地 setup（S5-4） | 是 | **否** | 不支持 | `none` | 否 | 无 | `local-process`（服务启停、模型下载、配置写入） | `confirm:true`、tier 校验在 `admit`；"可用后才启用配置"的顺序保留在 `run` |
| P6 检索索引（S5-5） | 是 | 是（再次按 manifest 差量，不重复写已索引页） | 不支持 | `none` | 否 | 无新增；manifest 仍是检查点 | `local-process`（宿主 MCP `ingest_data`/`delete_file` 调用） | 缺 provider/ingest 工具在入口与 `admit` 明确拒绝 |

`executionModes` 对全部非模型定义保持默认，不写 `subagent`。能力只声明上表真实可用的；没有 Settings-only 以外的假按钮。

## 4. 副作用、重试与"未知结果"的裁决

**一处传输重试层**：现状是 HTTP 客户端无重试、重试全在 `mineru-job.js` 的 `guarded`（S5-0 §2）。迁移时二选一，不叠加：保留 `guarded` 作为唯一重试层，并让每次尝试各是一条被观测的 Call（`external-request`，计数 1）；或把重试交给网关策略后删掉 `guarded`。S5-2 选定并在 PR 中说明；本步不改。

**自动重发的条件**（沿用 plan.md 第四节）：创建/上传这类有副作用的远端操作，仅当"幂等键成立"或"结果可核对"时才允许自动重发，否则声明 `sideEffect: true`，未知结果阻止盲重发（已有，G-5 测试）。按路径：

| 操作 | 声明 | 理由 |
|---|---|---|
| MinerU 创建批次 | **待 S5-2 裁决**：需 V-1 证据（是否按 `data_id` 去重、能否查询/删除批次） | 声明 `sideEffect:true` 而无核对手段会让丢响应的任务**永久不可继续**，比旧行为（继续并留下孤立批次，D-1）更差，违反"不低于 2.7.1"。S5-2 须二选一：(a) V-1 证明 `data_id` 幂等，则声明为非副作用并以 `data_id` 为引用；(b) 否则在 S5-2 前**另开内核提交**加核对钩子（见下） |
| MinerU 上传预签名地址、轮询、下载 | 上传：同批次，随创建裁决；轮询/下载：只读，无副作用声明 | 已存 `batchId` 的续跑只轮询、下载（保持，D-2 在迁移时一并修复） |
| 索引 `ingest_data` | 非副作用（按 `sourceKey` 幂等替换） | 上游文档写明"同一路径/source 再次写入会更新已有条目"（mcp-local-rag README，2026-10-06 读取；0.20.0 运行时行为仍属 V-2 待核验，S5-5 以 fake 固定、并在 PR 记录未验证项）。因此 ingest 已成功但 manifest 未保存时，再次以同一 `sourceKey`+`contentHash` 写入只会替换，不会重复创建 |
| 索引 `delete_file` | 非副作用，但**错误不能再被吞**（D-4） | 删除失败保留 manifest 项，下次差量重试；对"不存在"的返回语义是 V-2 的另一半，S5-5 须容忍并记录 |
| Marker 安装/卸载、setup 各步 | 无持久化，不记录意图；停止/失败后由用户在设置页重新开始 | `recoveryMode:'none'`；中断后显示"已中断"而非"可继续"（保持旧行为） |

**核对钩子（`reconcileRequest`）为什么本步不加**：内核当前对任何 `pending` 意图一律 `remote-result-unknown`，这对"拒绝盲重发"已足够，且被测试固定。"核对后继续"需要一个有真实核对手段的消费者才能写对、写测——候选是 S5-2 的云端创建（V-1 未验证）和 S5-6。现在加就是没有消费者的推测接口（违反"最小增量"和"先有真实用例"）。**触发条件**：S5-2 的 V-1 结论为"不幂等且可查询/可删除批次"。届时作为单独的 `kernel:` 提交：`durability.intent` 记录调用方在派发前声明的 `remoteOperationId`（`store.js` 的 `Intent` 已有该可选字段），`preflight` 对 `pending` 意图先调用持久化适配器的 `reconcileRequest(intent)`，只有返回已知结果才改写意图状态并继续，缺钩子/返回未知仍抛 `remote-result-unknown`。不可核对时的拒绝原因要给用户可读文案（S5-6 验收）。

## 5. 准入与授权边界（保持不变）

- 通用 `submit`/`retry`/`resume` 仍进入定义的原业务 `admit`（确认、所有权、工具可用性在每次 Attempt 前重新检查）；`submit` 在创建 Job 之前先过 executor 可用性（K4 的码）。
- Marker 安装/卸载的助手拒绝仍在 `lib/index.js` 的拒绝表（行为测试：`tests/nonmodel-baseline-install.test.mjs`），未确认不启动进程、不写状态；迁移后入口先做 `confirm:true` 与目录所有权检查，再 `submit`，拒绝时没有 Job 也没有进程（S5-3 用同一测试在开关开/关下各跑）。
- 查询、等待、取消沿用各自原授权范围，不套一条全局限制。`job.control` 的 `retry`/`resume`/`pause` 对 Settings-only 定义不可用（§1 G-11）。
- **D-10 / V-8 不在本步改**：`marker.settings.set`（可写任意程序路径，随后 `marker.import` 会执行它）、`mineru.local.setup`（`confirm:true` 由调用方自带）、`mineru.settings.set`、`mineru.import`、`marker.import` 目前对助手仍可达。这是产品决策（哪些操作列入 Settings-only），需要所有者定；建议至少把 `marker.settings.set` 的程序路径写入与 `mineru.local.setup` 纳入同一拒绝表。本步只确认：无论决定如何，迁移不得放宽现状，也不得因迁移让原本被拒的入口变成可达。

## 6. 工具/资源/副作用归属与旧包装去留

| 旧包装/状态 | 去留 | 归属步骤 |
|---|---|---|
| `retrieval-operations.js` 的 `runs` Map 与 `publicRun` | 迁移后删除；`index.status/cancel` 读写 Job；开关关闭时原样 | S5-5 |
| `marker-install.js` 的 `live` Map、进程内取消 | 迁移后由 Job 的 abort/取消回执取代；`marker-install.json` 保留为业务状态与卸载依据 | S5-3 |
| `convert.js` 的 `setups` Map | 同上 | S5-4 |
| `convert.js` 的全局转换闸门 | 变为准入租约（G-4 模式）；是否拆分云/本地见 D-11 | S5-2 |
| `mineru-job.js` 的 `guarded` 重试层 | 唯一重试层，保留或收归网关二选一（§4） | S5-2 |
| `runLocalCommand` 的"abort 即 reject" | 改为等待进程树退出后再结算（G-6、D-9）；该文件由 S5-2/3/4 所属家族修改 | S5-2/3/4 |
| 即时操作（settings/plan/status/test/preview/coverage） | 不迁移，保持即时返回 | — |

## 7. DSH 能力行

| 行 | 本步复用/裁决 | 未验证 |
|---|---|---|
| DSH-02 校验 | 复用 schemastery 契约校验；新增边界进同一 `oneOf`，存盘与读取走同一校验 | — |
| DSH-03 停止/超时 | 复用 `jobs.start` 的停止与 `AbortSignal`；取消回执与清理的先后由内核保证（G-6 测试） | 宿主对无 Agent 面板入口的行为（V-7）；Windows 进程树退出时机（V-4） |
| DSH-06 资源/限流 | 非音频域无供应商资源作用域；本地互斥用准入租约，不引入新资源种类 | 云端 MinerU 配额没有可观测配额域，保持无登记 |
| DSH-07 用量 | 非模型任务用量保持 unknown；不写模型账本 | — |
| DSH-08 存储/恢复 | 沿用 `persistence` 适配器与 `requestIntents`；"未知结果阻止重发"已测 | 核对钩子（§4）待 V-1 |

## 8. 验证

- `node scripts/test.mjs tests/unified-runtime-nonmodel-kernel.test.mjs`（4 条）、`tests/unified-runtime-nonmodel-contract.test.mjs`（7 条）各连跑 3 次无抖动；`npx eslint lib/jobs tests/unified-runtime-nonmodel-*.test.mjs` 通过。
- 内核既有测试在每个 `kernel:` 提交后重跑通过（见 §2）。
- 完整 `npm run verify` 结果见 PR。
- 未验证项：V-1、V-2（运行时行为）、V-4、V-7、V-8（产品决策）；真实 DSH 宿主中的 `jobs.start` 无 Agent 行为本步没有证据。

## 9. 给后续步骤的接口摘要

1. 非模型定义：`run` 内用 `context.gateway.step(key, { purpose, feature, budget })`（不写模型字段）加 `.observe({ boundary: 'local-process' | 'external-request', kind, sideEffect? }, op)`；操作内部负责等进程退出。
2. 家族入口负责：确认/所有权预检、同类单飞检查、把 `executor-unavailable` 映射成中文提示，随后 `submit`。
3. 阶段文案来自家族 `messages.js`；`context.present(reader)` 提供标题/阶段/进度；不在 `lib/job-contract.js` 或 `ui/tasks/*` 加按 kind 的分支。
4. 需要核对钩子时先提交内核增量（§4 触发条件），再迁移调用方。
