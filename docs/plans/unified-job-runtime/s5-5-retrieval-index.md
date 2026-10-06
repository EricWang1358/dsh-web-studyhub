# S5-5：检索索引后台构建接入

核验日期：2026-10-06。分支 `codex/runtime-s55-retrieval-index`，基线 origin/main（含 S5-1 #289 与内核 #287）。工作包文本见 [U32](sprints-2-6.md#u32-s5-5)；基线与缺陷编号沿用 [S5-0](s5-0-nonmodel-baseline.md)，契约裁决沿用 [S5-1](s5-1-nonmodel-contract.md)。

## 1. 做了什么

`retrieval.index.start / status / cancel`（以及覆盖情况里的 `building`）在开关 `runtime.pilot.retrievalIndex`（插件 `Config`，**默认关闭**）打开时由统一运行时承担：一次构建是一个 `retrieval-index` Job，进入共享任务表和任务控制台；关闭时是原来的后台 run，行为不变。开关只在一处读取：`lib/contexts/generation/retrieval/index-runs.js`。

继续调用既有的宿主/MCP 工具（`mcp__studyhub__ingest_data` / `delete_file`），不新增搜索引擎、不产生第二份索引内容；查询、预览、计划、覆盖仍是即时调用。

| 文件 | 职责 |
|---|---|
| `lib/contexts/generation/retrieval/jobs/retrieval-index.js` | 任务定义：`admit`（工具可用、读库和 manifest、算计划）、`run`（经网关观测一次 `local-process` 调用，里面是既有的 `buildIndex`） |
| `lib/contexts/generation/retrieval/jobs/retrieval-index-view.js` | 展示读取器（标题、阶段、进度、详情）与旧状态形状的读取 |
| `lib/contexts/generation/retrieval/jobs/submit-retrieval-index.js` | start/status/cancel 入口：同库单飞、拒绝在创建 Job 之前、回执 |
| `lib/contexts/generation/retrieval/index-plan.js`、`adopt-index.js` | 两条路径共用：课程资料与差量计划；构建后采用扩展索引为检索源 |
| `lib/contexts/generation/retrieval/legacy-index-run.js` | 原后台 run，原样搬出（开关关闭时使用） |
| `lib/contexts/generation/retrieval/index-runs.js`、`runtime-port.js` | 开关的唯一读取点；生成上下文给构建的 job 端口 |
| `lib/retrieval-messages.js` | 构建的全部中文文案（英文在 `application-messages*.js`） |
| `lib/retrieval-index.js` | 只加了 `canIngest/indexUnavailable`（三处共用）和 `onItem` 钩子，`buildIndex` 行为不变 |

## 2. 能力声明（诚实）

`cancel` 是；`retry` 否（控制台不显示重试，再次点"开始"即按 manifest 差量继续——重试会绕过入口的同库单飞检查）；暂停/恢复不支持；`recoveryMode: none`（无持久化，重启即无记录，manifest 仍是检查点，与旧版一致）；`set` 否。Call：整个构建一条 `local-process` Call（`requestCount` null），不记 token，`usage.tokens` null，`execution.mode` null。

## 3. 验收对照（U32）

