/* The one table of the app's pages (ui-consistency #109). The sidebar, the breadcrumb, the availability check and the
   renderer (ui/app/page-views.jsx) all read it, so a page is added in one row and not in four places.

   label    the sidebar entry (Chinese source text; callers pass it through ui())
   title    the heading in the top bar; `review` has none because its title is the run's own
   glyph    the icon (nav-<glyph> in components/Icon.jsx) shown in the sidebar
   group    what the page is about: its section of the sidebar's 「更多」 (NAV_SECTIONS below), where it sits when it is not in the main list;
            null for pages that are reached from elsewhere
   main     in the sidebar's main list by default (#654: six pages under 回到题目, at most seven rows). The learner can drag a page in or out;
            ui/nav-order.js derives the default order from this table, in registry order, so there is no second list to keep in step
   needs    the host contexts the page is useless without (ui/capabilities.js pageAvailable)
   flag     a switch the host publishes in the snapshot's `features` (default off): without it the page is not available, has no sidebar entry and no link
   back     the words of the way back to a page that names its own ("回到总纲", "回到复习全书"); the others say their sidebar label
   onEnter  what entering the page resets: onEnter(ctx, how). how is 'user' when the learner clicked its sidebar entry and
            'tour' when the feature tour switched to it; a plain navigate() calls nothing. ctx carries the resets.
   Free of ui() and React on purpose: the registry is plain data that a DOM-free test can read. */

const user = (reset) => (ctx, how) => { if (how === 'user') reset(ctx); };

export const PAGES = Object.freeze({
  library: { label: '学习库', title: '学习库', glyph: 'library', group: 'practice', main: true, needs: ['bank', 'study'], purpose: '每次打开先看这里：今天的安排、各门课的进度和最近在练的题' },
  sources: { label: '资料', title: '资料', glyph: 'sources', group: 'material', main: true, needs: ['materials'], purpose: '导入讲义、课件和笔记，也可以在这里读原文' },
  generate: { label: '创建题组', title: '创建题组', glyph: 'generate', group: 'material', main: true, needs: ['materials', 'bank', 'authoring', 'generation'], purpose: '选好资料出题；出之前能看到大概要花多少' },
  tasks: { label: '任务', title: '任务', glyph: 'tasks', group: 'notes', needs: [], purpose: '后台正在做什么、做完没有，都可以在这里看' },
  wrongbook: { label: '错题与待巩固', title: '错题与待巩固', glyph: 'wrongbook', group: 'practice', main: true, needs: ['bank', 'study'], purpose: '答错的题和还没巩固的题收在这里，可以只练它们' },
  workflows: { label: '学习流', title: '学习流', glyph: null, group: null, needs: ['workflows', 'bank', 'study'] },
  notes: { label: '学习笔记', title: '学习笔记', glyph: 'notes', group: 'notes', needs: ['notes'], onEnter: user((ctx) => ctx.clearNote()), purpose: '把做过的题写成笔记，也可以发布出去' },
  board: { label: '待办', title: '待办看板', glyph: 'board', group: 'notes', needs: [], onEnter: user((ctx) => ctx.openBoardFresh()), purpose: '把要做的事排成看板，可以设截止日期' },
  exam: { label: '模拟考试', title: '模拟考试', glyph: 'exam', group: 'exam', main: true, needs: ['bank', 'study'], onEnter: (ctx) => ctx.resetExam(), purpose: '按考试的时间和题型做一整套，交卷后看批改' },
  examprep: { label: '备考补习', title: '备考补习', glyph: 'examprep', group: 'exam', needs: ['materials', 'generation'], flag: 'examBlueprint', purpose: '按考试大纲整理要复习的清单，缺什么补什么' },
  book: { label: '复习全书', title: '复习全书', glyph: 'book', group: 'practice', needs: ['bank', 'study', 'materials'], back: '回到复习全书', purpose: '把这门课的题和讲解串成一本能读的书' },
  dashboard: { label: '统计', title: '学习统计', glyph: 'dashboard', group: 'exam', main: true, needs: ['bank', 'study'], purpose: '练了多少、掌握得怎么样、哪一块还薄弱' },
  skeleton: { label: '知识骨架', title: '知识骨架', glyph: 'skeleton', group: 'practice', needs: ['skeleton'], purpose: '把一门课的知识点画成骨架，先看清结构' },
  audio: { label: '音频转写', title: '音频转写', glyph: 'audio', group: 'material', needs: ['audio'], purpose: '把课堂录音转成文字，可以校对和翻译' },
  live: { label: '课堂实录', title: '课堂实录', glyph: 'live', group: 'material', needs: ['audio', 'recording'], purpose: '上课时录下来，下课后就有文字稿' },
  review: { label: '复习', title: null, glyph: null, group: null, needs: ['bank', 'study'] },
  draft: { label: '草稿与发布', title: '草稿与发布', glyph: null, group: null, needs: ['bank', 'authoring'] },
  manage: { label: '维护题组', title: '维护题组', glyph: null, group: null, needs: ['bank'] },
  outline: { label: '总纲', title: '总纲', glyph: null, group: null, needs: ['bank', 'study', 'materials'], back: '回到总纲' },
  graph: { label: '知识图谱', title: '知识图谱', glyph: null, group: null, needs: ['bank', 'study'], onEnter: user((ctx) => ctx.clearGraphScope()) },
  guided: { label: '带学工作台', title: '带学工作台', glyph: null, group: null, needs: ['study'] },
  settings: { label: '设置', title: '设置', glyph: 'settings', group: null, needs: [], purpose: '语言、外观、模型连接和引导提示都在这页调' },
});

