# Sprint 1：P1 最小内核 + 单文件音频试点

> 目标：一个真实任务（单文件音频导入）完整跑在公共内核上，同时留下继续迁移下一条路径所需的稳定接口。不迁移其他任务，不改变用户可见行为（除非下面某一步明确写了开关）。

**开工前提**：2.6.0 已发布（任务控制台与 `docs/job-contract.md` 契约 v1 已在 main）。

**角色**：一名「内核负责人」拥有 `lib/jobs/**`、契约文档与对应测试的合并权；其他人（任何代理）只通过已发布接口工作，接口缺口先在 PR 里改契约文档，由内核负责人合并。

每一步完成后，在本文件对应行打勾，并写上已合并 PR 与验证所用 SHA。依赖顺序为 **P0 门禁 → S1-0 评审 → S1-1 → S1-2 → S1-3 → S1-4 → S1-5 → S1-6 → S1-7**；可以提前只读调研，不能绕过前置门禁写生产代码。

目标文件名表示职责入口，不要求重复建立已有实现；是否保留、提取或委托现有模块，由 S1-0 的证据决定。S1-3 首先接入试点实际用到的资源，不提前迁移其他任务。新增自动恢复、调度策略或子代理策略保持独立开关；试点开关不同时启用这些改进。

## 接手记录

