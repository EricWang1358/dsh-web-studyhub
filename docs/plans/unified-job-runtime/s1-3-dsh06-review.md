# S1-3：DSH-06 实测、契约审查与待批准决定

2026-10-06 状态更新：下述建议已获所有者 02:53:23 UTC 授权，#264/#265 检查通过后分别合并为 `5bbc22d`、`ed157f3`。历史“待批准/暂停”表述对应原评审时点，契约门禁已解除；不代表 S1-3 整步或未来 PR 已批准。

## 结论与推荐

推荐先接受并单独授权合并 [#264](https://github.com/EricWang1358/dsh-web-studyhub/pull/264) 的**保行为提取部分**，以及 [#265](https://github.com/EricWang1358/dsh-web-studyhub/pull/265) 的**修订后资源契约**；随后继续实施 S1-3 的受限共享许可/冷却适配。不要把两份 PR 合并等同整个 S1-3 验收。

拟批准的实现仅覆盖一个 DSH host 进程、可信显式绑定的配额域、能观测每次实际请求及其物理清理的路径。沿用并演进原 `createPool` 唯一实现，不为同一资源再建第二套队列/重试器；保留录音/批次窗口上限。共享 provider 策略独立默认关闭，音频试点不隐式启用。宿主调用若隐藏内部 retry/hedge，无法证明物理请求边界，则拒绝该路径启用共享配额，保持 baseline，不伪报计数。

本批准范围不包括 #264/#265 以外的 PR 合并、S1-4 生产网关迁移、音频试点启用、部署/发布、付费模型调用、凭据/权限变更或用户本地任务。后续实现仍需单独代码验收；共享策略投入生产不由本契约默许。

## 当前实际证据

在已隔离的 DSH **0.2.0-rc.2** web composition 中新增手工审计模式 `--resource-scope`，沿用正式 jobs-only preset、实际注册 Agent/session、实际 jobs-local、实际 llm-retry 与 llm.stream。没有注册假 controller、替换真实重试器或改宿主限制；只创建受控空 producer，并向公开 `agent/request-error` waterfall 注入明确的合成 429。

2026-10-06 02:49:56 UTC 运行，**6 个 companion 步骤通过**；wrapper 5 步通过，**5 次本地 fake model 请求**，pageErrors/consoleErrors 均为 0，cleanup.converged=true。没有真实 provider HTTP 429、付费模型、质量或费用验证。

| 候选能力 | 实测结果 | S1-3 的结论 |
|---|---|---|
| jobs-local owner 上限 | 同一 parent 第 11 个 job 被拒绝；另一个真实 sibling 仍能接纳。前 10 个中一个进入 stopping 后仍拒绝替补；它 settled 后替补成功 | 这是 owner 的 Job 容量，不能充当同 provider 的实际请求配额 |
| llm-retry 共享状态 | 同 provider、同 policy 的两个真实 Agent 各自产生 retry=1，retryId 不同 | 已安装重试状态按 agent.session 隔离，不是同域公共计数 |
| Retry-After 等待 | 两个合成 429 都生成 delayMs=10000 的实际 llm/retry 事件，等待期间仍 pending | 宿主确实消费这类延迟；不能将它说成共享冷却 |
| 同 provider 新请求 | 上述两次等待尚未结束时，同 provider 的真实 llm.stream（仅本地 fake endpoint）已完成 | 在该 composition 与公开直接调用入口，宿主重试等待不提供共同请求接纳屏障 |
| 收尾 | 中断审计等待、释放所有空 producer，owner 清理收敛 | 证明该手工审计没有遗留自己的任务或退避等待；不等于所有生产远端能停止 |

源码与运行证据一致：`dsh-base/cordis.patch.yml` 加载 `dsh-llm-retry`；`dsh-jobs-local` 的 start/activeJobCount 统计 exact owner 的 running+stopping；`dsh-llm-retry` apply/recover 使用 sessionProjections、provider/policyKey；`dsh-agent` 的公开 agentEvents 将 subject 与 scope 绑定。精确安装文件版本、SHA-256、运行摘要见 [机器证据](s1-3-dsh06-evidence.json)。

**核验结论有明确范围**：上述已安装候选 API 的可复用边界与缺口已实测，可以排除“直接把 jobs 上限/llm-retry 当共享 provider 调度器”的方案。没有遍历或验证所有其他 DSH 扩展，也不声称未来/其他 composition 永远没有配额服务。具体 provider 适配器能否观测全部外部请求，仍必须逐路径证明；不能从本次 fake stream 推断真实 SDK 内部行为。

## 对 #265 的独立审查

本次按已合并契约、旧资源调用点、宿主实际行为重新核对，而非仅运行原 fixture。没有另开代理，也没有把自审称为另一位负责人的批准。

| 审查项 | 发现/处理 |
|---|---|
| 物理请求与 host-attempt | 原提案仅写 physical-request，未充分拒绝隐藏重试的路径。新增 providerObservation，shared 模式只接受 external-request；先红后绿测试拒绝 host-attempt |
| 全局保证范围 | 同一账户可能在别的进程/机器使用。新增 enforcementScope=host-process，拒绝 account-global；不声称账户全局总量受控 |
| 与旧路径共存 | 原 host gate 和录音/批次 pool 保留；相同 provider 资源实例只一个 owner。领域窗口并发和物理请求许可是不同约束，不能重复计数同一资源 |
| 开关与在途任务 | default-off 与音频试点独立；关闭先停新接纳并排空，避免新请求绕过仍在使用的旧策略。动态 limit 影响后续派发，Attempt 绑定身份不变 |
| 取消和真实占用 | 不能因 cancel 回执或 observer wait 到期释放；operation 的 awaited promise 必须涵盖实际清理。无法确认的 adapter 不能宣称可用 |
| 重试边界 | 资源层只接纳/等待/接收限流反馈，不重发；后续演进既有 pool 时必须显式关闭其资源模式中的 work 重试，避免和 S1-4 传输重试叠加 |
| 契约 fixture 限制 | 字符串引用和数据形状校验不证明权限、物理边界或调度；这类断言仍由生产集成和宿主/适配器证据承担 |

修订测试：新增边界反例先失败，修订后新旧契约共 **32 pass / 0 fail / 0 skip**；lint 结果与最终提交 CI 见 #265。这些不是共享调度的运行验收。

## 复现与保留范围

从本契约 worktree 执行，`--repo` 指向已经 provision 的隔离 QA worktree，只为复用其专用 DSH profile/SDK/本地 fake server 工具，不共享本工程 node_modules。测试仍通过自己的安装完成 lint/fixture 校验。这里未使用 StudyHub lifecycle 模式，故不把 profile 中原安装的 S1-2 包当作 #264 生产源码运行证明。

```sh
node tests/fixtures/runtime-s10/run-host-probe.mjs \
  --repo /workspace/runtime-s12 \
  --dsh-bin /workspace/runtime-s12/output/qa/dsh-cli/node_modules/@deepseek-ai/dsh/lib/bin.js \
  --out /workspace/runtime-s12/output/qa/s13-resource-scope \
  --variant official-jobs-preset --resource-scope --port 3593 --model-port 4597
```

需依代理规则清空所有凭据/重定向环境，设置 SSH_TTY=audit、工作区私有 TEMP/TMP/DSH_HOME/XDG/cache；实际运行使用 `output/s13-contract/run-command.mjs` 封装。不重置私人 profile，不更改默认 preset，不调用真实模型。手工宿主审计不加入 npm test，不增加 CI 外部程序测试负担。

审查/证据完成并不授予合并权。[代理规则](agent-rules.md)要求“先提交只改契约文档与测试的 PR，合并后再迁移调用方”；[Sprint 1](sprint-1.md)要求共享策略方案先经契约评审确认。本轮已把所需决定做成可审内容，生产共享策略接线仍暂停在该门禁。
