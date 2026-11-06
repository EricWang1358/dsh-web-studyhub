# 深度定制一本大书（访谈）

[English](custom-interview.md)

学习者上传了一本大书（比如 500 页），并不需要把每一部分都做出来。主会话用几个选项一次问一个问题，学习者勾了什么，才生成什么。答案存成这门课的**定制方案**（课程记录里的 `custom`），并由它决定要做的事。

## 从哪里开始

- 一份 150 页以上的资料转换或导入完成后，它那一行上的「深度定制这本书」：在「添加资料」的文件列表里，和「解析历史」里（「PDF 解析」里，以及有记录之后的「资料」页）。同一份资料只出现一次：按过之后这一行不再提供。更短的资料从不出现。150 是一个常量，`ui/custom-entry.js` 里的 `CUSTOM_BOOK_PAGES`。
- 「资料」页上同一份资料那一行的「深度定制」，在「查看 N 章」旁边：一直都在，不是只出现一次。课程已经有定制方案时，它写成「查看/修改定制」（消息里会写明这门课已有定制，主会话只问你想改的地方）。
- 复习全书的「更多 › 整本书 › 深度定制…」，每门课都有，不看页数。
- 总纲页上先问一句：课程里有 150 页以上的资料、又没有定制方案时，「生成总纲」和第一次「生成复习全书」不会马上开始。弹出的小问题给出「深度定制这本书（推荐）」（就是这个入口）、「整本生成」（原来的做法）和「取消」，并按这两个生成自己的 `estimate: true` 写出整本生成大约要几次模型调用、读多少 token（不调用模型，不写价格）。已有定制方案、或没有这样的资料的课程，照旧点一下就开始。

这些入口都只是把话填进主会话的输入框（共用的「发给主会话」，`custom.start`），由学习者按发送；按它们本身不会生成任何东西。消息里有课程名，这一行知道文档 key 和页数时也带上。

## 访谈（技能 `study-custom`）

主会话先读一次课程和方案的只读预览（这本书分成哪些章、调用次数和 token 的粗略估计；不调用模型），然后用 `ask_user_question` 按顺序问：

1. 这本书拿来做什么：预习、跟课学、期末复习、开卷考试要速查。这一问决定后面每个问题的默认，后面的问题把默认放在第一个选项。
2. 覆盖哪些内容：全书、只学考试范围（粘贴或交给我范围说明）、或者挑几章（接受「3–7 章」这样的范围）。
3. 要不要复习全书、要哪些部分（讲解、术语卡和易混概念、答题模板和速查表、公式页和索引）、讲解多详细。
4. 要不要出题、什么题型、多少题（覆盖强度）、做错的题要不要准备变式题。
5. 学习计划：按考试日期、按每周几章，或者不要；每天多少分钟。
6. 确认：先做一个样例看看（推荐）、直接全部做，或者再精简一些。

每答一题，主会话重读估计，用一句话说变了多少（只说调用次数和 token，不说价格）。确认之前不生成任何东西，也不存任何东西。确认之后用 `course.save` 存方案，再**调用一次 `course.custom.apply`**（见下），它用现有的后台任务开始方案要求的事，并用白话回答：开始了什么、什么在等和为什么、什么只记在方案里。现有功能做不到的选择（考试范围）照样存进方案，列在 `recorded` 里，主会话会明说没有做。

## 开始做（`course.custom.apply`）

`course.custom.apply {course?, confirm?}` 按**已存**的方案，用现有的任务依次做（它自己没有任务）：复习全书（`generation.courseBook.build`，只做选中的章，按方案的详尽程度）、题（`generate`，见下）、备考计划（`course.save {plan}`）。返回 `{status, course, started, waiting, recorded, done}`，每一项是 `{step, what}`，白话，主会话直接念；任务那一项带 `jobId`：

- `started`：现在开始的（书的任务、每一组章节的题一个任务、存好的计划）。
- `waiting`：没开始和为什么：没有模型、样例在等你看、章节编号现在找不到了、构建拒绝了、一次超过 12 组题（这些做完后再说一次）、按日期的计划缺考试日期。
- `recorded`：只记在方案里的选择（考试范围；复习全书现在照方案省略没勾的部分）。
- `done`：本来就已经是这样的：写好的书、做过的题、存好的计划、变式题的开关。

