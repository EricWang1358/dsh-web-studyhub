/* 找功能: where every feature of StudyHub is, as plain data (issue #653). The one decision "what can a learner look up, and where does it lead"
   is made here; the sheet (ui/finder/FinderSheet.jsx), the search (search.js), the availability check (availability.js) and the tests all read it.
   Free of ui() and React on purpose, like ui/pages.js: Chinese source strings, passed through ui() where they are shown; the English is
   ui/locales/en.finder.json.

   Two parts, so a new page or setting shows up by itself:
   - derived: one entry per page of ui/pages.js that has a sidebar group or a purpose (title = the sidebar label, sentence = its purpose, anchor =
     its sidebar row), one per category of ui/settings-groups.js (「设置 › <title>」, the category's purpose, its first anchor) and one per term of
     ui/mastery-terms.js GLOSSARY (a meaning and nowhere to go). Nothing of those texts is copied here.
   - hand-written (FEATURES): the features inside a page — the ones that are hard to find, or are about to be folded into a menu. Every sentence is
     checked against the code it describes. tests/feature-finder-entries.test.mjs fails when a page, a category or a term has no entry, when an anchor
     is no longer in the UI source, and when a string has no English. A later fold or move of a control must keep (or add) its entry here: that is how
     the control stays findable, and the old name stays as an alias.

   Entry: { id, kind: 'page' | 'setting' | 'feature' | 'term', area, title, aliases, path, what, page, anchors, needs?, prepare? }
     path     the crumbs, from where to start to the control (「资料 › 打开一份资料 › 工具栏 › 翻译」); each crumb is a source string
     page     the page it is on (a key of PAGES), or null for something every page has (the sidebar, the top bar); absent for a term
     anchors  data-tour ids, tried in order: the control itself first, then what stands in for it when the page is not showing it yet (the list, the
              button that opens it). A closed <details> around an anchor is opened by the finder.
     needs    { model, capability, flag, install }: said as tags, and capability / flag decide whether the host can take you there at all
     prepare  a key of PREPARE_STEPS: what the learner has to do first when the control is not on screen (the finder cannot open a document, start a
              round or open a menu for them) */
import { PAGES, sectionLabelOf } from '../pages.js';
import { SETTINGS_CATEGORIES } from '../settings-groups.js';
import { GLOSSARY } from '../mastery-terms.js';

/** The groups of the browsable index, in the order the learner meets them. */
export const FINDER_AREAS = Object.freeze([
  { id: 'daily', label: '每天学习' },
  { id: 'material', label: '资料与阅读' },
  { id: 'generate', label: '出题' },
  { id: 'practice', label: '练习与复习' },
  { id: 'exam', label: '考试与统计' },
  { id: 'course', label: '课程与录音' },
  { id: 'settings', label: '设置' },
  { id: 'terms', label: '名词' },
]);

/** The area of a page by its sidebar section (ui/pages.js NAV_SECTIONS); PAGE_AREA says where a page differs from its section. */
const GROUP_AREA = { material: 'material', practice: 'practice', exam: 'exam', notes: 'daily' };
const PAGE_AREA = { library: 'daily', generate: 'generate', notes: 'practice', skeleton: 'course', audio: 'course', live: 'course', settings: 'settings' };
/** The sidebar's 「更多」 (#654), the first crumb of every page folded into it. Not MORE below, which is a page's own 「更多选项」. */
const SIDEBAR_MORE = '更多';
/** In a narrow window the sidebar is a drawer (#657): the top bar's menu button stands in for every row of it. */
const NAV_MENU = 'nav-menu';

/** What the learner does first, for a control that is not on screen. `land` is the page to stand on meanwhile (default: the entry's page); `after`
    says it even when the control was found (a menu item behind a button that is). The words are said when the control itself could not be lit
    (ui/finder/trip.js tripNotice). */
export const PREPARE_STEPS = Object.freeze({
  document: { text: '先在「资料」里打开一份资料。' },
  run: { land: 'library', text: '先开始一轮练习，题目下方就有这一项。' },
  'run-more': { land: 'library', after: true, text: '先开始一轮练习，点题目下方的「更多」，菜单里就有这一项。' },
  draft: { land: 'library', text: '先在学习库里打开一份待发布的草稿。' },
  materials: { text: '先在「资料」里添加资料，这一项才会出现。' },
  mistakes: { text: '答错过题以后，这一项才会出现。' },
  task: { text: '先在「任务」里点开一个任务，这一项在任务的详情里。' },
  'add-dialog': { text: '点「添加资料」，在弹出的窗口里就有这一项。' },
});

const feature = (entry) => ({ kind: 'feature', aliases: [], anchors: [], ...entry });
const MORE = '更多选项';

