# 复习全书与主会话

[English](review-book-agent.md)

可以让 DSH 的主会话来写或重写你的[复习全书](review-book.zh-CN.md)：一个知识点、一章或者整本书，用你自己的话说（「把 2.3 按零基础重写一遍，加一个例子」），或者把要改的部分发给它。在对话里提出就是授权：主会话直接保存，不再反复确认；每次写入都保留上一版，在书页上点「回退到上一版」（或者让主会话撤回）就能退回去。唯一的硬规则是尊重资料：书里写的内容来自你的资料，引文逐字核对，资料以外的内容标（资料以外）。按 2026-10-11 的代码核对。

## 主会话怎么改书

主会话按 StudyHub 自带的 `study-book` 技能工作（插件里的 `skills/study-book/SKILL.md`），一次一个知识点：

1. 先看目录（`book.toc`）：每个知识点的 id、写了多少、它的资料页已经读了几页。
2. 读一个知识点（`book.read`）：它的文件、标题、前后两个知识点，以及这一点依据的资料页。
3. 打开这些页（`source.pages`，每次最多 4 页）。StudyHub 会记下打开过哪些页，所以主会话（和你）都能看到这一点的资料到底读了多少（`book.coverage`）。
4. 按标题一节一节地写（`book.write`）。每条引文都是一个注明出处的脚注；StudyHub 会在那份资料里（找不到再在这一点自己的页里）逐字查找，找不到的脚注会被拿掉，并告诉主会话是哪一条。同一个知识点里同一句引文被拿掉两次，会建议删掉那句话。
5. 读一遍写好的结果，看覆盖情况，再做下一个知识点。最后用中文告诉你：改了哪些知识点，哪些引文被拿掉了，哪些内容标了资料以外，还有哪些页没有读到。

主会话写进知识点生成文本的内容就成了你的：之后重新生成讲解也不会覆盖它，新的生成文本只作为建议等你「采用」或「忽略」，和你自己在书页上编辑一样。你自己的笔记和这一点的问答，只有你点名或者要求整本重写时才会改。

## 长时间的工作

主会话的每次调用都刻意做得很小：宿主会截断太长的工具结果，而 Auto 权限模式会带着之前所有调用一起审查每一次调用，整份文件地写，对话很快就会超长。对话变长时，主会话会把手上这一点做完，说清停在哪里，并建议开一个新对话继续；Auto 模式下最好每章开一个新对话。在新对话里说「从 3.2 接着写」就行。

## 让技能可用

插件在带技能注册表的 DSH 里启动时会自己注册 `study-book`，在有技能工具的会话里（学习预设有）技能列表就能看到它。如果你的主会话里看不到 `study-book`，把已安装插件里的 `skills/study-book` 文件夹复制到 `~/.dsh/skills/study-book`（也就是文件在 `~/.dsh/skills/study-book/SKILL.md`），DSH 也会从那里读技能。插件自己从不往它的文件夹和学习库以外的地方写东西。

## 开发者

- `book.toc {course?, offset?, limit?}`（每次最多 40 行）、`book.read {course?, hid, file?: 'gen' | 'mine' | 'qa', offset?}`（正文合计 4 500 字符，`more: {file, offset}` 接着读）、`book.coverage {course?, hid}`：lib/book-agent-read.js，只读；`book.toc` 先像 `course.book.open` 一样把书更新到最新（没有就建，总纲重整后重新对应）。每个结果都在宿主截断工具结果的 8 192 字符以内。按有质量把关的流程写成的书（[课程总纲](course-outline.zh-CN.md#复习全书讲解层)），`book.toc` 还给每个知识点 `concepts: 'N/M'`（清单里必讲条目讲到了几个），未达标的带 `short: true`，并给出全书三层的 `coverage`；`book.coverage` 多一项 `concepts {covered, total, status, missing?}`，列出还缺的名字。
- `source.pages {sourceId | documentId, from?, to?, offset?, hid?, course?}`：lib/book-pages.js，最多 4 页、6 000 字符（`next: {from, offset?}`，`end: true`）；学习库自己的清单（考点清单、总纲、复习全书本身）会被拒绝。显示过的内容由 lib/book-reading.js 记在学习库文件夹下的 `book-history/reading.json`（每份资料读过的字符区间、每个知识点的工作打开过哪些资料、每个知识点写入时被拿掉的引文），经临时文件和改名写入；它不在学习库里，也不进可携带备份。
- `book.write {course?, hid, file?, markdown | section: {heading, markdown} | edits: [{find, replace}], version?}`：lib/book-agent-write.js，脚注规则在 lib/book-footnotes.js，引文定位是 lib/book-quote.js（和复习全书的生成共用）。每次最多 20 000 字符、20 处替换。它走书的写入队列（lib/course-book-writer.js），在一个存储事务里按 `course.book.save` 的规则保存（lib/course-book-edit.js），所以书页上的保存和主会话的写入一个接一个进行。脚注按书的格式写回，`[^n]: [「原文」](studyhub://source/<id>) · 标题`，在「出处」下按顺序编号；标题放在知识点自己的标题之下；「练 5 道」那一行保持在最后；问答块、答题卡和 AI 块原样保留。整份写入的 `version` 过期时，保存主会话的文本，另一份作为建议保留；按节写入或替换则作用在文件现在的样子上。返回 `{status, hid, file, name, version, dropped: [{n, quote, reason, again?}], outsideCount, warnings, advice?, note?}`；warnings 会指出语言和书不一致、资料页还没打开、文件里的块不见了。拒绝码：book-write-mode、book-write-too-long、book-edit-find、book-section-missing、book-file-invalid、book-point-missing、book-point-not-leaf、course-book-missing。
- 技能在 lib/study-skills.js：`skills/<名字>/SKILL.md`（YAML 头部 `name`、`description`、`whenToUse`），宿主注入 `skills` 时用 `ctx.skills.register` 注册。工具说明是 `library.context` 的 `book` 区。
