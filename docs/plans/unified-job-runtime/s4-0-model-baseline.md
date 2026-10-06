# S4-0：模型任务基线与入口清单

> **早期只读基线，基于 origin/main `8d661f4`（`8d661f4a5ab62337ceadc4040396a32bafaa2df1`）；S4 开工时须在当时 main 上复核。**
> 本步只增加特征测试与本文，不修改生产代码。所有测试用假模型/假宿主，无真实网络与密钥；"真实宿主""真实模型"一律列入末尾待核验。
> 引用格式 `文件:行号`，行号以上述 SHA 为准。

## 1. 入口与实际任务身份

"面板"= `lib/host.js` 的 `createHostHandler`（`ui/*` 经 `/api/study-workspace/call` 进入，`host.js:416-570`）；"工具"= 注册的 `study_workspace`（`lib/index.js:313-340`，`runStudyTool` 末端同样是 `service.call(action,args)`）。二者落到同一个 `runtime.call`，没有各自的业务路径；`assist.start` 是唯一例外（只在面板处理器里，`host.js:484-521`，运行时没有该动作）。

| 入口（家族） | 面板调用点 | 工具/运行时动作 | 任务身份（现状） | 在 `snapshot.jobs`/控制台 |
|---|---|---|---|---|
| 翻译·长文（翻译本页/本章） | `ui/document-preview/translation/useBilingual.jsx:350-423` | `generation.translation.start/status/jobs`（`translation-jobs.js:182`） | `work.jobs` 内 `type:'translation'`、`origin:'translation'`，`id()` 随机；`semantic` 摘要去重（`translation-jobs.js:68-70`） | 是，kind `translation`（`job-contract.js:54,78`） |
| 翻译·选区/资料段落 | 同上 `:200` | `materials.translation.translate`（`translation-operations.js:283`） | 无任务；同步调用，可选 `requestId` 登记到进程内 `inflight`（`:30,284-286`），`materials.translation.cancel` 按它取消（`:341`） | 否（测试已钉：不产生行） |
| 为你定制 | `ui/WrongBook.jsx:466`、`ui/settings/CoachSection.jsx`、复盘触发（`worker.js:274-277`） | `coach.variants`/`coach.prepare`/`job.control`（`contexts/jobs/operations.js:56-66`） | 批次=内存里的 `coachTasks`（`worker.js:57-79`）；控制台只有"一天一行" `coach:YYYY-MM-DD`（`coach-daily.js:179`），kind `coach-daily` | 是（只有日行，批次不是任务） |
| 每日总结 | `ui/useDailyRecap.js:62-74`；自动检查点 `note.daily.advance`（`daily.js:126-139`） | `note.daily.generate/advance/cancel/status/reconcile`（`daily.js:119-193`） | 无任务表；身份是 `note.generation = {id, status, fingerprint, final, revision, pid, session}`（`daily.js:90-92`），`id` 随机 | **否**（无 kind；`kindOf` 若被喂入会落到 `extension`，`job-contract.js:79`） |
| 学习流后台单元 | `ui/WorkflowPortal.jsx:286,319` | `workflow.teaching.start`、`workflow.skeleton.generate`（`workflow-teaching.js:162`、`workflow-skeleton.js:158`） | 教学：`workflowTeachingJobs` 键 `[root,session,step]`（`workflow-teaching.js:17,173-175`）；骨架：键 `[root,session]`（`workflow-skeleton.js:14`）。持久化的只有 `record.teaching` / `session.skeletonJob` | **否** |
| 助手 | `ui/assist-request.js:6,15` | 仅面板处理器 `assist.start`（`host.js:484`）；写回是运行时 `assist.commit`（`runtime/builtins.js:174,207`） | `createAssistService` 的内存 `tasks` Map，`id()` 随机，每库最近 20 条（`assist.js:17,64-73`） | **否**（随 `snapshot.assist`，由面板处理器附加，`host.js:563-566`） |

不属本步迁移的即时模型请求：`workflow.quickstart` 的 `pickScope`、`workflow.feedback`（`workflow-guide.js:47-56,140-154`），教练 `nudgeFor/debrief/scheduleRewrite`（`worker.js:16-55,218-253,264-309`；复写走 `coachTask('rewrite')` 但不是契约任务），以及材料大纲建议（`outline-operations.js:97`）。

