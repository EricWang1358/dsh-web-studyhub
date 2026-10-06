/* The library and the light model the 为你定制 tests share (the S4-0 baseline and the runtime tests). Fakes only: no model, no network. */
import { createFakeModel } from '../../scripts/fake-model.mjs';
import { gate } from './model-family-baseline.mjs';

export const text = 'The Caretaker manages snapshot history without inspecting snapshot contents. A Memento stores an opaque snapshot of internal state.';
export const quiz = n => ({ id: `q${n}`, kind: 'quiz', topic: 'Memento', objective: `objective ${n}`, prompt: `第 ${n} 个关于 Memento 的问题：谁管理历史 ${n}？`, answer: 'Caretaker',
  hint: 'Who keeps the history?', explanation: 'The Caretaker keeps history.', misconception: 'Treating the Memento as the history manager.',
  citations: [{ sourceId: 'src', quote: 'The Caretaker manages snapshot history without inspecting snapshot contents.' }],
  options: [{ id: 'a', text: 'Caretaker', correct: true, explanation: 'It keeps history.' }, { id: 'b', text: 'Memento', correct: false, explanation: 'It is the snapshot.' },
    { id: 'c', text: 'Originator', correct: false, explanation: 'It restores state.' }] });

/** A library with ten quiz cards, set up only through `call` so the panel's door and the runtime's door can seed the same one. */
export async function seed(call) {
  await call('source.add', { id: 'src', title: 'Memento notes', text });
  await call('draft.save', { deck: { id: 'd', title: 'Patterns', cards: Array.from({ length: 10 }, (_, index) => quiz(index + 1)) } });
  await call('draft.publish', { id: 'd' });
}
/** The learner misses `count` cards; the refs of those cards. */
export async function miss(call, count) {
  let run = await call('review.start', { deckId: 'd', mode: 'quiz', count });
  const refs = [];
  for (let i = 0; i < count; i++) {
    refs.push({ deckId: 'd', cardId: run.card.id });
    run = await call('review.answer', { runId: run.id, cardId: run.card.id, selected: [run.card.options.find(option => option.text === 'Memento').id] });
    if (i < count - 1) run = await call('review.move', { runId: run.id, direction: 1 });
  }
  return refs;
}
/** The coach's light model: counts what is in flight (one lane means one), keeps the options of each call, can hold the first one (a stop ends the hold). */
export function lightModel() {
  const log = [], base = createFakeModel({ log, usage: true }), control = { options: [], inFlight: 0, peak: 0, hold: null, armedAt: 0 };
  /** The next call is held until `hold.release()`; what was asked before (the seeding) is not counted. */
  control.arm = () => { control.hold = gate(); control.armedAt = control.options.length; return control.hold; };
  control.complete = async (...args) => {
    control.options.push(args[2] || {}); control.inFlight += 1; control.peak = Math.max(control.peak, control.inFlight);
    const stopped = new Promise((_, reject) => args[2]?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true }));
    stopped.catch(() => {});
    try { if (control.hold && control.options.length === control.armedAt + 1) await Promise.race([control.hold.promise, stopped]); return await base(...args); }
    finally { control.inFlight -= 1; }
  };
  return control;
}

