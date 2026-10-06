# S5-3：Marker 一键安装接入

核验日期：2026-10-06。分支 `codex/runtime-s53-marker-install`，基线 origin/main `2573b58`。工作包文本见 [U30](sprints-2-6.md#u30-s5-3)；基线与缺陷编号沿用 [S5-0](s5-0-nonmodel-baseline.md)，契约裁决（`local-process`、非模型 Step、`retry:false` 表达 Settings-only）沿用 [S5-1](s5-1-nonmodel-contract.md)。

## 1. 做了什么

`marker.install.start` 与 `marker.install.cancel` 在开关 `runtime.pilot.markerInstall`（插件 `Config`，**默认关闭**）打开时走统一运行时：一次安装是一个 `marker-install` Job，进入共享任务表和任务控制台；`plan / status / uninstall` 以及安装的全部阶段（Python 查找、venv、pip、检测、写设置）、sentinel、目录所有权、`marker-install.json` 仍是 `lib/marker-install.js` 自己的，没有第二份实现。关闭时行为与 2.7.1 完全一致。开关只在一处读取：`lib/contexts/audio/install/marker-install-runs.js`。

| 文件 | 职责 |
|---|---|
| `lib/marker-install.js` | `start` 拆成 `prepare`（确认、无在途安装、计划，全部先于任何进程/文件）、`claim`（占 DSH_HOME 唯一的安装槽）、`begin`（阶段流水线，经 `observe` 接缝运行每段进程）。旧 `start` 就是这三步，行为不变 |
| `lib/contexts/audio/install/marker-install-job.js` | 任务定义：`admit`（再次要求 `confirm:true` 与目录归属，占槽）、`run`（`begin` + 等待结束）；`observeWithGateway` 把每段进程记成一条 `local-process` 观测 Call |
| `lib/contexts/audio/install/marker-install-view.js` | 展示读取器（标题、阶段、进度），读的是安装槽里的同一个活状态 |
| `lib/contexts/audio/install/marker-install-runs.js` | 开关的唯一读取点；`start` 提交 Job，`cancel` 走 Job 取消 |
| `lib/marker-install-text.js` | 任务的全部中文文案（英文在 `application-messages-en.js`） |
| `lib/local-command.js` | D-9 修复（见 §4），对所有本地命令生效 |
| `lib/contexts/audio/convert.js` | 一行：安装器经 `markerInstallerFor(ports, …)` 取得（开关关闭时原样返回安装器） |

## 2. 能力与授权边界

- **能力诚实**：`cancel` 是；`retry` 否；不可暂停；`recoveryMode: none`；`set` 否。控制台不显示假按钮；`job.control` 对已结束的安装 `retry/resume/pause` 分别以 `capability-unsupported / not-paused / job-ended` 拒绝，没有任何进程启动（测试）。
- **Settings-only 不变**：助手的 `study_workspace` 仍在 `lib/assistant-boundary.js`（#291）的表里、解析参数之前拒绝 `marker.install.start/uninstall`，不管 `confirm`。通用 submit 没有对助手开放的入口；通用 retry/resume 因上面的能力声明不能重新启动安装；再次安装只能是设置页一次新的、带 `confirm:true` 的 start。
- **confirm 与目录所有权**：`prepare` 在创建 Job 之前要求 `confirm === true` 并做计划检查（Python 版本、venv、磁盘、目录新建/空/带 sentinel），拒绝时没有 Job、没有文件、没有安装进程（只有计划本来就有的只读版本探测）；`admit` 在占槽前再检查一遍 `confirm` 与目录归属，作为纵深防御。sentinel 仍先于任何命令写入，卸载仍只删带 sentinel 的目录。
- **同 DSH_HOME 同时一个安装**：槽仍是模块级 `live`（按状态文件路径），Job 的 `admit` 同步占槽；第二个安装器对象或第二个库发起的 start/uninstall 一律 `busy`，且不创建 Job（测试）。
- **没有存活会话**（面板没有已登记 Agent）：`executor-unavailable` 映射为 `needs-session` 的中文提示，先于 Job 与进程；不回落旧路径（V-7 的宿主行为未验证）。

## 3. 副作用与观测

每段进程是一条 Step `install:<阶段>` 里的 `local-process` Call（`requestCount` null，不记 token，`usage.tokens` null，`execution.mode` null）：`find-python`、`create-venv`、`install`、`verify`。`create-venv` 与 `install` 改变安装目录，声明 `sideEffect: true`（`MARKER_INSTALL.mutatingStages`，一处）；探测与检测声明 `false`。非零退出码记为失败的 Call。安装无持久化（`recoveryMode: none`），所以 `sideEffect` 当前不产生意图记录——它声明的是"这一步不可盲目重复"，若将来给安装加恢复，内核会据此阻止盲重发；一处重试层不变（pip 自带 `--timeout 60`，插件无重试）。超时仍是各命令自己的 `timeoutMs`，Step 不再设第二个预算。

## 4. 缺陷与取消

| 编号 | 处置 |
|---|---|
| D-9 取消回执早于进程清理 | **修复**（`lib/local-command.js`）：被停止（abort 或超时）的命令在**进程树退出后**才 reject，最长等 `KILL_WAIT_MS`（10 s）以免调用方被杀不死的进程永远挂住。因此 Job 在清理完成后才结算为 `cancelled`，取消后立刻卸载不会撞上还在写文件的 pip。这对所有用 `runLocalCommand` 的路径生效（MinerU/Marker 转换、setup），是严格更好的行为；测试 `tests/local-command.test.mjs`（先红后绿，连跑 3 次） |
| D-8 安装不在任务表 | 修复（运行时路径） |
| D-10 / V-8 | `marker.settings.set` 等已由 #291 纳入 Settings-only；本步不再放宽 |
| 其余 | 保持：取消保留 StudyHub 创建的半成品与 sentinel，由用户在设置里卸载；无自动恢复，中断后显示"已中断" |

## 5. 保留或迁移

| 对象 | 去留 |
|---|---|
| 安装阶段、sentinel、目录所有权、`marker-install.json`、`live` 槽 | 保留，Job 经 `claim/begin` 直接使用 |
| 旧 `start`/`cancel` | 开关关闭时使用；S6 删除 |
| `plan/status/uninstall`、`marker.install.*` 动作与返回形状 | 不迁移（即时/本地操作），不变 |

回滚：关闭开关即回到旧路径，只影响新提交；无持久化格式变化。

## 6. 测试矩阵

- 新：`tests/unified-runtime-marker-install.test.mjs`（8 条）：Job 在共享列表、Call 与能力、各种拒绝先于任何 Job/进程、无会话拒绝、控制台不能重试/恢复/暂停、取消与卸载、控制台文案、英文文案、副作用声明。
- 开关两侧：`tests/marker-install-service.test.mjs` 读 `SWITCH_MODE`，孪生 `tests/marker-install-service.runtime.test.mjs`；`nonmodel-baseline-install`、`assistant-settings-boundary`、`marker-install` 在两侧不变地通过。
- `tests/local-command.test.mjs`（3 条）：D-9。

## 7. 未验证

- Windows 真机上 `taskkill /T /F` 的实际退出时机与文件句柄释放（V-4）：测试在本机 Windows 上通过，但没有在真实 pip 安装上验证。
- V-7：无 Agent 面板入口的宿主行为。
- 控制台 UI 无改动；用控制台自己的 `taskSummary/tasksOf/runningTaskCount` 读真实快照验证，未做浏览器截图。
