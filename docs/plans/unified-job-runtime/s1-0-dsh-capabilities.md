# S1-0 预备审计：DSH 能力、版本与复用边界

核验日期：2026-10-05（Asia/Shanghai）。这是源码与安装包审计，不是 S1-0 通过记录。初始审计基于 PR #239 的 `e024513bb54b1ea0f11de23dac93733c4099e019`；工作区随后快进到已合并 main `aa0259254bcd587128e583070599a804485c7d06`，重新读取确认插件 `package.json` 与 lock 根版本均为 **2.6.0**。生产代码未修改。本审计没有启动用户宿主，没有访问用户学习库、`~/.dsh` 或凭据，没有发出真实模型请求。

## 证据级别与门禁

- **L：锁文件与安装元数据**：证明本工作区解析了什么版本，不证明宿主加载了该服务。
- **S：导出、类型和源码**：证明接口及其声明的语义存在，不证明它在当前插件作用域可解析、模型路由可用或 UI 已加载。
- **D：隔离无外网探针**：已执行 rc.2 jobs 与 atomic 最小探针，结果见下文和 [基线记录](s1-0-baseline.md)。包级探针不能代替实际宿主核验。
- **H：实际目标宿主作用域核验**：已执行独立 rc.2 web 宿主的伴随插件与真实 agent scope 探针。明确区分 preset-free 拒绝与显式官方控制器组合通过；未直接拦截 StudyHub fiber，UI、持有请求取消和恢复保证仍待验。不存在接口的搜索结果不是“不支持”的证据。

插件版本 2.6.0 与 DSH 版本是两个不同的记录。正式迁移仍须核验计划要求的发布/P0 控制台证据、契约 v1、实际 DSH 版本和 S1-0 评审；插件 package 版本不能单独解除门禁。

## 实际版本

当前工作区安装依赖来自 `package-lock.json`；安装负责人报告使用 `npm ci --legacy-peer-deps`，因此不能把安装成功当作宿主 peer 兼容性通过。插件的 `@deepseek-ai/dsh-llm` / `dsh-tools` peer 要求 `>=0.2.0-rc.2 <0.3`，而锁定的开发依赖仍是 rc.1。此差异保持可见；S1-0 不顺手改生产依赖。

| 锁定并实际读取的包 | 版本 | lock integrity |
|---|---|---|
| `@deepseek-ai/cordis` | 4.0.4 | `sha512-obgyxqWAmFn3Re8kvsuUnyW+ihrz6eJCnJO4fh1cQzDtmPYz/zzVeUkH9R94I0OwSVOocK67Kgakm04j/oQXzg==` |
| `@deepseek-ai/dsh-llm` | 0.2.0-rc.1 | `sha512-F5ZlBG8z8o5PfEWeEF/PN9t/A1N/oEErvqmpqE4J8f9mJR85DvBdV+rjDs7OjAbMJsJ8INjkbroruG5NNKDg5A==` |
| `@deepseek-ai/dsh-scope` | 0.2.0-rc.1 | `sha512-D1JeWIz40A62/nJIi7HwLsddmuDwdcxV9Lbx5IgBveWDZHGqPIP0/CPJ4o6XWr+C1qI/GBtdMkN2Z3F20Rlt7w==` |
| `@deepseek-ai/dsh-timeout` | 0.2.0-rc.1 | `sha512-SQpvDLIPU0EJP1lbphfuEkLrvnX+CE9u9ym1+L5z/8dYe9BCPbhgjQoRvDnyzKZqFyoXVvZFdqdAADlc6DX7Ig==` |
| `@deepseek-ai/schemastery` | 3.18.4 | `sha512-SSXO6tYuyrIqKVbmOnIq0s+riUywYzouFMcnBluHF9n4KMo2G8HvEzhCYj6pj2617/glOjbJuVInJ9hfONsjkg==` |
| `schemastery` | 3.18.0 | `sha512-Jw2uxjoyyqc/yeurmChUEc/jbi8GsrdXV/KmqRUDZXJAXAmrJiPsz8vKa17l/VckyzljHZ9oGaul443CQiXxtA==` |

`package-lock.json` SHA-256：`fba6cbdcf20b6480b5587b5823f30052a615cec6f229301533249a6efbdebf44`。锁文件明确同时包含未加前缀的 `schemastery@3.18.0` 和 DSH fork `@deepseek-ai/schemastery@3.18.4`；StudyHub 配置目前使用前者，DSH 契约使用后者。不能仅因名字相似就把两个构造器和校验结果视作已验证兼容。

只读审计另读取全局安装目录 `D:\Program Files\nodejs\node_global\node_modules\@deepseek-ai\dsh`（下称 `DSH_PACKAGE_ROOT`）。其 CLI `@deepseek-ai/dsh`、`dsh-subagent`、`dsh-jobs`、`dsh-jobs-local`、`dsh-session`、`dsh-session-persistence`、`dsh-atomic-write`、`dsh-storage`、`dsh-storage-json`、`dsh-llm-retry`、`dsh-client-ui-workspace` 皆为 **0.2.0-rc.1**；cordis 4.0.4，DSH schemastery fork 3.18.4。这是安装包元数据，未读取全局 profile 配置，也未核验当前正在运行的宿主。

集成负责人已将官方 DSH **0.2.0-rc.2** 独立安装到仓库忽略目录 `output/runtime-s10/dsh-cli`。本审计实际读取其 CLI 与依赖 metadata：核心 DSH 服务皆为 rc.2，cordis 4.0.4、DSH schemastery fork 3.18.4；下称目标包根 `R = output/runtime-s10/dsh-cli/node_modules/@deepseek-ai`。未启动用户宿主。

