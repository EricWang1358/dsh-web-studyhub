/* 找功能: the part of the finder's data the daily path reads, so the first screen does not carry the rest of it. The index itself (ui/finder/entries.js, the largest
   input of the workspace) and the sheet that shows it arrive when the finder is first opened (ui/finder/lazy-sheet.jsx). What stays here is what is read without
   opening it: where 「带我去」 stands (PREPARE_STEPS, ui/finder/trip.js), and the entries 「也可以」 names (ui/method-alternatives.js): the page entries, derived from
   ui/pages.js, and the two features that are not pages. entries.js builds the index from these same objects, so each entry is written once. */
import { sectionLabelOf } from '../pages.js';

/** The area of a page by its sidebar section (ui/pages.js NAV_SECTIONS); PAGE_AREA says where a page differs from its section. */
const GROUP_AREA = { material: 'material', practice: 'practice', exam: 'exam', notes: 'daily' };
const PAGE_AREA = { library: 'daily', generate: 'generate', notes: 'practice', skeleton: 'course', audio: 'course', live: 'course', settings: 'settings' };
/** The sidebar's 「更多」 (#654), the first crumb of every page folded into it. Not MORE below, which is a page's own 「更多选项」. */
const SIDEBAR_MORE = '更多';
/** In a narrow window the sidebar is a drawer (#657): the top bar's menu button stands in for every row of it. */
export const NAV_MENU = 'nav-menu';

/** What the learner does first, for a control that is not on screen. `land` is the page to stand on meanwhile (default: the entry's page); `after`
    says it even when the control was found (a menu item behind a button that is). The words are said when the control itself could not be lit
    (ui/finder/trip.js tripNotice). */
export const PREPARE_STEPS = Object.freeze({
  document: { text: '先在「资料」里打开一份资料。' },
  run: { land: 'library', text: '先开始一轮练习，题目下方就有这一项。' },
  'run-place': { land: 'library', text: '先开始一轮非考试练习；当题目关联了资料或章节且总纲可用时，题目页页头就会显示这一项。' },
  'run-book-section': { land: 'library', text: '先开始一轮非考试练习；当复习全书这一节已经写好时，答错反馈下方和每条问答下面才会出现这一项。' },
  book: { text: '先在「复习全书」里打开一本书。' },
  'run-more': { land: 'library', after: true, text: '先开始一轮练习，点题目下方的「更多」，菜单里就有这一项。' },
  draft: { land: 'library', text: '先在学习库里打开一份待发布的草稿。' },
  materials: { text: '先在「资料」里添加资料，这一项才会出现。' },
  mistakes: { text: '答错过题以后，这一项才会出现。' },
  task: { text: '先在「任务」里点开一个任务，这一项在任务的详情里。' },
  'add-dialog': { text: '点「添加资料」，在弹出的窗口里就有这一项。' },
  'live-class': { text: '先在「课堂实录」里开始或打开一场实录，这一项才会出现。' },
  // `part`: the directions go through this part of the home (ui/lite-view.js); where 简洁版 left it out, the notice says so first (`hidden`) and offers the full view.
  outline: { text: '先在首页点「总纲」，打开这门课的总纲页。', part: 'home.course-extras', hidden: '现在是简洁版，首页的「总纲」按钮收起了。切回完整版后：' },
  'tool-failed': { text: '本地工具（MinerU、Marker、本地转写、电脑声音组件、检索扩展）安装或启动失败时，出错的那张卡片上才有这一项；没出错时这里没有它。' },
});

/** An entry that is not a page: the finder's own shape for a feature written by hand. */
export const feature = (entry) => ({ kind: 'feature', aliases: [], anchors: [], ...entry });

export const GUIDED_STUDY = feature({ id: 'guided-study', area: 'daily', title: 'AI 带学', page: 'guided', anchors: ['hand-off'],
  aliases: ['带学', '讲给我听', '先讲后练', '主会话带学', '学习流', 'guided study', 'explain to me', 'tutor', 'learning flow', 'workflow'],
  path: ['许多页面', '发给主会话'],
  what: '把这一阶段的资料交给主会话一步步讲清楚、边讲边问，不懂的地方当场追问。',
  needs: { capability: ['study'], model: true, chat: true } });

export const ORAL_EXAM = feature({ id: 'oral-exam', area: 'exam', title: '口头面试', page: 'exam', anchors: ['exam-case'],
  aliases: ['口试', '面试', '口头检验', '追问', 'oral exam', 'oral check', 'interview'],
  path: ['模拟考试', '考试形式'],
  what: '像面试一样一问一答、追问到底，检验这一阶段是不是真能讲出来；交卷后给出逐题点评。',
  needs: { capability: ['bank', 'study'], model: true } });

/** The hand-written entries 「也可以」 reads (ui/method-alternatives.js); entries.js lists them in its FEATURES, in their place in the index. */
export const DAILY_FEATURES = Object.freeze([GUIDED_STUDY, ORAL_EXAM]);

/** One entry per page of the registry that has a sidebar group or a purpose. */
export function pageEntries(pages) {
  return Object.entries(pages).filter(([, page]) => page.group || page.purpose).map(([id, page]) => ({
    id: `page-${id}`, kind: 'page', area: PAGE_AREA[id] || GROUP_AREA[page.group] || 'daily', title: page.label, aliases: [], what: page.purpose || '',
    path: page.main || !page.group ? [page.label] : [SIDEBAR_MORE, sectionLabelOf(page.group), page.label],
    page: id, anchors: [`nav-${id}`, NAV_MENU],
    needs: { ...(page.needs?.length ? { capability: page.needs } : {}), ...(page.flag ? { flag: page.flag } : {}) },
  }));
}
