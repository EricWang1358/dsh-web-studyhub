/* The feature tour ("重点切换指引", plan §4 C7) as data. Each step names the
   page to switch to, what to prepare there (open the sample lecture, start a
   sample practice round…) and the `data-tour` anchor to highlight; a list of
   anchors is tried in order. Copy is Chinese source text that the popover
   passes through ui(); the English lives in ui/locales/en.onboarding.json.
   tests/wp5-tour-steps checks the anchors against the UI source. */

export const TOUR_STEPS = [
  { id: "welcome",
    title: "欢迎来到 StudyHub",
    body: "导览会用一门示例课程（设计模式）带你走一遍最常用的功能，大约两三分钟。示例内容都标着「示例」，看完可以一键移除。" },
  { id: "nav", page: "library", anchor: "nav", placement: "right",
    title: "左侧是全部功能",
    body: "上面一组是每天的学习主线：学习库、资料、创建题组、错题与待巩固、模拟考试和统计；下面一组是整理和扩展工具。按住条目拖动可以调整顺序。" },
  { id: "home", page: "library", anchor: ["home-today", "home-hero"],
    title: "学习库：今天学什么",
    body: "首页根据到期复习、错题和新题排好今天的计划，点一下就开始。所有题组按课程整理在下方。" },
  { id: "sources", page: "sources", anchor: "sources-list",
    title: "资料：你的讲义和课件",
    body: "PDF、Markdown、网页和文本都可以导入，原文件会完整保留。一份文档就是一项资料，多页 PDF 也不会被拆散。" },
  { id: "document", page: "sources", prepare: "openSampleDocument", anchor: "source-tools", placement: "left", needs: "sourceId",
    title: "在原文里提问、出题",
    body: "这是示例讲义的原文。标出的段落已经关联了题目和解析；选中任意一段文字，就能就这段提问，或者用它出几道题。" },
  { id: "generate", page: "generate", prepare: "prepareGenerate", anchor: "generate-from-sources", placement: "right",
    title: "创建题组：用资料出题",
    body: "选好资料、题型和题数，内置 AI 会出题，并给每道题标出引用的原文。已经有现成的题目，也可以在这里直接导入。",
    modelNote: "出题需要先配置 AI 模型，导览快结束时会告诉你在哪里设置。" },
  { id: "draft", page: "draft", prepare: "openSampleDraft", anchor: "draft-publish", needs: "draftId",
    title: "草稿：检查后再发布",
    body: "AI 出的题先放进草稿。你可以逐题核对、修改或删除，确认无误再发布，发布后就能开始练习。这是一份示例草稿。" },
  { id: "practice", page: "review", prepare: "startSamplePractice", anchor: "review-question", needs: "deckId",
    title: "练习：答题、看解析",
    body: "选择题会逐项说明对在哪、错在哪；闪卡先回忆再翻面自评。每次作答后，系统按记忆曲线安排下一次复习。试着答一题吧。" },
  { id: "help", page: "review", prepare: "startSamplePractice", anchor: "review-help", needs: "deckId",
    title: "卡住了？点「帮我弄懂」",
    body: "后台助教会结合原文讲解这道题、补上前置知识。讲解完成后送进信箱，不打断你做题。",
    modelNote: "这项功能需要 AI 模型。" },
  { id: "wrongbook", page: "wrongbook", anchor: "wrongbook-list",
    title: "错题与待巩固",
    body: "答错或自评没掌握的题会自动收集到这里，可以按主题一键重练。示例里有两道还没掌握的题。" },
  { id: "exam", page: "exam", anchor: "exam-start",
    title: "模拟考试",
    body: "从选定的题组抽题组卷，限时作答。交卷后给出成绩单和逐题解析，薄弱点一目了然。" },
  { id: "case", page: "exam", anchor: "exam-case",
    title: "案例分析卷：限时练长案例",
    body: "考试是长案例加开放题？在这里限时做一套：先阅读并用不同颜色高亮线索，再按分值分配时间作答。交卷后按评分标准逐项批改，指出没落到案例上的建议和该写的假设。示例里有一套已经批改好的案例。",
    modelNote: "批改需要 AI 模型；示例里的批改结果不需要。" },
  { id: "dashboard", page: "dashboard", anchor: "dashboard-summary",
    title: "统计：看见自己的进步",
    body: "这里汇总了示例的三周练习：连续学习天数、正确率走势和各主题的掌握程度。" },
  { id: "skeleton", page: "skeleton", prepare: "openSampleSkeleton", anchor: "skeleton-main",
    title: "知识骨架：把题连成一张图",
    body: "骨架用概念和关系把零散的题串起来，点一个概念就能看到相关题目，也可以切换成知识图谱。" },
  { id: "workflows", page: "workflows", anchor: "workflows-main",
    title: "学习流：先讲后练",
    body: "按「讲解 → 复述 → 练习」一步步学一个主题，学到一半离开也能接着学。示例里有一次停在讲解步骤的学习流。" },
  { id: "settings-model", page: "settings", anchor: "settings-model",
    title: "设置：AI 模型",
    body: "出题、讲解和提问需要一个 AI 模型；复习练习和这次导览都不需要。模型在这里选择和检查。",
    modelNote: "还没有可用的模型，准备出题前先在这里配置一个。",
    readyNote: "已连接：{0}" },
  { id: "settings-audio", page: "settings", anchor: "settings-audio", context: "audio",
    title: "音频转写",
    body: "导入讲课录音，自动转成可以出题的文字资料。国内网络可以选免费的硅基流动（国内直连），不需要海外网络。" },
  { id: "finish", page: "settings", anchor: "settings-sample", final: true,
    title: "准备好了，换成你自己的资料",
    body: "导入一份讲义或课件就能开始。示例数据可以随时在这里移除，你自己的资料和记录不受影响。" },
];

/** Every Chinese source string a step can show (title, body, notes). */
export const tourStepCopy = (step) => [step.title, step.body, step.modelNote, step.readyNote].filter(Boolean);

/**
 * The steps this library can show: a step that needs the sample (its lecture,
 * draft or deck), a page or a component that is not there is left out.
 * ctx: { sample, pageAvailable(page), hasContext(id) }.
 */
export function availableTourSteps(steps, { sample, pageAvailable = () => true, hasContext = () => true } = {}) {
  return steps.filter((step) => (!step.needs || (sample?.loaded && sample[step.needs])) &&
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