目标安装锁文件 `output/runtime-s10/dsh-cli/package-lock.json` SHA-256：`afc8ac3c2f4bad9aa82dc377ca73d506d4c26e3f2423db842f83b8ffc778dc64`。所审读 jobs/subagent/session/storage/atomic/retry 的 18 份类型/实现与全局 rc.1 对应文件逐字节相同，scope/timeout 实现与 llm 公共类型也相同；`dsh-llm/lib/index.js:2367-2371` 重新读取确认 stream waterfall 仍相同。这仅复核已审计范围，不声明所有 provider 或宿主 profile 行为没有差异。

| 目标隔离安装包 | 实际版本 | 目标 lock integrity |
|---|---|---|
| `@deepseek-ai/dsh` | 0.2.0-rc.2 | `sha512-EAJ3gPNcVt/uv8X19PMm9NkVhWgT7xXNMk0UKCVm+IQ5rpSQOcsMUa0HWlnYYVybKMsccjcRB21vVVsaXQ6IdA==` |
| `@deepseek-ai/cordis` | 4.0.4 | `sha512-obgyxqWAmFn3Re8kvsuUnyW+ihrz6eJCnJO4fh1cQzDtmPYz/zzVeUkH9R94I0OwSVOocK67Kgakm04j/oQXzg==` |
| `@deepseek-ai/dsh-scope` | 0.2.0-rc.2 | `sha512-066p7Wv74GNWt4xA5Cyvl+7c/i9KrNEDALYh2/hu0VsJPLb4T9He+TY7y1bld9OgungmqyTy1n/cB2ZrVskvxA==` |
| `@deepseek-ai/dsh-llm` | 0.2.0-rc.2 | `sha512-6QFrQn/h0iNqCfPpgQidnHtLSpA99A7ZND/uYKaGSd/4BGP8KBhuRd0w63e9s4u+hfW8jc3j29WKcNLIOeUfcA==` |
| `@deepseek-ai/dsh-timeout` | 0.2.0-rc.2 | `sha512-NDob8b8DJDB/sDPz3P7xhrkxOh1O9FbN1EZRKsxP4fuTfp4hrQU7aekYS5qZENFKoR8dBJMTh/zcEBw4m31glQ==` |
| `@deepseek-ai/schemastery` | 3.18.4 | `sha512-SSXO6tYuyrIqKVbmOnIq0s+riUywYzouFMcnBluHF9n4KMo2G8HvEzhCYj6pj2617/glOjbJuVInJ9hfONsjkg==` |
| `@deepseek-ai/dsh-subagent` | 0.2.0-rc.2 | `sha512-33izf4xhq03RzolYUjv223tKmeOBl8fMnvnRN15zZB3GWfNRcBTVUUxuu99rCN8TSRRt5A5ABTwYbObb1Isjqw==` |
| `@deepseek-ai/dsh-subagent-spawn-in-process` | 0.2.0-rc.2 | `sha512-7qOuPyeMwaZ2/bFqYnMA6oNLYP+divyV+FlD2PeScDiAcKBI6ZXEhs3wUcT7C04o4zmSXEoalHvlJGAVYUA0jw==` |
| `@deepseek-ai/dsh-session` | 0.2.0-rc.2 | `sha512-wj+6MeqCYbDcbEvKH3puHyEGdjyu51JwBoN6Ua2tz6griLufDgLM5HpSU40L5xgpbOfrYVhXZs4vRgOrMlFY2g==` |
| `@deepseek-ai/dsh-session-persistence` | 0.2.0-rc.2 | `sha512-2OoRHZYWi5Vy0+1bPU37Y/NTh6uQiZ3VdpvDmW1oCgsapQr2JS/Lbody1gXOMJ1KXglCSLmePgTMC00uKw/UIg==` |
| `@deepseek-ai/dsh-session-persistence-jsonl` | 0.2.0-rc.2 | `sha512-iAzXWC8jmiLYjK+wuN/fAKXLniAfClWm0CmEIwSxZnJGVy8c0iy7j5v8UfOqUbwuGfqo5HUWfyLGgxbWH7SG3g==` |
| `@deepseek-ai/dsh-client-ui-workspace` | 0.2.0-rc.2 | `sha512-dGKLOFJXBiGDKl+qWMQ0cYF0AT485JMzSk+AUM6/81tZPapJuirxP7Yf5ZFMfsmgQFv6m4jjYlnOc6KcIfUUZQ==` |
| `@deepseek-ai/dsh-jobs` | 0.2.0-rc.2 | `sha512-SuCCfXZDabBxsKbHoulXEeQrRSYuOYLSfhvnflQf+CYeb68wggKraejkLyO60LrCGnBJsgCqKIdIKLCUvIeN+g==` |
| `@deepseek-ai/dsh-jobs-local` | 0.2.0-rc.2 | `sha512-sNyolYfcNVodxGyoWUM3G0f+numJexMrqwR0HC4x9kvzzZNR1WZV7ca4lCAzlaRSEvY8UPYxKC6Fi4T+MnBkSQ==` |
| `@deepseek-ai/dsh-llm-retry` | 0.2.0-rc.2 | `sha512-k992Xuafcz0plUyUHyxABDrB+elh6JYvVtQDnEIjUJkSAc8bbsN7ZcF5fxHFx0zCEoMrxRA7ZqtqxkFTYUiNMA==` |
| `@deepseek-ai/dsh-atomic-write` | 0.2.0-rc.2 | `sha512-CezxdPmADDnOyG/ed9R18In/NifnLgu8hfJEjTBKxd7kbu0XXenyqnk25jeWD6bJYwu8AWAwcpVFuf438EJPJA==` |
| `@deepseek-ai/dsh-storage` | 0.2.0-rc.2 | `sha512-tItvFJ1IAurwmZfBdrr8w+GuyLADZXZ01bos06Ma0QmD3+0NNyvo0E9qmYb54TfJ2h5yvRcFosHO1048gzuPPw==` |
| `@deepseek-ai/dsh-storage-json` | 0.2.0-rc.2 | `sha512-h7pD397LA8JUD3QMz1IUV5kAg4WD6iVSZnMFrrCnN0wBF5B0PS0BDHT+x7zojLtq3MFfyx3JwpmX7uF12S0glg==` |


