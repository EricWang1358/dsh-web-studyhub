# S5-7：非模型混跑与 P5 验收

核验日期：2026-10-07。分支 `codex/runtime-s57-nonmodel-acceptance`，基于 S5-6（#316）的分支。工作包文本见 [U34](sprints-2-6.md#u34-s5-7)；前序：[S5-1 契约](s5-1-nonmodel-contract.md)、[S5-2 PDF 转换](s5-2-pdf-convert.md)、[S5-3 Marker 安装](s5-3-marker-install.md)、[S5-4 MinerU 配置](s5-4-mineru-setup.md)、[S5-5 检索索引](s5-5-retrieval-index.md)、[S5-6 恢复矩阵](s5-6-recovery-matrix.md)。

本步不改任何运行时代码：它把四条非模型路径放在一起验收，并给出回退证据。**目标环境（真实 MinerU / Marker / 搜索扩展 / DSH 宿主）的 smoke 没有授权，§7 标为待做。**

四条路径与它们的开关（`lib/runtime-config.js`，默认全部关闭；关闭时一切与 2.7.1 相同）：

| 路径 | 开关 | 定义 |
|---|---|---|
| PDF 云端/本地转换 | `pdfConvert` | `pdf-convert` |
| Marker 安装 | `markerInstall` | `marker-install` |
| MinerU 本地配置 | `mineruSetup` | `mineru-setup` |
| 检索索引构建 | `retrievalIndex` | `retrieval-index` |

## 1. 混跑（模型任务在场）

测试：`tests/unified-runtime-nonmodel-family.test.mjs`（4 条）。一个 `StudyService`，同时有 fake MinerU 服务器、fake `mineru`/python/Marker 命令、fake 搜索扩展，以及一个被门控挂住的每日回顾（模型任务，`daily-recap` 定义）。

| 验收项 | 结论 | 证据 |
|---|---|---|
| PDF 转换、Marker 安装、MinerU 配置、索引构建可以在一个模型任务**占着**时全部完成 | 成立 | 模型任务停在第一次模型调用，四个非模型任务完成后它仍是 `running`，fake 模型只被调用一次，运行中任务数仍是 1 |
| 不共享不相关的限制 | 成立 | 非模型任务不进模型队列、不占模型并发、不记模型用量（见 §3 的账本断言）；它们各用自己的闸门 |
| 共同目录/资料的互斥仍然成立 | 成立 | 同库同时只有一个转换（第二本排队，不并行）；Marker 安装在 DSH_HOME 内只有一个槽（第二次开始是 `busy`）；同一资料库同时只有一个索引构建（第二次开始并入同一个）；混跑里逐项断言 |

## 2. 原工具与公共操作一致

同一个测试文件的第三条：对每个非模型任务，`job.status`（工具）与 `snapshot`（公共操作）读到的**能力、进度、结果、输出**逐项相同；缺失的用量**不被写成 0**：

- 没有模型调用的任务，`usage` 是 `{ tokens: null, tokenUsage: null, calls: 0 }`，`execution.mode` 是 `null`（"没有模型"，不是"零个"）；
- 能力表按路径固定：`cancel` 可用，`pauseMode` 为不支持，`set` 不可用，只有 `pdf-convert` 有 `retry`（与 S5-2 一致，MinerU 配置/安装/索引的"再来一次"是重新开始）；
- 第四条：用量账本不因非模型任务多出任何 feature。

## 3. 资源与副作用边界（汇总）

| 路径 | 外部副作用 | 观测边界 | 未知结果时 | 停止 |
|---|---|---|---|---|
| PDF 云端 | MinerU 创建批次、上传、下载 | `external-request`，创建/上传 `sideEffect: true`，轮询不记 Call | 创建回复丢失：`create-unknown`，不盲发；已存 batchId 先查询，查不了就拒绝（`create-unverified`），V-1 未验证 | 不向 MinerU 发任何取消/删除，引用保留 |
| PDF 本地 / Marker 转换 | 窗口进程写结果缓存 | `local-process` | 窗口结果在缓存而 manifest 没保存：按页范围恢复该窗口 | 进程退出后才 `cancelled`（`KILL_WAIT_MS` 10 s 上限，见 §8） |
| Marker 安装 | 创建目录、venv、`pip install` | `local-process`，每阶段一个 Call | 崩溃后显示 `interrupted`，sentinel 证明目录归安装器 | 同上；半成品保留，由用户在设置里卸载 |
| MinerU 配置 | 下载模型、改 mineru 的配置 | `local-process` | 模型已下载未改模式：再次配置不重复下载 | 下载中取消不写任何配置 |
| 检索索引 | 向扩展写入/删除来源 | `local-process` | 扩展已收但 manifest 没存：下次按同一 sourceKey 替换 | 在途写入未回答时取消：`unconfirmed`，不说成已写或未写 |

