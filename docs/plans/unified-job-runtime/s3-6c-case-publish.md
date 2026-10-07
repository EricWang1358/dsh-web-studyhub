# S3-6c：案例快速发布 + 批改（V4）

> 前置：S3-6（发布草稿）、S3-6b（补题自己的发布）。不新增开关（`generationPublish` + `generationRestart`，需要 `generation`）；不改内核，不新增任何持久字段。

## 问题

贴入带答案的案例（`generate { kind: 'case', answers }`）在运行结束时：`draft.publish.quick` 把草稿变成案例题组（草稿随即被删），再对每个有答案的题逐个 `card.grade`（模型按评分标准批改）。写入之后、批改做完之前进程退出，重启后重试被拒（`checkpoint-invalid`——检查点草稿已被发布删掉），任务永远报不出结果；批改没有回执，没有办法知道哪几题改过了。

## 做了什么

| 部件 | 位置 | 做什么 |
|---|---|---|
| 快速发布走同一条路 | `jobs/publish-step.js`（`quick`）、authoring 的 `draft.publish.plan { quick: true }` | 检查 = 在私有副本上做一遍 `draft.publish.quick`（没有复审、没有决定）；计划落盘（步键 `publish-quick`）；写入是内核提交；崩溃后 `reconcileCommit` 对着学习库看（题卡指纹 = 写入后的样子） |
| 每次批改由它的 attempt 认出 | `case-publish.js` `gradeRemaining` | 先看库里有没有「同一题、同一答案」的 rubric attempt，有就跳过、不再问模型；没有才 `card.grade`。批改本身不变 |
| 后一次 Attempt | `case-publish.js` `createCaseResume` | ① 运行时已确认写入（提交完成，可能是看学习库得知）：只补批改剩下的；② 草稿已满额、还没发布：发布并批改；③ 其余照旧 |
| 检查点的解释 | `generation-run-store.js` `validateCheckpoint`（S3-6b） | 草稿没了而本次运行计划过一次发布：不判无效，交给 `reconcileCommit` 定论 |

不落盘（没有 `generationRestart`）或开关关：原来的内联代码一字不变。

## 证据

`tests/unified-runtime-case-publish.test.mjs`（2 条；红灯：改前重试被拒 `checkpoint-invalid`）：

1. 发布后、第一次批改时进程退出 → 重试不再导入案例（案例题组仍是 1 个，没有草稿），两道答案各批改一次（rubric attempt 恰好一道一条），任务完成、`graded: 2`；
2. 写入后、进程还没知道时退出 → 重试看一眼找到写入（`recovered`），不导入第二次，两道答案各批改一次。

`wp12-case-generation` 全绿（开关关与 `generationPublishRestart` 矩阵）。

## 仍未做

通知走定义的结算通知（S6-5）。