## 固定行 ID 能力对照

下表的“边界建议”用于正式 S1-0/契约评审，未授权实现新架构。所有复用候选先通过同版本导出与作用域探针，再决定直接复用或薄适配。

| 行 ID | 包 / 服务 / 方法 / 版本（L/S） | 证据路径 | 作用域与现有责任者 | 当前核验结论 | 缺口 / 薄适配边界建议 |
|---|---|---|---|---|---|
| DSH-01 | cordis 4.0.4：`Context.plugin`、`ctx.effect`；项目 dsh-scope rc.1 / 目标 rc.2：`createScope`、`ScopedLayers`；目标 dsh-jobs / jobs-local rc.2：`ctx.jobs.start`、`kill`、`wait`、`attachController` | P01、P02、R01、R02 | fiber 拥有注册/订阅释放；scope 按对象身份及父链路由。宿主 jobs 按 session owner 围栏；记录超过 producer/controller fiber，owner/service teardown 收尾 | 部分复用（D/H 最小验证通过；明确组合与未测范围） | 优先复用作用域与 effect。正式评审须把宿主 jobs 同 StudyHub 现有共享 jobs/owner/domain 契约逐字段比较：宿主状态为 running/stopping/completed/killed/failed，内存注册不是持久化 Job/Attempt 模型。不能并排增加第二张生命周期表，也不能直接替换旧 ID/状态。 |
| DSH-02 | 项目 schemastery 3.18.0：可调用 schema、`object/union/const/array/required`；DSH fork 3.18.4：DSH 服务 Config 与 runtime 校验 | P03、P04；各包 package 导出 | 纯输入边界/配置校验，无 Job 事实存储或状态迁移责任 | 部分复用（D 已验证；H/业务保证有范围限制） | 复用已有校验构造器并用目标 fixture 证明缺省、未知字段、非法版本的语义。选择一种契约边界，勿另写通用校验库；不能预设 schema 会自动保留旧格式或拒绝额外字段。 |
| DSH-03 | 项目 dsh-timeout rc.1 / 目标 rc.2：`clampTimeout/deadline/idleWatchdog/timeoutOf`；subagent rc.2：one-shot signal + run.dispose；jobs wait | P05、R01、R03 | timeout 只融合 abort signal、清计时器并分类；实际停止由 capability/provider 执行。one-shot dispose 等 quiescence；continuable interrupt 是发出信号后的即刻回执 | 部分复用（D/H 最小验证通过；明确组合与未测范围） | 直接候选复用 timeout 原语；薄适配只做业务截止时间与取消传播/结果映射。wait 的观察者等待到期不能被解释为 kill。收到 abort/interrupt 回执不等于底层停止，许可释放必须等实际收尾。 |
| DSH-04 | 项目 dsh-llm rc.1 / 目标 rc.2：`ctx.llm`、`registerAdapter`、`listProviders`、`resolveModelInfo`、`resolveCallConfig`、`prepareCall`、`stream`；`BlockAssembler` | P06、P07、P08 | runtime 拥有 provider 注册、模型能力/档位验证与 llm/stream waterfall；adapter 做 wire 转换。prepareCall 可固定同一注册跨 HMR 查能力/dispatch | 部分复用（D/H 最小验证通过；明确组合与未测范围） | 复用已有 StudyHub modelCompletion 与宿主模型路由；网关只关联 Job/Attempt/Step/Call、预算和已批准重试边界。显式不支持的 effort 在 I/O 前拒绝，不能静默钳制；stream 的 provider 失败是 error/aborted finish chunk，middleware/consumer 错误仍可能抛异常。 |
| DSH-05 | 目标 dsh-subagent rc.2：`getProvider/start/startContinuable/sendMessage/interrupt/listChildren/drainContinuableChildren`；spawn-in-process；client uiWorkspace.openSession | R03、R04、R05、P09 | start fulfillment 是子代理发布与资源所有权转移点；one-shot holder 必须 dispose。continuable manager 拥有持久 child/inbox；UI 的 uiWorkspace 是 client 服务 | 部分复用（D/H 最小验证通过；明确组合与未测范围） | 启动 label 可持久显示名；本次未找到公开 rename 操作，保持待核验。复用现有 backgroundCapability/startBoundedChild；按 provider.capabilities 校验 agentOptions/toolFilter/outputSchema。cold desktop 需要合法协调 parent，不能伪造。打开子代理委托 client openSession 的 durable parent address，不在 server 假设 uiWorkspace 可用。 |
| DSH-06 | jobs-local rc.2：maxConcurrentJobsPerOwner（默认 10）；subagent rc.2：maxActiveSubagents（默认 8，continuable 父链）；llm providerRetryPolicy + dsh-llm-retry | R02、R03、R06、P10 | jobs 限 running+stopping 个数，按精确 owner/无 owner bucket，满时拒绝，不是模型 provider 配额队列；continuable 上限不等于全部 one-shot 限额。retry 状态按 agent session step/provider/policy | 待核验（新的共享 provider 策略；保行为试点沿用既有许可/池） | 已见上限与退避原语不能代替宿主共享音频转写槽或 provider 请求许可。尚未核验宿主共享 RPM/429 cooldown 能力；不能据搜索缺失写“宿主不支持”。保留已有 audioGate 与录音/批次文本池作用域；新共享文本策略须独立开关和评审。 |
| DSH-07 | dsh-llm rc.2：`usage` chunk、`TokenUsage`、`BlockAssembler.usage`；宿主 session log/query；插件 `reportUsage/usageFromTokenUsage/withJobUsage` | P08、P11、R07 | provider/adapter 只上报实际可观测 tokens；block assembler 未遇 usage 时为 undefined。插件 sink 归属 caller，host session 记录 agent 请求；二者不天然是同一账本 | 部分复用（D/H 最小验证通过；明确组合与未测范围） | uncached input 与 cache read/write 是不交叠桶，reasoning 为 output 子集，不能再次相加。Call 去重、ledger 与 host 内部 retries 可观测范围仍需 fake probe/宿主证据；未知不填零，不编造费用或 provider request 次数。 |
| DSH-08 | 目标 dsh-atomic-write rc.2：`writeFileAtomic/withFileLock`；sessionPersistence；storage/json；sessions | R08、R07、R09、R10 | atomic write 为同目录完整文件替换、Windows transient rename 重试；withFileLock 跨进程按 PID 的单文件 writer 锁；sessions 只是 live store；持久写由 agent lifecycle 的 writer handle/独立 backend 拥有 | 部分复用（D 已验证；H/业务保证有范围限制） | 正式核对 host atomic primitive 是否可部署/可解析，再决定委托还是保留已有 Windows atomicJson 薄适配。仍需原 manifest 每文件写顺序与业务字段唯一责任者；atomic primitive 不提供 fsync crash durability、产物/检查点联合提交或业务恢复。session storage 不能当 Job manifest 恢复完成证据。 |
| DSH-09 | cordis on/once/emit/parallel + scopeTarget；subagent start/end；session event/flush；jobs.events.subscribe；插件 sessionNotifier | P01、P02、R01、R03、R07、P12 | 订阅归 fiber；session/event 为 post-commit fire-and-forget，flush 是 awaited durability checkpoint。jobs settled 先释放 waiter，再 contained event，awaited 标明是否有等待者收取 | 部分复用（D/H 最小验证通过；明确组合与未测范围） | 复用已有 event/会话投递能力，领域事件只关联稳定键与公共投影。sessionNotifier 当前吞投递错误；不能据此声称可靠重投/恰好一次通知。持久去重、通知失败不改任务终态及旧入口避免双投递仍须测试。 |

