/* The feature tour ("重点切换指引", plan §4 C7) as data. Each step names the
   page to switch to, what to prepare there (open the sample lecture, start a
   sample practice round…) and the `data-tour` anchor to highlight; a list of
   anchors is tried in order. Copy is Chinese source text that the popover
   passes through ui(); the English lives in ui/locales/en.onboarding.json.
   tests/wp5-tour-steps checks the anchors against the UI source.

   There are two tours over the same list. The DEFAULT tour is the core chain
   (add a material, make questions, practise, 任务, the model), a minute or two
   of reading; the FULL tour is the explicit extra, offered at the end of the
   short one and in Settings. A step says which it belongs to:
     core: true     in both tours, with one text;
     only: "core"   only in the short tour (a shorter text for a page the full
                    tour spends three steps on);
     (neither)      only in the full tour. */

export const TOUR_STEPS = [
  { id: "welcome", core: true,
    title: "欢迎来到 StudyHub",
    body: "导览用一门示例课程（设计模式）带你看一遍：先走主线（添加资料、出题、练习），再看任务和模型设置在哪里。示例内容都标着「示例」，看完可以一键移除。" },
  { id: "nav", page: "library", anchor: "nav", placement: "right",
    title: "左侧是全部功能",
    body: "左侧按用到的频率分成三组：「每天」是每次学习都会用的（学习库、资料、创建题组、任务、错题与待巩固、学习流、学习笔记、待办，每周来新讲义时加资料、出题也在这里）；「阶段性」是隔一阵用一次的（模拟考试、备考补习、统计；备考补习在 DSH 开启后才出现）；「课程准备与管理」是每门课开头做一次或按需用的（知识骨架、音频转写、课堂实录）。后两组可以点标题收起。底部可以切换语言和外观，按住条目拖动可以调整顺序。" },
  { id: "home", page: "library", anchor: ["home-today", "home-hero"],
    title: "学习库：今天学什么",
    body: "首页根据到期复习、错题和新题排好今天的计划，点一下就开始。所有题组按课程整理在下方。" },
  { id: "course", page: "library", anchor: ["home-course", "home-hero"],
    title: "课程：考试信息与倒计时",
    body: "每门课可以记下考试形式、总分、作答和阅读时间、考试日期，课程标题旁会显示距考试还有几天。在这个标题的下拉菜单最后选「课程设置…」，还能放入老师的考试说明和重点知识点，出案例题、批改和模拟考试都会按它来。" },
  { id: "sources", core: true, page: "sources", anchor: ["sources-add", "sources-list"],
    title: "资料：先把讲义添加进来",
    body: "点「添加资料」：PDF、Word、PowerPoint、Markdown、保存下来的网页文件（.html）和文本都可以，原文件会完整保留；也可以直接粘贴文字。一份文档就是一项资料，多页 PDF 也不会被拆散；上百页的大教材会提示先转换成带页码的文字。" },
  { id: "document", page: "sources", prepare: "openSampleDocument", anchor: ["source-tools", "source-tools-toggle"], placement: "left", needs: "sourceId",
    title: "在原文里提问、出题",
    body: "这是示例讲义的原文。标出的段落已经关联了题目和解析；选中任意一段文字，就能就这段提问，或者用它出几道题。右上角的「从这份资料出题」会用整份资料出题。" },
  { id: "reader-practice", page: "sources", prepare: "openSampleDocument", anchor: "reader-practice", needs: "sourceId",
    title: "读完就练：做这几页的题",
    body: "阅读器工具栏里的「做这几页的题」会数出这几页关联了多少道题、几道到期，点一下就开始练；这几页还没有题时，同一个按钮可以为它们出题。" },
  { id: "translation", page: "sources", prepare: "openSampleDocument", anchor: "translation-toggle", needs: "sourceId",
    title: "中英对照翻译",
    body: "工具栏的「翻译」把这一页或这一章译成中文或英文，译文显示在对应段落旁。翻译在后台进行，可以继续阅读；已有的译文不需要模型。",
    modelNote: "翻译需要 AI 模型；已有的译文照常显示。" },
  { id: "generate-quick", only: "core", page: "generate", prepare: "prepareGenerate", anchor: "generate-summary", placement: "top",
    title: "出题：选好资料就能生成",
    body: "勾选要出题的资料，题型、题数和难度保持默认就行，再点这里的生成按钮。AI 出的题先进入草稿，你检查过再发布。",
    modelNote: "出题需要先配置 AI 模型，导览快结束时会告诉你在哪里设置。" },
  { id: "generate", page: "generate", prepare: "prepareGenerate", anchor: "generate-sources", placement: "right",
    title: "创建题组：选资料",
    body: "勾选要出题的资料；资料多时可以按名称筛选，转换过的大教材用「选择章节」只选这次要考的几章。已经有现成的题目，用页面上方的第二个入口直接导入。",
    modelNote: "出题需要先配置 AI 模型，导览快结束时会告诉你在哪里设置。" },
  { id: "generate-tune", page: "generate", prepare: "prepareGenerate", anchor: "generate-options", placement: "left",
    title: "题型、难度和题数",
    body: "题型和难度是开关，题数由「覆盖强度」决定（精简、标准或完整），想自己定题数再展开「自定义题数」。不知道练什么？点「帮我想想」，它只发送资料标题和目录，不发送全文；没有模型时，会改用你的错题给建议。" },
  { id: "generate-cost", page: "generate", prepare: "prepareGenerate", anchor: "generate-summary", placement: "top",
    title: "开始前先看一眼用量",
    body: "摘要行写明这次出什么题；「预计 … tok」是按真实提示词估算的 token 用量。出题完成后，任务详情的「实际用量」会列出真实消耗和缓存命中。" },
  { id: "tasks", core: true, page: "tasks", anchor: "nav-tasks", placement: "right",
    title: "任务：后台工作的进度",
    body: "出题、音频转写这类要等一阵的工作在后台进行，可以边等边做别的；进度、暂停、停止和重试都在「任务」里。" },
  { id: "draft", core: true, page: "draft", prepare: "openSampleDraft", anchor: "draft-publish", needs: "draftId",
    title: "草稿：检查后再发布",
    body: "AI 出的题先放进草稿。你可以逐题核对、修改或删除，确认无误再发布，发布后就能开始练习。这是一份示例草稿。" },
  { id: "practice", core: true, page: "review", prepare: "startSamplePractice", anchor: "review-question", needs: "deckId",
    title: "练习：答题、看解析",
    body: "选择题会逐项说明对在哪、错在哪；闪卡先回忆再翻面自评。每次作答后，系统按记忆曲线安排下一次复习。试着答一题吧。" },
  { id: "help", page: "review", prepare: "startSamplePractice", anchor: "review-help", needs: "deckId",
    title: "卡住了？点「帮我弄懂」",
    body: "后台助教会结合原文讲解这道题、补上前置知识。讲解完成后送进信箱，不打断你做题。",
    modelNote: "这项功能需要 AI 模型。" },
  { id: "wrongbook", page: "wrongbook", anchor: ["wrongbook-recs", "wrongbook-list"],
    title: "错题与待巩固：举一反三",
    body: "答错或自评没掌握的题会按题组收好（也可以切换成按主题），能按题组、状态筛选。「为你推荐」直接从题库里找相似的题，不消耗模型；想再练一遍，可以为错题生成变式（需要模型），或一键重练。" },
  { id: "exam", page: "exam", anchor: "exam-case",
    title: "模拟考试：三种考试形式",
    body: "在这里切换选择题笔试、案例分析卷和口头面试，都是限时作答。交卷后给出成绩单和逐题解析；案例卷按评分标准逐项批改，示例里有一套已经批改好的案例。",
    modelNote: "批改需要 AI 模型；示例里的批改结果不需要。" },
  { id: "examprep", page: "examprep", anchor: "nav-examprep", placement: "right",
    title: "备考补习：考前补漏",
    body: "把课件和样卷整理成一份考点清单：哪些样卷考过，哪些是补充，每个考点出自课件的哪一页。整理在后台进行，进度在「任务」里看。",
    modelNote: "整理考点清单需要 AI 模型。" },
  { id: "dashboard", page: "dashboard", anchor: ["dashboard-charts", "dashboard-summary"],
    title: "统计：看见自己的进步",
    body: "分数趋势、未来 14 天的到期复习预测和各主题的掌握程度都在这里，页面底部的「模型用量」按功能列出 token 消耗。图里是示例的三周练习。" },
  { id: "notes", page: "notes", anchor: "nav-notes", placement: "right",
    title: "学习笔记：把想法留下来",
    body: "练习时点「写笔记」存下的笔记，和每日讲解合集，都收在这里。笔记可以跳回对应的题，也可以存入资料库，再用资料页的阅读功能打开。" },
  { id: "skeleton", page: "skeleton", prepare: "openSampleSkeleton", anchor: "skeleton-main",
    title: "知识骨架：把题连成一张图",
    body: "骨架用概念和关系把零散的题串起来，点一个概念就能看到相关题目，也可以切换成知识图谱。" },
  { id: "workflows", page: "workflows", anchor: "workflows-main",
    title: "学习流：先讲后练",
    body: "按「讲解 → 复述 → 练习」一步步学一个主题，学到一半离开也能接着学。默认用当前课程的资料，想换课程，开始后点「换课程」。示例里有一次停在讲解步骤的学习流。" },
  { id: "settings-model", core: true, page: "settings", anchor: "settings-model",
    title: "设置：学习库与 AI 模型",
    body: "出题、讲解和提问需要一个 AI 模型；复习练习和这次导览都不需要。这里选学习库放在哪个文件夹，也选用哪个模型出题；模型的密钥在 DSH 的「设置 › 模型」里填，不在这里填。",
    modelNote: "还没有可用的模型：先在 DSH 的「设置 › 模型」里填好密钥，再回到这里选用它。",
    readyNote: "已连接：{0}" },
  { id: "settings-audio", page: "settings", anchor: "settings-audio", context: "audio",
    title: "音频转写",
    body: "导入讲课录音，自动转成可以出题的文字资料。国内网络可以选免费的硅基流动（国内直连），不需要海外网络。" },
  { id: "settings-extensions", page: "settings", anchor: ["settings-extensions", "settings-update"],
    title: "设置：检索扩展",
    body: "上百页的大教材，建议先用转换工具变成带页码的文字再导入；整本书出题时，可以让 DSH 里的检索工具只挑出相关页面。在「设置 › 关于与更新」可以检查新版本，有更新时侧栏底部也会提示。" },
  { id: "finish", core: true, page: "settings", anchor: "settings-sample", final: true,
    title: "准备好了，换成你自己的资料",
    body: "点「添加资料」就能开始。示例数据可以随时在这里移除，你自己的资料和记录不受影响。" },
];

