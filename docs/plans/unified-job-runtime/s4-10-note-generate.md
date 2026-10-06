# S4-10：笔记 AI 起草（`note.generate`）接入统一运行时

核验日期：2026-10-07。分支 `codex/runtime-s410-note-generate`，基于 main（含 #326、#327）。来源：[S6-0 覆盖复核](s6-0-coverage.md) 发现 `note.generate` 是全开后仍在运行时之外的后台模型任务，所有者决定把它做成模型任务家族的新工作包 S4-10（开关 `noteGenerate`，默认关）。

## 1. 做了什么

| 文件 | 职责 |
|---|---|
| `lib/contexts/notes/note-generation.js` | 一次起草的**领域本体**（从 `note.generate` 里原样抽出）：问一次模型、检查、只在笔记仍是被要求起草的那一版时写回、否则不写；失败时让笔记自己说明。两种执行方式都跑这一份 |
| `lib/contexts/notes/jobs/note-generate.js` | 任务定义 `note-generate`：模型调用是网关 Step `note:1`（direct，feature `other`）；`initialPresentation` 让记录在 `submit` 返回时就是完整的 |
| `lib/contexts/notes/jobs/note-generate-view.js` | 展示读取器（标题＝笔记标题、阶段、`legacy: { noteId, generationId, written }`） |
| `lib/contexts/notes/jobs/submit-note-generate.js` | 开关的唯一读取点 `noteGenerateExecutor`：开关打开时先**提交 Job 再返回**，关闭时进程内运行同一份本体 |
| `lib/contexts/notes/jobs/messages.js` | 任务文案（英文在 `lib/application-messages-en.js`） |
| `lib/contexts/notes/operations.js` | `note.generate` 只剩校验、"生成中"记录、`pending` 登记（沿用每日总结已有的 `pendingGeneration`：保存、删除、卸载仍靠 `pending.controller.abort` 停止它）和一次 `startDraft` |
| `lib/runtime-config.js`、`lib/runtime/builtins.js` | `noteGenerate` 开关一行；定义登记在 `notes` 行 |

## 2. 行为（两侧一致，除了"是不是 Job"）

| 情形 | 进程内（开关关） | 运行时（开关开） |
|---|---|---|
| 正常 | 笔记写回、`generation.status: done`、信箱一封"笔记草稿已生成" | 同；另有一个 Job 行（控制台可见）、一个 Call `note:1`、用量记一次（feature `other`） |
| 起草期间笔记被保存 | 不写回，笔记状态 `superseded` | 同；Job 完成但结果 `partial`（没有写入），卡片说"这次没有写入笔记" |
| 删除笔记 | 停止请求，不写回 | 停止请求并取消 Job（`cancelling` → `cancelled`），不写回 |
| 模型失败 | 笔记 `generation.status: failed` + 原因 | 同；Job `failed` 带同一原因 |
| 起草期间再点一次 | 已有一个在跑，返回 `running` | 同；仍只有一个 Job、一次模型调用 |
| 没有可用执行器 | — | 笔记 `failed`，原因"后台执行器暂时不可用，请稍后再试"；没有 Job，模型没被问 |

能力（诚实）：`cancel` 是；不可暂停；`recoveryMode: none`（重启后笔记停在"生成中"之前就是这样，与进程内相同——保存或再点一次起草即可）；`retry`／`set` 否。

## 3. DSH 能力行

DSH-01（唯一执行责任层：模型调用只经 `context.gateway.step`）、DSH-03（取消：保存、删除、卸载都能停止请求）、DSH-07（用量：feature `other`，一次一条，不记 0）。无新增自写能力。

## 4. 保留或迁移

| 对象 | 去留 |
|---|---|
| 起草本体、笔记修订保护、写回时的信箱信 | 保留（`note-generation.js`，两种方式共用） |
| `noteJobs` 里的 `pending`（保存/删除/卸载的停止入口） | 保留（原先是 Promise＋controller，现在与每日总结同一个 `pendingGeneration`） |
| 进程内执行 | 开关关闭时使用；S6-2 删除 |

## 5. 作为 S6-4 的证据：新增一种任务的改动范围

不改内核：`lib/jobs/**` **零改动**。全部改动只在笔记家族与一行登记：

- 新文件 5 个（`note-generation.js` 与 `jobs/` 下 4 个）；
- 改动：`lib/runtime-config.js`（开关 1 行）、`lib/runtime/builtins.js`（import 1 行＋`notes` 行 1 处）、`lib/contexts/notes/operations.js`（`note.generate` 变薄）、`lib/application-messages-en.js`（5 条英文）；
- 没有新的内核能力：`initialPresentation`、`context.gateway.step`、`notifications`（本任务不需要）都是已有的。

## 6. 测试

- `tests/blog-notes.test.mjs` 的两个起草用例读 `SWITCH_MODE`，由孪生 `tests/blog-notes.runtime.test.mjs` 在运行时一侧重跑（断言不变）；
- `tests/unified-runtime-note-generate.test.mjs`（5 条）：一个起草＝一个 Job（`submit` 返回即完整、Call、结果、用量一次）、重复启动、删除时取消、失败与被保存覆盖、没有执行器；
- 先红：该文件在实现前 5 条全部失败（没有 Job）。
