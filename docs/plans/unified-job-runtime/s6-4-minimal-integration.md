# S6-4：新增一种任务的最小接入证明

核验日期：2026-10-07。分支 `codex/runtime-s64-new-kind`，基于 main。工作包文本见 [U39](sprints-2-6.md#u39-s6-4)；前序：[S6-3 边界护栏](s6-3-boundaries.md)。

**结论**：一种新的普通任务只需要**一个定义**（含它的 `run`）、**一处提交**，可选再加**详情字段、展示读取器、输出桥**；不需要改内核（`lib/jobs/**`）的任何 kind/type 分支，也不需要改任务控制台（`ui/tasks/**`）。这里用一个合成的任务类型证明，并用真实的 S4-10 作旁证。

## 1. 合成证明（`tests/unified-runtime-new-kind.test.mjs`，9 条）

合成类型 `widget-sync`（什么也不做）通过**两个已发布的注册口**接入真实的 `StudyService`：`runtime.register({ id, operations })`（提交者的上下文）和 `runtime.registerJob(scope, 'widgets.v1', definition)`（定义），然后**只**经通用路径驱动：`job.*` 门、`snapshot`、任务控制台自己的读取代码（`ui/tasks/task-model.js`、`task-summary.js`）。

| 要求 | 测试 | 结果 |
|---|---|---|
| submit / list / status / wait | 一个同步完成：`job.wait` 完成；`job.status` 列表按领域给的名字（`legacyId`）列出；合同 `kind`、标题、结果引用、一条由网关观察的 Call；领域详情（`legacyFields`）在记录上 | 成立 |
| 控制台 | `tasksOf` 找到它，`taskKindOf` 为 `extension`（没有专门分支，按通用任务显示），`taskSummary` 给出标题、状态、可读的一行，没有 `undefined/NaN` | 成立 |
| 成功、失败、partial | 三种结果各自由合同如实呈现：`complete/complete`、`failed` 带原因且可重试、`complete/partial`；控制台状态 `done/fail/partial`（partial 是自己的状态，不当失败） | 成立 |
| 排队、运行、取消 | 领域自己的闸门让第二个排队；排队中取消从不运行；运行中取消先 `cancelling` 再 `cancelled`，领域闸门被归还；`runningTaskCount` 计两个 | 成立 |
| 未知总数 | `progress.total === null`、`percent === null`、单位 `widgets`；不编造百分比 | 成立 |
| retry | 通用 `job.control retry`：同一个 Job、第二个 Attempt；领域的授权在**每个** Attempt 的 `admit` 里再问一遍 | 成立 |
| 领域拒绝的提交 | 授权被收回后提交/重试都以 `failed` 带原因结束，**没有运行、没有模型请求、没有 Call** | 成立 |
| 输出 | `job.output` 从 cursor 读；只返回 cursor 之后的；写得比控制台保留的多时只保留尾部并说 `partial`（写入字符数更大） | 成立 |
| 迟到的停止 | 工作不看信号：先 `cancelling`，期间重试被拒；工作最终放手后结果被丢弃（`refs: []`）、一个 `settled` 事件、一个 Attempt；终态之后再取消无害、不产生第二次结束 | 成立 |
| owner 隔离与卸载 | 别的 owner 看不到、列表里没有、控制报"找不到"；卸载后运行中的任务以取消收尾，领域闸门被归还，没有残留的运行中任务 | 成立 |
| 没有人知道它的名字 | 扫描 `lib/jobs`、`ui/tasks`、`lib/runtime`、`lib/contexts/jobs`：没有任何文件出现 `widget-sync`/`widgets.v1` | 成立 |

**重复终态、旧 attempt 迟到、owner/domain 隔离、卸载收尾**复用既有实现：没有专用的计量层或通知层（合成定义没有 `notifications`，也不需要）。**任务声明不能覆盖业务授权**：授权是领域在 `admit` 里问的，内核每个 Attempt 都调用它——真实的 Marker 安装就是这样：未授权的安装在任何进程启动前被 `admit` 拒绝（`unified-runtime-marker-install.test.mjs`、S5-3）。

## 2. 真实证据：S4-10（`note.generate`，#333）

S4-10 在这之前就是"新增一种任务"的真实一次：`lib/jobs/**` 与 `ui/**` **零改动**（`git diff --stat` 对这两个目录为空）。改动全部在笔记家族和一行登记：

| 文件 | 行数 | 是什么 |
|---|---|---|
| `lib/contexts/notes/jobs/note-generate.js` | 34 | 定义（含 `run`、`initialPresentation`） |
| `lib/contexts/notes/jobs/note-generate-view.js` | 20 | 展示读取器（可选） |
| `lib/contexts/notes/jobs/submit-note-generate.js` | 27 | 提交与开关（领域自己的入口） |
| `lib/contexts/notes/note-generation.js` | 38 | 领域本体（两种执行方式共用，从原 `note.generate` 抽出） |
| `lib/contexts/notes/jobs/messages.js`、`lib/application-messages-en.js` | 11 + 4 | 文案 |
| `lib/contexts/notes/operations.js` | −41 + 薄层 | `note.generate` 变薄 |
| `lib/runtime-config.js`、`lib/runtime/builtins.js` | 1 + 3 | 开关一行；定义登记一处 |

## 3. 未来开发者的最小接入说明

要让一种新的后台工作成为统一运行时的任务，按下面五步，**不改内核、不改控制台**：

1. **写定义**（一个文件，放在你的上下文的 `jobs/` 目录）：
   ```js
   export const myDefinition = {
     kind: 'my-kind', version: 1, title: '任务标题',        // 标题文案放 messages.js，不要把中文写进代码文件
     capabilities: { cancel: true, retry: true, set: false, pauseMode: 'unsupported', recoveryMode: 'none', executionModes: ['direct'] },
     legacyFields: ['myDetail'],                               // 可选：放在记录上、`job.status` 能读到的领域字段
     legacyId: input => `my-${input.name}`,                    // 可选：任务在列表里的名字（重试不变）
     async admit(context, input) { /* 可选：领域的授权/占位/排队；每个 Attempt 都会再问一遍 */ return { finish() {}, state: {} }; },
     async run(context, input) {
       const answer = await context.gateway.step('my:1', policy).complete(system, prompt); // 模型只经网关
       context.progress({ done: 1, unit: 'items' });                                          // 总数不知道就不写 total
       return { refs: [{ kind: 'thing', id }], completeness: 'complete' };                    // 或 'partial'
     },
   };
   ```
2. **登记定义**：在 `lib/runtime/builtins.js` 的 `managedDefinitions` 对应上下文那一行加一个定义（一行），并在 `lib/runtime-config.js` 的 `MIGRATION_SWITCHES` 加一个默认关闭的开关。
3. **提交**：你的操作里 `context.jobs.submit('my-kind', input, options, bindings)`；用开关决定走新路径还是原路径（读开关的**只有一处**，写在 `submit-*.js`）。
4. **可选**：展示读取器（`context.present(reader)` 或定义上的 `initialPresentation`，让记录在 `submit` 返回时就完整）、输出桥（`gateway.step(key, policy, { output })`，把流式文字交给控制台的 `job.output`）、`notifications`（结算后进程内投递一次）、`persistence`（要跨重启恢复时才加，并且形状要和 `tests/fixtures/release-2.7.1` 一起变，见 S6-3）。
5. **测试**：给原特征测试加孪生文件（`<suite>.runtime.test.mjs`），先写红灯；`tests/unified-runtime-new-kind.test.mjs` 就是一份能照抄的最小例子。

护栏会替你检查：Job 模块里直接问模型、导入 provider、写公共任务表、自己分配队列或写合同都会被 `tests/unified-runtime-boundaries.test.mjs` 点名拒绝（S6-3）；新增的启动点要登记到 `s1-7-legacy-exceptions.json`（S6-0）。

## 4. 没做

不为测试增加任何真实业务功能；合成类型只存在于测试里。不做持久化/恢复的合成证明（那由 S1-5 与各家族的恢复矩阵覆盖，且需要和回退夹具一起变）。
