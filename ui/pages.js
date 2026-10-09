/* The one table of the app's pages (ui-consistency #109). The sidebar, the breadcrumb, the availability check and the
   renderer (ui/app/page-views.jsx) all read it, so a page is added in one row and not in four places.

   label    the sidebar entry (Chinese source text; callers pass it through ui())
   title    the heading in the top bar; `review` has none because its title is the run's own
   glyph    the icon (nav-<glyph> in components/Icon.jsx) shown in the sidebar
   group    the sidebar group (ui/nav-order.js NAV_DEFAULTS); null for pages that are reached from elsewhere
   needs    the host contexts the page is useless without (ui/capabilities.js pageAvailable)
   flag     a switch the host publishes in the snapshot's `features` (default off): without it the page is not available, has no sidebar entry and no link
   back     the words of the way back to a page without a sidebar entry ("返回总纲"); the others say their sidebar label
   onEnter  what entering the page resets: onEnter(ctx, how). how is 'user' when the learner clicked its sidebar entry and
            'tour' when the feature tour switched to it; a plain navigate() calls nothing. ctx carries the resets.
   Free of ui() and React on purpose: the registry is plain data that a DOM-free test can read. */

const user = (reset) => (ctx, how) => { if (how === 'user') reset(ctx); };

export const PAGES = Object.freeze({
  library: { label: '学习库', title: '学习库', glyph: 'library', group: 'daily', needs: ['bank', 'study'] },
  sources: { label: '资料', title: '资料', glyph: 'sources', group: 'daily', needs: ['materials'] },
  generate: { label: '创建题组', title: '创建题组', glyph: 'generate', group: 'daily', needs: ['materials', 'bank', 'authoring', 'generation'] },
  tasks: { label: '任务', title: '任务', glyph: 'tasks', group: 'daily', needs: [] },
  wrongbook: { label: '错题与待巩固', title: '错题与待巩固', glyph: 'wrongbook', group: 'daily', needs: ['bank', 'study'] },
  workflows: { label: '学习流', title: '学习流', glyph: 'workflows', group: 'daily', needs: ['workflows', 'bank', 'study'] },
  notes: { label: '学习笔记', title: '学习笔记', glyph: 'notes', group: 'daily', needs: ['notes'], onEnter: user((ctx) => ctx.clearNote()) },
  board: { label: '待办', title: '待办看板', glyph: 'board', group: 'daily', needs: [], onEnter: user((ctx) => ctx.openBoardFresh()) },
  exam: { label: '模拟考试', title: '模拟考试', glyph: 'exam', group: 'periodic', needs: ['bank', 'study'], onEnter: (ctx) => ctx.resetExam() },
  examprep: { label: '备考补习', title: '备考补习', glyph: 'examprep', group: 'periodic', needs: ['materials', 'generation'], flag: 'examBlueprint' },
  dashboard: { label: '统计', title: '学习统计', glyph: 'dashboard', group: 'periodic', needs: ['bank', 'study'] },
  skeleton: { label: '知识骨架', title: '知识骨架', glyph: 'skeleton', group: 'setup', needs: ['skeleton'] },
  audio: { label: '音频转写', title: '音频转写', glyph: 'audio', group: 'setup', needs: ['audio'] },
  live: { label: '课堂实录', title: '课堂实录', glyph: 'live', group: 'setup', needs: ['audio', 'recording'] },
  review: { label: '复习', title: null, glyph: null, group: null, needs: ['bank', 'study'] },
  draft: { label: '草稿与发布', title: '草稿与发布', glyph: null, group: null, needs: ['bank', 'authoring'] },
  manage: { label: '维护题组', title: '维护题组', glyph: null, group: null, needs: ['bank'] },
  outline: { label: '总纲', title: '总纲', glyph: null, group: null, needs: ['bank', 'study', 'materials'], back: '返回总纲' },
  graph: { label: '知识图谱', title: '知识图谱', glyph: null, group: null, needs: ['bank', 'study'], onEnter: user((ctx) => ctx.clearGraphScope()) },
  settings: { label: '设置', title: '设置', glyph: 'settings', group: null, needs: [] },
});

export const PAGE_IDS = Object.freeze(Object.keys(PAGES));

/** The registry row of a page, or undefined for a name nobody knows. */
export const pageOf = (id) => (Object.hasOwn(PAGES, id) ? PAGES[id] : undefined);

/** The contexts a page needs ([] for pages without needs and for unknown names). */
export const pageNeeds = (id) => pageOf(id)?.needs || [];

/** The host switch a page waits for (a key of the snapshot's `features`), or undefined. */
export const pageFlag = (id) => pageOf(id)?.flag;

/** The pages of one sidebar group, in registry order (NAV_DEFAULTS is the saved, reorderable version of this). */
export const pagesInGroup = (group) => PAGE_IDS.filter((id) => PAGES[id].group === group);

/** The sidebar label of a page that has a sidebar entry ("返回学习库"); undefined for the rest, which say "原位置". */
export const navLabelOf = (id) => (pageOf(id)?.group ? pageOf(id).label : undefined);

/** The words of the way back to a page that has no sidebar entry but names its own (source text); undefined for the rest. */
export const backLabelOf = (id) => pageOf(id)?.back || undefined;

/** The top-bar title as source text. Practice pages are titled by their run or their deck (see runTitle); an unknown page has none. */
export function pageTitleOf(id) {
  return pageOf(id)?.title || undefined;
}
