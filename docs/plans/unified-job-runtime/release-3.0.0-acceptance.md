# 3.0.0 发布验收记录

本页记录发布候选的验证范围，随发布 PR 冻结；合并后的完整检查、最终 SHA 与附件校验结果记在 PR 评论及 [3.0.0 发布页](https://github.com/EricWang1358/dsh-web-studyhub/releases/tag/v3.0.0)。授权、分工和发布条件见 [执行约定](release-3.0.0.md)。未完成事项不能因版本号变为 3.0.0 而视为通过；本页不覆盖 S6-7 的历史证据。

## 已确认的基线

- 集成基线：`4d04f751112d30387f295d1e590771931fe557d1`，包括控制台音频详情 [#364](https://github.com/EricWang1358/dsh-web-studyhub/pull/364) 和非音频回归矩阵 [#365](https://github.com/EricWang1358/dsh-web-studyhub/pull/365)。两份 PR 的独立评审与 Windows/Ubuntu CI 通过后合并。
- 宿主基线是隔离 DSH `0.2.0-rc.2`。它验证的是当时从上述 SHA 打包、版本仍标为 `2.7.1` 的包，不能替代最终 3.0.0 安装包验收。
- 真正 `v2.7.1` 发布主包已下载，并与该 Release 的校验和文件比对：`64c6ffc27b3da2f93360ac240a15c077632aa41b3a7d1e7f79e2e30158f774f9`。升级回退必须用这份包，不能把当前代码重标为旧版。

## 当前门禁

| 项目 | 状态与证据边界 |
| --- | --- |
| 本地程序停止修复 | 受控红灯复现，最初定向 21/21、最终相关四文件 38/38 通过；修复已独立评审并整合，整合后的 S5-7 五场景回退演练通过。最终集成全量验证和双平台 CI 仍待完成。 |
| 中文真实宿主 UI | 基线 8/8 通过，页面/控制台错误均为 0；模型为本机 fake。 |
| 英文真实宿主 UI | 最终 8/8 通过，页面/控制台错误均为 0。首次 7/8 暴露 QA 的旧英文按钮选择器；复跑另修正引导页等待保存的方式，未扩大超时。 |
| 真实宿主运行时 | 基线 19/19 通过，测试 overlay 开启全部 23 项；只能证明所运行的本机 fake 路径。 |
| 宿主界面矩阵 | 150% 下设置按钮不可达的缺陷已修复；浏览器回归 14/14、重建安装后的真实宿主运行时 19/19、界面矩阵 16/16 通过，CLS/页面错误/控制台错误均为 0。见 [S6-9](s6-9-host-qa.md) 和 [PR #366](https://github.com/EricWang1358/dsh-web-studyhub/pull/366)；Windows/Ubuntu 双 CI 通过后已合并，merge SHA 为 `f9a195872d9833b36daf7aee13acfa7c23d24032`。产品缩放不等同浏览器缩放。 |
| 真实模型质量 | CommandCode 累计 25 个样本，20 个业务完成、5 个历史失败；完成不代表内容全对。修复后的 5 个定点样本全部完成：补题 off/on、字幕 off/on、固定 q1 单卡定制。补题原 10 题及学习流原范围保留；host 字幕型号写为 null。相关产品回归分别 66/66、10/10。原 3 题定制返回不完整 JSON 的失败仍未解决，单卡成功不能代替；内容角色措辞、无依据的掌握推断及增强学习流拒绝等限制保留，见 [S6-10](s6-10-model-qa.md)。 |
| 四组 2.7.1 回退演练 | 本轮四组均通过：音频型号修复后的 S2-7（5 场景）、S3-7（8 场景）、S4-9（12 场景）、停止修复整合后的 S5-7（5 场景）。[S2](evidence/release-3.0.0-s27.json)、[S3](evidence/release-3.0.0-s37.json)、[S4](evidence/release-3.0.0-s49.json)、[S5](evidence/release-3.0.0-s57.json) 单独保存，不覆盖历史记录；这些库级演练不替代真实安装包往返。 |
| 定制任务摘要 | 每日记录闲置不再被误写为批次成功；失败筛选包含已结束的失败批次。公共每日契约和暂停入口不变。7 个新增场景先红后绿，相关 60/60 定向检查、中英 × 1280/420 × 100%/150% 八格浏览器探针通过，见 [修复说明](release-3.0.0-fixes.md)。 |
| 升级状态持久化修复 | 已修复已运行版本仍残留 pending 标记、导致 CLI 回退后无法再次升级的问题；5 项原始红灯，定向安装/检查 29/29 通过，延迟网络并发补充检查 1/1 通过，lint 通过。focused 审查 0 findings：作者 correctness、发布负责人独立本地 adversarial，见私有 `output/verification/300-model-update-fix/review.json`。无跨模型审查结论；实际包门禁仍待完成。 |
| 完整验证暴露的两处偶发缺陷 | 最终集成全量验证 7050/7064、2 失败、12 跳过；上一轮同代码通过，故均为偶发。①窄窗口首屏 CLS 0.0369：后台挂载的课堂实录视图在代码载入期间显示 46 px 的载入条，到达后页面上移；用 CPU 限速复现并定位，修复后同探针 16/16 为 0。②看板保存 EPERM：看板与笔记本登记的文件替换没有重试，已与学习库统一为共用的 `renameWithRetry`。两处均先红后绿，见 [修复说明](release-3.0.0-fixes.md)。修复后的完整验证见下一行。 |
| 真实包升级回退 | 探针已准备，待候选包执行 `2.7.1 → 3.0.0 → 2.7.1 → 3.0.0`；必须保留 `update.json` 验证回退后的界面再升级，不能删除缓存迁就探针。 |
| 依赖审计 | 仅更新开发依赖 `brace-expansion` 的两个补丁版本（5.0.12 / 1.1.21），更新后审计 0 个已知漏洞；完整验证仍待完成。 |
| 最终 main 验证与发行物 | 尚无最终发布 SHA、完整 verify、双平台 CI 或 3.0.0 发行物校验结果。 |

S3-7 的 `publish-before` 场景验证发布前中断后的旧版读取、完成发布及再次前进；新运行时仍可把中断任务显示为 failed，不能把演练通过解读为每条任务记录都是 complete。该库级场景不覆盖已有活跃学习流的全部发布边界；另有补题发布修复的 66 项公共路径回归和真实 off/on 定点复验。真实包往返及最终集成全量验证仍待完成。

`brace-expansion` 的修复范围依据上游公告：[嵌套递归耗尽栈](https://github.com/advisories/GHSA-qhr7-859c-m2p7)、[展开操作二次复杂度](https://github.com/advisories/GHSA-q2hr-2g5m-vwhr)。该依赖只在开发工具链中，不把审计为零写成所有安全问题均已排除。

## 默认值与兼容边界

发布负责人依据当前真实抽检与兼容证据，冻结 **23 个开关全部默认关闭**。首轮模型抽检仍有质量失败，其他家族缺少充分真实环境证据，因此本次没有默认值翻转。既有显式 opt-in 配置继续生效；仅影响新提交，在途任务保留原执行者与策略。旧执行路径保留，持久化格式不随产品版本号改动。

| 组别 | 默认 `false` 的完整清单 |
| --- | --- |
| 音频迁移（6） | `audioSingle`, `audioLiveSave`, `audioLiveCorrection`, `audioReview`, `audioSubtitles`, `audioBatch` |
| 出题迁移（3） | `generation`, `generationRepair`, `generationPublish` |
| 其他模型迁移（6） | `coach`, `dailyRecap`, `workflow`, `assist`, `noteGenerate`, `translation` |
| 本地工具迁移（4） | `markerInstall`, `mineruSetup`, `pdfConvert`, `retrievalIndex` |
| 独立增强（4） | `generationRestart`, `dailyRecapAgent`, `workflowAgent`, `translationParallel` |

列表以 `lib/runtime-config.js` 的 `MIGRATION_SWITCHES` 为准；所有 schema 项均 `.default(false)`。显式关闭恢复既有提交路径，不声称恢复旧进程中未持久化的任务。`generationRepair`、`generationPublish`、`generationRestart` 仍依赖 `generation`。

课堂校正的长时间历史增长、真实转写、Marker/MinerU 安装和云转换、真实搜索扩展、一整天的 experience channel 使用，以及所有者真实学习库的流程，均不能从本轮 fake 检查推导为已验证。发布说明必须如实列出仍未完成的项目。
