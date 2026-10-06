# S1-3 资源契约提案（review-only v1）

本 PR **只含契约文档与可执行校验 fixture**，没有资源调度实现，没有启用任何策略，也不使 S1-3 完成。基线 `09a094ae54c6afc68982ed5bc7d21a5a92d46b2e`；用户于 2026-10-06 02:28:22 UTC 接受并授权合并 S1-2 #262、继续 S1-3。下一份新接口生产实现必须等待本契约评审/合并及对应宿主能力核验，不以 fixture 通过替代这些门禁。

负责人 Codex 云端内核负责人；分支 `codex/runtime-s13-resource-contract`，独立 worktree `/workspace/runtime-s13-contract`，自身 npm ci。本文是独立的资源执行端口契约提案版本 1；不改变已经发布的 Job v1/v2 序列化形状、状态词汇或操作。将来若增加 Job 公共字段，必须另提版本变更。

## 需要批准的具体决定

1. **只复用实际实例**。转写绑定现有 host audioGate；文本工作量绑定原录音/批次 pool。绑定由可信宿主/运行时在注册作用域解析，资源字符串只用于审计，不能通过 submit 输入任意选择 owner、配额域或计数器。卸载即撤销绑定和新接纳。
2. **独立策略且默认关闭**。拟用配置名 `runtime.resources.sharedProviderQuota`，默认 `false`；不随 `runtime.pilot.audioSingle` 改变。开时必须明确 quotaDomainRef 和经过核验的实际请求适配器，否则在任何 I/O 前拒绝。没有配置入口实现，不会因合并本文改变用户设置。
3. **配额域不能猜**。可信配置将 provider 的账户/项目/配额组解析为不含密钥的 opaque ref；模型名、库目录、jobId、API key 哈希均不能自动推断同域。别名模型共享真实配额时必须映射同一个域；无法确认时拒绝启用策略。不得把凭据、URL 或账户详情写入 Job/事件；fixture 的字符校验不是秘密扫描器。
4. **一次实际申请，唯一责任层**。一个 host 内同 kind/scope 的资源只有一个 counterOwner；旧、新请求都委托它。一个物理请求只计一次；不允许旧 pool 外再套一套相同配额 gate。录音/批次窗口上限与 provider 请求上限是不同约束，若同时适用，由已选定的共同责任层协调可派发条件，禁止持有 provider 槽再等待同域子请求。具体共同实现须由 DSH-06 证据决定，不在此选择未核验的自写队列。
5. **有界等待与真实释放**。新 provider 资源申请显式 queueTimeoutMs，有限且非负；它不是 job.wait 的观察者 timeout。到期移除 waiter、不调用 provider；已接纳后请求 timeout/cancel 传播底层 signal，但必须等物理 promise/cleanup 完成才释放一次。旧 baseline 可保留 queueTimeoutMs=null，沿用既有 signal；这不算统一有界等待实现。
6. **共享冷却不是重试器**。许可层接收已观察到的 429/Retry-After，按确切域阻止新派发；不重发请求。S1-4 决定唯一传输重试责任层。已结束的失败请求先释放许可，冷却后重试重新申请。未确认物理停止的请求不能为了退避提前释放。不同域不受影响，下调不撤销在途占用，回升不超过配置上限。
7. **切换与回退**。策略/资源绑定身份在 Attempt 开始时固定；动态 limit 在同一实例上只影响后续派发。关闭策略不让新请求绕过仍在使用的同域限制：先关闭该域新接纳，排空使用旧策略的请求/Attempt 或等安全边界，方可切回 baseline。不能在同域并存两套配额计数。
8. **只承诺一个 host 进程中的实际可观测请求**。`enforcementScope: 'host-process'` 是首版明确边界，不是账户全局限额，也不覆盖另一 DSH 进程/机器。provider 绑定必须证明 `providerObservation: 'external-request'`；若宿主/SDK 会在一次 host-attempt 内隐藏 retry/hedge，请求数未知，拒绝该路径启用物理请求配额策略，保持 baseline 并返回能力缺口。不能用一个 host-attempt 许可冒充多个物理请求都已受控。

## 拟议端口语义（尚未发布）

资源对象由可信 domain 注册提供给执行上下文，建议端口为 `context.resources.run(resourceRef, operation, { queueTimeoutMs })`。这里只规定责任与生命周期，不提供可执行实现。资源引用必须属于当前 owner/domain/Attempt 已绑定集合；不能跨 owner 取得资源端口。宿主 gate 可以跨库共享实际容量，但共享容量不赋予操作/结果读取权限。

`operation(signal)` 的 fulfillment/rejection 表示本次物理资源使用及清理结束。端口等待它结束再完成 release；不会因 AbortSignal 触发或 Promise.race 的超时回执提前放行。operation 不得脱离 awaited promise 继续占用资源。端口不产生 Call、用量、业务终态、通知或产物提交；这些仍由原契约指定的生命周期/网关/writer 拥有。无占用的父编排任务直接等待子任务，不申请子任务使用的 provider 许可。