## 源码重点结论

1. **DSH 已有背景任务服务，不能跳过核对。** `dsh-jobs` 的抽象服务及 `dsh-jobs-local` 的进程内实现包含 owner/session 授权、controller 可服务范围、先到先结算、输出 ring 与等待。它们不等于批准计划中的全部契约；首要工作是比较唯一状态责任者和旧入口适配，不能因形状不同就另建竞争任务表。
2. **DSH 原子写能力存在。** 已安装源码明确有 Windows EACCES/EBUSY/EPERM 的有界 rename 重试和跨进程锁；这使“必须手写新原子写器”成为需要证据说明的例外。它不负责 StudyHub 的 manifest 字段、产物提交去重、checkpoint 或 fsync；复用不能扩大保证。
3. **“ctx.llm 有 retryPolicy”不等于 direct stream 自带全套重试。** 当前源码 `streamWithRegistration` 进入 `llm/stream` waterfall；可选 `dsh-llm-retry` 注册的是 `agent/request-error`，按 agent step 的 provider policy 退避并记录 `llm/retry`。StudyHub direct `ctx.llm.stream`、one-shot child、continuable child 必须分别核对是否经过该 hook，以及 provider SDK 是否另有内部重试，避免层数相乘。
4. **子代理“interrupt accepted”与“dispose settled”不是同一保证。** one-shot signal + holder.dispose 承担停止与 quiescence；continuable interrupt 不销毁 inbox/Activation，且 one-shot/未知 ID 是 no-op。停止协议不能盲调同一个名字后立即释放实际资源。
5. **uiWorkspace 是浏览器 client 能力。** node 半部 apply 本身无宿主操作；打开会话/子代理要走客户端导航契约和地址授权。服务类型存在不证明 server scope 可用。

## 最小无外网探针建议（由集成负责人执行）

所有探针使用同一包根的 cordis/Service 依赖，避免把 project 与 global 两份 cordis 混在一个上下文。环境清空密钥/token/baseURL，私有 TEMP/DSH_HOME/输出目录，provider 为内存 fake；不得启动用户 profile、恢复已有 sessions 或触发真实模型。

| 探针 | 最小断言 | 能证明与不能证明 |
|---|---|---|
| scope / effect / schema / timeout | createScope 注册 exact disposer/订阅，重复 dispose 等同一次释放，兄弟隔离/父链 event routing；schema 用真实契约 fixture；deadline 与 upstream abort、计时器 dispose、wait 上限区分 | 可证明安装包原语的最小可运行语义；不能证明目标宿主插件注入/API权限已通过 |
| ctx.llm fake adapter | 一次成功、error finish、signal abort；能力 resolve/显式 effort拒绝；usage缺失与实际 usage chunk；计数 adapter dispatch次数；注销服务拒绝新调用 | 无需 HTTP 的 fake adapter，证明该版本 seam；不能断言所有 mounted middleware/provider内部重试一样 |
| ctx.jobs fake producer | 同包根 LocalJobRegistry + attachController；unowned start/get/readAt，wait到期任务仍运行，kill后等待真实fake settle；terminal重复回调只发一条 settled；controller/dispose无残留 | owner隔离另需合法fake agent registry并满足exact-live-owner条件；伪session ID不可代替。实际宿主job controller scope仍待核验 |
| subagent fake provider | 能力缺失在dispatch前拒绝；取消admission清理；发布后signal与dispose收尾；result child-level error与infrastructure reject区分；label原样写入 | 不使用真实in-process模型循环；managerless continuable/interrupt的no-op不得当实际child停止证据 |
| atomic write / writer lock | 私有目录完整文件替换与失败清理；两个writer通过withFileLock执行read-modify-write而不丢更新；明确mode/dirMode | 普通文件成功不能替代Windows忙文件故障注入；无fsync，不声明断电持久性 |
| UI/session桥 | fake target导航与当前workspace边界，scope释放移除listener；会话投递失败不改job terminal，独立事件键去重 | 需真实客户端宿主再确认openSession UI可见/授权及P0控制台流程 |

## 已执行隔离探针

