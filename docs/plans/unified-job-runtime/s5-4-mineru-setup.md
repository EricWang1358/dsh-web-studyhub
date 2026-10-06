# S5-4：MinerU 本地长配置与模型准备接入

核验日期：2026-10-06。分支 `codex/runtime-s54-mineru-setup`，基于 S5-3（#304）的分支，因为共用 D-9 修复与 `lib/contexts/audio/local-process-job.js`；#304 合并后本 PR 的 diff 只含 S5-4。工作包文本见 [U31](sprints-2-6.md#u31-s5-4)；基线与缺陷编号沿用 [S5-0](s5-0-nonmodel-baseline.md)，契约裁决沿用 [S5-1](s5-1-nonmodel-contract.md)，同类做法见 [S5-3](s5-3-marker-install.md)。

## 1. 做了什么

`mineru.local.setup / .status / .cancel` 在开关 `runtime.pilot.mineruSetup`（`lib/runtime-config.js`，**默认关闭**）打开时走统一运行时：一次准备是一个 `mineru-setup` Job，进入共享任务表与任务控制台；关闭时是原来的后台 run，行为不变。`mineru.local.status / start` 等即时操作不迁移。开关只在一处读取：`lib/contexts/audio/setup/mineru-setup-runs.js`。

| 文件 | 职责 |
|---|---|
| `lib/mineru-setup.js` | 步骤本身，从 `convert.js` 里原样搬出：`checkSetupRequest`（档位与确认，先于任何读取）、`prepareSetup`（只读地看这台电脑：没有 mineru、无法下载模型就拒绝）、`runSetup`（启动服务 → 下载模型 → 写档位 → 写模式 → 重启，每步经 `observe` 接缝运行） |
| `lib/mineru-setup-text.js` | 全部中文文案（英文在 `application-messages*.js`） |
| `lib/contexts/audio/setup/legacy-setup-run.js` | 原后台 run（`setups` Map），开关关闭时使用 |
| `lib/contexts/audio/setup/mineru-setup-job.js` | 任务定义：`admit`（再检查确认、档位、mineru 仍在）、`run`（`runSetup` + 观测） |
| `lib/contexts/audio/setup/mineru-setup-view.js` | 展示读取器与旧状态形状 |
| `lib/contexts/audio/setup/mineru-setup-runs.js` | 开关的唯一读取点；运行时路径的 start/status/cancel |
| `lib/contexts/audio/local-process-job.js` | 与 S5-3 共用：`observeLocalWith`（每步一个编号的 Step 与 `local-process` Call）、`ACTIVE_STATUSES` |
| `lib/contexts/audio/convert.js` | `mineru.local.setup*` 三个处理器各一行，约 55 行内联实现与 `setups/tidy/downloaderOf` 搬走 |

阈值与字面量收进一处：档位取自 `LOCAL.modelsMb` 的键（原为字面量 `['basic','standard']`）；各步超时（默认 60 s、启动 90 s、下载 90 分钟）、写入的设置键与值、最后一行/原因长度在 `MINERU_SETUP`。

## 2. 能力与授权边界

- **能力诚实**：`cancel` 是；`retry` 否；不可暂停；`recoveryMode: none`；`set` 否。`job.control` 对已结束的 setup `retry/resume/pause` 以 `capability-unsupported / not-paused / job-ended` 拒绝且不启动任何进程（测试）。
- **Settings-only 不变**：`mineru.local.setup` 仍在 `lib/assistant-boundary.js`（#291）的表里，助手在解析参数之前被拒；`.status` 不在表里（只读）。通用 submit 没有对助手开放的入口；再次准备只能是设置页一次新的、带 `confirm:true` 的 start。
- **confirm 与前置检查先于任何 Job/进程**：未确认、档位不存在、没有 mineru、无法下载 —— 全部在创建 Job 之前拒绝，未确认时连只读探测都不跑（测试断言 CLI 日志为空）；`admit` 在占用前再检查确认/档位/mineru。写设置的顺序（模型 → 档位 → 模式 → 重启）保留在 `runSetup`。
- **同库同时一个**：入口在同一 tick 内检查并提交；第二次 start 以原来的 `setup-busy` 拒绝且不创建 Job（测试）。（原来也是按库，不是按 mineru 全局；两个库同时准备会互相覆盖 mineru 的设置，这是既有限制，本步不扩大。）
- **没有存活会话**：`executor-unavailable` 映射为 `setup-needs-session` 中文提示，先于 Job 与进程，不回落旧路径。

