/* The flow around a step plan (lib/generation-path.js): the selection it is made from, the brief that opens a conversation so the learner can shape the chapters
   with the AI, and queuing the steps as generation jobs. Pure; the host call is injected, so it is tested without a host. */
import { groupSourcesByDocument } from '../lib/source-groups.js';

/** The documents of a selection, restricted to the selected pages (each item keeps only what is selected: pages, chapters and chars follow). */
export function selectedItems(sources, selectedIds) {
  const chosen = new Set(selectedIds);
  const items = groupSourcesByDocument((Array.isArray(sources) ? sources : []).filter(source => chosen.has(source.id)));
  return items;
}

const ID_BUDGET = 6000;

/**
 * The message that opens a conversation about the plan. It carries the steps (with the ids of their pages while they fit), the course and goal, what the
 * search index can do, and what the assistant should do: shape the steps with the learner, and only after they confirm, generate each step.
 */
export function pathBrief({ steps, course = '', goal = '', indexed = false, language = 'zh' }) {
  const english = language === 'en';
  let used = 0;
  const lines = steps.map(step => {
    const ids = step.sourceIds.join(',');
    const withIds = used + ids.length <= ID_BUDGET;
    if (withIds) used += ids.length;
    const head = english ? `Step ${step.order}: ${step.title} · ${step.pages} pages · ${step.chars} chars · suggested ${step.count} questions` : `第 ${step.order} 步：${step.title} · ${step.pages} 页 · ${step.chars} 字符 · 建议 ${step.count} 题`;
    const focus = step.focus ? (english ? ` · focus: ${step.focus}` : ` · 重点：${step.focus}`) : '';
    const tail = withIds ? `\n   sourceIds: ${ids}` : '';
    return `${head}${focus}${tail}`;
  });
  const omitted = used < steps.reduce((sum, step) => sum + step.sourceIds.join(',').length, 0);
  if (english) return [
    `I want to work through a big book step by step, and I want to shape the steps with you${course ? ` (course: ${course})` : ''}${goal ? `, goal: ${goal}` : ''}.`,
    'This is the plan the app made from the chapters (it is only a starting point):',
    ...lines,
    omitted ? 'Some page ids are left out to keep this short: call source.list for the book to get them.' : '',
    indexed ? 'The search index of these materials is built: use source.search to find the pages for what I ask for, instead of reading whole chapters.' : 'The search index is not built yet: read only the pages you need.',
    'Ask me what I need (what to focus on, what to skip, how deep, how many questions), then propose changed steps: merge, split, reorder or rename chapters, each with its pages, a focus and a question count.',
    'Do not generate anything until I confirm. After I confirm, call generate once per step with that step\'s sourceIds, focus and count, in order. Reply in English.',
  ].filter(Boolean).join('\n');
  return [
    `我想按步骤学完一本大书，并且想和你一起定制每一步学哪些章节${course ? `（课程：${course}）` : ''}${goal ? `，目标：${goal}` : ''}。`,
    '下面是应用按章节做的初步路径（只是起点）：',
    ...lines,
    omitted ? '为了不太长，部分页面编号省略了：需要时用 source.list 取这本书的页面。' : '',
    indexed ? '这些资料的检索索引已经建好：按我的需求用 source.search 找页面，不要整章整章地读。' : '检索索引还没建好：只读需要的页面。',
    '请先问我需要什么（重点学什么、跳过什么、讲多深、每步多少题），再给出调整后的路径：可以合并、拆分、调整顺序或改章节名，每一步写明页面、重点和题数。',
    '我确认之前不要生成任何东西。确认后，按顺序对每一步调用 generate，带上这一步的 sourceIds、focus 和 count。',
  ].filter(Boolean).join('\n');
}

/**
 * Queue one generation job per step, in order, with the choices of the form (kind, difficulty, language, …). A step that fails to start is reported and the rest
 * still go. Resolves { started: [{ step, job }], failed: [{ step, message }] }.
 */
export async function queueSteps(call, steps, form, { course = '' } = {}) {
  const started = [], failed = [];
  for (const step of steps) {
    try {
      const job = await call('generate', { ...form, course, count: step.count, sourceIds: step.sourceIds, focus: step.focus || form?.focus || '' });
      started.push({ step, job });
    } catch (error) { failed.push({ step, message: String(error?.message || error) }); }
  }
  return { started, failed };
}