/** The features inside a page, written by hand. */
export const FEATURES = Object.freeze([
  // ── 资料与阅读 ──
  feature({ id: 'translation', area: 'material', title: '翻译', page: 'sources', anchors: ['translation-toggle', 'sources-list'], prepare: 'document',
    aliases: ['译', '中英对照', '双语', '对照翻译', '中英', 'translate', 'translation', 'bilingual'],
    path: ['资料', '打开一份资料', '工具栏', '翻译'],
    what: '把这一页或这一章译成中文或英文，译文显示在对应段落旁；翻译在后台进行，可以继续阅读，已有的译文不需要模型。',
    needs: { model: true } }),
  feature({ id: 'original-file', area: 'material', title: '补全原文件', page: 'sources', anchors: ['reader-original-notice', 'sources-list'], prepare: 'document',
    aliases: ['原文件', '补原文件', '附上原文件', '原始文件', '重新指定', 'attach original', 'original file'],
    path: ['资料', '打开一份资料', '补全原文件'],
    what: '只保存了提取出的文字的资料，可以补上原文件：指给它文件的位置（只记路径，不占空间），或复制一份进资料库；已保存的文字、引用和题目不会变。' }),
  feature({ id: 'practice-pages', area: 'material', title: '做这几页的题', page: 'sources', anchors: ['reader-practice', 'sources-list'], prepare: 'document',
    aliases: ['练这几页', '读完就练', '按页练习', '这几页', 'practice pages'],
    path: ['资料', '打开一份资料', '工具栏', '做这几页的题'],
    what: '数出这几页关联了多少道题、几道到期，点一下就开始练；这几页还没有题时，同一个按钮可以为它们出题。阅读时按 P 也能打开。' }),
  feature({ id: 'original-pdf', area: 'material', title: '原始 PDF', page: 'sources', anchors: ['reader-pdf-bar', 'reader-mode', 'sources-list'], prepare: 'document',
    aliases: ['pdf', '原页', '看原页', '原件', '按页提问', 'original pdf', 'pdf page'],
    path: ['资料', '打开一份 PDF', '显示方式', '原始 PDF'],
    what: '打开 PDF 资料后，把「显示方式」切到「原始 PDF」，就能看原文件的页面；在「学习工具」里按页提问，用翻页按钮换页，点预设直接问。没有原文件时先「补全原文件」。' }),
  feature({ id: 'selection-ask', area: 'material', title: '选中文字提问', page: 'sources', anchors: ['source-tools', 'source-tools-toggle', 'sources-list'], prepare: 'document',
    aliases: ['划词', '选段', '选中提问', '问这段', '没听懂', '举个例子', 'select text', 'ask about a passage'],
    path: ['资料', '打开一份资料', '选中一段文字', '学习工具'],
    what: '在阅读里选中一段原文，「学习工具」就能针对这段提问，也有「没听懂」「举个例子」这样的一键提问；回答只在阅读器打开期间保留，想留下就存为批注。',
    needs: { model: true } }),
  feature({ id: 'selection-quiz', area: 'material', title: '选中文字出题', page: 'sources', anchors: ['source-tools', 'source-tools-toggle', 'sources-list'], prepare: 'document',
    aliases: ['划词出题', '出题考我', '补充到现有题组', '补充题目', 'quiz from a passage'],
    path: ['资料', '打开一份资料', '选中一段文字', '补充到现有题组'],
    what: '选中一段原文后，可以把题补到一个现有题组里：生成的题经过独立审核，通过的增量保存，并和这段原文关联。',
    needs: { model: true } }),
  feature({ id: 'generate-from-source', area: 'material', title: '从这份资料出题', page: 'sources', anchors: ['reader-generate', 'sources-list'], prepare: 'document',
    aliases: ['整份资料出题', '用这份资料出题', 'generate from this material'],
    path: ['资料', '打开一份资料', '工具栏', '从这份资料出题'],
    what: '阅读时右上角的按钮：用整份资料出题。',
    needs: { model: true } }),
  feature({ id: 'archive', area: 'material', title: '归档与已归档', page: 'sources', anchors: ['sources-archived', 'sources-list'],
    aliases: ['归档', '已归档', '恢复资料', '永久删除', '删除资料', 'archive', 'archived', 'restore', 'delete material'],
    path: ['资料', '已归档'],
    what: '资料先归档，之后可以恢复，只有已归档的资料才能永久删除。页面右上角的「已归档」列出收起的资料；每一行的「更多」菜单里有「归档」；在「整理课程归属」里勾选几份后，还可以「归档所选」。' }),
  feature({ id: 'organize-courses', area: 'material', title: '整理课程归属', page: 'sources', anchors: ['sources-organize', 'sources-list'], prepare: 'materials',
    aliases: ['课程归属', '改课程', '分到课程', '归课程', '归档所选', 'organize', 'assign course'],
    path: ['资料', '整理课程归属'],
    what: '勾选资料后统一改它们属于哪门课，原文与引用保持不变；也可以先点「请 AI 建议」，看过建议再应用。' }),
  feature({ id: 'pdf-convert', area: 'material', title: 'PDF 解析', page: 'sources', anchors: ['import-mineru', 'sources-add'], prepare: 'add-dialog',
    aliases: ['mineru', 'marker', '扫描件', '扫描版', '公式多', 'ocr', 'pdf 转换', '解析 pdf', 'convert pdf', 'parse pdf'],
    path: ['资料', '添加资料', 'PDF 解析'],
    what: '文字读不出来、公式多，或超过 8 MB 的 PDF，可以先在本机解析成带页码的文字，再存为资料。它是音频组件的一部分，用 MinerU 或 Marker 解析。',
    needs: { capability: 'audio', install: 'MinerU' } }),

  // ── 出题 ──
  feature({ id: 'json-import', area: 'generate', title: '导入 JSON 题组', page: 'generate', anchors: ['generate-json'],
    aliases: ['json', '导入题组', '现成题目', '已有题目', '外部 ai', 'import json', 'import questions'],
    path: ['创建题组', '导入 JSON 题组'],
    what: '已经有题目，或是别的 AI 生成的题，可以直接导入：JSON 题组会存为草稿，检查后再发布。' }),
  feature({ id: 'case-exam', area: 'generate', title: '案例分析题', page: 'generate', anchors: ['generate-case'],
    aliases: ['案例', '案例题', '案例卷', '长案例', '评分标准', 'case study', 'case', 'rubric'],
    path: ['创建题组', '案例分析题'],
    what: '长案例加开放题，按评分标准逐项批改；这门课考案例题时，在这里出题。' }),
  feature({ id: 'coverage', area: 'generate', title: '覆盖强度', page: 'generate', anchors: ['generate-coverage', 'generate-from-sources'], prepare: 'materials',
    aliases: ['精简', '标准', '完整', '题量', '覆盖', '覆盖程度', 'coverage', 'strength', 'thorough'],
    path: ['创建题组', MORE, '覆盖强度'],
    what: '出题时资料要覆盖到什么程度：精简、标准、完整；选得越完整，题越多，花得也越多。出题前会按真实提示词估算大概要用多少 token。' }),
  feature({ id: 'custom-count', area: 'generate', title: '自定义题数', page: 'generate', anchors: ['generate-custom-count', 'generate-from-sources'], prepare: 'materials',
    aliases: ['题数', '题目数量', '几道题', '出多少题', 'count', 'number of questions'],
    path: ['创建题组', MORE, '覆盖强度', '自定义题数'],
    what: '想自己定题数时，在「覆盖强度」下展开「自定义题数」，填一个数或点常用题数；超过 30 道的会分成几轮，每轮最多 30 题。' }),
  feature({ id: 'budget', area: 'generate', title: '花费上限', page: 'generate', anchors: ['generate-budget', 'generate-from-sources'], prepare: 'materials',
    aliases: ['token', 'tokens', '预算', '上限', '限额', '省钱', '最多用', 'token budget', 'cost cap', 'spending limit'],
    path: ['创建题组', MORE, '覆盖强度', '花费上限'],
    what: '给一次出题设一个 token 上限（例如 2M）：用到了就在一轮结束时停下，已通过的题都保留；不填就不设上限。' }),
  feature({ id: 'difficulty', area: 'generate', title: '难度', page: 'generate', anchors: ['generate-difficulty', 'generate-from-sources'], prepare: 'materials',
    aliases: ['基础理解', '应用迁移', '深入辨析', '混合', '难易', 'difficulty', 'level'],
    path: ['创建题组', MORE, '难度'],
    what: '这次出的题偏基础还是偏难：混合、基础理解、应用迁移、深入辨析。默认值在「设置 › 出题偏好」里改。' }),
  feature({ id: 'question-language', area: 'generate', title: '出题语言', page: 'generate', anchors: ['generate-language', 'generate-from-sources'], prepare: 'materials',
    aliases: ['语言', '中文', '英文', '中英双语', 'english', 'language', 'bilingual questions'],
    path: ['创建题组', MORE, '语言'],
    what: '这次出的题用什么语言写：中文、English 或中英双语。默认值在「设置 › 出题偏好」里改。' }),
  feature({ id: 'notation', area: 'generate', title: '公式写法', page: 'generate', anchors: ['generate-notation', 'generate-from-sources'], prepare: 'materials',
    aliases: ['公式', 'latex', '数学公式', '纯文本', '公式乱码', 'formula', 'notation', 'math'],
    path: ['创建题组', MORE, '公式写法'],
    what: '题目里的公式怎么写：自动、纯文本或公式（LaTeX）。纯文本更稳定，公式适合数学、化学。默认值在「设置 › 出题偏好」里改。' }),
  feature({ id: 'generate-focus', area: 'generate', title: '这次想练什么', page: 'generate', anchors: ['generate-focus', 'generate-from-sources'], prepare: 'materials',
    aliases: ['侧重点', '练习重点', '想练什么', '主题', 'focus', 'what to practise'],
    path: ['创建题组', MORE, '这次想练什么？'],
    what: '写一句这次想练什么（例如「区分相似模式，重点练习工程场景中的取舍」），出题会侧重它；不写也可以出题。' }),
  feature({ id: 'generate-assist', area: 'generate', title: '帮我想想', page: 'generate', anchors: ['generate-assist', 'generate-focus', 'generate-from-sources'], prepare: 'materials',
    aliases: ['建议', 'ai 建议', '不知道练什么', '帮我想想练什么', 'suggest', 'suggestions'],
    path: ['创建题组', MORE, '这次想练什么？', '帮我想想'],
    what: '不知道练什么时点它：它只发送资料标题和目录，不发送全文；没有模型时，会改用你的错题给建议。' }),
  feature({ id: 'reference-questions', area: 'generate', title: '参考样题', page: 'generate', anchors: ['generate-reference', 'generate-from-sources'], prepare: 'materials',
    aliases: ['样题', '真题', '往年题', '样卷', '模仿样题', 'reference questions', 'sample questions', 'past papers'],
    path: ['创建题组', MORE, '参考样题（可选）'],
    what: '上传自己教材里的优质题目，或选已导入的样题：出题只参考题型、难度和表达方式，要求生成原创题，事实和答案仍以教材依据为准。所选样题会随教材发给模型，增加输入 token。' }),
  feature({ id: 'target-role', area: 'generate', title: '目标岗位 / 面试方向', page: 'generate', anchors: ['generate-role', 'generate-from-sources'], prepare: 'materials',
    aliases: ['目标岗位', '岗位', '面试方向', '面试', '职位', 'role', 'interview'],
    path: ['创建题组', MORE, '目标岗位 / 面试方向（可选）'],
    what: '写下目标岗位或面试方向（例如「后端工程师 · 系统设计」），出题会据此调整；可以不填。' }),
  feature({ id: 'top-up', area: 'generate', title: '为没覆盖的部分补题', page: 'draft', anchors: ['coverage-topup', 'draft-publish'], prepare: 'draft',
    aliases: ['补题', '补齐', '没覆盖', '补全题目', '接着补', 'top up', 'top-up', 'coverage gap'],
    path: ['草稿与发布', '为没覆盖的部分补题'],
    what: '草稿里还有资料小节没有题时，点它按小节补一轮题；开着「自动补到完整」会一轮接一轮补，直到每个小节都有题。补之前会先估算要用多少。学习库首页的待发布行和「任务」里也有这个入口。',
    needs: { model: true } }),
  feature({ id: 'publish-draft', area: 'generate', title: '发布草稿', page: 'draft', anchors: ['draft-publish'], prepare: 'draft',
    aliases: ['发布', '草稿', '待发布', '发布并开始练', 'publish', 'draft'],
    path: ['草稿与发布', '发布并开始练'],
    what: 'AI 出的题先放进草稿：你可以逐题核对、修改或删除，确认无误再发布，发布后就能开始练习。' }),
  feature({ id: 'draft-advanced', area: 'generate', title: '高级编辑', page: 'draft', anchors: ['draft-advanced', 'draft-publish'], prepare: 'draft',
    aliases: ['json 编辑', '改 json', 'edit json', 'advanced edit'],
    path: ['草稿与发布', '题目', '高级编辑'],
    what: '草稿页「题目」一栏里折叠着「高级编辑」，里面的「JSON 编辑」可以直接用 JSON 改这份草稿。' }),

  // ── 练习与复习 ──
  feature({ id: 'hint', area: 'practice', title: '提示', page: 'review', anchors: ['review-hint'], prepare: 'run',
    aliases: ['讲解', '看提示', '线索', 'hint', 'h'],
    path: ['练习', '题目下方', '提示'],
    what: '做题时点「提示」先看线索；揭晓答案以后，它变成「讲解」。按 H 键也能打开。' }),
  feature({ id: 'help-me-understand', area: 'practice', title: '帮我弄懂', page: 'review', anchors: ['review-help'], prepare: 'run',
    aliases: ['不懂', '助教', '通俗详解', '讲解', 'explain', 'help me understand', 'tutor'],
    path: ['练习', '题目下方', '帮我弄懂'],
    what: '卡住了点它：后台助教会结合原文讲解这道题、补上前置知识，讲完送进信箱，不打断你做题。',
    needs: { model: true } }),
  feature({ id: 'autopilot', area: 'practice', title: '自动驾驶', page: 'review', anchors: ['review-autopilot'], prepare: 'run',
    aliases: ['自动下一题', '自动进入下一题', 'autopilot', 'auto next'],
    path: ['练习', '题目下方', '自动驾驶'],
    what: '答对后自动进入下一题，点任意处或按键可以停下；按 A 键开关。默认值在「设置 › 练习」里。' }),
  feature({ id: 'en-toggle', area: 'practice', title: 'EN 双语切换', page: 'review', anchors: ['review-en'], prepare: 'run',
    aliases: ['en', 'english', '英文', '双语', '中英', 'bilingual'],
    path: ['练习', '题目下方', 'EN'],
    what: '在中文题干和答案后面显示英文。' }),
  feature({ id: 'font-size', area: 'practice', title: 'Aa 字号', page: 'review', anchors: ['review-reading'], prepare: 'run',
    aliases: ['字号', '字体大小', 'aa', '显示设置', '版心宽度', '阅读设置', 'font size', 'reading settings'],
    path: ['练习', '题目下方', 'Aa（显示设置）'],
    what: '调字号、版心宽度、字体和背景，还有「排版微调」；只改阅读和做题页的文字，不改整个界面。' }),
  feature({ id: 'thumbs', area: 'practice', title: '点赞 / 点踩', page: 'review', anchors: ['review-thumbs'], prepare: 'run',
    aliases: ['给题目打分', '打分', '评分', '反馈', '这题不错', '这题有问题', 'thumbs', 'rate a question', 'g', 'b'],
    path: ['练习', '题目下方', '点赞 / 点踩'],
    what: '这题不错就点赞，有问题就点踩；点踩后可以选标签（题干太空、选项太烂、太简单、太难、答案有误、解析不清、只问资料怎么说）。快捷键 G / B。' }),
  feature({ id: 'write-note', area: 'practice', title: '写笔记', page: 'review', anchors: ['review-more'], prepare: 'run-more',
    aliases: ['笔记', '记笔记', '存笔记', 'note', 'write a note'],
    path: ['练习', '题目下方', '更多', '写笔记'],
    what: '把想法存下来：在题目下方的「更多」里选「写笔记」。存下的笔记收在「学习笔记」里，可以跳回对应的题。' }),
  feature({ id: 'slay', area: 'practice', title: '斩题', page: 'review', anchors: ['review-more'], prepare: 'run-more',
    aliases: ['斩掉此题', '斩', '不再复习', '斩题组', 'slay', 'retire a question'],
    path: ['练习', '题目下方', '更多', '斩掉此题'],
    what: '把这道题移入斩题组，不再复习；斩掉的当时可以点「撤销」，恢复到原题组。' }),
  feature({ id: 'retrain', area: 'practice', title: '重练错题', page: 'wrongbook', anchors: ['wrongbook-retrain', 'wrongbook-list'], prepare: 'mistakes',
    aliases: ['重练', '错题重练', '巩固', '开始重练', '练错题', 'retrain', 'redo mistakes'],
    path: ['错题与待巩固', '重练'],
    what: '选一个范围，点「开始重练」，把待巩固的题按学习路径再练一遍；筛选之后，也可以只练筛出来的。' }),
  feature({ id: 'similar', area: 'practice', title: '同类题', page: 'wrongbook', anchors: ['wrongbook-recs', 'wrongbook-list'], prepare: 'mistakes',
    aliases: ['相似题', '类似题', '举一反三', 'similar questions', 'similar'],
    path: ['错题与待巩固', '点开一道错题', '同类题'],
    what: '点开一道错题的详情，能看到题库里已有的同类题，可以直接去练；页面上的「为你推荐」是同一类东西。' }),
  feature({ id: 'variants', area: 'practice', title: '生成变式', page: 'wrongbook', anchors: ['wrongbook-batch', 'wrongbook-list'], prepare: 'mistakes',
    aliases: ['变式', '变式题', '改写错题', '为全部错题生成变式', 'variant', 'variants', 'rewrite mistakes'],
    path: ['错题与待巩固', '生成变式'],
    what: '为错题改写新的变式题：每道题约 1 次轻量模型调用，一次有题数上限；写好的题放进「为你定制」，点「去练」开练。',
    needs: { model: true } }),
  feature({ id: 'recommend', area: 'practice', title: '为你推荐', page: 'wrongbook', anchors: ['wrongbook-recs', 'wrongbook-list'], prepare: 'mistakes',
    aliases: ['推荐', '相似题', '同主题', '不消耗模型', 'recommendations', 'recommended'],
    path: ['错题与待巩固', '为你推荐'],
    what: '直接从题库里找相似的题：同主题、引用同一页，或关键词相近，已排除你刚答对的；不消耗模型。' }),
  feature({ id: 'daily-recap', area: 'practice', title: '每日讲解合集', page: 'settings', anchors: ['settings-daily-recap'],
    aliases: ['讲解合集', '错题合集', '每日错题讲解', 'recap', 'daily recap'],
    path: ['设置', '每日讲解合集'],
    what: '同一天、同一课程只保留一篇合集，累计完成 10 道不同题目才生成；默认关闭，开启后会用当前 AI 模型。生成的合集收在「学习笔记」里。',
    needs: { model: true } }),
  feature({ id: 'task-controls', area: 'daily', title: '任务的停止与调整时限', page: 'tasks', anchors: ['tasks-detail', 'nav-tasks'], prepare: 'task',
    aliases: ['停止', '暂停', '停在这里', '时限', '运行时限', '超时', '取消任务', '任务控制台', 'stop', 'pause', 'time limit', 'timeout', 'cancel a task'],
    path: ['任务', '点开一个任务', '停止 / 调整时限'],
    what: '点开「任务」里的一个任务：进行中的可以暂停或停止（分轮出题的叫「停在这里」，已通过的题都保留），停下的可以「接着做」。详情里写明时限和已用时间；时限由设置决定时，「调整时限」会带你去「设置 › 出题偏好」改每轮运行时限，只对之后开始的任务生效。' }),
  feature({ id: 'mailbox', area: 'practice', title: '信箱', page: null, anchors: ['topbar-mailbox'],
    aliases: ['通知', '消息', '后台结果', '邮件', 'mailbox', 'inbox', 'notifications'],
    path: ['页面顶栏', '信箱'],
    what: '后台替你做完的事（改题、前置题、讲解、译文、批改、音频转写、PDF 转换……）都投递到信箱；点一条直接跳回那道题或那份结果，「全部已读」只清角标，不删记录。' }),

  // ── 考试与统计 ──
  feature({ id: 'exam-formats', area: 'exam', title: '模拟考试的三种形式', page: 'exam', anchors: ['exam-case'],
    aliases: ['笔试', '选择题笔试', '案例卷', '案例分析卷', '口头面试', '面试', '考试形式', 'written exam', 'oral exam', 'case exam', 'exam format'],
    path: ['模拟考试', '考试形式'],
    what: '在这里切换选择题笔试、案例分析卷和口头面试，都是限时作答；交卷后给出成绩单和逐题解析，案例卷按评分标准逐项批改。' }),

  // ── 课程与录音 ──
  feature({ id: 'course-settings', area: 'course', title: '课程设置', page: 'library', anchors: ['home-course'],
    aliases: ['考试日期', '分值', '总分', '重点', '重点知识点', '考试说明', '倒计时', '考试信息', 'course settings', 'exam date', 'exam info'],
    path: ['学习库', '课程标题', '课程设置…'],
    what: '每门课可以记下考试形式、总分、作答和阅读时间、考试日期，也能放入老师的考试说明和重点知识点；课程标题旁会显示距考试还有几天。在课程标题的下拉菜单最后选「课程设置…」，或到「设置 › 课程」。' }),
  feature({ id: 'live-local', area: 'course', title: '课堂实录的本地转写', page: 'settings', anchors: ['settings-audio'],
    aliases: ['本地转写', '本地引擎', '声音不上传', '离线转写', 'live local', 'local transcription', 'offline'],
    path: ['设置', '音频转写', '课堂实录的转写方式'],
    what: '课堂实录可以用 Gemini（云端，要密钥），也可以用本地转写：声音不上传，不需要密钥，要先安装。在「设置 › 音频转写」里选，也能在「课堂实录」页安装。',
    needs: { capability: 'audio', install: '本地转写引擎' } }),

  // ── 设置 ──
  feature({ id: 'library-folder', area: 'settings', title: '学习库文件夹', page: 'settings', anchors: ['settings-model'],
    aliases: ['学习库', '文件夹', '位置', '路径', '换文件夹', 'library folder', 'workspace', 'folder'],
    path: ['设置', '学习库与模型'],
    what: '学习库是你电脑上的一个文件夹，资料、题组和复习记录都保存在里面；在这里选它放在哪个文件夹。' }),
  feature({ id: 'choose-model', area: 'settings', title: '选择模型', page: 'settings', anchors: ['settings-model'],
    aliases: ['模型', 'ai 模型', '换模型', '密钥', 'api key', 'model', 'deepseek'],
    path: ['设置', '学习库与模型'],
    what: '出题、讲解和提问需要一个 AI 模型，在这里选用哪个；模型的密钥在 DSH 的「设置 › 模型」里填，不在这里填。' }),
  feature({ id: 'audio-keys', area: 'settings', title: '音频转写密钥 / 硅基流动', page: 'settings', anchors: ['settings-audio'],
    aliases: ['转写密钥', '硅基流动', 'siliconflow', 'gemini', 'groq', 'audio key', 'transcription key', '录音转文字'],
    path: ['设置', '音频转写'],
    what: '转写录音要填一个密钥：按 Gemini 免费、硅基流动、Groq、Gemini 付费的顺序尝试，只配一个也可以。国内网络可以选硅基流动，直连，不需要海外网络。',
    needs: { capability: 'audio' } }),
  feature({ id: 'retrieval', area: 'settings', title: '检索扩展', page: 'settings', anchors: ['settings-extensions'],
    aliases: ['检索', '索引', '建立索引', '大教材', '整本书', '上百页', 'retrieval', 'index', 'rag', 'large textbook'],
    path: ['设置', '检索扩展'],
    what: '给上百页的大教材用：装好检索扩展并为课程建立索引后，整本书出题时只挑出相关页面给 AI 看；超过 15 万字的选择会先用它挑页。',
    needs: { capability: 'generation', install: '检索扩展' } }),
  feature({ id: 'appearance-theme', area: 'settings', title: '外观', page: 'settings', anchors: ['settings-appearance-theme'],
    aliases: ['深色', '浅色', '暗色', '夜间', '主题', '护眼', '纸色', 'dark', 'light', 'theme', 'dark mode'],
    path: ['设置', '界面', '外观'],
    what: '选界面的明暗和配色（也有纯黑和护眼纸色）；选「跟随系统」就随电脑的深浅色变。' }),
  feature({ id: 'appearance-accent', area: 'settings', title: '强调色', page: 'settings', anchors: ['settings-appearance-accent'],
    aliases: ['颜色', '主色', '朱砂', 'accent', 'accent colour', 'color'],
    path: ['设置', '界面', '强调色'],
    what: '换一个强调色：朱砂是默认，另有几种可选。只换强调色，其他不变。' }),
  feature({ id: 'appearance-scale', area: 'settings', title: '界面大小', page: 'settings', anchors: ['settings-appearance-scale'],
    aliases: ['缩放', '放大', '字太小', '界面缩放', 'scale', 'zoom', 'interface size'],
    path: ['设置', '界面', '界面大小'],
    what: '放大整个界面（文字、按钮和间距一起），最大 200%。阅读和做题页另有 Aa 可以单独调字号和宽度。' }),
  feature({ id: 'appearance-font', area: 'settings', title: '界面字体', page: 'settings', anchors: ['settings-appearance-font'],
    aliases: ['字体', '标题字体', '本机字体', 'font', 'typeface'],
    path: ['设置', '界面', '界面字体'],
    what: '选界面字体和标题字体；也可以填本机已安装的字体名，找不到会用系统字体。' }),
  feature({ id: 'appearance-density', area: 'settings', title: '界面密度', page: 'settings', anchors: ['settings-appearance-density'],
    aliases: ['密度', '紧凑', '间距', '行距', 'density', 'compact', 'spacing'],
    path: ['设置', '界面', '界面密度'],
    what: '密度只改间距和行距，不改字号。' }),
  feature({ id: 'appearance-radius', area: 'settings', title: '圆角', page: 'settings', anchors: ['settings-appearance-radius'],
    aliases: ['圆角大小', '方角', 'radius', 'rounded corners', 'corners'],
    path: ['设置', '界面', '圆角'],
    what: '调卡片、按钮这些东西的圆角大小。' }),
  feature({ id: 'appearance-motion', area: 'settings', title: '动画', page: 'settings', anchors: ['settings-appearance-motion'],
    aliases: ['减弱动画', '无动画', '卡顿', '页面切换', 'motion', 'animation', 'reduce motion', 'lag'],
    path: ['设置', '界面', '动画'],
    what: '减弱只保留很短的淡入淡出；无动画则不再有页面切换和卡片动画（转圈提示仍会转）。页面切换卡顿时可以试试。' }),
  feature({ id: 'appearance-contrast', area: 'settings', title: '对比度', page: 'settings', anchors: ['settings-appearance-contrast'],
    aliases: ['高对比', '看不清', 'contrast', 'high contrast'],
    path: ['设置', '界面', '对比度'],
    what: '高对比会加深边框和次要文字、加粗焦点框；跟随系统时，遵循系统的“增加对比度”设置。' }),
  feature({ id: 'appearance-transfer', area: 'settings', title: '导出 / 导入外观', page: 'settings', anchors: ['settings-appearance-transfer'],
    aliases: ['导出外观', '导入外观', '恢复默认外观', '外观设置', 'export appearance', 'import appearance', 'reset appearance'],
    path: ['设置', '界面', '导出外观'],
    what: '把整套外观导出成一小段文字，粘贴到另一台电脑再导入；也能「恢复默认外观」。' }),
  feature({ id: 'ui-language', area: 'settings', title: '界面语言', page: 'settings', anchors: ['settings-appearance-language'],
    aliases: ['语言', '中文', '英文', 'english', 'language', 'interface language', 'switch language'],
    path: ['设置', '界面', '界面语言'],
    what: '在中文和 English 之间切换界面语言；默认跟随浏览器的语言。' }),
  feature({ id: 'shortcuts', area: 'settings', title: '快捷键', page: null, anchors: ['nav-shortcuts', 'nav-help', NAV_MENU],
    aliases: ['键盘', '快捷', '热键', '速查', 'keyboard', 'shortcuts', 'hotkeys', 'keys'],
    path: ['侧栏', '帮助', '快捷键'],
    what: '看这一页能用的键；按 ? 也能打开。' }),
  feature({ id: 'tour', area: 'settings', title: '功能导览', page: null, anchors: ['tour-reopen', 'nav-help', NAV_MENU],
    aliases: ['导览', '教程', '新手', '引导', '入门', '重看', 'tour', 'walkthrough', 'tutorial', 'onboarding'],
    path: ['侧栏', '帮助', '功能导览'],
    what: '切到每个关键功能，边走边看怎么用。先走主线（模型、资料、出题、草稿、练习），看完还可以看完整导览；随时可以暂停，之后接着看。' }),
  feature({ id: 'glossary', area: 'settings', title: '名词解释', page: null, anchors: ['nav-glossary', 'nav-help', NAV_MENU],
    aliases: ['术语', '名词', '词汇', '是什么意思', 'glossary', 'terms', 'what does it mean'],
    path: ['侧栏', '帮助', '名词解释'],
    what: '把鼠标放上去（或用键盘聚焦），会列出界面里这些词的意思：主会话、总纲、覆盖强度、前置题、学习库、题组。' }),
  feature({ id: 'sample-remove', area: 'settings', title: '移除示例数据', page: 'settings', anchors: ['settings-sample'],
    aliases: ['示例', '示例课程', '示例数据', '设计模式', '删除示例', 'sample', 'demo', 'remove sample'],
    path: ['设置', '学习画像与导览', '示例'],
    what: '载入过示例课程后，可以在这里移除示例数据，你自己的资料和记录不受影响；也可以重新载入示例、重看导览。' }),
  feature({ id: 'backup', area: 'settings', title: '备份与恢复', page: 'settings', anchors: ['settings-backup'],
    aliases: ['备份', '导出', '导入', '恢复', '导出学习库', '换电脑', 'backup', 'export', 'restore'],
    path: ['设置', '导入、计划与备份', '数据备份与恢复'],
    what: '导出会下载一个完整的 JSON 备份：资料、题组、复习进度和作答记录都在里面。恢复用一份完整备份替换当前学习库，替换前当前数据会自动另存一份。' }),
  feature({ id: 'legacy-import', area: 'settings', title: '导入旧学习库', page: 'settings', anchors: ['settings-legacy-import'],
    aliases: ['study-lib-spar', '旧学习库', '迁移', 'legacy', 'import old library', 'migrate'],
    path: ['设置', '导入、计划与备份', '导入 study-lib-spar'],
    what: '从已有的本地学习库（study-lib-spar）导入，保留可迁移的复习记录。' }),
  feature({ id: 'update', area: 'settings', title: '检查更新', page: 'settings', anchors: ['settings-update'],
    aliases: ['更新', '升级', '版本', '新版本', 'update', 'upgrade', 'version', 'check for updates'],
    path: ['设置', '关于与更新'],
    what: '看当前版本、已安装版本和最新已知版本，检查更新；有新版本时，侧栏底部也会提示。' }),
  feature({ id: 'usage-record', area: 'settings', title: '使用频率记录', page: 'settings', anchors: ['settings-usage'],
    aliases: ['使用记录', '使用频率', '隐私', '统计使用', 'usage', 'usage record', 'telemetry', 'privacy'],
    path: ['设置', '使用频率记录'],
    what: '只记录你用了哪些控件、各用了多少次（按天累计），不记录任何内容和名字；只保存在这台电脑上，可以随时查看、导出、暂停和删除。默认关闭。',
    needs: { capability: 'system' } }),
  feature({ id: 'experimental', area: 'settings', title: '实验性功能', page: 'settings', anchors: ['settings-experimental'],
    aliases: ['实验', '试验', 'jev', 'experimental', 'beta', 'labs'],
    path: ['设置', '实验性功能'],
    what: '显示实验性功能的总开关，默认关闭；关掉后它们全部隐藏并停止，里面已有的选择会保留。',
    needs: { capability: 'system' } }),
  feature({ id: 'hand-off', area: 'settings', title: '发给主会话', page: null, anchors: ['hand-off'],
    aliases: ['主会话', '交给主会话', '让主会话做', '发给 agent', 'hand off', 'main chat', 'send to chat', 'agent'],
    path: ['许多页面', '发给主会话'],
    what: '内置功能做不了的事，点「发给主会话」：StudyHub 把写好的话填进主会话的输入框，由你按发送；没有主会话时，复制到剪贴板。' }),
  // ── the sidebar itself (#654–#657) ──
  feature({ id: 'nav-more', area: 'settings', title: '侧栏的「更多」', page: null, anchors: ['nav-more', NAV_MENU],
    aliases: ['更多', '每天', '阶段性', '课程准备与管理', '侧栏分组', '其他功能', '调整顺序', '固定到侧栏', 'more', 'sidebar groups', 'reorder', 'pin'],
    path: ['侧栏', '更多'],
    what: '侧栏上方是最常用的几项，其余的按内容收在「更多」里：资料与出题、练习与复习、考试与统计、任务、笔记与待办。按住一项拖到上方就放进常用的几项（最多 6 项），用键盘时按 Alt 加上下方向键。' }),
  feature({ id: 'nav-help', area: 'settings', title: '帮助', page: null, anchors: ['nav-help', NAV_MENU],
    aliases: ['帮助', '说明', 'help'],
    path: ['侧栏', '帮助'],
    what: '侧栏底部的「帮助」里有功能导览、快捷键和名词解释。' }),
  feature({ id: 'nav-menu', area: 'settings', title: '导航菜单', page: null, anchors: [NAV_MENU, 'nav-collapse'],
    aliases: ['菜单', '侧栏', '侧边栏', '收起侧栏', '展开侧栏', '窄屏', 'menu', 'sidebar', 'navigation', 'collapse sidebar'],
    path: ['顶栏', '菜单按钮'],
    what: '窗口窄时，或把侧栏收起后，点顶栏左边的菜单按钮打开导航，每一项都带名字；按 Esc 或点外面就关上。窗口够宽时，导航里的「把侧栏固定在左边」能把它放回左边。' }),
  feature({ id: 'finder', area: 'settings', title: '找功能', page: null, anchors: ['nav-finder', NAV_MENU],
    aliases: ['搜索', '查找', '找', '搜', 'search', 'find', 'find a feature', 'command palette', 'ctrl k', 'ctrl+k', 'cmd k', '⌘k'],
    path: ['侧栏', '找功能'],
    what: '输入一个词（中文、英文或常见叫法都行）就能找到功能在哪，选中后「带我去」会切到那一页并标出来。按 Ctrl K（Mac 上 ⌘K），或在没有输入框聚焦时按 /，也能打开。' }),
]);

