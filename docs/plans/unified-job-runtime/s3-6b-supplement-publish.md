# S3-6b：补题运行自己的发布（同一条看一眼、不重写的路）

> 前置：S3-6（发布草稿，`generationPublish`）。本步不新增开关：补题（`supplement`）的最后一步发布，在 `generationPublish` + `generation` 开着、任务又落盘（`generationRestart`）时，走 S3-6 的同一条路。

## 为什么

补题运行在执行器里自己做一次发布（把本次通过审阅的题并入目标题组），发布一写入，运行记下的草稿就被删了。S3-6 之前的情形：写入之后、任务完成之前进程退出，重启后

- 重试被拒（`checkpoint-invalid`：检查点草稿已经没了），任务永远报不出自己已经完成的结果；
- 写入之前退出、草稿已满额：重试也被拒（「草稿已达到请求的题数，无需补题」），只剩发布没做，却没有路可以只做发布。

## 做了什么

| 部件 | 位置 | 做什么 |
|---|---|---|
| 同一步 | `jobs/publish-step.js`（`publishDraft`，S3-6 的发布任务也用它） | 检查（复审走网关，记到 `repair` 特性）→ 计划落盘 → 提交（`commitArtifact`）写入；不落盘时直接写 |
| 补题运行的发布 | `operations.js` `publish()` | 落盘且开关开 → `publishDraft`（步键 `publish`，超时收尾用 `publish-budget`，两个计划、两个提交互不相干）；否则原来的一次调用 |
| 计划文件按步键 | `generation-run-store.js` | `<任务>.<步键>.json`；`reconcileCommit` 按提交的步键读对应的计划 |
| 检查点的解释 | 同上 `validateCheckpoint` | 检查点草稿没了、而本次运行计划过一次发布（计划文件说的是这份草稿）：不判无效，交给 `reconcileCommit` 看学习库定论（学习者删的草稿则被认出：`publish-draft-changed`） |
| 后一次 Attempt 做什么 | `supplement-resume.js` `taskFor` | ① 运行时已确认写入（提交完成，可能是看学习库得知）：只汇报结果（`recovered`、事件 `publish-recovered`、会话一次通知）；② 草稿已满额、还没发布：只发布；③ 其余：照旧从草稿接着做 |

## 证据

`tests/unified-runtime-supplement-publish.test.mjs`（2 条，红灯：改前两条都失败，原因见上）：写入后回执前崩溃 → 重试找到写入，题组与写入完全一致（共 3 题，没有第二次补题），不问任何模型，会话收到一次结果；写入前崩溃 → 重试只发布，题组 3 题。

## 仍未做

快速发布 + 批改（V4）：见 S3-7。
