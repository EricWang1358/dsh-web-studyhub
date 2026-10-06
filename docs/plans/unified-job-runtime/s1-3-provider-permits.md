# S1-3：共享 provider 许可与实际入口接线

负责人 Codex 云端内核负责人；分支 `codex/runtime-s13-provider-permits`；独立 worktree `/workspace/runtime-s13-contract`、自身 node_modules。基线 `ed157f377c3116910d96158e6ecc41ef550ee166`，包含 #259 文档 merge c3377f6。文件范围见 [机器证据](s1-3-provider-evidence.json) 的源码指纹。

所有者 2026-10-06 02:53:23 UTC 授权 #264/#265 检查通过后合并，分别于 02:55:20、03:02:46 UTC 合并为 `5bbc22d`、`ed157f3`。本次实现依照已合并资源契约；**本 PR 合并与整个 S1-3 验收尚未授权**，S1-4 不提前开始。

## 唯一实现与实际接线

| 部分 | 本次实现与保留边界 |
|---|---|
| 原池 | 演进 `lib/audio-pool.js createPool`，scheduler 仍导出同一函数。默认 window 保留原录音/批次行为；显式 permit 模式有期限、共享冷却、动态限额、真实释放、排空，但从不重试 work |
| 实例与权限 | `lib/jobs/resources.js` 由 host 创建唯一 hub，按显式 quotaDomainRef 建一个原池实例。资源/租约注册表不是 Job 表；重复同域配置拒绝。route 别名在同一 binding 内共享；ref 不能授予 owner/domain 权限 |
| 执行上下文 | canonical lifecycle 通过可信 request services 取得 audio.v1 作用域，Attempt 开始时固定租约；公开 `context.resources.run(ref, operation, {queueTimeoutMs})` 绑定当前 owner/domain/Attempt。业务输入不能指定 counter owner |
| 旧入口 | 实际 `audio.import(path/uploadId)` 与单文件 retry 在原 worker 开始执行时取得同类租约，交给原 audio-job / GeminiTiers，结束等待物理工作清理后释放租约。音频仍由旧领域生命周期运行，未开启 S1-6 |
| 每次 HTTP | Gemini 的生成、上传开始、上传体、轮询、删除；Groq 文本/分片转写；SiliconFlow 分片转写均经显式 tier transport。每次 fetch+body 各申请一次，未把整个 upload+generate attempt 当成一请求。标题、参数回退和档位回退沿用该入口 |
| 冷却 | transport 观察真实响应形状 429，解析 Retry-After 秒数/日期或 Gemini retryDelay，缺失有效提示沿用 20s；同实例阻止后续派发、不同域独立。不重发、不记录 Call/用量 |
| 真实停止 | 可观察请求覆盖 response body；原 longFetch 的 opt-in awaitPhysicalClose 等到 ClientRequest close。取消不因单纯 signal/观察 timeout 提前释放。只证明本地传输结束，不能确认远端模型计算停止 |
| 重试责任 | 共享策略下窗口池 refusals=0，音频文本 withModelRetry 委托既有 GeminiTiers.request 的传输重试。既有参数修正/JSON 内容修正属于可见的新请求，均重申请许可。默认关路径保持原包装；S1-4 网关和 Call 账本未迁移 |
| 清理与关闭 | 禁止同许可嵌套申请。关闭策略先禁止新 Attempt；已接纳 Attempt 保持原绑定直至有界删除清理结束，再关池并回到 baseline。清理 DELETE 可在业务取消后继续，但仍需同一许可及期限。卸载传播 abort 并等待收尾 |

DSH 优先引用 **DSH-06** [rc.2 能力核验](s1-3-dsh06-review.md)：实际 jobs-local 是 owner Job 数，llm-retry 是 session/provider 状态，不是共享物理请求许可。复用已存在的 audioGate、原池、宿主 Agent/jobs、Cordis 生命周期；只补已实测缺口。没有第二套队列或资源重试器。

## 独立开关与支持范围

配置入口为插件 `Config.runtime.resources`，`sharedProviderQuota=false`，与音频试点开关无联动。默认 provider 排队期限 30000ms，可显式设有限非负值；0 只允许立即接纳。上限必须为正整数。以下仅为合成配置示例，不是账户映射或推荐限额：

```yaml
runtime:
  resources:
    sharedProviderQuota: true
    queueTimeoutMs: 30000
    bindings:
      - resourceRef: audio-paid
        quotaDomainRef: verified-project-a
        limit: 2
        providerObservation: external-request
        routes: [paid]
```

实际账户/项目同域关系必须由负责人明确配置，不能从模型名、目录、jobId、密钥或密钥哈希猜。启用时每个配置了密钥的 tier 都须有可信绑定；缺少绑定、host-attempt 观测、不明配额域在 I/O 前拒绝。配置字符串不写入公共 Job/事件，不含凭据。

**首版只开放单文件音频的直接 HTTP 路径与已注册的 audio.v1 canonical 资源消费者。** 宿主文本模型可能隐藏 retry/hedge，因此该组合拒绝启用策略。批次、字幕复查、实时课堂及未接线音频模型入口在启用时明确拒绝，避免同域旁路；默认关时保持原功能。不同 DSH 进程或机器不受此 hub 约束，不宣称账户全局上限。完整模型网关、恢复和音频试点仍属后续步骤。

同一个运行中 host 不接受另一份不同资源配置，须先排空/卸载所有配置 owner 后重建。已有 hub 的 disable 提供安全回退边界：阻止新 Attempt → 原策略下完成/取消并清理在途 Attempt → 排空唯一实例 → 新 Attempt baseline。没有热替换两份计数器；不在现有任务中偷偷切换绑定。

