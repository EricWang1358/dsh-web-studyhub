# S6-6：最终读兼容与指定版本回退

核验日期：2026-10-07。分支 `codex/runtime-s66-rollback-read`，基于 main。工作包文本见 [U41](sprints-2-6.md#u41-s6-6)；前序：各阶段的回退演练 [S2-7](s2-7-acceptance.md)、[S3-7](s3-7-acceptance.md)、[S4-9](s4-9-rollback.md)、[S5-7](s5-7-acceptance.md) 和形状守卫 `tests/unified-runtime-rollback-shape.test.mjs`。

本步**不改运行时代码**：把四次分阶段演练合成一张"路径 × 回退后三件事"的矩阵，给每个开关一行；再用测试补上演练没有直接钉住的三条性质（旧版读写一遍后在途任务的身份不变；未知 schema 不被改写；运行时留下的持久文件种类只有一种新的）。真实宿主、真实模型、安装包演练没有授权，见 §6。

**固定目标**：标签 `v2.7.1`，SHA `47f132815fc2fa65c7352f3f536109bb9c3ddd96`。四份证据文件（`s2-7-evidence.json`、`s3-7-evidence.json`、`s4-9-rollback-evidence.json`、`s5-7-evidence.json`）都对这个 SHA 演练；`tests/unified-runtime-rollback-read.test.mjs` 断言它们没有分叉。

## 1. 三件事分开记录

回退到 2.7.1 之后，**旧版启动**、**已完成的产物能读**、**未完成的新任务能继续**是三件不同的事，矩阵每个开关各记一格，不以"启动成功"代替全回退：

- `✓`：成立，有演练或测试证据；
- `△`：成立但有已记录的退化或限制（格子里写明）；
- `无`：这条路径没有可继续的持久工作（任务不持久，重启后与 2.7.1 一样消失），所以"继续"不适用；
- `未演练`：没有证据，如实写明，不写成成立。

## 2. 矩阵：路径 × 回退后的三件事

开关全部默认关闭；回退到 2.7.1 前的顺序：关闭开关 → 等控制台里的任务结束（或取消）→ 换回 2.7.1。直接换版本（不排空）也演练过，后果在格子里。

| 路径（开关） | 2.7.1 启动、读库 | 已完成的产物可读 | 未完成的新任务能否继续 | 证据 |
|---|---|---|---|---|
| `audioSingle` 单文件导入 | ✓ | ✓ | △ 2.7.1 把它显示为"已中断"并能「接着做」，结果与当前代码相同；但 2.7.1 自己的「接着做」第一次点击可能被它的 `revision-conflict` 拒绝（#303 修了），变通是再导入一次 | S2-7 §4 |
| `audioBatch` 批量导入 | ✓ | ✓ | △ 能；**失去"在途请求不重来"保护**：已发出但没收到答案的转写会再做一次（再花一次额度） | S2-7 §4.2、§8 |
| `audioSubtitles` 字幕导入 | ✓ | ✓ | 无 重启后任务消失，与 2.7.1 相同（D-9） | S2-7 §8 |
| `audioReview` 复查 | ✓ | ✓ | 无 同上 | S2-7 §8 |
| `audioLiveSave` 课堂保存 | ✓ | ✓ | 无 同上 | S2-7 §8 |
| `audioLiveCorrection` 课堂校正 | ✓ | ✓ | 无 同上 | S2-7 §8 |
| `generation` 出题、补题 | ✓ | ✓ | ✓ 草稿就是检查点：2.7.1 用 `generate { resumeDraftId }` 接着做，两边草稿逐项相同 | S3-7 §4 |
| `generationRestart` 出题重启恢复 | ✓ | ✓ | ✓ `generation-runs/` 是 2.7.1 不认识的目录，它被忽略；任务在 2.7.1 里只是"一份草稿，没有任务"，用上面的办法接着做 | S3-7 §4 |
| `generationRepair` 后台修题 | ✓ | ✓ | ✓ `repair-mid`：两边都修好 2 张，无待处理 | S3-7 §4 |
| `generationPublish` 发布 | ✓ | ✓ | ✓ 写入前：两边题组都是 3 张；写入后回执前：当前代码"看一眼找到写入"，2.7.1 无事可做，都没有重复 | S3-7 §4 |
| `translation` 翻译 | ✓ | ✓ | ✓ 在途被结束：0 段（一段一段通过后才写），再做一遍两边都是 9 段 | S4-9 §2 |
| `translationParallel` 翻译不再排在生成后面 | ✓ | ✓ | 无 只改排队，不写任何新东西 | S4-3，`unified-runtime-translation-scheduling.test.mjs` |
| `coach` 为你定制备题 | ✓ | ✓ | ✓ 在途被结束：库里没有备题、没有当天的行，两个版本读到的相同；再做一遍两边都得到三道变式（S6-6 补进 S4-9 的演练，`coach` 家族） | S4-9 §2 |
| `dailyRecap` 每日总结 | ✓ | ✓ | ✓ 在途被结束：2.7.1 显示"已中断"（带进程核对），再做一遍两边相同 | S4-9 §2 |
| `dailyRecapAgent` 总结用子代理 | ✓ | ✓ | 无 只改一次调用怎么执行，不写任何新东西；定义不持久 | S4-8，`unified-runtime-agent-policy.test.mjs` |
| `workflow` 学习流讲解/骨架 | ✓ | ✓ | △ 讲解记录在进程被结束后一直是"运行中"，2.7.1 与当前代码相同（回退没有让它变坏）；再开始即可 | S4-9 §3 |
| `workflowAgent` 学习流用子代理 | ✓ | ✓ | 无 同 `dailyRecapAgent` | S4-8 |
| `assist` 助教 | ✓ | ✓ | 无 助教任务只在内存里，重启后没有留下东西，再做一遍两边都是一条记录 | S4-9 §2 |
| `noteGenerate` 笔记起草 | ✓ | ✓ | △ 状态仍是"运行中"（两个版本都没有核对死进程的逻辑），再点一次起草即可 | S4-9 §2 |
| `examBlueprint` 备考补习：考点清单构建 | △ 按 v3.0.0 标签树演练，不是 2.7.1：旧版读写含 `blueprint` 字段的库，字段原样保留；2.7.1 未单独演练 | △ 蓝图是一份带附加字段的普通 source，旧版把它当普通 Markdown 资料读出并列在资料里（它不认识「考点清单不算资料」的隐藏规则，这是接受的退化）；同样只对 v3.0.0 演练 | 无 构建任务不持久（`recoveryMode: none`），重启后没有留下东西，再点一次构建；蓝图只在最后一步一次性入库，不会有半成品 | 3.1 步骤 1–2，`exam-blueprint-material.test.mjs`、`exam-blueprint-job.test.mjs` |
| `pdfConvert` PDF 转换 | ✓ | ✓ | ✓ 在途：2.7.1 列为已中断并续做，两边多出同样的 120 页，只加一次 | S5-7 §4 |
| `markerInstall` Marker 安装 | ✓ | ✓ | ✓ 两个版本都是"未完成"，再开始即完成 | S5-7 §4 |
| `mineruSetup` MinerU 配置 | ✓ | ✓ | ✓ 同上 | S5-7 §4 |
| `retrievalIndex` 检索索引 | ✓ | ✓ | ✓ 同上，按同一来源键替换 | S5-7 §4 |

**没有开关的种类：课程总纲整理（`course-outline-build`，2026-10-09）。** 旧版启动、读库：未演练，但总纲和考点清单同形，是一份带附加字段（`courseOutline`，`provenance: 'course-outline'`）的普通 source，旧版读写时字段原样保留。已完成的产物：△ 旧版（3.3.0 及更早）不认识「总纲不算资料」的隐藏规则，会把它当一份 Markdown 资料列在资料里，这是接受的退化，和考点清单相同。未完成的任务：无，任务不持久（`recoveryMode: none`），总纲只在最后一步一次性入库，没有半成品，重启后再点一次「生成总纲」。证据：`course-outline-book.test.mjs`、`course-outline-job.test.mjs`。

## 3. 格式：运行时留下了什么

- **内核记录没有新增字段**：形状守卫对每个写出的 manifest 用 2.7.1 自己的校验器（`tests/fixtures/release-2.7.1/`，逐字复制）检查，所以关掉开关回退后整个快照不会因一份读不了的记录而失败。演练第一次运行时发现过一次真实缺陷（请求意图带 `sideEffect` 与 `abandoned`），已在内核修复（#331）。`local-wait` 调用现在是无副作用的（#320），`deliveries` 只有 eventId/channel/status。
- **运行时特有的持久文件种类只有一种新的**：库目录下的 `generation-runs/`（出题家族的重启恢复，`generationRestart` 开着时才有）。2.7.1 不认识它，所以忽略它；它不会让 2.7.1 读库失败（演练 `generate-mid` 等六个场景证明）。其余种类（`audio-batches/`、`conversion-history/`、`prepared`、`coach-daily.json` 等）2.7.1 本来就写。
- **账本**（`model-usage.json`）格式没变；在途请求的用量是否已入账由 `accounting` 标记决定，2.7.1 读不到也不依赖它。
- **未知 schema 不被改写**：一份 `schemaVersion` 不是 1 的 manifest，当前代码拒绝认领（`restore` 抛 `unsupported-store-version`）并且**不改动磁盘上的字节**；2.7.1 的校验器同样拒绝。测试钉住。

## 4. 回退过程不动在途任务

- 开关在**提交**时读取；已经在跑的 Attempt 保留它开始时的执行者、定义版本和策略快照，关开关不改变它。
- 旧版把 manifest 读一遍再存一遍（它碰这个文件时就是这样），当前代码再读回来：**Attempt 身份、执行者引用、定义版本、策略快照、事件、`deliveries` 全部不变**（`tests/unified-runtime-rollback-read.test.mjs`，对任务进行中和已结算两种 manifest）。
- 新版本未完的记录不会被静默丢弃：回退前的中断任务在当前代码里显示为"未完成/已中断"，从不显示成运行中（S3-7 §4）。

## 5. 回退再前进（回到 alpha）

演练每个场景都做第三步：当前代码再打开 2.7.1 做完的库。结果：旧、新记录与回执一致（`rolledForward` 与 `sameCode` 逐项相同，见各证据文件和各验收文档的表）。一处已记录的残留：**回退再前进后，旧的"已中断"卡片留在列表里**（2.7.1 把工作做完只更新它自己的旧字段，不更新运行时的记录）；资料本身是对的，卡片可移除（S2-7 §8）。

## 6. 没做的、旧版无法继续的范围（如实记录）

- **旧版无法继续**：批量导入"请求在途"的保护（§2）；2.7.1 对 `revision-conflict` 的首击拒绝；笔记起草和学习流讲解的"运行中"不会自愈。这些是 2.7.1 自己的行为，回退到它时存在。要保留这些保护就不能回退到 2.7.1。
- **没有授权、待做**：真实 DSH 宿主上的"用户把版本换回 2.7.1"全流程（安装包、真实 Windows 安装目录）；真实模型下的回退抽样（S6-7）；真实 MinerU/Marker/搜索扩展。所有演练用 fake，硬结束是 `process.exit`，不是强杀。
- `dailyRecapAgent` / `workflowAgent` 的"无"是按构造（只改一次调用怎么执行、定义不持久）加测试，不是单独演练。
- 通知：出题家族的会话通知现在经内核结算 sink（#352），"通知后、结算前崩溃多一条"的窗口随之关闭（至多一次）；翻译随后（#354）。S3-7 §8 里那条旧限制以此为准。

## 7. 演练是否在 `npm test` 里，以及它们最近一次在哪个提交上跑过

**不在。** 四个演练（`tests/fixtures/runtime-s27|s37|s49|s57/run-drill.mjs`）需要旧版的树（`git archive v2.7.1`）和几分钟，CI 不跑它们；`npm test` 里只有读证据文件的检查（`unified-runtime-audio-evidence`、`-generation-evidence`、`-model-evidence`、`-nonmodel-evidence`）和本步的 `unified-runtime-rollback-read.test.mjs`，它们守住"证据文件自洽、指向同一个版本、矩阵没有漏开关"，不重新演练。所以演练要在**发布前手工重跑**。

**最近一次**：2026-10-07，四个演练在同一台机器上依次重跑，代码是提交 `1db56dd38e794790d580cd1f08de78c544d713cc`（本 PR 里加入 `coach` 家族之后的演练代码；运行时代码与 main 相同）。四个都以 `v2.7.1` / `47f13281` 为目标，退出码 0，并重写了四份证据文件（共约四分钟）。`s2-7`、`s5-7` 证据里的 `sourceHash`/`pageHash` 随生成内容的哈希变了；检查它们的测试比较的是同一份文件里各步之间的相等，不比较固定值，所以仍然成立。

解包旧版不需要手工步骤：四个演练共用 `tests/fixtures/extract-release.mjs`，只用 git 把标签写成文件树（临时索引文件 + `checkout-index --prefix`，不碰仓库自己的索引和工作区，不用系统 `tar`），Windows、macOS、Linux 一样；树已经在 `.local/old-<版本>` 就跳过。`tests/extract-release.test.mjs` 钉住字节一致、CRLF 保留、仓库不被改动。

## 8. 复现

- 矩阵与证据一致性、三条性质：`node scripts/test.mjs tests/unified-runtime-rollback-read.test.mjs`（廉价，CI 里跑）。
- 演练本身（需要 `v2.7.1` 标签，解包到 `.local`，只用 fake）：`node tests/fixtures/runtime-s27/run-drill.mjs`、`runtime-s37`、`runtime-s49`、`runtime-s57` 各一个（各约几分钟，会重写对应的证据文件）。