## 2. 逐入口基线

| 项 | 翻译·长文 | 为你定制 | 每日总结 | 学习流教学/骨架 | 助手 |
|---|---|---|---|---|---|
| **实际 queue / owner** | `queues(root)` 链式 Promise，与出题、补题共用（`translation-jobs.js:161-164`；`generation/operations.js:124,935,1165`；`selection-jobs.js:196`）；`ahead`=该库仍活跃的 job 数（`:73`），决定 `queued`/`running`；owner=`ownWork(job, workOwner)`（`:85`）。波内并发≤3 在 `materials` `runTasks`（`translation-operations.js:243`） | `coachQueues` 车道 `${root}:prep`，批次串行（`worker.js:67-77`）；复写车道按卡且 `rewriteSlot` ≤3（`:81-93`）；owner=`ownWork(task, worker.workOwner)`（`:61`） | 无队列：`noteJobs` 键 `${root}:${noteId}`（`daily.js:63,95`），一笔记一个活动生成；运行中再提交→合并成 `generation.next` 并在成功后重放（`:64-72,110-114`） | 无队列，满额即拒：每库≤3 份教学、≤3 个在途模型调用（`workflow-teaching.js:105,171`）；同步骤重复点击共享同一 job（`:169-170`） | 无队列。`tasks` Map（`assist.js:64`）；同卡同证据可复用一个本地 child（`assist-child.js:59-71`），同 teacher 内串行（`entry.tail`，`:65,75,95`）；owner=host 级 `assist` 服务，随宿主 `dispose`（`host.js:41-48`） |
| **内容版本 / 提交保护** | 提交时钉住 `documentId+revision+target+scope+comment`（`:37-46,139`）；每波按钉住的 revision 写回（`translation-operations.js:185-195`）；新 revision 不继承译文（已测）。**词汇表不钉**：每波重读（`settingsOf`，`:57-62`） | 学习档案 `memoryRevision/prepRevision/consent` 与批次起点比较，变了丢弃（`worker.js:168-190`）；设置在**批次开始时**读（`coach-daily.js:88-94`） | `fingerprint`（题目+课程，`daily-recap.js:174`）+ `note.revision` 在生成开始时记入（`daily.js:90-92`）；每次写入校验 `generation.id`、状态与 revision（`daily-generation.js:8-26`） | `record.teaching.id===job.id` 且保存的讲解内容与启动时 `existingMaterial` 相同（`workflow-teaching.js:126-132`）；输入（卡片、证据）在启动事务内取（`:176-184`） | `expectedDigest`（`assistDigest(card)` / `gradingDigest`，`assist.js:87`）；`route`/`sessionId`/`signal` 在提交时固定 |
| **提示与档位** | `translationPrompt`；`temperature:0.2`（`translation-operations.js:220`）；批内一次纠正重试 `[0,1]`（`:213`）。模型调用带 `jobId`+`resultOwner:'plugin'`，于是走 `lib/index.js:262` 的 `generation()` 分支（`:246-254`）→有子代理能力时每批开一次性 child（`generation-agent.js:83-89`），否则直连；阶段文本 `Writing translations n/m` 不属任何 effort 阶段（`stage-effort.js:21-27`）→只受会话/学习者生成档位（`index.js:247`，`stageEffort` 未传） | `worker.light`：最低档+90 s 超时+15 s 对冲（`index.js:56-57,227-233`）；设置 `reasoning` 非 lowest 时传 `reasoningEffort` 并改走 `correct()`（`worker.js:164`；`coach-daily.js:18`） | `recapPrompt(tone,language)`（`daily-recap.js:226`）；`complete(system,prompt,{signal})`，无 jobId/stage/task→`index.js:263` 的普通分支（学习者生成档位）；批 30 题（`daily-generation.js:5`），>1 批再 consolidate | 固定英文 system（`workflow-teaching.js:32-50`）；`service.complete(system,prompt)` **不带 signal 与选项**（`:110`）；成稿+独立评审，最多 2 轮（`:85-97`）；骨架 2 轮（`workflow-skeleton.js:76-100`） | `assistInstruction(mode)`+`languageSystem`；直连 `{task:'assist', signal, maxTokens:10000, route}`（`assist.js:131`）；child 路径 `toolFilter:{allow:[]}`+`agentOptions` 取提交时 route（`:119-129`）；route/档位在 `host.js:486-520` 于提交时解析 |
| **取消与收尾** | `job.cancel`：排队→立即 `cancelled`，运行→`cancelling`+abort（`contexts/jobs/operations.js:71-99`）；已保存波保留（`translation-operations.js:321-328`），最多丢一波；**排队任务的最终收尾要等前序放手**（测试已钉，stage `Cancelled before starting`，`translation-jobs.js:118-124`）；1 h 预算到点→`failed/budget`（`:125-128,149-152`）；插件卸载 abort（`builtins.js:308`） | **无取消**（`caps.cancel:false`，`job-contract.js:64,189`）；卸载置 `task.cancelled`，排队批次拒绝开始（`builtins.js:314`；`worker.js:70`），在途批次无 signal 跑完，由 §版本保护丢弃陈旧结果 | `note.daily.cancel`：先写 `cancelled` 再 abort（`daily.js:140-152`）；已存 fragments 保留；课程改名/合并→`superseded`+abort（`:161-164,177-182`）；卸载 abort（`builtins.js:316`） | **无取消动作**；卸载置 `job.cancelled`（`builtins.js:317`），之后 `complete` 包装抛"已结束"（`workflow-teaching.js:103,111`）；删会话→受保护写回丢弃；超时靠 `Promise.race` 240 s/300 s，**底层请求不被中止**（`:119-122`；`workflow-skeleton.js:103-106`） | `clearAssist`/`dispose` abort 任务并释放 child（`assist.js:164-169`；`assist-child.js:30-35`）；8 min 超时（`assist.js:18,108`）；`abortable` 竞速，迟到输出丢弃（`host-capabilities.js:210-220`） |
| **Call / 账本** | `job.steps`（≤40）+`withJobUsage`（`translation-jobs.js:92-104`）→契约 calls；用量账本经 `recordedModels`（`builtins.js:286`；`model-usage.js:138`，同键不重复计），feature=`other`（`model-usage.js:22`）。**网关未参与** | 批次 token 由 usage sink 累加入日账（`worker.js:202-204`；`coach-daily.js:105-112`），每批 `calls:1`、日行 `calls`=批数（`:184-185`，批内重试/对冲不可见）；用量账本 feature=`coach` | 无 Call；用量记入账本 feature=`other`（notes 不在 `BY_CONTEXT`，`model-usage.js:19-21`）；笔记不存用量 | `withJobUsage(job,…)`→`record.teaching.tokenUsage`（`workflow-teaching.js:110,150`）；账本 feature=`flow` | **无**：`service.complete` 直连宿主，不过 `recordedModels`；账本无记录，任务记录无用量字段（测试已钉） |
| **产物** | 文档 revision 记录内的 `translations.items`（`translation-operations.js:185-195`）；job 仅内存 | `s.prepared` 就绪卡（`worker.js:173-184`）+`coach-daily.json`（`coach-daily.js:70-78`，14 天） | `note.markdown/daily.{fingerprint,final,fragments}` 与 `note.generation`（`daily-generation.js:68-82`） | `session.records[step].{content,citations,help,teaching}`（`workflow-teaching.js:133-153`）；骨架存为普通知识骨架并挂 `session.skeletonId`（`workflow-skeleton.js:82-91`） | 卡片 followup/补丁/新题，经 `assist.commit`（`assist-content.js:91-119`）；任务记录仅内存 |
| **通知** | 收件箱 `translate-result/-failed`（失败被吞）+会话 `announce`（`translation-jobs.js:106-116`）；取消不发信 | 就绪卡写 `variant` 信，在写卡同一事务内（`worker.js:185-186`）；无会话通知 | `note` 信仅"首次内容或 final"，在提交事务内（`daily-generation.js:82`）——**通知与完成同事务** | 无 | derive 模式写 `variant` 信（`assist-content.js:119`）；其他模式的信件路径待核验 |

