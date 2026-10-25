# 复习全书与主会话

[English](review-book-agent.md)

可以让 DSH 的主会话来写或重写你的[复习全书](review-book.zh-CN.md)：一个知识点、一章或者整本书，用你自己的话说（「把 2.3 按零基础重写一遍，加一个例子」），或者把要改的部分发给它。在对话里提出就是授权：主会话直接保存，不再反复确认；每次写入都保留上一版，在书页上点「回退到上一版」（或者让主会话撤回）就能退回去。唯一的硬规则是尊重资料：书里写的内容来自你的资料，引文逐字核对，资料以外的内容标（资料以外）。按 2026-10-16 的代码核对。

## 主会话怎么改书

主会话按 StudyHub 自带的 `study-book` 技能工作（插件里的 `skills/study-book/SKILL.md`），一次一个知识点：

1. 先看目录（`book.toc`）：每个知识点的 id、写了多少、它的资料页已经读了几页。
2. 读一个知识点（`book.read`）：它的文件、标题、前后两个知识点，以及这一点依据的资料页。
3. 打开这些页（`source.pages`，每次最多 4 页）。StudyHub 会记下打开过哪些页，所以主会话（和你）都能看到这一点的资料到底读了多少（`book.coverage`）。
4. 按标题一节一节地写（`book.write`）。每条引文都是一个注明出处的脚注；StudyHub 会在那份资料里（找不到再在这一点自己的页里）逐字查找，找不到的脚注会被拿掉，并告诉主会话是哪一条。同一个知识点里同一句引文被拿掉两次，会建议删掉那句话。角标和脚注总是一起走：文件末尾始终只有一组 `[^1]`…`[^n]`；和文件里一字不差的脚注再找不到时按原样保留（这次写入新加的或改了字的脚注一律重新核对）；一次替换删掉了脚注、正文里却还有它的角标时，这次写入会被拒绝。
5. 读一遍写好的结果，看覆盖情况，再做下一个知识点。最后用中文告诉你：改了哪些知识点，哪些引文被拿掉了，哪些内容标了资料以外，还有哪些页没有读到。

主会话写进知识点生成文本的内容就成了你的：之后重新生成讲解也不会覆盖它，新的生成文本只作为建议等你「采用」或「忽略」，和你自己在书页上编辑一样。你自己的笔记和这一点的问答，只有你点名或者要求整本重写时才会改。

## 从书页发给主会话

书页可以替你把消息填进对话的输入框（只填入，不会发送；你看过再按发送）。消息第一句是你自己的话（要对哪个知识点做什么，知识点标题作为名字写在句子里），紧接着是放在围栏里的你的要求，所以输入框里先看到的就是你要的。空一行之后，在「StudyHub 附注（给助手）」下面，每行一条写主会话要用的：先读 `study-book` 技能、用 `book.read` 读这一节，课程和知识点，这一点的文件和生成文件的版本，资料页读了几页，规则（可核对的脚注、按书的语言标资料以外、一次只写一个小节），做完汇报什么（每次改动都保留上一版，`course.book.revert` 可以退回），以及一行说明围栏里是什么；选中的话随后放在数据围栏里，最后是语言句。消息里没有书的正文：主会话自己读。

