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

### 可直接审批的决定

**请求批准的是按以下边界开发 S1-2，并补齐 S1-1 剩余 live 兼容验收；不是批准合并、开启试点、付费模型、发布或 S1-3 后续门禁。**

| 决定项 | 技术建议（待批准） | 已有证据 / 尚存风险 |
|---|---|---|
| owner/controller | 使用发起任务的真实、已注册 live Agent；复用该 Agent composition 中现有官方 `dsh-tool-jobs` controller；由宿主 admission 拒绝无 controller/无 live owner，不自动创建 Agent、不改 preset、不用 unowned | explicit 官方 preset 实测可用；冷会话只读不代表 owner；任意用户 preset 未验证 |
| 唯一结算责任 | 同一 `work.jobs` 上由公共生命周期独占业务 Job/Attempt 终态、完成事件及提交资格；DSH handle 只报告物理执行状态；不另建队列、公共表或独立结算者 | 当前两种身份/状态不同；仅有 schema/reader 和宿主物理探针，业务结算接线尚未实现 |
| 取消/卸载 | 重复 control 在薄适配层去重；plugin/domain 卸载停止新接纳、显式停止已关联 handles，等实际 producer 收尾再释放许可；未知远端停止保留 unknown | 重复 kill 实测调用 cancel 两次；producer fiber 卸载不自动停 host job；实际 owner dispose 会停 job |
| v1 隔离 | 本轮不改变旧执行；未来试点默认关闭，仅影响新提交；冷会话/无 controller 时新试点明确拒绝，旧读取/控制保留；跨 session 操作先校验已有库/插件/domain 权限再委托记录中的 owner | **需明确接受的 alpha 限制：冷会话不能新提交试点，owner Agent 销毁将停止其试点任务。** v1 的宿主级任务所有权不等同会话生命周期，不能声称此处已行为等价 |

若不接受上述 alpha 限制，应先选择并验证能维持旧行为的合法 owner 生命周期，不能直接写执行器或伪造长存 Agent。本轮建议不是已有批准；已实测项也不等于最终实现验收。

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


## 验证跟进：Node 22 / 24 的内存断言

2026-10-06，在 PR #260 原 head `94008813efa62ead49f7e1c352c0ba169adac0a0` 上继续诊断，未变更生产源码。`package.json` 接受 Node >=22.19，`.github/workflows/verify.yml` 固定 Node 22，所以不能只以云端 Node 24 失败推定生产泄漏，也不能忽略受支持版本。

在原测试的临时观测副本中只增加诊断输出（没有改断言），相同 120 MiB 输入、480 个 256 KiB chunks：

| 未修正基线 | 整文件测试结果 | hash 前 ArrayBuffers | 未强制回收的峰值 |
|---|---|---|---|
| Node 22.22.3 | 22 pass / 0 fail | 7,041,103 bytes | 34,566,223 bytes |
| Node 24.19.0 | 21 pass / 1 fail | 5,192,205 bytes | 69,679,629 bytes |

生产 `hashFile` 将每块交给 hash.update 后释放引用；原断言读的是包含待回收缓冲区的进程 ArrayBuffers，受 V8 回收时机影响。修正只在 `tests/original-attach.test.mjs`，复用已有 `scripts/qa/perf-probe.mjs` 的 collectGarbage/settledMemory，并明确断言回收可用；保持 64 MiB 原预算、120 MiB 输入、chunk 数量/大小、超限拒绝断言。新增一个强持有整文件的反例及 digest 对照，证明回收不会让整文件缓冲行为逃过检查。没有提高阈值、减少输入或改变生产读写。

初版修正后 Node 22 / 24 各 22 pass；补充显式回收可用断言和诊断输出后，最终 Node 24 再次 22 pass / 0 fail，实测流式存活缓冲峰值 1.182 MiB、整文件反例 120.932 MiB。Node 22 完整验证使用隔离安装的 22.22.3、工作区 npm cache、系统 Chromium 和跨 worktree 共用锁 `/workspace/studyhub-tests/full-run.lock`；锁已实际取得。最终完整结果与精确 head 的双平台 CI 终态以 [PR #260](https://github.com/EricWang1358/dsh-web-studyhub/pull/260) 的验证跟进为准，不能将前述历史失败改写为初次通过。

原 `9400881` Ubuntu / Windows CI 均已通过（run 37396279431）；后续提交必须另核验精确 SHA，旧 head 绿灯不代表新提交通过。上述验证修复不放行 owner/controller 审定，也不使 S1→S6 总目标完成。


### 完整验证发现的测试环境问题

Node 22 的第一次全量检查完成：5,557 pass / 5 fail / 2 skip，501,947 ms，lint 通过；测试失败后该链路 build 未运行。两项 skip 仅为 Windows 文件共享锁测试，不是浏览器跳过。保留日志 `verify-node22-final.log`。五项失败及补验如下：

- `original-attach` 引用已有 perf helper，间接包含子进程调用，因此慢测试清单守卫要求注册到 cli 分类；已按规则登记，不修改守卫。`8588c15` 的 Ubuntu CI 也仅此一项失败（5,477 pass / 1 fail / 79 skip，run 37396873864），不将旧 head 成功当作当前通过。
- 独立安装的 Node 22 没有相邻 npm，而打包回归刻意清空 npm_execpath 以验证相邻查找。仅在私有 Node 目录安装 npm 11.9.0，未改变依赖清单或发布代码；打包回归补验通过。
- 系统 Chromium 的管理策略禁止 `file://`，三项 spine 浏览器测试因此失败。QA 夹具现以回环 HTTP 提供原有两份固定资源，包含禁用 localStorage 的场景；服务只绑定 127.0.0.1、随机端口并在退出时关闭，不更改浏览器策略。保持所有尺寸、导航、存储、键盘和动画断言。第一次补验 12 pass / 1 fail 暴露独立的 blocked-storage 导航仍用 file URL；补齐后 spine 三项全部通过、无 skip（`spine-http-final.log`）。

修复后重新运行精确提交的全量验证和双平台 CI；最终结果写入 PR #260 验证区，历史失败与补验收据保留。没有改动生产实现、放宽内存预算或绕过负责人门禁。
