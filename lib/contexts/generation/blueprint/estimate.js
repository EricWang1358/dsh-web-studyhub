import { POINTS_PER_WINDOW, QUESTIONS_PER_CHUNK } from './constants.js';
import { STANDIN } from './jobs/messages.js';
import { mergePrompt, paperPrompt, slidesPrompt } from './prompts.js';

/**
 * The calls the build is expected to make, with their real prompts (the candidates and points of the later calls are stand-ins of a typical size):
 * a call per chunk of sample paper, one to unite the points of the papers, a call per window of slides, one to unite the extra points of the windows.
 */
export function estimateCalls(plan) {
  const calls = plan.paperChunks.map(piece => ({ id: 'paper', ...paperPrompt(piece, plan), outputChars: { low: 150, high: QUESTIONS_PER_CHUNK * 220 } }));
  const stand = (prefix, count) => Array.from({ length: count }, (_, index) => ({ id: `${prefix}${index + 1}`, title: STANDIN.title, parent: STANDIN.parent }));
  const guess = Math.min(60, 6 * Math.max(1, plan.paperChunks.length));
  if (plan.mergeNeeded) calls.push({ id: 'merge', ...mergePrompt(stand('c', guess), plan), outputChars: { low: 80, high: guess * 60 } });
  const points = stand('p', guess);
  for (const window of plan.windows) {
    calls.push({ id: 'slides', ...slidesPrompt(window, plan.paperChunks.length ? points : [], plan), outputChars: { low: 150, high: POINTS_PER_WINDOW * 260 } });
  }
  if (plan.extraMergeNeeded) {
    const extras = Math.min(60, POINTS_PER_WINDOW * plan.windows.length);
    calls.push({ id: 'merge', ...mergePrompt(stand('x', extras), plan), outputChars: { low: 80, high: extras * 60 } });
  }
  return calls;
}