## 3. 副作用与观测

每个子进程步骤与每次状态检测是一条 `local-process` Call（`start / detect / download / configure / configure / start / detect`，`requestCount` null，无 token）。会改动学习者 mineru 的 `download`、`configure` 声明 `sideEffect: true`（`MINERU_SETUP.mutatingSteps`，一处）：它们的顺序有意义，将来给 setup 加恢复时内核会据此阻止盲重放；服务启动/重启与检测声明 `false`。无持久化，所以 `sideEffect` 当前不产生意图记录。一处重试层不变（插件无重试）；超时仍是各命令自己的 `timeoutMs`。

## 4. 缺陷

| 编号 | 处置 |
|---|---|
| D-8 setup 不在任务表 | 修复（运行时路径） |
| D-9 取消回执早于清理 | 已由 S5-3 的 `runLocalCommand` 修复覆盖：取消后 Job 在下载进程退出后才结算为 `cancelled`（测试：取消后没有写过任何配置） |
| D-9 的后果（给 S5-2） | `convert.js` 的取消分支先把 Job 标为 `cancelled`、再 `await discardJob(...)` 删临时目录；D-9 之后取消在进程退出后才结算，旧测试里"等进程消失"那段隐含的延迟没有了，于是"状态已 cancelled 但目录还没删完"这个既有的小竞态暴露出来（约 1/10）。本分支只把 `mineru-local-service` 的断言改成等待清理完成；PDF 转换迁移（S5-2）时应让终态在清理之后发布，与 D-9 的原则一致 |
| V-6 `mineru.local.start` 同步阻塞 | **未改**：它是即时操作（读取类，保持原接口）；是否应改为后台任务是产品决策 |
| D-10 | `mineru.local.setup` 已由 #291 纳入 Settings-only |

## 5. 保留或迁移

| 对象 | 去留 |
|---|---|
| 步骤顺序、确认、tier 校验、"模型已就绪则跳过下载"、失败不改任何设置 | 保留（`lib/mineru-setup.js`，两条路径共用一份） |
| `setups` Map 与 `publicSetup` | 搬到 `legacy-setup-run.js`，开关关闭时使用；S6 删除 |
| `mineru.local.status/start`、`mineru.settings.*` | 不迁移 |

回滚：关闭开关即回到旧路径，只影响新提交；无持久化格式变化。

## 6. 测试矩阵

- 新：`tests/unified-runtime-mineru-setup.test.mjs`（9 条，登记 slow/cli）：Job 在共享列表与 Call 序列、各种拒绝先于任何 Job/进程、无会话、同库单一、失败与控制被拒、取消后未写配置、控制台文案、副作用声明、边界与英文。
- 开关两侧：`tests/mineru-local-service.test.mjs` 读 `SWITCH_MODE`，孪生 `tests/mineru-local-service.runtime.test.mjs`（该文件的全部 13 条，含转换用例，在开关打开时也通过）；`assistant-settings-boundary`、`mineru-local`、`mineru-messages` 不变。

## 7. 未验证

- 真实 mineru 的服务启停、`mineru-models-download` 与 `config set`：全部用 fake CLI（`tests/helpers/fake-mineru-cli.mjs`），没有碰 `~/.mineru` 或联网下载；V-3（杀掉客户端后本地服务是否继续）与 Windows 进程树退出时机（V-4）保持待核验。
- V-7：无 Agent 面板入口的宿主行为。
- 控制台 UI 无改动；用控制台自己的 `taskSummary/tasksOf/runningTaskCount` 读真实快照验证，未做浏览器截图。
