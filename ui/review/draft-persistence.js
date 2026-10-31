/* A question's unsubmitted answer on its way to the library (#537), without React: what is saved, which question it belongs to, and the one save channel.
   useReviewSession feeds the channel from the open entry and waits on it before a step; the host keeps the draft on the run (review.draft.save, a plain write of the
   run with no model anywhere near it). */

/** After the last keystroke; a step or a link does not wait for it, it flushes. */
export const DRAFT_SAVE_DELAY_MS = 400;

/** The save's content. Empty values stay in it: writing them is what clears an older draft. Whether the hint or explanation is open is not saved. */
export function draftPayloadOf(entry) {
  return {
    draft: { selected: entry.selected, text: entry.response, stepInputs: entry.clozeValues },
    ...(entry.assistance ? { assistance: entry.assistance } : {}),
  };
}

/** Names the question a save belongs to: library, round, place, card, queue. A corrected card (its revision) is the same question. */
export const draftKey = (root, run) => (run?.card ? JSON.stringify([root || '', run.id, run.index, run.card.id, run.queueVersion || 0]) : '');

/** Does this question take a draft? An answered one is done, and an exam saves its own picks (ui/Exam.jsx). */
export const draftable = (run) => !!run?.card && !run.feedback && !run.complete && !run.closed && run.mode !== 'exam';

/** What `run.draft` puts back. An option the card no longer has could never be unticked, so it does not return. */
export function restoredDraft(run) {
  const draft = run?.draft;
  if (!draft) return null;
  const options = run.card?.options;
  const selected = Array.isArray(draft.selected) ? draft.selected : [];
  return {
    selected: options ? selected.filter((id) => options.some((option) => option.id === id)) : selected,
    text: typeof draft.text === 'string' ? draft.text : '',
    stepInputs: draft.stepInputs && typeof draft.stepInputs === 'object' ? draft.stepInputs : {},
  };
}

/** Help recorded on either side, added up: evidence is never taken back. */
export function mergeAssistance(...records) {
  const merged = {};
  for (const record of records) for (const [flag, value] of Object.entries(record || {})) if (value) merged[flag] = true;
  return Object.keys(merged).length ? merged : null;
}

/** An entry reopened on the same question keeps what the learner made on screen, which is newer than what the host answered with. */
export const keepTyped = (opened, { selected, response, clozeValues, assistance }) =>
  ({ ...opened, selected, response, clozeValues, assistance: mergeAssistance(opened.assistance, assistance) });

const signature = (selected, text, stepInputs, assistance) => JSON.stringify([selected, text, stepInputs, Object.keys(assistance || {}).sort()]);
/** Equal signatures: this entry has nothing new for the library. */
export const entrySignature = (entry) => signature(entry.selected, entry.response, entry.clozeValues, entry.assistance);
export function savedSignature(run) {
  const saved = restoredDraft(run);
  return signature(saved?.selected || [], saved?.text || '', saved?.stepInputs || {}, mergeAssistance(run?.assistance));
}

/**
 * The save channel: at most one write in flight, so an older write cannot land after a newer one; for each question only its newest text waits.
 * A write's answer touches nothing but what it wrote: a late success cannot mark newer text saved, a late failure cannot bring older text back.
 * call(action, args) is a plain host call, never act(); currentRoot() is the library open now; a save for another one is dropped unsent.
 */
export function createDraftSaver({ call, currentRoot, delayMs = DRAFT_SAVE_DELAY_MS, setTimer = setTimeout, clearTimer = clearTimeout }) {
  const waiting = new Map();
  let timer = null, writing = null, failed = false, generation = 0;

  const stopTimer = () => { if (timer !== null) clearTimer(timer); timer = null; };
  const nextReady = () => [...waiting.values()].find((job) => job.ready);

  async function drain() {
    for (let job = nextReady(); job; job = nextReady()) {
      waiting.delete(job.key);
      if (job.root !== currentRoot()) continue;
      const startedIn = generation;
      try {
        // A stale answer ({ ok: false, stale }) is done too: the question is gone, and so is the reason to keep the words on their way.
        await call('review.draft.save', job.args);
      } catch {
        // Kept for the next try, unless newer text took its place meanwhile or the library changed. It waits to be flushed or for the next keystroke's timer.
        if (startedIn === generation) {
          failed = true;
          if (!waiting.has(job.key)) waiting.set(job.key, { ...job, ready: false });
          return;
        }
      }
    }
  }
  const write = () => {
    writing ||= drain().finally(() => { writing = null; });
    return writing;
  };
  const release = () => {
    stopTimer();
    for (const job of waiting.values()) job.ready = true;
    return write();
  };

  return {
    /** job: { key, root, args }. A question that was waiting for its debounce when another one starts is sent now. */
    schedule(job) {
      waiting.delete(job.key);
      const others = waiting.size > 0;
      for (const other of waiting.values()) other.ready = true;
      waiting.set(job.key, { ...job, ready: false });
      stopTimer();
      timer = setTimer(release, delayMs);
      if (others) write();
    },
    /** Sends everything now and waits. True when all of it arrived; false when a write failed (its words are kept, nothing was lost). */
    async flush() {
      failed = false;
      while (waiting.size || writing) {
        await release();
        if (failed) return false;
      }
      return true;
    },
    dirty: () => waiting.size > 0 || !!writing,
    /** Forget one question (it was answered) or, with no key, everything (the library changed). A write in flight then cannot come back. */
    discard(key) {
      if (key !== undefined) { waiting.delete(key); return; }
      generation += 1;
      waiting.clear();
      stopTimer();
    },
  };
}
