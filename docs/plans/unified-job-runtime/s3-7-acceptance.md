# S3-7：出题全家族集成、回退与 P3 验收

核验日期：2026-10-07。分支 `codex/runtime-s37-acceptance`，基于 S3-6c（#342）的分支。工作包文本见 [U16](sprints-2-6.md#u16-s3-7)；前序：[S3-0 基线](s3-0-generation-baseline.md)、[S3-1](s3-1-generation-queue.md)、[S3-2](s3-2-step-identity.md)、[S3-3](s3-3-restart-continuation.md)、[S3-4](s3-4-selection.md)、[S3-5](s3-5-repair.md)、[S3-6](s3-6-publish.md)、[S3-6b](s3-6b-supplement-publish.md)、[S3-6c](s3-6c-case-publish.md)。

本步不改运行时代码：它把出题家族的五类任务放在一起验收，补上 S3-0 恢复矩阵里还没有真实证据的两行（mixed、case 首份草稿前），并给出回退到 2.7.1 的证据。**目标环境（真实模型、真实 DSH 宿主）的 smoke 没有授权，§7 标为待做。**

家族的五类任务与它们的开关（`lib/runtime-config.js`，默认全部关闭；关闭时一切与 2.7.1 相同）：

| 任务 | 开关 | 定义 | 步骤 |
|---|---|---|---|
| 出题、补题、案例（含覆盖运行） | `generation` | `generation`、`supplement` | S3-1 / S3-2 |
| 重启后同一个任务回来、接着做 | `generationRestart`（需要 `generation`） | 同上（落盘） | S3-3 |
| 选区补题 | `generation` | `supplement`（`origin: selection`） | S3-4 |
| 后台修题 | `generationRepair`（需要 `generation`） | `draft-repair` | S3-5 |
| 发布草稿、补题自己的发布、案例快速发布 + 批改 | `generationPublish`（需要 `generation`；崩溃后的核对需要 `generationRestart`） | `draft-publish`（+ 另两条走同一步） | S3-6 / 6b / 6c |

没有 `generation` 时另三个开关什么也不做（开关说明里写明，只在提交处读一次）。

## 1. 混跑

测试：`tests/unified-runtime-generation-family.test.mjs`（2 条）。一个 `StudyService`，所有出题开关全开；五类任务同库：头一个出题任务停在第一次模型调用，后面依次是补题、选区补题、后台修题、发布草稿。

| 验收项 | 结论 | 证据 |
|---|---|---|
| 既有互斥：同库一次一个，按接收顺序 | 成立 | 头一个任务占着模型时后面四个都是 `queued`，模型只被问过一次（`plan`）；放开后顺序完成；任意两个任务的模型调用时间区间互不重叠 |
| 同一个库队列，没有新队列 / 新重试 / 绕过 | 成立 | 五类都经 `startGeneration` 进 `libraryQueue`；架构守卫（`unified-runtime-architecture`）对启动点逐处核对，全开后迁移 0 |
| 停一个只停它自己 | 成立 | 排队中的修题被停：它从不启动、不问模型、草稿原样；其余四个照常完成，目标题组正好得到各自的题（5 张，不多不少） |
| 每次调用记在做它的任务上，用量按调用数 | 成立 | 每个任务契约里每个调用的 `jobId` 是自己的；`usage.calls` 等于调用数；每个调用的观测边界是 `host-attempt`（经网关） |
| 工具与公共操作一致 | 成立 | 逐个任务比较 `job.status`（工具）与快照：同一个任务与状态、同一段阶段文字；暂停能力都是 `unsupported`，并且这么说 |
| 同配额资源 | 不适用 | 共享供应商配额开启时出题仍拒绝启动（`capability-unverified`，S3-1 的选择）；见 §8 |

## 2. 新旧入口、开关关与开

同 fixtures 的两侧各跑一遍（S3-1 起每一步都做）：