export const PAGE_IDS = Object.freeze(Object.keys(PAGES));

/** The sections of the sidebar's 「更多」, by what the pages in them are about (#654), in the order they are drawn. A label names what is
    inside, never how often it is used; a section whose pages are all in the main list (or switched off) is not drawn. */
export const NAV_SECTIONS = Object.freeze([
  { id: 'material', label: '资料与出题' },
  { id: 'practice', label: '练习与复习' },
  { id: 'exam', label: '考试与统计' },
  { id: 'notes', label: '任务、笔记与待办' },
]);

/** How many pages the main list holds at most, besides 回到题目 (#654: at most seven rows). */
export const MAIN_LIMIT = 6;

/** The label of a 「更多」 section (source text), or undefined for an id that is not one. */
export const sectionLabelOf = (group) => NAV_SECTIONS.find((section) => section.id === group)?.label;

/** The registry row of a page, or undefined for a name nobody knows. */
export const pageOf = (id) => (Object.hasOwn(PAGES, id) ? PAGES[id] : undefined);

/** The contexts a page needs ([] for pages without needs and for unknown names). */
export const pageNeeds = (id) => pageOf(id)?.needs || [];

/** The host switch a page waits for (a key of the snapshot's `features`), or undefined. */
export const pageFlag = (id) => pageOf(id)?.flag;

/** The pages of one 「更多」 section, in registry order, whether or not they sit in the main list by default. */
export const pagesInGroup = (group) => PAGE_IDS.filter((id) => PAGES[id].group === group);

/** The sidebar label of a page that has a sidebar entry ("返回学习库"); undefined for the rest, which say "原位置". */
export const navLabelOf = (id) => (pageOf(id)?.group ? pageOf(id).label : undefined);

/** The words of the way back to a page that has no sidebar entry but names its own (source text); undefined for the rest. */
export const backLabelOf = (id) => pageOf(id)?.back || undefined;

/** The top-bar title as source text. Practice pages are titled by their run or their deck (see runTitle); an unknown page has none. */
export function pageTitleOf(id) {
  return pageOf(id)?.title || undefined;
}