使用目标 rc.2 包根创建无 session 的 Cordis Context，通过 `await ctx.plugin(LocalJobRegistry, {})` 等待服务启动。未创建真实 agent owner，此结果只证明安装包原语：

- `ctx.jobs`：unowned fake producer 可读取输出；观察者 wait 到期仍 running；kill 后 settled 为 killed；重复 kill 已终结，cancel 回调一次，settled 事件一次；controller、订阅与 fiber 已释放。
- `writeFileAtomic/withFileLock`：四个并发 read-modify-write 串行完成，最终值 4。
- 未验证：合法 session owner 隔离、实际面板 controller scope、宿主卸载下在途资源、Windows busy rename 注入、断电持久性。生产环境不能借 unowned 绕过所有权。

命令与输出摘要见 [基线记录](s1-0-baseline.md)。这两项 D 级证据不把九行 H 级待核验自动改成支持。

## 输入、作用域与超时最小探针

目标安装包的无网络探针通过：独立 scope 对象身份、重复 dispose 只释放一次且不移除兄弟；DSH fork schemastery 3.18.4 的 required/default/const-version 校验；dsh-timeout 的上游 abort 原因保留、重复 dispose、非法零超时拒绝与上限钳制。未测 unknown fields、真实 Job shape 兼容与 elapsed deadline；不是 S1-1 契约验收。原始结果 `output/runtime-s10/primitive-probe.json`。

## 待核验与阻断

- 官方 DSH rc.2 版本与已审计导出已核对；jobs/atomic 已有部分 D 级证据，其他原语、当前宿主作用域及项目 rc.1 安装同 peer rc.2 的兼容仍待核验。
- companion/root 与真实 agent scope 的 llm、sessions、one-shot subagents、显式官方 controller 已有 H 证据；StudyHub 最终 owner/controller 绑定、持有请求取消、客户端 uiWorkspace 仍待对应步骤实测。
- 宿主 jobs 与现有 `lib/runtime/tasks.js`、共享 jobs、owner/domain、旧ID及公共契约 v1 的逐字段所有权对照。
- retry 执行者与 provider 内部 retries、用量观测范围；宿主共享请求限制/冷却能力是否可用。
- 原子写/锁的部署依赖、每 manifest 串行顺序、恢复失败窗口与兼容旧记录。
- P0 发布/控制台/契约证明与 S1-0 评审通过链接。以上依赖项未解决前不进入 S1-1。

## 证据索引

路径中的 P 为当前仓库工作区，R 为官方 rc.2 目标包根，H 为只读全局 rc.1 包的归档证据。下列 R 行号/公共契约已通过与 H 同路径逐字节比对确认；P SDK 类型与 R 同名类型亦同。行号对应本次读取的版本。

| 证据 | 可复查路径与符号/行号 |
|---|---|
| P01 | `node_modules/@deepseek-ai/cordis/src/fiber.ts:403-418` effect/disposer；`src/events.ts:246-300` fiber-owned listener |
| P02 | `node_modules/@deepseek-ai/dsh-scope/lib/types/index.d.ts` Scope/createScope/scopeTarget；`lib/types/store.d.ts` ScopedLayers；`lib/index.js:296-305` createScope |
| P03 | `node_modules/schemastery/lib/index.d.ts:23-54,104-112`；`package.json` |
| P04 | `node_modules/@deepseek-ai/schemastery/package.json` exports；`dsh-llm/lib/types/retry-policy.d.ts` 使用DSH fork schema |
| P05 | `node_modules/@deepseek-ai/dsh-timeout/lib/types/index.d.ts`；`lib/index.js` clampTimeout/deadline/idleWatchdog/timeoutOf |
| P06 | `node_modules/@deepseek-ai/dsh-llm/lib/types/index.d.ts:34-45,236-412`；`lib/index.js:2367-2371` stream waterfall |
| P07 | `lib/index.js:101-175` modelCompletion；`lib/host.js` sessionModelFor/model route；`lib/reasoning-effort.js` 档位探测（调用线索，未运行） |
| P08 | `node_modules/@deepseek-ai/dsh-llm/lib/types/types.d.ts:153-174,489-524`；`lib/types/assembler.d.ts:58-61` |
| P09 | `lib/host-capabilities.js:13-40,120-137`；`lib/generation-agent.js`；`lib/generation-continuable.js` |
| P10 | `node_modules/@deepseek-ai/dsh-llm/lib/types/retry-policy.d.ts`；`lib/types/index.d.ts:319-323` |
| P11 | `lib/usage-scope.js:27-53`；`lib/token-usage.js:22-51` |
| P12 | `lib/session-notice.js:1-18`；`lib/index.js` sessionNotifier |
| R01 | `dsh-jobs/lib/types/index.d.ts`；`lib/types/types.d.ts:117-145,187-236`；`lib/types/view.d.ts:15` |
| R02 | `dsh-jobs-local/lib/types/index.d.ts:20-25,55-85`；`lib/index.js:414-419,624` |
| R03 | `dsh-subagent/lib/types/index.d.ts:102-106,170-208,268-300`；`lib/types/types.d.ts:120-183,285-317` |
| R04 | `dsh-subagent-spawn-in-process/lib/index.js:23-34` capabilities/start |
| R05 | `dsh-client-ui-workspace/lib/types/index.d.ts` node half；`lib/types/client/navigation.d.ts:10-44,91-95` uiWorkspace |
| R06 | `dsh-llm-retry/lib/types/index.d.ts`；`lib/index.js:151-183` agent/request-error |
| R07 | `dsh-session/lib/types/index.d.ts:34-72,327-370`；`dsh-session-persistence/lib/types/index.d.ts:80-136` |
| R08 | `dsh-atomic-write/lib/types/index.d.ts` writeFileAtomic/withFileLock 与有限保证 |
| R09 | `dsh-storage/lib/types/index.d.ts:1-4,39-61` hub/data forms |
| R10 | `dsh-storage-json/lib/types/index.d.ts:1-26` atomic JSON backend/root |

