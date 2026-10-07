# S2–S6 架构约定（迁移方式）

> 2026-10-06 所有者要求：注意 pattern 与架构，不硬编码、不写大文件、分层、解耦，降低后续修 bug 与测试的时间和 token 成本；所有任务在任务控制台可观测、可配置。本页把这些要求落成每个 S 步骤都要遵守的写法。它不改变 [plan.md](plan.md) 的范围与开关约束，只规定“怎么写”。

## 1. 分层与依赖方向

```text
contract (lib/jobs/contract*.js)      公共契约形状与不变量
  ↑
kernel   (lib/jobs/**)                 生命周期、调度许可、网关、存储/恢复、限额
  ↑
family   (lib/contexts/<family>/jobs/) 任务定义 + 业务执行器 + 展示映射
  ↑
surface  (operations / tools / ui)     入口、权限、开关读取、控制台详情组件
```

- 依赖只能指向内层。`lib/jobs/**` 不得 import `lib/contexts/**` 或 `ui/**`（由 `tests/unified-runtime-layout.test.mjs` 检查）。
- 内核里没有任何按 kind 的分支；家族差异只能通过定义的 `capabilities`、`admit`、`run`、`persistence`、`present` 表达。
- 控制台只读公共契约。迁移后的家族不得在 `lib/job-contract.js` 或 `ui/tasks/*` 新增 `type === '<kind>'` 分支；需要专有详情时注册详情组件（见第 4 节）。

## 2. 文件大小与模块形态

- 内核与新家族目录：单文件 ≤ 200 行、单行 ≤ 181 字符；超出就拆，不放宽上限。新增目录在迁移时加入布局护栏 `RULES`。
- 一个任务 kind 一个定义文件：`lib/contexts/<family>/jobs/<kind>.js`，只组装 `admit` / `run` / `persistence` / `present`，业务步骤调用既有领域函数，不在定义里重写流水线。
- 共享状态通过参数传递；不要靠向共享 `binding` 对象随手挂字段来传递执行中状态（S1 试点的写法在 S2-1 收敛为显式的 attempt 本地状态）。
- 内核内部使用 `ops(k)` 组装模式：每个关注点一个模块，导出 `xxxOps(k)`，在 `lib/jobs/lifecycle.js` 统一装配到同一份内核状态。

## 3. 配置：不硬编码

| 类别 | 放在哪里 | 规则 |
|---|---|---|
| 迁移开关 | 插件 `Config` 的 `runtime.<family>`（`lib/index.js`，schemastery） | 默认关闭，只影响新提交；在途 Attempt 固定策略快照 |
| 独立策略开关（恢复、解除串行、子代理优先、配额收敛） | 同上，与迁移开关分开 | 每个开关独立默认值、验收、回退说明 |
| 家族可调参数（并发、窗口、批量、超时、重试次数） | 家族设置模块（如 `lib/audio-settings.js`）的默认值表 | 执行器只读设置，不写字面量；用户可调的进入设置界面 |
| 内核契约边界 | `lib/jobs/limits.js` | 是契约上限而非调参旋钮，改动视同契约变更 |

迁移某条路径时，顺手把该路径上的魔法数字移入对应设置/限额表，并在 PR 去留表里列出。

## 4. 可观测：每个任务都进控制台

- 定义必须提供展示：标题、`stage.code`（结构化，文案走 locales/application messages）、`progress`（`total` 可空）、领域事件；观测不到的数据留空，不补零。
- 所有模型调用经网关 `context.gateway.step()`，所以调用时间线、用量、执行方式自动进入控制台；非模型外部操作用 `gateway.observe({ boundary })` 记录。
- 控制动作只来自 `capabilities` + 当前状态，控制台不显示假按钮。
- 专有详情（如音频分段、字幕条目）通过前端详情注册表按 kind 映射组件；注册表是唯一允许出现 kind 的地方，控制台主体不分支。
- 用户可见文本：内核不含中文/英文提示文案（布局护栏检查）；家族展示用 `stage.code + args`，文案在 locales。迁移期为旧读取者生成的 legacy 字段可以保留原文案。