**时间预算**：翻译 1 h 硬限（`translation-jobs.js:27`）；每日总结**无**预算；教学 240 s、骨架 300 s（均为 `Promise.race`）；助手 8 min（`AbortController`）；为你定制单次 90 s（light）。

## 3. 保留 / 迁移

| 部分 | 处理 | 负责步骤 |
|---|---|---|
| 翻译：提交、状态、等待、取消、Call、用量、通知、`semantic` 去重 | 迁移到公共生命周期/网关，仍通过 `admit` 适配委托 `queues(root)` 与资料写锁；原分段、复用、修复、保存规则不变 | S4-2；解除串行 S4-3 |
| 翻译：段落规则、`persist` 单事务、`revision` 钉住、词汇表读取 | 保留在 materials | — |
| 选区/资料单段翻译（无任务） | 保留为即时请求；仅计量/重试包装按去留表退出（"实际请求只计一次"） | S4-2 |
| 为你定制：批次执行、控制、调用归属 | 迁移；`coach-daily` 日账本、日行投影、设置与暂停保留为领域聚合（不是新公共 jobs 表）。复写/陪学/复盘保持即时请求 | S4-4 |
| 每日总结：生成执行、取消 | 迁移；note、fingerprint、fragments、`next` 合并、手改保护、supersede 语义保留在 notes | S4-5；子代理优先 S4-8 |
| 学习流：教学与骨架后台单元 | 迁移（获得真实取消）；流程、导航、资料/草稿锁、步间依赖保留 | S4-6；子代理优先 S4-8 |
| 助手：任务事实投影到公共运行时；child 复用与生命周期 | 投影迁移；child 仍由宿主服务与 `assist-child` 持有，不复制第二份生命周期 | S4-7 |
| 面板与工具的双入口 | 保持同一 `service.call`；`assist.start` 仍是面板唯一入口，迁移后须获同样权限，不得出现仅 UI 可控的任务 | S4-1/S4-7 |

