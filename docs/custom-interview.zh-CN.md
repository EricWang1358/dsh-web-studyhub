# 深度定制一本大书（访谈）

[English](custom-interview.md)

学习者上传了一本大书（比如 500 页），并不需要把每一部分都做出来。主会话用几个选项一次问一个问题，学习者勾了什么，才生成什么。答案存成这门课的**定制方案**（课程记录里的 `custom`），并由它决定要做的事。

## 从哪里开始

- 一份 150 页以上的资料转换或导入完成后，它那一行上的「深度定制这本书」：在「添加资料」的文件列表里，和「解析历史」里（「PDF 解析」里，以及有记录之后的「资料」页）。同一份资料只出现一次：按过之后这一行不再提供。更短的资料从不出现。150 是一个常量，`ui/custom-entry.js` 里的 `CUSTOM_BOOK_PAGES`。
- 复习全书的「更多 › 整本书 › 深度定制…」，每门课都有，不看页数。

两处都只是把话填进主会话的输入框（共用的「发给主会话」，`custom.start`），由学习者按发送；按它们本身不会生成任何东西。消息里有课程名，这一行知道文档 key 和页数时也带上。

## 访谈（技能 `study-custom`）

主会话先读一次课程和方案的只读预览（这本书分成哪些章、调用次数和 token 的粗略估计；不调用模型），然后用 `ask_user_question` 按顺序问：

1. 这本书拿来做什么：预习、跟课学、期末复习、开卷考试要速查。这一问决定后面每个问题的默认，后面的问题把默认放在第一个选项。
2. 覆盖哪些内容：全书、只学考试范围（粘贴或交给我范围说明）、或者挑几章（接受「3–7 章」这样的范围）。
3. 要不要复习全书、要哪些部分（讲解、术语卡和易混概念、答题模板和速查表、公式页和索引）、讲解多详细。
4. 要不要出题、什么题型、多少题（覆盖强度）、做错的题要不要准备变式题。
5. 学习计划：按考试日期、按每周几章，或者不要；每天多少分钟。
6. 确认：先做一个样例看看（推荐）、直接全部做，或者再精简一些。

每答一题，主会话重读估计，用一句话说变了多少（只说调用次数和 token，不说价格）。确认之前不生成任何东西，也不存任何东西。确认之后用 `course.save` 存方案，再用现有的功能开始第一步：总纲、复习全书（按章、样例先行与否、再写术语卡和易混概念）、按覆盖强度出题、和学习者一起起草备考计划。现有功能做不到的选择（复习全书里单独去掉某一部分、只对选定章节出题、没有考试日期的每周几章计划）照样存进方案，主会话会如实说没有做。

课程已经有方案时，不会从头再问一遍：主会话用一句话说出方案，只问什么变了。

宿主不支持多选时，多选的问题改成打字回答，把选项列成一小段。

## 开发者

- 技能：`skills/study-custom/SKILL.md`，列在 `SHIPPED_SKILLS`（lib/study-skills.js）。它只提学习工作区的动作和方案的只读预览 `course.custom.preview`；tests/custom-interview-skill.test.mjs 把每个名字对着登记表查。
- 发给主会话：ui/agent-prompts/index.js 里的 `custom.start`（构建函数 ui/agent-prompts/custom.js：`{course?, document?, pages?, hasCustom?}`；技能 `study-custom`，末尾「我想：」）。
- 入口：ui/custom-entry.js（常量、`offersCustom`、`customOfferOf`、浏览器里「每份资料只提一次」的记忆），ui/PdfConvertJob.jsx（`HistoryRow`）和 ui/ImportHub.jsx 里的那一行，ui/book/BookMore.jsx 和 ui/book/more-actions.js 里的菜单项 `custom`。两处都登记在「找功能」里（`custom-book-menu`、`custom-book-import`）。英文：ui/locales/en.custom.json。
- 测试：tests/custom-interview-skill.test.mjs、tests/custom-interview-ui.test.mjs、tests/custom-interview-browser.test.mjs（截图放到 `CUSTOM_SHOTS`）。
