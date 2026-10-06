# S1-2 云端接手与宿主绑定前置证据

2026-10-06，Codex 云端负责人；任务分支 `codex/runtime-s12-host-evidence`，独立 worktree `/workspace/runtime-s12`。基线 `c3377f67a2797ba97807447653fb9228a1834265`。本轮只增加特征测试、手工宿主探针与证据；不接入生产执行，不表示 S1-1 整步或 S1-2 已完成。

## 已核实的进度与门禁

- GitHub REST 与 `git ls-remote` 均确认 main 为上述 SHA；[#259](https://github.com/EricWang1358/dsh-web-studyhub/pull/259) 已合并。开工时开放 PR 列表为空；alpha 分支为 `c092d7ac8e73228091a9d0a0a7c04e6b82f64570`。没有改动该分支或任何本地电脑任务。
- [v2.6.0](https://github.com/EricWang1358/dsh-web-studyhub/releases/tag/v2.6.0) 为已发布非 draft release，发布时间 `2026-10-05T07:43:57Z`；历史 P0 控制台与契约 v1 证据继续见 [S1-0 基线](s1-0-baseline.md)，本轮没有重做 P0 UI 验收。
- S1-0 已接受并合并 #241；S1-1 契约 #245、读取兼容 #255 已合并。#255 merge 为 `1a432f5e9cf166398385174cf1ec047f16cfceef`，其说明明确不勾选整个 S1-1。不能从“兼容已合并”推导 live v2 控制、稳定执行身份或持久化已实现。
- `lib/jobs/` 只有生产契约模块；普通 producer 仍 v1。注册、生命周期、调度、网关、持久化、单文件音频试点仍是 S1-2…S1-6 的缺口。解除归档的 v2 历史跨进程保存及损坏 archive envelope 身份核对仍归 S1-5。
- 已读取入口五份文件、契约、历史 PR 与证据。当前云端工作区及仓库没有 `AGENTS.md` 或 `.agents/skills/SKILL.md`，未凭空补造本地技能要求。
- 正式持续 goal API：当前工具清单及 `codex --help` / `codex exec --help` 未暴露可配置接口，**未设置**。S1→S6 总目标仍待完成，不能把本轮证据 PR 当作总任务完成。

## 本轮实测

DSH 对照行：DSH-01 / DSH-03 / DSH-09；复用已有 Cordis、StudyHub runtime 与 DSH jobs 实例，不创建生产任务表、调度器或 controller。所用 Node `24.19.0`、npm `11.9.0`、Cordis `4.0.4`；隔离安装 DSH、agent、llm、jobs-local、subagent、tool-jobs、agent-preset、agent-preset-registry 均实际核验为 `0.2.0-rc.2`。

### 生产源码的特征测试

新增 [runtime-owner-characterization.test.mjs](../../../tests/runtime-owner-characterization.test.mjs) 使用真实 Cordis 与 StudyHub 生产 plugin/fiber，session/model 服务为明确的 test doubles，不宣称完整 DSH 宿主验证。

| 场景 | 观察结果 |
|---|---|
| 两会话的面板 facade 与工具 requestServices | 同库同 runtime、同 `workOwner` Symbol、同 audioGate；会话 ID 各自保持；没有 executor 绑定 |
| 冷会话读取 | `sessionPersistence.stat` 可供 source.list 读取；不调用 agents.create；不存在 live Agent/session；未知会话拒绝 |
| 卸载期间持有的 extension 执行 | 卸载传播 abort，但 fiber disposal 返回时任务仍 cancelling，settled promise 仍在；释放执行器后才 cancelled，新派发拒绝 |

这些是旧行为基线，不能为“通过”而提前修正生产代码。首次运行的 2 pass / 1 fail 是测试误读 `StudyService.root`，已更正为实际 `service.store.root`，不是生产缺陷红灯。

### 实际 rc.2 web 宿主

复用 [S1-0 手工探针](../../../tests/fixtures/runtime-s10/README.md)，新增显式 `--studyhub-binding` 模式。在隔离 profile 安装当前打包的生产 StudyHub，再直接观察其真实 workbench fiber；继续使用单独的 `s10-jobs-only` 官方 controller preset，**没有证明任意默认/preset 配置都可执行**。

已提交 [机器可读收据与源码/日志指纹](s1-2-cloud-evidence.json)。最终运行：`output/qa/s12-binding-final/host-capabilities.json` 与 `summary.json`，**7 项通过，cleanup converged，4 次本机 fake 请求，0 页面错误、0 控制台错误**。没有真实服务商请求或付费模型质量验证。

| 实测 | 结果 / 对 S1-2 的影响 |
|---|---|
| 真实 parent/sibling 与 StudyHub requestServices | 同生产 Symbol owner、同 audioGate，不同 initiating session；生产 executor 仍未绑定 |
| 从生产 workbench fiber 的 jobs 服务提交 controlled producer | 明确 live owner + 官方 controller 时接纳；随机不存在 owner 在 dispatch 前拒绝；外会话读取拒绝 |
| stop 与物理收尾 | held producer 的 kill 后状态 stopping；观察 wait 到期不结算；实际释放后 killed、settled 一次 |
| 重复 kill | rc.2 在 stopping 时再次调用 producer.cancel，实测 **2 次**；并非重复结算。S1-2 需业务 control admission 去重 |
| 卸载生产 workbench fiber | live Agent 仍在，宿主 job 仍 running、隐式 cancel **0 次**。显式 kill 与释放后收尾完成；必须增加 plugin scope → 已关联 handle 的停止/等待薄适配 |
| owner dispose | 原有探针确认取消、移除 job/Agent/session，scope disposer 一次；不等同于 producer fiber 卸载 |

宿主源码解释：`dsh-jobs-local/lib/index.js` 的 `resolveOwner/servesOwner`（527–545）核对真实 Agent/controller；`killJob`（611 起）在非终态重调 cancel；`disposeOwned`（771 起）才按 Agent 生命周期清理。scope 身份与 Agent 身份不可互相代替。

首次 held-stop 探针按“重复 kill 仅 cancel 一次”假设失败（`2 !== 1`）；随后保留真实结果为特征断言，没有修改宿主或生产代码掩盖差异。

## 提交负责人审定的绑定方案（尚未批准）

1. 保留库级 `work.jobs` 为唯一公共事实来源，现有 Symbol/domain 权限边界继续适用。DSH jobs 只作为真实物理执行 handle；业务 Job/Attempt 的状态映射、一次结算、提交身份保护由唯一内核负责，不能复制第二套执行 promise/队列。
2. live 工具入口从已注册的 execution.agent 取得 owner；面板只在真实 agents.get(sessionId) 存在且该 owner 有官方 controller 时接纳新试点。冷会话、无 controller 时明确拒绝新试点，不自动创建 Agent、不改用户 preset、不退到 unowned。旧路径与读取保持原行为，试点默认关闭。这项试点范围限制需要负责人明确接受。
3. plugin scope 释放时关闭新接纳，对该 scope 已关联 handles 做幂等停止，并等真实 producer cleanup；不能仅凭 host killed/failed 或 timeout race 回收资源。DSH 抛错 cancel 的强制失败仍可能留下孤儿，须另测并保留未知状态。
4. 现有库内跨 session 查询/控制与宿主 exact-owner 访问不同。公共操作先保留原库/插件/domain 授权，再使用记录的合法 owner 调用宿主；不能由 caller 提交任意 owner ID 绕过校验。进程内关联不是第二张公共任务表。
5. 状态/动作、迟到产物、排队取消、三类超时、卸载、单次完成事件和旧入口回归，须在上述边界获审定后先写失败测试，再实现 S1-2。音频真实接入仍待 S1-3…S1-6 顺序验收。

必须等待的批准来自 [能力表](s1-0-dsh-capabilities.md) 最后一段：“alpha 必须先审定 owner/controller 绑定与单一结算责任者”；[Sprint 1](sprint-1.md) 也明确“不能绕过前置门禁写生产代码”。本轮将可评审的方案和实测提交，**暂停依赖的生产实现**，CI 或 fake 模型不能替代负责人批准。

## 可复跑命令与验证状态

依赖在独立 worktree `npm ci --legacy-peer-deps` 安装；所有测试通过仓库 `scrubSecrets` 清空凭据/redirect 变量，TEMP/TMP/TMPDIR/DSH_HOME 与 XDG data/cache/config 均指向工作区私有目录，`SSH_TTY=audit`。未设置 `STUDY_TEST_NO_LOCK`，仓库 runner 与网络测试守卫未改。默认机器锁位于用户 home，该目录在此环境不可写；runner 按既有规则降为无锁运行，本轮没有并发启动第二个全量检查。后续全量云端检查应将 `STUDY_TEST_LOCK_FILE` 指向跨 worktree 共用的 `/workspace/studyhub-tests/full-run.lock`，而不是各自私有 TEMP。

```sh
node scripts/test.mjs --test-concurrency=1 tests/runtime-owner-characterization.test.mjs tests/host-ownership.test.mjs tests/plugin-composition.test.mjs tests/backend-boundaries.test.mjs tests/unified-runtime-live-read.test.mjs tests/unified-runtime-archive-read.test.mjs tests/unified-runtime-recovery-read.test.mjs

# 先按既有 QA 流程准备私有 profile；Linux 可设 PLAYWRIGHT_CHROMIUM=/usr/bin/chromium。
node tests/fixtures/runtime-s10/run-host-probe.mjs --repo /workspace/runtime-s12 --dsh-bin /workspace/runtime-s12/output/qa/dsh-cli/node_modules/@deepseek-ai/dsh/lib/bin.js --out /workspace/runtime-s12/output/qa/s12-binding-final --variant official-jobs-preset --studyhub-binding --port 3592 --model-port 4596
```

| 检查 | 状态 |
|---|---|
| 7 文件定向回归 | 92 pass / 0 fail / 0 skip，3,845.85 ms；`output/s12-private/targeted.log` |
| 实际 DSH 宿主 | 上述 7 项通过；基线 + 本 PR 探针，无生产改动 |
| 语法与 diff | 两份 manual probe `node --check`、`git diff --check` 通过 |
| 全量 `npm run verify` | **失败**：lint 通过；5,487 pass / 2 fail / 75 skip，228,385 ms；失败后该链路 build 未执行；`output/s12-private/verify.log` |
| 独立最终 lint / build | 两项通过；`final-lint.log` / `build.log` |
| 打包与任务控制台补验 | 13 pass / 0 fail / 0 skip，含 6 条 Chromium 实际 UI 测试；`pack-console.log` |
| 内存断言隔离复现 | `tests/original-attach.test.mjs` 21 pass / 1 fail：第 286 行 arrayBuffers < 64 MiB 断言在当前 Node 24 云端复现；相关生产与测试文件未改；原因未确认 |
| S1-2 新生命周期、持久化、音频试点、S2–S6 | 未运行/未实施；前置门禁仍在 |
| 真实模型、alpha 发布、指定版本回退 | 未运行；需后续授权与验收 |

全量失败逐项：`original-attach` 内存断言如上；`wp28b-companion` 的 npm pack 尝试写 `/home/agent/.npm/_cacache`，该环境不可写。75 skip 包含未选定系统 Chromium 导致的浏览器跳过，不能视为完整 UI 通过。包/控制台以工作区 npm cache 与系统 Chromium 151.0.7922.173 单独补验：13 pass / 0 fail / 0 skip（含 6 条实际浏览器测试），220,721 ms，`output/s12-private/pack-console.log`。此补验消除包缓存失败并证明所列控制台场景，但不覆盖其余被跳过的 UI，也不把完整 verify 改记为通过。没有为过测改断言、关闭机器锁或削减全量清单。

保留环境失败：第一次 profile 安装因 pnpm 尝试写用户数据目录失败，改用工作区 XDG 目录后 profile/宿主启动成功；Playwright pinned browser 不存在且下载失败，实际 probe 用已安装 `/usr/bin/chromium` 成功。原 driver 只有 CRLF 哈希，Linux LF 被拒；字节比对确认仅换行不同后增加精确 LF 哈希，仍拒绝其他源码。

回退本 PR 只撤回新增测试/探针/文档，无生产或持久数据升级。下一步是负责人接受/修订本节绑定方案并明确 S1-1→S1-2 前置范围；之后执行 S1-2 生命周期实现。S1-3 起不得越过该验收，S6 总目标保持未完成。
