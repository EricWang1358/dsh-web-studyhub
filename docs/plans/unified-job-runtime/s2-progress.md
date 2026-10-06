# S2 进度与交接（音频完整迁移）

> 负责人：Claude（内核负责人，2026-10-06 所有者授权自行合并合格 PR、落 main、开关默认关）。字段按 [sprints-2-6 交接字段](sprints-2-6.md#verification-contract)。完成只认已合并 PR。

| S | 状态 | 分支 / PR | 基线 SHA | 范围 | 验证 | 未确认 / 下一步 |
|---|---|---|---|---|---|---|
| S2-0a | 已合并 | `codex/runtime-s20-baseline` / #282 | `8d661f4` | 内核分层（零行为变化）、`limits.js`、布局护栏、[架构约定](s2-architecture.md) | verify 5875 / 5872 通过 / 0 失败 / 3 跳过；双平台 CI | — |
| S2-0 | 已合并 | `codex/runtime-s20-audio-baseline` / #283 | `8d661f4` | [音频基线与所有权表](s2-0-audio-baseline.md)、特征测试 | 新增 27 项；双平台 CI | 缺陷 D-1…D-12 由 S2-1…S2-6 消除 |
| S2-1a | PR 中 | `codex/runtime-s21a-kernel` / #287 | `fd5c5a1` | 观察到的失败为已知结果（只有 `sideEffect:true` 保持未知）、`context.persistence`、持久化夹具、开关矩阵工具 | 红灯 2 项 → 绿；定向 285/0 | — |
| S2-1 | 进行中 | `codex/runtime-s21-audio-import` | `fd5c5a1` + #287 | 单文件导入/重试完整接入（见下） | 见下 | S2-2 批次 |

## S2-1 记录

**改动**

- 试点 `lib/contexts/audio/pilot.js` 拆为 `lib/contexts/audio/jobs/`：`single-import.js`（定义，attempt 状态挂在 admission lease 上、端口经 `context.persistence`，不再写 bindings）、`single-view.js`（展示读取器与旧字段）、`single-notifications.js`（信箱/会话/输入清理）、`submit-single.js`（提交、恢复、重试入口，拒绝码转学习者文案）。
- `lib/audio-messages.js`：音频家族文案唯一来源（旧执行器、运行时、`audio-batch.js` 共用）；`audioRefusal()` 把 `input-changed`/`input-unavailable`/`not-retryable`/`attempt-active` 转成与旧路径一致的提示。
- `assertImportSettings()`（`lib/audio-settings.js`）：三处重复的导入设置检查收成一处；运行时 admit 也用当前设置检查（修复「移除密钥后重试，走到翻译才失败」）。
- 单文件任务保留的上传副本随任务文件夹一起移除（`keptUploadDir`、`retireAudioBatch`/`removeAudioBatch`），新旧路径共用；修复运行时任务关闭后上传副本残留。
- D-3：`job.control retry` 回包的 `attemptId` 指向新尝试（音频、出题、PDF 转换的重试共用）。

**开关矩阵**：`tests/audio-retry.runtime.test.mjs` 以运行时模式重跑整套 `audio-retry` 特征测试（`SWITCH_MODE`）。改动前运行时侧红灯 5 项：录音变化后报错码而非提示、宿主模型调用失败被判为远端未知而拒绝重试、旧字段缺失、移除密钥后重试未在入口拒绝、关闭失败卡片不清理上传副本。改动后两侧 25 通过 / 1 跳过（「宿主执行钩子」仅旧路径：运行时由网关启动子代理，见 `unified-runtime-gateway`）。逐请求清单在运行时侧来自控制台调用时间线 `contract.calls`，与旧 `tasks` 同为 4 次请求。

**新增测试**：`unified-runtime-audio-relink`（旧路径失败、开关打开后重启重试：转写与校对复用，只重做翻译与标题，同一文件夹改存运行时记录）、`audio-kept-upload`（上传副本引用校验与随任务移除）。

**去留**

| 字段 / 调用点 | 处置 |
|---|---|
| `pilot.js` 的 `binding.view/settings/pipeline/persistence/controlValues` 写入 | 移除；改为 lease `state` 与 `context.persistence` |
| 旧字段 `tasks` | 运行时不产生（调用进网关时间线），不再列入旧字段 |
| `preparedAudioSettings` / `operations.js prepare()` / 运行时 admit 三份检查 | 收成 `assertImportSettings` |
| 音频文案字面量（排队、读取、复用、已存、取消、重试拒绝、录音变化） | 收入 `lib/audio-messages.js` |
| `retryable` 内存占位（旧路径） | 保留至 S2-6 全部迁完；运行时任务不使用 |