本次审读只读安装包和仓库源码；下面指纹可检验同版本安装内容。临时从原工作区读取的 dsh-scope/timeout/llm JS 与 llm index 类型随后同本工作区独立安装逐字节比对一致；没有使用原工作区 node_modules 运行测试。

### 当前仓库/安装包文件 SHA-256

| 路径（P） | SHA-256 |
|---|---|
| `package.json` | `9661fe14fd48b7a47a12c7da54ae1a62abdb0e4561d444bb7b18198e74d3c5fd` |
| `package-lock.json` | `fba6cbdcf20b6480b5587b5823f30052a615cec6f229301533249a6efbdebf44` |
| `lib/index.js` | `6d5a1812572ef89f13efc44e16d5aaf850cf07d08a1dae74f40f518cf6bc360a` |
| `lib/host.js` | `022eac902ee4efd273ec1175cb7543378aadeb9722c872de6ea3483285dbf07f` |
| `lib/host-capabilities.js` | `16844a397d797e719f8b8f60e52376f602332c49884ffc0ab345aaeb9181f0a9` |
| `lib/session-notice.js` | `c01a11374c91ab64ccbba99c4363253cc076fdfbdcba39d1ed4e2ba96a8675d3` |
| `lib/generation-agent.js` | `161d8613be2438a70f8636c6f4c81a5c7f348015aa35023869350328100f0a2e` |
| `lib/generation-continuable.js` | `347dbb7d1fcb895d04f854b7ff1343870da859a00ee1ff4c39e55b602f8ca8fa` |
| `lib/usage-scope.js` | `ec4cf42661d3a0fa9eefaf2cc4a3019be9b56aefa2018aa1470bc4e431c26d3c` |
| `lib/token-usage.js` | `494679e5b4a84e163ca2b03b0ce2bec8cf6357922f02b0fe565fcc95b6aa9fc2` |
| `scripts/qa/dsh-e2e.mjs` | `a2b148c28b53cccd8fe67b2668527d09b1908f483286f910ff6693de5ad66246` |
| `node_modules/@deepseek-ai/cordis/src/fiber.ts` | `b7661d6c19be76cef6b97d88719a8112c0f8b5abe65bd9e7d5947773fd4b96d4` |
| `node_modules/@deepseek-ai/cordis/src/events.ts` | `9aff93dcfcad98aebb692c19c36d3bf034a96f9085bc66900a997cda3f79e6fe` |
| `node_modules/@deepseek-ai/dsh-scope/lib/index.js` | `2829df71d76e08941457d4dd173eac60783e55354921137c8b75e8b5c0d2ecca` |
| `node_modules/@deepseek-ai/dsh-scope/lib/types/index.d.ts` | `203beba1f2b00636990eefa4fe763207c1d657987a16531ca89dc6de3713f96e` |
| `node_modules/@deepseek-ai/dsh-scope/lib/types/store.d.ts` | `20406af558195dde255de42fbec68cbde95f7488d7ab845dbbd2df58db7cc1eb` |
| `node_modules/@deepseek-ai/dsh-timeout/lib/index.js` | `744fdb4f79c8d513c6d4014a018949cfb2f02f4dde4621167302c5467c3994ec` |
| `node_modules/@deepseek-ai/dsh-timeout/lib/types/index.d.ts` | `5850f831ae4b3e50af729af37ad4f99f4644ad48ddfc020e699decf4f8c1f29b` |
| `node_modules/@deepseek-ai/dsh-llm/lib/index.js` | `9132c8a8053ee82b9fb1ded4f98c85cf557f288a15a85c552c6b1fb319ead120` |
| `node_modules/@deepseek-ai/dsh-llm/lib/types/index.d.ts` | `c5e3c6d92c7c2cf1529ff34eeaf0af92ccee56f2e5ae0f06c36f8548736f9c55` |
| `node_modules/@deepseek-ai/dsh-llm/lib/types/types.d.ts` | `6b7f5b81f6b680b1bf33346950f43e1cb760182f14d54cb71f5f0c1f2ce20352` |
| `node_modules/@deepseek-ai/dsh-llm/lib/types/retry-policy.d.ts` | `67b3a7b21f5224d849a008135bbd6102eda6a517d1362809a140e64085e8ae20` |
| `node_modules/@deepseek-ai/dsh-llm/lib/types/assembler.d.ts` | `c5eb8c0da60d6410daa171134014bf77cde759d1a7a914fe0ec63d800cc8034d` |
| `node_modules/schemastery/lib/index.d.ts` | `d84b05b596aafd7be8867d29ff85e02cb690888a1f8aaa85afe5d5f01862efd8` |

### 只读全局宿主包文件 SHA-256（rc.1）

