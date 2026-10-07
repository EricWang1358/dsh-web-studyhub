# S2–S6 收尾与下一位负责人交接

本文交接统一任务运行时 S2-0…S6-7 之后的状态。工作包逐项对应的 PR 与合并 SHA、例外清单、不支持的能力、完整 verify 记录都在 [S6-7 验收](s6-7-acceptance.md)，这里不重复，只写接手要知道的东西。

## 1. 现在在哪

- **代码**：S2-0…S6-6 与 S6-7 的验收记录全部在 `main`。所有迁移都在 23 个默认关闭的开关后面（`MIGRATION_SWITCHES`，`lib/runtime-config.js`），所以用户装到的行为仍是旧路径，与 2.7.1 一致。
- **验收**：[s6-7-acceptance.md](s6-7-acceptance.md)（#359）。完整 `npm run verify` 全绿：6857 个测试，6845 通过、0 失败、12 跳过，lint 与构建通过。真实宿主证据见 [s6-7-host-evidence.md](s6-7-host-evidence.md)（#361）：隔离的 DSH 0.2.0-rc.2，23 个开关全开，非模型路径 18/18，控制台浏览器测试开关全关、全开各 54/54。
- **没有发布**：没有任何 commit 被记成 alpha 或已发布。

## 2. 架构：改一个任务或加一个任务时去哪里

约定的全文在 [s2-architecture.md](s2-architecture.md)。最短的路线：

| 要做的事 | 位置 |
|---|---|
| 内核（Job / Attempt / Step / Call、生命周期、恢复、结算） | `lib/jobs/`，生命周期拆在 `lib/jobs/lifecycle/*`，由 `lib/jobs/lifecycle.js` 组装；上限集中在 `lib/jobs/limits.js` |
| 一种任务的定义 | `lib/contexts/<家族>/jobs/<kind>.js`，配套 view、notifications、submit 入口，用户可见的话只放在该家族的 messages 模块 |
| 注册定义 | `lib/runtime/builtins.js` 的 `managedDefinitions` 表，每行一个 |
| 开关 | `MIGRATION_SWITCHES` 加一行，默认 `false` |
| 模型调用 | 只经 `context.gateway.step(key, policy, …).complete()`；非模型的外部工作用 `gateway.observe({ boundary, sideEffect })` |
| 结果通知 | 定义上的 `notifications` sink；持久化的任务由 `persistence.open` 的闭包给出 notifier，两边的 channel 与幂等性必须一致（`lib/jobs/notices.js`） |
| 新增普通任务不改内核的证明 | S6-4，`tests/unified-runtime-new-kind.test.mjs` |

**不能破的规则**（每条都有护栏测试）：

- 文件 ≤200 行、行 ≤181 字符、内核只向内 import、`lib/jobs` 里没有用户可见文字：`tests/unified-runtime-layout.test.mjs`。
- 每个模型调用点与任务起点都在清单里：`tests/unified-runtime-architecture.test.mjs` 对照 [s1-7-legacy-exceptions.json](s1-7-legacy-exceptions.json)。"待迁移"行现在是 0；新增调用点必须走 gateway，或者在清单里写明理由与责任人。
- **不要给持久化的内核记录加字段**（store 外壳、intents、commits、封闭的 contract 记录）。2.7.1 的校验器是封闭的，加字段会让回退后的旧版拒绝整个库。`tests/fixtures/release-2.7.1/` 里有原样复制的旧校验器，回退形状测试会抓到。
- 有副作用的请求才写 intent；没有副作用的请求崩溃后直接重问。
- 每个开关有双跑：`<suite>.runtime.test.mjs` 设 `STUDY_RUNTIME_SWITCH=runtime`，辅助在 `tests/helpers/runtime-switch.mjs`。
- 启动子进程、浏览器或 ffmpeg 的测试要登记在 `tests/slow-tests.json`。

## 3. 待办（按优先级）

### 3.1 需要所有者决定或授权

1. **真实模型质量抽检**：在临时库里做，不用所有者的库或 `~/.dsh`，小样本、写明预算。范围与要记录的数字见验收 §8。
2. **`npm run qa:dsh`**：宿主是 React 18，预览打包的是 React 19，alpha 前要在真实宿主里看一眼。
3. **alpha 版本与发布**：按发布流程，从 `codex/studyhub-<版本>` 开 PR、所有者合并、在 main 上打包、`gh release create` 带同样 11 个附件，标为预发布。
4. **默认值翻转**：决定哪些开关改成默认开。翻转之后才能删清单里 21 处 `delete-s6-2` 的旧路径。S6-2 只删了两个开关值下都已经死掉的代码。
5. 旧的待定决定：翻译、总结、助手的用量分桶（S4-1 G4），超时结束的原因（G3）。