| 验收 | 实现与证据（`tests/unified-runtime-retrieval-index.test.mjs`） |
|---|---|
| 相同 contentHash/sourceKey 复用，变更只更新对应部分，删除保持既有授权范围 | 计划与 manifest 逻辑未改。测试：二次构建不发任何调用；改一页只重写该页的 key；一页离开库只删除它的 key（`library` 是整库页 id，不会误删其他课程的条目） |
| provider/ingest 工具缺失明确拒绝 | 入口与 `admit` 都先检查，错误码 `retrieval-index-unavailable`，没有 Job、没有写入；面板没有存活会话时（`executor-unavailable`）改为明确提示 `retrieval-index-needs-session`，同样不创建 Job |
| 取消停止后续 ingest，不把未知的已提交写入当作未发生 | 取消后无新的 ingest；在途那一页**既不记入 manifest 也不宣称未写**，状态里列在 `unconfirmed`，对应 Call 为 `cancelled`；下次构建以同一 sourceKey 重写 |
| ingest 成功但 manifest 保存前崩溃，先按内容身份核对，不无依据重复创建 | 内容身份是（sourceKey，contentHash）。同一 sourceKey 再次写入是**替换**（上游文档："Reusing the same path or source updates the existing entry"；0.20.0 运行时行为仍属 V-2，未验证），所以未记入 manifest 的页再写一遍不会新增条目。运行时路径还修了"保存失败被吞"（D-5）：写入已成功但 manifest 保存失败时任务以 `retrieval-manifest-unsaved` 失败并说明原因；测试用"替换式"的假扩展断言重做后条目数不变 |
| 同库只一个活动构建，其他库按现有规则隔离；query/preview 仍即时 | 入口在同一 tick 内检查并提交（无 `await` 夹在中间）；第二次 start 返回同一个 Job，课程不同时回执带 `requestedCourse`（D-7 不再静默）；另一个库有自己的构建（基线测试在开关下重跑）；构建运行期间 preview/plan/coverage 即时返回、不起任务 |
| 任务控制台可见（D-8） | 测试用控制台自己的 `taskSummary/tasksOf/runningTaskCount` 读真实快照：进行中计数、标题、进度行、百分比，取消后显示"已停止"；插件卸载会随定义一起停止构建 |

## 4. 缺陷处置

| 编号 | 处置 |
|---|---|
| D-5 manifest 保存失败被吞 | 运行时路径修复（任务失败并说明）；原路径不变 |
| D-6 取消途中那一页 | 运行时路径报告为 `unconfirmed`；原路径不变 |
| D-7 第二次 start 忽略课程 | 运行时路径报告 `requestedCourse`；原路径不变 |
| D-8 不在任务表 | 修复（运行时路径） |
| D-4 删除失败被吞 | **未修**：`buildIndex` 两条路径共用，修它会改变 2.7.1 行为（基线测试固定）；建议作为独立改动由所有者决定 |

## 5. 保留或迁移

| 对象 | 去留 |
|---|---|
| `runs` Map 与 `publicRun` | 原样搬到 `legacy-index-run.js`，开关关闭时使用；S6 删除 |
| manifest、contentHash/sourceKey、`planIndex`、`buildIndex`、host 端口 | 保留，运行时路径直接调用 |
| 即时操作（status/set/test/preview/plan/coverage/endpoint.set） | 不迁移 |

回滚：关闭开关即回到原后台 run（只影响新提交；在途构建不受影响）；没有持久化格式变化。

## 6. 测试矩阵

- 新：`tests/unified-runtime-retrieval-index.test.mjs`（10 条）。
- 开关两侧：`tests/wp28b-index.test.mjs`、`tests/nonmodel-baseline-index.test.mjs` 读 `SWITCH_MODE`，各有 `*.runtime.test.mjs` 孪生；基线里"不在共享任务表"一条按模式断言（原路径为空、运行时为一条 Job）。
- 红灯记录：开关接线前，新文件最初的 8 条里 7 条失败（唯一通过的是"复用"一条，它固定的是既有行为）；随后补的英文文案与控制台两条在实现后加入。

## 7. 未验证/开放

- V-2：mcp-local-rag 0.20.0 对同 key 再写入是替换、`delete_file` 对不存在项的返回——依据上游文档，未在真实扩展上验证（本机没有安装、不联网跑真实索引）。若将来能列出扩展内条目（`list_files` 字段未确认），可在 `admit` 里加"先核对"步骤，不改内核。
- V-7：无 Agent 面板入口的宿主行为（本步以明确提示拒绝）。
- 控制台 UI 无改动；未做真机浏览器截图。