现有 `admitAudio(work(release))` 有提前安全释放和取消后领域清理语义；不把它伪装成上述 run 契约。保行为提取见 [#264](https://github.com/EricWang1358/dsh-web-studyhub/pull/264)。将来接入新端口时须由薄适配分清转写物理阶段与后续文本，保持原阶段占用范围。

拒绝分类：unknown/unbound resource、scope-unloaded、capability-unverified、quota-domain-unresolved、queue-timeout、aborted。操作失败原样进入生命周期错误处理；permit 拒绝不创建假的 provider Call。错误码最终发布需契约实现测试覆盖，本文的 schema 错误码只是评审 fixture 的拒绝诊断。

## 数据 fixture 与可证明范围

`tests/fixtures/unified-runtime-resources.mjs` 使用已有 `schemastery`，只验证提案形状和关系：版本 1、明确策略布尔值、可空旧等待期限、有限新 provider 等待期限、真实资源类型/计量单元/作用域、唯一 resourceRef 与同域责任者、显式无权限含义的 counterOwnerRef。baseline 和 shared 两组身份/limit/期限全部是合成前提，**1000ms 与 limit=2 不是产品默认值或宿主测量**。

测试覆盖原值不变、试点开关不隐式启用策略、未知版本/字段/策略拒绝、窗口不能冒充请求、重复域不能注册第二计数器、非有限限制拒绝。fixture 没有 queue、timer、provider、网络调用或调度状态机，不证明真实许可、混跑、取消、冷却或恢复。

红灯：缺失 fixture 时测试退出 1。首份 schema 由于 nullable union 标为 required 而误拒绝 null，结果 1 pass / 5 fail；改为显式字段存在性检查和 nullable schema 后 6 pass / 0 fail。最终验证命令/结果与日志 SHA 在 PR 中记录。文档/fixture 不宣称生产运行通过，不勾选 sprint 实施状态。

```sh
node --test tests/unified-runtime-resource-contract.test.mjs tests/unified-runtime-contract.test.mjs
npm run lint
```

## 实施验收仍必须完成

| 待实现的证明 | 必须观测的行为 |
|---|---|
| 同域混跑 | 旧/新真实请求进入同一责任层，实际峰值不超限，每个物理请求只申请一次 |
| 双向冷却 | 旧 429 阻止新派发及反向都成立，Retry-After 有假时钟边界；不同域不被误阻塞 |
| 两类计数 | 录音/批次窗口上限保持，provider 只覆盖请求占用，不能通过 title/fallback/child 旁路 |
| 动态控制 | 下调保留在途、停止超限新派发；回升不超配置；取消等待移除、退避释放后重申请 |
| 物理清理 | finish/fail/cancel 重复回执只释放一次，未停 producer 持续占用；父子同域不死锁 |
| 策略切换 | 默认关闭、试点开关独立；在途身份固定，关闭先停止新接纳并排空，无双实例 |
| 宿主能力 | DSH-06 对应安装版本、公开 API、实际 composition 及作用域的最小验证；源码搜索缺失不能代替 |

DSH-06 当前证据只证明既有 StudyHub gate/pool 可复用、rc.2 jobs-local 上限是精确 owner 的 running+stopping Job 数、llm-retry 状态属于 agent.session 的 provider/policyKey。它们不是共同 provider 许可/冷却的已验收接口。审批本文仅固定语义；不能授权在能力仍待核验时自行写替代实现，不能放行 S1-4 或发布。

### 本轮独立核查与修订

按已发布 Job/Attempt 契约和实际宿主证据重新审查后，发现原提案未充分限定“物理请求可见”与“一个 host 进程”的边界。已追加上面第 8 项，并以先红后绿的 fixture 拒绝 `host-attempt` 冒充 `external-request`、拒绝 `account-global` 保证。没有变更生产代码。

[DSH-06 实际宿主证据与审批建议](s1-3-dsh06-review.md)给出本轮新运行结果。原“待核验”现细分为：候选 rc.2 owner-job/session-retry 行为已实测；它们不能作为共享 provider 许可/冷却直接使用；具体请求适配器的可观测性仍需逐路径核验。不能将任何一项扩展为整个 S1-3 已完成。

**合并门禁**：[agent-rules.md](agent-rules.md) 要求“需要新接口：先提交只改契约文档与测试的 PR，合并后再迁移调用方”；[sprint-1.md](sprint-1.md) S1-3 要求共享策略“方案先经 S1-0/契约评审确认”。因此生产策略接入暂停在此，已有资源提取与契约准备可以独立交付。此 PR 不含也不要求任何凭据/权限变更、真实模型调用、发布或部署。
