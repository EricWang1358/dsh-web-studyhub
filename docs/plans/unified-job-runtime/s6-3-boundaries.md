# S6-3：结构与 API 边界护栏

核验日期：2026-10-07。分支 `codex/runtime-s63-boundaries`，基于 main（含 #340）。工作包文本见 [U38](sprints-2-6.md#u38-s6-3)；前序：[S6-0](s6-0-coverage.md)（启动点与例外清单）、[S6-2](s6-2-dead-only.md)（调用图）。

本步只加护栏与它们的正反例，**不改任何运行时代码**。新测试：`tests/unified-runtime-boundaries.test.mjs`（9 条）；扩展：`tests/architecture-boundaries.test.mjs`（+2 条）；新辅助：`auditJobModule`/`diagnose`（`tests/helpers/runtime-architecture.mjs`）、`tests/helpers/kernel-shape.mjs`。

## 1. 一个 Job 模块不能做什么（五条规则）

`auditJobModule(source)` 按**调用与绑定的确切形状**（AST，不看名字像不像）返回 `{ rule, api, count }`；失败信息是一行：`<模块>: <规则> — \`<API>\`: <为什么>`，原因取自 `RULES` 一处，所有失败说同一句话。

| 规则 | 拒绝什么 | 为什么（失败信息里的话） |
|---|---|---|
| `gateway-bypass` | 直接问模型：`x.complete(…)`、`ctx.llm.stream`、`providedComplete/providedLight`、provider 地址的 `fetch`、不经 `context.gateway.step` 的 `step(...).complete` | Job 只经 `context.gateway.step(key, policy).complete(...)` 问模型；直接调用没有 Call、没有用量、没有许可、没有停止 |
| `provider-import` | 导入 `gemini/groq/siliconflow/model-completion/host-capabilities` | provider 经网关到达；导入 provider 模块就是第二条没人观察的路 |
| `public-table-write` | 对 `jobs/tasks/queue(s)/retryable/generationControllers/settled/jobControls/jobOutputs` 做 `set/add/push/delete` | 公共任务表和它的控制器属于运行时（`lib/jobs/lifecycle`）；Job 模块自己不写 |
| `public-queue` | 自己分配名为 `jobs/tasks/queue(s)/jobTable/taskTable` 的数组/Map/Set | 调度是运行时的（`lib/jobs/scheduler.js`，一层许可）；Job 模块不分配自己的队列或任务表 |
| `lifecycle-write` | 给 `…contract.status/attemptId/finishedAt/calls/events` 赋值 | 状态、attempt、时间、Call 与事件由生命周期写；Job 模块只呈现它们 |

**不会被误伤**（正例，测试逐条断言为空）：不带 provider 地址的 `fetch`；领域 Map（`reserve`、`candidates`、`writers`、`locks`）；per-file 写入队列（形状同 `lib/store-lock.js`、`lib/atomic-json.js`：`tails`、`holding`）；私有 controller（`new AbortController()`、`controllers` Map、`#controller` 私有字段）；`context.gateway.step(...)` 与绑定了它的 `step.complete`；视图/成员自己的 `status`/`finishedAt` 赋值。

## 2. 真实的 Job 模块与例外（精确，不用通配）

范围：每个已登记定义（`managedDefinitions`）所在的目录及其中所有文件（共 11 个目录）。当前只有 **13 处**命中，全部是 S6-0 已经说明过的东西，逐行登记在 `s1-7-legacy-exceptions.json` 的新字段 `boundaries`（模块、规则、API、次数、理由、`removeAt`）：

| 模块 | 命中 | 理由 | 何时去掉 |
|---|---|---|---|
| `audio/jobs/live-correction-models.js` | `gateway-bypass tiers.complete`、`provider-import gemini.js` | 课堂校正的 Gemini 文字叶子，调用发生在校正 Job 的网关 Step 里，本模块只是构造它 | 保留：provider 叶子 |
| `audio/jobs/text-model.js` | `provider-import gemini.js` | 构造音频文字步骤用的 Gemini 档位，不在这里发请求 | 保留：provider 叶子 |
| `generation/jobs/generation.js`、`generation/translation/jobs/translation.js` | `public-table-write …generationControllers.set` | Job 把取消控制器放进控制台控件读的表，直到控件改读内核 | S6-5 |
| `generation/jobs/library-queue.js` | `queues.set/delete`、`settled.set/delete` | 出题与翻译 Job 排队用的每库队列（S3-1 保留） | S6-5 |
| `generation/jobs/submit-generation.js` | `jobs.set`、`generationControllers.set`、`jobControls.set` | `startLegacy`：开关关闭时的原出题路径 | 默认值翻转之后 |
| `study/jobs/submit-assist.js` | `provider-import host-capabilities.js` | 只导入 `abortable`（停止辅助函数），本模块不发宿主请求 | 保留 |

