/* The flow around a step plan (lib/generation-path.js): the selection it is made from, the brief that opens a conversation so the learner can shape the chapters
   with the AI, and queuing the steps as generation jobs. Pure; the host call is injected, so it is tested without a host. */
import { groupSourcesByDocument } from '../lib/source-groups.js';
import { CALL_PAGES, CALL_QUESTIONS } from '../lib/generation-path.js';

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

const ID_BUDGET = 6000;

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
 * The message that opens a conversation about the plan. It carries the steps (with the book pages each covers and, while they fit, the ids of their pages), the course
 * and goal, what the search index can do, how to get the ids of a custom page range, how big one generate call may be, how to see a job (job.status) and to take the
 * next step only after the one before ended; steps to skip are listed without ids. And what the assistant should do: shape the steps with the learner, and only after
 * they confirm, generate each step.
 */
export function pathBrief({ steps, course = '', goal = '', indexed = false, language = 'zh' }) {
  const english = language === 'en';
  const documents = [...new Set(steps.flatMap(step => (step.ranges || []).map(run => run.document)).filter(Boolean))];
  let used = 0;
  const skipped = step => step.included === false;
  const lines = steps.map(step => {
    const range = rangesText(step.ranges, english, documents.length), shown = range && !String(step.title).includes(range.replace(/^"[^"]*" |^《[^》]*》/, '')) ? range : '';
    if (skipped(step)) {
      const word = step.optional && MATTER_WORDS[step.matter] ? MATTER_WORDS[step.matter][english ? 'en' : 'zh'] : '';
      const why = english ? (step.optional ? `suggest skipping it${word ? ` (${word.toLowerCase()})` : ''}; I can ask for it later` : 'skip for now (I switched it off)')
        : (step.optional ? `建议跳过${word ? `（${word}）` : ''}；我需要时再说` : '先跳过（我没有勾选这一步）');
      return english ? `Step ${step.order}: ${step.title}${shown ? ` · ${shown}` : ''} · ${step.pages} pages · ${why}` : `第 ${step.order} 步：${step.title}${shown ? ` · ${shown}` : ''} · ${step.pages} 页 · ${why}`;
    }
    const ids = step.sourceIds.join(',');
    const withIds = used + ids.length <= ID_BUDGET;
    if (withIds) used += ids.length;
    const head = english ? `Step ${step.order}: ${step.title}${shown ? ` · ${shown}` : ''} · ${step.pages} pages · ${step.chars} chars · suggested ${step.count} questions` : `第 ${step.order} 步：${step.title}${shown ? ` · ${shown}` : ''} · ${step.pages} 页 · ${step.chars} 字符 · 建议 ${step.count} 题`;
    const focus = step.focus ? (english ? ` · focus: ${step.focus}` : ` · 重点：${step.focus}`) : '';
    const tail = withIds ? `\n   sourceIds: ${ids}` : '';
    return `${head}${focus}${tail}`;
  });
  const omitted = used < steps.filter(step => !skipped(step)).reduce((sum, step) => sum + step.sourceIds.join(',').length, 0);
  const hasRanges = steps.some(step => step.ranges?.length);
  const bookNames = documents.length ? documents.map(name => english ? `"${name}"` : `《${name}》`).join(english ? ', ' : '、') : '';
  if (english) return [
    `I want to work through a big book step by step, and I want to shape the steps with you${course ? ` (course: ${course})` : ''}${goal ? `, goal: ${goal}` : ''}.`,
    `This is the plan the app made from the chapters (it is only a starting point).${hasRanges ? ` Page numbers are PDF page numbers (the number after "p." in a page title)${bookNames ? ` of ${bookNames}` : ''}.` : ''}`,
    ...lines,
    omitted ? 'Some page ids are left out to keep this short: call source.list for the book to get them.' : '',
    hasRanges ? 'To map my wishes to pages (for example "pages 55–76"), do not guess ids: call source.list {"query": "<book title>", "groupBy": "document", "memberOffset": <first page - 1>, "memberLimit": <up to 200>}. Every member has its page and id, in page order; take the ids of the pages inside my range.' : '',
    indexed ? 'The search index of these materials is built: use source.search to find the pages for what I ask for, instead of reading whole chapters.' : 'The search index is not built yet: read only the pages you need.',
    'Ask me what I need (what to focus on, what to skip, how deep, how many questions), then propose changed steps: merge, split, reorder or rename chapters, each with its pages, a focus and a question count.',
    `Keep every generate call small: at most ${CALL_PAGES} pages and ${CALL_QUESTIONS} questions. A step that is bigger than that (more pages or more questions) is split into several generate calls: cut its pages into runs of at most ${CALL_PAGES} pages by page number and share the questions out, at most ${CALL_QUESTIONS} per call, one call after another.`,
    'generate only starts a background job and returns a jobId: the questions are not written yet. After you start one, look at it with job.status {jobId} (it answers at once; use job.wait only for one short wait of at most 60 seconds). Start the next call only after the previous step has finished (job.status says finished and complete); if it is still running, tell me where it is (stage, saved/requested questions) and wait. You cannot watch a job between my messages, so do not promise to report on your own: say that you will check with job.status when I write next, and then do report.',
    'Do not generate anything until I confirm. After I confirm, call generate for each step in order (skip the steps marked as skipped unless I ask for them) with that step\'s sourceIds, focus and count, as described above. Reply in English.',
  ].filter(Boolean).join('\n');
  return [
    `我想按步骤学完一本大书，并且想和你一起定制每一步学哪些章节${course ? `（课程：${course}）` : ''}${goal ? `，目标：${goal}` : ''}。`,
    `下面是应用按章节做的初步路径（只是起点）。${hasRanges ? `页码是 PDF 页码，也就是页面标题里“p.”后面的数字${bookNames ? `（书：${bookNames}）` : ''}。` : ''}`,
    ...lines,
    omitted ? '为了不太长，部分页面编号省略了：需要时用 source.list 取这本书的页面。' : '',
    hasRanges ? '要把我说的页码（比如“第 55–76 页”）对应到页面，不要猜编号：调用 source.list {"query": "书名", "groupBy": "document", "memberOffset": 第一页页码-1, "memberLimit": 最多 200}，每个成员都带 page 和 id，按页码顺序；取页码在我说的范围里的那些 id。' : '',
    indexed ? '这些资料的检索索引已经建好：按我的需求用 source.search 找页面，不要整章整章地读。' : '检索索引还没建好：只读需要的页面。',
    '请先问我需要什么（重点学什么、跳过什么、讲多深、每步多少题），再给出调整后的路径：可以合并、拆分、调整顺序或改章节名，每一步写明页面、重点和题数。',
    `每次调用 generate 都要小：至多 ${CALL_PAGES} 页、至多 ${CALL_QUESTIONS} 题。一步超过这个大小（页数多或题数多）就拆成几次 generate：把它的页面按页码切成每段至多 ${CALL_PAGES} 页，题数分给各段，每次至多 ${CALL_QUESTIONS} 题，一次接一次地做。`,
    'generate 只是开始一个后台任务并返回 jobId，这时题目还没有写好。开始之后用 job.status {jobId} 看它（马上返回；只有需要时才用 job.wait 等一小会儿，最多 60 秒）。上一步完成（job.status 显示已结束且 complete）之后再开始下一步；还在进行就告诉我现在到哪了（阶段、已存/要求的题数），等它做完。你无法在两条消息之间自己盯着任务，所以不要承诺“好了再告诉你”：说明我下次发消息时你会先用 job.status 查看，然后真的汇报。',
    '我确认之前不要生成任何东西。确认后，按顺序对每一步（标了“跳过”的步骤除非我要）调用 generate，带上这一步的 sourceIds、focus 和 count，并遵守上面的大小限制。',
  ].filter(Boolean).join('\n');
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
