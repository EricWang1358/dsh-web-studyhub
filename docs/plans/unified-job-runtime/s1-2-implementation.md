# S1-2 云端实现记录

## 精确批准范围

用户于 **2026-10-06 01:22:13 UTC**，在主线程对 [455a02c 的可直接审批方案](https://github.com/EricWang1358/dsh-web-studyhub/blob/455a02c62473401043efdf73317acb10c329a8e8/docs/plans/unified-job-runtime/s1-2-cloud-preflight.md#可直接审批的决定) 回复“批准”。授权实现 S1-2、补齐 S1-1 live 兼容验收：真实发起 Agent + 现有官方 controller，唯一业务结算，卸载显式停止并等 producer 清理，v1 隔离。接受冷会话不能新提交试点、销毁 owner Agent 停止其试点任务的 alpha 限制。

批准不包含 main 合并、发布、部署、付费模型调用，也不替代后续负责人的独立策略及验收决定。证据 PR #260 保持独立 draft；实现分支 `codex/runtime-s12-lifecycle` 基于 `455a02c`。S1-2 尚未验收。

## 实现边界（进行中）

- 同一 `work.jobs` 元记录持有 canonical contract；legacy lean 属性只作派生读取；WeakMap 保存执行关联，不新增公共任务表。
- DSH-01/03/09 复用实测 rc.2 jobs.start/kill/producer.done；原生 admission 决定 controller 可用性，不访问宿主私有表，不创建 Agent 或加载 controller。
- Cordis effect 注册定义与卸载；公共生命周期负责物理 Attempt、logical wait 和完成事件。producer 未完成之前保留等待与占用。
- 领域提交使用异步准备 + 再次身份校验 + 同步 publication；持久 writer 的联合提交、崩溃恢复仍属于 S1-5，不能声称本步已经完成。
- 原 extension work.start 与 v1 领域路径保持原实现；没有注册音频试点定义或启用试点开关。

## 验证

红灯日志 `output/s12-implementation/red.log`：缺失 lifecycle/executor 模块。后续测试与真实宿主、完整验证结果待填写；不使用 fake 结果替代真实模型验收。

### 本轮已执行结果

- 首轮 test:fast：5,081 pass / 3 fail。新增 panel 绑定直接读取 `ctx.agents` 触发 Cordis 注入保护，影响三个旧宿主测试；改为受保护的 get 查询，缺失服务只阻止新试点，不影响旧请求。
- 修正后 11 文件定向回归：117 pass / 0 fail / 0 skip（3,018 ms）；包括上述三个失败、旧 owner/extension 行为、版本读取与新生命周期。
- 实际 rc.2 宿主：8 步通过，4 次本机 fake 请求，cleanup converged；验证 canonical 取消、跨 Agent native fence、实际 owner Agent 销毁、插件卸载等待 producer。安装包的 10 份变更生产文件逐份与源码一致；指纹收据见 `s1-2-implementation-evidence.json`。
- 保留打包诊断：覆盖同一路径 tarball 后 pnpm 复用了旧安装；改用指纹命名的私有 tarball 后逐文件校验一致并重跑，最终采用 `s12-lifecycle-fingerprinted` 报告，前两次宿主结果不充当最终源码证据。
- lint / build 已通过；完整 verify 与最终提交 CI 的状态以实现 PR 验证区为准，不提前计为通过。

### #260 单独合并授权与最新基线

后续用户单独批准合并 #260；在原 head 455a02c、双平台 CI 成功、无审查意见/未解决线程、无冲突的情况下，已于 2026-10-06 01:39:00 UTC 合并为 `b8ff5eef8132ede33bb1c3466e8651308124673e`。此前 main 独立合入 UI PR #261（44e3712）。S1-2 新实现未进入 #260；本分支将按规则 merge origin/main 后做组合验证。该次授权不允许合并本实现 PR。


### 合并前旧基线完整回归与组合验证范围

首轮完整 verify（455a02c 基线 + S1-2 实现）通过：5,574 pass / 0 fail / 2 Windows-only skip，492,541 ms，lint 与 build 通过，日志 `output/s12-implementation/verify.log`。之后补充直接读取运行中 snapshot 的 queued-only 动作矩阵回归（先红后绿），以及真实文件产物提交的取消 fence，并增加宿主有界输出的写入/读取委托。

已 fast-forward 整合 main `b8ff5ee`，保留全部独立 UI 变更，重新 npm ci。宿主 driver #261 的差异已审读：新增 UI-only 选择器测试位于本探针有意跳过的 UI 区段，既有安全配置与启动/清理入口不变；仅新增精确 LF/CRLF 哈希，仍拒绝其他源码。本探针不宣称验证该 UI 区段。最终完整组合回归与新提交 CI 另记于实现 PR。

### 公共接口与限制

`StudyRuntime.registerJob(cordisContext, domainApi, definition)` 注册定义；操作上下文 `context.jobs` 提供 `submit(kind, input, policy)`、`status`、`list`、`wait`、`control`、`output`。只接受该 domain 与真实 workOwner；old facade 控制先校验库/owner，再委托记录的真实执行 owner。旧 extension `context.work` 保持不变。

`run(context, input)` 收到 signal、身份、受控 progress、检查点、request timeout、commit 和宿主 output。commit 仅支持异步准备后的同步 publication；异步持久 writer 的事务 fence、恢复和 S1-5 必须另行实现/验收，不能将该原语当作跨文件原子提交。请求超时请求停止并等待真实 promise 收尾，不以 Promise.race 冒充已停止。没有登记音频试点，没有修改模型路由或用量责任层。

下一门禁：S1-2 实现 PR 的负责人验收与合并；之后才能按 S1-3 的真实资源/策略矩阵推进。当前批准不放行新文本配额策略、自动恢复、音频试点开启或发布。

最后追加的请求 runtime 卸载回归先红后绿：原 `disposeRequests` 丢弃 drain promise，现所有 scope 清理逐层返回并等待它。对应 5 文件 20 pass / 0 fail，保留 `request-drain-red.log` / `request-drain-final.log`；最终精确提交全量验证以 CI 与 PR 收据为准。


组合全量回归完成：5,636 pass / 0 fail / 2 Windows-only skip，601,159 ms，lint/build 通过，日志 verify-main.log。该长测启动后有最后的局部卸载修正，故不把它单独当作最终精确 SHA 全量证明；最后差异的定向检查和精确提交 CI 分别保留。

最终复核补充了“定义已卸载后 retry 不再显示 available”的失败测试；修正仅刷新作用域失效后的动作拒绝原因（scope-unloaded），不改变 v1 或物理停止协议。相关 6 文件 83 pass / 0 fail，日志 unloaded-actions-red.log / unloaded-actions-final.log。实现独立 Draft PR #262；新实现没有获得合并授权。

## 后续验收与合并（2026-10-06）

所有者于 02:28:22 UTC 接受本记录的 S1-2 限定范围，授权合并 #262 并继续 S1-3。已于 02:30:38 UTC 合并，远端 main 核实为 `09a094ae54c6afc68982ed5bc7d21a5a92d46b2e`。最终 head `78f83a8` 双平台 CI 均成功、各 5537 pass / 0 fail / 94 skip；最终安装包实际宿主探针 8 步通过、4 次 fake 请求，完整收据见 [#262](https://github.com/EricWang1358/dsh-web-studyhub/pull/262)。此前“待验收”的段落保留为历史状态，本段为当前门禁结论。后续 PR 合并、共享配额策略及发布仍分别审定。
