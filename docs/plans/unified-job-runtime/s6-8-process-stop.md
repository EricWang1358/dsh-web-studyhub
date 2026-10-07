# S6-8：本地进程停止确认

## 接手与范围

2026-10-07，Codex 在 `codex/runtime-stop-witness` 接手，基线 `4d04f751112d30387f295d1e590771931fe557d1`。内核负责人负责最终集成验证与提交；本工作包修改 `lib/local-command.js`、其专属测试、慢测试清单登记、音频控制台测试的快照读取及本文。来源是 [S6 交接 §3.2.4](s6-handoff.md#32-开着的工程项) 的停止见证缺口。本文记录实施证据，尚不是合并或 3.0.0 发布声明。

## 缺陷与最小修复

原来的 `KILL_WAIT_MS` 会在请求停止 10 秒后无条件拒绝 Promise。进程仍运行、无法发送终止信号或停止结果未知时，调用者却已经执行 `finally`：Marker 释放安装目录占用、PDF 释放转换许可，或 MinerU 配置显示终态，随后允许新操作进入同一资源。运行过的子进程发出 `error` 时，也可能是信号发送失败，不能当作退出证明。Windows 上 `taskkill` 启动失败后的 `child.kill()` 同步异常原先会逃逸事件回调。

修复删除按时间强行结算，复用 Node 的子进程 `close` 事件确认该子进程退出及 stdio 关闭。取消/超时继续请求整棵进程树停止，保留最早停止原因；未收到确认时 Promise 保持未结，已有调用者继续持有资源。运行过的子进程 `error` 进入相同停止流程，已经停止中的错误不覆盖原原因。没有 PID 的 spawn 失败、同步 spawn 失败照常立即拒绝。Windows fallback 的信号异常被捕获，但不伪装成退出。

`runLocalCommand` 签名、正常 `{ code, stdout, stderr }` 结果、正常取消原因、超时错误码不变。不新增接口、队列、生命周期、轮询、重试、默认开关或持久字段。新旧调用路径共用这一适配，因此都修复同一缺陷；不以开关保留明知会提前释放资源的错误。

## DSH 与调用链依据

引用 [DSH 能力表](s1-0-dsh-capabilities.md) DSH-01、DSH-03（审计目标 DSH 0.2.0-rc.2、cordis 4.0.4；P01/P02/P05、R01/R02/R03）：宿主生命周期和停止请求仍走原入口，停止回执不能代替真实占用释放。本次仅修复原有 Node 本地命令薄适配，不根据尚未核验的宿主能力自建替代服务，不把 DSH owner 的 `executorWitness` 当作 CLI 子进程身份。

已检查两层调用：

- `marker-install.js` 的 `begin → observe → runLocalCommand`，只有命令结算后才走终态持久化与 `live.delete`；`marker-local.js` 的解析输出目录清理同样等待命令返回。
- `mineru-setup.js → mineru-local.js/runCli → runLocalCommand`；旧 `legacy-setup-run.js` 等待后才写终态，统一运行时 `mineru-setup-job.js` 也等待相同 `runSetup`。
- `mineru-local.js/parseWindow` 和 Marker 的本地解析，经 PDF 转换调用；旧 `convert.js` 的许可释放在等待完成的 `finally`，统一运行时沿用本地命令等待，不新增结算者。

## 验证证据

先在原生产代码上增加受控 Node 子进程、假时钟测试，运行官方 `scripts/test.mjs`：8 项中 4 通过、4 失败。失败分别证明旧 deadline 提前释放、Windows fallback 异常逃逸、超时提前释放、运行中 error 提前释放。红灯日志：`output/verification/stop-red.log`（工作树内忽略的本地证据）。

实现后最终运行 `scripts/test.mjs tests/local-command.test.mjs tests/unified-runtime-nonmodel-recovery.test.mjs`：21/21 通过，0 失败、0 跳过；日志 `output/verification/stop-green.log`。其中 10 项命令测试覆盖真实子进程正常取消/超时、迟到与提前取消、拒绝/抛错的 kill、超过旧 deadline 仍占用、重复取消/close 仅结算一次、保留原停止原因、未启动与真实缺失程序不挂起、同步 spawn 失败；原有 11 项恢复测试保持通过，包含 Marker/MinerU/PDF 停止未确认期间的资源占用断言。

focused ESLint 和 `git diff --check` 通过。测试使用工作树私有 TEMP/TMP、DSH_HOME、`SSH_TTY=audit`，官方入口清理继承凭据并保留机器锁。未调用模型、真实安装程序或用户学习库；测试没有新增生产注入 API。全量守卫识别到已有真实进程用例的专属测试尚未登记，将 `tests/local-command.test.mjs` 按序补入 `tests/slow-tests.json` 的 CLI 清单。

负责人质量检查首轮 `npm run verify`：lint 通过，7029 项中 7013 通过、4 失败、12 跳过，耗时 1879 秒；测试失败使 build 未执行。日志 `output/verification/stop-full-verify.log`。四项失败是慢测试登记守卫、音频池结束清理目录的 `ENOTEMPTY`、音频控制台开/混合模式等待终态超时。保留原失败记录，不以此前分支的全绿结果代替本轮证据。

补登记后，原样串行复测 `audio-pool`、`unified-runtime-audio-console`、`slow-tests-list`、`local-command`、`unified-runtime-nonmodel-recovery` 五文件：46/46 通过，0 失败、0 跳过，耗时 251 秒；日志 `output/verification/stop-isolated-recheck.log`。当时三项音频用例未修改代码、断言或超时。后续混合模式再次超时，故不能将首轮音频失败全部归为一次性负载。

三次后续全量尝试均未完成，不计作完整结果：12 并发重跑按负责人要求停止（`stop-full-verify-recheck.log`）；4 并发首次使用的私有临时目录过长，在 Windows 触发 Marker 的 `ENAMETOOLONG`，停止并将测试包装器临时目录缩短（`stop-full-concurrency4.log`）；短目录轮次 lint 通过，测试最后输出到 2423，观察到音频混合模式终态超时及导航高亮缺失两项失败后，按负责人指示停止旧树测试以统一集成修复（`stop-full-concurrency4-short-temp.log`）。这些日志均位于 `output/verification/`，保留失败和中断原因；build 未执行。导航高亮由另一个工作包修复，不在本次改动内。

首轮 12 项跳过包括：8 项音频批处理运行中崩溃恢复场景由专属统一运行时测试覆盖；1 项旧宿主子代理路由由模型网关测试替代；2 项 Windows 不支持的信号处理假设；1 项缺少符号链接权限。没有为取得绿灯增加跳过。

## 音频测试读取修复与最终质量检查

`unified-runtime-audio-console.test.mjs` 的混合模式每轮对 11 个任务分别调用 `cardOf`，每次都会重新读取完整真实快照。这使一轮并行产生 11 次完整快照，并拖慢等待中的任务。修复仅将一轮改为读取 1 次真实 `snapshot`，再按原来 11 个 ID 查找任务；诊断文本也复用同样的读取方式。保留所有数量、ID、终态、控制和归档断言，保留 `trickle(4)`、300 秒超时、250 毫秒轮询。缺失任务仍会失败，不使用模拟快照替代真实读取。

同规模受控测量日志 `output/verification/console-snapshot-cost-complete.log`：1/1 通过，11 个任务的一次观察从 11 次快照、1513 毫秒变为 1 次快照、128 毫秒；这是单次机制测量，不是稳定性能保证。测量脚本只作为忽略的本地证据，没有新增镜像测试。

最终串行运行 `unified-runtime-audio-console`、`local-command`、`unified-runtime-nonmodel-recovery`、`slow-tests-list` 四文件：38/38 通过，0 失败、0 取消、0 跳过，耗时 263.237 秒；日志 `output/verification/stop-final-focused.log`。其中音频开模式耗时 38.493 秒、混合模式 60.747 秒。最终 `npm run lint` 通过（`output/verification/stop-final-lint.log`），`git diff --check` 通过。此次定向结果不代表完整仓库验证通过。

已实际执行 `ce-simplify-code` 的复用、质量、效率三项独立检查，无建议改动。最终四个代码/测试文件实际执行 `ce-code-review mode:agent base:4d04f751112d30387f295d1e590771931fe557d1 plan:docs/plans/unified-job-runtime/s6-8-process-stop.md` 的 focused 审查：正确性检查及独立 adversarial 读取均无代码发现。独立读取使用本地同模型族上下文；外部代码发送曾被自动审批拒绝，未重试。最终独立审查者曾建议快照方向，因此不是盲审，也不声称跨模型审查。机器可读回执：`C:/Users/Eric1/AppData/Local/Temp/compound-engineering-Eric1/ce-code-review/20261007-stop-final/review.json`。

审查完成不等于发布门禁通过：本工作包尚无最终全量绿灯，最终整合后的 literal `npm run verify`、build 及 Windows/Ubuntu CI 由负责人统一执行。回执保留这一限制，禁止引用旧分支或定向结果替代。

## 边界与回退

- 无法证实停止的进程会保持占用，可能一直显示正在停止；这是保留资源安全性的选择，不再用 10 秒制造已停止的结果。
- `close` 证明被启动的直接子进程退出和 stdio 关闭。主动脱离进程组、关闭继承 stdio 后继续运行的后代进程，不在本次证据范围；没有新增跨平台 OS 级进程树见证。
- 本次不解决宿主整体崩溃/重启之后的 CLI 身份和存活识别，不将相同 PID 当成同一进程，不声称真实安装或真实宿主验收完成。
- 无持久格式变化，2.7.1 回退读形状不受影响。撤销本修复会恢复提前释放缺陷，不推荐用代码回退解除一个未确认的占用。

下一步：负责人精确提交本工作包、整合其他已验证修复后统一完整验证及两平台 CI；停止见证的跨宿主恢复/后代进程扩展如需新公共契约或持久形状，应另做契约评审，不在这份缺陷修复中混入。
