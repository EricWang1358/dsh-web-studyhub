# S5-2：PDF 云端与本地转换接入

核验日期：2026-10-07。分支 `codex/runtime-s52-pdf-convert`，基于 S5-4（#306）的分支与 origin/main。工作包文本见 [U29](sprints-2-6.md#u29-s5-2)；基线与缺陷编号沿用 [S5-0](s5-0-nonmodel-baseline.md)，契约裁决沿用 [S5-1](s5-1-nonmodel-contract.md)，同类做法见 [S5-3](s5-3-marker-install.md)、[S5-4](s5-4-mineru-setup.md)。

## 1. 做了什么

`mineru.import`、`marker.import`、`mineru.retry` 启动的转换，在开关 `runtime.pilot.pdfConvert`（`lib/runtime-config.js`，**默认关闭**）打开时是统一运行时的一个 `pdf-convert` Job：进入共享任务表与任务控制台（控制台本来就认识这个 kind），带阶段、进度、分段与每次对外调用的观测。**保留**：切分 → 上传 → 解析 → 下载 → 合并 → 保存、云端 batchId、已完成分段、本地页窗与自适应切分、导入语义、转换历史与信箱信件——这些都是同一份代码（`lib/mineru-job.js` 的 `convertPdf`、`lib/contexts/audio/pdf/convert-run.js` 的一次转换尝试）。开关关闭时与 2.7.1 一致。开关只在一处读取：`convert.js` 的 `startConvertJob`。

| 文件 | 职责 |
|---|---|
| `lib/contexts/audio/pdf/convert-run.js` | **新旧两条路径共用的一次转换尝试**（从 `convert.js` 原样搬出）：转换、导入、清理、写历史；`outcome` 为 complete/cancelled/failed。取消的顺序修在这里（§4） |
| `lib/contexts/audio/convert-support.js`、`convert-card.js` | 两条路径共用的小件：工作卡片、阶段文字、历史行开头、结束时的信件与通知、撤回失败信 |
| `lib/contexts/audio/pdf/pdf-convert-job.js` | 任务定义：`admit`（读 manifest、开历史行、同库一次一个的闸门）、`run`（一次转换 + 观测 + 结束信件） |
| `lib/contexts/audio/pdf/pdf-convert-view.js` | 展示读取器：把运行时观测到的生命周期叠在工作卡片上，复用既有的 `jobContract` 投影（控制台的 `pdf.*` 阶段词不变） |
| `lib/contexts/audio/pdf/observed-mineru.js` | 观测包装：云端 create/upload/download 为 `external-request` Call，本地每个窗口为 `local-process` Call |
| `lib/contexts/audio/pdf/submit-pdf-convert.js`、`retry-pdf-convert.js` | 启动回执；`mineru.retry` 对 Job 走 Job 自己的 retry |
| `lib/mineru-job.js` | 只加 `verifyCreates` 选项与三条文案（D-1/D-2，§3）；默认关，原路径不变 |
| `lib/contexts/audio/local-process-job.js` | 与 S5-3/S5-4 共用：观测适配器加 `boundary` 选项、`holdSlot` 闸门租约 |
| 内核 `legacyId`（独立 `kernel:` 提交） | 见 §2 |

`convert.js` 从 495 行减到约 330 行。

## 2. Job 的列表 id = 转换自己的 id（内核增量一处）

转换的任务文件夹、历史行、信箱信、`mineru.retry` 的回执、面板上"历史行 ↔ 实时卡片"的对应，都用同一个 id（manifest id），旧测试明确断言"the record is the job: one id"。内核原先给每个 Job（和每次重试）一个新的随机列表 id，这会破坏上面所有对应关系。最小的增量：定义可带 `legacyId(input)`，Job 的列表 id 就是它，重试时保持不变；不带的定义不变（每个 Job、每次重试一个新 id）。先写红灯测试（`tests/unified-runtime-legacy-id.test.mjs`），名字不合规则（不匹配 `[\w.-]{1,128}`）在创建任何 Job 之前拒绝 `invalid-legacy-id`；`docs/job-contract.md` 补了一节。改动 `job-record.js`、`control.js`、`scoped.js`、`registry.js` 各数行，文件均远小于 200 行。

## 3. 创建结果未知与已存 batch（D-1、D-2）

MinerU 只能按 **batch id** 查询，不能按 `data_id` 查；所以丢了创建回复就没有任何办法核对。契约（plan §四）：副作用请求只在幂等键或可核对时自动重发，不能核对就不自动重发并说明原因。落实（只在 Job 路径，`convertPdf({ verifyCreates: true })`）：

| 情形 | 行为 |
|---|---|
| 创建回复没收到（网络类错误） | **不自动重发**：该段以 `create-unknown`（可「接着做」）停止，原因写明；创建意图（`creating`，带 dataId）在请求**之前**已写进 manifest。学习者点「接着做」＝同意重新创建，且完成后给出提示"MinerU 那边可能留下一个没用的空批次"。MinerU 明确回应了的失败（429/5xx）仍由 `guarded` 自动重试 |
| 已创建未上传（`requested`，带 batchId）时重启/重试（D-2） | 先**按已存 batchId 查询**：字节已到（状态非 waiting）→ 不再创建、不再上传，直接轮询；没到、或 MinerU 说不认识这个 batch → 只创建一次新的；**查不到状态**（网络/5xx）→ 以 `create-unverified` 停止，不创建也不上传，保留引用 |
| 上传的预签名地址 | 不落盘，所以"字节没上去"只能新创建（旧批次是空的，推测不占额度——V-1 未验证） |

