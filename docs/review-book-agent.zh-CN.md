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

## 整理书的结构

也可以让主会话整理书的结构：给章或知识点改名（「把 2.3 改名为『进程与线程』」）、把知识点移到别的章或另一个知识点旁边、删掉不需要的知识点或章；在一个知识点里插入、改名、移动、删除小节。这些都不会重新整理总纲，也不发送书的正文：主会话按 id 指明章、知识点和标题。新的小节放在它该在的位置，而不是文件末尾。插入或改名小节时，这个知识点的文件里已有的标题会被拒绝（空格、大小写、同一个标点的全角和半角不算不同：「十一、性能测试」和「十一，性能测试」是同一个标题；编号算：「十二、性能测试」是另一个）；整点重写、按节写入或替换之后出现两个同名标题时，会告诉主会话，不会悄悄留着。删掉的知识点或小节不留空标题，也不留占位文字；你在被删的知识点里写的东西不会被直接扔掉，而是移到「未归位」，在这个知识点的标题下。删除一章时，它下面的知识点放到它原来的位置（你要求的话也可以一起删掉）；一章没有知识点了会空着留下，要再删一次。会让标题超过第 6 级（或高过第 1 级）的移动会被拒绝。每次改动都保留上一版：让主会话撤回即可（它用 `course.book.revert`），从最近的一次往前，前提是总纲还没有重新生成（「重新整理」，或者资料、样卷变了时「更新全书」生成了新的总纲），而且是最近 10 次结构改动之内（删掉的知识点很大时更少）。撤回时，改动之后你又编辑过（或者用「回退到上一版」退过）的文件保持原样，并会说明是哪几份。「回退到上一版」替换掉的内容也会留着，主会话可以再拿回来（`redo`）。这两种副本都存在版本历史里，而版本历史只保留有限的几版：「未归位」里的那一份才是一直在的。所以整理「未归位」请直接编辑它，不要对它「回退到上一版」：那样会把这些笔记又从「未归位」里拿出来，之后只能靠撤回那次删除（总纲没变时）或那次重做找回。以后总纲重新生成时，书会按新总纲重新排：你给知识点起的名字跟着知识点留下，章的名字只在新总纲给这一章的名字和原来一样时才留下，移动和删除不保留。

## 从书页发给主会话

书页可以替你把消息填进对话的输入框（只填入，不会发送；你看过再按发送）。消息第一句是你自己的话（要对哪个知识点做什么，知识点标题作为名字写在句子里），紧接着是放在围栏里的你的要求，所以输入框里先看到的就是你要的。空一行之后，在「StudyHub 附注（给助手）」下面，每行一条写主会话要用的：先读 `study-book` 技能、用 `book.read` 读这一节，课程和知识点，这一点的文件和生成文件的版本，资料页读了几页，规则（可核对的脚注、按书的语言标资料以外、一次只写一个小节），做完汇报什么（每次改动都保留上一版，`course.book.revert` 可以退回），以及一行说明围栏里是什么；选中的话随后放在数据围栏里，最后是语言句。消息里没有书的正文：主会话自己读。

