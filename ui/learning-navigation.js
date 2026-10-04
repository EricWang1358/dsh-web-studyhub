import { reviewEntryKey } from './async.js';

/* Every learning object the app can jump to, as one table (ui-consistency #110). A kind is one entry:
     load(target, call, env)       fetch what the destination needs; the host answers, nothing on screen changes yet
     open(result, target, nav, env) show it: only calls the `nav` verbs, so it is testable without a DOM
     reference(state)              the object the learner is looking at right now, or null (used to hand a "where I was" to the board)
     trail: false                  opening it leaves no way back (a source opens over the page it was opened from)
   and the way back from a page is RETURN_PAGES. Adding a kind means adding its row here, nowhere else.
   env: { live(): still the current request, data(): the library snapshot, refresh() }.
   nav: enterRun, showSource, showNote, showSkeleton, showDeck, showWorkflow, showExam, showLibrary, showPage, showManagedDeck.
   Free of ui() so the table stays plain data and logic; messages are Chinese source text that the shell localizes. */

/** What load() answers when the request went stale: the caller drops it silently. */
export const ABORT = Symbol('stale learning target');

const scopeOf = (deckId, cardIds) => cardIds.map((cardId) => ({ deckId, cardId }));
const startPath = (call, scope) => call('review.start', { mode: 'path', scope, fresh: true });

export const LEARNING_TARGETS = {
  card: {
    async load(target, call, env) {
      await call('card.get', { deckId: target.deckId, cardId: target.cardId });
      if (!env.live()) return ABORT;
      return startPath(call, scopeOf(target.deckId, [target.cardId]));
    },
    open: (result, target, nav) => nav.enterRun(result),
    reference: (s) => s.page === 'review' && s.run?.card?.id ? { kind: 'card', deckId: s.run.deckId || s.run.card.deckId, cardId: s.run.card.id } : null,
  },
  // Exactly the questions a passage supplement just added, as one practice run.
  cards: {
    load: (target, call) => startPath(call, scopeOf(target.deckId, target.cardIds)),
    open: (result, target, nav) => nav.enterRun(result),
  },
  source: {
    trail: false,
    load: (target, call) => call('source.get', { id: target.id }),
    open: (result, target, nav, env) => nav.showSource(env.data()?.sources?.find((source) => source.id === target.id) || result, target.quote),
    reference: (s) => s.modal?.type === 'source' && s.modal.source?.id ? { kind: 'source', id: s.modal.source.id } : null,
  },
  note: {
    load: (target, call) => call('note.get', { id: target.id }),
    open: (result, target, nav) => nav.showNote(result.id),
    reference: (s) => s.page === 'notes' && s.noteInitialId ? { kind: 'note', id: s.noteInitialId } : null,
  },
  skeleton: {
    load: (target, call) => call('skeleton.get', { id: target.id }),
    open: (result, target, nav) => nav.showSkeleton(result.id),
    reference: (s) => s.page === 'skeleton' && s.skeletonFocus ? { kind: 'skeleton', id: s.skeletonFocus } : null,
  },
  deck: {
    load: (target, call) => call('deck.get', { id: target.id }),
    open: (result, target, nav) => nav.showDeck(result),
    reference: (s) => s.page === 'manage' && s.managedDeck?.id ? { kind: 'deck', id: s.managedDeck.id } : null,
  },
  exam: {
    load: (target, call) => call('review.get', { runId: target.runId }),
    open: (result, target, nav) => nav.showExam(target.kind, target.runId),
    reference: (s) => s.page === 'exam' && s.exam?.runId ? { kind: s.exam.kind === 'oral' ? 'oral' : 'exam', runId: s.exam.runId } : null,
  },
  oral: {
    load: (target, call) => call('oral.get', { runId: target.runId }),
    open: (result, target, nav) => nav.showExam(target.kind, target.runId),
  },
  workflow: {
    load: (target, call) => call('workflow.session.get', { id: target.sessionId }),
    open: (result, target, nav) => nav.showWorkflow(target.sessionId),
    reference: (s) => s.page === 'workflows' && s.workflowReturn?.sessionId ? { kind: 'workflow', sessionId: s.workflowReturn.sessionId } : null,
  },
  course: {
    async load(target, call, env) {
      if (!env.data()?.focus?.courses?.some((item) => item.name === target.course)) throw new Error('关联课程已不存在');
      const result = await call('focus.set', { course: target.course });
      await env.refresh();
      return result;
    },
    open: (result, target, nav) => nav.showLibrary(),
    reference: (s) => s.focus?.course != null ? { kind: 'course', course: s.focus.course } : null,
  },
};