完整的路径 × 失败点矩阵与测试位置见 [S5-6](s5-6-recovery-matrix.md)。S5-6 的矩阵就是 U34 要求的"隔离 CLI / fake MCP / provider 故障测试"：所有格子用 fake MinerU 服务器、fake 命令和 fake 扩展，不接触网络、密钥或用户的 Python/Marker 环境。

## 4. 回退到固定版本

**固定目标**：标签 `v2.7.1`，SHA `47f132815fc2fa65c7352f3f536109bb9c3ddd96`（每步验收对照的发布）。

**为什么不需要"保存兼容 checkpoint"**：这四条路径的任务定义都**没有持久化**（`recoveryMode: none`），内核不写任何新的任务记录。当前代码在开关打开时留下的文件，种类与 2.7.1 写的完全相同（证据文件 `fileKinds`，逐类列出；测试断言其中没有任何任务/运行时/attempt/step 类的文件）。所以没有需要迁移或兼容的新格式，回退不需要转换步骤。

**排空**：开关在每次**提交**时读取；关闭开关并重启后，新任务走原路径。回退前的操作顺序（也是 §6 结论的依据）：关闭四个开关 → 等控制台里这四类任务结束（或取消它们）→ 换回 2.7.1。直接换版本（不排空）也是安全的，后果见下表：这就是演练做的事（准备阶段的进程在任务还在跑时被**硬结束**，不 dispose、不清理）。

**演练**（`tests/fixtures/runtime-s57/run-drill.mjs`，需要旧版本的树，所以手动运行，不在 CI 里；结果记录在 [`s5-7-evidence.json`](s5-7-evidence.json)，`tests/unified-runtime-nonmodel-evidence.test.mjs` 校验该文件与本文一致）：五个场景，每个场景同一个资料库和同一个 DSH_HOME（路径不变，因为转换目录和索引 manifest 都按库路径取键）：

1. 当前代码、四个开关全开，做出产物或未完成的工作，然后进程被硬结束；
2. 2.7.1 的树（`git archive v2.7.1`，开关概念不存在）打开同一个库，读取，并把未完成的工作做完；
3. 当前代码再打开它读取（回退后再前进）；
4. 把第 1 步的快照放回去，当前代码自己把未完成的工作做完（对照）。

全部使用 fake，没有网络、没有真实密钥。

### 已完成产物：旧版本读得出

| 产物 | 2.7.1 读到的 | 证据（场景 `settled`） |
|---|---|---|
| 转换后的页面与文档 | 7 页，页面内容哈希相同 | `pages`、`pageHash` 三方一致 |
| 转换历史 | 一条 `complete` | `history` 一致 |
| 检索索引覆盖 | 7 页全部已索引、0 页缺失 | `indexed`、`missing` 一致 |
| Marker 安装 | 已安装、状态 `complete` | `install`、`installed` 一致 |
| MinerU 配置 | 状态读取为 `idle`（StudyHub 不保存配置结果，由 mineru 自己说是否就绪；当前代码重启后同样是 `idle`） | 两个版本一致 |

### 未完成的新任务：每条路径的去向

| 路径 | 回退时的状态 | 2.7.1 看到的 | 能否继续 | 证据 |
|---|---|---|---|---|
| PDF 转换（本地，已完成第一个窗口） | 任务文件夹与 manifest、已保存窗口结果仍在；历史行是"运行中" | 一行 `interrupted`，带「接着做」 | **能**：`mineru.retry` 从 manifest 继续，只做没做完的窗口，加 120 页（4 → 124），页面内容哈希与当前代码完成的结果**完全相同**，页数只加一次 | 场景 `pdf` |
| Marker 安装（停在 pip） | `marker-install.json` 记为运行中，没有进程 | `interrupted`，不是运行中也不是已安装 | **能**：再次开始在原目录继续，完成后 `installed: true`，回退后再前进读得出 | 场景 `install` |
| MinerU 配置（停在模型下载） | 没有任何记录；mineru 的配置没被改 | `idle`（不是运行中，也不是就绪） | **能**：重新开始，完成 | 场景 `setup` |
| 索引构建（写到一半） | manifest 未保存，扩展里可能已有少数来源 | 覆盖显示 0 页已索引（半成品不被当成已建好） | **能**：重新开始，按来源键替换，完成后 4/4 | 场景 `index` |

在这四个场景里，2.7.1 与当前代码的"回退后可见状态"和"继续后的结果"逐项相同（`rolledBack` 与 `sameCode`），所以这些路径迁移到运行时**没有改变任何一条路径的未完成工作的命运**。`rolledForward`（当前代码读 2.7.1 做完的结果）也读得出。