| 路径（H） | SHA-256 |
|---|---|
| `package.json` | `6c5d2b98ca97920fffe81eaff8455dfd1e97524c8b3a7a3b0cac4c960ebb363c` |
| `node_modules/@deepseek-ai/dsh-subagent/lib/types/index.d.ts` | `674879b514f8af54213ecc4985cf7a8e8b00c8a00086261fcccce1b0d6325ee4` |
| `node_modules/@deepseek-ai/dsh-subagent/lib/types/types.d.ts` | `e5cadbdece5be5c323334fd71cff23db6c193ca2f3f59e378d514ae9d9923a65` |
| `node_modules/@deepseek-ai/dsh-subagent-spawn-in-process/lib/index.js` | `11c92108dd145957f8251a81fc9bfb8a30e7f6f25d96e34a5cb8581a4be4be06` |
| `node_modules/@deepseek-ai/dsh-client-ui-workspace/lib/types/index.d.ts` | `e8a5b090f2ea3c5f1c1c0cd4cc4e6625f8229d746330f4ab42d3f60842ca002b` |
| `node_modules/@deepseek-ai/dsh-client-ui-workspace/lib/types/client/index.d.ts` | `a778fa5e14efd0d7af658c421a183ce3b453de3f3a689a254916b812cbbafb51` |
| `node_modules/@deepseek-ai/dsh-client-ui-workspace/lib/types/client/navigation.d.ts` | `b4a357efd40f3cb61d649edaeb4265621d5b6ec4cdcbe8cce1a5394ea7ffa44e` |
| `node_modules/@deepseek-ai/dsh-jobs/lib/types/index.d.ts` | `c8374bad5f88ba996911b47d5eb9af450ae6fb6128dc4238e4af102e53f728b7` |
| `node_modules/@deepseek-ai/dsh-jobs/lib/types/types.d.ts` | `8b80d52a4bfafbd52ae763ebdad8c01faba666f3ad99612e3b912caa94f86109` |
| `node_modules/@deepseek-ai/dsh-jobs/lib/types/view.d.ts` | `7cac33509bbbaf7fadf868c2d964d8bace9a9cb55257900e6d535a09c997dd2a` |
| `node_modules/@deepseek-ai/dsh-jobs-local/lib/types/index.d.ts` | `61a4947c8e80bf04272897627271c98ec4ddcc3ec87c7c211e57c42009f454f2` |
| `node_modules/@deepseek-ai/dsh-jobs-local/lib/index.js` | `3bed0cd38c649f39b148752e742ff1ef57696a6b9b11b15ff8cc6cd1d4f08f26` |
| `node_modules/@deepseek-ai/dsh-session/lib/types/index.d.ts` | `8c6244c55203351724078ddb18e9075d82ec8c1e5087a13cff594681383ccba8` |
| `node_modules/@deepseek-ai/dsh-session-persistence/lib/types/index.d.ts` | `405eed914b242e16a07c8343004e134669b8948b26d1067e300fb222baf10b96` |
| `node_modules/@deepseek-ai/dsh-atomic-write/lib/types/index.d.ts` | `840b85ab3d60fd0f4adfea004a7ddc69da57a77b38d0e86f37d092d5bb3e6503` |
| `node_modules/@deepseek-ai/dsh-storage/lib/types/index.d.ts` | `c15111d5f10e8008413344143663f4a50b2d9f9c8cc928f4a9c0c03f4b9879d7` |
| `node_modules/@deepseek-ai/dsh-storage-json/lib/types/index.d.ts` | `250367a16d5dfcf04a48ae58f871d26d2be8d725478f5909f4385e6b2ca5f607` |
| `node_modules/@deepseek-ai/dsh-llm-retry/lib/types/index.d.ts` | `827df6f75bac3b3e7107bc0260b309d4d204a67ef87ffc7b0614e921068ceea3` |
| `node_modules/@deepseek-ai/dsh-llm-retry/lib/index.js` | `cbb99f1c5038e4a9167aedf333343cb3e3adfb5c9f45a37ef7562b024429d050` |

### 官方隔离目标包文件 SHA-256（rc.2）

| 路径（R） | SHA-256 |
|---|---|
| `dsh/package.json` | `0a85203e3e907dd2e3bec34324a2494758ca6cdee234b07090a7c8df0b11acac` |
| `dsh-subagent/lib/types/index.d.ts` | `674879b514f8af54213ecc4985cf7a8e8b00c8a00086261fcccce1b0d6325ee4` |
| `dsh-subagent/lib/types/types.d.ts` | `e5cadbdece5be5c323334fd71cff23db6c193ca2f3f59e378d514ae9d9923a65` |
| `dsh-subagent-spawn-in-process/lib/index.js` | `11c92108dd145957f8251a81fc9bfb8a30e7f6f25d96e34a5cb8581a4be4be06` |
| `dsh-client-ui-workspace/lib/types/index.d.ts` | `e8a5b090f2ea3c5f1c1c0cd4cc4e6625f8229d746330f4ab42d3f60842ca002b` |
| `dsh-client-ui-workspace/lib/types/client/index.d.ts` | `a778fa5e14efd0d7af658c421a183ce3b453de3f3a689a254916b812cbbafb51` |
| `dsh-client-ui-workspace/lib/types/client/navigation.d.ts` | `b4a357efd40f3cb61d649edaeb4265621d5b6ec4cdcbe8cce1a5394ea7ffa44e` |
| `dsh-jobs/lib/types/index.d.ts` | `c8374bad5f88ba996911b47d5eb9af450ae6fb6128dc4238e4af102e53f728b7` |
| `dsh-jobs/lib/types/types.d.ts` | `8b80d52a4bfafbd52ae763ebdad8c01faba666f3ad99612e3b912caa94f86109` |
| `dsh-jobs/lib/types/view.d.ts` | `7cac33509bbbaf7fadf868c2d964d8bace9a9cb55257900e6d535a09c997dd2a` |
| `dsh-jobs-local/lib/types/index.d.ts` | `61a4947c8e80bf04272897627271c98ec4ddcc3ec87c7c211e57c42009f454f2` |
| `dsh-jobs-local/lib/index.js` | `3bed0cd38c649f39b148752e742ff1ef57696a6b9b11b15ff8cc6cd1d4f08f26` |
| `dsh-session/lib/types/index.d.ts` | `8c6244c55203351724078ddb18e9075d82ec8c1e5087a13cff594681383ccba8` |
| `dsh-session-persistence/lib/types/index.d.ts` | `405eed914b242e16a07c8343004e134669b8948b26d1067e300fb222baf10b96` |
| `dsh-atomic-write/lib/types/index.d.ts` | `840b85ab3d60fd0f4adfea004a7ddc69da57a77b38d0e86f37d092d5bb3e6503` |
| `dsh-storage/lib/types/index.d.ts` | `c15111d5f10e8008413344143663f4a50b2d9f9c8cc928f4a9c0c03f4b9879d7` |
| `dsh-storage-json/lib/types/index.d.ts` | `250367a16d5dfcf04a48ae58f871d26d2be8d725478f5909f4385e6b2ca5f607` |
| `dsh-llm-retry/lib/types/index.d.ts` | `827df6f75bac3b3e7107bc0260b309d4d204a67ef87ffc7b0614e921068ceea3` |
| `dsh-llm-retry/lib/index.js` | `cbb99f1c5038e4a9167aedf333343cb3e3adfb5c9f45a37ef7562b024429d050` |
| `cordis/src/fiber.ts` | `b7661d6c19be76cef6b97d88719a8112c0f8b5abe65bd9e7d5947773fd4b96d4` |
| `cordis/src/events.ts` | `9aff93dcfcad98aebb692c19c36d3bf034a96f9085bc66900a997cda3f79e6fe` |
| `dsh-scope/lib/index.js` | `2829df71d76e08941457d4dd173eac60783e55354921137c8b75e8b5c0d2ecca` |
| `dsh-scope/lib/types/index.d.ts` | `203beba1f2b00636990eefa4fe763207c1d657987a16531ca89dc6de3713f96e` |
| `dsh-scope/lib/types/store.d.ts` | `20406af558195dde255de42fbec68cbde95f7488d7ab845dbbd2df58db7cc1eb` |
| `dsh-timeout/lib/index.js` | `744fdb4f79c8d513c6d4014a018949cfb2f02f4dde4621167302c5467c3994ec` |
| `dsh-timeout/lib/types/index.d.ts` | `5850f831ae4b3e50af729af37ad4f99f4644ad48ddfc020e699decf4f8c1f29b` |
| `dsh-llm/lib/index.js` | `9132c8a8053ee82b9fb1ded4f98c85cf557f288a15a85c552c6b1fb319ead120` |
| `dsh-llm/lib/types/index.d.ts` | `c5e3c6d92c7c2cf1529ff34eeaf0af92ccee56f2e5ae0f06c36f8548736f9c55` |
| `dsh-llm/lib/types/types.d.ts` | `6b7f5b81f6b680b1bf33346950f43e1cb760182f14d54cb71f5f0c1f2ce20352` |
| `dsh-llm/lib/types/retry-policy.d.ts` | `67b3a7b21f5224d849a008135bbd6102eda6a517d1362809a140e64085e8ae20` |
| `dsh-llm/lib/types/assembler.d.ts` | `c5eb8c0da60d6410daa171134014bf77cde759d1a7a914fe0ec63d800cc8034d` |


