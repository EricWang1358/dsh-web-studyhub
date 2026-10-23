/* The flow around a step plan (lib/generation-path.js): the selection it is made from, the page ranges and matter words of the brief that opens a conversation
   so the learner can shape the chapters with the AI (ui/agent-prompts/path.js), and queuing the steps as generation jobs. Pure; the host call is injected, so it is tested without a host. */
import { groupSourcesByDocument } from '../lib/source-groups.js';

/** The documents of a selection, restricted to the selected pages (each item keeps only what is selected: pages, chapters and chars follow). */
export function selectedItems(sources, selectedIds) {
  const chosen = new Set(selectedIds);
  const items = groupSourcesByDocument((Array.isArray(sources) ? sources : []).filter(source => chosen.has(source.id)));
  return items;
}

/** What each kind of front or back matter is called (the panel shows the Chinese through the locale; the English brief uses these words). */
export const MATTER_WORDS = Object.freeze({
  front: { zh: '前言与目录', en: 'Front matter and contents' },
  contents: { zh: '目录页', en: 'Table of contents' },
  copyright: { zh: '版权页', en: 'Copyright page' },
  dedication: { zh: '献词', en: 'Dedication' },
  preface: { zh: '前言或序', en: 'Preface or foreword' },
  acknowledgments: { zh: '致谢', en: 'Acknowledgments' },
  index: { zh: '索引', en: 'Index' },
  colophon: { zh: '版记', en: 'Colophon' },
  author: { zh: '作者介绍', en: 'About the author' },
  appendix: { zh: '附录', en: 'Appendix' },
  bibliography: { zh: '参考文献', en: 'Bibliography' },
  blank: { zh: '空白页', en: 'Blank pages' },
});

const runText = (run, english) => run.from === run.to ? (english ? `${run.from}` : `第 ${run.from} 页`) : (english ? `${run.from}–${run.to}` : `第 ${run.from}–${run.to} 页`);
/** The pages a step covers, as the brief writes them ("第 55–76 页、第 80 页" / "pages 55–76, 80"); with several documents each run says which one. */
export function rangesText(ranges, english, documents = 1) {
  const list = Array.isArray(ranges) ? ranges.filter(run => Number.isInteger(run?.from) && Number.isInteger(run?.to)) : [];
  if (!list.length) return '';
  const named = documents > 1;
  const groups = [];
  for (const run of list) { const last = groups.at(-1); if (last && last.document === run.document) last.runs.push(run); else groups.push({ document: run.document, runs: [run] }); }
  return groups.map(group => {
    const text = english ? `pages ${group.runs.map(run => runText(run, true)).join(', ')}` : group.runs.map(run => runText(run, false)).join('、');
    return named && group.document ? (english ? `"${group.document}" ${text}` : `《${group.document}》${text}`) : text;
  }).join(english ? '; ' : '；');
}

/**
 * Queue one generation job per step, in order, with the choices of the form (kind, difficulty, language, …). A step that fails to start is reported and the rest
 * still go. Resolves { started: [{ step, job }], failed: [{ step, message }] }.
 */
export async function queueSteps(call, steps, form, { course = '' } = {}) {
  const started = [], failed = [];
  // A step is a plain request with its OWN count. The form-only fields stay at home: its empty spending limit ('') made the backend take every step for a coverage run and refuse
  // all of them (「tokenBudget 需要是不小于 1000 的整数」), and the level / auto-complete / typed total belong to a whole-material run, not to one step of a path.
  const { customCount: _typed, tokenBudget: _budget, autoComplete: _auto, coverageLevel: _level, ...base } = form || {};
  for (const step of steps) {
    try {
      const job = await call('generate', { ...base, course, count: step.count, sourceIds: step.sourceIds, focus: step.focus || form?.focus || '' });
      started.push({ step, job });
    } catch (error) { failed.push({ step, message: String(error?.message || error) }); }
  }
  return { started, failed };
}

/** The failed steps grouped by their reason, in the order the reasons first appeared: [{ message, steps: [title] }]. One reason that hit 21 steps is said once. */
export function failureGroups(failed, titleOf) {
  const groups = new Map();
  for (const { step, message } of failed || []) {
    if (!groups.has(message)) groups.set(message, []);
    groups.get(message).push(titleOf(step));
  }
  return [...groups].map(([message, steps]) => ({ message, steps }));
}