## 验证证据及限制

所有命令通过隔离 Node 22.22.3、工作区 TEMP/TMP/DSH_HOME 和清空凭据的封装运行。完整验证保留机器级锁；没有付费模型、发布、部署或用户本地任务操作。

| 证据 | 实际结果 |
|---|---|
| 原语先红 | 0 pass / 1 fail / 9 cancelled：旧实现未拒绝缺失期限，其余因旧等待取消；不能称 10 个有效失败断言 |
| 期限竞态先红 | 12 pass / 1 fail：释放先于 timeout 回调时，过期工作被运行；修复后通过 |
| 新绑定/传输先红 | 缺 resources 模块；两个 longFetch close 断言失败；旧/新真实入口混跑失败 |
| 接线中间失败 | 19 pass / 11 fail：漏传 importAudio 内部 resources/sharedQuota，修复后 audio-concurrency 11/0；没有隐去失败或削弱断言 |
| 单一重试责任先红 | 新窗口测试发现额外 withModelRetry，委托后通过 |
| 最终定向 | 55 pass / 0 fail / 0 skip：绑定、许可、传输关闭、实际 audio.import+canonical 混跑、旧自适应、host ownership 与 plugin composition |
| 历史原语完整 verify | 5664 pass / 0 fail / 2 平台跳过，587541.521ms，lint/build 通过；此结果早于后续接线，不能替代最终验证 |
| 最终完整 verify / 双平台 CI | 以对应实现 PR 的精确 head、日志哈希与平台结果为准；本文不提前声称通过 |
| 实际 rc.2 原生探针 | 2026-10-06T03:40:14.345Z：6 companion 步骤、5 wrapper 步骤通过；3 native Jobs + 6 本地假 HTTP 请求，峰值 1，冷却观测 55ms，取消及回退排空通过 |
| 探针外围与收尾 | 另有 4 次本地 DSH fake model 请求；0 page/console errors，cleanup.converged=true |
| 真实模型/质量/计费 | 未运行；发布验收仍保留 |

实际探针加载当前 worktree 的生产模块、使用已安装 rc.2 的真实 Agent/jobs；未替换隔离 profile 中已安装的 StudyHub 包，也未把这一点说成完整新插件安装测试。新插件 host 配置/工具与面板共享通过源码接线及 composition/ownership 回归验证。模块/报告/日志指纹见 [机器证据](s1-3-provider-evidence.json)。

```sh
node --test tests/unified-runtime-resource-binding.test.mjs tests/unified-runtime-provider-permits.test.mjs tests/unified-runtime-http-cleanup.test.mjs tests/audio-concurrency.test.mjs tests/audio-pool-adaptive.test.mjs tests/host-ownership.test.mjs tests/plugin-composition.test.mjs
npm run verify
node tests/fixtures/runtime-s10/run-host-probe.mjs --repo /workspace/runtime-s12 --dsh-bin /workspace/runtime-s12/output/qa/dsh-cli/node_modules/@deepseek-ai/dsh/lib/bin.js --out /workspace/runtime-s12/output/qa/s13-provider-permits-final --variant official-jobs-preset --provider-permits --port 3593 --model-port 4597
```

手工探针不加入 npm test，不新增 CI 外部程序依赖。`output/s13-contract/` 保留全部红绿日志；机器证据固定阶段性回执，PR 更新最终精确提交验证。

## 审查与剩余门禁

审查清单逐项：1 DSH-06 实测如上；2 原池唯一实现，许可不重试；3 核心不含音频业务分支，支持范围拒绝位于宿主/领域边界；4 前置 #265 已合并；5 默认关与旧回归、策略开混跑分别验证；6 有界等待、取消/清理、释放、租约收尾覆盖；7 不声称未支持入口或隐藏重试可用；8 持久化恢复待 S1-5；9 不新写 Call/账本；10 原 gate/窗口范围保持，共享请求、双向冷却、别名、动态限额/排空有测试；11 假模型与真实宿主、客户端清理与远端停止明确区分；12 无 UI 改动；13 真实抽检未授权/未运行；14 先红后绿，完整与 CI 见 PR；15 私有环境与机器锁；16 S1-3 不提前打勾；17 已实现资源策略排空，整版持久化回退与发布演练仍待 S1-7。

后续所需负责人决定是本次限定实现的代码验收与 PR 合并，以及是否接受上述明确支持边界作为 S1-3 门禁。不得用测试/CI 替代该决定。没有获得这一步验收前，不进入 S1-4 或以自动恢复、音频试点开关掩盖未完成的后续阶段。

### 完整验证发现的既有测试收尾竞态

`e765c3e` 的 Ubuntu/Windows CI 均通过（各 5602 pass / 0 fail / 94 skip），但云端带浏览器全量在 `coverage-run-exec` 的模拟重启用例 after hook 报 `ENOTEMPTY`。这份测试在本次资源实现和并行 #266 中均未修改：它复制仍在运行的旧服务目录模拟崩溃，最后放开旧 producer，却没等待原任务的最终记账便删除源目录。单独复跑 16/0 不能消除这一竞态，也不能把失败全量标通过。

单独登记并修复这个 fixture：放开旧 producer 后调用既有 `settleJob` 等其记账结束再清理。不修改出题/恢复生产逻辑，不增加固定 sleep、放宽业务断言或仅给 rm 盲加重试。该测试修复后的定向、完整和新 head CI 结果追加到 PR；所有旧失败日志保留。