再说一次也安全：正在做的任务只是被点名，不会再开一个；写好的书和做过的题不会重做。**样例先行**时，书先写两个知识点的样例并等着，题只先做第一组的第一轮；`confirm: true`（你说「做完」）才写完整本、做完所有组的题，并把第一轮后停住的那一组接着做到底（写在 `started` 里，不写在 `done` 里）。不是样例的任务会要求自己做到底，不管强度是哪一档。同时来两次 apply 会一个接一个处理，同一组题不会开两次。一段没有分页的文字里的章节没法单独切出来：它的题读整段文字，`recorded` 里会点出是哪一章。

**题按方案出。** 只读选中章节的页（总纲的章：它的知识点对应的页；资料的章：它的页；一段没有分页的文字里的章只能整段读，返回里会照实说），只出你勾选的题型（一个混合的任务，不是每个题型各一个），强度用方案里的。一个覆盖任务最多规划 500 题，所以上限按任务算：选中的章按顺序分组，每组都在上限以内（一章自己超过上限就按它的页切开），每组一个任务。三章要出 1,500 题，是三个以上的任务，不是一个任务被截在 500。预览里的题数和调用次数用同样的分组（`questions.runs` 是任务数）。

**每周几章的计划。** `plan.by: 'weekly'` 加 `chaptersPerWeek` 存成一份不需要考试日期的备考计划：复习全书的章从存下的那天起一周一周往后排，每个学习日读那一周的知识点，一周结束时没学完的挪进当前这一周。复习全书的「备考计划」和首页的「本周」卡片写着「本周：第 3–4 章」和今天读哪几节。按考试日期排的计划要先有考试日期（没有就说明，什么也不存），存成一份最小的计划；课程已有计划时不会覆盖。

**变式题。** 方案里的 `variants` 开关只管这门课：开，这门课做错的题自动准备变式题（练习点评、追问、「太简单 / 太难」），不需要打开设置里的总授权；关，不自动准备，不管总授权怎么设；没有方案（或方案不出题）就照旧由总授权决定。你在错题本里手动要的不受影响。

课程已经有方案时，不会从头再问一遍：主会话用一句话说出方案，只问什么变了。

宿主不支持多选时，多选的问题改成打字回答，把选项列成一小段。

## 开发者

- 技能：`skills/study-custom/SKILL.md`，列在 `SHIPPED_SKILLS`（lib/study-skills.js）。它只提学习工作区的动作、只读预览 `course.custom.preview` 和 `course.custom.apply`；tests/custom-interview-skill.test.mjs 把每个名字对着登记表查。
- 开始做：lib/custom-apply.js（顺序、去重、样例；白话在 lib/custom-apply-words.js）、lib/custom-sources.js（`scopeUnits`：每个选中章节的页）、lib/custom-questions.js（`packRuns`、`fitUnits`：任务分组，估计也读它）、lib/custom-variants.js（这门课的变式题开关）、lib/plan-weekly.js（`periodPlan` 里的每周排期）。这个动作登记在资料库上下文里；它启动任务的授权（`generation: generate, courseBook.build`，`courses: course.save`）是 lib/runtime/domain-contracts.js 里的 `actionGrants.library`。lib/custom-apply.js 里的 `BUILD_HONOURS_PARTS` 说明构建是否按方案里的部分来做，构建做到之后改成真。
- 发给主会话：ui/agent-prompts/index.js 里的 `custom.start`（构建函数 ui/agent-prompts/custom.js：`{course?, document?, pages?, hasCustom?}`；技能 `study-custom`，末尾「我想：」）。
- 入口：ui/custom-entry.js（常量、`offersCustom`、`customOfferOf`、浏览器里「每份资料只提一次」的记忆），ui/PdfConvertJob.jsx（`HistoryRow`）和 ui/ImportHub.jsx 里的那一行，ui/book/BookMore.jsx 和 ui/book/more-actions.js 里的菜单项 `custom`。两处都登记在「找功能」里（`custom-book-menu`、`custom-book-import`）。英文：ui/locales/en.custom.json。
- 测试：tests/custom-interview-skill.test.mjs、tests/custom-interview-ui.test.mjs、tests/custom-interview-browser.test.mjs（截图放到 `CUSTOM_SHOTS`）；开始做：tests/custom-apply.test.mjs、custom-apply-plan、custom-apply-book、custom-sources、custom-questions、custom-variants；每周计划：tests/plan-weekly.test.mjs、tests/custom-weekly-browser.test.mjs（截图放到 `WEEKLY_SHOTS`）。
