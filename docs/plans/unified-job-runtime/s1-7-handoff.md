# S1 云端收尾与下一位 agent 交接

本轮终点遵从所有者 2026-10-06 07:23:55 UTC 指令：S1-7 后交接，不启动 S2–S6。**S1-6 已验收合并；S1-7 的护栏、回退与本地包检查已执行，真实模型抽检和 alpha 发布仍受阻，不能把整个 S1 标成已发布。** 不需要重做已完成步骤，也不能跳过剩余发布门禁。

## 精确入口与版本

| 项目 | 交接基准 |
|---|---|
| 权威入口 | [README](README.md) → [sprint-1](sprint-1.md) → 本文；规则为 [agent-rules](agent-rules.md)、[17 项审查](review-checklist.md) |
| 已验收运行时代码 / main 基准 | `4204d981eb6d6dca23a44ea430195f78ad1bc5e5`，S1-6 squash merge [#279](https://github.com/EricWang1358/dsh-web-studyhub/pull/279) |
| S1-6 审查头 | `f6149713602b6d4e1d3ff5198d3e52fb1118dbdc`；分支 `codex/runtime-s16-audio`；[委托逐项验收](https://github.com/EricWang1358/dsh-web-studyhub/pull/279#issuecomment-6012045125) |
| S1-6 最终合入基线 | `9ce4775974bcbc3b696f1d36613d2e35b3764df5`（其他工作的 #278）；CI merge `03fcb91294ccb2e8cb6bce6bd7980955ad8b8dc0` |
| 独立 runtime alpha | `codex/unified-runtime-alpha` = `c092d7ac8e73228091a9d0a0a7c04e6b82f64570`，本轮未移动；**不含本轮完整实现，不是可发布候选** |
| S1-7 工作分支 | `codex/runtime-s17-handoff`，从 `4204d981eb6d6dca23a44ea430195f78ad1bc5e5` 分出，只改测试/证据/交接，无生产功能迁移 |
| 最终交接提交定位 | 本文不能自包含自身 commit 或后续 merge SHA；最终 S1-7 head、main merge、PR 与 CI 的完整值以本分支 PR 的收尾评论为冻结清单，同时在交接回复给出。用 `git rev-parse HEAD origin/main` 核对，不凭短 SHA 推测。 |
| 云端活动目录 | `/workspace/runtime-s13-contract`；原 `/workspace/dsh-web-studyhub` 保持在 `c3377f6`，未用于改动 |
| 指定回退目录 / SHA | `/workspace/runtime-s17-rollback`，detached `b53b14752ec74dc149d2c7690cc33a5d6ab9e6b7`，独立安装依赖，未共享 node_modules |

`#259` 文档合并 `c3377f6` 是原始交接点，不是当前 main。当前正式 package 版本为 2.7.0；计划中历史“2.6.x alpha”目标没有被偷偷改写，也没有将正式版降号。发布负责人须在获准发布后协调 alpha 分支/版本，不能把这里的私有 2.7.0 测试 tarball 当作 alpha 预发行。

## S1-0…7 逐项状态

| 步骤 | 状态与证据 |
|---|---|
| S1-0 | 已验收合并 #241，merge `f091f09f830c226bfebc9af22344896733893a10`；基线/能力/旧行为审计保留历史范围。 |
| S1-1 | #245 契约、#255 读取兼容已合并；原先欠缺的生产绑定由 #262、持久化由 #275、公开 single facade 由 #279 补齐。限于 S1 已验收范围，不代表其他任务迁移完成。 |
| S1-2 | 已验收 #262，merge `09a094ae54c6afc68982ed5bc7d21a5a92d46b2e`；真实 owner/controller 绑定。 |
| S1-3 | 已验收 #267，merge `48ff29c301676533744eca65ef2015178edc17b5`；可观察 single HTTP、宿主进程内共享配额，独立默认关闭。 |
| S1-4 | 契约 #270、实现 #272 已验收，merge `be82089666427ac8b8a2fbe0e4ab20c96b35bf39`；模型网关/Call/既有账本。 |
| S1-5 | 契约 #273、实现 #275 已验收，merge `5aecc769d657c094b1dac5b5b832779e976dd9c2`；manifest 恢复与提交核对。 |
| S1-6 | 契约 #276、实现 #279 已验收，merge `4204d981eb6d6dca23a44ea430195f78ad1bc5e5`；公开 single 音频开关默认关，混跑/检查点/原生执行/输出与安装包界面已测。 |
| S1-7 | 授权内护栏、例外清单、回退、包检查及交接已准备；本 PR 的最终检查/合并见收尾评论。**真实质量与 alpha 发布未执行，步骤仍受阻，不勾选发布完成。** |

S1 的日常技术取舍、阶段审查和检查通过后的合并由所有者 04:07:50 UTC 委托。排除项始终是付费模型调用、外部权限/凭据变化、不可恢复用户数据删除、发布和部署；本轮未做这些动作，也未操作或停止用户本地任务。

## 通过、失败与未运行

机器证据：[S1-6](s1-6-audio-evidence.json)、[S1-7](s1-7-evidence.json)。所有命令通过私有 runner 清理密钥环境，使用 Node 22.22.3、私有 TEMP/TMP/DSH_HOME，真实宿主测试 `SSH_TTY=audit`。runner 位于 `output/s13-contract/run-command.mjs`；没有使用 `STUDY_TEST_NO_LOCK`。

| 验证 | 结果与范围 |
|---|---|
| 最终音频代码 `npm run verify` | **5849 通过 / 0 失败 / 2 跳过**，640582.614471ms；`s16-accepted-verify.log`，SHA256 `bd0b227f3a6e4472d1b820d3492f68851b87d8f88510dbb7c21db2c2dd01dda6`。这是回执修复后、独立 #278 合入前的云端完整浏览器验证。 |
| 最终集成基线完整 CI | [run 37432413774](https://github.com/EricWang1358/dsh-web-studyhub/actions/runs/37432413774)，Ubuntu `112166127917`、Windows `112166128029` 各 **5770/0/94**。跳过的环境相关测试不能冒充通过；云端浏览器结果单列。 |
| 合入 #278 后定向复核 | `node scripts/test.mjs tests/unified-runtime-adapters.test.mjs tests/unified-runtime-audio-pilot.test.mjs tests/unified-runtime-contract.test.mjs tests/job-contract.test.mjs tests/deck-parts.test.mjs`：**69/0/0**；lint 通过。没有无理由第三次重跑全部云端浏览器。 |
| 实际安装包 | `output/qa/s16-accepted-host`：rc.2 jobs/children、当前安装源码指纹、公开排队回执/暂停/恢复/取消/输出/成品与四档 console 检查通过；全部模型为本地假响应。截图已纳入仓库 `evidence/s1-6/`。 |
| S1-7 护栏 | `node scripts/test.mjs tests/unified-runtime-architecture.test.mjs tests/architecture-boundaries.test.mjs tests/backend-boundaries.test.mjs`：**16/0/0**；新增 guard 最初缺实现的红灯保留 `s17-guard-red.log`。最终 lint/build 通过。 |
| S1-7 回退/回到新版本 | 三个真实 Node 进程依次 prepare、old-read、current-resume；旧库正文逐字一致、0 模型请求、未完成 manifest 不变；旧版明确不可继续，新版显式恢复只执行 proofread/translate/title、1 个新执行绑定、不重复转写。 |
| 私有包 | build 后 `npm pack --ignore-scripts --json --pack-destination output/qa/s17-pack`；551 文件，包含精确 pilot 源码和 client，不含私有 output/node_modules/学习库；SHA256 `5f76ff1936f967dec45f5a316d6fe3b9bd75e32cde58b77fc477777a919e037e`。未发布。 |
| 失败历史 | S1-6 多个红灯和宿主/安装/选择器失败均见实施记录；回执缺陷在一次全量绿后才补测发现，旧绿不能替代修复后结果。S1-7 初始探针误从 lean snapshot 读正文，检查时发现缺正文，改为 `source.get` 并断言非空后重跑；仅 `*-final-*` 记录用于回退结论。 |
| 未运行 | 真实模型质量/账单、真实远端停止确认、桌面或 web 宿主整体降级、alpha 发布、部署、S2–S6。本 S1-7 测试/文档提交无生产变动，复用上述生产完整验证，加新护栏/回退/包检查与本 PR CI；不把复用称为新的云端全量运行。 |

## 护栏与保留路径

[例外清单](s1-7-legacy-exceptions.json) 登记 31 个源码模块的现有模型形态调用或任务/队列集合声明，每项有入口、责任者、原因、后续审查/移除阶段与证据。测试使用 AST CallExpression、导入边界和集合绑定角色；普通缓存、注释中的 fetch/Map 和非模型下载不会只因字符串命中而失败。新增受管定义必须登记，single pilot 禁止直接模型调用、第二任务表/队列和直接生命周期写入，共享流水线必须收到 gateway。

这是约束已识别静态 API 的回归护栏，不是全程序污点证明；动态别名/反射等仍须人工审查。未迁移的批量、live、字幕、纠错、出题、学习流、转换等按 S2–S6 对应阶段处理，不能利用“旧文件在清单”无审查增加新调用。网关/provider 受控叶节点可能长期保留，登记移除阶段是责任复核点，不是要求机械删除。

## 回退限制与下一步

指定旧 SHA 是 `b53b14752ec74dc149d2c7690cc33a5d6ab9e6b7`。演练先关闭新接纳（新任务确认为 v1），等待完成任务排空，对另一受管任务保存安全检查点，再由旧版 `StudyService` 独立进程启动并读取同一**私有合成库**。旧版的 `resume` 不可用，原因 `kernel-recovery-required`；直接 `audio.retry` 也拒绝，不尝试支付模型请求。资料可读与未完成新任务能否继续是两个独立结论。

回到兼容的新版本后仍须显式 resume；不删除旧记录，不重写为 legacy，不根据请求意图猜测远端结果。真实远端未确认结果仍须 reconciliation，无法确认就保留拒绝。

下一位 agent 的第一步是读本文、PR 收尾评论和 [S1-7 条目](sprint-1.md#s1-7-护栏与发布)，核验实际 refs/工作树。**首个未完成工作是 S1-7 的发布门禁：另行获得真实抽检的模型/输入/预算授权，记录质量、耗时、请求与用量，再取得 alpha 发布授权并处理独立分支/版本。** 不自动联系其他 agent，不自行发布。只有所有者新授权后才从 [S2-0](sprints-2-6.md#u1-s2-0) 开始后续音频迁移。

私有持久产物：`output/s13-contract/` 保存命令日志和 scrubbed runner；`output/qa/s16-accepted-host/` 保存宿主完整报告；`output/qa/s17-rollback-final-library/` 保存合成回退库（最后已经在新版完成恢复）；`output/qa/s17-pack/` 保存私有 tarball。若云端工作区不可用，可从已推送分支恢复源码/测试/仓库证据，按上述 fixture 重新生成私有数据；不能把哈希当作丢失原始日志的替代物。
