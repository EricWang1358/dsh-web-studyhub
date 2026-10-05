# S1-1：契约评审交付与验证

**当前交付仅为契约评审，S1-1 尚未完成。** 生产 projector 仍为 v1；未新增内核、facade、调度器、网关、持久化或开关。契约评审合并后，才能提交版本读取和旧入口兼容实现。

## 前置接受与文件归属

S1-0 的 [PR #241](https://github.com/EricWang1358/dsh-web-studyhub/pull/241) 已经所有者接受并授权合并；接受范围和未确认限制见 [基线接受记录](s1-0-baseline.md#评审接受与合并)。已接受的历史基线为 merge `f091f09f830c226bfebc9af22344896733893a10`；当前兼容基线为正式 2.6.1 `e61f6debe9436794cafc2bc8c65a0d0164e5ac5e`。alpha 工作分支为 `codex/unified-runtime-alpha`，正式 main 仍运行发布版。

| 修改者 | 唯一文件范围 | 交付 |
|---|---|---|
| 内核负责人 | docs/job-contract.md、README/sprint 接手记录与本验证记录；F091 阶段曾修正旧 panel 测试时钟，现已由正式 2.6.1 测试替代 | 同一公共形状的拟议 v2、写入者、后续门禁与集成验证 |
| 契约 fixture 代理 | tests/fixtures/unified-runtime-contract.mjs、tests/unified-runtime-contract.test.mjs | 复用 schemastery 的静态 schema、关系检查及拒绝测试；根代理集成独立审查修正 |
| 兼容代理 | s1-1-compatibility.md、tests/fixtures/unified-runtime-compatibility.json | 发布 v1 事实、旧入口差异、4 组带合成前提的兼容向量 |

契约正文以 [docs/job-contract.md 的 S1-1 proposal](../../job-contract.md#proposed-v2-s1-1-contract-review) 为准；旧入口事实及动作顺序以 [兼容矩阵](s1-1-compatibility.md) 为准。JSON 只包含合成输入的实际 v1 projector 输出与明确标记为合成前提的 v2 数据，不是生产任务或真实宿主迁移记录。

## DSH 优先与手写边界

- [DSH-02](s1-0-dsh-capabilities.md#固定行-id-能力对照)：直接复用已安装 `schemastery@3.18.0`；不更改依赖，也不把 DSH fork 3.18.4 的构造器视为相同实例。
- fixture 中的闭合元字段、版本拒绝和关系检查是 Job/Attempt/Step/Call 的业务契约，不是另一校验框架或状态机。宿主 primitive schema 不能判断同一 Job 的身份引用和能力/动作关系，因此用小量静态检查补齐。
- [DSH-01/03/04/07/08/09](s1-0-dsh-capabilities.md#固定行-id-能力对照)：仅记录字段和责任层。没有自建 jobs 表、queue、retry、provider、结算或账本；真实绑定与唯一执行责任者仍须后续宿主验证。
- 所选库会给部分缺省对象补值，接受非有限 number，并可能把 Date 当作字典；实际红灯见下表。本 fixture 的 schema transform 保留 null/absent，要求可保存的 plainData 拒绝改写、函数与 accessor；验证不会执行输入的自定义 serializer。这是已观察的数据校验缺口，不代表 DSH 缺少任务服务。校验通过不能证明模型调用、checkpoint、安全恢复或 host owner 真实存在。

## 本地证据

所有测试使用自有依赖、私有 TEMP/TMP/DSH_HOME、`SSH_TTY=audit`，清空 `*_API_KEY`、`*_TOKEN`、`*BASE_URL`。仓库 runner 的机器锁与网络隔离保留；没有真实 provider 请求，也不读取所有者学习库或配置。日志保存在忽略目录 `output/runtime-s10/`、`output/runtime-s11/`，不提交模型输出或用户数据。

| 阶段 | 命令 / 证据 | 实际结果 |
|---|---|---|
| schema 初次红灯 | node scripts/test.mjs --test-concurrency=1 tests/unified-runtime-contract.test.mjs；s11-contract-red.log | 2 pass / 7 fail；缺省对象处理不符合 absent/null 约定 |
| 关系守卫前红灯 | 同上；s11-contract-relations-red.log | 4 pass / 5 fail；版本、关系、观测、能力错误尚未被拒绝 |
| 定义版本守卫前红灯 | 同上；s11-definition-red.log | 10 pass / 1 fail；最新定义不匹配未拒绝 |
| 物理状态守卫前红灯 | 同上；s11-physical-state-red.log | 10 pass / 2 fail；终态 active / checkpoint-paused 不一致未拒绝 |
| JSON 数据边界前红灯 | 同上；s11-json-boundary-red.log | 13 pass / 5 fail（18 tests）；NaN/Infinity/undefined/Date/percent NaN 被错误接纳 |
| 自定义 serializer 前红灯 | 同上；s11-custom-serializer-red.log | 17 pass / 2 fail（19 tests）；输入 toJSON 被执行，修正后调用计数为 0 |
| fixture 最终定向检查 | 同上；s11-contract-final.log；两文件 ESLint | 19 pass / 0 fail / 0 skip；188.6 ms；ESLint 通过 |
| 首轮集成回归 | node scripts/test.mjs --test-concurrency=1 tests/unified-runtime-contract.test.mjs tests/job-contract.test.mjs tests/job-control-audio.test.mjs tests/job-output-audio.test.mjs tests/audio-single-characterization.test.mjs；runtime-s11/targeted.log | 33 pass / 0 fail / 0 skip；13950 ms；后续数据边界修正另行复验 |
| 审查状态守卫前红灯 | node scripts/test.mjs --test-concurrency=1 tests/unified-runtime-contract.test.mjs tests/task-console-panels.test.mjs；review-state-split-red.log | 26 pass / 3 fail；无 Attempt 的 checkpoint pause、终态不一致、物理运行中仍允许 queued-only pause 未被拒绝 |
| 首轮审查定向回归 | 首轮集成命令另含 tests/task-console-panels.test.mjs；targeted-final.log | 50 pass / 0 fail / 0 skip；7999 ms；22 条新契约测试、7 条旧 panel 测试及 v1/音频路径 |
| 首轮完整检查 | npm run verify；verify.log | lint 通过；4953 pass / 0 fail / 1 cancelled / 2 Windows skip；旧 deck-archive-browser 超时，build 未运行 |
| 归档测试复现 | node scripts/test.mjs --test-concurrency=1 tests/deck-archive-browser.test.mjs；deck-archive-repro.log | 未改代码单独重跑通过；完整复跑也通过，首次超时原因未确认 |
| 完整复跑及时间缺陷 | npm run verify；verify-recheck.log；panel 单跑 timeline-clock-red.log | lint 通过；4953 pass / 1 fail / 2 skip；旧 timeline 只剩 1 个 bar，单跑复现 6 pass / 1 fail；build 未运行 |
| 首轮审查完整检查 | npm run verify；verify-final.log | lint、4957 pass / 0 fail / 0 cancelled / 2 Windows skip、build 全部通过；测试 195067 ms；exit 0 |
| 状态组合复核前红灯 | node scripts/test.mjs --test-concurrency=1 tests/unified-runtime-contract.test.mjs；review-active-checkpoint-red.log | 22 pass / 3 fail（25 tests）；运行中无活动 Attempt、queued/运行中 Attempt、不正确的 checkpoint 成功终态未拒绝 |
| 最终定向回归 | 六文件命令同前；targeted-reviewed.log | 53 pass / 0 fail / 0 skip；7961 ms；25 条契约测试、7 条旧 panel 测试及 v1/音频路径 |
| F091 最终完整检查 | npm run verify；verify-reviewed.log | lint、4960 pass / 0 fail / 0 cancelled / 2 Windows skip、build 全部通过；测试 206702 ms；exit 0 |
| 文档引用 | Markdown 链接与标题锚点检查 | 六份变更文档共 59 个本地引用、18 个固定基线源码引用，均通过；F091 十份变更文件 CRLF 通过 |

上述红灯是在对应守卫实现前实际运行得到，未删除已写实现制造事后失败。golden 校验只证明给定数据形状与已发布 v1 projector 输出；未来真实行为须另写 public-entry 测试。以上记录固定在 F091 的工作树，不代表已验证并行更新后的正式 2.6.1。没有 UI 或生产代码改动，当前不以浏览器截图/真实模型质量抽检替代契约验证。完整复跑发现旧 panel 测试固定使用 2026-10-05 10:00 UTC 的数据，却读取真实当前时间；运行中的 timeline 正确裁掉十分钟前的调用。F091 阶段仅该测试用 node:test 的 mock 固定 Date.now 到 fixture 第 40 秒，保留四个 bar 的原断言；测试结束自动恢复时钟，未改生产窗口、超时或网络隔离。正式 2.6.1 的测试在同步时已替代该临时改动，最终相对 E61 不包含 panel 测试修改。

## 同步正式 2.6.1

F091 契约稿经完整验证和原生独立审查后保存为本地 `3bc2e1a`（旧测试时钟）与 `eab40db`（S1-1 契约）；审查回执 `20261005-s11-3d09d225` 为 complete，绑定 F091 diff SHA256 `10f245fe4f2deb8ebd0e168104d3e6ee17b6c63dc028630f60a42690649a1778`。它不证明新基线兼容。

随后 alpha 用本地 merge `b66b41b` 同步正式 [PR #242](https://github.com/EricWang1358/dsh-web-studyhub/pull/242) / E61，保留全部正式行为。唯一冲突采用正式 panel 测试，其时间线使用完成视图、OutputView 使用固定 now，已替代 F091 临时时钟修正。相对 E61 的交付仍只有九份文档与 fixture/test，无生产、依赖或 UI 改动。S1-0 历史接受记录不改写，当前归档/结束输出说明及纯投影数据按 E61 补充。

| E61 集成证据 | 实际结果 |
|---|---|
| 自有依赖 | npm ci --legacy-peer-deps，私有测试环境；npm-ci-e61.log；exit 0 |
| 契约及现有边界定向回归 | 10 文件 runner（契约、v1/音频、归档、结束输出、panel）；targeted-e61.log；107 pass / 0 fail / 0 skip；12204 ms；exit 0 |
| 完整 verify | npm run verify；verify-e61.log；lint、5142 pass / 0 fail / 0 cancelled / 2 Windows skip、build 全部通过；测试 247762 ms；exit 0 |
| 最终归档交接断言 | 完整 verify 后仅补 saved archive → restored input 的 deepEqual；contract-handoff-e61.log；25 pass / 0 fail / 0 skip；271 ms；exit 0；最终 PR head 由 CI 全量验证 |
| 最终引用与审查 | 59 个本地引用、35 个固定 SHA 源码引用、CRLF 与 diff 检查通过；最终 E61 独立审查回执随本步 PR 交付，F091 回执仅作历史 checkpoint |

## 待评审与后续验收

简化复核的代码复用、质量、效率三项均已完成：无实质代码删改；修正一处注释以准确说明校验次序。没有独立 typecheck 命令；E61 lint、107 条定向回归、5142 条完整测试与 build 已通过，保留 2 条既有 Windows skip。独立代码审查发现的状态缺口经实际红灯和修正后回归覆盖：checkpoint pause 必须存在已保存的结束 Attempt；终态与最新 Attempt 一致，但保留 checkpoint pause 后逻辑取消的例外；queued-only pause 不能在物理 Attempt 已运行或结束时开放；running 需要活动 Attempt，queued 的活动 Attempt 也应 queued，checkpoint-pause 不能成为逻辑成功终态。审查回执与最终 diff 在本步 PR 中交付；使用原生独立审查上下文，未开展跨厂商模型审查。未合并的契约稿不能勾选为 S1-1 完成，更不能直接供其他生产模块接入。

合并后先实现同一来源的版本读取和 legacy facade 委托，执行旧查询/控制/等待/输出/通知/UI 身份回归，再满足 S1-1 全部验收。S1-2 真正 StudyHub scope/Agent/controller 绑定、一次结算与迟到产物保护；S1-3 共享资源；S1-4 唯一 gateway 与观测；S1-5 故障恢复和持久去重；S1-6 开关双路径与 UI 宿主流程仍未实现。

后续试点开关仍默认关闭，恢复、调度策略、子代理策略改进各自独立。此 PR 回退仅撤回文档与测试，没有数据升级；它不能证明未来 alpha 的跨版本回退，正式回退演练在 S1-7 执行。
