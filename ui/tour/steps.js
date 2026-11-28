/* The feature tour ("重点切换指引", plan §4 C7) as data. Each step names the
   page to switch to, what to prepare there (open the sample lecture, start a
   sample practice round…) and the `data-tour` anchor to highlight; a list of
   anchors is tried in order. Copy is Chinese source text that the popover
   passes through ui(); the English lives in ui/locales/en.onboarding.json.
   tests/wp5-tour-steps checks the anchors against the UI source.

   There are two tours over the same list. The DEFAULT tour is the core chain
   in the first-run line's order (3.6 D5: the model, add a material, make
   questions, check the draft, practise; 任务 is only in the full tour), a
   minute or two of reading; the FULL tour is the explicit extra, offered at
   the end of the short one and in Settings, in the list's order. A step says
   which it belongs to:
     core: true     in both tours, with one text;
     only: "core"   only in the short tour (a shorter text for a page the full
                    tour spends three steps on);
     (neither)      only in the full tour.
   A core step keeps one `body` for the short tour; where the full tour says
   more, that is its `fullBody`.
   Every step has a `chapter` (TOUR_CHAPTERS). The list is written in the
   learning order and each chapter is one piece of it: the full tour walks it
   as written, the card's header says the chapter, and 跳到下一章 goes to the
   next one's first step. The short tour has no chapters: its ending is the
   list's last, and 「更多」 over it would promise more steps.
   The short tour runs in CORE_ORDER. Its last step depends on the library:
   while the first-run line is up (`line: true`, the context's `line`), it
   ends on the line's step 2 on the library home; otherwise (`line: false`) on
   Settings, as the full tour does. */

/** The chapters in the learning order, each with the card's header: a whole sentence per chapter, so each has its own English (前置 here is not the coverage view's 前置). */
const CHAPTER_HEADINGS = Object.freeze({ "开始": "功能导览 · 开始", "前置": "功能导览 · 前置", "备料": "功能导览 · 备料", "练习": "功能导览 · 练习",
  "复习": "功能导览 · 复习", "考试": "功能导览 · 考试", "更多": "功能导览 · 更多" });
export const TOUR_CHAPTERS = Object.freeze(Object.keys(CHAPTER_HEADINGS));
export const chapterHeading = (chapter) => CHAPTER_HEADINGS[chapter];

/** Which order of the full tour's list a paused full tour's step belongs to (ui/tour/progress.js). It goes up when steps move or are put before others:
    the step a learner paused on then no longer says which steps they have seen. (1, never written down, is the order before 5.4.1.) */
export const FULL_TOUR_ORDER = 2;

