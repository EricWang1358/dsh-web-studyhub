# S5-0：非模型任务与副作用基线

> 早期只读基线，基于 origin/main `8d661f4a5ab62337ceadc4040396a32bafaa2df1`；S5 开工时须在当时 main 上复核。

核验日期：2026-10-06。分支 `codex/runtime-s50-nonmodel-baseline`。本步只增加本文与特征测试，不改生产代码；缺陷只登记，不修复，也不在测试里扩大预期行为（[agent-rules §5](agent-rules.md)）。行号均指上述 SHA 的 `lib/**`；"测试"列指本步新增的 `tests/nonmodel-baseline-*.test.mjs` 或已有旧测试。

覆盖范围对应 [U27](sprints-2-6.md#u27-s5-0)：云端/本地 PDF 转换（含 Marker 转换）、Marker 安装、MinerU 本地 setup、检索索引构建/删除，以及它们周围的即时操作。DSH 宿主证据（DSH-03/06/08）本步未取得，属 S5-1 起的工作。

## 1. 路径矩阵

### 1.1 输入、资源、进程、远端引用

| 路径 | 入口与输入 | 真实资源实例 | 外部进程 | 远端引用 |
|---|---|---|---|---|
| P1 云端 PDF | `mineru.import`（`path`/`uploadId`，`title`、`course(s)`、`route`）`convert.js:431-470`；需令牌与隐私确认 `:446-450` | MinerU 账户配额（令牌，无配额域登记）；本插件内全局串行闸 `convert.js:65-66,81`；磁盘 job 目录 | 无（`fetch`）`mineru-api.js:83-91` | `chunk.batchId`、`chunk.dataId`（`mineru-job.js:306-310`，进 manifest）；预签名 `zipUrl` 不落盘 `:329` |
| P2 本地 MinerU PDF | 同上，`route: local\|auto`，tier 取自 `mineru.local.status` `convert.js:438-445` | 本机 mineru 服务（外部持有，单实例）；CPU；同一全局串行闸 | `mineru parse --pages a-b --wait N --json -o local-a-b.md`（每窗一次）`mineru-local.js:511-514`；只读探测 `server status --json` 等 `mineru-job.js:400` | 无；服务内部 parse 记录不保存，只按 tier+页范围识别 `mineru-local.js:301-408` |
| P3 Marker 转换 | `marker.import` `convert.js:319-340`；Marker 须 `ready` | Marker CLI；同一全局串行闸 | `marker_single`（每窗一次）`marker-local.js:64-76` | 无 |
| P4 Marker 安装 | `marker.install.start {confirm, location, mirror, removePrevious}` `marker-install.js:296-370` | 安装目录（sentinel）；`marker.json`；`marker-install.json`；进程内 `live` Map `:248` | `python --version`/`-c`、`python -m venv`、`python -m pip install marker-pdf`、`marker_single --help` `:109-117,324-351` | 无引用（PyPI/镜像，由 pip 管）；`removePrevious` 只记本地路径 `:305` |
| P5 MinerU 本地 setup | `mineru.local.setup {tier, confirm}` `convert.js:367-409` | mineru 自己的服务配置库与模型目录（CLI 所有）；内存 `setups` Map `:245` | `mineru server start`、`mineru-models-download --tier T`、`config set`×2、`server restart` `:385-400` | 无；下载由下载器自管 |
| P6 检索索引 | `retrieval.index.start {course}` `retrieval-operations.js:148-173` | 搜索扩展（DSH 子进程 MCP，`lancedb`、`models` 在 `DSH_HOME/study/retrieval`）`packages/studyhub-retrieval/index.js:41-45`；内存 `runs` Map `:61` | 无；经 `ctx.tools.execute` 调 `mcp__studyhub__ingest_data` / `delete_file` `retrieval-host.js:27-35` | `studyhub://source/<id>` + 内容 SHA-256（`retrieval-index.js:24-26`）；manifest 记录 |

### 1.2 目录所有权、manifest、幂等、停止、恢复

| 路径 | 目录所有权 | manifest | 幂等 | 停止 | 恢复 |
|---|---|---|---|---|---|
| P1 | `DSH_HOME/study/tmp/pdf-convert/<sha16(库)>/{jobs,results,uploads}` 插件独占 `mineru-paths.js:11-17`；成功后整目录清除 `convert.js:152`；conversion-history 在**库根** `mineru-history.js:16-22` | `jobs/<id>/manifest.json` 原子写 `mineru-job.js:66-81`；chunk 状态 planned/cut/requested/uploaded/parsing/done | 同一文件哈希同时只能一个 `convert.js:78`；完成块由 `results/<hash16>/<页范围>.json` 复用 `mineru-job.js:284-291`；**创建/上传无幂等**（D-1、D-2） | `AbortSignal` 只中断在途 fetch `mineru-api.js:83-91`；不通知远端；取消保留完成块 `convert.js:157-160` | 重启后 manifest 标 failed/可「接着做」`convert.js:197-218`；已上传块只轮询，`requested` 块重新创建 `mineru-job.js:361-365` |
| P2 | 同 P1；窗口结果 `local-a-b.result.json`/`.md` 在 job 目录，缓存键 `local-<tier>-a-b.json` `:190-191` | 同；自适应计划只存已决定的窗口 `:149-156` | 同；`restoreRanges` 按页范围跨计划复用 `:436-459` | `runLocalCommand` abort → `killTree` 并**立即 reject** `local-command.js:8-14,34`；不停服务端 parse（V-3） | `reconcileWindows` 忘记结果已丢的窗口 `:462-471` |
| P3 | 同 P2；缓存键 `marker-a-b.json`，与 MinerU 互不复用 | 同 P2（Marker 默认也是自适应窗口，`liveness:false`）`convert.js:136` | 同 P2 | 同 P2 | 同 P2 |
| P4 | 目标目录须为：不存在/空/带本安装器 sentinel，否则改用其内 `StudyHub-Marker` `marker-install.js:150-166`；sentinel `.studyhub-marker.json` 先于任何命令写入 `:336`；只删 `venv`、sentinel、（空则）目录 `:286-294` | `DSH_HOME/study/marker-install.json`（状态机+末 200 行日志）`:237-245`；`study/marker.json` 由 configure 阶段写 `:351` | 不幂等：重复 start 重建 venv；全 DSH_HOME 同时一个 `:248,277-283` | `abort` → 杀进程树，状态 cancelled，保留半成品环境与 sentinel `:357` | 无自动恢复：`running` 且无 live 显示 `interrupted` `:260`；由用户再点安装 |
| P5 | 插件不拥有目录（模型/配置属 mineru） | 无；内存 run 对象，重启即丢 | 同库同时一个 `convert.js:371-372`；tier 与模型已就绪则跳过下载 `:378-380` | `abort` → 杀当前 CLI 步骤；已下载保留；状态 cancelled `:404` | 无；`status` 回到 idle |
| P6 | 无专属目录；manifest 在 `DSH_HOME/study/retrieval/manifests/<sha16(库)>.json` `retrieval-index.js:33-48` | `{sources:{id:{hash,at}}}`，每 10 页与结束时写 `:21,87,114` | `contentHash` 相同跳过；变更页以同一 `sourceKey` 再 ingest（是否替换旧块依赖扩展，V-2）`:59-63` | signal 在页间检查并传给在途 `port.call` `:91,93` | 无 run 恢复；manifest 即检查点，再点 start 做差量 |

## 2. 副作用与重试层

同一外部操作只应有一层传输重试。现状：HTTP 客户端无任何重试，重试全部在 job 层 `guarded`（`mineru-job.js:243-262`）。

| 操作 | 实际副作用 | 重试层与预算 | 测试 |
|---|---|---|---|
| 云端创建 `POST /file-urls/batch` | 在 MinerU 建批次与预签名地址（占配额） | 仅 job `guarded`：3 次（`CONVERT.transferFailures`），第 1、2 次失败后等 8 s、16 s，封顶 30 s；429 按 `Retry-After`，累计预算 15 分钟 `:29-32,258-259`。**可能重复创建**（D-1） | cloud #1 #2 #4 |
| 云端上传 `PUT` | 写预签名对象 | 同上 3 次；不重新创建 | cloud #3 |
| 轮询 `GET extract-results` | 只读 | 同层 6 次（`pollFailures`）；单块 2 小时上限 `:27,339` | 旧 `mineru-job` |
| 下载 `GET zip` | 只读；写本地 results 缓存 | 同层 3 次；失败保留 batchId，续跑只轮询+下载 | cloud #3 |
| `task-not-found` | 之后再创建一次 | `convertChunk` 一次性 `:371`，再失败即停 | cloud #6 |
| 本地/Marker 窗口 | 在 job 目录与 results 写文件 | 无传输重试；`failed/timeout/empty-output/marker-*/total-mismatch` 折半再试至最小窗 `:62,487-495`；其余失败要用户「接着做」 | 旧 `mineru-adaptive-service` |
| Marker 安装各阶段 | venv、pip 下载与安装、写 `marker.json` | 插件无重试；pip 自带 `--timeout 60` 的内部重试 `:343`；超时 venv 3 分钟、pip 90 分钟 `:39` | 旧 `marker-install` |
| MinerU 本地 setup 各步 | 启停服务、下载模型、改服务配置 | 无重试；`server start` 90 s、下载 90 分钟、`config set` 60 s `convert.js:385-400` | 旧 `mineru-local-service` |
| 索引 `ingest` | 向扩展写一页 | 无重试；单次 15 分钟；失败进 `failed[]`，连续 5 次中止 `retrieval-index.js:20,22,100-102` | index #1，旧 `wp28b-index` |
| 索引 `delete` | 从扩展删一页 | 无重试，**错误被吞**（D-5）`:109` | index #2 |
| 设置写入 | 本地文件原子写 | 无 `mineru-settings.js:69-73` | 旧 `mineru-settings` |

## 3. 即时操作与长任务

| 类别 | 操作 | 事实 | 测试 |
|---|---|---|---|
| 即时（保持原接口，不建 Job） | `mineru.settings.get/set`、`mineru.test`、`mineru.plan`、`mineru.local.status`、`mineru.history.list/remove/clear`、`mineru.upload.*`、`marker.settings.get/set`、`marker.local.status`、`marker.install.plan/status/cancel/uninstall`、`retrieval.status/set/endpoint.set/preview/test`、`retrieval.index.plan/coverage/status/cancel` | 返回数据，无 `jobId`，不进共享任务表，不起后台 run；`mineru.test` 只发一次 `GET extract-results/<uuid>`，未上传；`mineru.plan` 只读本地文件；CLI 只执行 `--version`/`config`/`server`；python 只做探测。测试实际覆盖 `mineru.settings.get/set`、`test`、`plan`、`local.status`、`history.list`、`marker.settings.get`、`marker.local.status`、`marker.install.status/plan`；`retrieval.status/preview/index.plan/coverage/status` 见 index #5；其余按代码审阅 | instant #1，index #5 |
| 即时但有写副作用 | `mineru.history.list` 先 `recoverAudioBatches` 并 `interruptRecords` `convert.js:270-276`；`mineru.local.start` 同步等服务起来 `:365` | 名为读取却会改状态/阻塞（D-12） | 旧 `mineru-history-service` |
| 长任务（共享任务表，pdf-convert Job） | `mineru.import`、`marker.import`、`mineru.retry` | 任务控制台可见；`job.control` 的 retry 仅按 `pdf-convert→mineru.retry` 分流 `jobs/operations.js:256` | 旧 `mineru-service` |
| 长任务（**不在**共享任务表） | `mineru.local.setup`、`marker.install.start`、`retrieval.index.start` | 各自内存/文件状态，自己的 status/cancel；任务控制台看不到；服务卸载后仍在运行（D-8） | instant #2 #3，index #5 |

## 4. 保留或迁移

| 对象 | 去留 | 步骤 |
|---|---|---|
| pdf-convert 执行（split/upload/parse/download/merge/save）`mineru-job.js:502-529` | 迁移为内核 definition，保留 `convertPdf` 业务函数与 `mineru.*`/`mineru.retry` 旧接口 | S5-2 |
| manifest + `results/` 缓存 + 页窗口逻辑 | 保留，作为 `persistence` 适配器（`recoveryMode` 取 resume-checkpoint，对照 `audio-runtime-store`）| S5-2 |
| 全局串行闸 `convert.js:65-66` | 迁移为资源规则；本地进程与云端互相阻塞（D-11）须在 S5-2 决定 | S5-2 |
| conversion-history（库根）`mineru-history.js` | 保留为业务账本，不并入 Job 表；与 Job 的对应关系 S5-2 定 | S5-2 |
| inbox 信 `pdf-result/pdf-failed` `convert.js:117-121` | 保留；迁移时改为幂等通知通道（参照 `pilot.js` 的 `idempotent: true`）| S5-2 |
| Marker 安装执行器、sentinel、`marker-install.json` | 执行迁移为 Job；sentinel/目录所有权/确认/卸载全部保留；Settings-only admission 保留 `lib/index.js:348` 并映射到 `definition.admit` | S5-3 |
| `mineru.local.setup`（`setups` Map）| 迁移；confirm、tier、模型就绪后才启用配置的顺序保留 | S5-4 |
| 即时 settings/plan/status/test | 不迁移 | — |
| 索引 run（`runs` Map）与 manifest `retrieval-index.js` | run 迁移；manifest、`contentHash`/`sourceKey`、ingest/delete 经 `retrievalPort` 保留 | S5-5 |
| `mineru.upload.*` 上传登记 | 保留，S5-2 只消费 `claimUpload`/`discardUpload` | S5-2 |

## 5. 硬编码常量

| 常量 | 值 | 位置 | 建议归属 |
|---|---|---|---|
| MinerU 每文件上限 页/字节；请求/传输超时；轮询间隔 | 200 页、200 MB；60 s、30 min；4 s（上限 30 s） | `mineru-api.js:18-26` | 留在客户端常量（来自外部文档，非用户设置） |
| 切块边界 | 200 页、180 MB | `pdf-chunker.js:15,17` | 同上 |
| 任务时限与预算 | 慢提示 4 分钟、单块 2 小时、限流预算 15 分钟、等待 30 s、轮询失败 6、传输失败 3、清理 7 天 | `mineru-job.js:25-34` | 任务定义的策略表（内核 `policy` 目前只认队列/执行超时，见 §7） |
| 本地窗口与等待 | 首窗 10、爬坡 10/20/20、目标 75 s、最小 5/最大 50、等待地板 120 s、每页 8 s、加载余量 180 s | `mineru-local.js:14-40` | 同上，并与 UI 估计共用一份数据 |
| 本地耗时/体积估计 | 1.6/2.5 s/页；800/1200 MB | `mineru-local.js:36-38` | 估计数据表，UI 与任务共读 |
| 存活探测 | 20 s 一问、首问 5 s、静默 120 s、连续 3 次空闲 | `mineru-local.js:27` | 任务策略表 |
| setup 各步超时 | 默认 60 s、启动 90 s、下载 90 分钟；档位 `basic/standard` | `convert.js:367-400` | 任务策略表；档位取 `LOCAL.tiers` |
| Marker 安装 | 下载/磁盘估计、5–20 分钟、命令超时 venv 3 分钟/pip 90 分钟/验证 60 s/探测 10 s、日志 200 行、镜像表、默认目录 `DSH_HOME/studyhub/marker`、文件夹名与 sentinel 名 | `marker-install.js:16-40,78` | 估计与镜像为数据表；超时为任务策略；名称留常量（目录所有权标识） |
| Marker 检测/窗口超时 | 2 分钟 / 120 分钟 | `marker-local.js:30,64` | 任务策略表 |
| 上传 | 3 MB 分块、PDF 800 MB、24 小时清理 | `audio-upload.js:14,16,17` | 留 |
| 历史 | 保留 50 条/90 天 | `mineru-history.js:16` | 用户可见设置候选 |
| 索引 | ingest 15 分钟、每 10 页存一次、连续失败 5、模型 90 MB | `retrieval-index.js:19-22` | 任务策略表 / 估计数据 |
| 检索 | 查询超时 30 s、预算 120 000 字符、MCP 调用 90 s | `retrieval-operations.js:16-17`、`retrieval-host.js:18` | 同上 |

## 6. kind 专属分支

`lib/job-contract.js` 与 `ui/tasks/*` 只认 `pdf-convert`；Marker 转换是 `pdf-convert` 加 `converter:'marker'`，没有独立 kind。安装、setup、索引若建 Job，现在会落入 `extension`。

| 位置 | 内容 |
|---|---|
| `job-contract.js:22` | kind 注释清单 |
| `:53` | `CAPABILITIES['pdf-convert']`：cancel、retry、不可暂停、单位 `pages` |
| `:66-72` | `kindOf`：未知 type → `extension` |
| `:90,97,106` | 阶段码 `pdf.<phase>` |
| `:122-124` | 进度：页数；`segments` 固定写成 `author`（D-13） |
| `:326` | `detail`：`filename/route/converter/chunk/adaptive/note/eta/window/liveness/warnings` |
| `:347,371` | 结果引用取 `sourceIds`；标题取文件名 |
| `ui/tasks/task-model.js:18-21` | `KINDS` 映射 `pdf-convert→pdf`，其余 `extension` |
| `ui/tasks/task-summary.js:51,60` | `PDF_PHASES` 阶段文案 |
| `ui/tasks/CompactJobCard.jsx:23` | 「第 i/n 段」 |
| `ui/PdfConvertJob.jsx` | 资料页转换卡 |
| `lib/job-status.js:11`、`runtime/job-notice.js:27`、`runtime/builtins.js:308` | 状态常量、完成通知、插件卸载时只取消 `audio-import/pdf-convert` |
| `contexts/jobs/operations.js:89,96,186,256` | 取消文案、`mineru.retry` 分流 |

## 7. 与已发布内核的差额

内核入口：`lib/jobs/{contract,executor,lifecycle,registry,resources,gateway,store,durability}.js`。当前只注册了 `audio.v1`（`runtime/builtins.js:322`）。

| 编号 | 非模型任务需要 | 内核现状 | 位置 |
|---|---|---|---|
| G-1 | 面板（无 Agent 会话）发起安装/setup/索引 | `submit` 要求已登记的活 Agent 才能准入 | `executor.js:11-17`、`lifecycle.js:383-386` |
| G-2 | 记录 Call/请求计数/观测 | 只有模型网关写 `calls`；非模型的 `run` 只有 `output`/`present`/`controls`/`signal`；`context.gateway` 读取即抛 `model-not-admitted` | `gateway.js:50,166`、`lifecycle.js:149` |
| G-3 | 观测边界 | `observation.boundary` 仅 `external-request/host-attempt/legacy/local-wait`，无本地子进程、文件传输 | `contract.js:75-76` |
| G-4 | 资源：安装目录互斥、本地进程并发、库级索引互斥、云端批次配额 | `createProviderResources` 只支持 `providerObservation:'external-request'` 的 HTTP 路由与配额域 | `resources.js:11-13,25-27` |
| G-5 | 远端操作引用（batchId、dataId、sourceKey）与"先核对后重发" | Attempt 只有 `executor`、`checkpointRef`；没有远端引用字段、核对钩子或"未知结果"状态 | `contract.js:62-73` |
| G-6 | 取消回执与进程实际清理分开 | `definition.cancel` 单一；`executor.inspect` 只核对 DSH 原生 job，不核对子进程树 | `executor.js:20-37`、`registry.js:8-13` |
| G-7 | 执行模式 | `executionModes` 只允许 `direct/subagent`；无"非模型" | `registry.js:13`、`contract.js:88` |
| G-8 | 恢复 | `recoveryMode≠none` 必须提供 `persistence.open`；manifest 可适配，但"远端已创建未确认"无对应语义 | `registry.js:14` |
| G-9 | 不伪造用量 | `usage.tokens/tokenUsage/calls` 默认 null，符合；但 `usageLedger` 只接宿主模型调用的 `tokenUsage` | `lifecycle.js:3,76-78` |
| G-10 | 任务策略 | `submit` 的 policy 只接受 `queueTimeoutMs/executionTimeoutMs` | `lifecycle.js:383-386` |
| G-11 | Settings-only/confirm admission | `definition.admit(context, input, bindings)` 可承载，但谁是调用者（面板/助手）没有进入 `context` | `lifecycle.js:231` |

## 8. 缺陷（本步不修）

| 编号 | 缺陷 | 证据 | 测试固定 |
|---|---|---|---|
| D-1 | 创建响应丢失后用同一 `dataId` 再创建，MinerU 留下孤立批次，无核对、无取消 | `mineru-job.js:308` | cloud #4 |
| D-2 | 已创建未上传（`requested`）时重启，不复用已存 `batchId`，再创建一个 | `:361-365` | cloud #5 |
| D-3 | 客户端没有取消/删除批次的能力，取消只中断本机请求 | `mineru-api.js:109-160` | cloud #1 |
| D-4 | 索引 `delete` 失败被吞，manifest 仍删项，远端留孤儿且不再重试 | `retrieval-index.js:109-111` | index #2 |
| D-5 | ingest 已成功但 manifest 未保存（`save` 失败被吞）时下次整批重写，无核对 | `:114` | index #3 |
| D-6 | 取消发生在 ingest 途中，该页未记录，下次重写（可能已被扩展接收） | `:93-96` | index #4 |
| D-7 | 第二次 `retrieval.index.start` 无论课程都并入第一个 run，课程参数被忽略 | `retrieval-operations.js:150` | index #5 |
| D-8 | setup、安装、索引不在共享任务表；服务卸载不会停止它们（模块级 Map） | `convert.js:245`、`retrieval-operations.js:61`、`marker-install.js:248` | instant #2 #3 |
| D-9 | `runLocalCommand` abort 后立即 reject，不等进程退出；取消回执早于清理，PDF 取消还会立刻删 job 目录 | `local-command.js:34`、`convert.js:160` | 代码审阅；Windows 真机未验证（V-4） |
| D-10 | `study_workspace` 只拒绝 `marker.install.start/uninstall`；`marker.settings.set`（可写任意程序路径，随后 `marker.import` 会执行它）、`mineru.local.setup`（`confirm:true` 由调用方自带）、`mineru.settings.set`、`mineru.import`、`marker.import` 仍可达 | `lib/index.js:348` | 已动态确认并修复（`tests/assistant-settings-boundary.test.mjs`）：助手设的程序路径确被 `marker.local.status`/`marker.import` 执行；`marker.settings.set`、`mineru.settings.set`、`mineru.local.setup` 现与安装/卸载同列 Settings-only（`lib/assistant-boundary.js`）；两个 import 保留给助手，只用学习者在设置里配好的程序与授权 |
| D-11 | 一个 jobs 表只有一个转换闸：本地 Marker 转换会让云端转换排队 | `convert.js:65-66,81-82` | 仅代码审阅 |
| D-12 | 读取类调用带写副作用或长阻塞（`history.list`、`local.start`） | `convert.js:270-276,365` | 仅代码审阅 |
| D-13 | pdf-convert 的进度分段固定标成 `author` | `job-contract.js:124` | 仅代码审阅 |

## 9. 待核验

| 编号 | 问题 | 受阻步骤 |
|---|---|---|
| V-1 | MinerU 是否按 `data_id` 去重、是否提供取消/删除批次（本步未联网，未读官方文档） | S5-2、S5-6 |
| V-2 | mcp-local-rag 对同一 source 再 ingest 是替换还是累加；`delete_file` 对不存在项是否幂等 | S5-5 |
| V-3 | 杀掉 `mineru parse` 客户端后，本地服务里的 parse 记录是否继续跑（`mineru-job.js:398-400` 已标注"未验证"） | S5-4、S5-6 |
| V-4 | Windows `taskkill /T /F` 的实际退出时机与文件句柄释放（job 目录删除是否失败） | S5-2、S5-3 |
| V-5 | 转换结果入库：导入层以合并字节哈希作 `document.id`（`materials/files.js:21,57-67` 看起来幂等），"导入后、终态保存前崩溃"再恢复是否不重复未按测试固定 | S5-2、S5-6 |
| V-6 | `mineru.local.start` 在真实 CLI 上的阻塞时长与是否应保持即时 | S5-4 |
| V-7 | DSH `jobs.start` 在无 Agent 的面板入口下的行为（G-1 的宿主证据） | S5-1 |
| V-8 | D-10 的可达性已确认（见 D-10）；仍待产品决策：`mineru.local.start`（启动常驻本地服务，不改配置）是否也列入 Settings-only | S5-1、S5-3 |

## 10. 测试

新增（全部在 origin/main 上通过，未改生产代码；外部程序一律用现有 fake）：

| 文件 | 数 | 固定的内容 | 登记 slow |
|---|---|---|---|
| `tests/nonmodel-baseline-cloud.test.mjs` | 6 | 传输层单次请求、无取消/删除；创建/上传/下载的重试层与次数；D-1、D-2；`task-not-found` 再创建一次 | 否（回环 HTTP） |
| `tests/nonmodel-baseline-cache.test.mjs` | 5 | 块缓存按文件/页/路线（云、tier、Marker）分区；`discardJob` 按 converter 分区与 `keepResults`；`sweepStale`；job 目录归属 | 否 |
| `tests/nonmodel-baseline-index.test.mjs` | 5 | `sourceKey`/`contentHash`、ingest 限时与 signal；D-4–D-7；跨库互不影响；不在任务表 | 否 |
| `tests/nonmodel-baseline-install.test.mjs` | 4 | 助手工具在解析前拒绝安装/卸载（行为，非源码正则）；未确认不启动进程、不写状态；sentinel 与目录所有权；全 DSH_HOME 单实例 | cli |
| `tests/nonmodel-baseline-instant.test.mjs` | 3 | 即时操作无 Job/无上传/只读 CLI；setup 与安装不在任务表；D-8 | cli |
| `tests/helpers/nonmodel-baseline.mjs` | — | 共享的私有 DSH_HOME 与 PDF job 装置 | — |

已由旧测试固定、本步不重复：令牌/隐私确认前不上传（`mineru-service`）、分块与合并、完成块续跑、取消保留完成块、限流/网络退避（`mineru-job`）、历史记录（`mineru-history-service`）、自适应窗口与折半（`mineru-adaptive-service`）、setup 的 confirm/取消/失败（`mineru-local-service`）、安装四阶段/取消/失败/卸载/搬迁（`marker-install`、`marker-install-service`）、索引增量与取消/失败（`wp28b-index`）。

命令：`node scripts/test.mjs tests/nonmodel-baseline-<name>.test.mjs`（逐个）与 `tests/slow-tests-list.test.mjs`；`npx eslint` 针对新增文件。
