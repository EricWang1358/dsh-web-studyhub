# S6-5（音频与 PDF 一侧）：任务控制台回归矩阵

核验日期：2026-10-07。分支 `codex/runtime-s65-audio-console`，基于 main（含 #337 的任务名问题修复）。本文是 S6-5 里"音频卡片在任务控制台里，在每一种开关组合下"的部分；PDF 转换并入同一份矩阵，因为它与音频家族共用转写闸门和任务控制台的同一批操作。全部使用 fake：假的转写服务、假的宿主模型、环回端口上的假 MinerU，不碰网络、密钥或用户的库。

## 1. 方法

- 测试：`tests/unified-runtime-audio-console.test.mjs`（音频，14 条，其中 6 条是矩阵、1 条按 id 形状、1 条核对"已知发现"清单、6 条是下面各个发现的单条测试）与 `tests/unified-runtime-pdf-console.test.mjs`（PDF，6 条）。公共部分在 `tests/helpers/audio-console.mjs`、`pdf-console.mjs`、`console-card.mjs`。
- **只经公共操作**：`snapshot`、`job.status`、`job.wait`、`job.control`（cancel / pause / resume / retry / set）、`job.output`、`job.message`、`job.cancel`、`job.dismiss`、`job.archive` / `job.unarchive`、`job.delete`。卡片用任务控制台自己的纯代码读（`ui/tasks/*`：`task-model`、`task-facts`、`task-summary`、`task-control`、`call-model`、`task-actions`，不渲染 DOM）。
- **开关组合**：每一种任务，各自开关 **关**（原路径）、**开**（运行时）、**混**（同一个服务里一个原路径任务加一个运行时任务，翻开关发生在两次提交之间）。每种任务有三个观察点：运行中、停止后、完成后（完成后再走归档 → 取回 → 删除）。
- **任务种类**：单文件 `audio-import`、批次 `audio-batch`、字幕 `audio-subtitles`、复查 `audio-review`、课堂保存 `audio-live-save`、课堂校正 `audio-live-correction`（原路径没有这张卡，D-12）、PDF 转换 `pdf-convert`（云端路线）。

## 2. 每张卡片断言了什么

| 断言 | 内容 |
|---|---|
| 控制台读的字段都在 | `contract` 有 `jobId`、`kind`、`title`、`status`、`stage`、`progress`、`actions`、`result`、`usage`、`execution`、`detail`、`startedAt`、`calls`、`events`；`taskKindOf`（音频卡必须是 `audio`，PDF 必须是 `pdf`）、`taskTitle`、`stateLabel(taskState)`、`taskLine`、`taskFacts`（四个事实，各有标签与值）、`taskSegments`、`usageLine`、`headerActions`（全是布尔）、`controlItems`（每项有键/中文标签/类型/值）、`timelineModel`、`logLines` 都能画 |
| 只提供它声明的操作 | 运行时卡片：`cancel` 当且仅当运行中且声明了 `cancel`；声明"不支持暂停"的没有暂停；没有设置的没有设置；没有重试的没有重试；运行中不出现重试；结束后什么都不提供 |
| 拒绝用大白话 | 每个不可用的动作：`reasonText` 是中文句子，不是裸的代码；直接调 `job.control` 被拒时，错误信息同样是中文句子，且不含内部错误文字 |
| 输出与步骤可读 | 第一个调用的 `job.output` 回 `supported/live/text/nextCursor`；`timelineModel`、`logLines` 能读 |
| 同一任务两个名字 | 卡片 id 与 `contract.jobId`：`job.status`、`job.wait`、`job.control`、`job.cancel` 都能用（原路径的例外见 §5） |
| 结束后 | 完成/取消的卡片不提供任何动作；停止已结束的任务按卡片说的拒绝；`打开结果` 对产出资料的任务指向「打开资料」；运行时任务的卡片上有宿主模型的 token；归档记录是只读的、取回后仍是同一种卡片、删除后消失 |

## 3. 各种任务的卡片（运行时一侧）

| 种类 | `kind` | 取消 | 暂停 | 设置 | 重试 | 恢复方式 |
|---|---|---|---|---|---|---|
| 单文件 | `audio-import` | 有 | 在检查点 | 有 | 有 | 从检查点继续 |
| 批次 | `audio-batch` | 有 | 在检查点 | 有（控制就绪后才提供） | 有 | 从检查点继续 |
| 字幕 | `audio-subtitles` | 有 | 不支持 | 无 | 有（进程内） | 无 |
| 复查 | `audio-review` | 有 | 不支持 | 无 | 有（进程内） | 无 |
| 课堂保存 | `audio-live-save` | 有 | 不支持 | 无 | 有（进程内） | 无 |
| 课堂校正 | `audio-live-correction` | 有 | 不支持 | 无 | 无 | 无 |
| PDF 转换 | `pdf-convert` | 有 | 不支持 | 无 | 有 | 无 |

