import { ui, uiFormat } from "../i18n.js";

/* The plain-words notes of an audio import that the page cards and the 任务 console share: how many windows run at once and a transcript reused. No React here: the console's model reads them. */

/** How many proofread / translate windows run at once, and, when the model pushed back, that it was lowered (and came back). */
export function parallelNote(parallel) {
  if (!parallel || !(parallel.limit >= 1)) return '';
  if (parallel.effective < parallel.limit) return uiFormat('并行 {0}（已因限流从 {1} 降到 {0}）', [parallel.effective, parallel.limit]);
  if (parallel.lowest < parallel.limit) return uiFormat('并行 {0}（曾因限流降到 {1}，已恢复）', [parallel.effective, parallel.lowest]);
  return uiFormat('并行 {0}', [parallel.effective]);
}

/** A recording that went on from a saved transcript did not ask the transcription provider again: say so, so "0 requests" is explained. */
export function reuseNote(steps) {
  const step = steps?.transcribe;
  if (!(step?.reused > 0)) return '';
  if (step.reused >= step.total) return ui('复用已保存的转写，没有向转写服务发请求');
  return uiFormat('复用已保存的转写 {0}/{1} 段，其余 {2} 段重新转写', [step.reused, step.total, step.total - step.reused]);
}