export const TOUR_STEPS = [
  { id: "welcome", chapter: "开始", core: true,
    title: "欢迎来到 StudyHub",
    body: "导览用一门示例课程（设计模式）带你看一遍主线：模型在哪里设置、添加资料、出题、检查草稿、练习。示例内容都标着「示例」，看完可以一键移除。" },
  { id: "flow", chapter: "开始", page: "library",
    title: "怎么学：前置 → 每天一轮 → 复习",
    body: "前置是配模型、填考试日期，之后每学完一章备一次料：导入、出题、检查草稿、发布。练习是每天一轮「今日学习」，先想再答，答错当场弄懂。复习不用自己排：到期题自动进每天那一轮；每周回头清错题、看薄弱主题；单元末限时模拟。导览按这个顺序走。" },
  // While the sidebar is a drawer (a narrow window, or put away) it is behind the top bar's menu button (#657): the step then lights that button. A step
  // that introduces a page lights that page's own heading instead (#1712).
  { id: "nav", chapter: "开始", page: "library", anchor: ["nav", "nav-menu"], placement: "right",
    title: "左侧是全部功能",
    body: "上面是最常用的几项：学习库、资料、创建题组、错题与待巩固、模拟考试、统计。其余的按内容收在「更多」里：资料与出题、练习与复习、考试与统计、任务、笔记与待办；按住一项拖到上方，就放进常用的几项。底部是「找功能」（Ctrl K，选中后直接带你过去）、「帮助」（导览、快捷键、名词解释）和「设置」，语言和外观在「设置 › 界面」。窗口窄或收起侧栏时，点左上角的菜单按钮打开导航。" },
  { id: "finder", chapter: "开始", page: "library", anchor: ["nav-finder", "nav-menu"], placement: "right",
    title: "记不住入口？找功能",
    body: "按 Ctrl K（或点侧栏「找功能」）输入关键词，选中后直接带你过去。任何页面按 ? 看这一页的快捷键，按 S 继续上一轮或开始今日学习。" },
  { id: "settings-model", chapter: "前置", core: true, page: "settings", anchor: "settings-model",
    title: "设置：学习库与 AI 模型",
    body: "出题、讲解和提问需要一个 AI 模型；复习练习和这次导览都不需要。这里选学习库放在哪个文件夹，也选用哪个模型出题；模型的密钥在 DSH 的「设置 › 模型」里填，不在这里填。",
    modelNote: "还没有可用的模型：先在 DSH 的「设置 › 模型」里填好密钥，再回到这里选用它。",
    readyNote: "已连接：{0}" },
  { id: "course", chapter: "前置", page: "library", anchor: ["home-course", "home-hero"],
    title: "课程：考试信息与倒计时",
    body: "每门课可以记下考试形式、总分、作答和阅读时间、考试日期，课程标题旁会显示距考试还有几天。在这个标题的下拉菜单最后选「课程设置…」，还能放入老师的考试说明和重点知识点，出案例题、批改和模拟考试都会按它来。" },
  { id: "appearance", chapter: "前置", page: "settings", anchor: "settings-appearance",
    title: "界面按你的习惯调",
    body: "「设置 › 界面」换语言、深色或护眼纸色、整体大小。嫌首页和侧栏太满，打开最上面的「简洁版」，只留练题常用的部分，随时能切回。" },
  { id: "sources", chapter: "备料", core: true, page: "sources", anchor: ["sources-add", "sources-list"],
    title: "资料：先把讲义添加进来",
    body: "点「添加资料」：PDF、Word、PowerPoint、Markdown、保存下来的网页文件（.html）和文本都可以，原文件会完整保留；也可以直接粘贴文字。一份文档就是一项资料，多页 PDF 也不会被拆散；上百页的大教材会提示先转换成带页码的文字。" },
  { id: "document", chapter: "备料", page: "sources", prepare: "openSampleDocument", anchor: ["source-tools", "reader-more"], placement: "left", needs: "sourceId",
    title: "在原文里提问、出题",
    body: "这是示例讲义的原文。标出的段落已经关联了题目和解析；选中任意一段文字，就能就这段提问，或者用它出几道题。工具栏里红色的「AI 出题」会用整份资料出题；查找、翻译、显示设置和学习工具在最右边的「更多」里。PDF 资料在「原始 PDF」里按页提问：用翻页按钮换页，点预设直接问；图表或扫描页可以发给主会话，截图只在主会话能看图片时有用。" },
  { id: "reader-practice", chapter: "备料", page: "sources", prepare: "openSampleDocument", anchor: "reader-practice", needs: "sourceId",
    title: "读完就练：做这几页的题",
    body: "点「AI 出题」右边的小箭头，「做这几页的题」会数出这几页关联了多少道题、几道到期，点一下就开始练；这几页还没有题时，同一个面板可以为它们出题。" },
  { id: "translation", chapter: "备料", page: "sources", prepare: "openSampleDocument", anchor: "reader-more", needs: "sourceId",
    title: "中英对照翻译",
    body: "工具栏最右边「更多」里的「翻译…」把这一页或这一章译成中文或英文，译文显示在对应段落旁。翻译在后台进行，可以继续阅读；已有的译文不需要模型。",
    modelNote: "翻译需要 AI 模型；已有的译文照常显示。" },
  { id: "generate-quick", chapter: "备料", only: "core", page: "generate", prepare: "prepareGenerate", anchor: "generate-summary", placement: "top",
    title: "出题：选好资料就能生成",
    body: "勾选要出题的资料，题型、题数和难度保持默认就行，再点这里的生成按钮。AI 出的题先进入草稿，你检查过再发布。",
    modelNote: "出题需要先配置 AI 模型，在哪里设置见导览第 2 步。" },
  { id: "generate", chapter: "备料", page: "generate", prepare: "prepareGenerate", anchor: "generate-sources", placement: "right",
    title: "创建题组：选资料",
    body: "勾选要出题的资料；资料多时可以按名称筛选，转换过的大教材用「选择章节」只选这次要考的几章。已经有现成的题目，用页面上方的第二个入口直接导入。",
    modelNote: "出题需要先配置 AI 模型，在哪里设置见前面的「前置」一章。" },
  { id: "generate-tune", chapter: "备料", page: "generate", prepare: "prepareGenerate", anchor: "generate-options", placement: "left",
    title: "题型和覆盖强度",
    body: "题型和「覆盖强度」就在这里：覆盖强度分精简、标准、完整，想自己定题数就选「自定义」。难度、语言、公式写法、花费上限都收在「更多选项」里。不知道练什么？展开「更多选项」点「帮我想想」，它只发送资料标题和目录，不发送全文；没有模型时，会改用你的错题给建议。" },
  { id: "generate-cost", chapter: "备料", page: "generate", prepare: "prepareGenerate", anchor: "generate-summary", placement: "top",
    title: "开始前先看一眼用量",
    body: "摘要行写明这次出什么题；「预计 … tok」是按真实提示词估算的 token 用量。出题完成后，任务详情的「实际用量」会列出真实消耗和缓存命中。" },
  { id: "tasks", chapter: "备料", page: "tasks", anchor: ["nav-tasks", "tasks-head"], placement: "right",
    title: "任务：后台工作的进度",
    body: "出题、音频转写这类要等一阵的工作在后台进行，可以边等边做别的；进度、暂停、停止和重试都在「任务」里。" },
  { id: "draft", chapter: "备料", core: true, page: "draft", prepare: "openSampleDraft", anchor: "draft-publish", placement: "top", needs: "draftId",
    title: "草稿：检查后再发布",
    body: "AI 出的题先放进草稿。你可以逐题核对、修改或删除，确认无误再发布，发布后就能开始练习。保存和发布都在页面底部的这一栏里。这是一份示例草稿。" },
  { id: "draft-check", chapter: "备料", page: "draft", prepare: "openSampleDraft", anchor: "draft-question", needs: "draftId",
    title: "发布前抽查几道",
    body: "抽查 3–5 道，看三件事：答案在引用的原文里找得到依据；考的是知识本身，不是「资料里说了什么」；答案只有一个。引用和结构由代码检查，内容仍可能出错。点「发布并开始练」时不再让模型复审，结构有问题的题也会发布：还能判分的，练习时标着「待核对」；缺答案、选项不全等判不了分的，练习时只能跳过（不计成绩）或「交给后台修题」。" },
  { id: "home", chapter: "练习", page: "library", anchor: ["home-today", "home-hero"],
    title: "学习库：今天学什么",
    body: "首页根据到期复习、错题和新题排好今天的计划，点一下就开始。一轮默认最多 20 题（在「设置 › 练习」改），顺序是到期 → 薄弱 → 新题，新题最多占一半。所有题组按课程整理在下方。" },
  { id: "practice", chapter: "练习", core: true, page: "review", prepare: "startSamplePractice", anchor: "review-question", needs: "deckId",
    title: "练习：答题、看解析",
    body: "选择题会逐项说明对在哪、错在哪；闪卡先回忆再翻面自评。每次作答后，系统按记忆曲线安排下一次复习。题目下方有三个帮手：「帮我弄懂」把讲解放在这道题下面，「修题」直接改这张卡，「更多」里的「出前置题…」补一道更基础的题。试着答一题吧。" },
  { id: "grading", chapter: "练习", page: "review", prepare: "startSamplePractice", anchor: "review-question", needs: "deckId",
    title: "闪卡和开放题：0–5 怎么选",
    body: "想完再按 Space 翻面，按 0–5 自评。0、1 是想不起来，本轮末尾重练；2 是说不完整；3 费劲想起来；4 顺利答出；5 能讲给别人听——选 5 这道题立刻算「已掌握」，别随手点。按错了按 Z 撤销。" },
  { id: "help", chapter: "练习", page: "review", prepare: "startSamplePractice", anchor: "review-help", needs: "deckId",
    title: "卡住了？点「帮我弄懂」",
    body: "后台助教会结合原文讲解这道题、补上前置知识。讲解会出现在这道题下面的问答里，完成时信箱会提醒你，不打断你做题。想一步步想清楚，点旁边的「带学」，在题目旁开一段一问一答的对话。觉得题目本身有问题，点「修题」，助教会直接改这张卡；基础不牢，点「更多」里的「出前置题…」，或讲解下面的「出成前置题」，在同一题组里补一道更基础的题。",
    modelNote: "这项功能需要 AI 模型。" },
  { id: "guided-study", chapter: "练习", page: "review", prepare: "startSamplePractice", anchor: "review-help", needs: "deckId",
    title: "AI 带学：边讲边练",
    body: "在主会话里说一句就能开始，比如「带我学条件概率，每讲完一个点就出一道题考我」。主会话讲一个点，当场按你的资料出一道经过审核的题，放到右侧带学工作台让你做；做错了可以点「请教主会话」。更多说法和默认设置在「设置 › 引导 › AI 带学」。",
    modelNote: "AI 带学需要配置 AI 模型。" },
  { id: "round-end", chapter: "练习", page: "library",
    title: "做完一轮，先看本轮题目",
    body: "结算页的「本轮题目」列出这轮错了、没掌握和没答的题：点开回看你的答案、正确答案和问答；有错题时可以「先遮答案自测」再考自己一次，或直接重练错题。能说出为什么错，这一轮才算收尾。" },
  { id: "mastery", chapter: "复习", page: "library", anchor: "home-mastery", needsDeck: true,
    title: "掌握度看的是记得多久",
    body: "掌握度把每道题按级别折算再取平均，不是正确率：未学、薄弱、学习中（间隔不到 6 天）、熟悉（6 天以上）、已掌握（连续答对、间隔累积到 3 周以上，或自评「轻松掌握」）。刚学完全答对，数字也不会马上很高，隔几天再答对才升。" },
  { id: "wrongbook", chapter: "复习", page: "wrongbook", anchor: ["wrongbook-recs", "wrongbook-list"],
    title: "错题与待巩固：举一反三",
    body: "答错或自评没掌握的题会按题组收好（错题多了可以切换成按主题，也有按题组、状态的筛选和搜索）。「为你推荐」直接从题库里找相似的题，不消耗模型；想再练一遍，在「重练」里选好范围（只练错题，或加上同类题、变式），再点「开始重练」；也可以为错题生成变式（需要模型）。" },
  { id: "dashboard", chapter: "复习", page: "dashboard", anchor: ["dashboard-charts", "dashboard-summary"],
    title: "统计：看见自己的进步",
    body: "分数趋势、未来 14 天的到期复习预测和各主题的掌握程度都在这里，页面底部的「模型用量」按功能列出 token 消耗。图里是示例的三周练习。" },
  { id: "outline", chapter: "复习", page: "outline", anchor: "outline-tree", needsDeck: true,
    title: "总纲：找没覆盖的章节",
    body: "资料按章节排成树，每一节能看掌握情况、直接练这一节；看到哪节没题，就回去补。这样看不花 token；「生成总纲」和「生成复习全书」要用模型，整本书比较费。" },
  { id: "exam", chapter: "考试", page: "exam", anchor: "exam-case",
    title: "模拟考试：三种考试形式",
    body: "在这里切换选择题笔试、案例分析卷和口头面试，都是限时作答。交卷后给出成绩单和逐题解析；案例卷按评分标准逐项批改，示例里有一套已经批改好的案例。",
    modelNote: "批改需要 AI 模型；示例里的批改结果不需要。" },
  { id: "examprep", chapter: "考试", page: "examprep", anchor: ["nav-examprep", "examprep-head"], placement: "right",
    title: "备考补习：考前补漏",
    body: "把课件和样卷整理成一份考点清单：哪些样卷考过，哪些是补充，每个考点出自课件的哪一页。整理在后台进行，进度在「任务」里看。",
    modelNote: "整理考点清单需要 AI 模型。" },
  { id: "exam-plan", chapter: "考试", page: "exam",
    title: "考前怎么安排",
    body: "考前约三周起，每天照常做今日学习，每周限时模拟一两套；考前一周主攻错题、顽固题和需要补强的主题；最后一两天只回顾，不大批出新题。课程设置里填了考试日期，复习安排会对齐考试（「考前对齐」默认开着）。考完把课程设为未激活。" },
  { id: "notes", chapter: "更多", page: "notes", anchor: ["nav-notes", "notes-head"], placement: "right",
    title: "学习笔记：把想法留下来",
    body: "练习时点「写笔记」存下的笔记，和每日讲解合集，都收在这里。笔记可以跳回对应的题，也可以存入资料库，再用资料页的阅读功能打开。" },
  { id: "skeleton", chapter: "更多", page: "skeleton", prepare: "openSampleSkeleton", anchor: "skeleton-main",
    title: "知识骨架：把题连成一张图",
    body: "骨架用概念和关系把零散的题串起来，点一个概念就能看到相关题目，也可以切换成知识图谱。" },
  // The sidebar's 复习全书 opens the 总纲 page until a book is written; the tour stays there, since opening a book page could write the book's files.
  { id: "book", chapter: "更多", page: "outline", anchor: "outline-book", needsDeck: true,
    title: "复习全书：能读的一本书",
    body: "把一门课的讲解和题串成一本书，读到哪一节就能练哪一节，速查表适合考前翻。写书要用模型，整本书比较费：先生成总纲就能看到预计用量，也可以只挑几章写。还没写书时，「更多 › 复习全书」打开的就是这个总纲页。" },
  { id: "board", chapter: "更多", page: "board", prepare: "openBoardToday", anchor: "board-today-head",
    title: "待办与专注计时",
    body: "「待办」的今日页列出今天要做的事。「今天先做什么」按到期和薄弱题给一份安排（也可以请 AI 重排），接受后才建待办；点「开始专注」用番茄钟计时。" },
  { id: "settings-audio", chapter: "更多", page: "settings", anchor: "settings-audio", context: "audio",
    title: "音频转写",
    body: "导入讲课录音，自动转成可以出题的文字资料。国内网络可以选免费的硅基流动（国内直连），不需要海外网络。「课堂实录」边上课边转写；支持的电脑可以装本地引擎，不需要密钥，声音不上传。" },
  { id: "settings-extensions", chapter: "更多", page: "settings", anchor: ["settings-extensions", "settings-update"],
    title: "设置：检索扩展",
    body: "上百页的大教材，建议先用转换工具变成带页码的文字再导入；整本书出题时，可以让 DSH 里的检索工具只挑出相关页面。在「设置 › 关于与更新」可以检查新版本，有更新时侧栏底部也会提示。" },
  { id: "backup", chapter: "更多", page: "settings", anchor: "settings-backup",
    title: "备份与换电脑",
    body: "「导出学习库」得到完整备份：资料、题组、复习进度和作答记录；API 密钥、外观设置和只记了路径的原文件不在里面。换电脑后用「选择备份文件」恢复，替换前会先把当前数据另存一份。" },
  { id: "finish-line", chapter: "更多", only: "core", line: true, page: "library", anchor: ["first-run-material", "home-today"], final: true,
    title: "准备好了，换成你自己的资料",
    body: "点「添加资料」，就从首页这条线的第 2 步开始：资料加好后，第 3 步先写明要出什么、预计用多少，再由你点「出第一组题」。示例数据随时可以移除，不影响你自己的资料和记录。" },
  { id: "finish", chapter: "更多", core: true, line: false, page: "settings", anchor: "settings-sample", final: true,
    title: "准备好了，换成你自己的资料",
    body: "点「添加资料」就能开始。示例数据可以随时在这里移除，你自己的资料和记录不受影响。",
    fullBody: "点「添加资料」就能开始，示例数据可以随时在这里移除，你自己的资料和记录不受影响。之后的节奏：每天一轮，每周回头清错题，单元末限时模拟；导览随时能从「帮助」里重开。" },
];

