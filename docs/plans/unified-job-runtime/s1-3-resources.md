# S1-3：共享既有资源的第一段实现

## 授权、基线与交付范围

所有者于 2026-10-06 02:28:22 UTC 明确接受 S1-2、授权合并 #262 并继续 S1-3。已核对 #262 head `78f83a8d1ca00a6669a76cc0df0db58ae3ef8bbc`、Ubuntu/Windows CI 成功、无评审/评论/未解决线程且可合并。main 同期独立合入 #263，仅版本和发布说明变更，没有生产逻辑重叠。#262 于 02:30:38 UTC 合并，远端 main 核实为 `09a094ae54c6afc68982ed5bc7d21a5a92d46b2e`。

本步负责人 Codex 云端内核负责人；分支 `codex/runtime-s13-resources`，基线为上述 merge。独立 worktree `/workspace/runtime-s12` 已在自身目录重新 `npm ci --legacy-peer-deps`。alpha 仍为 `c092d7ac8e73228091a9d0a0a7c04e6b82f64570`；未操作主检出、未发布/部署。此次授权没有扩展到其他 PR 合并或真实模型调用。

**这是 S1-3 的保行为资源共享部分，不是整个 S1-3 完成。** 生产变化仅把旧 worker 内部 `pumpAudio/admitAudio` 原样提取到 `lib/jobs/scheduler.js`（内部名 `pumpSlots/admitSlot`）；worker 的既有方法委托同一函数。`createPool` 直接重导出现有 `lib/audio-pool.js` 函数，未复制实现。没有新增 `context.resources`、公开包导出、Job 契约字段、配额注册表或资源策略。

## 真实资源与责任边界

| 资源 | 唯一实例/责任者 | 实际占用和申请/释放点 | 本轮委托与限制 |
|---|---|---|---|
| 转写槽 | `servicesForHost(owner).audioGate`；无宿主注入时保留各 runtime 原有 gate | 单文件 `startAudioJob` 入槽，`runAudioImport.onTranscribed` 释放；异常/结束 finally 幂等释放。批次父任务不占槽，成员通过同一 admit 入槽 | 旧 audio worker 与合成 v2 consumer 共用原对象、active Set、waiting 数组；新位置不创建实例。设置更新仍由既有入口写 limit 并 pump |
| 文本窗口池 | 单录音或整个批次的 `createPool` 返回对象 | 既有 `pool.run` work 生命周期；拒绝后 finally 释放，再等待 backoff，再申请 | 原录音/批次上限、动态下调/回升、暂停及拒绝重试保持。不是每个 provider HTTP 请求的许可；title、fallback、内部 retry 边界仍待 S1-4 |
| provider 配额域/RPM/共享冷却 | 尚无经评审接入的共同 owner | 尚未接入 | 不支持；不能从 audioGate 或窗口 pool 推导。未新增策略开关，也未借音频试点启用 |
| 本地工具、writer 互斥 | 各现有领域实现 | 不在本次转写共享范围 | 没有提前迁移；writer 串行与持久化仍在 S1-5 核对 |

### 不可省略的既有语义

- `admitSlot` 的 taskId 是唯一的占用 token；新 Attempt 使用 attemptId，旧入口保留旧 job/member ID。不同活跃申请不能复用 token。
- 取消排队申请会移除 waiter，随后仍调用 `work(release)` 让领域完成取消结算。callback 必须在 I/O 前检查 signal；此函数不是“取消后 callback 不执行”的新契约。合成 v2 consumer 显式检查 `signal.throwIfAborted()`。
- 运行取消只传播信号；实际 work 未退出时仍占槽。安全阶段提前 release 的调用者必须证明物理转写已结束；finally 再次 release 不得释放下一位。
- 下调只影响新派发；在途数量可以暂时高于新 limit。父批次保持 `orchestrates` 绕过父级占槽，再由成员申请，避免父持槽等子。
- pool 的拒绝 backoff 属于被拒绝的 work。测试明确证明同一 pool 的新 work 仍可运行：**这不是共享 429 冷却**，不能把该测试标为共享配额策略验收。
- 没有新增计时器；资源等待沿用现有 signal。新的统一资源排队期限、公开资源端口和多资源组合语义需要先走契约评审。

## DSH 对照与核验范围

