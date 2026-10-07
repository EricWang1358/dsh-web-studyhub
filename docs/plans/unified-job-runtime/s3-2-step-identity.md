# S3-2：稳定 Step 身份与领域 checkpoint / 补位 / 储备身份

> 前置：S3-1（#295）已合并。本步给出出题每一次模型调用所属的**逻辑单元**的稳定身份、把一次运行"被问了什么"冻结在检查点（草稿）里、并给出"哪些单元已完成"的引用。不新增持久化、不新增暂停能力、不改任何草稿检查点语义；恢复由 S3-3 使用这里的记录。

## 1. Step 键（`jobs/step-identity.js`，纯函数）

`stepKeyOf({ purpose, round, group, part, attempt, fill, retry, unit })` → 用 `:` 连接的片段，只含该调用的**坐标**，不含计数器或时钟：

| 片段 | 含义 | 来源 |
|---|---|---|
| `r<n>` | 覆盖运行的第 n 轮（计划轮与补位轮） | 执行器 `plan.round` |
| `g<n>` | 一次规划覆盖的第 n 组页面（规划发生在任何 part 之前） | `batch.js planGroup / planAssignedGroup` |
| `p<n>` | 本轮的第 n 个 part | `batch.js runPart / replan` |
| `a<n>` | part 的第 n 次尝试（第 1 次省略）：失败的 part 重写 | `batch.js tries` |
| `f<n>` | part 内第 n 个补位轮（先储备目标、再重新规划） | `generation.js reserveRound`（经 `within`），`batch.js replan` |
| `<unit>` | part 之外的命名单元：`weights`（小节权重）、`repaired`（修补后的复审） | 执行器 / `generation.js patchRound` |
| `<purpose>` | `plan / blueprint / author / review / repair` | 调用种类（与控制台同一判定） |
| `x<n>` | 不可读复审回复的第 n 次再问 | `generation.js singleRoundReview` |

例：`g1:plan`、`p1:blueprint`、`p1:author`、`p1:review`、`p1:f1:author`、`p1:f2:plan`、`r2:p3:a2:review:x1`。长度不超过内核 `stepKeyLength`。

解决 S3-0 D-6：旧 `stepKeyOf` 只有 `kind:part`，覆盖运行不同轮的同一 part、补位轮与首轮写作共用一个键，补位轮的"答案蓝图"调用还被归为写作（现在上下文里 `kind: 'blueprint'`，与首轮一致）。

## 2. 冻结的输入（`jobs/input-ref.js`）与检查点引用（`jobs/checkpoint-ref.js`）

- `inputRefOf({ definition, request, sources, extraSourceIds, added })`：`{ version, definition: "generation@1" | "supplement@1", sources: [{ id, hash }], hash, extraSourceIds?, added? }`。`hash` 只由**决定单元的东西**算出：种类与各类题数、题数、语言、难度、侧重、角色、约束、公式写法、并入目标、覆盖强度、参考资料及其格式、课程、`batchSize`、各资料文本的哈希、定义标识。并发、补位轮数、时限、推理档位**不**参与（它们改变怎么跑，不改变单元是什么）。
- 每次保存草稿都写入 `editorial.generation.inputRef`（`operations.js saveProgress`）；这是 S3-0 要求的「`extraSourceIds`/count 与哈希进 inputRef」：用未覆盖资料补题带 `extraSourceIds` 与 `added`，定向补题的定义标识是 `supplement@1`。
- `checkpointStatus(saved, current)`：`{ valid: true }` 或 `{ valid: false, reason: 'none' | 'definition' | 'sources' (changed: [id]) | 'request' }`。S3-3 用它拒绝"输入或定义变了"的恢复；本步**不**用它拒绝任何现有的继续路径（行为不变）。
- （S3-3 以 `checkpointOf/checkpointHolds` 取代，S6-2 已删除，下面是 S3-2 当时的记录）`checkpointRefOf(draft)`：`{ ref: "draft:<id>:v<draftVersion>", completed: ["r1", "r3"] }`——检查点就是草稿（公共侧只存引用，不另建产物表）；`completed` 是覆盖运行已完成/跳过的轮的键前缀。普通运行没有已完成的轮：它是一个单元，从草稿已有的题继续。

## 3. S3-0 恢复矩阵中本步负责的行

| 行 | 本步交付 | 仍待 |
|---|---|---|
| plain / mixed / case 首份草稿前 | 请求被冻结的内容与哈希已定义（`inputRef`），Step 键稳定 | 首份草稿之前没有地方存：持久化请求 = S3-3 |
| plain/case 首个 part 之后 | 草稿带 `inputRef`；`checkpointRefOf`（已被 S3-3 的 `checkpointOf` 取代）引用该草稿版本 | interrupted 可见、同逻辑 Job 新 attempt = S3-3 |
| `resumeDraftId` 续补 | 继续时可比较旧 `inputRef` 与新请求（`checkpointStatus`） | 同上 |
| `extraSourceIds` 补题 | `extraSourceIds`、`added` 进入冻结输入 | 请求在首次保存前仍只在内存：S3-3 |
| target supplement | 定义标识 `supplement@1` 进入冻结输入 | 恢复 / 自动发布 = S3-3 / S3-6 |
| coverage | 键含轮号；`completed` 给出已完成的轮 | 同逻辑 Job 新 attempt（D-4）= S3-3 |
| selection / repair / publish | 不变 | S3-4 / S3-5 / S3-6 |

## 4. 验收对应（U11）

- 同逻辑 Job 新 attempt 不改变已完成 Step 键：`generation-step-identity`（同一运行两次键完全相同）、`unified-runtime-generation-queue`（运行时下两次运行键相同且每个单元一个键）；输入/定义改变使检查点无效：`generation-input-ref`。
- 首 pass 先保存再补位，`fillRounds`=0/1/上限只补缺口：既有 `generation-fill-rounds` 全绿（本步只把假模型移到 `tests/helpers/fill-rounds-model.mjs` 供两个套件共用）；`generation-step-identity` 断言 0/1/2 轮各自只命名自己运行的单元。
- 两并行 part 不领同一储备目标、已拒目标不重规划、happy path 无额外请求：既有 `generation-yield`、`generation-fill-rounds` 全绿且未改；本步只给调用加坐标，不增减调用。
- 旧 attempt / 乱序不能提交：内核已有（`unified-runtime-lifecycle` 的迟到发布围栏）；出题侧 `partial` 走结果字段：`generation-step-identity` 的"fewer questions than asked"两边（旧 / 运行时）都是 `complete` + `result.completeness: partial`。

## 5. 没做、以及为什么

- 不持久化 `inputRef` 到运行时记录、不声明 `recoveryMode`/暂停：没有安全的中间检查点之前不虚增能力（S3-3 才有持久输入与恢复）。
- 补位目标 id（`fill-<n>`）与储备 id 仍是进程内计数：它们是草稿证据里的名字，不是 Step 身份；Step 身份已由 `f<n>` 与 part 给出，改它们会改变草稿内容，不属于本步。