## 4. 硬编码常量（值 · 位置 · 建议归宿）

| 常量 | 值 | 位置 | 建议归宿 |
|---|---|---|---|
| 翻译作业时限 | 3 600 s | `translation-jobs.js:27` | 任务类型策略（网关 `budget.timeoutMs`） |
| 翻译步骤记录上限 | 40 | `translation-jobs.js:25` | 观测存储上限 |
| 翻译并发/波 | min1 max3 默认2；每批 ≤6 段/4 000 字；段长 1 200；评论 300；历史 5 | `passage-translation.js:14-24` | 并发→调度配额域设置；其余为领域规则，留原处 |
| 翻译单次上限 | 500 段、20 000 字、受影响 200 | `translation-operations.js:26` | 领域规则 |
| 翻译温度 / 修复轮 | 0.2 / 1 次纠正 | `translation-operations.js:220,213` | 网关用途策略 / 业务格式修复（与传输重试分开计） |
| 备题合并阈值 / 延迟 / 批大小 | 3 张 / 20 s / 4 张 | `coach/worker.js:111,15,123` | 教练策略设置 |
| 复写并行 / 任务保留 | 3 / 20 | `coach/worker.js:15,63` | 同上 |
| 日设置默认与限值 | 24 批/日、就绪≤12、reasoning `lowest`；保留 14 天、展示 7 天、60 批/日 | `coach-daily.js:16-24`，`coach.js:27` | 已是设置对象（`DAILY.limits`），保留 |
| light 超时 / 对冲 | 90 s / 15 s | `lib/index.js:56-57` | 网关用途策略 |
| 总结门槛 / 批大小 / 自动增量 | 10 题 / 30 题 / +5 题 | `daily-recap.js:8`；`daily-generation.js:5`；`daily.js:135` | 总结设置（`daily-recap-settings.js`）或领域规则；无时限需新增 |
| 教学并发 / 在途调用 / 超时 | 3 / 3 / 240 s | `workflow-teaching.js:171,105,121` | 学习流策略设置 |
| 教学输入上限 | 卡 24、证据半径 650/预算 12 000、讲解 600–20 000 字 | `workflow-teaching.js:53,56,69` | 领域规则 |
| 骨架 | 80 卡、300 s | `workflow-skeleton.js:19,16` | 同教学 |
| 助手 | 任务 20、超时 8 min、`maxTokens` 10 000、结果 60 000 字 | `assist.js:17,18,131,113` | 网关用途策略 / 领域校验 |
| 助手 child 池 | 4 个、空闲 120 s、8 轮 | `assist-child.js:5` | 宿主服务策略 |