- 开关关：出题家族的既有套件全绿（与 2.7.1 行为一致）。
- 开关开（`STUDY_RUNTIME_MATRIX`，每步新增档位）：`generation` 档对 43 个出题套件，34 个全绿，其余 9 个是已评审的差异（S3-1 起逐条记录在 [S3-1](s3-1-generation-queue.md)/[S3-3](s3-3-restart-continuation.md) §6：暂停、补充要求不送达在途子代理、中断任务没有说明文字等）；`generationRestart` / `generationRepair` / `generationPublish` 及它们的「加重启」档对各自相关套件逐档记录（[S3-4](s3-4-selection.md)、[S3-5](s3-5-repair.md) §5、[S3-6](s3-6-publish.md) §6）。
- 同一套件的两侧：`draft-repair.test.mjs` + `.runtime`、`draft-publish.test.mjs` + `.runtime`、`generation-step-identity` + `.runtime`、`main-context` + `.restart`。差异都可解释：重试换新的 legacy id（逻辑任务 id 不变）、「部分修好」是「完成 + completeness partial」、任务不再自己调用 `withJobUsage`（网关代记）、通知由执行器结算时发一次（S6-5 再统一到内核结算）。

## 3. S3-0 恢复矩阵逐行

「证据」都是真实的任务停在那一点后复制库目录、新服务打开的重启测试（V1：不是杀真实宿主进程，是同一个状态的一致拷贝；DSH 宿主真实退出见 §7）。

| S3-0 行 | 现在 | 证据 |
|---|---|---|
| plain 首份草稿前 | 同一逻辑任务已中断；重试按原请求再问一次，一份草稿 | `generation-restart` #2 |
| mixed 首份草稿前 / 首个 part 后 | 同一逻辑任务；重试补缺的 part，两种题型都写，已存的题不动，不翻倍；与从未被打断的运行逐张相同 | `generation-restart-mixed`（本步新增，补上 V3；「少一张」的情形见 §8，已证明不是丢题） |
| case 首份草稿前 | 情景材料 id 由逻辑任务决定，崩溃留下的孤立材料被替换，库里只有一份；一份草稿 | `generation-restart-case`（本步新增，补上 D-5 / V4） |
| plain / case 首个 part 之后 | 同一逻辑任务沿同一草稿，已通过的题 id 不动 | `generation-restart` #1 |
| `resumeDraftId` 续补 | 同上 | `generation-restart` #1 |
| `extraSourceIds` 补题 | 首批保存后沿草稿继续，用记下的资料不用当前界面 | `generation-restart` #3 |
| target supplement | 沿检查点草稿继续并发布进同一题组，卡 id 与复习计划不变 | `generation-restart` #4 |
| 目标 supplement 写入后、任务完成前 | 重试看一眼找到写入，不再补第二次 | `unified-runtime-supplement-publish`（S3-6b） |
| coverage | 同一逻辑任务；只重跑在途的轮，已完成的轮保留 | `generation-restart` #9 |
| 重试被拒 / 执行者仍活 / 记录损坏 / 双重试 | 见 S3-3 §2 | `generation-restart` #5–#8 |
| selection，active 记录（D-1） | 候选题只审不再写，一次追加 | `unified-runtime-selection` #3 |
| selection，回执已提交记录未标完成（D-2） | 按回执重放同一批题卡，无模型调用，无重复 | `unified-runtime-selection` #4 |
| `draft.repair` | 同一逻辑任务；只修还没修好的卡，已修好的不重修 | `unified-runtime-repair` |
| `draft.publish.start`：写入前 / 复审中 / 写入后回执前 | 写入前沿用检查零次模型调用；复审中重问；写入后看一眼，不写不问，会话听到一次 | `unified-runtime-publish` #2 #3 #4 |
| 发布：草稿被改 / 题组被改后的重试 | 拒绝，说明发生了什么与该怎么做 | `unified-runtime-publish` #6 #7 |
| case 快速发布 + 批改（V4） | 发布后批改中退出：不重导案例、已批改的不重批 | `unified-runtime-case-publish`（S3-6c） |
| 旧 attempt 迟到不影响新尝试 | 内核既有测试；修题 / 发布的外部中止（删草稿）现在通知运行时 | `unified-runtime-recovery`、`review-integrity` #22 |

## 4. 回退到固定版本

**固定目标**：标签 `v2.7.1`，SHA `47f132815fc2fa65c7352f3f536109bb9c3ddd96`。