/** One entry per page of the registry that has a sidebar group or a purpose. */
function pageEntries(pages) {
  return Object.entries(pages).filter(([, page]) => page.group || page.purpose).map(([id, page]) => ({
    id: `page-${id}`, kind: 'page', area: PAGE_AREA[id] || GROUP_AREA[page.group] || 'daily', title: page.label, aliases: [], what: page.purpose || '',
    path: page.main || !page.group ? [page.label] : [SIDEBAR_MORE, sectionLabelOf(page.group), page.label],
    page: id, anchors: [`nav-${id}`, NAV_MENU],
    needs: { ...(page.needs?.length ? { capability: page.needs } : {}), ...(page.flag ? { flag: page.flag } : {}) },
  }));
}

/** One entry per settings category: 「设置 › <title>」, its purpose, its first anchor. */
function settingEntries(categories) {
  return categories.map((category) => ({
    id: `setting-${category.id}`, kind: 'setting', area: 'settings', title: category.title, aliases: [], path: ['设置', category.title], what: category.purpose || '',
    page: 'settings', anchors: [category.anchors[0]], needs: category.needs ? { capability: category.needs } : {},
  }));
}

/** One entry per glossary term: its meaning, and nowhere to go. */
function termEntries(glossary) {
  return Object.entries(glossary).map(([key, term]) => ({
    id: `term-${key}`, kind: 'term', area: 'terms', title: term.label, aliases: [], path: ['名词解释'], what: term.hint, anchors: [], needs: {},
  }));
}

