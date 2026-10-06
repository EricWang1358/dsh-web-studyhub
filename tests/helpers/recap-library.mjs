/* The library and the model the daily recap tests share (the S4-0 baseline and the runtime tests). Fakes only: no model, no network. */
import { StudyService } from '../../lib/service.js';
import { until } from './wait.mjs';
import { privateRoot } from './model-family-baseline.mjs';
import { SWITCH_MODE, switchOptions } from './runtime-switch.mjs';

export const writing = '# 今日学习总结\n\n' + '围绕已练习的知识点整理正确思路，核对条件与推理步骤。'.repeat(8);
export const course = '数学 / 第一章';

/** A library with forty quiz cards in one deck; seeded through the service so both doors can start from the same place. `pilotPaths` switches more on, `nativeHost` gives the Jobs a host with a parent session (S4-8). */
export async function seeded(t, options = {}, mode = SWITCH_MODE) {
  const root = await privateRoot(t, 'model-baseline-recap-');
  const service = new StudyService(root, { ...options, ...switchOptions(mode, { complete: options.complete, paths: ['dailyRecap', ...(options.pilotPaths || [])], host: options.nativeHost }) });
  t.after(() => service.dispose());
  await service.store.update(state => {
    state.decks.push({ id: 'd', title: course, course, cards: Array.from({ length: 40 }, (_, i) => ({ id: `d-${i}`, kind: 'quiz', topic: `知识点 ${i % 3}`, prompt: `题目 ${i}`,
      answer: '正确答案', explanation: '先核对条件。', options: [{ id: 'a', text: '正确选项', correct: true }, { id: 'b', text: '干扰选项' }] })) });
  });
  return service;
}
export const answer = (service, count, offset = 0) => service.store.update(state => {
  for (let i = offset; i < offset + count; i++) state.attempts.push({ id: `a-${i}`, runId: 'seed', deckId: 'd', quiz_id: `d-${i}`, timestamp: new Date().toISOString(), grade: 4, assessment: 'graded' });
});
export const noteOf = async (service, id) => (await service.call('note.get', { id }));
export const done = (service, id, generation) => until(async () => { const note = await noteOf(service, id); return note.generation?.id === generation && note.generation.status !== 'running' && note; }, 'the generation to end');
/** A model that records what it was asked and can hold the n-th call. */
export function model() {
  const control = { calls: [], gates: new Map() };
  control.complete = async (system, prompt, options = {}) => {
    const number = control.calls.length;
    control.calls.push({ system, data: JSON.parse(prompt), options });
    const held = control.gates.get(number);
    if (held) await held.promise;
    return writing;
  };
  return control;
}

