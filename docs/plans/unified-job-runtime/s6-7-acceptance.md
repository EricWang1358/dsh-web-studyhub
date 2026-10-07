# S6-7：统一运行时 alpha 总验收

核验日期：2026-10-07。分支 `codex/runtime-s67-acceptance`，基于 main `82478c27`（含 #355–#358；核验时没有未合并的 PR）。工作包文本见 [U42](sprints-2-6.md#u42-s6-7)；前序：[S6-0 覆盖复核](s6-0-coverage.md)、[S6-1 兼容核对](s6-1-compat.md)、[S6-2 只删无使用者的代码](s6-2-dead-only.md)、[S6-3 边界护栏](s6-3-boundaries.md)、[S6-4 新增任务的最小接入证明](s6-4-minimal-integration.md)、[S6-5 控制台矩阵（音频与 PDF 一侧）](s6-5-audio-console.md)与[即时请求入口](s6-5a-instant.md)、[S6-6 最终读兼容与回退](s6-6-rollback.md)。

**这份文件声明什么，不声明什么。** 它把 P1–P6 实际合并的 PR 和 SHA、剩余的旁路例外、不支持的能力和保留的历史 reader、证据入口放在一处，并记录合并前完整 `npm run verify` 的结果。它**没有**声明：任何 alpha 版本号、tag、GitHub 发布或"某个 commit 是 alpha"——这些需要所有者授权，见 §8（待定门禁）。23 个迁移开关**全部默认关闭**，关闭时一切与 2.7.1 相同（这是回退本身）；默认值没有翻转。不替正式 main 声明完成。

## 1. R1–R6 逐项可追溯