| 步骤 | 状态 | 负责人 / 分支 / 文件范围 | 前置评审与已合并 PR | 验证 SHA / 证据 | 未确认项 / 下一步 |
|---|---|---|---|---|---|
| S1-0 | 已合并 | Codex 集成负责人 / codex/unified-runtime-alpha / 本目录审计、tests/audio-single-characterization 与 fixture、slow-tests 清单 | 所有者接受已验证范围及待核验限制并授权合并 [#241](https://github.com/EricWang1358/dsh-web-studyhub/pull/241) | head 6b1ecedb69308ec44078f10c24975eb2a6a2aef7；merge f091f09f830c226bfebc9af22344896733893a10；[本地及 CI 证据](s1-0-baseline.md) | 最终 StudyHub owner/controller 绑定等限制仍阻断对应实现步骤 |
| S1-1 | 受阻 | Codex 内核负责人 / codex/unified-runtime-alpha / 契约与版本读取兼容范围 | 契约 [#245](https://github.com/EricWang1358/dsh-web-studyhub/pull/245)、读取兼容 [#255](https://github.com/EricWang1358/dsh-web-studyhub/pull/255) 已合并 | #255 head c092d7ac8e73228091a9d0a0a7c04e6b82f64570；merge 1a432f5e9cf166398385174cf1ec047f16cfceef；[历史验证](s1-1-compatibility-implementation.md) | 仅所列交付已合并，不勾选整步；live facade/执行绑定仍待 S1-2，持久化待 S1-5 |
| S1-2 | 已合并 | Codex 云端内核负责人 / codex/runtime-s12-lifecycle / 注册、生命周期、原生绑定与旧入口 | 所有者 2026-10-06 02:28:22 UTC 验收并授权合并 [#262](https://github.com/EricWang1358/dsh-web-studyhub/pull/262) | head 78f83a8；merge 09a094ae54c6afc68982ed5bc7d21a5a92d46b2e；双平台 CI 与实际宿主 8 步见 PR | S1-2 限定范围已接受；持久化、音频试点和共享配额策略仍保留后续门禁 |
| S1-3 | 进行中 | Codex 云端内核负责人 / codex/runtime-s13-provider-permits / 原池、scoped resources、provider HTTP/旧单文件接线、宿主配置与验证 | #264 保行为提取、#265 资源契约已获授权合并 | 基线 ed157f377c3116910d96158e6ecc41ef550ee166；[许可实现与验证](s1-3-provider-permits.md) | 限定单文件/可观察 HTTP 许可、旧新委托与独立默认关配置已实现；等待精确提交验证和负责人验收，不勾选整步，不放行 S1-4 |
| S1-4 | 未开始 | 待领取 | 待 S1-3 通过 | 待填写 | 唯一执行与计量路径 |
| S1-5 | 未开始 | 待领取 | 待 S1-4 通过 | 待填写 | 恢复识别与提交核对 |
| S1-6 | 未开始 | 待领取 | 待 S1-5 通过 | 待填写 | 开关双路径验证 |
| S1-7 | 未开始 | 待领取 | 待 S1-6 通过 | 待填写 | 护栏、回退、发布证据 |

状态只使用未开始 / 进行中 / 待评审 / 受阻 / 已合并；受阻项写明缺少什么证据，已合并项仍须满足本步验收。文档完善不能把实施状态改为完成。日志与测试结果记录命令、所用 SHA、结果摘要和仓库内证据路径或 PR 链接；不放密钥、完整私有输入或模型原始内容。

## S1-0 基线与 DSH 能力对照（必须先做，不写生产代码）

- [x] 核验并填写文末基线记录：2.6.0 发布证据、P0 控制台验证、`docs/job-contract.md` 实际版本、`main` SHA、Node、实际安装的 DSH/相关包版本与锁文件。0.2.0-rc.2 是计划测试目标，不能代填为已核验版本。
- [x] **DSH 能力对照表**：读 `node_modules/@deepseek-ai/*`（cordis、dsh-llm、dsh-scope、dsh-timeout、schemastery 等）的导出与类型，以及本地 DSH 的宿主服务（`ctx.llm`、`ctx.sessions`、子代理服务 `subagents.*`、`uiWorkspace`），逐行填写下表：

<a id="dsh-capability-map"></a>

  | 行 ID | 内核部件 | 包 / 服务 / 方法 / 实际版本 | 证据路径与最小验证 | 作用域 / 责任者 | 核验结论 | 缺口 / 薄适配边界 |
  |---|---|---|---|---|---|---|
  | [DSH-01](s1-0-dsh-capabilities.md#固定行-id-能力对照) | 注册、生命周期、卸载释放 | cordis 4.0.4 / dsh-scope、jobs rc.2 | P01/P02/R01/R02；jobs 隔离与显式官方 preset owner 探针通过；最终绑定待审 | fiber/effect 与 session owner | 部分复用（最小 D/H 探针；明确组合与范围） | 不建第二张生命周期表；宿主 handle 与业务 Job 的关系待评审 |
  | [DSH-02](s1-0-dsh-capabilities.md#固定行-id-能力对照) | 输入与契约校验 | schemastery 3.18.0 / DSH fork 3.18.4 | P03/P04；required/default/version 最小探针通过；契约 fixture 待 S1-1 | 输入/配置边界 | 待核验 | 复用选定校验方案，不另建通用库 |
  | [DSH-03](s1-0-dsh-capabilities.md#固定行-id-能力对照) | 取消、超时 | dsh-timeout/subagent/jobs rc.2 | P05/R01/R03；jobs wait/kill 隔离探针通过 | abort 传播与真实执行收尾 | 待核验（部分 D 通过） | 观察者 wait 不取消；停止回执不能代替许可释放 |
  | [DSH-04](s1-0-dsh-capabilities.md#固定行-id-能力对照) | 模型调用与档位 | ctx.llm / dsh-llm rc.2 | P06/P07/P08；宿主 fake stream/usage/effort 拒绝通过 | provider 注册与 stream waterfall | 待核验 | 复用 modelCompletion；网关只关联身份与批准策略 |
  | [DSH-05](s1-0-dsh-capabilities.md#固定行-id-能力对照) | 子代理启动、命名、取消、打开 | dsh-subagent / uiWorkspace rc.2 | R03/R04/R05/P09；真实 one-shot parent/child 通过；UI 待测 | parent agent 与 client 导航 | 待核验 | 不伪造 parent、不在 server 假设 uiWorkspace 可用 |
  | [DSH-06](s1-0-dsh-capabilities.md#固定行-id-能力对照) | 并发、请求频率、429 冷却 | jobs/subagents 上限、providerRetryPolicy rc.2 | R02/R03/R06/P10；[rc.2 实际作用域探针](s1-3-dsh06-review.md) | job 数量与请求许可分开 | 候选 owner-job/session-retry 边界已实测；具体 provider 路径仍待核验 | 沿用 audioGate 和原池；演进 permit 模式，不另建队列/重试 |
  | [DSH-07](s1-0-dsh-capabilities.md#固定行-id-能力对照) | 用量上报与观测边界 | usage chunk / BlockAssembler / session log rc.2 | P08/P11/R07；fake usage 已测；缺失 usage/内部 retry 待核验 | provider 观测与唯一 caller sink | 待核验 | 未知不填零；Call/账本去重另有契约 |
  | [DSH-08](s1-0-dsh-capabilities.md#固定行-id-能力对照) | 持久化、原子写、恢复 | dsh-atomic-write / sessions/storage rc.2 | R08/R07/R09/R10；4 个带锁写 D 探针通过 | 单文件 writer 与 agent lifecycle | 待核验（部分 D 通过） | 原子替换不等于联合提交或 fsync；manifest 所有权待评审 |
  | [DSH-09](s1-0-dsh-capabilities.md#固定行-id-能力对照) | 事件、完成通知与投递 | cordis / jobs.events / session rc.2 | P01/P02/R01/R03/R07/P12；settled 一次 D 探针通过 | fiber 订阅 / session 投递 | 待核验（部分 D 通过） | 投递错误不能改终态；持久去重仍待测试 |

  核验结论使用直接复用 / 部分复用 / 已核验不支持 / 待核验。类型或导出证明接口存在，最小验证证明在当前宿主作用域可用；二者分别记录。无法启动宿主、缺少权限或未拿到源码时，写明缺少的证据，保持待核验。试点实现依赖的待核验项会阻断对应步骤；后续阶段才用到的能力可注明阶段和宿主限制，不以空壳实现补齐。

- [x] 审计 `lib/runtime/tasks.js` 与调用方：列出共享 `jobs` 的来源、注册与控制入口、作用域释放、当前 extension 兼容范围、实际计量与完成通知责任者。逐项决定保留 / 演进 / 委托宿主 / 后续删除，并引用文件、符号和测试；不要先新建另一张任务表。
- [x] 记录资源与写入所有权：识别 `admitAudio`、`audioGate`、`lib/audio-pool.js` 各自限制的真实范围与计数实例；记录公共状态、manifest 业务字段、许可释放、重试、Call/用量、产物提交、通知的现有责任者及拟迁移责任者。不得用相似的函数名推断同一资源。
- [x] **单文件音频的行为清单**：锁定实际入口与“单文件”的范围，列出输入校验、步骤与回退顺序、状态值、manifest、计量点、取消、已有重试/恢复、通知和 UI 字段。按下面模板填写，每个断言对应源码与 fixture；未观察到的行为保持未确认。

  | 行为 ID / 场景 | 现有入口与可见行为 | 状态 / 产物 / manifest / 用量 / 通知断言 | fixture 与测试 | 验证 SHA / 结果 |
  |---|---|---|---|---|
  | AU-01/03/11/12：成功、无效输入、回退与失败 | [逐项旧行为](s1-0-audio-behavior.md#行为清单)；path/uploadId 校验，转写→校对→翻译→标题→资料 | 成功仅资料；失败/回退、用量与通知按已执行测试范围锁定，不推断真实 provider 质量 | 既有 audio/audio-retry/audio-pool-adaptive；新增 audio-single-characterization 第一项 | AA02592 + S1-0；[完整与定向结果](s1-0-baseline.md#已执行验证) |
  | AU-09/12：排队取消、运行取消、部分结果 | [逐项旧行为](s1-0-audio-behavior.md#行为清单)；排队取消不调用模型，运行取消停后续窗口 | cancelled/retryable、已完成 checkpoint、partial 警告按旧断言；真实远端 stop 未确认 | audio-concurrency/audio-pool/audio-retry/audio；完整 verify 含 audio-windows | E024 定向与 AA02592 全量；[结果及限制](s1-0-baseline.md) |
  | AU-05/14/15/16：重启识别、既有重试/恢复 | [旧 single recovery](s1-0-audio-behavior.md#行为清单)；运行中断识别为 failed+retryable，无自动调用 | 显式 retry 保持 singleId、换外部 ID；既有 checkpoint/累计用量保留 | audio-retry；新增 audio-single-characterization 真实进程退出/重启第二项 | AA02592 + S1-0，新增 2 pass；[验证记录](s1-0-baseline.md) |

  | 字段或操作 | 现有唯一责任者 / 源码 | 迁移后唯一责任者 | 兼容适配方式 / 验证 |
  |---|---|---|---|
  | Job 生命周期、attempt 结算 | [领域 worker 与 tasks executor](s1-0-runtime-audit.md#4-字段操作与唯一责任者清单) | 唯一内核责任层与合法 DSH handle 组合待 S1-1/2 评审 | 同一 work.jobs，私有执行索引不增加公共表；[兼容草案](s1-1-compatibility.md#1-唯一事实来源权限与写入者) |
  | manifest 业务字段、产物提交 | [audio-batch 与领域 store](s1-0-runtime-audit.md#4-字段操作与唯一责任者清单) | 领域业务 writer 保留，内核独占生命周期元字段；待实现审定 | 按当前 Attempt 授权提交，writer 保序/原子替换；崩溃窗口在 S1-5 验收 |
  | 资源许可、传输重试、429 冷却 | [host audioGate、录音/批次 text pool、模型/tier retry](s1-0-runtime-audit.md#5-实际资源实例与重试分工) | 复用同一真实实例和单一策略层；待 S1-3/4 定稿 | 转写槽不等于整任务/文本配额；混跑与冷却尚未实现 |
  | Call、用量入账、完成事件、通知 | [taskTracker、原账本、worker finally、notifier](s1-0-runtime-audit.md#4-字段操作与唯一责任者清单) | 迁移 Call 由网关写，沿用账本，唯一完成事件由生命周期写；待实现评审 | 不从旧 calls 猜 HTTP 请求；跨重启去重在 S1-4/5 验收 |
- [x] **特征测试（characterization tests）**：仅新增测试、fixture 与文档，不改生产代码；固定实际可见行为，并在旧实现上通过。成功/失败、取消/部分结果、回退/计量、既有重启处理至少有对应证据；不支持的行为记录为不支持。发现缺陷另行登记，不能在此步修改业务或把目标设计写成测试预期。

**交付物与门禁**：基线记录、能力表、任务服务审计、资源/字段所有权表、行为清单与旧实现上全绿的特征测试。记录测试命令、SHA、结果与评审通过链接。**P0 未核验、试点依赖项仍待核验、特征测试未通过或 S1-0 未获评审通过时，不进入 S1-1。** 文档上的目标接口不能作为完成证据。

2026-10-05，所有者接受 [#241](https://github.com/EricWang1358/dsh-web-studyhub/pull/241) 的已验证范围与待核验限制，授权合并并进入 S1-1 契约评审。该接受不放行相关生产实现；能力表的未确认项仍按其对应步骤补证据。


### 已核对的源码线索（不是 S1-0 通过记录）

以下仅来自 PR #237 合并后的源码 `d05588def3d43dc757b6d969885c69a0f87afe11`，未运行宿主或测试。实施者必须在 P0 发布后的实际基线上复核；不能据此填写 DSH 能力已验证或勾选实施完成。

| 对象 | 当前源码事实 | 实施时要核对的边界 |
|---|---|---|
| 任务服务 | [tasks.js](https://github.com/EricWang1358/dsh-web-studyhub/blob/d05588def3d43dc757b6d969885c69a0f87afe11/lib/runtime/tasks.js#L7-L77) 写入共享 `registry.jobs`，并有私有 entries / owner / domain 队列 | 保留 owner/domain 隔离、取消与清理；私有索引不能误判为第二份公共任务表 |
| 转写槽 | [host.js](https://github.com/EricWang1358/dsh-web-studyhub/blob/d05588def3d43dc757b6d969885c69a0f87afe11/lib/host.js#L35-L48) 提供宿主共享 `audioGate`；[admitAudio](https://github.com/EricWang1358/dsh-web-studyhub/blob/d05588def3d43dc757b6d969885c69a0f87afe11/lib/contexts/audio/worker.js#L22-L42) 在转写结束后释放槽 | 不是整段音频任务的占用，也不是文本计数器 |
| 文本池 | [audio-job.js](https://github.com/EricWang1358/dsh-web-studyhub/blob/d05588def3d43dc757b6d969885c69a0f87afe11/lib/audio-job.js#L275-L278) 每录音一池；[audio-batch.js](https://github.com/EricWang1358/dsh-web-studyhub/blob/d05588def3d43dc757b6d969885c69a0f87afe11/lib/audio-batch.js#L256-L260) 每批次一池 | 原上限按录音/批次生效，不存在可直接引用的宿主统一文本计数；扩大限制作用域须独立开关 |
| 单文件持久记录与重试 | [prepareSingleAudioRecord](https://github.com/EricWang1358/dsh-web-studyhub/blob/d05588def3d43dc757b6d969885c69a0f87afe11/lib/audio-batch.js#L110-L130) 已有 `kind:'single'`、输入 hash/size、参数与 job；[worker.js](https://github.com/EricWang1358/dsh-web-studyhub/blob/d05588def3d43dc757b6d969885c69a0f87afe11/lib/contexts/audio/worker.js#L161-L190) 中断旧卡为 failed + retryable，重试换外部 job ID | S1-1 映射目标 interrupted / 稳定逻辑 Job 身份与旧状态/ID，保留兼容入口、通知和 UI 行为 |
| 原子写与重试 | [audio-batch.js](https://github.com/EricWang1358/dsh-web-studyhub/blob/d05588def3d43dc757b6d969885c69a0f87afe11/lib/audio-batch.js#L19-L69) 有 Windows rename 重试和每 manifest 文件写入串行化；[audio-pool.js](https://github.com/EricWang1358/dsh-web-studyhub/blob/d05588def3d43dc757b6d969885c69a0f87afe11/lib/audio-pool.js#L41-L78) 同时拥有文本并发与限流拒绝重试 | 抽取保留写入顺序；接网关前核对 pool、传输重试、格式修复的分工，避免叠加 |

先检查既有 `tests/audio-concurrency.test.mjs`、`tests/host-ownership.test.mjs`、`tests/audio-pool.test.mjs`、`tests/audio-pool-adaptive.test.mjs`、`tests/audio-batch.test.mjs`；补缺口，不重复重写已有测试。

## S1-1 公共契约与状态兼容

- [ ] `lib/jobs/contract.js`：生命周期状态、能力声明（`pauseMode`、`recoveryMode`、动作列表）、Job/Attempt/Step/Call 的形状，用 `schemastery`（或对照表选定的 DSH 校验方案）声明与校验。
- [ ] 旧状态读兼容：`done` → `complete`，`partial` → `result.completeness`，`superseded` → 结束原因；只读旧、写新。
- [ ] 与 2.6.0 的 `docs/job-contract.md` 对齐；如有改动，契约版本号 +1 并写兼容说明。
- [ ] 契约先提交文档与可执行 fixture/契约验证，评审合并后再提交兼容实现；明确每个字段的写入者、状态转换表、动作矩阵及拒绝原因。复用 P0 契约，不能另建互相竞争的公共形状。
- [ ] 明确旧中断卡片 `failed + retryable` 与新 `interrupted` 的映射、旧重试外部 job ID 与稳定逻辑 Job/新 Attempt 的关联；测试旧 ID 查询、控制、通知与 UI 链接的兼容规则。不得把新内部身份规则直接写回旧接口而不说明差异。
- **验收**：同一旧记录经旧入口与新公共视图读取后语义一致；状态映射、未知/不兼容版本、非法动作、不支持的暂停/恢复均有明确结果；`total` 未知、时间/用量缺失不得编造。交付契约评审链接、版本兼容说明、fixture 与测试证据。

## S1-2 注册表与生命周期

- [x] `lib/jobs/registry.js`：任务定义注册（挂在 cordis 上下文，插件卸载随作用域释放）；定义包含 `kind`、版本、能力、`run(ctx, input)`、恢复钩子。
- [x] `lib/jobs/lifecycle.js`：创建 Job、开 Attempt、状态转换、**一次结算**、迟到结果保护（旧 attempt 的进度/结果被丢弃）、取消协议（`cancelling` → 收尾 → `cancelled`）。
- [x] 公共操作 `submit / status / list / wait / control / output` 接到内核；现有 `job.cancel / job.status / job.wait` 改为兼容入口。
- **验收**：可控执行器与假时钟覆盖同一 Job 只存在一个活动 attempt；取消/完成竞态、重复 control、重复终态回调均只结算一次。旧 attempt 的进度、结果及产物提交被拒绝，不能只保护内存状态。
- **停止验收**：排队取消不会启动执行器；运行取消与三类超时传播实际停止信号；卸载后不再派发、不残留事件订阅或计时器，活动执行按停止协议收尾。底层未停止前不得提前回收其实际占用许可；无法确认的远端停止如实记录。
- **等待语义**：区分 `wait` 的观察者等待上限与任务的排队期限、执行预算、请求超时。既有 `tasks.wait(timeoutMs)` 到期返回快照，不取消任务；兼容入口保持这一语义，不能把查询等待超时当成任务停止。
- **交付**：状态/动作测试、公共操作与 extension/旧入口兼容证据、资源释放和完成事件计数断言。

## S1-3 调度器（资源与配额域）

- [ ] `lib/jobs/scheduler.js`：资源实例（模型配额域、音频转录槽、本地工具、写入互斥、任务内并发）、许可申请/释放、429 冷却、动态限额、有界等待；从 `lib/audio-pool.js` 推广，不另写。
- [ ] **与旧路径共享实际资源**：转写沿用同一个宿主 `audioGate` / `admitAudio` 实例。文本先按 S1-0 核验的录音/批次作用域复用现有池；不能声称 `audioGate` 已提供文本计数。
- [ ] **计数迁移与策略改进分开**：按目标实际配额域收敛时，新旧文本路径委托同一许可与冷却责任层；保留原录音/批次上限。新增宿主/配额域文本限制会改变并发行为，须有独立策略开关、默认值、资源键映射和回退说明，不能仅因打开 `runtime.pilot.audioSingle` 就启用。唯一责任层不能用叠加两个新闸门实现；方案先经 S1-0/契约评审确认。
- [ ] 基于 S1-0 的资源表接入真实许可实例；记录每类资源的作用域、配置上限、实际占用区间、申请/释放点与旧包装去留。`lib/audio-pool.js` 是否适合承载具体限制以审计为准，不能把窗口 worker pool 当成 provider 的请求许可。
- **验收矩阵**：新旧路径混跑时观测转写实际峰值，验证宿主共享上限；文本策略关时验证原录音/批次上限与基线行为，策略开时验证同一配额域的混跑总上限。共享策略开时，旧路径 429 使新路径冷却，反向也成立；不同配额域不互相误阻塞。同一实际资源请求只申请一次许可。
- **边界验收**：排队取消清除等待者；已停止请求在退避等待时释放许可，到期重新申请；并发下调后保留在途占用并停止超限新派发，回升不超过配置上限；完成、失败、取消均仅释放一次。父子任务等待不形成同资源死锁。
- **交付**：资源实例与旧入口委托说明、混跑/冷却/取消测试、假时钟与实际占用断言。动态策略若改变基线行为，独立开关且默认不随试点启用。

## S1-4 模型网关与非模型执行适配器

- [ ] `lib/jobs/gateway.js`：受管模型请求唯一入口；显式 `purpose / feature / requestedEffort / executionMode / budget`；档位经 `lib/model-effort.js`；子代理经宿主子代理服务；每次可观测请求写一条 Call；**唯一的传输重试层**（试点路径上移除叠加的旧 retry 包装）。
- [ ] 转写适配器：包装现有 Gemini / Groq / 硅基流动调用与分档回退（`lib/gemini.js` 等），把它们的请求写成 Call，计量从 Call 聚合（取代试点路径上的音频计量 fetch 包装，旧路径继续用旧包装直到 P2）。
- [ ] 按实际调用点列出“重试/回退/计量包装去留表”：保留、委托或移除的符号与唯一责任层。网关复用 `ctx.llm`、宿主子代理及既有 provider 适配器；不得增加第二个传输重试实现。重试次数、回退顺序、音频额度检查保持基线，新增策略另开开关。
- **验收**：模拟一次失败后成功重试、一次 fallback 与永久失败；实际可观测请求分别产生 Call，账本按稳定 Call 身份只入账一次。重复聚合与恢复不会重复记账；观测不到的宿主内部重试、tokens 或时点留空/标 `unknown`，估算值注明来源。
- **执行验收**：直接/宿主子代理调用都关联正确 Job/Attempt/Step，记录档位“请求 / 实际 / 回退原因”；`agent-required` 不可用时明确拒绝，`agent-preferred` 的回退可见且遵守契约。能力可用性经宿主最小验证确认，fake provider 测试不能代替宿主核验。
- **交付**：调用点去留表、计量/重试/执行模式测试与能力表 DSH-04/05/07 的证据。

## S1-5 持久化与恢复识别

- [ ] `lib/jobs/store.js`：任务元记录（类型、输入引用、attempt、状态、版本、检查点引用、`schemaVersion`）；**共用原子写入器**（从 `audio-batch.js atomicJson` 提取，保留 Windows 重命名重试）。
- [ ] 适配单文件音频既有 manifest：明确哪个字段由谁负责，生命周期只由内核决定。
- [ ] 重启：只把确认失去执行者的 attempt 标为 `interrupted`；按 `recoveryMode` 提供重试/继续；产物用 stepKey 去重。
- [ ] 复核并适配既有 `kind:'single'` manifest 与输入 hash/size、参数、旧外部 job ID；区分公共元记录、领域记录与兼容卡片字段。复用现有公共 `jobs` 与领域存储，不能新建第二份任务事实来源。原子写入同时保留 Windows 替换重试与按 manifest 文件串行化，不能只抽取 rename。
- **故障矩阵**：明确“提交”指业务产物提交。覆盖产物提交前、产物提交后但检查点保存前、检查点保存后但终态/通知保存前崩溃，以及重复恢复；核对领域产物与提交记录，断言不重复产物、不重复入账、不重复完成事件。通知失败不改任务终态，投递去重使用稳定事件键。
- **恢复拒绝矩阵**：原执行者仍存活、输入不可访问/指纹变化、版本不兼容、检查点损坏均给出原因，不启动新 attempt。远端结果未知先核对 `remoteOperationId`，不能无依据自动重发。
- **交付**：字段所有权定稿、旧格式读取 fixture、原子写 Windows 行为回归、故障/拒绝测试与已验证的 `recoveryMode`。新增自动恢复独立开关，不借试点默认启用。

## S1-6 单文件音频试点切换

- [ ] 开关 `runtime.pilot.audioSingle`（默认关；测试与开发开）：开时单文件音频导入经内核执行，关时走旧路径。
- [ ] 控制台继续读同一公共视图（不需改控制台公共部分）。
- [ ] S1-0 的同一组特征测试在开关关/开下分别通过，保存相同 fixture、模型与策略条件及行为差异表。取消、计量、中断识别、已声明恢复能力均有证据；任何行为差异先解释并单独评审。
- [ ] 在旧、新 attempt 运行期间切换开关：在途 attempt 的执行者、定义版本与策略快照不变，只影响新提交；新旧混跑继续满足 S1-3 的许可和冷却约束。不得用切换触发在途任务重提。
- [ ] 本地 DSH 0.2.0-rc.2 实测（`SSH_TTY=audit`、清空密钥变量、工作区内临时 `DSH_HOME`、fake model）：提交 → 排队 → 运行/进度 → 取消或完成 → 中断识别/能力反馈，保存控制台截图和所用版本；范围与未测能力写明。
- **交付**：双路径回归与切换矩阵、宿主验证记录、截图、开关默认值与配置入口。公共控制台不增加音频专有分支；专有详情通过既有扩展边界展示。

## S1-7 护栏与发布

- [ ] 架构测试：迁移例外清单（旧入口、负责人、计划移除阶段）；禁止未登记的新任务表 / 队列 / 直接 provider 调用 / 直接 `complete`。
- [ ] 文档：本文件打勾、`README.md` 进度表更新、DSH 对照表定稿。
- [ ] 架构护栏按模块依赖/API 边界检查，允许网关/provider 适配器的受控实现与登记的旧路径；不能仅凭 `fetch` / `Map` 字符串误伤非模型请求或普通缓存。例外表含入口、责任者、原因、移除阶段与证据。
- [ ] 完成指定回退 tag/SHA 的演练：关闭新接纳 → 排空在途 attempt 或保存兼容检查点 → 旧版启动；分别记录产物可读、未完成新任务能否继续。新版本记录旧版无法继续时，保留记录并明确限制，不宣称完整回退。
- [ ] 发布前执行仓库规定的 `npm run verify` 与产物检查；真实模型抽检需所有者授权、预算和输入/模型/档位/质量/耗时/请求数/用量记录。未授权或未验证的发布门禁保持待完成，fake model 不能代替质量抽检。
- [ ] 发布 2.6.x alpha 预发行（独立 alpha 分支，与 main 正式版本并行；所有者 2026-10-05 指定）：changelog 写明已验证范围、独立开关及默认值、在途任务处置、指定回退版本与未支持能力。发布不自动扩大试点覆盖面。
- **交付**：护栏结果、例外清单、完整验证与抽检证据、回退演练、发布版本/commit、更新后的接手记录。

## 基线记录

实际证据见 [S1-0 基线与验证记录](s1-0-baseline.md)；以下保留门禁状态，不以源码审计代替宿主实测。

| 记录项 | 实际值 / 证据 |
|---|---|
| 核验日期与负责人 | 2026-10-05 / Codex 集成负责人 |
| 2.6.0 发布版本 / tag / commit / 链接 | v2.6.0 / aa0259254bcd587128e583070599a804485c7d06 / [release](https://github.com/EricWang1358/dsh-web-studyhub/releases/tag/v2.6.0) |
| P0 控制台验证 / 契约路径与版本 | #239 CI 与控制台记录；docs/job-contract.md v1；[基线记录](s1-0-baseline.md#发布与-p0) |
| 迁移基线 main commit SHA | aa0259254bcd587128e583070599a804485c7d06 |
| Node / DSH / 相关包实际版本 / 锁文件 | Node 22.22.3 / 目标 DSH rc.2；[版本与哈希](s1-0-dsh-capabilities.md#实际版本) |
| 单文件试点入口、范围、fixture | audio.import(path 或 uploadId) / 单录音；[行为与测试](s1-0-audio-behavior.md) |
| tasks.js 审计与资源/字段所有权证据 | [审计与所有权](s1-0-runtime-audit.md)，迁移责任待契约评审 |
| 特征测试命令 / SHA / 结果链接 | [基线记录](s1-0-baseline.md#已执行验证)：92 项基线 + 2 项新增；完整 verify 4935 pass / 0 fail / 2 skip |
| 待核验能力与受阻步骤 | [能力表](s1-0-dsh-capabilities.md#待核验与阻断)；S1-0 已接受的限制按 S1-2/3/4/5/6 对应门禁继续保留；本轮只进入契约评审 |
| S1-0 评审者 / 通过评审链接 | 独立原生审查完成；所有者本轮接受范围与限制并授权合并 [#241](https://github.com/EricWang1358/dsh-web-studyhub/pull/241)，merge f091f09f830c226bfebc9af22344896733893a10 |
