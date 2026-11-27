/* One library with every home block on it at once (tests/lite-view.test.mjs): a learner a few weeks in, with a course that has an exam, a route, a method,
   focus topics, drafts, a running and a failed generation, another unfinished round, a companion and topics to group. Plus what the app gives the sidebar. */

const DAY = 86400000;
/** A calendar date `days` from now, as the courses store it. */
export const dateIn = (days) => new Date(Date.now() + days * DAY).toISOString().slice(0, 10);

const deck = { id: 'd1', title: 'Behavioural patterns', folder: 'CS3219', course: 'CS3219', topics: ['Memento'], available: 5, count: 5, quizCount: 3, wrong: 2, createdAt: '2026-09-01T00:00:00Z' };
const progress = { d1: { counts: { mastered: 1, familiar: 1, learning: 1, weak: 1, new: 1 }, total: 5, mastery: 60, due: 1, status: 'active', topics: [] } };
const route = { course: 'CS3219', current: 0, learned: 3, cards: 5, chapters: [{ deckId: 'd1', title: 'Behavioural patterns', total: 5, learned: 3, weak: 1, status: 'current' }],
  next: { label: 'Behavioural patterns', fresh: 2, reviews: 1 } };
const method = { own: true, course: 'CS3219', index: 1, stage: { name: '练熟概念' }, counts: { cards: 5, answered: 3 }, gate: { ready: false } };
const focusProgress = { course: 'CS3219', total: 3, done: 1, weak: 1, learning: 1, none: 0, weakScope: [{ deckId: 'd1', topic: 'Memento' }], topics: [] };

export function richLibrary(patch = {}) {
  return {
    root: '/tmp/lite-lib', revision: 'r1',
    decks: [deck], progress,
    sources: [{ id: 's1', title: 'Lecture 1', text: 'x', course: 'CS3219', createdAt: new Date().toISOString() }],
    drafts: [{ id: 'dr1', title: 'Draft set', course: 'CS3219', cards: [{ id: 'c1' }] }],
    jobs: [
      { id: 'j-run', type: 'generate', status: 'running', title: 'Generating now', deckTitle: 'Generating now', sourceIds: ['s1'], createdAt: new Date().toISOString() },
      { id: 'j-failed', type: 'generate', status: 'failed', title: 'Failed run', deckTitle: 'Failed run', error: 'boom', sourceIds: ['s1'], createdAt: new Date().toISOString() },
    ],
    runs: [{ id: 'r-old', mode: 'path', scope: [{ deckId: 'd1' }], index: 1, total: 4, title: 'Half done', deckIds: ['d1'] }],
    today: { due: 1, weak: 2, new: 1, size: 4, course: 'CS3219' },
    next: { deckId: 'd1', deckTitle: 'Behavioural patterns', topic: 'Memento', mastery: 23 },
    coach: { ready: 4 },
    courses: [{ id: 'c-1', name: 'CS3219', active: true, exam: { date: dateIn(5) }, companions: [{ id: 'k1', title: 'Companion lesson' }] }],
    bookCourses: ['CS3219'],
    topicGrouping: { topics: 20, groups: 0, ungrouped: 20 },
    focus: { mode: 'class', course: 'CS3219', courseId: 'c-1', courses: [{ name: 'CS3219', due: 1 }], fresh: [{}, {}], route, method, progress: focusProgress },
    paceForecast: { asOf: dateIn(0), pace: null, courses: { CS3219: { status: 'cold-start', total: 5, remaining: 4, pomodoros: 2, days: 9, floor: 3 } } },
    features: { examBlueprint: true },
    model: { ready: true, reason: 'ok', label: 'Model' },
    ...patch,
  };
}

const noop = () => {};
/** StudyMap's props for `data` (through tests/helpers/study-map-props.mjs), with the two ways to a map page the app also gives the home. */
export function homeElementProps(mapProps, data, extra = {}) {
  const props = mapProps({ ...homeProps(data), ...extra });
  Object.assign(props.actions, { onShowOutline: noop, onOpenMasteryMap: noop });
  return props;
}
/** The flat props tests/helpers/study-map-props.mjs turns into StudyMap's. */
export const homeProps = (data) => ({ data, start: noop, resume: noop, manage: noop, openDraft: noop, retryGeneration: noop, addSource: noop, createManual: noop, importLibrary: noop,
  generateFromSources: noop, onCoachPractice: noop, onWeakPoints: noop, onShowGraph: noop, onCourseSettings: noop, onGenerateFocus: noop,
  notebooks: [{ root: '/other', title: 'Other library', workspace: '/w', exists: true, current: false, decks: [], deckCount: 2 }] });

export const services = () => ({ call: async () => undefined, act: async () => undefined, busy: false, notify: noop, askInChat: noop,
  host: { capabilities: { chat: true } }, openSettings: noop, navigate: noop, openModal: noop });

/** What SidebarNav reads from the app. */
export function sidebarApp({ data = richLibrary(), page = 'library', touring = null } = {}) {
  return {
    data,
    core: { notify: noop, call: async () => ({}) },
    shell: { navDrawer: false },
    nav: { navPage: page, pageTarget: null, page, navigate: noop },
    session: { run: null, onCoachPractice: noop },
    intents: { resumeOrStart: noop },
    board: { count: 0 },
    tour: { tourStep: touring },
  };
}