- 知识点标题旁的「问 AI」（见[读的时候问 AI](review-book.zh-CN.md#读的时候问-ai)）：一个框，五个预设（「讲细点」「加个例子」「润色成大白话」「加过渡」「还漏了哪些小知识点、要不要补进来」），两个去处；「发给主会话」就是发到这里。框可以留空（消息会请主会话把这一节改得更清楚易读）。按 Escape 关闭，焦点回到「问 AI」。它不需要应用里设置模型。
- 选中几句话：工具条上的「发给主会话」直接把它们（放在数据围栏里，不带角标数字）连同这一个知识点发过去，请主会话只改与它们有关的地方；「写一段…」打开同一个框，选中的话在最上面，在框里写的要求也一起发。
- 书栏「更多 › 整本书 › 发给主会话」：点了直接发（没有表单；想提要求就在主会话的输入框里写）；消息里没有具体知识点，请主会话先说哪些知识点最值得改、等你挑好再写，并从 `book.toc` 开始一次一个知识点。

发生了什么，页面底部会出一张盖章回执：「已填进主会话的输入框」（5 秒后收起；应用已经切到主会话）；输入框里你已经写了字时是「输入框里你写的字都留着」（消息改为复制，宿主能切到主会话时带「去主会话」）；宿主没有对话输入框时（单独打开应用）是「已复制到剪贴板」（「看看内容」打开消息）。浏览器不让用剪贴板时，整条消息会在一张卡片里打开，有「复制全文」和全选兜底；只有不复制就关掉卡片，才会留下「请手动复制」那张回执。你也可以不点任何按钮，直接在主对话里说想怎么改书。

## 长时间的工作

主会话的每次调用都刻意做得很小：宿主会截断太长的工具结果，而 Auto 权限模式会带着之前所有调用一起审查每一次调用，整份文件地写，对话很快就会超长。对话变长时，主会话会把手上这一点做完，说清停在哪里，并建议开一个新对话继续；Auto 模式下最好每章开一个新对话。在新对话里说「从 3.2 接着写」就行。

### 权限审查本身出错时

权限审查（auto-review）属于 DSH 宿主，不是 StudyHub 的一部分：StudyHub 既不运行它，也没有任何声明能把它打开或关掉。如果宿主的审查服务不可用，或者它自己的请求被拒绝（主会话看到的是 `INVALID_REQUEST` / 400，读取类调用如 `book.toc` 和写入类调用都会遇到），这次调用没有改动书里的任何内容。请等几分钟再试，或者开一个新对话（对话越长，审查请求越大），或者换成会逐次询问你的权限模式，自己点同意。主会话会被要求停下来如实说明，而不是反复重试，也不会改用更重的调用（比如 `course.book.save`）。这类故障要由 DSH 项目去修，StudyHub 修不了。

## 让技能可用

插件在带技能注册表的 DSH 里启动时会自己注册 `study-book`，在有技能工具的会话里（学习预设有）技能列表就能看到它。如果你的主会话里看不到 `study-book`，把已安装插件里的 `skills/study-book` 文件夹复制到 `~/.dsh/skills/study-book`（也就是文件在 `~/.dsh/skills/study-book/SKILL.md`），DSH 也会从那里读技能。插件自己从不往它的文件夹和学习库以外的地方写东西。

## 开发者

- `book.toc {course?, offset?, limit?}`（每次最多 40 行）、`book.read {course?, hid, file?: 'gen' | 'mine' | 'qa', offset?}`（正文合计 4 500 字符，`more: {file, offset}` 接着读）、`book.coverage {course?, hid}`：lib/book-agent-read.js，只读；`book.toc` 先像 `course.book.open` 一样把书更新到最新（没有就建，总纲重整后重新对应）。每个结果都在宿主截断工具结果的 8 192 字符以内。按有质量把关的流程写成的书（[课程总纲](course-outline.zh-CN.md#复习全书讲解层)），`book.toc` 还给每个知识点 `concepts: 'N/M'`（清单里必讲条目讲到了几个），未达标的带 `short: true`，并给出全书三层的 `coverage`；`book.coverage` 多一项 `concepts {covered, total, status, missing?}`，列出还缺的名字。被截断的文件还会带 `truncated: true` 和 `nextOffset`；`offset` 只在同时给出 `file` 时有效（不带 `file` 时会以 `book-offset-needs-file` 拒绝，不会悄悄从头读）。
- `source.pages {sourceId | documentId, from?, to?, offset?, hid?, course?}`：lib/book-pages.js，最多 4 页、6 000 字符（`next: {from, offset?}`，`end: true`）；学习库自己的清单（考点清单、总纲、复习全书本身）会被拒绝。显示过的内容由 lib/book-reading.js 记在学习库文件夹下的 `book-history/reading.json`（每份资料读过的字符区间、每个知识点的工作打开过哪些资料、每个知识点写入时被拿掉的引文），经临时文件和改名写入；它不在学习库里，也不进可携带备份。
- `book.write {course?, hid, file?, markdown | section: {heading, markdown} | edits: [{find, replace}], version?}`：lib/book-agent-write.js，脚注规则在 lib/book-footnotes.js，引文定位是 lib/book-quote.js（和复习全书的生成共用）。每次最多 20 000 字符、20 处替换。它走书的写入队列（lib/course-book-writer.js），在一个存储事务里按 `course.book.save` 的规则保存（lib/course-book-edit.js），所以书页上的保存和主会话的写入一个接一个进行。脚注按书的格式写回，`[^n]: [「原文」](studyhub://source/<id>) · 标题`，在「出处」下作为一组按顺序编号（保存前会检查；文件里有好几组 `[^1]`…`[^n]` 时合成一组，每个角标保留它后面那一组里的脚注；和文件里一字不差的脚注再找不到时原样保留并在 warnings 里列出，按替换、按节写入、整份写入时原样抄回都是如此；整份写入时脚注和角标都没写回，这条脚注就去掉；角标写回了、脚注没写回，也照样保留（角标沿用文件里同号的脚注，并给出提示）；新文本里没有自己脚注的角标沿用文件里同号的脚注，并给出提示；定义行写成全角冒号 `：` 也认）。引文读到与开头配对的那个引号为止，角标从不算进引文（lib/quote-match.js 和 lib/quote-locate.js 的比较键不含 `[^n]`）；标题放在知识点自己的标题之下；「练 5 道」那一行保持在最后；问答块、答题卡和 AI 块原样保留。整份写入的 `version` 过期时，保存主会话的文本，另一份作为建议保留；按节写入或替换则作用在文件现在的样子上。返回 `{status, hid, file, name, version, dropped: [{n, quote, reason, again?}], outsideCount, warnings, advice?, note?}`；warnings 会指出语言和书不一致、资料页还没打开、文件里的块不见了。拒绝码：book-write-mode、book-write-too-long、book-edit-find、book-footnote-in-use（替换删掉了仍有角标的脚注：会列出角标和处数）、book-footnote-check、book-section-missing、book-file-invalid、book-point-missing、book-point-not-leaf、course-book-missing。
- 「发给主会话」：消息是登记表里的 `book.edit`（ui/agent-prompts/index.js，技能 `study-book`）；ui/agent-prompts/book.js 的 `bookEditPrompt({course, hid?, title?, files, version, coverage, selection?, instruction, scope: 'point' | 'selection' | 'book'}, language)` 给出各部分，ui/agent-prompts/message.js 排版（纯函数；两种语言；不含书的正文；标题是名字片段，选中的话在数据围栏里，学习者的要求在 request 围栏里）。框是 ui/book/BookAsk.jsx（`AskForm`；整本书是「更多」里的一项，ui/book/more-actions.js），选区工具条是 ui/book/BookSelectBar.jsx，两者在 ui/book/BookAskLayer.jsx 里接起来；发出去的路径是 ui/book/send-to-chat.js 的 `useSendToChat(course)`（读这个知识点的 `book.coverage`，再调用 `askInChat`：宿主的对话输入框，否则剪贴板）。测试：tests/book-send-to-chat.test.mjs、tests/book-send-to-chat-browser.test.mjs。
- 技能在 lib/study-skills.js：`skills/<名字>/SKILL.md`（YAML 头部 `name`、`description`、`whenToUse`），宿主注入 `skills` 时用 `ctx.skills.register` 注册。工具说明是 `library.context` 的 `book` 区。
