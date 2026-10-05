[English](main-session-queries.md)

# 在主对话中查询资料与题组

在 DSH 里，主对话通过 `study_workspace` 工具读写你的 StudyHub 学习库。你用平常的话提问，助手自己选择调用哪些操作。本页列出它能查什么，方便你把要求说清楚，也方便核对它的回答。

助手按小页读取学习库，不需要临时编写扫描文件的脚本。

## 可以这样问

| 想做的事 | 例如可以说 | 助手调用 |
| --- | --- | --- |
| 了解学习库概况 | “我的学习库里现在有什么？” | `library.context` |
| 找某天导入的资料 | “列出我昨天导入的资料” | `source.list {importedOn:"yesterday"}` |
| 搜索或阅读资料原文 | “资料里哪里讲了 TCP 三次握手？” | 先 `source.search`，再 `source.get` |
| 查哪些题引用了某份资料 | “哪些题引用了这份讲义？” | `source.coverage` |
| 找已有的题 | “题库里有没有二分查找的题？” | `card.search` |
| 给已有题组补题 | “根据这份讲义，给二分查找题组补 5 道题” | `supplement`，见[向已有题组补题](supplementation.zh-CN.md) |
| 把草稿发布到已有题组 | “把这份草稿并入二分查找题组” | `draft.publish` |
| 把知识骨架画成可交互的图 | “用 archify 技能画我的可靠性骨架” | `skeleton.get`，再 `skeleton.diagram.attach`，见[搭配好用的工具](companions.zh-CN.md) |