## 5. P5 验收对照（U34）

| U34 验收项 | 状态 | 位置 |
|---|---|---|
| PDF、安装、模型准备、索引与模型任务混跑，不共享不相关限制，不越过共同目录/资料互斥 | **成立** | §1，`unified-runtime-nonmodel-family.test.mjs` |
| 原工具与公共操作的能力/进度/结果/输出一致，缺失用量不伪装成 0 | **成立** | §2 |
| 关闭接纳并排空/保存兼容 checkpoint 后，旧版启动、已有产物可读、未完成任务可继续分别有证据 | **成立**（无需 checkpoint：没有新格式） | §4，`s5-7-evidence.json` |
| 隔离 CLI / fake MCP / provider 故障测试 | **成立** | [S5-6](s5-6-recovery-matrix.md)，11 个新格子加前序测试 |
| 目标环境 smoke 记录 | **待做（未授权）** | §7 |
| 未验证的远端能力如实保留限制 | **成立** | §8 |

## 6. 例外表更新（`s1-7-legacy-exceptions.json`）

本步不新增或删除例外条目。四个定义（`pdf-convert`、`marker-install`、`mineru-setup`、`retrieval-index`）已在各自的步骤里加入 `managedDefinitions`；这四条路径仍保留的原路径（开关关闭时使用）列在各步的"保留或迁移"表里，统一由 S6-2 删除。仍属于业务账本、不是任务执行旁路的对象：转换历史 `mineru-history`、信箱信、`mineru.upload.*` 登记、`live` 安装槽、manifest 与 `results/` 缓存。

## 7. 目标环境 smoke（待做，未授权）

以下**没有**在真实环境运行；每一项都需要所有者授权真实资源后单独做，结果补在本节。

| 项 | 需要 | 状态 |
|---|---|---|
| 云端转换一本真实 PDF（创建、上传、轮询、下载、导入） | 真实 MinerU 令牌与额度 | 待做 |
| 云端创建回复丢失后的批次核对（V-1：只能按批次号查询） | 同上，制造丢失需要真实网络故障 | 待做 |
| 本地 MinerU 转换与取消（含 Windows `taskkill` 的实际退出时间，V-4） | 本机 mineru 安装 | 待做 |
| Marker 在真实 Python 上安装、取消与卸载 | 真实 Python 与网络（pip） | 待做 |
| MinerU 配置下载真实模型 | 真实网络与磁盘 | 待做 |
| 检索索引在真实 mcp-local-rag 上构建，核对同键重入是替换（V-2，0.20.0） | 真实扩展 | 待做 |
| 宿主无 Agent 时的行为（V-7） | 目标 DSH 宿主 | 待做 |

## 8. 已知缺口与限制（记录，不在本步修）

- **取消后的任务只回答"请重新导入"**：内核对 `cancelled` 也给出 retry，而取消会删任务文件夹，此时重试得到原有的提示"临时文件已被清理…请重新导入这份 PDF（已解析好的段落会被复用）"。与 2.7.1 一致；内核按定义配置可重试状态属于 **S6-5**。
- **D-11**：云端与本地转换共用一个闸门（同库一次一个），与 2.7.1 相同；拆开是单独的策略开关。
- **V-1** MinerU 云端只能按批次号查询，无法按 data_id 查：创建回复丢失而又没有保存批次号时，只能拒绝，不能自动核对。
- **V-4** Windows `taskkill` 的真实退出时机未在真机上验证；`KILL_WAIT_MS`（10 s）到后调用方被放行，此后进程可能仍在；需要进程见证才能让新 attempt 拒绝启动。
- **V-7** 宿主没有 Agent 时的行为未在真实宿主上验证（`executor-unavailable` 只有 fake 证据）。
- **D-10 / V-8** 这些设置只能在设置页修改（#291 的 Settings-only 产品决定）。
- 孤儿进程：安装与配置的 Job 不持久化，重启后不会主动查找旧进程；只显示"已中断/空闲"，不把未知说成已停止或已就绪（S5-6 §4）。

## 9. 复现

- 混跑与一致性：`node scripts/test.mjs tests/unified-runtime-nonmodel-family.test.mjs`；
- 证据文件的核对：`node scripts/test.mjs tests/unified-runtime-nonmodel-evidence.test.mjs`（廉价，在 CI 里跑）；
- 重新做回退演练：`node tests/fixtures/runtime-s57/run-drill.mjs`（约 1–2 分钟；需要 `v2.7.1` 标签，解包到 `.local/old-2.7.1`；只用 fake，DSH_HOME 在 `.local/drill` 下；会重写 `s5-7-evidence.json`）。