## 4.1 内核给定义的接口（S2-1a 起）

- `context.persistence`：定义自己 `persistence.open` 返回的端口；admit/run 直接用，不挂在 bindings 上。
- `initialPresentation(input, bindings)`（可选）：返回一个 reader，submit 返回前装上，记录一进任务表就是完整的（第二次启动、列表、状态在同一轮就能找到它）；admit 里的 `context.present` 随后接管。不要用轮询或旁表等第一轮。
- `context.admission.state`：admit 返回的 lease 里放本次 attempt 的状态（视图、设置、流水线缓存等），run 读取。
- `gateway.observe({ boundary, sideEffect })`：观察到结束即已知结果；只有 `sideEffect: true`（重复执行不安全的远端操作）在失败或结果未知时保持 pending，阻止盲目重发。`sideEffect: false` 的请求不写请求意图（进程死在它中间也没有要核对的东西，恢复后直接再问）。
- 落盘形状的回退约束：清单（manifest）与契约写到磁盘的形状必须仍能被上一个发布（目前是 v2.7.1）自己的校验器读入，否则关掉开关回退后整个快照会失败。`tests/unified-runtime-rollback-shape.test.mjs` 用 `tests/fixtures/release-2.7.1/` 里原样拷贝的校验器检查；要加新的落盘字段，先改回退目标或放进旧版本本来就开放的位置，不要改那份拷贝。
- 宿主模型：网关调用的是 `preparedModelHost(services)`——与其他模型调用同一套准备（界面语言、图片/脚注清理、阶段本地化），不记账（网关入账）。家族不要绕开 `gateway.step().complete()` 自己包模型函数。
- 轻量通道：`gateway.step(key, policy, { model: 'light' })` 走宿主轻量路线（对冲 + 一次瞬时重试），只用于 `direct`。
- 结算通知：有持久化的定义在 persistence 端口上声明 `notifications`；没有持久化的定义在定义上声明 `notifications: [{ channel, deliver(event, view, bindings) }]`（bindings 是提交时给的，即提交者自己的服务），结算后进程内投递一次、观察者等投递完成；失败记在 `detail.notificationError`，不改变终态。
- 学习者可见的拒绝：内核抛结构化 code，家族在入口处映射成文案（如 `audioRefusal`），不在内核里写文案。

## 5. 测试成本

- 开关两侧：特征测试文件读 `SWITCH_MODE`（`tests/helpers/runtime-switch.mjs`），再加一行的孪生文件 `<suite>.runtime.test.mjs` 以运行时模式重跑同一套测试；机制不同的断言按模式分支并写明原因，不复制测试。
- 每个定义配一份窄测试：用内核 + 假宿主执行器 + 假模型直接驱动定义，不启动整个服务；共用 `tests/fixtures/unified-runtime-contract.mjs` 等现有夹具，缺的夹具加到同一处。
- 改动一个模块只需重跑它的窄测试和布局/架构护栏；全量 `npm run verify` 只在 PR 收尾与阶段集成时各跑一次。
- 特征测试先在旧实现上通过，再迁移；新能力先有红灯记录。

## 6. 每个 S 步骤的交付清单

1. 分支 `codex/runtime-s<阶段><步骤>-<主题>`，从最新 `origin/main` 分出。
2. 先特征测试/红灯，再实现；PR 描述含 DSH 能力表行、开关与默认值、去留表、[审查清单](review-checklist.md) 17 项证据。
3. 布局与架构护栏全绿；不新增未登记旁路（[例外清单](s1-7-legacy-exceptions.json)）。
4. 进度写入 `s2-progress.md`（后续阶段对应 `s3-progress.md` …）。