R 的定义见 [sprints-2-6.md 的 Requirements](sprints-2-6.md#requirements)。"证明"一栏是**在没有真实模型和宿主的条件下**能给出的证明；真实环境的部分在 §8。

| R | 内容 | 阶段验收文档 | 证明了什么（测试 / 证据） |
|---|---|---|---|
| R1 | P2 音频家族迁移 | [S2-7](s2-7-acceptance.md) | 六条音频路径（单文件、批次、字幕、复查、课堂保存、课堂校正）在一个服务里混跑，用量/通知/任务表只有一个来源（`tests/unified-runtime-audio-family.test.mjs`）；回退到 v2.7.1：旧版启动、已完成产物可读、批次/单文件续做，演练证据 `s2-7-evidence.json`（`unified-runtime-audio-evidence.test.mjs` 读它）；已记录的退化是批次"在途请求不重来"的保护。 |
| R2 | P3 出题、补题、选区补题、修题、发布，重启可见可继续、不重复提交 | [S3-7](s3-7-acceptance.md) | 五类任务混跑（`unified-runtime-generation-family.test.mjs`）；重启继续与"发布写入后回执前崩溃：看一眼，不重写"（`generation-restart.test.mjs`、`unified-runtime-publish.test.mjs`、`unified-runtime-supplement-publish.test.mjs`）；回退演练七个场景 `s3-7-evidence.json`，两个版本做完得到同样的库。 |
| R3 | P4 翻译、为你定制、每日总结、学习流、助手（+ 笔记起草 S4-10） | [S4-9](s4-9-rollback.md) | 四个家族在一个服务里同时在途，一个任务表、一个账本写入点、能力拒绝用同样的话、开关各自独立、策略开启时调用是宿主子代理（`unified-runtime-model-family.test.mjs`）；翻译不排在整库生成后面且同文档仍互斥（`unified-runtime-translation-scheduling.test.mjs`）；为你定制的 #234 行为保留（`model-family-baseline-coach*.test.mjs`）；回退演练六个家族 `s4-9-rollback-evidence.json`。 |
| R4 | P5 PDF 转换、Marker 安装、MinerU 配置、检索索引 | [S5-7](s5-7-acceptance.md)、[S5-6 矩阵](s5-6-recovery-matrix.md) | 四条路径与模型任务混跑、共同目录互斥（`unified-runtime-nonmodel-family.test.mjs`）；未知副作用/停止/恢复的路径 × 失败点矩阵；回退演练五个场景 `s5-7-evidence.json`。 |
| R5 | P6 删除无使用者的旧实现，新增普通任务无需内核分支 | [S6-2](s6-2-dead-only.md)、[S6-3](s6-3-boundaries.md)、[S6-4](s6-4-minimal-integration.md) | 调用图守卫：执行区域里没有"任何开关取值下都没有使用者"的代码，删过的不会回来（`unified-runtime-architecture.test.mjs`）；Job 模块五条边界规则、内核向下的依赖、持久化形状与回退夹具同进同退（`unified-runtime-boundaries.test.mjs`、`architecture-boundaries.test.mjs`、`unified-runtime-rollback-shape.test.mjs`）；合成新类型只注册定义和执行器就能 submit/list/status/wait/control/output（`unified-runtime-new-kind.test.mjs`，9 条），真实旁证是 S4-10（#333）。**未删的旧执行实现见 §4：它们是开关关闭时的默认路径，等默认值翻转。** |
| R6 | DSH 优先、唯一责任边界、行为保持、独立开关、alpha 交付约定 | [agent-rules.md](agent-rules.md)、[review-checklist.md](review-checklist.md) | 23 个开关各一行（`lib/runtime-config.js`），回退矩阵每个开关一行（`unified-runtime-rollback-read.test.mjs`）；模型只在一处被做出（`instant-model-guard.test.mjs`）、一处被计量；公共操作的名字解析（S6-1、#337、#358）；迁移前后同一组特征测试各跑一次（各家族 `*.runtime.test.mjs` 孪生）。 |

## 2. 工作包 → 已合并 PR 与合并 SHA

数据来自 `gh pr list --state merged`（合并提交的前 8 位）。每行写的是实际合并的 PR，不是计划。

| 工作包 | 内容 | 已合并 PR · 合并 SHA |
|---|---|---|
| P0 | 任务控制台、公共契约（2.6.0） | [#240](https://github.com/EricWang1358/dsh-web-studyhub/pull/240) `aa025925` |
| S1-0 | DSH 能力证据、基线与特征测试 | [#241](https://github.com/EricWang1358/dsh-web-studyhub/pull/241) `f091f09f` |
| S1-1 | 契约与版本读取兼容 | [#245](https://github.com/EricWang1358/dsh-web-studyhub/pull/245) `169a69ee`<br>[#255](https://github.com/EricWang1358/dsh-web-studyhub/pull/255) `1a432f5e` |
| S1-2 | 任务生命周期与旧控制委托 | [#260](https://github.com/EricWang1358/dsh-web-studyhub/pull/260) `b8ff5eef`<br>[#262](https://github.com/EricWang1358/dsh-web-studyhub/pull/262) `09a094ae` |
| S1-3 | 资源与许可 | [#264](https://github.com/EricWang1358/dsh-web-studyhub/pull/264) `5bbc22dc`<br>[#265](https://github.com/EricWang1358/dsh-web-studyhub/pull/265) `ed157f37`<br>[#267](https://github.com/EricWang1358/dsh-web-studyhub/pull/267) `48ff29c3` |
| S1-4 | 模型网关与 Call 记账 | [#270](https://github.com/EricWang1358/dsh-web-studyhub/pull/270) `6b6be21d`<br>[#272](https://github.com/EricWang1358/dsh-web-studyhub/pull/272) `be820896` |
| S1-5 | 持久化与恢复 | [#273](https://github.com/EricWang1358/dsh-web-studyhub/pull/273) `5c8342ea`<br>[#275](https://github.com/EricWang1358/dsh-web-studyhub/pull/275) `5aecc769` |
| S1-6 | 单文件音频试点 | [#276](https://github.com/EricWang1358/dsh-web-studyhub/pull/276) `9674a736`<br>[#279](https://github.com/EricWang1358/dsh-web-studyhub/pull/279) `4204d981` |
| S1-7 | 护栏、回退证据与交接 | [#281](https://github.com/EricWang1358/dsh-web-studyhub/pull/281) `8d661f4a` |
| S2-0 | 音频基线与内核分层 | [#282](https://github.com/EricWang1358/dsh-web-studyhub/pull/282) `dce6bdca`<br>[#283](https://github.com/EricWang1358/dsh-web-studyhub/pull/283) `e21c0d33` |
| S2-1 | 单文件音频（含 S2-1a 内核支持、S2-1b 宿主模型） | [#287](https://github.com/EricWang1358/dsh-web-studyhub/pull/287) `c5d6b170`<br>[#290](https://github.com/EricWang1358/dsh-web-studyhub/pull/290) `a1438ffd`<br>[#294](https://github.com/EricWang1358/dsh-web-studyhub/pull/294) `9d24aed3` |
| S2-2 | 音频批次 | [#301](https://github.com/EricWang1358/dsh-web-studyhub/pull/301) `228bb483` |
| S2-3 | 音频窗口与许可责任 | [#309](https://github.com/EricWang1358/dsh-web-studyhub/pull/309) `a03c6913` |
| S2-4 | 字幕导入 | [#311](https://github.com/EricWang1358/dsh-web-studyhub/pull/311) `d0caf93f` |
| S2-5 | 复查与课堂校正 | [#317](https://github.com/EricWang1358/dsh-web-studyhub/pull/317) `33dd8019` |
| S2-6 | 课堂保存 | [#325](https://github.com/EricWang1358/dsh-web-studyhub/pull/325) `1c9dd08b` |
| S2-7 | 音频混跑、回退演练与 P2 验收（含 S2-7b） | [#339](https://github.com/EricWang1358/dsh-web-studyhub/pull/339) `ee3dfeeb`<br>[#343](https://github.com/EricWang1358/dsh-web-studyhub/pull/343) `81118c77` |
| S3-0 | 出题基线与恢复矩阵 | [#285](https://github.com/EricWang1358/dsh-web-studyhub/pull/285) `427cfb8b` |
| S3-1 | 出题接入运行时 | [#295](https://github.com/EricWang1358/dsh-web-studyhub/pull/295) `2573b584` |
| S3-2 | 稳定 Step 身份与冻结输入 | [#302](https://github.com/EricWang1358/dsh-web-studyhub/pull/302) `08597f52` |
| S3-3 | 重启继续 | [#314](https://github.com/EricWang1358/dsh-web-studyhub/pull/314) `e528a63e` |
| S3-4 | 选区补题 | [#324](https://github.com/EricWang1358/dsh-web-studyhub/pull/324) `c5e02150` |
| S3-5 | 后台修题 | [#330](https://github.com/EricWang1358/dsh-web-studyhub/pull/330) `27949740` |
| S3-6 | 发布（含 3-6b 补题发布、3-6c 案例发布、3-6d 前台审阅） | [#336](https://github.com/EricWang1358/dsh-web-studyhub/pull/336) `8ed45413`<br>[#341](https://github.com/EricWang1358/dsh-web-studyhub/pull/341) `97016f3d`<br>[#342](https://github.com/EricWang1358/dsh-web-studyhub/pull/342) `cef91023`<br>[#351](https://github.com/EricWang1358/dsh-web-studyhub/pull/351) `c882ddeb` |
| S3-7 | 出题全家族混跑、回退演练与 P3 验收 | [#348](https://github.com/EricWang1358/dsh-web-studyhub/pull/348) `aaaa8f8b` |
| S4-0 | 模型任务基线与入口清单 | [#286](https://github.com/EricWang1358/dsh-web-studyhub/pull/286) `336d9c13` |
| S4-1 | 模型任务契约与共用接线 | [#288](https://github.com/EricWang1358/dsh-web-studyhub/pull/288) `8a663753` |
| S4-2 | 翻译 | [#312](https://github.com/EricWang1358/dsh-web-studyhub/pull/312) `65886a10` |
| S4-3 | 翻译不再排在整库生成后面 | [#320](https://github.com/EricWang1358/dsh-web-studyhub/pull/320) `eccf4cb0` |
| S4-4 | 为你定制 | [#292](https://github.com/EricWang1358/dsh-web-studyhub/pull/292) `dc719ab7` |
| S4-5 | 每日总结 | [#300](https://github.com/EricWang1358/dsh-web-studyhub/pull/300) `bd9b63b4` |
| S4-6 | 学习流 | [#305](https://github.com/EricWang1358/dsh-web-studyhub/pull/305) `31ca2e00` |
| S4-7 | 助手 | [#310](https://github.com/EricWang1358/dsh-web-studyhub/pull/310) `e4f60b10` |
| S4-8 | 子代理优先策略（每日总结、学习流） | [#321](https://github.com/EricWang1358/dsh-web-studyhub/pull/321) `46745469` |
| S4-9 | 模型家族混跑与回退演练 | [#327](https://github.com/EricWang1358/dsh-web-studyhub/pull/327) `662efd8f`<br>[#344](https://github.com/EricWang1358/dsh-web-studyhub/pull/344) `0ff865d3` |
| S4-10 | 笔记 AI 起草 | [#333](https://github.com/EricWang1358/dsh-web-studyhub/pull/333) `5fe165cb` |
| S5-0 | 非模型任务与副作用基线 | [#284](https://github.com/EricWang1358/dsh-web-studyhub/pull/284) `fd5c5a14` |
| S5-1 | 非模型执行与能力契约 | [#289](https://github.com/EricWang1358/dsh-web-studyhub/pull/289) `ea0bcc9a` |
| S5-2 | PDF 转换 | [#315](https://github.com/EricWang1358/dsh-web-studyhub/pull/315) `47b90977` |
| S5-3 | Marker 安装 | [#304](https://github.com/EricWang1358/dsh-web-studyhub/pull/304) `a0ab8304` |
| S5-4 | MinerU 配置 | [#306](https://github.com/EricWang1358/dsh-web-studyhub/pull/306) `fa5c7352` |
| S5-5 | 检索索引 | [#293](https://github.com/EricWang1358/dsh-web-studyhub/pull/293) `00355de5` |
| S5-6 | 未知副作用与停止/恢复矩阵 | [#316](https://github.com/EricWang1358/dsh-web-studyhub/pull/316) `5315320e` |
| S5-7 | 非模型混跑、回退演练与 P5 验收 | [#323](https://github.com/EricWang1358/dsh-web-studyhub/pull/323) `a9ecf46d` |
| S6-0 | 迁移覆盖与例外清单 | [#326](https://github.com/EricWang1358/dsh-web-studyhub/pull/326) `5c2cd934`<br>[#329](https://github.com/EricWang1358/dsh-web-studyhub/pull/329) `d207cf06` |
| S6-1 | 旧契约、ID 与扩展消费方兼容（含 job.* 认合同 jobId） | [#335](https://github.com/EricWang1358/dsh-web-studyhub/pull/335) `c1727e1e`<br>[#337](https://github.com/EricWang1358/dsh-web-studyhub/pull/337) `1563747f` |
| S6-2 | 只删无使用者的旧代码（调用图守卫） | [#340](https://github.com/EricWang1358/dsh-web-studyhub/pull/340) `136eae13` |
| S6-3 | 结构与 API 边界护栏 | [#349](https://github.com/EricWang1358/dsh-web-studyhub/pull/349) `ed0c8d97` |
| S6-4 | 新增普通任务的最小接入证明 | [#350](https://github.com/EricWang1358/dsh-web-studyhub/pull/350) `46f52dae` |
| S6-5 | 全家族控制台与兼容回归（含 5a 即时请求入口、5b 选区问答记账、音频与 PDF 控制台矩阵、任务名解析） | [#345](https://github.com/EricWang1358/dsh-web-studyhub/pull/345) `f85d87b7`<br>[#346](https://github.com/EricWang1358/dsh-web-studyhub/pull/346) `595fedc4`<br>[#356](https://github.com/EricWang1358/dsh-web-studyhub/pull/356) `46a9314c`<br>[#358](https://github.com/EricWang1358/dsh-web-studyhub/pull/358) `587604c2` |
| S6-6 | 最终读兼容与指定版本回退 | [#355](https://github.com/EricWang1358/dsh-web-studyhub/pull/355) `82478c27`<br>[#357](https://github.com/EricWang1358/dsh-web-studyhub/pull/357) `35ee13b3` |

**支撑 PR（不属于某个单独工作包）**

| PR · 合并 SHA | 内容 |
|---|---|
| [#297](https://github.com/EricWang1358/dsh-web-studyhub/pull/297) `9a0fc7c1` | 守卫认得网关步骤调用 |
| [#298](https://github.com/EricWang1358/dsh-web-studyhub/pull/298) `a8af8ac5` | 测试锁与机器负载解耦 |
| [#299](https://github.com/EricWang1358/dsh-web-studyhub/pull/299) `e23d55f2` | 每个迁移开关一行配置（`lib/runtime-config.js`） |
| [#303](https://github.com/EricWang1358/dsh-web-studyhub/pull/303) `a7301bc6` | 重新绑定等在途结算通知（修重试后的 revision-conflict） |
| [#308](https://github.com/EricWang1358/dsh-web-studyhub/pull/308) `3a4c6fa9` | Attempt 固定创建时的模型线路 |
| [#313](https://github.com/EricWang1358/dsh-web-studyhub/pull/313) `9b5beb9f` | lint 禁止重复对象键 |
| [#331](https://github.com/EricWang1358/dsh-web-studyhub/pull/331) `7abdc86e` | 落盘清单保持能被 2.7.1 读入 + 回退形状守卫 |
| [#332](https://github.com/EricWang1358/dsh-web-studyhub/pull/332) `9c0f3bbe` | 时序敏感测试等待状态、度量工作量 |
| [#334](https://github.com/EricWang1358/dsh-web-studyhub/pull/334) `d41db184` | S4-9 混跑测试在负载下稳定 |
| [#338](https://github.com/EricWang1358/dsh-web-studyhub/pull/338) `2c872020` | 库写入的进程内队列，文件锁只在进程间仲裁 |
| [#347](https://github.com/EricWang1358/dsh-web-studyhub/pull/347) `07d0759f` | 音频测试辅助：先 dispose 再删库 |
| [#352](https://github.com/EricWang1358/dsh-web-studyhub/pull/352) `d3b9ddf9` | 内核：成对的结算 sink，出题家族的通知经它 |
| [#353](https://github.com/EricWang1358/dsh-web-studyhub/pull/353) `1bc5761a` | 看板与笔记本登记同走进程内队列 |
| [#354](https://github.com/EricWang1358/dsh-web-studyhub/pull/354) `80b93f2f` | 翻译的会话通知成为进程内结算 sink |

## 3. 没有合并的东西

本文只引用已合并的 PR。截至核验，没有属于 P1–P6 的未合并 PR 被当作完成引用；A 道的"真实宿主 smoke 与浏览器控制台测试"证据在 §9 等待并入，**不在这里算作已有**。

## 4. 旧实现与旁路的剩余例外

清单：[`s1-7-legacy-exceptions.json`](s1-7-legacy-exceptions.json)；守卫 `unified-runtime-architecture.test.mjs`、`unified-runtime-boundaries.test.mjs`、`instant-model-guard.test.mjs` 对它们做**精确**匹配：新增一处调用、一处启动点或一处模型获取，必须先在清单里有一行（含负责人、理由、移除时点），否则测试变红。清单里 **18 个**定义是 `managed`（运行时的 Job 定义，由守卫逐个审计"不得绕过网关/不得自建任务表"）；其余全部在下面。

**数量**：模型形状的调用点 36 行、后台启动点 32 行（合计 88 个已审查的位置）、边界例外 13 行、模型获取例外 3 行。位置的处置：

| 处置 | 数量 | 含义 |
|---|---|---|
| `migrate`（开关全开后仍在运行时之外，须由某一步迁移） | **0** | 没有。每一个迁移位置都已迁移，没有"以后再迁"的静默旁路 |
| `delete-s6-2`（旧路径，开关全开后不可达） | 21 | 23 个开关默认关闭，所以这些旧路径**就是今天的默认路径**，关闭开关即回退。只有在默认值翻转之后才能删；清单里它们的移除时点都写 `after default flip`（守卫强制）。S6-2 已经删掉了那时就无使用者的部分 |
| `exception`（有意保留，写明类别和理由） | 67 | 见下表的类别与理由；没有"待定"类 |

**不是干净清零的几处，以及所有者对它们的决定（2026-10-07）：**

1. **出题与翻译 Job 的取消控制器登记（`generationControllers`）和每库队列（`queues`/`settled`）保留为控制适配与领域的排队顺序。** 它们原先写着 `removeAt: S6-5`，但 S6-5 交付的是控制台回归矩阵（音频与 PDF 一侧）、即时请求入口、选区问答记账和任务名解析，并没有把控制台控件改读内核、也没有用内核调度取代每库队列。决定：**保留**，清单里这六行现在写 `retained: cancel-controller registration is the control adapter` / `retained: library queue is the domain's admission order`，理由逐行更新；`tests/unified-runtime-boundaries.test.mjs` 和 `unified-runtime-acceptance-doc.test.mjs` 钉住新的写法，旧的 `S6-5` 标签回来会变红。要取消这个保留需要另立工作包。
2. **八条前台即时请求行**（capture、coach、followup、ingest、oral exam、rubric grading、`study`/`recording` 的操作）原先写着"owner decision at S6-5"。现在写 `decided in S6-5a (#345): no Job, metered through the gateway`：它们**保持即时**（不建 Job、不出卡片），经唯一的计量入口 `lib/runtime/instant.js` 共享 provider 配额并只记一次用量（[s6-5a-instant.md](s6-5a-instant.md)）。
3. **没有"模型获取"裸奔**：`modelServices(` 只在入口 `lib/runtime/instant.js`、定义 `lib/runtime/models.js` 和 `lib/service.js` 的兼容 getter 里被调用（三行，见下）。getter 随进程内旧执行器（上面 `delete-s6-2`）一起离开。

### 4.1 模型形状的调用点（36 行）

| 文件 | 负责人 | 类别 | 理由 | 移除时点 |
|---|---|---|---|---|
| `lib/assist.js` | existing domain maintainer | 旧路径（开关关时的默认）（删除待默认值翻转）；领域自己的结构（缓存/队列/单飞） | The original in-process assistant request; the panel list of recent requests stays | after default flip |
| `lib/audio-files.js` | runtime/domain maintainer | 不是任务 | Directory traversal queue of the audio file picker | retained |
| `lib/audio-gateway-calls.js` | audio family (lane A) | 服务商叶子实现 | The text provider leaf behind the gateway (host or Gemini) of an audio job on the runtime | retained: the provider leaf |
| `lib/audio-import.js` | existing domain maintainer | 共享流水线（模型由调用方传入） | The import pipeline takes its model as an argument: the gateway step on the runtime, the raw model only on the original path | S6-2 (original callers) |
| `lib/audio-job.js` | existing domain maintainer | 旧路径（开关关时的默认）（删除待默认值翻转） | importAudio has an original provider branch; jobTextModel serves the classroom save until S2-6 | after default flip |
| `lib/audio-review.js` | existing domain maintainer | 共享流水线（模型由调用方传入） | The review pipeline takes its model as an argument (the gateway step when audioReview is on) | S6-2 (original callers) |
| `lib/batch.js` | existing domain maintainer | 共享流水线（模型由调用方传入） | The generation pipeline takes its model as an argument (the gateway step when generation is on) | S6-2 (original callers) |
| `lib/capture.js` | existing domain maintainer | 前台即时请求 | capture.question: one awaited request, no job record (decision S4-0: instant model requests stay instant) | decided in S6-5a (#345): no Job, metered through the gateway |
| `lib/coach.js` | existing domain maintainer | 前台即时请求；共享流水线（模型由调用方传入） | Coach: the prep batch is a Job when coach is on; nudge, debrief and rewrite are instant requests (decision S4-0) | decided in S6-5a (#345): no Job, metered through the gateway |
| `lib/contexts/audio/jobs/live-correction-models.js` | audio family (lane A) | 服务商叶子实现 | The Gemini text provider leaf of a class correction on the runtime | retained: the provider leaf |
| `lib/contexts/audio/worker.js` | existing domain maintainer | 会话子系统；旧路径（开关关时的默认）（删除待默认值翻转） | liveTranslation (per-sentence live translation) stays with the session; the original correction call is bypassed | after default flip |
| `lib/contexts/authoring/publication.js` | existing domain maintainer | 前台即时请求 | The review before a publication. Asked outside a Job (the learner or an agent calls draft.publish itself) it is an instant request: the model of the … | stays; the Job-owned legacy half goes with startLegacy at S6-2 |
| `lib/contexts/generation/operations.js` | existing domain maintainer | 前台即时请求 | generate.suggest is one awaited request, never a background job | never; the suggestion stays |
| `lib/contexts/notes/daily-generation.js` | existing domain maintainer | 共享流水线（模型由调用方传入） | The recap pipeline takes its model as an argument (the gateway step when dailyRecap is on) | S6-2 (original caller) |
| `lib/contexts/notes/note-generation.js` | existing domain maintainer | 共享流水线（模型由调用方传入） | The note draft body takes its model as an argument (the gateway step when noteGenerate is on) | S6-2 (the in-process caller) |
| `lib/contexts/recording/operations.js` | existing domain maintainer | 前台即时请求 | capture: one awaited request (decision S4-0) | decided in S6-5a (#345): no Job, metered through the gateway |
| `lib/contexts/study/operations.js` | existing domain maintainer | 前台即时请求 | card.grade: one awaited rubric grading request | decided in S6-5a (#345): no Job, metered through the gateway |
| `lib/daily-recap.js` | existing domain maintainer | 共享流水线（模型由调用方传入） | The recap rewrite takes its model as an argument | S6-2 (original caller) |
| `lib/followup.js` | existing domain maintainer | 前台即时请求 | A follow-up question: one awaited request (decision S4-0) | decided in S6-5a (#345): no Job, metered through the gateway |
| `lib/generation.js` | existing domain maintainer | 共享流水线（模型由调用方传入） | The generation pipeline takes its model as an argument (the gateway step when generation is on) | S6-2 (original callers) |
| `lib/index.js` | existing domain maintainer | 服务商叶子实现 | The host model adapter: DSH ctx.llm.stream and the host sub-agent route; the gateway reaches the model through it | retained: the provider leaf |
| `lib/ingest.js` | existing domain maintainer | 前台即时请求 | Pasted-material ingest: one awaited request | decided in S6-5a (#345): no Job, metered through the gateway |
| `lib/jobs/gateway.js` | runtime kernel maintainer | 内核 | The approved model gateway of the runtime | retained |
| `lib/library-usage.js` | runtime/domain maintainer | 不是任务 | Directory traversal queue of the storage-usage report | retained |
| `lib/live-job.js` | existing domain maintainer | 旧路径（开关关时的默认）（删除待默认值翻转） | The classroom save pipeline (proofread): original runner until S2-6 | after default flip |
| `lib/live.js` | existing domain maintainer | 会话子系统 | Per-sentence live translation of a class | retained: with the session |
| `lib/oral-exam-service.js` | existing domain maintainer | 前台即时请求 | Oral exam turns: awaited requests | decided in S6-5a (#345): no Job, metered through the gateway |
| `lib/rubric-grading.js` | existing domain maintainer | 前台即时请求 | Rubric grading of one answer: one awaited request (card.grade) | decided in S6-5a (#345): no Job, metered through the gateway |
| `lib/runtime/builtins.js` | runtime/domain maintainer | 不是任务 | Static capability and name arrays, not live task collections | retained |
| `lib/runtime/domain-contracts.js` | runtime/domain maintainer | 不是任务 | Static schema and capability arrays, not live task collections | retained |
| `lib/runtime/models.js` | existing domain maintainer | 服务商叶子实现 | The host model adapter handed to the contexts (prepares the request, keeps spawnCorrection) | retained: the provider leaf |
| `lib/runtime/tasks.js` | runtime/domain maintainer | 公开 API | Extension task queues (public API) | retained (S6-1 checks the compatibility) |
| `lib/runtime/work.js` | runtime/domain maintainer | 内核；领域自己的结构（缓存/队列/单飞） | The work object: the job table the console reads plus the domain single-flight tables of the legacy executors | retained: the console reads the job table and the library queue is the domain's admission order (S6-7) |
| `lib/sample-library.js` | runtime/domain maintainer | 不是任务 | Queues of the synthetic sample library | retained |
| `lib/translation.js` | existing domain maintainer | 共享流水线（模型由调用方传入） | The translation pipeline takes its model as an argument (the reader asks it directly; the translate card is a Job when translation is on) | retained; S6-2 (original callers) |
| `lib/workflow-teaching.js` | existing domain maintainer | 旧路径（开关关时的默认）（删除待默认值翻转） | The in-process teaching call (the Job runs it behind the gateway when workflow is on) | after default flip |

### 4.2 后台启动点（32 行）

| 文件 | 负责人 | 类别 | 理由 | 移除时点 |
|---|---|---|---|---|
| `lib/contexts/audio/convert.js` | audio family (lane A/D) | 旧路径（开关关时的默认）（删除待默认值翻转）；历史读取适配 | startConvertJob: the original conversion run (job record, retry entry, cancel controller) | after default flip |
| `lib/contexts/audio/operations.js` | audio family (lane A) | 会话子系统；旧路径（开关关时的默认）（删除待默认值翻转） | live.start: the live class session (a connection with its own lifecycle; its correction and its save are the jobs) | after default flip |
| `lib/contexts/audio/setup/legacy-setup-run.js` | non-model family (lane D) | 旧路径（开关关时的默认）（删除待默认值翻转） | the original background run of the local MinerU setup | after default flip |
| `lib/contexts/audio/worker.js` | audio family (lane A) | 旧路径（开关关时的默认）（删除待默认值翻转）；历史读取适配 | startAudioJob: the original audio runner. With the five audio switches on (audioLiveSave included, S2-6) nothing calls it | after default flip |
| `lib/contexts/coach/worker.js` | coach family (lane C) | 领域自己的结构（缓存/队列/单飞）；旧路径（开关关时的默认）（删除待默认值翻转） | coachTask: the library lane that queues a prep batch (its body is a Job when coach is on) and runs a card rewrite | after default flip |
| `lib/contexts/generation/jobs/generation.js` | generation family (lane B) | 控制适配 | the Job registers its cancel controller in the legacy table the console controls read (until the controls read the kernel) | exception |
| `lib/contexts/generation/jobs/submit-generation.js` | generation family (lane B) | 旧路径（开关关时的默认）（删除待默认值翻转） | startLegacy: the original generation run (job record, controller, control, queue turn); also the original run of the selected-passage supplement (S3-… | after default flip |
| `lib/contexts/generation/operations.js` | generation family (lane B) | 历史读取适配 | coverage.recover: a coverage run the last process left unfinished comes back as an interrupted record read from its draft marker (runs kept on disk b… | exception |
| `lib/contexts/generation/retrieval/legacy-index-run.js` | non-model family (lane D) | 旧路径（开关关时的默认）（删除待默认值翻转） | the original background run of the search-index build | after default flip |
| `lib/contexts/generation/selection.js` | generation family (lane B) | 领域自己的结构（缓存/队列/单飞） | the single-flight table of selection operations (an operation id is answered once) | exception |
| `lib/contexts/generation/translation-jobs.js` | translation family (lane C) | 旧路径（开关关时的默认）（删除待默认值翻转） | the original translation card run (job record, controller, control) | after default flip |
| `lib/contexts/generation/translation/jobs/translation.js` | translation family (lane C) | 控制适配 | the Job registers its cancel controller in the legacy table the console controls read | exception |
| `lib/contexts/jobs/operations.js` | jobs context | 历史读取适配 | job.* : history rows of the runtime restored into the job table, read-only | exception |
| `lib/contexts/materials/translation-operations.js` | translation family (lane C) | 领域自己的结构（缓存/队列/单飞） | the cancel handles of a reader translation call that named a requestId | exception |
| `lib/contexts/notes/daily.js` | notes family (lane C) | 领域自己的结构（缓存/队列/单飞）；旧路径（开关关时的默认）（删除待默认值翻转） | the pending generation of a recap (supersede and catch-up); the run itself is a Job when dailyRecap is on | after default flip |
| `lib/contexts/notes/operations.js` | notes family (lane D) | 领域自己的结构（缓存/队列/单飞）；旧路径（开关关时的默认）（删除待默认值翻转） | the pending draft of a note: what a save, a delete or an unloaded plugin stops it by (the draft itself is a Job when noteGenerate is on) | after default flip |
| `lib/generation-continuable.js` | runtime/domain maintainer | 服务商叶子实现 | the host sub-agent of a continuable generation phase (agent execution mode behind the model route) | exception |
| `lib/groq.js` | audio family (lane A) | 服务商叶子实现 | ffmpeg decode and cut of the audio windows, inside an audio Job (stopped with it; not recorded as a Call) | exception |
| `lib/host-capabilities.js` | runtime kernel maintainer | 服务商叶子实现 | startBoundedChild: the one place a host sub-agent is started (the gateway uses it, for the policies that prefer an agent: dailyRecapAgent, workflowAg… | exception |
| `lib/job-control.js` | runtime/domain maintainer | 控制适配 | the pause-boundary poll of a job control (the console controls of generation, translation and audio read it) | exception |
| `lib/jobs/lifecycle/control.js` | runtime kernel maintainer | 内核 | the kernel writes its own job into the job table | exception |
| `lib/jobs/lifecycle/job-record.js` | runtime kernel maintainer | 内核 | the kernel puts its job under its owner | exception |
| `lib/jobs/lifecycle/scoped.js` | runtime kernel maintainer | 内核 | the kernel writes its own job into the job table | exception |
| `lib/live-correction.js` | audio family (lane A) | 旧路径（开关关时的默认）（删除待默认值翻转） | the rolling-correction timer of a class; a managed class (audioLiveCorrection) starts none | after default flip |
| `lib/live.js` | audio family (lane A) | 会话子系统 | the watchdog of a live class connection | exception |
| `lib/local-command.js` | non-model family (lane D) | 服务商叶子实现 | runLocalCommand: the one runner of local programs (process tree stop, KILL_WAIT_MS) | exception |
| `lib/marker-install.js` | non-model family (lane D) | 服务商叶子实现；领域自己的结构（缓存/队列/单飞）；旧路径（开关关时的默认）（删除待默认值翻转） | the install stages (venv, pip, check) inside begin(): a Call of the Job when markerInstall is on | after default flip |
| `lib/marker-local.js` | non-model family (lane D) | 前台即时请求；服务商叶子实现 | detectMarker: the instant "is Marker ready" question (awaited by the caller) | exception |
| `lib/mineru-local.js` | non-model family (lane D) | 服务商叶子实现 | runCli: status, server start and the parse windows of a local conversion | exception |
| `lib/runtime/tasks.js` | runtime/domain maintainer | 公开 API | extension tasks (kind extension): a published public API of the plugin; no model gateway | exception |
| `lib/workflow-skeleton.js` | workflow family (lane C) | 领域自己的结构（缓存/队列/单飞）；旧路径（开关关时的默认）（删除待默认值翻转） | the single-flight table of skeleton generation (the run is a Job when workflow is on) | after default flip |
| `lib/workflow-teaching.js` | workflow family (lane C) | 领域自己的结构（缓存/队列/单飞）；旧路径（开关关时的默认）（删除待默认值翻转） | the single-flight table of teachings (the run is a Job when workflow is on) | after default flip |

### 4.3 边界例外（13 行，S6-3）

| 文件 | API（规则，次数） | 理由 | 移除时点 |
|---|---|---|---|
| `lib/contexts/audio/jobs/live-correction-models.js` | `tiers.complete`（gateway-bypass，1） | The Gemini text leaf of a class correction: the call runs inside a gateway step of the correction Job (`gateway.step(...)`), this… | retained: the provider leaf |
| `lib/contexts/audio/jobs/live-correction-models.js` | `../../../gemini.js`（provider-import，1） | The Gemini text leaf of a class correction: the call runs inside a gateway step of the correction Job (`gateway.step(...)`), this… | retained: the provider leaf |
| `lib/contexts/audio/jobs/text-model.js` | `../../../gemini.js`（provider-import，1） | Builds the Gemini tiers the text steps of an audio Job run on, inside gateway steps; no request is made here | retained: the provider leaf |
| `lib/contexts/generation/jobs/generation.js` | `binding.work.generationControllers.set`（public-table-write，1） | The Job puts its cancel controller where the console controls (job.control) read it: this registration is the control adapter | retained: cancel-controller registration is the control adapter |
| `lib/contexts/generation/jobs/library-queue.js` | `queues.delete`（public-table-write，1） | The per-library queue Jobs of generation and translation wait in; S3-1 kept it as the scheduling order: the library queue is the … | retained: library queue is the domain's admission order |
| `lib/contexts/generation/jobs/library-queue.js` | `queues.set`（public-table-write，1） | The per-library queue Jobs of generation and translation wait in; S3-1 kept it as the scheduling order: the library queue is the … | retained: library queue is the domain's admission order |
| `lib/contexts/generation/jobs/library-queue.js` | `settled.delete`（public-table-write，1） | The per-library queue Jobs of generation and translation wait in; S3-1 kept it as the scheduling order: the library queue is the … | retained: library queue is the domain's admission order |
| `lib/contexts/generation/jobs/library-queue.js` | `settled.set`（public-table-write，1） | The per-library queue Jobs of generation and translation wait in; S3-1 kept it as the scheduling order: the library queue is the … | retained: library queue is the domain's admission order |
| `lib/contexts/generation/jobs/submit-generation.js` | `work.generationControllers.set`（public-table-write，1） | startLegacy: the original generation path (switch generation off) writes its own table, controller and control | after default flip |
| `lib/contexts/generation/jobs/submit-generation.js` | `work.jobControls.set`（public-table-write，1） | startLegacy: the original generation path (switch generation off) writes its own table, controller and control | after default flip |
| `lib/contexts/generation/jobs/submit-generation.js` | `work.jobs.set`（public-table-write，1） | startLegacy: the original generation path (switch generation off) writes its own table, controller and control | after default flip |
| `lib/contexts/generation/translation/jobs/translation.js` | `task.work.generationControllers.set`（public-table-write，1） | The Job puts its cancel controller where the console controls (job.control) read it: this registration is the control adapter | retained: cancel-controller registration is the control adapter |
| `lib/contexts/study/jobs/submit-assist.js` | `../../../host-capabilities.js`（provider-import，1） | Imports `abortable`, a stop helper; no host request is made by this module | retained: a stop helper |

### 4.4 模型获取（3 行，S6-5a）

| 文件 | 处置 | 理由 | 移除时点 |
|---|---|---|---|
| `lib/runtime/instant.js` | entry | The one metered entry: every request's and executor's model services are made here, usage booked once, instant requests under the… | stays |
| `lib/runtime/models.js` | definition | Defines modelServices (language, local-content preparation, the light route) and uses it for the host's own service object | stays |
| `lib/service.js` | exception | StudyService's compatibility getters (complete, light, fetch, WebSocket) hand the host's model to in-process callers that predate… | S6-2 (the in-process executors) with the callers that read them |

## 5. 不支持的能力，和为历史保留的 reader（逐项）

### 5.1 不支持（如实，不假装有）

1. **共享 provider 配额下的出题与翻译**：开启 `runtime.resources.sharedProviderQuota` 时，运行时路径的出题、翻译**拒绝启动**（`capability-unverified`），因为它们的模型调用还没有被观测边界覆盖。音频有自己的许可层；即时请求用 `instant-text` 租约（[S6-5a](s6-5a-instant.md)）。（[S3-7 §8](s3-7-acceptance.md)、S4-2）
2. **暂停**：只有音频单文件、音频批次和翻译有检查点暂停；其余家族 `pauseMode: unsupported`，控制台不出现暂停按钮（[S6-5 矩阵](s6-5-audio-console.md)按声明断言）。
3. **重试**：出题家族（结束后）、音频（课堂校正除外）、PDF 转换有；课堂校正、翻译、为你定制、每日总结、学习流、助手、笔记起草只有取消，"再来一次"是重新开始。
4. **重启后的恢复**：只有 `generationRestart` 的出题运行、音频单文件/批次的 manifest 和 PDF 转换的"已中断"记录能被接着做。其余定义 `recoveryMode: none`：字幕、复查、课堂保存、课堂校正重启后任务消失（D-9，与 2.7.1 相同）；笔记起草与学习流讲解被结束后一直显示"运行中"直到再开始一次（与 2.7.1 相同）。（[S2-7 §8](s2-7-acceptance.md)、[S4-9 §3](s4-9-rollback.md)）
5. **子代理优先策略只有 fake 宿主证据**：`dailyRecapAgent`/`workflowAgent` 默认关；真实宿主下重启后的子任务归属缺证据（V2，[S3-7 §8](s3-7-acceptance.md)）；没有 Agent 的真实宿主行为未验（V-7，[S5-7 §8](s5-7-acceptance.md)）。
6. **三份单文件持久化的 `version` 只写不校验**（S6-1 缺口 B）：`job-archive.json`、PDF 转换 manifest、`marker-install.json` 遇到未知版本会当 v1 读、下次写入改成 v1。运行时没有改过这三份的格式，所以今天没有错读；将来任何格式升级前必须先补校验。（内核任务存储、音频 manifest 的 `runtimeJob`、归档里的合同遇到未知版本是**明确拒绝**，S6-6 钉住不改写。）
7. **扩展任务服务 `context.work` 不是统一运行时**：没有网关、没有 Attempt，只是共享任务表里的一行，只提供取消（S6-1 §5，6 条测试固定其行为）。
8. **即时请求没有 Job**：capture、卡片批改、追问、导入、口语考试等一次一答的请求不建任务、不出卡片；它们的排队等待计数只在内存里，随进程重置（[S6-5a](s6-5a-instant.md)）。
9. **云端与本地 PDF 转换共用一个闸门**（D-11，同库一次一个，与 2.7.1 相同）；拆开是单独的策略开关，没做。
10. **外部副作用的已知限制**：MinerU 云端只能按批次号查询（V-1：创建回复丢失又没存批次号时只能拒绝）；Windows `taskkill` 的真实退出时机未在真机验证（V-4）；设置只能在设置页改（D-10/V-8，#291 的产品决定）；安装与配置不持久化，重启后不主动找旧进程，只显示"已中断/空闲"（[S5-7 §8](s5-7-acceptance.md)）。
11. **旧默认路径还在**：见 §4，21 个位置等默认值翻转；翻转前"所有开关关"就是回退，也是 2.7.1 的行为。

### 5.2 为历史保留的 reader

| reader | 读什么 | 为什么留 | 遇到未知/新格式 |
|---|---|---|---|
| 内核任务存储 `lib/jobs/store.js` | `schemaVersion: 1` 的 manifest（`runtimeJob`） | 重启后恢复、回退再前进 | 明确拒绝（`unsupported-store-version`），字节不改（S6-6） |
| `readJobContract`（`lib/jobs/contract.js`） | 归档里的 `contractVersion` 1 与 2 | `job.unarchive` 与历史行 | 明确拒绝，先于任何改动（`unified-runtime-archive-read`） |
| `<库>/job-archive.json` 本身 | `{ version: 1, records }` | 归档列表 | **不校验**（§5.1 第 6 条） |
| `recoverAudioBatches` | 上个进程留下的批次/单文件文件夹与信箱信 | 开关关闭或旧数据：只读/只能重试的卡 | 读 manifest 的 `runtimeJob`：未知 schema 明确拒绝 |
| `recoverConvertJobs` / `conversion-history` | 未完成的转换变成"已中断，可接着做"，接着做开一个 Job | PDF | 单条损坏丢弃，不影响其他 |
| `coverage.recover` | 上个进程留下的覆盖运行，从草稿标记读出为"已中断" | 出题（`generationRestart` 下的运行经内核回来） | 按草稿计划恢复 |
| `generation-runs/<id>.json`（`lib/generation-run-store.js`） | 出题运行的请求与运行时记录 | 重启继续 | 输入变了/定义版本不符：`input-changed`、`definition-version-mismatch`，拒绝恢复 |
| `job.*` 的历史行 | 运行时任务在重启后读回任务表的只读行 | 控制台 | 只读 |

清单里标 `read-adapter` 的 5 个位置（`convert.js` 两处、`worker.js`、`generation/operations.js`、`jobs/operations.js`）就是上表的前几行，在 §4.2 里。

## 6. 证据索引

| 范围 | 文档 | 证据文件 / 测试 |
|---|---|---|
| 固定回退目标（`v2.7.1` / `47f132815fc2fa65c7352f3f536109bb9c3ddd96`）、最终矩阵 | [S6-6](s6-6-rollback.md) | `unified-runtime-rollback-read.test.mjs`、`unified-runtime-rollback-shape.test.mjs`、`tests/fixtures/release-2.7.1/` |
| 音频回退 | [S2-7](s2-7-acceptance.md) | `s2-7-evidence.json`、`unified-runtime-audio-evidence.test.mjs` |
| 出题回退 | [S3-7](s3-7-acceptance.md) | `s3-7-evidence.json`、`unified-runtime-generation-evidence.test.mjs` |
| 模型家族回退（含为你定制） | [S4-9](s4-9-rollback.md) | `s4-9-rollback-evidence.json`、`unified-runtime-model-evidence.test.mjs` |
| 非模型回退与矩阵 | [S5-7](s5-7-acceptance.md)、[S5-6](s5-6-recovery-matrix.md) | `s5-7-evidence.json`、`unified-runtime-nonmodel-evidence.test.mjs` |
| 控制台矩阵（音频与 PDF 一侧）、任务名 | [S6-5](s6-5-audio-console.md)、[S6-1](s6-1-compat.md) | `unified-runtime-audio-console.test.mjs`、`unified-runtime-pdf-console.test.mjs`；各家族的混跑测试同样只经公共操作读（`unified-runtime-{audio,generation,model,nonmodel}-family.test.mjs`）。**没有一份把所有家族放在一张表里的控制台矩阵**；浏览器里的控制台测试由 A 道在 §9 补 |
| 新增普通任务的最小接入证明 | [S6-4](s6-4-minimal-integration.md) | `unified-runtime-new-kind.test.mjs`（9 条合成）、S4-10（#333）真实旁证 |
| 旧代码删除与例外 | [S6-0](s6-0-coverage.md)、[S6-2](s6-2-dead-only.md)、[S6-3](s6-3-boundaries.md) | `s1-7-legacy-exceptions.json` + 三个守卫 |
| 即时请求入口 | [S6-5a](s6-5a-instant.md) | `instant-ledger-characterization.test.mjs`、`unified-runtime-instant.test.mjs`、`instant-model-guard.test.mjs` |
| 契约与每个家族的公开形状 | [../../job-contract.md](../../job-contract.md) | 文末"最终状态（S6-7）"一节 |
| 演练是否在 CI 里 | [S6-6 §7](s6-6-rollback.md) | **不在**：四个演练（`tests/fixtures/runtime-s{27,37,49,57}/run-drill.mjs`）要旧版树和几分钟，发布前手工重跑；CI 只读证据文件。解包已不依赖系统 `tar`（#357） |

## 7. 完整 verify 记录

**完整 `npm run verify` 通过**，在提交 `3934ff7746ecc2408391a652caa6335bda23b880`（本 PR 的代码与清单状态；记录这次运行的提交只改本文件的这一节）上：

| 项 | 记录 |
|---|---|
| 命令 | `npm run verify`（= `npm run lint && npm test && npm run build`；`npm test` = `node scripts/test.mjs`，即完整套件，不是 `test:fast`，没有缩小范围） |
| 环境 | Windows；`TEMP`/`TMP`/`TMPDIR` 指向工作区内的私有目录 `.local/verify-temp`；`SSH_TTY=audit`；进程环境里所有 `*_API_KEY`、`*_TOKEN`、`*BASE_URL` 先清掉（`scripts/test.mjs` 还会再清一次并给每次运行一个私有 `DSH_HOME`）；**没有设置 `STUDY_TEST_NO_LOCK`**（机器级测试锁没有被绕过）；没有网络与真实模型 |
| lint | 通过（`eslint lib scripts tests ui packages eslint.config.js`，无输出） |
| 测试 | **tests 6857；pass 6845；fail 0；cancelled 0；skipped 12；todo 0**；耗时 331.6 s（整个 verify 340 s） |
| build | 通过（`Built DSH client modules and standalone preview`） |
| 之前的一次 | 同一条命令在 `662802e6396fb7d4463977fa7cf7519bad490c2d`（清单标签修改之前）上也通过：6856 个测试里 6844 通过、0 失败、12 跳过，342 s。两次之间只改了清单的 `removeAt`/理由文字、两处守卫断言和本文 |

这是在本机、fake 模型下的结果。它**不是**真实模型、真实宿主或真实安装包的验证，也不是 CI 在两个平台上的结果（CI 对 PR 的最终提交另外跑）；那些见 §8。

## 8. 待定门禁（PENDING，只有所有者授权后才能做）

下面每一项都**没有**做，也没有被写成做过。每项写明它还缺什么。

| 门禁 | 状态 | 还缺什么 |
|---|---|---|
| 真实模型质量抽检 | **PENDING** | 所有者对线路与预算的授权；每个受影响家族（出题、补题、翻译、每日总结、学习流、为你定制、助手、笔记起草、音频文本）固定输入、模型、档位、预算；运行时 vs 进程内、`agent-preferred` vs 直连各一组；记录质量、耗时、请求数、用量、样本范围。同时测 `INSTANT_COOLDOWN_MS`（5 s）与 `instant-text` 租约上限在真实服务商上的合适值。（[Verification Contract 的"模型质量"行](sprints-2-6.md#verification-contract)） |
| alpha 版本号 / tag / GitHub 发布 | **PENDING，未记录任何版本** | 所有者决定版本号与要翻转默认值的开关；翻转后才能删 `delete-s6-2` 的旧路径（§4）；发布流程（从 `codex/studyhub-<版本>` 开 PR、所有者合并、在 main 上打包、`gh release create`）。本文**不**把任何 commit 记为 alpha 或已发布。 |
| 真实安装包 | **PENDING** | 真实 Windows 上从安装包安装、在 2.7.1 之上升级、再换回 2.7.1 的全流程；演练只验证了"同一个库交给两棵代码树"，用的是 fake 与 `process.exit`，不是用户换安装包 |
| 真实宿主 smoke 与浏览器控制台测试 | **部分完成，见 §9** | 已做：非模型路径在隔离的真实 DSH 上 18/18，控制台浏览器测试开关全关、全开各 54/54，1280/420 截图。仍待定：所有模型路径、复查、检索索引构建、PDF 本地转换、Marker/MinerU 安装、宿主内重启恢复、150% 缩放 |
| `npm run qa:dsh`（React 18 宿主 vs 预览的 React 19） | **PENDING（所有者在 alpha 前跑）** | 联网安装 DSH rc.2；S6-5a 的用量页新增一行，不依赖 React 版本相关接口，但需要在真实宿主里看一眼 |
| 真实音频与外部工具 | **PENDING** | 真实 Gemini 转写一段真实录音（含窗口、429、取消）；一堂约 90 分钟的真实课堂校正；真实 MinerU 云端与本地、Marker 安装、搜索扩展；宿主没有 Agent 时的行为；Windows `taskkill` 真机退出时机 |

## 9. 宿主与浏览器证据

全文见 [s6-7-host-evidence.md](s6-7-host-evidence.md)（#361，截图与脱敏的 `summary.json` 在 `evidence/`，复现命令 `npm run qa:dsh-runtime`）。摘要：

- 环境：本机 DSH 0.2.0-rc.2，从 main `82478c27` 打包的插件，私有 `DSH_HOME`/`TEMP`/`TMP`，清空所有 key/token/base-url 变量，`SSH_TTY=audit`，插件配置里 23 个迁移开关全开；唯一的模型是本地 fake。
- 真实宿主 18/18：运行时字幕任务（`contractVersion: 2`，执行者 `dsh-jobs`）运行中可见、按卡片 id 与契约 id 都能查、拒绝都是学习者的话、停止后再停被拒（`job-ended`）、关闭、第二个任务完成、归档与取消归档；控制台里真实点击 停止 → 勾选 → 删除 → 确认删除；1280/420 无横向溢出、无控制台或页面错误；收尾后 `~/.dsh`、`~/.mineru` 不变，无残留进程与端口。
- 控制台浏览器测试及配套边界测试：开关全关 54/54、全开 54/54，0 跳过。
- 发现：F-1 控制台把所有音频家族卡片都叫「音频批量转写」，由 #362 修复；F-2 QA 的 fake 模型接不住经 DSH 子代理转来的提示，已在 #361 的 harness 里修复；F-3 `mineru.local.status` 会只读地运行一次本机已装的 mineru 取版本号。
- 没有跑（理由见该文 §7）：所有模型路径、复查、检索索引构建、PDF 本地转换、Marker/MinerU 安装、云端 PDF、宿主内重启恢复。

## 10. 交接

- 下一步（所有者）：§8 的每一项；决定默认值翻转的范围，之后删除 `delete-s6-2` 的旧路径。§4 的第 1、2 条已经决定（保留控制适配、即时请求保持即时）。`job-archive.json` 等三份版本字段的校验（§5.1 第 6 条）在 #360（未知 `version` 在读取时明确拒绝）。
- 复现本文的数字：`gh pr list --state merged`（§2）；`node scripts/test.mjs tests/unified-runtime-architecture.test.mjs tests/unified-runtime-boundaries.test.mjs tests/instant-model-guard.test.mjs tests/unified-runtime-acceptance-doc.test.mjs`（§4 的清单与本文一致）；演练见 [S6-6 §8](s6-6-rollback.md)。
