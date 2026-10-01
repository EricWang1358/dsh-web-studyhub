[English](main-session-queries.md)

# 主会话查询资料与现有题组

主会话调用现有 `study_workspace`，先取 `library.context` 的小摘要；需要具体参数时，再用 `library.context {area:"sources"}`、`{area:"generation"}` 或 `{area:"cards"}` 读取相应契约。入口说明保持简短，资料正文、题目和关系只在需要时分页读取。不需要临时编写扫描脚本。

## 按导入日期找资料

`source.list {importedOn:"2026-09-29",timeZone:"Asia/Shanghai",offset:0,limit:50}` 使用当地日历日期。也可以用 `importedOn:"today"` / `"yesterday"`，或用含首尾日的 `importedFrom`、`importedTo`；单日与区间不能混用。结果回显解析后的日期、时区和每项时间依据。原有 `createdAt` 是兼容依据；由题目引用推断出的日期只用于展示，不参与精确导入日筛选。时间未知的资料也不会被猜到某一天。

`course` 缺省或 `"*"` 查询全库，空字符串查询未分类；`sourceIds:[]` 明确表示没有资料。日期、课程和来源范围在列表、搜索、覆盖检查中一致应用，零结果不会变成全库结果。

## 精简目录和关系

`source.list {groupBy:"document",course:"第三部分课程",offset:0,limit:30}` 把 PDF 页面按原文档 ID、连续音频的分卷按批次 ID 展示。每组仍返回总成员数、分页的原资料 ID 和引用关系。需要下一页时传 `memberOffset` / `memberLimit`；查全文用 `source.get {id,offset,limit}`，不要把整个资料库塞进一次会话。

`source.coverage {sourceIds:["实际资料ID"],deckIds:["实际题组ID"],targetOffset:0,targetLimit:20}` 列出精确目标题组中明确引用资料的题目。活动题组、归档题组和草稿分别显示；JSON 题库的自引用来源另列，不算独立资料证据。`directReferences` 的分子/分母只描述明确引用的资料数；没有引用不等于知识点未覆盖。主会话须进一步阅读资料、现有题目，再决定是否需要前置题或补题，不能把直接引用率当作语义覆盖率。

已有题目用 `card.search` 按精确题组 ID 查询。确认需要补题后，`generate` 的 `mergeTargetId` 指向该题组；部分完成时用 `resumeDraftId` 和当前 `draftVersion` 续生成。草稿经现有校验与发布合并，原题 ID、复习记录、历史和前置关系继续保留。前置依赖用 `capture.requiredBy` 或 `card.link`，避免另造一套关系表。

设计和验收边界见[联动计划](plans/2026-09-30-0016-feat-quiet-product-integration-plan.md)及[联动验收记录](quiet-product-integration-verification.md)。


## 把已有草稿发布到现有题组

先读取 `draft.get {id}` 获得 `draftVersion`，再调用 `draft.publish {id,draftVersion,mergeTargetId}`。快速发布和后台发布使用相同目标规则；兼容 `deckId`、`deck`（目标 ID 或 `{id}`）参数，但多个字段必须指向同一目标。无效、冲突或已归档的目标直接报错。成功返回 `id/deckId`、`added` 和 `total`，这几个字段反映同一事务已落盘的结果；`accepted` 是通过检查的题数，不能单独证明合并目的地。`draft.save {deck}` 只保存草稿，不发布、不合并。