## 5. `lib/job-contract.js` 与 `ui/tasks/*` 中的按 kind 分支

| 位置 | 内容 |
|---|---|
| `job-contract.js:51-65` | `CAPABILITIES`：`translation`（cancel/checkpoint 暂停/set/无 retry，单位段）、`coach-daily`（无 cancel，`daily:true`） |
| `:75-81` | `kindOf`：`translation`、`coach-daily` 白名单，其余 `extension` |
| `:107,131-134,149-152` | 翻译阶段码 `translation.queued/writing`、进度；coach 进度来自 `coachDaily.metrics` |
| `:185-189` | 日行的 `active`/cancel 规则 |
| `:309-322,328,340,347,353,370-372` | 翻译时限详情、detail、结果引用 `source`、`rejected→partial`、标题；coach 日详情 |
| `lib/job-archive.js:54` | `coach-daily` 不归档 |
| `ui/tasks/task-model.js:18-19`；`task-summary.js:13-14,39,42,61,70`；`task-facts.js:36,49`；`TaskBody.jsx:23,41`；`TaskConsole.jsx:121`；`task-selection.js:11`；`task-control.js:82`；`call-model.js:74,85` | 翻译与 coach 的文案、事实、批次页签、日行选择/控制；`recap`/`workflow`/`assist` **没有任何分支** |

## 6. 与已发布内核 `lib/jobs/**` 的契约差额（交 S4-1）

1. **排队**：内核没有"按库串行队列"这一资源（`scheduler.js` 只导出音频槽池，`resources.js` 是提供方配额）。翻译需经 `definition.admit`（`lifecycle.js:231`）委托 `queues(root)`；"排队中"的展示须与该队列一致，现状是靠 `ahead` 计数推断（缺陷 D5）。
2. **日聚合**：内核 Job 是一次逻辑运行（一个活动 attempt）；为你定制的"一天=N 个批次"、`cancel:false`、"暂停"=账本标志，不适合直接映射成一个 Job。需决定：批次各为 Job + 日行投影（契约夹具），或日行仍由 `coach-daily` 投影。
3. **提交合并与 supersede**：总结的 `generation.next` 合并/重放、`final` 升级、课程变更 `superseded` 不对应内核"一 Job 一活动 attempt"；内核有 `endReason:'superseded'`（`contract.js` AttemptSchema），但缺"提交并入在途 Job"的幂等语义。
4. **取消能力**：教学/骨架/备题批次今天都没有可传播的 signal；迁到网关（`gateway.js` 对每个 Step 给 `entry.signal`）后才会有真取消，须同时让领域写回按当前 attempt 保护。
5. **执行方式**：定义级 `executionModes` 只接受 `direct|subagent`（`registry.js:10-11`），而网关策略有 `agent-preferred|agent-required`（`gateway.js:12`）；翻译现状是"有子代理能力就用 child"（`generation-agent.js`），既非二者之一也无开关，S4-2 须如实声明为 direct 还是 subagent；S4-8 需要定义级的 agent-preferred。
6. **child 复用**：Attempt `executor` 是封闭的 `dsh-jobs` 句柄（`contract.js`），助手一个 child 跨多个任务复用，与"一 attempt 一执行者"不合；`childId/parentId` 已在 Call 上。"cleanup 未完成时公共 wait 不提前宣告收尾"需内核侧语义确认。
7. **账本**：内核按 `callId` 幂等记账（`lifecycle.js:78,239`），旧路径靠 `recordedModels` 同键 sink（`model-usage.js:138`）；迁移时两者不得并存。`USAGE_FEATURES`（`model-usage.js:16`）没有翻译/总结/助手，目前分别落在 `other`/`other`/无。
8. **通知**：内核持久化端口为 `notifications:[{channel, idempotent, deliver}]`（音频试点，`contexts/audio/pilot.js`）；总结与备题的信件与完成**同事务**，S4-5 须拆开后才满足"通知失败不改完成终态"。
9. **预算**：内核 `budget` 仅 `timeoutMs/maxOutputTokens`（`gateway.js:14-17`）；每日总结今天无预算，教学/骨架的超时不会中止底层请求。
10. **恢复**：五个家族的 job 都只在内存（重启后翻译 job 消失、无 interrupted，已测），首轮迁移 `recoveryMode:'none'` 即可，不得顺带承诺恢复。