每次尝试仍是单独一条 Call（一处重试层不变，`guarded`）。创建与上传声明 `sideEffect: true`；下载与核对为 false。轮询（每几秒一次，可达数小时）**不记 Call**，避免成千上万条相同的只读 Call 撑大契约，进度由阶段与进度条显示。

## 4. 终态在清理之后（来自 D-9 的后果）

转换被取消时，Job/任务卡片原来**先**被标成 `cancelled`、**后**删除任务文件夹：S5-3 的 D-9 修复让取消在进程退出之后才结算，这个顺序里的缝就暴露了（`mineru-local-service` 取消测试约 1/10 偶发）。现在 `runConversion` 在 cancel 分支里**先**处理文件夹、**再**把卡片标为 `cancelled`、再写历史；Job 路径里 `run` 在这之后才返回，所以第一次被读到的结束状态下磁盘上已经没有残留。这是对**原路径**也生效的小改动（同一份 `runConversion`），不在开关后。测试两条路径各一条（`unified-runtime-pdf-convert`）。

## 5. 能力、并发与边界

- **能力诚实**：`cancel` 是；`retry` 是（再次进入 `admit`，重读 manifest，只做没做完的）；不可暂停；`recoveryMode: none`。**已知残余**：内核对 `cancelled` 状态也给出 retry，但取消会删任务文件夹（保留已解析结果缓存），此时重试会得到原有提示"临时文件已被清理…请重新导入这份 PDF（已解析好的段落会被复用）"，不会重复解析。
- **一次一个**：同库同时一个转换，云端与本地互相排队——与原路径相同（D-11 保持，拆开是单独的策略开关）。闸门是准入租约（`holdSlot`），排队时可取消并从等待线中移除，第一个继续（测试）；原路径与 Job 路径各用自己的闸门，同一次进程启动内开关不变，因此不会混跑。
- **令牌与隐私确认**：`mineru.import` 在创建 Job 之前照旧检查令牌与"已确认上传到 MinerU"，拒绝时没有 Job、没有上传（`mineru-service` 测试两侧通过）。
- **没有存活会话**：`executor-unavailable` 映射为 `convert-needs-session` 的中文提示，先于 Job；准备好的任务文件夹与上传被清理/保留（测试：无 Job、无文件夹、无任何 MinerU 请求）。
- **重启**：Job 不持久化（`recoveryMode: none`）；重启后仍由原来的 `recoverConvertJobs` 把 manifest 恢复成"已中断，可接着做"的记录，「接着做」（`mineru.retry`）此时开一个新的 Job，从 manifest 继续。持久化 Job 与"产物导入后终态保存失败"的核对属于 S5-6。
- **结束信件与会话通知**在尝试内写入（`announceEnd`，与原路径同一份），取消不发；信件失败只在卡片上留一条警告。

## 6. 保留或迁移

| 对象 | 去留 |
|---|---|
| 切分/上传/解析/下载/合并/保存、manifest、`results/` 缓存、页窗与自适应切分 | 保留（`convertPdf` 未改行为） |
| 转换历史（`mineru-history`）、信箱信、`mineru.upload.*` | 保留为业务账本/登记，Job 只在同一位置读写 |
| `startConvertJob` 的后台 run（`gate.tail` 链） | 开关关闭时使用；S6 删除 |
| `retryable` Map | Job 路径不用（Job 自己的 retry） |

回滚：关闭开关即回到原路径，只影响新提交；无持久化格式变化（manifest 只多出 Job 路径才会写的 `creating` 状态，旧代码把它当成未上传的段落重新创建，与旧行为一致）。

## 7. 测试矩阵

- 新：`tests/unified-runtime-pdf-create.test.mjs`（6，D-1/D-2 单元，先红后绿）、`tests/unified-runtime-pdf-convert.test.mjs`（11：同一本书两条路径得到相同页序/文本/课程、观测与无用量、重试只重做未完成段、取消顺序（两条路径）、排队与取消、信件、控制台、无会话拒绝、丢失创建回复、英文、本地窗口 Call 与取消杀进程）、`tests/unified-runtime-legacy-id.test.mjs`（2，内核）。
- 开关两侧：`mineru-service`、`mineru-history-service`、`mineru-local-service`、`mineru-adaptive-service`、`marker-service` 各有 `*.runtime.test.mjs` 孪生（全部在开关打开时通过）；其间唯一的差别（重试后 id 相同、信件撤回）已让 Job 路径与原路径一致，没有改任何断言的预期，只加了 `SWITCH_MODE` 注入。

## 8. 未验证

- V-1：MinerU 是否按 `data_id` 去重、能否查询/删除批次、空批次是否占额度——全用 fake MinerU，文档里的措辞都标了"推测"；若 V-1 证明可按 data_id 去重，`create-unknown` 的停止可以放宽。
- 本地窗口在真实 mineru/Marker 上的进程树退出（V-4，D-9 已在 S5-3 修复，测试用 fake CLI）。
- V-5（"导入后、终态保存前崩溃"再恢复不重复资料）：Job 不持久化，未覆盖，属 S5-6。
- 控制台 UI 无改动；用控制台自己的 `taskSummary/tasksOf/runningTaskCount` 读真实快照验证，未做浏览器截图。