要从电脑导入 JSON 题组文件，见[在主对话中导入文件](json-import.zh-CN.md#在主对话中导入文件)。

## 调用的写法

本页把调用写成 `操作 {参数}`，例如 `source.list {importedOn:"today"}`。工具实际收到的是操作名，加上 JSON 字符串形式的参数：

```json
{"action":"source.list","payload_json":"{\"importedOn\":\"today\"}"}
```

## 先读学习库摘要

`library.context` 返回一份简短摘要：

- 学习库文件夹、时区和今天的日期；
- 当前方向：课堂或面试模式、课程和目标岗位；
- 资料数、活动题组数、归档题组数、草稿数，以及活动题组里的题目数；
- 第一页课程名；
- 契约分区列表。

需要某类操作的具体参数时，读取对应分区，例如 `library.context {area:"sources"}`、`{area:"generation"}` 或 `{area:"cards"}`。分区有 `sources`、`imports`、`classroom`、`generation`、`cards`、`learning`、`organization`、`notes`、`board`、`workflows`、`cases` 和 `skeletons`。

资料原文、题目和关联关系只在需要时分页读取。

## 按导入日期找资料

```text
source.list {importedOn:"2026-09-29", timeZone:"Asia/Shanghai", offset:0, limit:50}
```

- `importedOn` 接受当地日历日期（`YYYY-MM-DD`）、`"today"` 或 `"yesterday"`。
- `importedFrom` 和 `importedTo` 表示日期区间，包含首尾两天。区间不能和 `importedOn` 同时使用。
- `timeZone` 默认为宿主所在时区。日期或时区无效、区间首尾颠倒时，会直接报错。
- `query` 按资料标题筛选。

结果会回显解析后的日期和时区，给出日期筛选前已记录、推断和未知日期的资料数（`dateCounts`），并标明每份资料的时间依据。

资料日期的认定方式：

- 优先使用记录下来的导入时间；较早的资料改用原有的 `createdAt`。
- 根据题目引用推断出的日期只用于展示，不参与日期筛选。
- 日期未知的资料也不参与筛选。StudyHub 不会根据文件时间戳猜测日期。

## 按课程或资料限定范围

- 不传 `course` 或传 `"*"` 表示全库；空字符串表示未分类的资料。
- 课程名也包括它的子课程，例如 `第三部分 / 第 2 周` 属于 `第三部分`。
- `sourceIds:[]` 明确表示不选任何资料。
- 这些筛选在 `source.list`、`source.search` 和 `source.coverage` 中规则一致。
- 没有结果时如实返回空结果，不会扩大到全库。

## 精简浏览大课程

```text
source.list {groupBy:"document", course:"第三部分", offset:0, limit:30}
```

- `groupBy:"document"` 按文档 ID 把同一文档（例如一份 PDF）的各页归为一组，按批次 ID 把多段音频的转写归为一组。
- 每组保留总成员数、一页成员资料 ID 和引用关系。
- 用 `memberOffset`、`memberLimit` 翻看更多成员，用 `relationOffset`、`relationLimit` 翻看更多关系。
- 读正文用 `source.get {id, offset, limit}`。不要把整个学习库塞进一次对话。

## 查哪些题引用了资料

```text
source.coverage {sourceIds:["实际资料ID"], deckIds:["实际题组ID"], targetOffset:0, targetLimit:20}
```

- 按目标题组列出明确引用所选资料的题目。
- 活动题组、归档题组和草稿分开列出。只有不传 `deckIds` 时才包括草稿。
- 精确的 `deckIds` 优先于 `course`。题组 ID 不存在时报错，`deckIds:[]` 表示不选任何题组。
- 用 `cardOffset`、`cardLimit` 翻看每个题组里的题目。
- JSON 导入时保存的资料单独计数，不算独立证据。

如何理解这些数字：

- `directReferences` 的分母是所选的独立资料数，分子是其中被目标题组和草稿直接引用的资料数。
- `semanticCoverage` 始终为 `unassessed`。直接引用率不等于知识点覆盖率。
- 没有引用不代表知识点没有覆盖。决定补前置题或补题之前，先读资料和现有题目。

## 查找题目并补入题组

- 用 `card.search {query, deckIds}` 按精确题组 ID 搜索题目。归档题组默认跳过，传 `includeArchived:true` 才会包括。
- 你要求给某个题组补题时，助手使用 `supplement {deckId, sourceIds, count}`，在一个后台任务里完成生成、审核和发布。见[向已有题组补题](supplementation.zh-CN.md)。
- `generate {..., mergeTargetId}` 则只生成一份以该题组为目标、经过审核的草稿，不会自行发布。
- 生成只完成一部分时，用 `generate {resumeDraftId, draftVersion}` 续生成，`draftVersion` 填草稿当前的版本。
- 发布时题目并入目标题组，原题 ID、复习记录、历史和前置关系都保留。
- 前置关系用 `capture {requiredBy}` 或 `card.link` 记录。

## 把草稿发布到已有题组

1. 用 `draft.get {id}` 读取草稿，拿到当前的 `draftVersion`。
2. 调用 `draft.publish {id, draftVersion, mergeTargetId}`。

目标规则：

- 审核后发布（`draft.publish`）、快速发布（`draft.publish.quick`）和后台发布（`draft.publish.start`）使用同一套目标规则。
- 兼容 `deckId` 和 `deck`（目标 ID 或 `{id}`）两个别名。同时传多个时，必须指向同一题组，也要和草稿里已保存的目标一致。
- 目标无效、不存在、相互冲突、已归档或不是普通题组时，直接报错，不会被忽略。

如何看结果：

- `id`/`deckId`、`added` 和 `total` 来自同一个已提交的事务，用它们确认题目去了哪里。
- `accepted` 是通过检查的题数，单凭它不能证明合并去向。
- `draft.publish` 只发布通过检查和审核的题，其余的题留在草稿里，并列出问题（`rejectedDraft`）。`draft.publish.quick` 则发布全部题目，只给有问题的题加标记。
- 全部题目都没通过时，不发布任何内容：`id` 为 `null`，题目留在草稿里。

`draft.save {deck}` 只保存草稿，不发布，也不合并。

## 分页大小

| 调用 | 分页字段 | 默认值 / 上限 |
| --- | --- | --- |
| `library.context` | `offset`、`limit`（课程名） | 30 / 100 |
| `source.list` | `offset`、`limit` | 100 / 200 |
| `source.list {groupBy:"document"}` | `memberOffset`、`memberLimit` | 50 / 200 |
| 关联关系列表 | `relationOffset`、`relationLimit` | 20 / 100 |
| `source.get` | `offset`、`limit`（字符） | 20,000 / 60,000 |
| `source.search` | `limit`（片段数） | 8 / 50 |
| `source.coverage` | `offset`、`limit`（资料） | 50 / 200 |
| `source.coverage` | `targetOffset`、`targetLimit`；`cardOffset`、`cardLimit` | 各 20 / 100 |
| `card.search` | `limit` | 20 / 50 |

## 设计记录

设计和验收边界见[联动计划](plans/2026-09-30-0016-feat-quiet-product-integration-plan.md)和[联动验收记录](quiet-product-integration-verification.md)。