/** Every entry, derived ones first inside their area (a page before the features inside it): the order of the index. */
export function buildEntries({ pages = PAGES, categories = SETTINGS_CATEGORIES, glossary = GLOSSARY, features = FEATURES } = {}) {
  const all = [...pageEntries(pages), ...features, ...settingEntries(categories), ...termEntries(glossary)];
  const rank = new Map(FINDER_AREAS.map((area, index) => [area.id, index]));
  return all.map((entry, order) => ({ entry, order })).sort((a, b) => rank.get(a.entry.area) - rank.get(b.entry.area) || a.order - b.order).map(({ entry }) => entry);
}

export const FINDER_ENTRIES = Object.freeze(buildEntries());

/* ── what an entry says it needs ────────────────────────────────────────────────────────────────────────────────────────── */

/** The label of a host switch: the page it switches on. */
const flagWord = (flag) => Object.values(PAGES).find((page) => page.flag === flag)?.label || flag;

/** The words of the tags: each is a template, so the English of a tag is one translation, not one per name. */
export const TAG_TEMPLATES = Object.freeze({ model: '需要 AI 模型', flag: '需要 DSH 开启{0}', install: '需要先安装 {0}' });

/** The tags under an entry: what it needs, said and never hidden. `translate` is ui() where the tags are shown; the names in them (a page, an install) are translated too. */
export function entryTags(entry, translate = (text) => text) {
  const needs = entry?.needs || {}, fill = (template, name) => translate(template).replace('{0}', translate(name));
  return [needs.model && translate(TAG_TEMPLATES.model), needs.flag && fill(TAG_TEMPLATES.flag, flagWord(needs.flag)), needs.install && fill(TAG_TEMPLATES.install, needs.install)].filter(Boolean);
}

/** Every Chinese source string an entry can show (the title, the crumbs, the sentence, the tags), for the English-coverage test. The aliases are only searched. */
export function finderCopy(entries) {
  const seen = new Set();
  const add = (text) => { if (text && /[㐀-鿿]/.test(text)) seen.add(text); };
  for (const entry of entries) {
    add(entry.title);
    add(entry.what);
    entry.path.forEach(add);
    add(entry.needs?.install);
    if (entry.needs?.flag) add(flagWord(entry.needs.flag));
  }
  for (const area of FINDER_AREAS) add(area.label);
  Object.values(TAG_TEMPLATES).forEach(add);
  return [...seen];
}