## 7. 已登记缺陷（均未修复）

| # | 描述 | 证据 |
|---|---|---|
| D1 | 翻译词汇表每波重读，提交后保存的规则会影响已排队/在途 job 的后续段落，与"提交快照"不一致（目标/revision/范围/评论是钉住的） | 测试 `…translation` #3 |
| D2 | 教学与骨架的模型调用不带 signal，"超时/取消"只是丢弃迟到结果，底层请求继续并计费 | `workflow-teaching.js:110,119-122` |
| D3 | 教学没有用户可调用的取消动作，也不在任务控制台 | 测试 `…workflow` #2 |
| D4 | 助手的用量不进账本，也无任务级用量；与其他家族不一致 | 测试 `…assist` #5 |
| D5 | 翻译 `queued`/`running` 由 `ahead` 计数推断，不是读队列本身；若队列里有未登记在 `jobs` 的 Promise，会显示 running 却在等（现有写入者均登记 job，未发现实例，待核验） | `translation-jobs.js:73,161` |
| D6 | 每日总结用量落 feature `other`，笔记不记用量；总结无时间预算 | 测试 `…daily-recap` #5 |
| D7 | 备题日行的 `calls` 记批数，批内重试/对冲不可见；排队中的第二批在开始前无任何可见记录 | `coach-daily.js:184-185`；测试 `…coach` #1 |
| D8 | 已取消的排队翻译 job 立即显示 cancelled，但在队链里仍占位到轮到它才收尾 | 测试 `…translation` #2 |

## 8. 特征测试与已有覆盖

新增（旧实现通过，无生产改动）：`tests/helpers/model-family-baseline.mjs`（`gate`、`privateRoot`、`panelDoor`）；`tests/model-family-baseline-{translation,coach,daily-recap,workflow,assist}.test.mjs`，共 25 个用例。

| U17 条目 | 新测试（编号=文件内顺序） | 已有覆盖（不重复） |
|---|---|---|
| 面板与既有入口同产物 | 五个文件各一例（面板处理器 vs 运行时，两个库）；助手另钉"仅面板" | 工具路径经 `service.call`，见 §1 |
| 翻译等待 `queues(root)` | translation #1、#2、#9（重启后无 job、已保存段保留） | `translation-jobs`（生命周期/用量/通知）、`job-control-translation`（暂停/并发） |
| 总结 supersede 旧 generation | daily-recap #2（迟到结果不写回） | `daily-recap` 取消/合并/删除 |
| 助手旧 tasks/child 状态 | assist #1（记录形状含 childId/reused）、#2（内存 20 条、重启清空）、#3（无 child 无模型拒绝） | `assist-host`（child 生命周期、复用、超时、修复） |
| 提交后不改输入上下文 | translation #3、#4；coach #1；daily-recap #1；workflow #1 | `workflow-teaching`（离开步骤/外部改写）、`daily-recap`（合并 final） |
| 无 child/无观测不算成功 | translation #6（用量 unknown=null、runner direct）；assist #3；daily-recap #3（无模型） | `translation-jobs`（无模型拒绝） |
| 计量/账本 | translation #8、daily-recap #5、workflow #4、coach #1、assist #5 | `wp27-*`（任务用量） |
| 控制台可见性 | translation #7、daily-recap #3、workflow #2（均不在 `snapshot.jobs` 或无独立行） | — |

## 9. 待核验

1. 真实宿主下翻译每批的一次性 child（`resultOwner:'plugin'`）与 `runtime:'subagent'` 步骤；本步只用假模型，step.runtime 仅见 `direct`。
2. 真实 `study_workspace` 工具（假 `ctx.llm`）端到端；本步以"同一 `service.call`"的源码事实 + 面板处理器代替。
3. 真实 `recordedModels` 与宿主汇总在子代理路径下是否重复/遗漏用量。
4. 助手非 derive 模式的收件箱信件写入点。
5. D5 的反例是否存在；跨进程总结 `isRunning` 的 pid 判断（`daily.js:23-29`）。
6. UI 浏览器行为（任务控制台、面板、窄屏）未触及；真实模型质量、耗时、请求数均未抽检（无授权与预算）。
7. §6 的内核差额以当时 main 的 `lib/jobs/**` 为准，S4-1 开工时重核。
