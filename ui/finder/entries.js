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
  book: { text: '先在「复习全书」里打开一本书。' },
  'run-more': { land: 'library', after: true, text: '先开始一轮练习，点题目下方的「更多」，菜单里就有这一项。' },
  draft: { land: 'library', text: '先在学习库里打开一份待发布的草稿。' },
  materials: { text: '先在「资料」里添加资料，这一项才会出现。' },
  mistakes: { text: '答错过题以后，这一项才会出现。' },
  task: { text: '先在「任务」里点开一个任务，这一项在任务的详情里。' },
  'add-dialog': { text: '点「添加资料」，在弹出的窗口里就有这一项。' },
  'live-class': { text: '先在「课堂实录」里开始或打开一场实录，这一项才会出现。' },
  outline: { text: '先在首页点「总纲」，打开这门课的总纲页。' },
});

const feature = (entry) => ({ kind: 'feature', aliases: [], anchors: [], ...entry });
const MORE = '更多选项';

/** The features inside a page, written by hand. */
export const FEATURES = Object.freeze([
  // ── 资料与阅读 ──
  feature({ id: 'translation', area: 'material', title: '翻译', page: 'sources', anchors: ['reader-more', 'sources-list'], prepare: 'document',
    aliases: ['译', '中英对照', '双语', '对照翻译', '中英', 'translate', 'translation', 'bilingual'],
    path: ['资料', '打开一份资料', '工具栏', '更多', '翻译…'],
    what: '在阅读器工具栏最右边的「更多」里点「翻译…」：把这一页或这一章译成中文或英文，译文显示在对应段落旁；翻译在后台进行，可以继续阅读，已有的译文不需要模型。',
    needs: { model: true } }),
  feature({ id: 'reader-chapters', area: 'material', title: '按章阅读', page: 'sources', anchors: ['reader-outline', 'reader-more', 'sources-list'], prepare: 'document',
    aliases: ['目录', '章节', '上一章', '下一章', '跳到某一页', '整本书', '其他章节', 'chapters', 'table of contents', 'next chapter'],
    path: ['资料', '打开一份资料', '目录'],
    what: '长资料一次只显示一章，打开更快：有章节的书按它自己的章（和「资料」页「查看 N 章」里的一样），没有章节的每 20 页一段。「目录」列出所有章，点一章就换过去，展开能看到其中的页；正文末尾有「上一章」「下一章」。从引用、练习或「查看 N 章」去某一页时，会自己换到那一章；「在文中查找」也会列出其他章节里的结果。' }),
  feature({ id: 'original-file', area: 'material', title: '补全原文件', page: 'sources', anchors: ['reader-more', 'reader-original-notice', 'sources-list'], prepare: 'document',
    aliases: ['原文件', '补原文件', '附上原文件', '原始文件', '重新指定', '没有原文件', 'attach original', 'original file'],
    path: ['资料', '打开一份资料', '工具栏', '更多', '补全原文件…'],
    what: '只保存了提取出的文字的资料，可以补上原文件：打开工具栏最右边的「更多」，PDF 资料的「原始 PDF」一行写着「没有原文件」，点它就是补全（别的格式是「补全原文件…」）：指给它文件的位置（只记路径，不占空间，文件再大也行），或复制一份进资料库（最多 40 MB）；已保存的文字、引用和题目不会变。从本机路径转换的 PDF 会自动记住原文件的位置；之后在阅读器里把某一页发给主会话，会带上原文件的路径和页码。原文件找不到或被改动时，阅读器上方会有提示。' }),
  feature({ id: 'practice-pages', area: 'material', title: '做这几页的题', page: 'sources', anchors: ['reader-practice', 'sources-list'], prepare: 'document',
    aliases: ['练这几页', '读完就练', '按页练习', '这几页', 'practice pages'],
    path: ['资料', '打开一份资料', '工具栏', 'AI 出题旁的小箭头'],
    what: '数出这几页关联了多少道题、几道到期，点一下就开始练；这几页还没有题时，同一个面板可以为它们出题。点「AI 出题」右边的小箭头，或阅读时按 P。' }),
  feature({ id: 'original-pdf', area: 'material', title: '原始 PDF', page: 'sources', anchors: ['reader-pdf-bar', 'reader-more', 'sources-list'], prepare: 'document',
    aliases: ['pdf', '原页', '看原页', '原件', '按页提问', '显示方式', '阅读', '原文', 'original pdf', 'pdf page'],
    path: ['资料', '打开一份 PDF', '工具栏', '更多', '显示方式', '原始 PDF'],
    what: '打开 PDF 资料后，在工具栏最右边的「更多」里把「显示方式」切到「原始 PDF」，就能看原文件的页面；在「更多 › 学习工具」里按页提问，用翻页按钮换页，点预设直接问。没有原文件时先「补全原文件」。' }),
  feature({ id: 'selection-ask', area: 'material', title: '选中文字提问', page: 'sources', anchors: ['source-tools', 'reader-more', 'sources-list'], prepare: 'document',
    aliases: ['划词', '选段', '选中提问', '问这段', '没听懂', '举个例子', '学习工具', 'select text', 'ask about a passage', 'study tools'],
    path: ['资料', '打开一份资料', '选中一段文字', '学习工具'],
    what: '在阅读里选中一段原文，「学习工具」会自己打开（也可以在工具栏最右边的「更多」里点「学习工具」），就能针对这段提问，也有「没听懂」「举个例子」这样的一键提问；回答只在阅读器打开期间保留，想留下就存为批注。',
    needs: { model: true } }),
  feature({ id: 'selection-quiz', area: 'material', title: '选中文字出题', page: 'sources', anchors: ['source-tools', 'reader-more', 'sources-list'], prepare: 'document',
    aliases: ['划词出题', '出题考我', '补充到现有题组', '补充题目', 'quiz from a passage'],
    path: ['资料', '打开一份资料', '选中一段文字', '补充到现有题组'],
    what: '选中一段原文后，可以把题补到一个现有题组里：生成的题经过独立审核，通过的增量保存，并和这段原文关联。',
    needs: { model: true } }),
  feature({ id: 'generate-from-source', area: 'material', title: '从这份资料出题', page: 'sources', anchors: ['reader-generate', 'sources-list'], prepare: 'document',
    aliases: ['整份资料出题', '用这份资料出题', '出题', 'generate from this material'],
    path: ['资料', '打开一份资料', '工具栏', 'AI 出题'],
    what: '阅读时工具栏里红色的「AI 出题」按钮：用整份资料出题。',
    needs: { model: true } }),
  feature({ id: 'reader-wrong', area: 'material', title: '这份资料的错题', page: 'sources', anchors: ['reader-wrong', 'sources-list'], prepare: 'document',
    aliases: ['错题', '待巩固', '答错的题', '错题本', '去练', '看原文', 'wrong questions', 'mistakes'],
    path: ['资料', '打开一份资料', '工具栏', '错题'],
    what: '列出这份资料里你答错或还没巩固的题（和「错题与待巩固」页是同一批记录），当前章节的在前，其余的在后；每道题可以「去练」（练完回到这里）或「看原文」跳到它问的那一段。没有时会写一句「没有待巩固的题」。' }),
  feature({ id: 'reader-mind-map', area: 'material', title: '思维导图', page: 'sources', anchors: ['reader-map', 'sources-list'], prepare: 'document',
    aliases: ['导图', '脑图', '章节结构', '标题树', 'mind map', 'chapter map'],
    path: ['资料', '打开一份资料', '工具栏', '思维导图'],
    what: '把当前这一章按它的标题画成一棵树（章 › 节 › 小节），不用模型、不花 token；点一个节点跳到那里，点箭头折叠一枝。想让它更细，点「交给主会话细化」，主会话会照这一章的页面补全。' }),
  feature({ id: 'reader-more', area: 'material', title: '阅读器的「更多」', page: 'sources', anchors: ['reader-more', 'sources-list'], prepare: 'document',
    aliases: ['更多', '工具栏', '三个点', '显示方式', '阅读', '原文', '掌握度与覆盖', '覆盖', '重命名', '资料重命名', '今日待办', '题组', '使用这份资料的题组', '下载原文件', '宿主文件预览', 'more menu', 'reader toolbar'],
    path: ['资料', '打开一份资料', '工具栏', '更多'],
    what: '阅读器的工具栏只留「目录」「AI 出题」「错题」「思维导图」，其余都在最右边的「更多」里：显示方式（阅读 / 原文 / 原始 PDF）、在文中查找（Ctrl/⌘ F）、翻译…、显示设置…、学习工具、掌握度与覆盖、AI 整理目录…、重命名…、今日相关待办、使用这份资料的题组、下载原文件。' }),
  feature({ id: 'reader-find', area: 'material', title: '在文中查找', page: 'sources', anchors: ['reader-more', 'sources-list'], prepare: 'document',
    aliases: ['查找', '搜索', '搜文中', 'ctrl f', 'cmd f', 'find in text'],
    path: ['资料', '打开一份资料', '工具栏', '更多', '在文中查找'],
    what: '在这份资料里找一个词，也会列出其他章节里的结果。按 Ctrl/⌘ F 直接打开，或在「更多」里点「在文中查找」。' }),
  feature({ id: 'reader-display', area: 'material', title: '阅读显示设置', page: 'sources', anchors: ['reader-more', 'sources-list'], prepare: 'document',
    aliases: ['字号', '版心', '字体', '背景', '下划线', 'Aa', '显示设置', '纸张', 'display settings', 'font size'],
    path: ['资料', '打开一份资料', '工具栏', '更多', '显示设置…'],
    what: '字号、版心宽度、字体、背景、下划线，和中英对照译文怎么显示，都在「更多」的「显示设置…」里；改了所有阅读的地方一起变。' }),
  feature({ id: 'reader-outline-assist', area: 'material', title: 'AI 整理目录', page: 'sources', anchors: ['reader-outline', 'reader-more', 'sources-list'], prepare: 'document',
    aliases: ['让 AI 帮你', '只分章节', '整理目录', '标题解析不对', 'ai outline', 'ai chapters'],
    path: ['资料', '打开一份资料', '工具栏', '更多', 'AI 整理目录…'],
    what: '自动解析的标题不满意时，在「更多」里点「AI 整理目录…」：它会打开「目录」，底部可以让 AI 整理完整目录，或只找出章节（较省）；先估算用量，确认后才调用一次模型。',
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
    path: ['创建题组', '覆盖强度'],
    what: '出题时资料要覆盖到什么程度：精简、标准、完整，或「自定义」一个题数；选得越完整，题越多，花得也越多。出题前会按真实提示词估算大概要用多少 token。' }),
  feature({ id: 'custom-count', area: 'generate', title: '自定义题数', page: 'generate', anchors: ['generate-custom-count', 'generate-coverage', 'generate-from-sources'], prepare: 'materials',
    aliases: ['题数', '题目数量', '几道题', '出多少题', '自定义', 'count', 'number of questions', 'custom'],
    path: ['创建题组', '覆盖强度', '自定义'],
    what: '想自己定题数时，在「覆盖强度」里选「自定义」，填一个数或点常用题数；超过 30 道的会分成几轮，每轮最多 30 题。选回精简、标准或完整，题数就不再起作用。' }),
  feature({ id: 'auto-complete', area: 'generate', title: '自动补到完整', page: 'generate', anchors: ['generate-auto', 'generate-coverage', 'generate-from-sources'], prepare: 'materials',
    aliases: ['自动补', '补到完整', '分轮', '一轮接一轮', '接着出', 'auto complete', 'rounds', 'finish automatically'],
    path: ['创建题组', '覆盖强度', '自动补到完整'],
    what: '一轮出不完的计划，开着它会一轮接一轮自动做完；关掉就只出第 1 轮，其余的在草稿页点「为没覆盖的部分补题」，一次补一轮。精简默认不自动补，标准和完整默认自动补。' }),
  feature({ id: 'budget', area: 'generate', title: '花费上限', page: 'generate', anchors: ['generate-budget', 'generate-from-sources'], prepare: 'materials',
    aliases: ['token', 'tokens', '预算', '上限', '限额', '省钱', '最多用', 'token budget', 'cost cap', 'spending limit'],
    path: ['创建题组', MORE, '花费', '花费上限'],
    what: '给一次出题设一个 token 上限（例如 2M）：用到了就在一轮结束时停下，已通过的题都保留；不填就不设上限。' }),
  feature({ id: 'difficulty', area: 'generate', title: '难度', page: 'generate', anchors: ['generate-difficulty', 'generate-from-sources'], prepare: 'materials',
    aliases: ['基础理解', '应用迁移', '深入辨析', '混合', '难易', 'difficulty', 'level'],
    path: ['创建题组', MORE, '难度与语言', '难度'],
    what: '这次出的题偏基础还是偏难：混合、基础理解、应用迁移、深入辨析。默认值在「设置 › 出题偏好」里改。' }),
  feature({ id: 'question-language', area: 'generate', title: '出题语言', page: 'generate', anchors: ['generate-language', 'generate-from-sources'], prepare: 'materials',
    aliases: ['语言', '中文', '英文', '中英双语', 'english', 'language', 'bilingual questions'],
    path: ['创建题组', MORE, '难度与语言', '语言'],
    what: '这次出的题用什么语言写：中文、English 或中英双语。默认值在「设置 › 出题偏好」里改。' }),
  feature({ id: 'notation', area: 'generate', title: '公式写法', page: 'generate', anchors: ['generate-notation', 'generate-from-sources'], prepare: 'materials',
    aliases: ['公式', 'latex', '数学公式', '纯文本', '公式乱码', 'formula', 'notation', 'math'],
    path: ['创建题组', MORE, '难度与语言', '公式写法'],
    what: '题目里的公式怎么写：自动、纯文本或公式（LaTeX）。纯文本更稳定，公式适合数学、化学。默认值在「设置 › 出题偏好」里改。' }),
  feature({ id: 'generate-focus', area: 'generate', title: '这次想练什么', page: 'generate', anchors: ['generate-focus', 'generate-from-sources'], prepare: 'materials',
    aliases: ['侧重点', '练习重点', '想练什么', '主题', 'focus', 'what to practise'],
    path: ['创建题组', MORE, '想练什么', '这次想练什么？'],
    what: '写一句这次想练什么（例如「区分相似模式，重点练习工程场景中的取舍」），出题会侧重它；不写也可以出题。' }),
  feature({ id: 'generate-assist', area: 'generate', title: '帮我想想', page: 'generate', anchors: ['generate-assist', 'generate-focus', 'generate-from-sources'], prepare: 'materials',
    aliases: ['建议', 'ai 建议', '不知道练什么', '帮我想想练什么', 'suggest', 'suggestions'],
    path: ['创建题组', MORE, '想练什么', '这次想练什么？', '帮我想想'],
    what: '不知道练什么时点它：它只发送资料标题和目录，不发送全文；没有模型时，会改用你的错题给建议。' }),
  feature({ id: 'reference-questions', area: 'generate', title: '参考样题', page: 'generate', anchors: ['generate-reference', 'generate-from-sources'], prepare: 'materials',
    aliases: ['样题', '真题', '往年题', '样卷', '模仿样题', 'reference questions', 'sample questions', 'past papers'],
    path: ['创建题组', MORE, '想练什么', '参考样题（可选）'],
    what: '上传自己教材里的优质题目，或选已导入的样题：出题只参考题型、难度和表达方式，要求生成原创题，事实和答案仍以教材依据为准。所选样题会随教材发给模型，增加输入 token。' }),
  feature({ id: 'target-role', area: 'generate', title: '目标岗位 / 面试方向', page: 'generate', anchors: ['generate-role', 'generate-from-sources'], prepare: 'materials',
    aliases: ['目标岗位', '岗位', '面试方向', '面试', '职位', 'role', 'interview'],
    path: ['创建题组', MORE, '题组信息', '面试方向（可选）'],
    what: '为面试准备出题时，写下目标岗位或面试方向（例如「后端工程师 · 系统设计」），出题会据此调整；普通课程出题不用填，它收在「更多选项」里的「面试方向」下。' }),
  feature({ id: 'question-kinds', area: 'generate', title: '题型', page: 'generate', anchors: ['generate-kinds', 'generate-from-sources'], prepare: 'materials',
    aliases: ['单选', '多选', '判断', '判断题', '对错题', '闪卡', '开放问答', '填空', '动手', '动手任务', '选择题', '出什么题', 'question types', 'kinds', 'multiple choice', 'true/false', 'true or false', 'cloze', 'hands-on', 'hands-on task'],
    path: ['创建题组', '题型'],
    what: '这次出哪几种题：单选测验、多选测验、判断题、闪卡、开放问答、填空卡、动手任务，可以多选，总题数会在几种题型之间平均分配。默认值在「设置 › 出题偏好」里改。' }),
  feature({ id: 'deck-course', area: 'generate', title: '新题组放进的课程', page: 'generate', anchors: ['generate-course', 'generate-from-sources'], prepare: 'materials',
    aliases: ['课程归属', '课程', '归到哪门课', '放进课程', '改课程', 'deck course', 'course'],
    path: ['创建题组', '新题组放进的课程', '更改'],
    what: '新题组默认放进你勾选的资料所在的课程（资料列表上方的「课程范围」只用来筛选资料）；点「更改」可以另选或新建一门课，留空就是未分类。' }),
  feature({ id: 'top-up', area: 'generate', title: '为没覆盖的部分补题', page: 'draft', anchors: ['coverage-topup', 'draft-publish'], prepare: 'draft',
    aliases: ['补题', '补齐', '没覆盖', '补全题目', '接着补', 'top up', 'top-up', 'coverage gap'],
    path: ['草稿与发布', '为没覆盖的部分补题'],
    what: '草稿里还有资料小节没有题时，点它按小节补一轮题；开着「自动补到完整」会一轮接一轮补，直到每个小节都有题。补之前会先估算要用多少。学习库首页的待发布行和「任务」里也有这个入口。',
    needs: { model: true } }),
  feature({ id: 'draft-coverage', area: 'generate', title: '覆盖率与计划进度', page: 'draft', anchors: ['draft-coverage', 'draft-publish'], prepare: 'draft',
    aliases: ['覆盖率', '覆盖了多少', '覆盖进度', '计划进度', '计划做完了', '不在计划里', '生成详情', 'coverage', 'plan progress'],
    path: ['草稿与发布', '覆盖'],
    what: '草稿页的「覆盖」一栏用一行写覆盖了几个小节、占百分之几，下面一句话说出题计划是否做完、还有几个小节不在计划里；每轮怎么分在草稿页的「生成详情」里。「任务」里点开出题任务，也是同一栏，那里的「计划进度」只说计划做完了多少。' }),
  feature({ id: 'publish-draft', area: 'generate', title: '发布草稿', page: 'draft', anchors: ['draft-publish'], prepare: 'draft',
    aliases: ['发布', '草稿', '待发布', '发布并开始练', 'publish', 'draft'],
    path: ['草稿与发布', '页面底部的操作栏', '发布并开始练'],
    what: 'AI 出的题先放进草稿：你可以逐题核对、修改或删除，确认无误再发布，发布后就能开始练习。「保存并校验」和「发布并开始练」在页面底部的操作栏里，往下翻题目时它一直在。' }),
  feature({ id: 'delete-draft', area: 'generate', title: '删除草稿', page: 'draft', anchors: ['draft-more', 'draft-publish'], prepare: 'draft',
    aliases: ['删草稿', '丢弃草稿', '不要这份草稿', '删除这份草稿', 'delete draft', 'discard draft'],
    path: ['草稿与发布', '页面底部的操作栏', '更多（⋯）', '删除草稿'],
    what: '草稿页底部操作栏里的「更多」（⋯）菜单：点「删除草稿」会先问一次，确认后永久删除这份草稿里还没发布的题；出题用的资料和已经发布的题组不会删。' }),
  feature({ id: 'draft-advanced', area: 'generate', title: '高级编辑', page: 'draft', anchors: ['draft-advanced', 'draft-publish'], prepare: 'draft',
    aliases: ['json 编辑', '改 json', 'edit json', 'advanced edit'],
    path: ['草稿与发布', '题目', '高级编辑'],
    what: '草稿页「题目」一栏里折叠着「高级编辑」，里面的「JSON 编辑」可以直接用 JSON 改这份草稿。' }),

  // ── 练习与复习 ──
  feature({ id: 'hint', area: 'practice', title: '提示', page: 'review', anchors: ['review-hint'], prepare: 'run',
    aliases: ['讲解', '看提示', '线索', 'hint', 'h'],
    path: ['练习', '题目下方', '提示'],
    what: '做题时点「提示」先看线索；揭晓答案以后，它变成「讲解」。按 H 键也能打开。' }),
  feature({ id: 'task-check', area: 'practice', title: '动手任务与静态检查', page: 'review', anchors: ['task-practice', 'review-more'], prepare: 'run',
    aliases: ['动手任务', '动手', '在主会话里检查', '静态检查', '看参考实现', '写完了', '自报', '不跑测试', 'hands-on task', 'static check', 'check in main chat', 'reference solution', 'self-report'],
    path: ['练习', '动手任务', '在主会话里检查'],
    what: '动手任务不在应用内提供编辑器、也不运行测试：你在本地写完代码、SQL、推导或方案后，点「在主会话里检查」，主会话只读你指定的文件，按验收标准逐条判满足、缺失或有问题（最多指出 3 处问题，不替你改文件），并写回练习记录；也可以点「看参考实现」（记为看过答案）或「写完了（自报）」（记为自报，未验收）。' }),
  feature({ id: 'help-me-understand', area: 'practice', title: '帮我弄懂', page: 'review', anchors: ['review-help'], prepare: 'run',
    aliases: ['不懂', '助教', '通俗详解', '讲解', 'explain', 'help me understand', 'tutor'],
    path: ['练习', '题目下方', '帮我弄懂'],
    what: '卡住了点它：后台助教会结合原文讲解这道题、补上前置知识，讲完送进信箱，不打断你做题。',
    needs: { model: true } }),
  feature({ id: 'fix-question', area: 'practice', title: '修题', page: 'review', anchors: ['review-improve'], prepare: 'run',
    aliases: ['改题', '修改题目', '题目不好', '题干不清楚', '答案不准确', '让助教检查', 'improve question', 'fix a question', 'repair question'],
    path: ['练习', '题目下方', '修题'],
    what: '觉得这道题不好，点题目下方的「修题」：点一个常见的问题（或者自己写一句），后台助教会直接改这张卡，改完可以一步撤销。',
    needs: { model: true } }),
  feature({ id: 'fix-phrases', area: 'practice', title: '我的常用语句', page: 'review', anchors: ['review-improve'], prepare: 'run',
    aliases: ['自定义修题', '自定义语句', '常用语句', '复用语句', '个性化修题', '我的语句', 'my phrases', 'custom fix phrase', 'reusable phrase'],
    path: ['练习', '题目下方', '修题', '我的常用语句'],
    what: '在「修题」框里写好一句话，点「存为我的常用语句」，它就和内置的常见问题排在一起，以后点一下就填进框里；每条旁边的 ✕ 可以删掉（几秒内可撤销）。最多 12 条，每条最多 200 字，存在学习库的设置里。' }),
  feature({ id: 'autopilot', area: 'practice', title: '自动跳下一步', page: 'review', anchors: ['review-more'], prepare: 'run-more',
    aliases: ['自动驾驶', '自动下一题', '自动进入下一题', '答对后自动', 'autopilot', 'auto next', 'auto-advance'],
    path: ['练习', '题目下方', '更多', '自动跳下一步'],
    what: '答对后自动进入下一题，点任意处或按键可以停下；在题目下方的「更多」里开关，按 A 键也行。默认值在「设置 › 练习」里。' }),
  feature({ id: 'en-toggle', area: 'practice', title: '显示英文（EN）', page: 'review', anchors: ['review-more'], prepare: 'run-more',
    aliases: ['EN 双语切换', 'en', 'english', '英文', '双语', '中英', 'bilingual'],
    path: ['练习', '题目下方', '更多', '显示英文'],
    what: '在题目下方的「更多」里打开「显示英文」，中文题干和答案后面就会显示英文。' }),
  feature({ id: 'font-size', area: 'practice', title: '字号与版心（Aa）', page: 'review', anchors: ['review-more'], prepare: 'run-more',
    aliases: ['Aa 字号', '字号', '字体大小', 'aa', '显示设置', '版心宽度', '阅读设置', 'font size', 'reading settings'],
    path: ['练习', '题目下方', '更多', '字号与版心…'],
    what: '在题目下方的「更多」里选「字号与版心…」，调字号、版心宽度、字体和背景，还有「排版微调」；只改阅读和做题页的文字，不改整个界面。' }),
  feature({ id: 'thumbs', area: 'practice', title: '这题不错 / 这题有问题', page: 'review', anchors: ['review-more'], prepare: 'run-more',
    aliases: ['点赞 / 点踩', '点赞', '点踩', '给题目打分', '打分', '评分', '反馈', 'thumbs', 'rate a question', 'g', 'b'],
    path: ['练习', '题目下方', '更多', '这题不错 / 这题有问题…'],
    what: '在题目下方的「更多」里选「这题不错」或「这题有问题…」；选后者可以再选标签（题干太空、选项太烂、太简单、太难、答案有误、解析不清、只问资料怎么说）。快捷键 G / B。' }),
  feature({ id: 'write-note', area: 'practice', title: '写笔记', page: 'review', anchors: ['review-more'], prepare: 'run-more',
    aliases: ['笔记', '记笔记', '存笔记', 'note', 'write a note'],
    path: ['练习', '题目下方', '更多', '写笔记'],
    what: '把想法存下来：在题目下方的「更多」里选「写笔记」。存下的笔记收在「学习笔记」里，可以跳回对应的题。' }),
  feature({ id: 'slay', area: 'practice', title: '斩题', page: 'review', anchors: ['review-more'], prepare: 'run-more',
    aliases: ['斩掉此题', '斩', '不再复习', '斩题组', 'slay', 'retire a question'],
    path: ['练习', '题目下方', '更多', '斩掉此题'],
    what: '把这道题移入斩题组，不再复习；斩掉的当时可以点「撤销」，恢复到原题组。' }),
  feature({ id: 'retrain', area: 'practice', title: '重练错题', page: 'wrongbook', anchors: ['wrongbook-retrain', 'wrongbook-list'], prepare: 'mistakes',
    aliases: ['重练', '错题重练', '巩固', '开始重练', '练错题', '练这一组', '练筛选的', 'retrain', 'redo mistakes'],
    path: ['错题与待巩固', '重练'],
    what: '选好这一轮练什么（只练错题、加上同类题，或加上变式），点「开始重练」，把待巩固的题按学习路径再练一遍；筛选之后，也可以只练筛出来的，有多个题组时每个题组旁边还有「练这一组」。' }),
  feature({ id: 'similar', area: 'practice', title: '同类题', page: 'wrongbook', anchors: ['wrongbook-recs', 'wrongbook-list'], prepare: 'mistakes',
    aliases: ['相似题', '类似题', '举一反三', 'similar questions', 'similar'],
    path: ['错题与待巩固', '点开一道错题', '同类题'],
    what: '点开一道错题的详情，能看到题库里已有的同类题，可以直接去练；页面上的「为你推荐」是同一类东西，想和错题一起练，在「重练」里选「错题 + 同类题」。' }),
  feature({ id: 'variants', area: 'practice', title: '生成变式', page: 'wrongbook', anchors: ['wrongbook-batch', 'wrongbook-list'], prepare: 'mistakes',
    aliases: ['变式', '变式题', '改写错题', '为全部错题生成变式', 'variant', 'variants', 'rewrite mistakes'],
    path: ['错题与待巩固', '生成变式'],
    what: '为错题改写新的变式题：每道题约 1 次轻量模型调用，一次有题数上限；错题只有一道时用它旁边的「生成变式」，多了页面上还有「为全部错题生成变式」；写好的题放进「为你定制」，点「去练」开练。',
    needs: { model: true } }),
  feature({ id: 'recommend', area: 'practice', title: '为你推荐', page: 'wrongbook', anchors: ['wrongbook-recs', 'wrongbook-list'], prepare: 'mistakes',
    aliases: ['推荐', '相似题', '同主题', '不消耗模型', '练这几道', 'recommendations', 'recommended'],
    path: ['错题与待巩固', '为你推荐'],
    what: '直接从题库里找相似的题：同主题、引用同一页，或关键词相近，已排除你刚答对的；不消耗模型。这一行只说明找到了什么，要练就在「重练」里选「错题 + 同类题」，再点「开始重练」。' }),
  feature({ id: 'wrongbook-filter', area: 'practice', title: '筛选与搜索错题', page: 'wrongbook', anchors: ['wrongbook-filter', 'wrongbook-list'], prepare: 'mistakes',
    aliases: ['筛选', '搜索错题', '按题组看', '按主题', '按题组', '全部展开', '全部收起', '只看这个题组', '题组筛选', 'filter mistakes', 'search mistakes', 'group by topic', 'expand all'],
    path: ['错题与待巩固', '列表上方的筛选栏'],
    what: '错题满 10 道，列表上方才出现这一排：按主题或按题组分组、全部展开 / 全部收起、按题组 / 状态 / 文字筛选，每个题组旁还有「只看这个题组」。少于 10 道时一眼就能看完，所以没有这一排。' }),
  feature({ id: 'wrongbook-refresh', area: 'practice', title: '刷新错题', page: 'wrongbook', anchors: ['wrongbook-list', 'nav-wrongbook'],
    aliases: ['刷新', '重新读取', '更新错题', 'refresh', 'reload mistakes'],
    path: ['错题与待巩固'],
    what: '错题页不再有「刷新」按钮：打开着的时候它每隔几秒自己看一眼，有新的错题或错题已订正就会更新，展开的题组和题保持原样。' }),
  feature({ id: 'book-cheat-sheet', area: 'practice', title: '速查表', page: 'book', anchors: ['book-more', 'nav-book'], prepare: 'book',
    aliases: ['速查', '开卷速查', '小抄', '打印', '打印速查', '存为 PDF', '导出 html', '术语卡', '易混', '公式页', 'cheat sheet', 'cheatsheet', 'print', 'pdf', 'open book', 'export html'],
    path: ['复习全书', '更多', '速查表'],
    what: '把答题模板、题干信号矩阵、易混对照、公式和术语卡排成密密的两栏一页，每条都标着书里的哪一节，点一节的编号回到书里那一节；「打印 / 存为 PDF」按 A4 两栏打印，「下载 .html」存成一个能离线打开的页面（手机上也能看）。书里还没有术语卡、答题模板或公式时，这一项不出现；这门课的定制方案（深度定制）没勾「速查表」时也不出现，没勾「公式」或「索引」时，速查页里的公式页、生词与概念和术语卡（按章）同样不出现，在课程设置的「你的定制」里勾上就回来。「导出…」里也有同一个下载；整本书也能存成这样一个页面，见「导出复习全书」。' }),
  feature({ id: 'book-export', area: 'practice', title: '导出复习全书', page: 'book', anchors: ['book-more', 'nav-book'], prepare: 'book',
    aliases: ['导出', '导出全书', '导出 html', '整本书网页', '离线打开', '打印整本书', '发给同学', '不含原文引文', '去掉引文', '分享', 'markdown', 'pandoc', 'zip', 'export book', 'export html', 'whole book page', 'offline book', 'print the book', 'share the book', 'without quotes'],
    path: ['复习全书', '更多', '导出…'],
    what: '「更多 › 导出…」把整本书存成三种：一个 Markdown 文件（给 Pandoc 用）、分文件的 zip，或「整本书（.html）」，一个能离线打开、也能打印的页面：每章另起一页，出处在章末，手机上也能看，按钮上写着约多少页 A4。发给别人时勾「整本书页面不含原文引文」：脚注和答案册概念里逐字摘自资料的原文去掉，只留出处（资料名）；这个选项只对整本书页面起作用。印哪些题、含不含答案册，三种都一样。' }),
  feature({ id: 'custom-book-menu', area: 'practice', title: '深度定制', page: 'book', anchors: ['book-more', 'nav-book'], prepare: 'book',
    aliases: ['深度定制', '定制', '定制方案', '定制这本书', '只学考试范围', '挑几章', '复习全书要哪些部分', '要不要出题', 'customize', 'customise', 'custom plan', 'customize in depth'],
    path: ['复习全书', '更多', '深度定制…'],
    what: '让主会话问你几个选项：这本书用来做什么、要学哪些章、复习全书要哪些部分、要不要出题、要不要学习计划；确认之后才生成，选了什么就只做什么，答案存成这门课的定制方案。只填进主会话的输入框，由你按发送。' }),
  feature({ id: 'custom-book-import', area: 'material', title: '深度定制这本书', page: 'sources', anchors: ['custom-book', 'import-mineru', 'sources-add'], prepare: 'add-dialog',
    aliases: ['深度定制', '定制', '定制这本书', '大书', '整本教材', '五百页', 'customize this book', 'customize', 'custom plan'],
    path: ['资料', '添加资料', '解析历史', '深度定制这本书'],
    what: '导入或解析完一份 150 页以上的资料后，它出现在解析完成的任务卡片上（「用它出题」旁边）、「添加资料」的文件列表和「解析历史」里的那一行，点过一次就不再出现：让主会话先问你几个选项，再决定这本书做什么。短资料不出现；以后随时可以在「资料」页那本书的那一行（「查看 N 章」旁边）或复习全书的「更多」里找到「深度定制」。' }),
  feature({ id: 'custom-book-row', area: 'material', title: '深度定制（资料那一行）', page: 'sources', anchors: ['custom-book-row', 'sources-list'], prepare: 'materials',
    aliases: ['深度定制', '定制', '查看定制', '修改定制', '定制方案', '大书', '整本教材', '五百页', 'customize', 'custom plan', 'view custom plan'],
    path: ['资料', '150 页以上的资料那一行', '深度定制'],
    what: '150 页以上的资料，在「资料」页它那一行的「查看 N 章」旁边一直有「深度定制」，不是只出现一次：让主会话问你几个选项，再决定这本书做什么；确认之前不生成任何东西。这门课已经有定制方案时它写成「查看/修改定制」，主会话只问你想改的地方。只填进主会话的输入框，由你按发送。' }),
  feature({ id: 'custom-book-gate', area: 'practice', title: '生成总纲前先问要不要深度定制', page: 'outline', anchors: ['outline-organise'], prepare: 'outline',
    aliases: ['生成总纲', '生成复习全书', '整本生成', '先深度定制', '整本书', '大书', '确认', '估算', '用量', 'generate outline', 'generate review book', 'whole book', 'confirm'],
    path: ['总纲', '生成总纲', '深度定制这本书（推荐）'],
    what: '课程里有 150 页以上的资料、又还没有定制方案时，在总纲页点「生成总纲」或第一次点「生成复习全书」不会马上开始：先问你「深度定制这本书（推荐）」「整本生成」还是「取消」，并按这次生成自己的估算写出大约要几次模型调用、读多少 token（只是估计，不含价格，不调用模型）。选「整本生成」和以前一样马上开始；已有定制方案或资料都不到 150 页时，点一下就开始。' }),
  feature({ id: 'weekly-plan', area: 'practice', title: '每周几章的备考计划', page: 'book', anchors: ['book-weekly', 'nav-book'], prepare: 'book',
    aliases: ['本周', '每周几章', '本周读哪几章', '没有考试日期的计划', '按周学习', 'weekly plan', 'chapters a week', 'this week'],
    path: ['复习全书', '备考计划'],
    what: '在深度定制里选「按每周几章排」，没有考试日期也有计划：复习全书的「备考计划」和首页的「本周」卡片写着「本周：第 3–4 章」和今天读哪几节；前几周没学完的会排进本周，不会丢。' }),
  feature({ id: 'daily-recap', area: 'practice', title: '每日讲解合集', page: 'settings', anchors: ['settings-daily-recap'],
    aliases: ['讲解合集', '错题合集', '每日错题讲解', 'recap', 'daily recap'],
    path: ['设置', '每日讲解合集'],
    what: '同一天、同一课程只保留一篇合集，累计完成 10 道不同题目才生成；默认关闭，开启后会用当前 AI 模型。生成的合集收在「学习笔记」里。',
    needs: { model: true } }),
  feature({ id: 'guided-study', area: 'daily', title: 'AI 带学', page: 'guided', anchors: ['hand-off'],
    aliases: ['带学', '讲给我听', '先讲后练', '主会话带学', '学习流', 'guided study', 'explain to me', 'tutor', 'learning flow', 'workflow'],
    path: ['许多页面', '发给主会话'],
    what: '把这一阶段的资料交给主会话一步步讲清楚、边讲边问，不懂的地方当场追问。',
    needs: { capability: ['study'], model: true } }),
  feature({ id: 'task-controls', area: 'daily', title: '任务的停止与调整时限', page: 'tasks', anchors: ['tasks-detail', 'nav-tasks'], prepare: 'task',
    aliases: ['停止', '暂停', '停在这里', '时限', '运行时限', '超时', '取消任务', '任务控制台', 'stop', 'pause', 'time limit', 'timeout', 'cancel a task'],
    path: ['任务', '点开一个任务', '停止 / 调整时限'],
    what: '点开「任务」里的一个任务：进行中的可以暂停或停止（分轮出题的叫「停在这里」，已通过的题都保留），停下的可以「接着做」。详情里写明时限和已用时间；时限由设置决定时，「调整时限」会带你去「设置 › 出题偏好」改每轮运行时限，只对之后开始的任务生效。' }),
  feature({ id: 'delete-task', area: 'daily', title: '删除任务记录', page: 'tasks', anchors: ['tasks-more', 'tasks-detail'], prepare: 'task',
    aliases: ['删除任务', '删除记录', '清掉任务', '删除这一天', 'delete task', 'remove task record'],
    path: ['任务', '点开一个已结束的任务', '更多（⋯）', '删除任务记录'],
    what: '点开「任务」里一个已结束的任务，详情右上角的「更多」（⋯）菜单里有「删除任务记录」：记录马上从列表里消失，几秒内可以撤销；资料、草稿和题组不会删。进行中的任务不能删除。也可以勾选几个已结束的任务，用批量栏一起删。' }),
  feature({ id: 'mailbox', area: 'practice', title: '信箱', page: null, anchors: ['topbar-mailbox'],
    aliases: ['通知', '消息', '后台结果', '邮件', 'mailbox', 'inbox', 'notifications'],
    path: ['页面顶栏', '信箱'],
    what: '后台替你做完的事（改题、前置题、讲解、译文、批改、音频转写、PDF 转换……）都投递到信箱；点一条直接跳回那道题或那份结果，「全部已读」只清角标，不删记录。' }),

  // ── 考试与统计 ──
  feature({ id: 'exam-formats', area: 'exam', title: '模拟考试的三种形式', page: 'exam', anchors: ['exam-case'],
    aliases: ['笔试', '选择题笔试', '案例卷', '案例分析卷', '口头面试', '面试', '考试形式', 'written exam', 'oral exam', 'case exam', 'exam format'],
    path: ['模拟考试', '考试形式'],
    what: '在这里切换选择题笔试、案例分析卷和口头面试，都是限时作答；交卷后给出成绩单和逐题解析，案例卷按评分标准逐项批改。' }),
  feature({ id: 'oral-exam', area: 'exam', title: '口头面试', page: 'exam', anchors: ['exam-case'],
    aliases: ['口试', '面试', '口头检验', '追问', 'oral exam', 'oral check', 'interview'],
    path: ['模拟考试', '考试形式'],
    what: '像面试一样一问一答、追问到底，检验这一阶段是不是真能讲出来；交卷后给出逐题点评。',
    needs: { capability: ['bank', 'study'], model: true } }),

  // ── 课程与录音 ──
  feature({ id: 'course-settings', area: 'course', title: '课程设置', page: 'library', anchors: ['home-course'],
    aliases: ['考试日期', '分值', '总分', '重点', '重点知识点', '考试说明', '倒计时', '考试信息', '岗位', '岗位方向', '岗位说明', 'jd', '面试', '笔试 / 面试', 'course settings', 'exam date', 'exam info', 'role', 'job description', 'interview'],
    path: ['学习库', '课程标题', '课程设置…'],
    what: '每门课可以记下考试形式、总分、作答和阅读时间、考试日期，也能放入老师的考试说明、重点知识点，以及可选的岗位方向与 JD（供笔试或口头面试准备使用）；课程标题旁会显示距考试还有几天。在课程标题的下拉菜单最后选「课程设置…」，或到「设置 › 课程」。' }),
  feature({ id: 'course-method', area: 'course', title: '学法', page: 'library', anchors: ['course-method', 'home-course'],
    aliases: ['学法', '学法卡', '阶段', '课堂跟学', '学习流', '自定义流程', '笔试 / 面试准备', '过关宽严', '也可以', '改学法', '和主会话改学法', 'study method', 'learning method', 'course method', 'stages', 'learning flow', 'workflow'],
    path: ['学习库', '课程标题', '课程设置…', '学法'],
    what: '每门课按哪几个阶段学、过关宽严怎么算，以及当前阶段「也可以」用哪些功能；默认是课堂跟学，不改也照常学，随时可以轻改或和主会话一起改。' }),
  feature({ id: 'custom-readiness', area: 'course', title: '章节准备度与补齐', page: 'library', anchors: ['custom-readiness', 'home-course'],
    aliases: ['准备度', '章节准备度', '这一章准备好了吗', '补齐', '补漏', '没写讲解', '没出题', '扎实', 'readiness', 'chapter readiness', 'fill gaps', 'fill what is missing'],
    path: ['学习库', '课程标题', '课程设置…', '你的定制', '章节准备度'],
    what: '课程有定制方案、也生成了复习全书之后，「课程设置」的「你的定制」下面列出方案里每一章的准备度：一条细条是扎实的知识点占比，悬停能看到讲解、有题、练过、扎实各有几个知识点；书里还没写的章标「未生成」。「补齐」会先说明要做什么、大概多少次模型调用，点「开始补齐」才开始，只启动已有的任务（生成讲解、出题、变式题），进度在「任务」里。' }),
  feature({ id: 'live-local', area: 'course', title: '课堂实录的本地转写', page: 'settings', anchors: ['settings-audio'],
    aliases: ['本地转写', '本地引擎', '声音不上传', '离线转写', 'live local', 'local transcription', 'offline'],
    path: ['设置', '音频转写', '课堂实录的转写方式'],
    what: '课堂实录可以用 Gemini（云端，要密钥），也可以用本地转写：声音不上传，不需要密钥，要先安装。在「设置 › 音频转写」里选，也能在「课堂实录」页安装。',
    needs: { capability: 'audio', install: '本地转写引擎' } }),
  feature({ id: 'live-pause', area: 'course', title: '断句停顿', page: 'settings', anchors: ['settings-live-pause'],
    aliases: ['断句', '停顿', '讲得快', '一直没有断句', '润色 0 句', 'sentence pause', 'pause length'],
    path: ['设置', '音频转写', '断句停顿'],
    what: '课堂实录多久没有新文字（本地转写：多久没有声音）就算一句话说完。老师讲得快、几乎不停顿时选「短」，句子会更早出现，润色和出题也更早能用；下次开始或接着录时生效。',
    needs: { capability: 'audio' } }),
  feature({ id: 'live-polish', area: 'course', title: '课堂实录的润色状态与重试', page: 'live', anchors: ['live-polish', 'nav-live'], prepare: 'live-class',
    aliases: ['上下文润色', '润色', '已检查', '已润色', '已跳过', '原文保留', '重试待校正内容', '润色失败', '润色超时', '润色 0 句', 'polish', 'skipped', 'retry polish'],
    path: ['课堂实录', '逐字稿上方的「上下文润色」一行'],
    what: '逐字稿上方的「上下文润色」一行写着已检查、已润色和已跳过几句；有句子太长或超时被跳过（原文保留），或出了错，错误就在这一行里，点它旁边的「重试待校正内容」再试；用了多少次模型在「说明与用量」里。',
    needs: { capability: 'audio', model: true } }),
  feature({ id: 'live-selection', area: 'course', title: '在实录里选句出题', page: 'live', anchors: ['live-selection', 'nav-live'], prepare: 'live-class',
    aliases: ['最近一段', '最近 8 句', '选中内容出题', '勾选句子', '划选', '清空', '题数', '实录出题', 'recent', 'last 8 sentences', 'select sentences'],
    path: ['课堂实录', '逐字稿下面的选择栏'],
    what: '勾选句子或划选文字，或点「最近一段」选中最近约 1200 个字符，再点「选中内容出题」。按钮灰着时，悬停或聚焦它会说为什么（还没选句子、字数不够、一次最多 400 句）。',
    needs: { capability: 'audio', model: true } }),
  feature({ id: 'live-save', area: 'course', title: '实录结束后保存为资料与课堂笔记', page: 'live', anchors: ['live-save', 'nav-live'], prepare: 'live-class',
    aliases: ['保存为资料', '校对后保存', '课堂笔记', '笔记', '结束实录', '实录保存', 'save class', 'class notes', 'save as source'],
    path: ['课堂实录', '结束实录', '保存按钮'],
    what: '结束实录后随时可以点「保存为资料」，不会因为润色或译文没做完而点不了：它会先补完润色和译文，再存下文字稿和课堂笔记；润色没整理出笔记时，会用文字稿另外整理一份；做不完的，任务里会写清楚。',
    needs: { capability: 'audio' } }),

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
    aliases: ['检索', '索引', '建立索引', '大教材', '整本书', '上百页', 'token', '耗 token', '本地模型', 'retrieval', 'index', 'rag', 'large textbook', 'tokens', 'embedding model'],
    path: ['设置', '检索扩展'],
    what: '给上百页的大教材用：在「设置 › 检索扩展」的「检索：只让 AI 看相关页面」装好检索扩展并为课程建立索引后，整本书出题时只读相关页面，更省 token、也更聚焦；超过 15 万字的选择会先用它挑页。建索引在本机算，不调用 AI、不耗 token，资料不离开电脑；第一次要下载约 90 MB 的检索模型，只下载一次。150 页以上的书还没建索引时，「添加资料」的文件列表下面、解析完成的卡片和「解析历史」里「深度定制这本书」旁，以及「更多 › 整本书」里，都有「先建立检索索引」，点它直达这里；「创建题组」和「资料」页列表上方的「有 N 份资料的索引还没建完 · 去建立索引」也一样，悬停能看到用途。',
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
    path: ['设置', '界面', '更多外观选项', '界面字体'],
    what: '选界面字体和标题字体；也可以填本机已安装的字体名，找不到会用系统字体。' }),
  feature({ id: 'appearance-density', area: 'settings', title: '界面密度', page: 'settings', anchors: ['settings-appearance-density'],
    aliases: ['密度', '紧凑', '间距', '行距', 'density', 'compact', 'spacing'],
    path: ['设置', '界面', '更多外观选项', '界面密度'],
    what: '密度只改间距和行距，不改字号。' }),
  feature({ id: 'appearance-radius', area: 'settings', title: '圆角', page: 'settings', anchors: ['settings-appearance-radius'],
    aliases: ['圆角大小', '方角', 'radius', 'rounded corners', 'corners'],
    path: ['设置', '界面', '更多外观选项', '圆角'],
    what: '调卡片、按钮这些东西的圆角大小。' }),
  feature({ id: 'appearance-motion', area: 'settings', title: '动画', page: 'settings', anchors: ['settings-appearance-motion'],
    aliases: ['减弱动画', '无动画', '卡顿', '页面切换', 'motion', 'animation', 'reduce motion', 'lag'],
    path: ['设置', '界面', '更多外观选项', '动画'],
    what: '减弱只保留很短的淡入淡出；无动画则不再有页面切换和卡片动画（转圈提示仍会转）。页面切换卡顿时可以试试。' }),
  feature({ id: 'appearance-contrast', area: 'settings', title: '对比度', page: 'settings', anchors: ['settings-appearance-contrast'],
    aliases: ['高对比', '看不清', 'contrast', 'high contrast'],
    path: ['设置', '界面', '更多外观选项', '对比度'],
    what: '高对比会加深边框和次要文字、加粗焦点框；跟随系统时，遵循系统的“增加对比度”设置。' }),
  feature({ id: 'appearance-transfer', area: 'settings', title: '复制 / 导入外观', page: 'settings', anchors: ['settings-appearance-transfer'],
    aliases: ['导出外观', '导入外观', '复制外观设置', '下载外观', '外观设置', '换电脑', 'export appearance', 'import appearance', 'copy appearance', 'move appearance'],
    path: ['设置', '界面', '更多外观选项', '复制外观设置'],
    what: '把整套外观带到另一台电脑：点「复制外观设置」（或「下载为文件」），在那边点「导入外观」，粘贴或选这个文件。「更多外观选项」点开才看得到。' }),
  feature({ id: 'appearance-reset', area: 'settings', title: '恢复默认外观', page: 'settings', anchors: ['settings-appearance-reset'],
    aliases: ['重置外观', '还原外观', '界面乱了', '字太大', 'reset appearance', 'restore default appearance', 'default look'],
    path: ['设置', '界面', '恢复默认外观'],
    what: '一键把语言以外的外观（明暗、强调色、大小、字体、动画、对比度、密度、圆角）都改回默认。' }),
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
  feature({ id: 'diagnostics', area: 'settings', title: '复制诊断信息', page: 'settings', anchors: ['settings-diagnostic'],
    aliases: ['诊断信息', '诊断', '报问题', '反馈问题', '报错', '出错', '崩溃', 'diagnostic', 'diagnostics', 'diagnostic info', 'bug report', 'crash', 'error report'],
    path: ['设置', '关于与更新'],
    what: '报问题时用：复制一段文字，里面只有版本、界面语言、页面、出错类型、程序自带的报错短句、出错位置的函数名、任务类型和状态、资料/题组/题目的数量，以及实验性功能是否开启；别的报错内容只写字数，不复制。复制前可以先读一遍，DSH 版本要自己补上。某个页面出错时，出错页上也有同名按钮。' }),
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
    what: '侧栏上方是最常用的几项，其余的按内容收在「更多」里：资料与出题、练习与复习、考试与统计、任务、笔记与待办。按住一项拖到上方就放进常用的几项（最多 6 项，满了先把其中一项拖到「更多」），用键盘时按 Alt 加上下方向键。' }),
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
    what: '输入一个词（中文、英文或常见叫法都行）就能找到功能在哪，选中后「带我去」会切到那一页，并把焦点放到那个控件上。按 Ctrl K（Mac 上 ⌘K），或在没有输入框聚焦时按 /，也能打开。' }),
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