/** The order the learner's current view is looked up in: the most specific thing on screen first, the course last. */
export const REFERENCE_ORDER = ['source', 'card', 'note', 'skeleton', 'deck', 'workflow', 'exam', 'course'];

const targetOf = (target) => (target && Object.hasOwn(LEARNING_TARGETS, target.kind) ? LEARNING_TARGETS[target.kind] : null);

/** Fetch a target; ABORT when the kind is unknown or the request went stale on the way. */
export async function loadLearningTarget(target, call, env) {
  const entry = targetOf(target);
  return entry ? entry.load(target, call, env) : ABORT;
}

/** Show a loaded target through the `nav` verbs. */
export function openLearningTarget(target, result, nav, env) {
  targetOf(target)?.open(result, target, nav, env);
}

/** Does opening this target leave a way back? */
export const leavesTrail = (target) => targetOf(target)?.trail !== false;

/** The object on screen, for "add to the board with where I am". state: { root, page, run, noteInitialId, skeletonFocus, managedDeck, workflowReturn, exam, modal, focus }. */
export function currentStudyReference(state) {
  const root = state.root;
  if (!root) return null;
  for (const kind of REFERENCE_ORDER) {
    const reference = LEARNING_TARGETS[kind].reference(state);
    if (reference) return { root, ...reference };
  }
  return null;
}

/** Where the learner is now, to come back to: the page, its run and typed-in answer, any open source. */
export function captureContext(state, overrides = {}) {
  const { page, run, entry = {}, modal } = state;
  return { root: state.root, page, runId: page === 'review' ? run?.id : undefined,
    index: run?.index, runComplete: !!run?.complete, noteId: state.noteInitialId, skeletonId: state.skeletonFocus, deckId: state.managedDeck?.id,
    exam: state.exam, workflow: state.workflowReturn?.sessionId,
    modal: modal?.type === 'source' ? { sourceId: modal.source?.id, quote: modal.quote } : null,
    input: page === 'review' ? { key: reviewEntryKey(run), selected: entry.selected, response: entry.response, clozeValues: entry.clozeValues,
      hint: entry.hint, explain: entry.explain, teachAnswer: entry.teachAnswer } : null,
    invoker: state.invoker ?? null, ...overrides };
}

/** The way back, per page. Pages without a row here just show themselves again (see returnTargetFor). */
export const RETURN_PAGES = {
  review: {
    load: (origin, call) => origin.runComplete ? call('review.get', { runId: origin.runId }) : call('review.move', { runId: origin.runId, index: origin.index }),
    open: (result, origin, nav) => nav.enterRun(result, origin.input),
  },
  notes: {
    load: async (origin, call) => { if (origin.noteId) await call('note.get', { id: origin.noteId }); },
    open: (result, origin, nav) => nav.showNote(origin.noteId),
  },
  exam: { open: (result, origin, nav) => nav.showExam(origin.exam?.kind || 'exam', origin.exam?.runId || null) },
  skeleton: {
    load: async (origin, call) => { if (origin.skeletonId) await call('skeleton.get', { id: origin.skeletonId }); },
    open: (result, origin, nav) => nav.showSkeleton(origin.skeletonId),
  },
  manage: {
    applies: (origin) => !!origin.deckId,
    load: (origin, call) => call('deck.get', { id: origin.deckId }),
    open: (result, origin, nav) => nav.showManagedDeck(result),
  },
};
const PLAIN_RETURN = { plain: true, open: (result, origin, nav) => nav.showPage(origin.page) };

export function returnTargetFor(origin) {
  const entry = Object.hasOwn(RETURN_PAGES, origin?.page) ? RETURN_PAGES[origin.page] : null;
  return entry && (!entry.applies || entry.applies(origin)) ? entry : PLAIN_RETURN;
}
export const loadReturnTarget = async (entry, origin, call) => entry.load?.(origin, call);
export const openReturnTarget = (entry, result, origin, nav) => entry.open(result, origin, nav);

export async function readExamTarget(call, runId) {
  const run = await call('review.get', { runId });
  if (run?.mode !== 'exam') throw new Error('找不到这场笔试');
  return run.complete || run.closed
    ? { run, report: await call('exam.report', { runId }) }
    : { run, report: null };
}