原路径一侧：单文件与批次提供暂停与设置；字幕、复查、课堂保存的暂停/设置显示"任务还没有开始"（`no-control-yet`，这几种任务在原路径上没有控制）；重试在运行中显示"任务还在进行"。原路径没有课堂校正的卡片。

## 4. 发现与修复（每条一个先红的测试）

首次运行矩阵发现了以下问题；按协调者的决定，在本 PR 里修，每条一条先红后绿的测试（`tests/unified-runtime-audio-console.test.mjs` 末尾，及矩阵里的硬断言）。

| # | 发现 | 红灯（修复前） | 修复 | 位置 |
|---|---|---|---|---|
| 1 | 课堂校正的卡片在控制台里被当成 `extension`（"后台任务"），因为 `audio-live-correction` 不在音频家族登记里（S2-5b 的遗漏）；音频页也不列它 | `correction (audio-live-correction) is an audio job: false !== true` | `lib/job-status.js` 的 `JOB_TYPES` 与 `AUDIO_JOB_TYPES` 各加一行 | 音频页现在也会列出课堂校正的卡片（与课堂保存一致） |
| 2 | 给音频任务发 `job.message`，回的是内部错误文字 `Cannot read properties of undefined (reading 'length')`（原路径与运行时都一样） | `refused in words: "Cannot read properties of undefined (reading 'length')"`（off 与 on 各一条） | `job.message` 先判断任务是否接收补充说明，否则用 `audio-messages` 的 `AUDIO_TEXT.noMessages`（音频）或一句通用的话回复；英文模板已加 | `lib/contexts/jobs/operations.js` |
| 3 | 对**运行中**的运行时任务点重试，被拒的原因说"已经完成，或没有可接着做的进度"——任务还在跑 | 卡片上的原因码是 `not-retryable`，期望 `not-ended` | 内核的动作视图：任务没结束用 `not-ended`（原路径本来就是），结束了且不能重试才用 `not-retryable`；`audioRefusal` 也认 `not-ended`（"任务还在进行，请等它结束"） | `lib/jobs/lifecycle/view.js`、`lib/audio-messages.js` |
| 4 | 首次运行里，批次的 `set` 卡片说"现在不可用"，而 `job.control set` 被接受了 | **没有红灯**：在未改动的代码上，"卡片与 job.control 逐刻一致"的测试（启动后 40 次，每次前后各读一次卡片）是绿的；首次运行的差异是我的测试在批次的控制就绪之前读了卡片。契约本来就是唯一的真相：`job.control` 每次先刷新再判断 | 不需要改代码；保留这条测试防止回退 | — |
| 5 | 对**已结束**的运行时任务 `job.control cancel`，回答"已停止"，而卡片写着"取消不可用（`job-ended`）" | 回了一个成功的回复（"not answered as done"） | 内核 `control`：已结束的任务停止时拒绝，原因码 `job-ended`，与卡片一致 | `lib/jobs/lifecycle/scoped.js` |
| 6 | 按 `contract.jobId` 叫任务：运行时任务的 `job.status`/`job.wait`/`job.control`/`job.cancel` 都认；见 §5 的原路径例外 | `job.cancel` 一度不认运行时任务的 `contract.jobId`，#337 已修（本 PR 的 `job.cancel` 断言转绿） | #337 | — |

## 5. 已知限制与剩余缺口

- ~~原路径音频任务按 `contract.jobId` 叫 `job.status` / `job.wait` 找不到~~：已由 #358 修好（两者经 `jobs/operations.js` 的 `resolve` 认卡片 id、`singleId`、`batchId`、`contract.jobId` 与归档别名）。矩阵现在对开关关闭的每一种卡片都断言两个 id 都认。
- **课堂校正对一个沉默的模型 20 秒就放弃一轮**（`RollingCorrection` 的 `requestMs`，按设计：一个卡住的请求不能拖住整堂课的校正；那一轮会在下一个周期重来）。矩阵里据此先看校正的卡片，再看别的。
- 音频页 `AudioJobs` 现在也会列课堂校正的卡片（修复 1 的后果）。
- 没有覆盖：PDF 的本地路线（`mineru-local-service`、`marker-service` 自己的孪生测试覆盖）、真实宿主与真实浏览器里 React 组件的渲染（这里读的是控制台的纯代码，不渲染 DOM）、重启后的卡片（S2-7、S2-7b 与恢复测试覆盖）。