测试固定这些规则：

- **新命中失败**，信息指到模块与 API；
- **多余的行也失败**（行里的命中已不存在就要删行）；
- **行必须精确**：模块是一个 `lib/…js` 文件而不是目录或模式，API 不含通配字符，次数是整数，有理由和 `removeAt`，同一（模块，规则，API）只能一行；合成一条 `lib/contexts/**/*.js` / `work.*.set` 的"放宽"行，检查它的谓词会拒绝；
- **定义文件本身几乎没有例外**：定义里只允许那两条 S6-0 的控制适配（`generationControllers.set`，都在 S6-5 去掉），模型、provider、队列、生命周期四条规则对定义**零例外**。

红灯证据（写完后各做一次）：在 `lib/contexts/notes/jobs/` 下放一个同时 `work.jobs.set(...)` 和 `worker.complete(...)` 的临时文件，测试红灯，两行诊断都指到该文件与 API；移除后通过。

## 3. 持久化的内核形状与回退夹具同进同退

`tests/fixtures/release-2.7.1/`（回退目标 2.7.1 自己的校验器，README 说"永远不要为了让失败变绿去改它"）原先只有**行为**检查（`unified-runtime-rollback-shape`：当前代码写出的每份 manifest 2.7.1 都读得出）。现在加一道**变更探测**：

- `tests/helpers/kernel-shape.mjs` 在 Job 的整个生命里（答复、结果未知、被拒、等待、检查点、已投递通知）收集 manifest 的**键路径**，去掉属于领域的自由字段；
- `tests/fixtures/release-2.7.1/shape-baseline.json` 记录这 146 条路径（含摘要，防手改）；
- 当前形状与基线不同就失败，信息是：*"The persisted shape of a Job manifest changed (added […], removed […]). Persisted shapes change only together with the rollback fixtures: check that release 2.7.1 still reads what is written (tests/unified-runtime-rollback-shape.test.mjs; the validators are tests/fixtures/release-2.7.1, see its README.md: never edit them…), then update tests/fixtures/release-2.7.1/shape-baseline.json in the same commit."*；
- 更新基线用 `node tests/fixtures/release-2.7.1/make-shape-baseline.mjs`，**只在**回退校验通过之后、同一个提交里做。

红灯证据：从基线里去掉 `job.checkpoint.digest`，测试红灯并打印上面这句、`added: ["job.checkpoint.digest"]`；还原后通过。限制：只覆盖内核的 manifest；归档文件、转换 manifest、安装状态的格式没有统一的校验器（S6-1 缺口 B），属 S6-6。

## 4. 内核向下的依赖（`architecture-boundaries` 新增）

`lib/jobs/**` 越出自己目录的导入**恰好是 10 个**共享基础设施模块（存储 `atomic-json`、许可池 `audio-pool`、宿主子代理辅助 `host-capabilities`、`job-output`、`model-effort`、`model-usage`、`reasoning-effort`、`runtime/work-ownership`、`token-usage`、`usage-scope`），不含任何上下文、领域流水线或界面。新增一个导入要改列表（是评审，不是通配）；列表里已不再被导入的也要删。另一条用合成例子说明"一个上下文的 Job 读另一个上下文的私有模块"会被现有的上下文导入边界点名，而对方的 `contracts.js` 与自己上下文放行。

## 5. 没做、与限制

- 不改运行时；不新增通配；`backend-boundaries`、`client-boundaries`、`lib-registries` 已通过且未改（它们管的是扩展任务、owner、客户端模块与注册表，与本步的 Job 模块边界互补）。
- 规则的盲区：只看调用与赋值的确切形状；经变量别名传递的模型函数、动态属性名、`Reflect`/`apply` 调用看不到（S6-0 缺口 10 同类）；对 `job.status = …` 这类写**视图/成员对象**的赋值不拦（太多合法用法），拦的是写合同。
- 例外的批准与移除规则：加行要精确、有理由、有 `removeAt`；`removeAt` 到了的步骤负责删行（行不再命中测试就会红）。
