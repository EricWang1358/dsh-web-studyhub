# 3.0.0 真实抽检发现的修复

负责人：Codex；集成基线 `4d04f751112d30387f295d1e590771931fe557d1`，分支 `codex/studyhub-3.0.0`。这是 U2 的缺陷记录，不将工作树当成已发布版本。真实输入与初始失败见 [S6-10](s6-10-model-qa.md)。

## 补题发布与已有学习流

真实 CommandCode 的旧/新补题路径都在写入已有题组时失败，错误为只读 `scope` 赋值。通过公开 RPC、假模型和已有工作流复现，排除了模型输出的影响。

`finishDestination → mergeDecks → relocateReferences` 会把工作流的宽范围选择固定成合并前的题目成员，避免新题偷偷进入进行中的流程。authoring 已读取并参与 `workflow-data` 事务，但 `draft.publish`、`draft.publish.quick`、外层 `deck.import` 漏报了 `workflowSessions` 写集合。修复只补齐这三处声明，沿用现有事务和锁；`draft.publish.plan` 仍不持久化。

- 新增 6 项公共路径回归：修复前 6/6 失败，修复后 6/6 通过。首个夹具缺少 requestId 的准备错误另存，不计入缺陷红灯。
- 相关 7 个文件 66/66 通过，零跳过；覆盖直接、快速、后台发布、导入、补题开关关/开、计划只读、工作流原成员、一次版本递增、无关会话和现有只读保护。
- 未新增字段、任务表、队列、重试、公共接口或开关。复用 [DSH-08](s1-0-dsh-capabilities.md) 对应既有插件事务边界；这次修复的是插件内部写入所有权，并未扩大宿主权限。
- 回退代码会重新暴露该保存故障；已写入的题目引用与工作流版本仍采用既有形状。真实模型修复复测和最终包兼容结果由验收记录单独给出。

## 宿主音频处理的型号记录

字幕的真实 off/on 样本实际调用 CommandCode，持久记录却复制了未使用的 `settings.textModel`（Gemini 默认项）。同样的写法存在于单文件音频和课堂校对保存。

三个既有产物写入点在 `textProvider === 'host'` 时将聚合 `textModel` 写为 `null`，不猜测宿主多阶段调用是否使用同一型号；每次调用的真实观测仍由既有网关负责。直接 Gemini 路径继续保留其配置值。不会重写历史记录、改变缓存键或改动模型路由。

- 在既有公开行为测试上加入产物断言：红灯 10 项中 6 失败、4 通过；修复后相同 10 项全过，零跳过。覆盖单文件、课堂保存、字幕的开关关/开及 Gemini 值保留。
- 这是明确登记的旧行为缺陷修复，不把新的元数据预期冒充历史特征行为。相关 JS 文件定向 ESLint 通过。
- 复用 [DSH-04/07](s1-0-dsh-capabilities.md) 的模型与观测事实；没有另建型号或用量账本。真实字幕定点复测及 2.7.1 旧读者演练另见验收记录。

## 开始练习后的导航高亮

全量测试发现开始练习后当前行高亮缺失。按钮在 `busy` 时移除 `aria-current`，布局副作用因此清空高亮；`busy` 解除后原依赖不变，按钮虽恢复当前状态，高亮却不会重新测量。修复仅在已有布局副作用的依赖中增加 `busy`，保留禁用状态、原样式与尺寸。

真实浏览器回归拦住公开 snapshot 的实际响应，点击进入练习，等产品自身解除 busy 后用原 `measureSidebar/checkContract` 检查高亮，再释放响应。100%/200% 两场景均先失败后通过；原有导航布局与一致性两文件 14/14 通过，零跳过。未改检查器、未加固定睡眠或扩大超时，ESLint 通过。无新公共部件或存储变更；复用既有宿主 UI 边界，对应 DSH-01/08。

完整红绿日志在私有 `output/verification/publication-scope-{red,green,regression}.log`、`300-model-metadata-{red,green}.log` 与 `nav-busy-{red,green,regression}.log`。`ce-code-review` focused 审查已完成，0 findings，记录在 `output/verification/300-release-review/review.json`；独立本地上下文非代码作者，但此前提供过 QA 发现，不称盲审或跨模型审查。全量验证、双平台 CI、最终安装包复验仍是单独发布门禁。