引用 [DSH-06](s1-0-dsh-capabilities.md#固定行-id-能力对照) 与 DSH-01/03。保行为部分依能力表复用已经核验的 StudyHub host audioGate 和录音/批次 pool；没有把 DSH 的任务 owner 上限当作转写或 provider 请求配额。

本轮重新读取实际安装 `@deepseek-ai/dsh-jobs-local@0.2.0-rc.2`：`lib/index.js` 的 Config、start 和 activeJobCount 按精确 owner 统计 running/stopping，满额拒绝。`dsh-llm-retry@0.2.0-rc.2` 的 apply/recover 将重试状态写在 `sessionProjections.llmRetry`，以 provider/policyKey 读取当前 agent.session；step/start 或 turn/end 清空。它消费 providerRetryAfterMs，不能因此推断跨 session 的配额域许可/共享冷却。

实际入口源码哈希和版本见 [机器证据](s1-3-resource-evidence.json)。这是源码范围核验，不是新的宿主运行证明；也不声称所有 DSH 包都不支持共享配额。S1-2 的真实宿主 binding 验证仍按其原范围有效，本轮不把受控 native double 说成真实宿主。

## 验证与保留的失败

- 在基线生产代码上先运行 `tests/unified-runtime-resource-baseline.test.mjs`：**4 pass / 0 fail**，覆盖 FIFO、提前释放幂等、排队取消清理、动态限额和独立文本池。
- 新入口测试先红：`tests/unified-runtime-resources.test.mjs` 因 scheduler 模块不存在退出 1，日志 `output/s13-implementation/resources-red.log`。
- 提取后 6 文件定向回归 **33 pass / 0 fail / 0 skip**，日志 `resources-green.log`。覆盖同函数委托、真实生命周期取消与物理清理、fake clock 的拒绝退避，以及既有 audio/pool/host ownership。
- 新增实际 `StudyService.audio.import` 与 v2 资源 consumer 双向混跑后，首次 **9 pass / 1 fail**：测试 teardown 对跨 owner snapshot 调 `job.wait` 被正确拒绝。改为既有 owner 过滤的 `job.status`，没有放宽权限或断言；随后该文件 **10 pass / 0 fail / 0 skip**，日志 `mixed-audio-fixed.log`。
- 所有文本/转写请求均为本地受控 fake，无付费请求。混跑测试的宿主 executor 是 double，不是真 DSH 重测；真实领域音频入口、gate 与生命周期参与测试。
- 完整 `npm run verify` 和最终 SHA 的 CI 结果在本实现 PR 验证区记录，不能用以上定向结果代替。完整测试保留机器锁，环境清空凭据变量，使用私有 TEMP/TMP/DSH_HOME、Node 22.22.3 和 system Chromium。

复现（先按仓库规则隔离环境）：

```sh
node --test tests/unified-runtime-resource-baseline.test.mjs tests/unified-runtime-resources.test.mjs tests/audio-concurrency.test.mjs tests/audio-pool.test.mjs tests/audio-pool-adaptive.test.mjs tests/host-ownership.test.mjs
npm run verify
```

## 剩余门禁与下一项可审决定

1. 本 PR 的保行为资源提取须负责人验收与单独合并授权；不勾选整个 S1-3。
2. S1-3 的新旧 provider 配额域总上限、双向共享 429 冷却、不同域隔离，以及统一有界等待尚未实现/验收。S1-4 不可凭本次共享 gate 测试直接放行。
3. 建议下一份**仅契约/fixture PR**先明确：许可绑定到实际请求边界（不是窗口）；配额域需显式无密钥标识，不能按模型名猜账户配额；原录音/批次工作量上限保留；共享策略独立默认关闭；复用或扩展既有唯一责任层，禁止套第二个 pool/retry；排队 deadline 与 observer wait 分开；取消必须等物理清理后释放。DSH 候选实现与作用域核验完成后才选定适配方案，不能把待核验当作不存在。
4. 若负责人选择在首个音频试点暂不提供扩大配额域策略，需要明确接受该范围，并同步调整 S1-3 验收门禁；本代理没有自行作出这个决定。

回退：恢复 worker 内原函数并删除新增内部入口；text pool 未修改，数据格式、模型策略、计量和在途执行语义不变。没有持久迁移、试点开关或发布操作。