**新持久形状**：内核记录没有新增字段（回退形状守卫 `tests/unified-runtime-rollback-shape.test.mjs` 对每个写出的清单用 2.7.1 自己的校验器检查）。出题家族自己写的只有库目录下的 `generation-runs/` 一个文件夹（运行记录 `<id>.json`、发布计划 `<id>.publish.json` / `<id>.publish-quick.json`，**2.7.1 从不读它**，证据 `fileKinds`），草稿与题组仍写 2.7.1 已经写的同一种分片。

**排空**：开关在每次**提交**时读取；关闭四个开关并重启后，新任务走原路径。回退前的顺序：关闭开关 → 等控制台里出题类任务结束（或取消）→ 换回 2.7.1。直接换版本（不排空）也是安全的：下面的演练就是「硬结束后直接换版本」。

**演练**（`tests/fixtures/runtime-s37/run-drill.mjs`，需要旧版本的树，所以手动运行，不在 CI 里；结果记在 [`s3-7-evidence.json`](s3-7-evidence.json)，`tests/unified-runtime-generation-evidence.test.mjs` 校验该文件与本文一致）：八个场景，每个场景同一库的四个进程：

1. 当前代码、所有出题开关全开，做出完成的产物或在某个点停住，然后进程被硬结束（不 `dispose`、不清理）；
2. 2.7.1 的树（`git archive v2.7.1`）打开同一个库，读取，并用**自己的工具**把未完成的工作做完；
3. 当前代码再打开它读取（回退后再前进）；
4. 把第 1 步的快照放回去，当前代码用**任务的重试**自己把未完成的工作做完（对照）。

全部使用 fake，没有网络、没有真实密钥。

### 已完成产物：旧版本读得出

场景 `settled`：补题、选区补题、修题、发布、出题全部完成后，2.7.1 读到的题组（目标题组 5 张：原有、发布的 2、补题的 1、选区的 1）、草稿（修好的 2 张读作已修好）、选区操作记录（`complete`）与当前代码逐项相同；2.7.1 没有任务表，任务只存在于库里的产物里。

### 未完成的新任务：每个点的去向

| 场景 | 回退时库里的样子 | 2.7.1 看到的 | 2.7.1 怎么做完 | 当前代码怎么做完 | 结果 |
|---|---|---|---|---|---|
| `generate-mid`（第一个 part 已存） | 检查点草稿 1 张 | 一份草稿，没有任务 | `generate { resumeDraftId }` | 重试 | 两边草稿都是 3 张，逐项相同 |
| `repair-mid`（修到第二张） | 第一张已修好，第二张仍待处理 | 同左 | `draft.repair` | 重试 | 两边都 2 张修好，无待处理 |
| `publish-before`（写入前） | 草稿完整、题组未动 | 同左 | `draft.publish.start` | 重试 | 两边题组都是 3 张，草稿没了 |
| `publish-after`（写入后、回执前） | 题组已写、草稿没了 | 题组 3 张，没有待发布的 | 无事可做 | 重试：看一眼找到写入 | 两边题组都是 3 张，没有重复 |
| `supplement-after`（补题发布写入后） | 同上 | 同上 | 无事可做 | 重试：找到 | 两边题组都是 3 张 |
| `case-grading`（案例已发布、批改未做） | 案例题组 2 张，没有批改 | 同左 | 逐题 `card.grade` | 重试：只补批改 | 两边案例题组 1 个、批改 2 条 |
| `selection-review`（审阅中） | 操作记录 `reviewing` | 同左 | 同一 `operationId` 再开始 | 同一 `operationId` 再开始 | 两边题组一张追加、记录 `complete` |

回退后再前进（`rolledForward`）读到 2.7.1 做完的结果，逐项相同；回退前的中断任务在当前代码里显示为「未完成」，从不显示成运行中。

## 5. P3 验收对照（U16）

