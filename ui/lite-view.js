/* 简洁版 (the lite view): an opt-in switch of this browser (设置 › 界面) that changes only what the SIDEBAR and the LIBRARY HOME draw. This module is the one
   rule every consumer reads, plain data and pure functions (no DOM, no React, no ui()): which parts are left out, how the sidebar is drawn, and the one
   stored value. It is a display filter: no page becomes unavailable, no library data, dismissal, setting or saved sidebar order is read or written.

   Where the rule is read: ui/app/SidebarNav.jsx (rows), ui/StudyMap.jsx with ui/study-map/DeskIntro.jsx, CourseHeading.jsx and CatalogHeading.jsx (home
   blocks), ui/app/page-views.jsx (the app's own home blocks) and ui/finder/trip.js (directions that go through a button the home left out).
   ui/use-lite-view.js is the React side. */
import { PAGES } from './pages.js';
import { browserStorage, readText, writeText } from './storage.js';

/** Its own key, apart from the appearance's: 恢复默认外观 does not reach it. */
export const LITE_VIEW_KEY = 'study-lite-view';

/** The pages the lite sidebar keeps in the main list, where the learner has them there. Every other page is drawn in its 「更多」 section. */
export const LITE_MAIN = Object.freeze(['library', 'sources', 'generate', 'wrongbook']);

/** The parts left out while 简洁版 is on. Anything not listed is drawn as always. */
export const LITE_HIDDEN = Object.freeze([
  'nav.coach', //           the 为你定制 row (its round stays under 其他开始方式 on the home)
  'nav.reorder', //         drag, Alt+arrows and 恢复默认顺序: rows that are drawn elsewhere must not rewrite the saved order
  'home.next', //           the 下一步 card, except in the states liteShowsNext keeps
  'home.daily-plan', //     今天先做什么
  'home.exam-cards', //     期末一周 and 本周
  'home.setup', //          课程准备 (card or chip)
  'home.course-extras', //  the 总纲 button by the course, 课程进度, 学法 and 重点 lines, 掌握度 with 掌握图谱 and pace, 推荐下一步 (the exam countdown stays)
  'home.desk-play', //      今日折纸 and 抽一签
  'home.catalog-maps', //   总纲 and 查看图谱 on the 学习目录 heading
  'home.topic-groups', //   the topic-group reminder
  'home.notebooks-open', // what is under the 全局笔记本 heading: it starts folded (publishing and searching have no other way in, so it stays)
]);

/** The 下一步 card's states (ui/study-map/next-step.js) that stay in the lite view: nothing else on the home offers them unasked, since the exam cards are left
    out (the countdown gives the days, not the way to the review book) and 创建题组 only ticks new materials once the learner is there. The other states are
    said elsewhere on screen. */
export const LITE_NEXT_STATES = Object.freeze(['new-source', 'exam']);

/** Is `part` drawn? `lite`: whether the lite view is what is on screen (liteViewOn). */
export const liteShows = (lite, part) => !lite || !LITE_HIDDEN.includes(part);

/** Is the 下一步 card drawn for state `id`? */
export const liteShowsNext = (lite, id) => liteShows(lite, 'home.next') || LITE_NEXT_STATES.includes(id);

/** Is the lite view what is on screen? The saved choice, except while the guided tour runs: the tour points at the full view. */
export const liteViewOn = ({ saved, touring }) => !!saved && !touring;

/** The sidebar order as it is DRAWN ({ group: [page id] }, ui/nav-order.js). Full view: `order` itself. Lite: the main list keeps the LITE_MAIN pages the
    learner has there, in their order; the rest of it is drawn at the end of each page's home section. `order` is never changed and nothing is saved. */
export function liteNavOrder(order, lite) {
  if (!lite) return order;
  const demoted = order.main.filter((id) => !LITE_MAIN.includes(id));
  return Object.fromEntries(Object.entries(order).map(([group, ids]) => [group,
    group === 'main' ? ids.filter((id) => LITE_MAIN.includes(id)) : [...ids, ...demoted.filter((id) => PAGES[id].group === group)]]));
}

/** The one stored value of this browser. `storage` is injectable for tests; only the exact text 'on' turns it on. */
export function createLiteViewStore({ storage } = {}) {
  const target = () => storage ?? browserStorage();
  const load = () => readText(LITE_VIEW_KEY, 'off', target()) === 'on';
  let current = null;
  const listeners = new Set();
  const get = () => (current ??= load());
  const apply = (next) => { if (next === get()) return false; current = next; listeners.forEach((listener) => listener()); return true; };
  return {
    get,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    /** The learner's choice: applied for this session even when the storage refuses it. */
    set(on) { if (apply(!!on)) writeText(LITE_VIEW_KEY, on ? 'on' : 'off', target()); },
    /** Read the stored value again (another tab changed it): nothing is written back. */
    reload() { apply(load()); },
  };
}