### 3.2 开着的工程项

1. **控制台详情按任务种类说话**（S6-7 宿主截图发现）。#362 已经让每种音频任务有自己的名字，但详情面板仍按"音频转写"家族说话，共三处：
   - 请求行写「还没有向转写服务发请求」，字幕导入根本不调转写服务；
   - 并行时间线的图例（转写/校对/翻译）；
   - 文件面板的三条阶段条，课堂校正不该有文件页。

   前两处的修改与先失败的测试在分支 `codex/runtime-s67c-audio-detail-wip`（叠在 #362 上，未开 PR，护栏没有重跑）；第三处没做。#362 合并后把这个分支并上 main，补上第三处，跑控制台 UI、浏览器、英文与 locale-key、layout、slow-list 测试后开 PR。
2. **只有音频与 PDF 有控制台回归矩阵**（S6-5）。出题、翻译、每日总结、学习流、助手等家族还没有同样的逐状态矩阵。D 道做到一半就中断了：分支 `codex/runtime-s65-console-nonaudio`（未开 PR，基于较旧的 main）里有 5 个辅助文件（`tests/helpers/console-families*.mjs`、`console-fields.mjs`、`nonmodel-library.mjs`），还有 `unified-runtime-nonmodel-family.test.mjs` 改用这些辅助后的版本；矩阵测试文件本身还没写，也没跑过。接着做时先并入最新 main，再参照 [s6-5-audio-console.md](s6-5-audio-console.md) 与 `tests/unified-runtime-audio-console.test.mjs` 的写法。
3. **宿主里没跑过的路径**（理由见宿主证据 §7）：所有模型路径、复查、检索索引构建、PDF 本地转换、Marker 安装、MinerU 安装配置、云端 PDF、宿主内的重启恢复、150% 缩放。
4. **内核后续**：
   - 调用历史没有上限（S2-5b 一次实测 180 个调用约 165 KB），应改成有界历史加合计；
   - 恢复时 preflight 对每个批次成员算哈希，大批次时较慢；
   - 可重试的状态集合应能按定义配置；
   - `KILL_WAIT_MS` 需要一个进程存活的见证。
5. **已知限制，按设计保留**：课堂校正对 20 秒没有回应的模型放弃这一轮（`RollingCorrection` 的 `requestMs`）。读到更新版本写的任务归档时当成空归档（#360），只在从未来版本回退时出现。`mineru.local.status` 会只读地运行一次本机已装的 mineru 来取版本号（宿主证据 F-3）。

## 4. 工作方式与安全约束

- 不碰所有者的库、`~/.dsh`、`~/.mineru` 和任何密钥。跑测试前清掉所有 `*_API_KEY`、`*_TOKEN`、`*BASE_URL` 变量，用私有 `TEMP`/`TMP`，设 `SSH_TTY=audit`。没有授权不做真实模型、联网安装、pip、MinerU 或 Marker 调用。
- 一个工作包一个 PR，从最新 `main` 开分支；合并前两个平台的 CI 都要绿。合并用 `gh pr merge --merge`，不 rebase，不 force-push。
- 盘点全仓库的 PR（护栏、例外清单）合并前要先并入最新 main，合完后在 main 上重跑护栏。并入 main 之后用 `git diff --stat origin/main` 确认只剩本 PR 的文件：曾有分支在并入时把 main 已删除的代码悄悄带回来。
- Windows 上：文件混有 CRLF 与 LF，按字节改；git 的 stash 栈在所有 worktree 之间共用，不要用裸 `git stash`，要搁置改动就提交一个临时 WIP commit；回退演练用 `tests/fixtures/extract-release.mjs` 只靠 git 解出 v2.7.1（#357），不再依赖系统 tar。
- 只在一个平台失败的测试，先加日志拿到证据再修。#343 的 revision-conflict 就是靠日志找到的：runtime 的 `dispose()` 没有等还在写的记录，现在由 `stopWhere` 排空每个 durable 队列。冲突日志保留在 `durability.preflight` 与 `store.save` 里。
- 完整验证：`npm run verify`（lint、完整测试、构建），持机器锁，不能缩小测试范围冒充全绿。

## 5. 清理

- `.claude/worktrees/` 下的 `agent-*` 与 `runtime-s2` 是这轮各道与协调者的 worktree，里面没有未推送的工作（交接时逐个查过：没有未提交的改动，也没有领先远端的提交）。两个做到一半的工作已经作为 WIP 分支推到远端，见 §3.2 的第 1、2 条。可以用 `git worktree remove`（不加 `--force`）逐个删掉，删之前先看一眼 `git status`。
- 已合并的 `codex/runtime-*` 远端分支可以删除。
