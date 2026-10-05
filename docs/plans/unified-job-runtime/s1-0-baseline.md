# S1-0：2.6.0 基线与验证记录

核验日期：2026-10-05（Asia/Shanghai）。负责人：Codex 集成负责人；分支：`codex/unified-runtime-alpha`。本步仅增加审计文档、旧行为特征测试及 fixture，不修改生产代码。用户已指定最终交付为独立 alpha，与正式版本并行开发；本记录不是 alpha 实现完成声明。

## 发布与 P0

| 项目 | 证据 |
|---|---|
| 插件发布 | [v2.6.0](https://github.com/EricWang1358/dsh-web-studyhub/releases/tag/v2.6.0)，发布时间 2026-10-05 07:43:57 UTC |
| P0 合并 | [PR #239](https://github.com/EricWang1358/dsh-web-studyhub/pull/239)，merge SHA `60023a11c5baf2fdcae6e8ff8af9376ee94b0368` |
| 发布合并 / main 基线 | [PR #240](https://github.com/EricWang1358/dsh-web-studyhub/pull/240)，`aa0259254bcd587128e583070599a804485c7d06`；package 与 lock 根版本 2.6.0 |
| 公共契约 | [docs/job-contract.md](../../job-contract.md) 与 `lib/job-contract.js` 实际 contractVersion 1；单文件 logical jobId 与 attemptId 分开 |
| P0 CI | #239 的 [Windows](https://github.com/EricWang1358/dsh-web-studyhub/actions/runs/37277987931/job/111659228492) 与 [Ubuntu](https://github.com/EricWang1358/dsh-web-studyhub/actions/runs/37277987931/job/111659228206) 验证成功 |
| P0 控制台记录 | #239 描述记录 zh 深色 1280/420、en 浅色 1280 的 journey、任务控制台 CLS 0 和浏览器测试；这是该 PR 的交付证据，不能冒充本轮重跑。完整 100%/150% 缩放、真实模型抽检仍未验证 |
| 本轮宿主验证 | 见下文；独立 rc.2、私有 DSH_HOME、fake model；不读取用户配置与学习库 |

源码审计起点为 #239 head `e024513bb54b1ea0f11de23dac93733c4099e019`；到 main 基线的差异只有版本与发布文档，`lib/**`、契约、旧测试实现没有变化。详细审计链接保持固定 SHA；后续基线变化需重新核对。

## 文件与环境

- 审计：[DSH 能力表](s1-0-dsh-capabilities.md)、[任务服务与资源/字段所有权](s1-0-runtime-audit.md)、[单文件音频行为清单](s1-0-audio-behavior.md)。
- 特征测试：`tests/audio-single-characterization.test.mjs`；fixture：`tests/fixtures/audio-single-characterization-process.mjs`；已登记 `tests/slow-tests.json` cli 组。
- Node 22.22.3、npm 10.9.8；自有依赖通过 `npm ci --legacy-peer-deps` 安装。实际包版本与 lock/source hash 在 DSH 能力表逐项记录。
- DSH CLI 0.2.0-rc.2 隔离安装于 `output/runtime-s10/dsh-cli`；项目开发依赖 rc.1 与 peer rc.2 的差异保留在能力表，未在本步更改依赖。
- 清除所有 `*_API_KEY`、`*_TOKEN`、`*BASE_URL`；TEMP/TMP 与 DSH_HOME 在隔离工作树下；SSH_TTY=audit。测试通过仓库 runner 的网络隔离，不发真实模型请求。
- 原检出目录的未提交改动保持原状。原始运行日志在忽略目录 `output/runtime-s10/`；仓库保存下列命令、结果与故障记录，不提交用户数据或模型原始输出。

## 已执行验证

| 验证 | 命令 / 基线 | 结果与日志 |
|---|---|---|
| 旧路径定向基线 | E024：`node scripts/test.mjs --test-concurrency=4` 后接下列 10 文件 | 92 pass / 0 fail / 0 skip；39054 ms；0 外部连接尝试（10 processes）；`baseline-tests.log` |
| 新特征测试 | AA02592：`node scripts/test.mjs --test-concurrency=1 tests/audio-single-characterization.test.mjs` | 2 pass / 0 fail；4161 ms；0 外部连接尝试（1 process）；`characterization-tests.log` |
| 简化后特征复验 | AA02592：`node scripts/test.mjs --test-concurrency=1 tests/audio-single-characterization.test.mjs` | 2 pass / 0 fail；4865 ms；`characterization-final.log` |
| 失败项隔离复跑 | AA02592：`node scripts/test.mjs --test-concurrency=1 tests/marker-install-service.test.mjs tests/test-runner-lock.test.mjs` | 13 pass / 0 fail / 2 Windows skip；10088 ms；`recheck-baseline-tests.log` |
| 完整验证复跑 | AA02592 + 本步新增测试：`npm run verify`；关闭可选 STUDY_TEST_NETWORK_REPORT | lint、4935 pass / 0 fail / 2 Windows skip、build 均通过；测试 204354 ms；`verify-clean.log` |
| rc.2 隔离包探针 | AA02592：`node --import ./scripts/qa/test-network.mjs ./output/runtime-s10/probe-dsh.mjs` | jobs wait 不取消、读取输出、kill 幂等、cancel 回调与 settled 事件各一次；4 个带锁并发写后计数 4；`dsh-probe.log` |
| 宿主报告路径边界 | 对实际 fixture 入口传入 25 个冲突路径（私有资源、SDK、QA 外路径、Windows junction 与大小写别名） | 均在导入 driver 前拒绝；私有 profile 与 SDK 未变；`host-path-boundary.log` |
| 最终 fixture 静态检查 | AA02592 + 本步全部文件：`npm run lint` | 通过；`final-lint.log` |
| 仓库路径宿主复验 | `node tests/fixtures/runtime-s10/run-host-probe.mjs --repo <worktree> --dsh-bin <isolated rc.2 lib/bin.js> --out <worktree>/output/qa/host-s10-final --variant official-jobs-preset --port 3491 --model-port 4495 --lang zh` | 5 步通过 / 4 fake requests / 0 page或console errors；cleanup一次；`host-capability-final.log` 与 `output/qa/host-s10-final/summary.json` |

完整 verify 在新增 manual host fixtures 前通过；该三份文件加入后，最终 lint 与仓库路径手动宿主复验通过。自动测试与生产实现未再次变化，未重复全量测试。

定向基线的 10 文件：audio-concurrency、host-ownership、audio-pool、audio-pool-adaptive、audio-batch、audio-retry、audio-ledger、job-contract、job-control-audio、job-output-audio（均 `tests/<name>.test.mjs`）。新增用例锁定观察者 wait 超时与进程中断后的显式重试，保留旧 single manifest、稳定 logical ID、新 attempt、无自动出题、原请求顺序与用量/通知断言。

### 首次完整检查的失败与处理

首次 `npm run verify`：4933 pass / 2 fail / 2 skip，245672 ms，`verify.log`。

1. `test-runner-lock` 要求子进程 stderr 为空；可选 STUDY_TEST_NETWORK_REPORT=1 添加“0 connections blocked”报告，导致该旧断言失败。复跑仅关闭额外报告变量，网络隔离仍开启，未改测试或生产源码。
2. `marker-install-service` 在 marker.json 替换时发生 EPERM。单独复跑和完整复跑均通过，未能稳定复现；记录为 Windows 瞬时文件替换风险，不宣称已修复。该模块在本步没有改动。

首次运行的 21 次外部连接尝试被 runner 阻断（561 processes）。这个计数包含仓库网络隔离测试主动产生的请求，不能解释为实际网络请求已发出；相关音频定向测试计数为零。

## 宿主核验与门禁

实际宿主能力来源：[manual fixtures](../../../tests/fixtures/runtime-s10/README.md)，使用私有既有 web profile 与安装的官方 rc.2 SDK。

| 场景 | 结果 |
|---|---|
| preset-free 真实 agent | parent/session、stream/usage、effort 拒绝、one-shot child 与清理通过；owned job 明确拒绝（无 controller），结果保留于 output/qa/host-s10 |
| 显式官方 jobs-only preset | 5 步全部通过；4 次本机 fake requests；页面/控制台错误 0；owner 隔离、wait 不取消、kill/settled 各一次、owner dispose 收尾；output/qa/host-s10-jobs-preset |
| 纯安装包原语 | scope 独立/重复 dispose、schemastery required/default/version、timeout 上游 abort/上限/非法值通过；output/runtime-s10/primitive-probe.json |

裸 agent 不会自动组合 standard preset；实际 web session controller 会显式挂载它。第二场景是明确加装的官方测试组合，不能冒充所有默认会话都可用，也不批准手写替代任务层。范围和未测项见 [DSH 审计](s1-0-dsh-capabilities.md#实际-rc2-web-宿主的补充核验)。


隔离包探针没有合法 session owner，不能证明实际插件 scope、owner 隔离或 UI 导航；生产中不能用 unowned job 绕过边界。实际 rc.2 宿主验证已完成本地打包、安装、创建私有 web profile、启动与打开 StudyHub 学习库（页面与控制台错误均为零）。随后 first-message 驱动误选隐藏的会话搜索 input，超时退出；模型调用与子代理核验因此未完成，不能把启动成功记为完整宿主能力通过。原始 summary 与截图在 `output/runtime-s10/host-e2e/`，随后运行上述能力探针；原流程的隐藏搜索框选择失败保留，不把该流程记为全部通过。能力表尚待核验的试点依赖项继续阻断对应步骤，不以源码存在或 fake provider 成功代替。

## 评审接受与合并

S1-0 状态：已验收合并。所有者在本轮明确接受已验证范围及待核验限制，并授权仅合并 [PR #241](https://github.com/EricWang1358/dsh-web-studyhub/pull/241)、继续独立 alpha 的 S1-1；后续契约仍单独评审。#241 于 2026-10-05 09:27:34 UTC 合并，head 为 `6b1ecedb69308ec44078f10c24975eb2a6a2aef7`，merge 为 `f091f09f830c226bfebc9af22344896733893a10`。

该 head 的独立原生审查完成且无剩余发现；[远端 CI](https://github.com/EricWang1358/dsh-web-studyhub/actions/runs/37288514589) 的 Windows 与 Ubuntu 检查均成功。审查范围为本步文档、测试与探针，不是 alpha 生产实现。

S1-1 以该 merge 为基线先提交契约及可执行 fixture。StudyHub 生产 fiber/owner/controller 的最终绑定、真实停止与恢复故障窗口、计量和 UI 导航等未确认项仍保留为对应实现步骤的门禁；所有者接受审计不等于这些能力已通过。alpha 试点尚未实现，开关默认关闭；正式版本继续沿 main 维护。
