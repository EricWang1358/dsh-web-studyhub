# S1-1：版本读取与兼容实现

契约前置 [PR #245](https://github.com/EricWang1358/dsh-web-studyhub/pull/245) 已审查、双平台 CI 通过，并按所有者 2026-10-06 的指令合并；merge SHA 为 `169a69ee8c64476576ce5bbc4ef9331d2db8ee1e`。本实现基于该已提交正式基线，在独立 `codex/unified-runtime-alpha` 分支继续。兼容实现仍待 PR 评审合并，S1-1 未勾选完成。

## 实际接线

- [lib/jobs/contract.js](../../../lib/jobs/contract.js) 是唯一 Job/Attempt/Step/Call schema 和版本 reader。复用已审定的 schemastery 声明，fixture 改为导入生产实现；未保留第二份 validator。
- [jobContract / snapshotJob / checkAction](../../../lib/job-contract.js) 保持普通旧记录的 v1 输出、旧状态映射和动作顺序。已投影视图和保存契约先检查声明版本；v2 恢复历史保留 runtime、能力和公共扩展，动作仍经同一个 actionState 判定。不会从 v1 补造 Attempt、owner、checkpoint 或观测数据。
- [job.unarchive](../../../lib/contexts/jobs/operations.js) 先校验整批找到的记录，再委托现有 archive.remove。缺失/未知契约版本、未知 runtime schema、损坏形状、错误物理引用、矛盾观测或能力有明确错误码；拒绝不移除原归档，不恢复 manifest，不插入 Job。
- v1 归档继续使用原恢复入口及拒绝顺序。v2 历史先放回同一 jobs，再让既有恢复扫描按真实归档别名和文件夹排除它；混合恢复及之后恢复 v1 都不会覆盖 v2 或建立旧 retry hold。内部关联只保存归档已有事实，不猜 batchId/singleId，不出现在 snapshot 或 lean job.status。重新归档保留关联，删除/关闭仍委托既有清理；v2 历史离开百条内存列表前，等待同一归档 writer 成功；写入失败仍保留历史及恢复排除。永久删除按同一 writer 排在待写归档之后，再移除历史与文件，避免已删除记录重新出现。格式 envelope、writer 和限额沿用原实现，不增加恢复参数或执行器。

## DSH 优先与自写边界

[DSH-02](s1-0-dsh-capabilities.md#固定行-id-能力对照)复用实际安装的 `schemastery@3.18.0`；本轮没有新增依赖或校验框架。业务身份引用、版本分流与元字段闭合沿用 #245 的已审定规则。只读输入测试复现 schema 会赋值给原对象，因此解析前检查主动值并复制数据；返回数据不修改冻结的保存输入。该副本是读取边界，不是另一份任务事实来源。

DSH-01/03/04/07/08/09 的真实 StudyHub 绑定、停止、执行、计量和恢复门禁保持原范围。本轮不新增任务表、队列、重试、账本、provider 或生命周期结算。

## 验证记录

基线为 `169a69e` 加本 PR 所有文件；最终提交 SHA 和双平台 CI 以实现 PR 的证据为准。测试均用自有已安装依赖、私有 TEMP/TMP/DSH_HOME，清除密钥/Token/Base URL，`SSH_TTY=audit`；保留仓库网络隔离和机器锁，无真实模型或所有者数据访问。没有新增浏览器、ffmpeg 或宿主程序测试。

| 阶段 | 实际结果 | 工作树证据 |
|---|---|---|
| 归档实现前红灯 | 30 failed：尚未拒绝不兼容数据/保留 v2 投影；不是导入或环境失败 | `output/runtime-s11-compat/archive-red.log` |
| 读取实现前红灯 | 8 passed / 16 failed：旧数据保持通过，版本/形状/引用/观测/能力拒绝尚未接通 | `output/runtime-s11-compat/live-red.log` |
| 初次接线 | 124 passed / 14 failed：冻结输入暴露 schema 的原对象写入 | `output/runtime-s11-compat/compatibility-green.log` |
| 副本校验后 | 136 passed / 2 failed：批量归档测试把两种记录顺序混用；文件字节未改变 | `output/runtime-s11-compat/compatibility-green-2.log` |
| 修正测试比较顺序 | 十文件 138 passed / 0 failed / 0 skipped，6,238 ms | `output/runtime-s11-compat/compatibility-green-3.log` |
| 初次全量 | lint 通过；5,300 passed / 6 failed / 2 Windows skip，构建未运行。5 项 Marker 失败来自过长 TEMP 的 ENAMETOOLONG，1 项布局 CLS 为 0.0355 | `output/runtime-s11-compat/verify-compatibility-2.log` |
| 环境复验 | 只缩短自有 TEMP/TMP；同两文件 6 passed，CLS 为 0；未改生产代码或测试断言 | `output/runtime-s11-compat/environment-recheck.log` |
| 真实恢复红灯 | 新增 8 failed：batch/single 混合或随后 v1 恢复覆盖 v2，重归档别名/删除清理/内存淘汰关联丢失 | `output/runtime-s11-compat/real-recovery-red-2.log` |
| 修复后定向 | 十一文件 146 passed / 0 failed / 0 skipped，5,749 ms，零模型调用 | `output/runtime-s11-compat/compatibility-green-4.log` |
| 修复后初次全量 | 5,313 passed / 0 failed / 1 cancelled / 2 Windows skip；旧 deck-archive-browser 90 秒超时，未运行构建 | `output/runtime-s11-compat/verify-compatibility-final.log` |
| 原浏览器复验 | 1 passed / 0 failed；8,191 ms；保持断言、源码与超时 | `output/runtime-s11-compat/deck-browser-recheck.log` |
| 补归档故障保护前全量 | lint / 5,314 passed / 0 failed / 0 cancelled / 2 Windows skip / build 全通过；不覆盖随后新增保护 | `output/runtime-s11-compat/verify-compatibility-final-2.log` |
| writer 等待/失败红灯 | 8 passed / 2 failed：历史先从内存消失，写失败时丢失唯一恢复排除 | `output/runtime-s11-compat/prune-writer-red.log` |
| writer 保护后 | 148 passed；新测试先误用不存在的公开 recover 名称，修正为已有 typed audio.v1/recover 后通过，未新增 API | `output/runtime-s11-compat/compatibility-green-5.log`、`compatibility-green-6.log` |
| 删除交错红灯 | 10 passed / 2 failed：实际 archive writer 已保存、prune 交接未返回时，delete/dismiss 没有移除归档副本 | `output/runtime-s11-compat/prune-delete-red.log` |
| 最终定向 | 十一文件 150 passed / 0 failed / 0 skipped，5,633 ms，零模型调用 | `output/runtime-s11-compat/compatibility-green-7.log` |

定向命令：`node scripts/test.mjs tests/unified-runtime-recovery-read.test.mjs tests/unified-runtime-live-read.test.mjs tests/unified-runtime-archive-read.test.mjs tests/unified-runtime-contract.test.mjs tests/job-contract.test.mjs tests/job-status.test.mjs tests/job-archive.test.mjs tests/job-archive-ops.test.mjs tests/job-archive-service.test.mjs tests/job-control-audio.test.mjs tests/audio-single-characterization.test.mjs`。前两组新测试并行编写，真实服务恢复回归由根代理补充；根代理拥有全部生产文件和权威验证。旧回归测试及兼容 JSON 未改。

最终冻结源码 `npm run verify` 已通过：lint / 5,318 passed / 0 failed / 0 cancelled / 2 Windows skip / build，218,461 ms；证据为 `output/runtime-s11-compat/verify-compatibility-release.log`。两个既有 signal-handler 测试在 Windows 跳过。双平台 CI 以实现 PR 为准。正式 `ce-code-review` 回执 `20261006-s11-compat-169a69ee` 已完成八个检查视角，修复前十文件 diff SHA-256 为 `0c1d0a769dea978faf4796e4ca00035c39abf4be5f08780795d584faf5e5ee6c`；唯一 P1 为旧全库扫描覆盖 v2 历史。根代理按真实入口红灯修复；后续独立核验又指出 writer 失败保护及永久删除排序，并逐项补齐。旧回执不改写为修复后结论；修复后 `followup-validation.json` 为 complete，原 P1、writer 失败保护与删除排序均验证关闭，未解决源码发现为零。六个生产文件排序 path/SHA-256 manifest 的 hash 为 `7a4ce98592ad6eb3e27157f973e0715a333f3b94cd6e2abdbce10110cc27e668`，该值不是 Git diff hash；最终生产与测试文件逐项复验仍匹配独立核验，文档更新另做最终差异和链接核验。原生审查共享模型系列，不宣称跨供应商独立审查。本地输出不跟踪进仓库，PR 的验证记录提供可复核交付入口。简化检查复用/效率无修改；质量检查统一版本常量、去掉临时 PR 历史注释，未删安全检查。

## 实现范围与下一步

这是明确版本的读取及旧入口兼容边界。v2 数据的 admission/物理历史在测试中是显式合成前提，不证明 live executor、controller、checkpoint 或恢复可用。新 Job/Attempt 创建、状态转换、一次结算、跨 Attempt facade 与稳定通知由 S1-2 及后续步骤验证；本轮不把这些算成已实现。

没有新增配置开关或改普通任务默认值。alpha 试点仍默认关闭；此 PR 不升级旧记录，也未发布 alpha。回退撤回 reader 接线即可继续读原 v1；真实 alpha 数据升级和回退演练仍为 S1-7 门禁。

## 已记录的限制

审查记录指出：archive envelope 的 `record.id`、`job.id`、任意 aliases 与内部有效 v2 契约之间尚未做完整一致性核对。既有 writer 构造正常身份关联；已批准契约未定义任意历史 alias 到 runtime 的完整关系。本轮保持旧 envelope 读取规则，不猜新身份。该损坏边界限制留给 S1-5 的存储与恢复门禁；不能据本轮测试声称任意损坏 archive envelope 已通过验证。

解除归档后的 v2 历史仍是内存记录；本轮覆盖重新归档后的重启读取，未证明解除归档后跨进程保留 runtime 历史。该公共元记录持久化和恢复边界归 S1-5。本轮普通 producer 仍为 v1，不能据合成 v2 测试提前启用新执行路径。