/** The short tour's order, the first-run line's (3.6 D5): 欢迎 → 设置·模型 → 资料 → 出题 → 草稿 → 练习 → 完成 (one of the two last steps). */
export const CORE_ORDER = Object.freeze(["welcome", "settings-model", "sources", "generate-quick", "draft", "practice", "finish-line", "finish"]);

/** Is the step in the short (core) tour, or in the full one? */
export const inCoreTour = (step) => step.core === true || step.only === "core";
export const inFullTour = (step) => step.only !== "core";

/** How many steps the short tour has once the sample is loaded (the number the welcome page may say): one of its two last steps is shown. */
export const CORE_TOUR_LENGTH = TOUR_STEPS.filter((step) => inCoreTour(step) && step.line !== true).length;

/** Every Chinese source string a step can show (title, body, notes). */
export const tourStepCopy = (step) => [step.title, step.body, step.fullBody, step.modelNote, step.readyNote].filter(Boolean);

/**
 * The steps this library can show: a step that needs the sample (its lecture,
 * draft or deck), a page or a component that is not there is left out.
 * ctx: { sample, pageAvailable(page), hasContext(id), full, line, hasDeck } — `full` picks the
 * full tour; the default is the short one, in CORE_ORDER; `line` says the
 * first-run line is up (the short tour then ends on its step 2); `hasDeck` says a
 * published deck is there (a `needsDeck` step talks about what only one brings).
 */