## 实际 rc.2 web 宿主的补充核验

2026-10-05，独立 output/qa 私有 profile 中加载伴随测试插件；凭据清空、fake OpenAI 只监听本机。宿主服务 inventory 与真实 agent scope 中可解析 llm、agents、sessions、jobs、subagents、tools、sessionPersistence；server uiWorkspace 与 sessionQuery 未解析，不能推断客户端导航缺失。

| 对照行 | 本轮断言 | 结果与范围 |
|---|---|---|
| DSH-01/04 | agents.create 创建真实注册 parent/sibling；live session 与真实 scope；工具白名单为空；fake parent turn 完成 | 通过；伴随插件与真实 agent scope，未直接拦截 StudyHub fiber |
| DSH-04/07 | ctx.llm 经宿主注册 fake route stream，BlockAssembler finish stop、文本与实际 usage；不支持的 effort 在 dispatch 前拒绝 | 通过：5 chunks，input17/output12/total29；这些是 fake provider 上报，不是生产模型质量/费用 |
| DSH-05/09 | spawn one-shot child 的真实 parent lineage、持久 label、正常输出、start/end 各一次、重复 dispose 后 agent/session 移除 | 通过；未测持有请求期间取消、continuable、浏览器 openSession |
| DSH-01/03/09 | owned job 在该真实 parent 上提交，未注册测试自写 controller | 被拒绝：background jobs unavailable: no job controller serves this agent (load @deepseek-ai/dsh-tool-jobs in its composition)。jobs 服务存在不等于该 composition 可提交；保留拒绝证据，不能改成“DSH 不支持 jobs” |
| 清理 | parent/child/session 收尾、scope effect 释放 | converged，parent scope disposer 一次 |

原始结果 output/qa/host-s10/host-capabilities.json、summary.json；伴随探针来源和运行命令在基线记录。接入宿主 jobs 前，必须明确合法 owner/controller composition；不能以 unowned 绕过拒绝或独立重写任务层。此结论仍未审定 alpha 的最终责任边界。

### 显式官方控制器组合复验

拒绝的源码原因：web profile 将 host-plane tool-jobs 关闭；正常 web 会话在创建时显式挂载 standard agent preset。裸 agents.create 不做该组合；tools.restrict 的空白名单仅限制工具可见性，不移除 controller。精确源码位置见 [探针说明](../../../tests/fixtures/runtime-s10/README.md)。

第二次以独立 s10-jobs-only preset 仅挂载已安装的官方 dsh-tool-jobs（quiet delivery），未手写 attachController；保留既有 default preset，parent/child 工具 schemas 均为空。实际 5 步全通过、4 次本机 fake requests、零页面/控制台错误，cleanup converged：

- 真实 parent/sibling、live session/scope、fake parent turn、ctx.llm stream 与 usage、effort 拒绝、one-shot child 标签/lineage/生命周期/重复释放全部通过。
- owned job 可提交；外会话和 callerless 读被拒绝；wait 到期仍运行；running→stopping→killed，producer cancel 与 settled 各一次，awaited reader 有记录。
- owner dispose 取消/移除 owned job、agent/session，scope disposer 一次。

来源：[manual fixtures](../../../tests/fixtures/runtime-s10/README.md)；原始结果 `output/qa/host-s10-jobs-preset/host-capabilities.json` 与 `summary.json`。这是显式 test composition 证据，不证明所有默认/preset 会话已自动有 controller；preset-free 拒绝保留于 `output/qa/host-s10`。alpha 必须先审定 owner/controller 绑定与单一结算责任者。