/** Is the step in the short (core) tour, or in the full one? */
export const inCoreTour = (step) => step.core === true || step.only === "core";
export const inFullTour = (step) => step.only !== "core";

/** How many steps the short tour has once the sample is loaded (the number the welcome page may say). */
export const CORE_TOUR_LENGTH = TOUR_STEPS.filter(inCoreTour).length;

/** Every Chinese source string a step can show (title, body, notes). */
export const tourStepCopy = (step) => [step.title, step.body, step.modelNote, step.readyNote].filter(Boolean);

/**
 * The steps this library can show: a step that needs the sample (its lecture,
 * draft or deck), a page or a component that is not there is left out.
 * ctx: { sample, pageAvailable(page), hasContext(id), full } — `full` picks the
 * full tour; the default is the short one.
 */
export function availableTourSteps(steps, { sample, pageAvailable = () => true, hasContext = () => true, full = false } = {}) {
  return steps.filter((step) => (full ? inFullTour(step) : inCoreTour(step)) && (!step.needs || (sample?.loaded && sample[step.needs])) &&
    (!step.page || step.page === "draft" || pageAvailable(step.page)) && (!step.context || hasContext(step.context)));
}

/** The id of the step before (-1) or after (+1) `id`; a vanished step restarts at the first. */
export function tourNeighbour(steps, id, direction) {
  const index = steps.findIndex((step) => step.id === id);
  if (index < 0) return steps[0]?.id ?? null;
  return steps[index + direction]?.id ?? null;
}

/** ←/→ move, Esc pauses; anything with a modifier belongs to someone else. */
export function tourKeyAction(event) {
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return null;
  return { ArrowRight: "next", ArrowLeft: "back", Escape: "close" }[event.key] || null;
}
