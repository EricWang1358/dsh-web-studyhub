# S6-2：只删没有使用者的代码

核验日期：2026-10-07。分支 `codex/runtime-s62-dead`，基于 main（含 #333 S4-10）。工作包文本见 [U37](sprints-2-6.md#u37-s6-2)；前序：[S6-0](s6-0-coverage.md)、[S6-1](s6-1-compat.md)。

## 1. 范围与决定

每个迁移开关现在都默认关闭，所以"旧执行器"是今天的默认路径，关开关就是回滚。协调者决定（2026-10-07）：**S6-2 只删任何开关取值下都没有使用者的代码**，S6-0 §7 的"开关打开后不可达"那批整体删除**等默认值翻转之后**（真实模型抽样与 alpha 之后，S6-7；所有者已授权这两道关）。`lib/runtime/tasks.js`（扩展任务公开 API）保留。

"没有使用者"的证明是调用图，不是印象：`tests/helpers/dead-symbols.mjs` 对 `lib/` 的每个顶层声明回答"生产代码里有没有东西到达它"——自己文件里的引用、被导出时别的生产文件的导入、`import *`/`export *`；**不看开关取值**，所以只在开关关闭时才到的符号、只在开关打开时才到的符号都算"活"；反复计算到不再有新的死符号（只被死函数用的辅助函数也是死的）；测试不算使用者。

## 2. 删掉的（每项一个提交）

| 删除 | 为什么没有使用者 | 证据 |
|---|---|---|
| `lib/live.js` 的模块级课堂登记表 `export const { activeSession, registered, register, unregister, listSaved } = createLiveRegistry()` 里的前四个，以及它那个共享的 `Map` | 注释写的是"给独立的低层消费者的兼容"，没有任何消费者：音频上下文用自己注入的登记表（`createLiveRegistry` 仍在）。留下的 `listSaved` 变成 `listSavedFrom(root, new Map())`——登记表永远是空的，行为不变（测试用它列已保存的课堂） | 调用图；`live`、`live-correction`、`owned-work-services`、`audio-family-baseline-live`、`unified-runtime-live-save` 通过 |
| `lib/contexts/generation/jobs/checkpoint-ref.js` 的 `checkpointRefOf` | S3-2 的检查点引用；S3-3 以 `checkpointOf/checkpointHolds` 取代后只剩一个测试在用（连同那个测试用例一起删，`s3-2-step-identity.md` 里加了注记） | 调用图；`generation-input-ref` 通过 |
| `lib/mineru-job.js` 的 `PHASES` | 没有任何引用（界面有自己的 `CLOUD_PHASES`） | 调用图 |
| `lib/workflow-course.js` 的 `deckCourse` | 没有任何引用（课程树之前的一行辅助函数） | 调用图 |

## 3. 留下来的与理由

调用图在执行相关的文件里还找到 12 个"生产代码没人用"的符号，**不删**：它们是被测试钉住的词表或辅助函数（`JOB_STAGE_CODES`、`FAILURE_CODES`、`RUN_STATES`、`SHORTFALL_STATES`、`tokensPerSecond`、`ttftAverageMs`、`pruneRecords`、`splitWav`、`plainModel`、`extraQuestionDefault`、`sourceIdFromKey`、`listSaved`）。它们逐个写在 `tests/unified-runtime-legacy-delegation.test.mjs` 的 `KEPT` 里并附理由；以后**新增**一个死符号会让测试变红，要么删掉要么写理由——这是个棘轮，不是一次性清理。

`lib/` 其余部分（`case-study`、`course-active`、`inbox-kinds`、`quote-*`、`update-check` 等）也有类似的"只有测试用"的导出，与迁移无关，**不在本步范围**，也不在守卫的范围内。

## 4. 没有删的（等默认值翻转）

S6-0 §7 的整张表：旧转换/配置/索引后台运行、`startLegacy`、旧翻译卡运行、旧安装器的 `start/cancel`、进程内的讲解/骨架/总结/助教/备题/笔记起草分支、旧音频执行器及其重试、旧校正计时器与调用、`executeLiveSaveJob`。清单（`s1-7-legacy-exceptions.json`）里这些行的 `removeAt` 都改成了 `after default flip`，`tests/unified-runtime-architecture.test.mjs` 要求每一条 `delete-s6-2` 的行都是这个值。

## 5. 测试

`tests/unified-runtime-legacy-delegation.test.mjs`（3 条）：

1. 执行相关的文件里没有"没人到达"的符号，除了 `KEPT` 里有理由的那 12 个；`KEPT` 里的符号若已被用或已消失也要从表里拿掉。**红灯证据**：写测试时 `lib/workflow-course.js#deckCourse` 还在，这一条因它而红，删除后变绿。
2. 本步删的三样保持被删（`live.js` 的四个导出、`checkpointRefOf`、`PHASES`）。
3. 统一运行时的任务（`audioSubtitles` 为例）不在任何原始表里：没有取消控制器、没有重试占位、没有 `jobControls`；任务表里的行是内核的记录（`contractVersion: 2`）；`job.cancel` 经内核真的停止请求，`job.wait` 答 `cancelled`——公开的门委托内核，没有残留的执行旁路。

## 6. 本步没有做

- 没有删任何开关打开后才不可达的旧执行实现（等默认值翻转）。
- 没有拷贝实现到新文件来假装清理；没有动内核。