- 知识点标题旁的「问 AI」（见[读的时候问 AI](review-book.zh-CN.md#读的时候问-ai)）：一个框，五个预设（「讲细点」「加个例子」「润色成大白话」「加过渡」「还漏了哪些小知识点、要不要补进来」），两个去处；「发给主会话」就是发到这里。框可以留空（消息会请主会话把这一节改得更清楚易读）。按 Escape 关闭，焦点回到「问 AI」。它不需要应用里设置模型。
- 选中几句话：工具条上的「发给主会话」直接把它们（放在数据围栏里，不带角标数字）连同这一个知识点发过去，请主会话只改与它们有关的地方；「写一段…」打开同一个框，选中的话在最上面，在框里写的要求也一起发。
- 书栏「更多 › 整本书 › 发给主会话」：点了直接发（没有表单；想提要求就在主会话的输入框里写）；消息里没有具体知识点，请主会话先说哪些知识点最值得改、等你挑好再写，并从 `book.toc` 开始一次一个知识点。

发生了什么，页面底部会出一张盖章回执：「已填进主会话的输入框」（5 秒后收起；应用已经切到主会话）；输入框里你已经写了字时是「输入框里你写的字都留着」（消息改为复制，宿主能切到主会话时带「去主会话」）；宿主没有对话输入框时（单独打开应用）是「已复制到剪贴板」（「看看内容」打开消息）。浏览器不让用剪贴板时，整条消息会在一张卡片里打开，有「复制全文」和全选兜底；只有不复制就关掉卡片，才会留下「需要手动复制」那张回执。你也可以不点任何按钮，直接在主对话里说想怎么改书。

## 在大书里只改一处

改文件里的一处，不需要把整份文件发过去，所以 `course.book.save` 没有「增量」模式。`book.write` 本来就能只改文件的一部分：某个标题下的一节（`section`）、几处精确替换（`edits`），或者对小节的一次 `op`（插入、删除、改名、移动），每次最多 20 000 字符。它们不要 `version`：直接作用在文件现在的样子上，所以主会话和书页不会互相覆盖对方改的其他文字（只有整份 `markdown` 写入才和 `version` 比较；主会话的文字照样保存，另一边的文字留作建议）。实测：一本 120 个知识点的书，其中一个知识点的文件有 1 826 010 字符（上限 2 000 000）；写一节用 0.26 秒，回答 188 字符；给另外 20 个知识点各写一次约 3 秒（每次都要写整个库，约 0.15 秒）；用 `heading` 或 `offset` 读那份文件，回答约 7 000 字符。

- 要读到长文件深处的一节，用 `book.read {hid, file, heading}`（标题 id，没有就用标题文字）：文字从那个标题开始，标题列表也从那里往后列。以前它只列文件最前面的 30 个标题，后面的 id 只能把文件按每次 5 500 字符整份读完才能知道。
- 想先看一本长书的整体结构，用 `book.toc {compact: true}`：只给 `hid`、`n` 和标题（章的行带 `chapter: true`），每次 60 行而不是 30 行。400 个标题很长的知识点，从 11 次调用、73 000 字符降到 7 次、41 000 字符。每个知识点仍然用 `book.read` 读。
- 主会话不用 `course.book.save` 或 `course.book.open` 做这件事。`course.book.save` 是书页自己的保存（整份文件进、整本书出）：保存那份 180 万字符的文件后，回答有 190 万字符，宿主在 8 192 字符处截断，主会话连自己的保存状态都看不到。
- 不提供一次写好几个知识点：每个知识点都要先 `book.read`、`source.pages`（一次改写的调用主要花在这里），每次写入本来就很小，而且一批里某一次失败，剩下的怎么办还得另定规则。

## 长时间的工作

主会话的每次调用都刻意做得很小：宿主会截断太长的工具结果，而 Auto 权限模式会带着之前所有调用一起审查每一次调用，整份文件地写，对话很快就会超长。对话变长时，主会话会把手上这一点做完，说清停在哪里，并建议开一个新对话继续；Auto 模式下最好每章开一个新对话。在新对话里说「从 3.2 接着写」就行。

### 权限审查本身出错时

权限审查（auto-review）属于 DSH 宿主，不是 StudyHub 的一部分：StudyHub 既不运行它，也没有任何声明能把它打开或关掉。如果宿主的审查服务不可用，或者它自己的请求被拒绝（主会话看到的是 `INVALID_REQUEST` / 400，读取类调用如 `book.toc` 和写入类调用都会遇到），这次调用没有改动书里的任何内容。请等几分钟再试，或者开一个新对话（对话越长，审查请求越大），或者换成会逐次询问你的权限模式，自己点同意。主会话会被要求停下来如实说明，而不是反复重试，也不会改用更重的调用（比如 `course.book.save`）。这类故障要由 DSH 项目去修，StudyHub 修不了。

## 让技能可用

插件在带技能注册表的 DSH 里启动时会自己注册 `study-book`，在有技能工具的会话里（学习预设有）技能列表就能看到它。如果你的主会话里看不到 `study-book`，把已安装插件里的 `skills/study-book` 文件夹复制到 `~/.dsh/skills/study-book`（也就是文件在 `~/.dsh/skills/study-book/SKILL.md`），DSH 也会从那里读技能。插件自己从不往它的文件夹和学习库以外的地方写东西。

## 开发者

- `book.toc {course?, offset?, limit?, compact?}`（每次最多 40 行；`compact: true` 时是 `{hid, n, title}` 行，章带 `chapter: true`，每次最多 60 行）、`book.read {course?, hid, file?: 'gen' | 'mine' | 'qa', offset? | heading?}`（正文合计 4 500 字符，`more: {file, offset}` 接着读；`heading`（标题 id 或标题文字）让文件的正文从那个标题开始，文件里没有时以 `book-section-missing` 拒绝，和 `offset` 一起给以 `book-read-heading-offset` 拒绝，不带 `file` 以 `book-offset-needs-file` 拒绝；`headings` 从正文开始处往后列 30 个）、`book.coverage {course?, hid}`：lib/book-agent-read.js，只读；`book.toc` 先像 `course.book.open` 一样把书更新到最新（没有就建，总纲重整后重新对应）。每个结果都在宿主截断工具结果的 8 192 字符以内。按有质量把关的流程写成的书（[课程总纲](course-outline.zh-CN.md#复习全书讲解层)），`book.toc` 还给每个知识点 `concepts: 'N/M'`（清单里必讲条目讲到了几个），未达标的带 `short: true`，并给出全书三层的 `coverage`；`book.coverage` 多一项 `concepts {covered, total, status, missing?}`，列出还缺的名字。被截断的文件还会带 `truncated: true` 和 `nextOffset`；`offset` 只在同时给出 `file` 时有效（不带 `file` 时会以 `book-offset-needs-file` 拒绝，不会悄悄从头读）。
- `source.pages {sourceId | documentId, from?, to?, offset?, hid?, course?}`：lib/book-pages.js，最多 4 页、6 000 字符（`next: {from, offset?}`，`end: true`）；学习库自己的清单（考点清单、总纲、复习全书本身）会被拒绝。显示过的内容由 lib/book-reading.js 记在学习库文件夹下的 `book-history/reading.json`（每份资料读过的字符区间、每个知识点的工作打开过哪些资料、每个知识点写入时被拿掉的引文），经临时文件和改名写入；它不在学习库里，也不进可携带备份。
- `book.write {course?, hid, file?, markdown | section: {heading, markdown} | edits: [{find, replace}], version?}`：lib/book-agent-write.js，脚注规则在 lib/book-footnotes.js，引文定位是 lib/book-quote.js（和复习全书的生成共用）。每次最多 20 000 字符、20 处替换。它走书的写入队列（lib/course-book-writer.js），在一个存储事务里按 `course.book.save` 的规则保存（lib/course-book-edit.js），所以书页上的保存和主会话的写入一个接一个进行。脚注按书的格式写回，`[^n]: [「原文」](studyhub://source/<id>) · 标题`，在「出处」下作为一组按顺序编号（保存前会检查；文件里有好几组 `[^1]`…`[^n]` 时合成一组，每个角标保留它后面那一组里的脚注；和文件里一字不差的脚注再找不到时原样保留并在 warnings 里列出，按替换、按节写入、整份写入时原样抄回都是如此；整份写入时脚注和角标都没写回，这条脚注就去掉；角标写回了、脚注没写回，也照样保留（角标沿用文件里同号的脚注，并给出提示）；新文本里没有自己脚注的角标沿用文件里同号的脚注，并给出提示；定义行写成全角冒号 `：` 也认）。引文读到与开头配对的那个引号为止，角标从不算进引文（lib/quote-match.js 和 lib/quote-locate.js 的比较键不含 `[^n]`）；标题放在知识点自己的标题之下；「练 5 道」那一行保持在最后；问答块、答题卡和 AI 块原样保留。整份写入的 `version` 过期时，保存主会话的文本，另一份作为建议保留；按节写入或替换则作用在文件现在的样子上。返回 `{status, hid, file, name, version, dropped: [{n, quote, reason, again?}], outsideCount, warnings, advice?, note?}`；warnings 会指出语言和书不一致、资料页还没打开、文件里的块不见了。拒绝码：book-write-mode、book-write-too-long、book-edit-find、book-footnote-in-use（替换删掉了仍有角标的脚注：会列出角标和处数）、book-footnote-check、book-section-missing、book-file-invalid、book-point-missing、book-point-not-leaf、course-book-missing。
- `book.write` 带 `op: 'insert' | 'delete' | 'rename' | 'move'`（#459，lib/book-section-ops.js）：把一个知识点文件里的小节当作一棵树来改，按标题 id 指明（book.read 会列出），不按标题文字。insert `{section: {heading, markdown}, after | before | within: id，或 position: 'start' | 'end'}`（文件里已有同名标题时以 book-section-exists 拒绝；`sameTitle` 不看任何空白、大小写、脚注角标和同一个标点的全角 / 半角，「、」算逗号、「。」算句号，文字、数字和编号照算；回答里的 `section.id` 是新标题的 id）；delete `{heading, children?: 'promote' | 'delete' | 'toUnplaced'}`（默认 promote 把子小节提一级；toUnplaced 还会写「未归位」，这一节的脚注改名为 `[^<hid>x<n>-<key>]` 并带上定义，「未归位」会超过 `FILE_TEXT_MAX` 时以 course-book-unplaced-full 拒绝；那份文件也保留自己的上一版）；rename `{heading, title}`；move `{heading, after | before | within | position}`（层级跟着新位置变；不能移到自己里面，也不能超过第 6 级：book-section-move-invalid）。每次 20 000 字符的规则、脚注核对和 `version` 的规则都和按节写入一样。拒绝码：book-write-op（会列出允许的 op 和位置）、book-write-mode、book-section-missing、book-section-exists、book-section-move-invalid、book-footnote-binding、course-book-unplaced-full。改名、移动、删除直接作用在文件的原文上，从不经过脚注流程：每个角标、脚注和「出处」列表都一字不差（几个列表共用 `[^1]` 的文件也一样）；移走或删掉的一节只带走外面没有角标引用的列表，外面有角标引用的列表留在原处（lib/book-footnote-binding.js 按 book.write 读文件的方式判断每个角标引用哪条：它后面第一条同号脚注，没有就最后一条）。放到另一节末尾的小节放在那一节结尾的「出处」列表之前；如果那样会让某个角标指向别的脚注，就放在列表之后；操作之后逐个角标核对它引用的脚注都没变（每个角标都被跟踪到操作之后，所以两个角标互换了脚注也算变了；会变时以 book-footnote-binding 拒绝，什么都不写）。代码块里的行对这些操作来说是代码：其中的标题、角标、脚注和列表都不会被改动或拆开（删除时把子小节提一级，是把它们当一整段来调整标题）。已知限制：普通写入（markdown、section、edits、insert；#477 的脚注读取）仍会把代码块里的 `[^n]: …` 行当作脚注。删除会带走只有被删部分的角标引用的脚注（以及因此空掉的「出处」标签）；toUnplaced 还会把它的角标引用的其他脚注复制一份到「未归位」，在那里所有标签改名为 `[^<hid>x<n>-<标签>]`。insert 像按节写入一样核对新小节的脚注。toUnplaced 删除的回答会说明：要把这一节放回去，用这个知识点文件的回退，不要回退「未归位」（那里的副本可能是唯一的一份）。离开知识点的文字（这里、course.book.delete、总纲重新整理时的合并和放入未归位）都经过 lib/book-parked-text.js：在代码之外改名脚注标签（中文标签也改），只去掉已不存在的那个知识点自己的练 / 问答链接（按标题 id 精确匹配；同一行里学习者的话保留）。按节写入时给出文件里没有的标题，仍然追加在文件末尾，并提示用 op insert；任何一次写入让文件里出现两个同名标题时都会给出提醒（`the file now has the heading "…" twice`）。书自己的章和知识点：`course.book.rename / move / delete`（[复习全书 · 开发者](review-book.zh-CN.md#开发者)），按 book.toc 给出的 `structureVersion` 做 compare-and-set。
- 「发给主会话」：消息是登记表里的 `book.edit`（ui/agent-prompts/index.js，技能 `study-book`）；ui/agent-prompts/book.js 的 `bookEditPrompt({course, hid?, title?, files, version, coverage, selection?, instruction, scope: 'point' | 'selection' | 'book'}, language)` 给出各部分，ui/agent-prompts/message.js 排版（纯函数；两种语言；不含书的正文；标题是名字片段，选中的话在数据围栏里，学习者的要求在 request 围栏里）。框是 ui/book/BookAsk.jsx（`AskForm`；整本书是「更多」里的一项，ui/book/more-actions.js），选区工具条是 ui/book/BookSelectBar.jsx，两者在 ui/book/BookAskLayer.jsx 里接起来；发出去的路径是 ui/book/send-to-chat.js 的 `useSendToChat(course)`（读这个知识点的 `book.coverage`，再调用 `askInChat`：宿主的对话输入框，否则剪贴板）。测试：tests/book-send-to-chat.test.mjs、tests/book-send-to-chat-browser.test.mjs。
- 技能在 lib/study-skills.js：`skills/<名字>/SKILL.md`（YAML 头部 `name`、`description`、`whenToUse`），宿主注入 `skills` 时用 `ctx.skills.register` 注册。工具说明是 `library.context` 的 `book` 区。