| U16 验收项 | 状态 | 位置 |
|---|---|---|
| 同 fixtures 新/旧入口与新策略关/开分别验证，差异可解释 | **成立** | §2 |
| generate / fill / selection / repair / publish 混跑，既有互斥生效，无新增 jobs / queue / retry / bypass | **成立** | §1，架构守卫 |
| S3-0 恢复矩阵每行都有真实退出 / 重启证据，任务可见且能继续、一次结算 / 提交 / 通知、旧 attempt 迟到不影响新尝试 | **成立**（V1：一致拷贝而非杀真实进程；DSH 宿主真实退出待做） | §3 |
| 按固定 tag / SHA 回退，分别声明已完成可读与未完成可继续范围 | **成立** | §4，`s3-7-evidence.json` |
| 目标环境 smoke | **待做（未授权）** | §7 |
| 正式 main 的进度不因 alpha 文档或发布而改变 | **成立**：本步只加文档 / 测试 / 夹具，不改运行时代码 | — |

## 6. 例外表更新（`s1-7-legacy-exceptions.json`）

本步不新增或删除例外条目。出题家族四个定义已在各自的步骤里加入 `managedDefinitions`；仍保留的原路径（开关关闭时使用，`startLegacy` 等）列在 S6-0 的清单里，统一由 S6-2 删除。仍列为迁移的只剩一处模型调用：快速发布的审阅（`authoring/publication.js`，随 S3-7 之后的评审）。

## 7. 目标环境 smoke（待做，未授权）

以下**没有**在真实环境运行；每一项都需要所有者授权真实资源后单独做，结果补在本节。

| 项 | 需要 | 状态 |
|---|---|---|
| 用真实模型跑一次出题 + 补题 + 发布，核对数量、顺序、档位、用量与通知 | 真实供应商与额度 | 待做 |
| 在真实 DSH 宿主里硬结束进程，再启动，核对任务回来、可继续、一次通知（V1） | 目标 DSH 宿主 | 待做 |
| 子代理执行方式（`runtime: subagent`）下重启后子任务是否还活着、归属如何（V2） | 目标 DSH 宿主 | 待做 |
| 共享供应商配额开启时的出题（目前拒绝启动） | 真实配额绑定 | 待做 |
| `card.grade`（案例批改）与发布前复审在真实模型上的用量记账 | 真实模型 | 待做 |

## 8. 已知缺口与限制（记录，不在本步修）

- **快速发布的审阅**（`authoring/publication.js`）仍是宿主模型调用，不经网关（§6）。
- **通知**：出题家族由执行器结算时通知，崩溃的那次 Attempt 不通知、接上的那次通知一次，所以不会重复；但「通知后、结算前」崩溃的窗口仍可能多一条，内核结算通知（`persistence.notifications`）要求定义同时可以声明落盘与非落盘两种，留给 S6-5。
- **共享供应商配额**：开启时出题拒绝启动（`capability-unverified`），需要观测边界后才能放开（S3-1）。
- **`card.grade`** 的模型调用在 study 上下文里，不经网关。
- **mixed 重试少一张 = fixture 的行为，不是丢题**（`generation-restart-mixed` 两条钉住）：这个假规划器是确定的、总取资料开头的句子，且在每个进程里从 `#1` 起给目标编号。重试用「全新的」规划器时，它又规划出已存草稿里那一题（问题文字相同、目标编号不同），服务器的补题合并（`mergeContinuedDraft`）把重复的那一张跳过，并写进草稿的 `failures`「补题时跳过了一道与已有草稿重复的题」，草稿仍显示比请求少一张，可以再「接着做」；测试逐张核对：重试写了 3 张，被跳过的恰是与已存那张问同一个问题的一张，其余 2 张按序保留，没有任何写出的题无声丢失。换成「记得已规划过什么」的规划器（真实规划器被告知草稿里已有的题，这里用 `alreadyPlanned` 模拟），重试与从未被打断的运行逐张相同（4 张、题型相同、没有跳过）。
- **V1**：重启用「复制库目录 + 新服务」模拟，不是杀真实宿主进程。
- **V2**：子代理执行方式下重启后的子任务归属缺宿主证据。
- **`job.dismiss` 后的运行记录**：记录在忽略 / 删除任务后仍留在磁盘，下次重启会再回来（7 天清理）；jobs 上下文需要通知家族（S6）。
- **已完成任务的运行记录**到下次重启才删除（S6）。