export function availableTourSteps(steps, { sample, pageAvailable = () => true, hasContext = () => true, full = false, line = false, canChat = true, hasDeck = true } = {}) {
  const shown = steps.filter((step) => (full ? inFullTour(step) : inCoreTour(step) && (step.line === undefined || step.line === !!line)) &&
    (canChat !== false || step.id !== "guided-study") &&
    (!step.needs || (sample?.loaded && sample[step.needs])) && (!step.needsDeck || hasDeck) && (!step.page || step.page === "draft" || pageAvailable(step.page)) && (!step.context || hasContext(step.context)));
  if (full) return shown.map((step) => (step.fullBody ? { ...step, body: step.fullBody } : step));
  const rank = (step) => { const at = CORE_ORDER.indexOf(step.id); return at < 0 ? CORE_ORDER.length : at; };
  return shown.map((step, at) => ({ step, at })).sort((a, b) => rank(a.step) - rank(b.step) || a.at - b.at).map(({ step: { chapter: _chapter, ...step } }) => step);
}

/** The id of the step before (-1) or after (+1) `id`; a vanished step restarts at the first. */
export function tourNeighbour(steps, id, direction) {
  const index = steps.findIndex((step) => step.id === id);
  if (index < 0) return steps[0]?.id ?? null;
  return steps[index + direction]?.id ?? null;
}

/** The first step of the chapter after the one `id` is in (跳到下一章); null in the last chapter and for a step that is not there. */
export function tourNextChapter(steps, id) {
  const at = steps.findIndex((step) => step.id === id);
  if (at < 0) return null;
  return steps.slice(at + 1).find((step) => step.chapter !== steps[at].chapter)?.id ?? null;
}

/** A step that came from the sidebar (the whole sidebar or one of its entries): the card also keeps off the first block of the page it opens (#1712). */
export const opensFromNav = (step) => /^nav(-|$)/.test([step.anchor].flat()[0] || "");

/** ←/→ move, Esc pauses; anything with a modifier belongs to someone else. */
export function tourKeyAction(event) {
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return null;
  return { ArrowRight: "next", ArrowLeft: "back", Escape: "close" }[event.key] || null;
}
