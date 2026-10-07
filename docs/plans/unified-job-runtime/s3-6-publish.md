# S3-6：发布草稿（publication）与崩溃后的核对

> 前置：S3-1（队列）、S3-3（落盘，开关 `generationRestart`）、S3-5（`draft-repair.js` 的同一形状）。本步让 `draft.publish.start` 成为统一运行时里的任务，开关 `runtime.pilot.generationPublish`（默认关；**需要 `generation`，没有它这个开关什么也不做**，开关说明里写明，只在提交处读一次，定义从不读配置）。崩溃后的核对只在 `generationRestart` 也开着时有（任务落盘）；没有它，发布任务只在本进程里，进程退出就没了——和以前一样。
>
> **不改内核的落盘形状**：没有新增 `Commit.intent` 或任何持久字段。发布计划放在领域自己的文件里（见 §2）。

## 1. 流程

| 步 | 做什么 | 在哪 |
|---|---|---|
| 排队 | 与出题、补题、修题共用 `libraryQueue`；`startGeneration` 的同一个入口 | `draft-publish.js` |
| 检查 | `draft.publish.plan`（authoring，新动作）：发布前逐卡复审（每批一次网关步骤 `k<批的指纹>:publish:review[:x<n>]`），并**在私有副本上做一遍写入**，得到写入会留下什么——题卡**正是**写入后的样子（分部标记 `part`、所有规整都算进去），不是草稿里的样子 | `authoring/operations.js` |
| 计划落盘 | 检查的结果（决定 + 预期）写进 `generation-runs/<任务>.publish.json`，在提交之前 | `generation-run-store.js` |
| 写入 | `context.commitArtifact('publish', …)`：内核先把待定提交写盘，再调用 `draft.publish { planned: true }`，它不再复审，只照计划写；一次原子的 `state.update` | `draft-publish.js` |
| 回执 | 小而朴素：`{ id, deckId, accepted, rejected, added, total, remainingDraftId }`，写进提交记录 | 同上 |

没有 `generationRestart`（任务不落盘）：同样的检查，写入直接做，没有提交记录。没有 `generationPublish`：原来的一次 `draft.publish` 调用（复审 + 写入），一字不变。

## 2. 崩溃后怎么办：看，不盲目重做

计划里的 `expect`：草稿 id 与版本、目标题组与写入前的版本、**每张被接受的题在写入后的指纹**（`lib/publication-fingerprint.js`：题的 id 与所有说明它问什么、答什么的字段，不含学习者自己的使用痕迹——加入时间、复习计划、标记、前置、修订）、写入后会留下的草稿（部分被拒时）。`reconcileCommit`（经 run store）对着现在的学习库判断：

| 看到的 | 结论 |
|---|---|
| 草稿还在原版本，题组里一张都没有 | 没写过（`notPublished`）：内核丢掉待定提交，重试从头来；检查**不重做**（计划还在，草稿与目标题组版本没变就直接用） |
| 题组里每张被接受的题都是预期的指纹，草稿没了（或就是写入留下的待处理草稿） | 写过了：回执由计划重建（`recovered: true`），**不再写**，不再问模型 |
| 草稿被改过 / 删了，题组里一张也没有 | `publish-draft-changed`：学习者看到「草稿在检查发布之后被改动或删除了……请打开题组和草稿核对已有的题目；如果有缺的，请重新发布这份草稿。」 |
| 题组在写入之后被改过、或只有一部分 | `publish-deck-changed`：「题组在检查发布之后被改动过，其中可能已经有了这次发布的部分题目。请打开题组核对；缺的题目请重新发布这份草稿。」 |

文字在 `jobs/messages.js`（`PUBLISH_TEXT`，中文，英文在 `application-messages-en.js`），`lib/job-contract.js` 的 `REASONS` 引用它们，所以任务台的重试按钮旁和 `job.control` 的拒绝都是这几句话；两个码各管一种（内核只保留拒绝码，不保留文字）。

「被找到」的任务：任务卡有 `recovered: true`，阶段文字写明「已核对：上次中断前题目已经并入题组，没有重复写入」，记录上有领域事件 `publish-recovered`（`{ deckId, accepted, added }`）。通知：执行器结算时 `announceJob` 一次（与出题、修题一样）；崩溃的那次 Attempt 没结算、没通知，接上的那次结算一次，所以会话**恰好听到一次**——正常发布一次、写入后回执前崩溃再接上也一次（`unified-runtime-publish` 两处断言）。

## 3. S3-0 恢复矩阵中本步负责的行

| 行 | 现在（`generationPublish` + `generationRestart`） | 证据 |
|---|---|---|
| 排队 / 复审前 | 重启后同一逻辑任务已中断；重试从头，写一次 | #2 |
| 复审中 | 同上，复审重问一次，写一次 | #3 |
| 复审后、写入前 | 重试沿用已存的检查，**一次模型也不问**，写一次 | #2 |
| 写入后、回执前（V5） | 重试看一眼学习库：写过了，不写、不问、会话听到一次，题组与写入完全一致 | #4 |
| 同上，分部草稿 | 指纹按写入后的样子算（`part` 标记），不被当成冲突 | #5 |
| 检查后草稿被改 | 拒绝，`publish-draft-changed`，什么也没写 | #6 |
| 写入后题组被改 | 拒绝，`publish-deck-changed`，什么也没再写 | #7 |
| case 快速发布 + 批改（V4） | 见 [S3-6c](s3-6c-case-publish.md)：同一条路，批改由 attempt 认出 | `unified-runtime-case-publish` |
| 补题运行里的发布（`publish()` 在执行器里） | 见 [S3-6b](s3-6b-supplement-publish.md)：同一条路，写入后回执前崩溃由看一眼接上 | `unified-runtime-supplement-publish` |

## 4. 内核没改

`lib/jobs/**` 本步未改。`lib/job-contract.js` 的 `REASONS` 加两个码；`contexts/jobs/operations.js` 的 `job.control` 对「家族有白话」的拒绝码用白话抛出。

## 5. 开关打开后的差异

- 发布前复审的模型调用由 `host-attempt` 网关步骤记账（旧路径是 `withJobUsage` 的手工记账）。
- 发布任务仍然不可取消（`job.cancel` 拒绝 `draft-publish`，不变）；卸载插件仍会中止它。
- 重试换新的 legacy id，逻辑 Job id 不变。

## 6. 开关矩阵

`STUDY_RUNTIME_MATRIX=generationPublish` / `generationPublishRestart`（新增两档），发布相关 9 个套件：

| 套件 | `generationPublish` | `generationPublishRestart` | 说明 |
|---|---|---|---|
| publication-context、review-integrity、generation-lifecycle、deck-parts-exec、documents、terminals、queue | 全绿 | 全绿 | |
| wp27-usage-jobs | 全绿 | 全绿 | 第一次矩阵失败 1 条：发布复审的用量记到了 `generate`，应是 `repair`（复审是 authoring 的活）；已修：任务的模型用 `featureOf('authoring', 'draft.publish')` |
| generation-family-baseline-restart-plain | 1 条不适用 | 3 条不适用 | 断言「重启后没有发布任务回来」，正是本开关要改变的行为（同 S3-3、S3-5 的已评审差异）；`unified-runtime-publish` 覆盖新行为 |

新增套件：`tests/unified-runtime-publish.test.mjs`（9 条）、`tests/draft-publish.test.mjs` + `draft-publish.runtime.test.mjs`（同一套件两侧，3 条）。
