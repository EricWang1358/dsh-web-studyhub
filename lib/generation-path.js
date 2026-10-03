/* 分步出题路径: a selection too big for one generation (or too big to generate well in one go) is cut into steps in the order of the book, each small enough to
   generate and review properly, so the learner can work through a book chapter by chapter instead of being told "select fewer chapters".

   The plan is made locally from what the app already knows (the chapters of each document, else its pages), so it is instant and always valid: every selected
   page lands in exactly one step, in order, and no step is over the budget. A model may then refine it (names, what each step practises, a suggested order and
   count) through applyPathRefinement, which can never add, drop or re-cut a step: the model only decorates a plan that is already correct. Pure, no model call. */

/** The size of one step in characters: well under the one-shot limit, about what retrieval hands to the author. */
export const STEP_CHARS = 150_000;
export const MAX_STEPS = 40;
const MIN_COUNT = 6, MAX_COUNT = 30;

const clamp = (value, low, high) => Math.min(Math.max(value, low), high);
const clip = (value, length) => { const text = String(value ?? '').replace(/\s+/g, ' ').trim(); return text.length > length ? text.slice(0, length) : text; };

/** How many questions a step of this size deserves. */
export const suggestedCount = chars => clamp(Math.round((Number(chars) || 0) / 6000), MIN_COUNT, MAX_COUNT);

const rangeText = (from, to) => from === to ? `第 ${from} 页` : `第 ${from}–${to} 页`;

/** The units of one document in page order: runs of consecutive pages that belong to the same chapter (pages with no chapter form runs of their own). */
function unitsOf(item) {
  const chapterOf = new Map();
  for (const chapter of item.chapters || []) for (const id of chapter.sourceIds || []) if (!chapterOf.has(id)) chapterOf.set(id, chapter);
  const units = [];
  for (const page of item.pages || []) {
    const chapter = chapterOf.get(page.sourceId) ?? null, last = units.at(-1);
    if (last && last.chapter === chapter) { last.pages.push(page); last.chars += page.chars || 0; }
    else units.push({ document: item.key, chapter, pages: [page], chars: page.chars || 0 });
  }
  const whole = new Map((item.chapters || []).map(chapter => [chapter, (chapter.sourceIds || []).length]));
  for (const unit of units) unit.wholeChapter = !!unit.chapter && unit.pages.length === whole.get(unit.chapter);
  return units;
}

/** A unit over the budget is cut into runs of pages (a page over the budget stays alone: pages are not cut). */
function cut(unit, budget) {
  if (unit.chars <= budget || unit.pages.length < 2) return [unit];
  const parts = [];
  let run = [], chars = 0;
  for (const page of unit.pages) {
    if (run.length && chars + (page.chars || 0) > budget) { parts.push({ ...unit, pages: run, chars, wholeChapter: false }); run = []; chars = 0; }
    run.push(page); chars += page.chars || 0;
  }
  if (run.length) parts.push({ ...unit, pages: run, chars, wholeChapter: false });
  return parts;
}

const partOf = unit => {
  const from = unit.pages[0].page, to = unit.pages.at(-1).page;
  const name = unit.chapter ? String(unit.chapter.title || (unit.chapter.front ? '前言与目录' : '')).trim() : '';
  return { documentKey: unit.document, chapter: name, whole: unit.wholeChapter, from, to, title: name && unit.wholeChapter ? name : name ? `${name} · ${rangeText(from, to)}` : rangeText(from, to) };
};

function titleOf(parts) {
  if (parts.length === 1) return parts[0].title;
  if (parts.length === 2) return `${parts[0].title}、${parts[1].title}`;
  return `${parts[0].title} … ${parts.at(-1).title}`;
}

function build(units, budget) {
  const steps = [];
  let current = null;
  for (const unit of units.flatMap(item => cut(item, budget))) {
    if (current && current.chars + unit.chars <= budget) { current.units.push(unit); current.chars += unit.chars; }
    else { current = { units: [unit], chars: unit.chars }; steps.push(current); }
  }
  return steps;
}

/**
 * The plan for a selection. `items` are the grouped documents of the selection (lib/source-groups.js groupSourcesByDocument, restricted to the selected pages).
 * Resolves { basis: 'chapters' | 'pages', budget, totalChars, steps: [{ id, order, title, parts, sourceIds, pages, chars, count, focus, reason }] }.
 */
export function planGenerationPath(items, { budget = STEP_CHARS, maxSteps = MAX_STEPS } = {}) {
  const documents = (Array.isArray(items) ? items : []).filter(item => item?.pages?.length);
  const units = documents.flatMap(unitsOf);
  const totalChars = units.reduce((sum, unit) => sum + unit.chars, 0);
  let size = Math.max(1, budget), steps = build(units, size);
  // A very long book: widen the steps instead of dropping pages, so there are never more than maxSteps of them.
  for (let guard = 0; steps.length > maxSteps && guard < 8; guard += 1) { size = Math.ceil(Math.max(size * 1.2, (totalChars / maxSteps) * 1.1)); steps = build(units, size); }
  return {
    basis: documents.some(item => item.chapters?.some(chapter => chapter.sourceIds?.length)) ? 'chapters' : 'pages',
    budget: size, totalChars,
    steps: steps.map((step, index) => {
      const parts = step.units.map(partOf), sourceIds = step.units.flatMap(unit => unit.pages.map(page => page.sourceId));
      return { id: `step-${index + 1}`, order: index + 1, title: titleOf(parts), parts, sourceIds, pages: sourceIds.length, chars: step.chars,
        count: suggestedCount(step.chars), focus: '', reason: '' };
    }),
  };
}

/** The list of refinements in a model's reply, whatever it wrapped it in: a bare list, { steps }, { path }, { plan: { steps } }, { result: { steps } }. */
const listOf = reply => {
  if (Array.isArray(reply)) return reply;
  for (const candidate of [reply?.steps, reply?.path, reply?.plan?.steps, reply?.plan, reply?.result?.steps, reply?.result]) if (Array.isArray(candidate)) return candidate;
  return [];
};
/** The first of several field names (the alternatives models use) that holds a value. Shared with the 帮我想想 reply (contexts/generation/suggest.js). */
export const first = (item, names) => { for (const name of names) if (item?.[name] !== undefined && item[name] !== null && item[name] !== '') return item[name]; return undefined; };

/** Which step a refinement item means: its id as given, "step-n" / a bare number / "第 n 步" for the n-th step, or a title that is one of the steps'. */
function stepOf(item, base, byId, position) {
  const raw = first(item, ['id', 'stepId', 'step_id', 'step', 'index', 'order']);
  if (typeof raw === 'string' && byId.has(raw.trim())) return byId.get(raw.trim());
  if (raw !== undefined) {
    const n = Number(String(raw).match(/\d+/)?.[0]);
    if (Number.isInteger(n) && n >= 1 && n <= base.length) return base[n - 1];
  }
  const title = String(first(item, ['originalTitle', 'title', 'name']) ?? '').trim();
  const byTitle = title ? base.find(step => step.title === title) : null;
  if (byTitle) return byTitle;
  return position !== undefined ? base[position] : undefined;
}

/**
 * A model's refinement of a plan: a list of { id, title?, focus?, count?, reason? } in the order it recommends (the common alternative names of those fields, a bare
 * list or another wrapper are understood too; an item with no usable id is matched by position only when the model returned exactly one item per step). Only known
 * steps count, once each; text is clipped, the count clamped; what a step covers is never touched, and a step the model forgot keeps its place after the named
 * ones. { source: 'model' | 'local', steps }.
 */
export function applyPathRefinement(steps, reply) {
  const base = Array.isArray(steps) ? steps : [];
  const byId = new Map(base.map(step => [step.id, step]));
  const list = listOf(reply), sameLength = list.length === base.length;
  const named = [], seen = new Set();
  list.forEach((item, index) => {
    if (!item || typeof item !== 'object') return;
    const step = stepOf(item, base, byId, sameLength ? index : undefined);
    if (!step || seen.has(step.id)) return;
    seen.add(step.id);
    const title = clip(first(item, ['title', 'name']), 80), count = Number(first(item, ['count', 'questions', 'questionCount', 'numQuestions']));
    named.push({ ...step, ...(title ? { named: true } : {}),
      title: title || step.title, focus: clip(first(item, ['focus', 'practice', 'practise', 'goal', 'emphasis']), 200), reason: clip(first(item, ['reason', 'why', 'rationale']), 200),
      count: Number.isFinite(count) && count > 0 ? clamp(Math.round(count), MIN_COUNT, MAX_COUNT) : step.count });
  });
  if (!named.length) return { source: 'local', steps: base };
  const rest = base.filter(step => !seen.has(step.id));
  return { source: 'model', steps: [...named, ...rest].map((step, index) => ({ ...step, order: index + 1 })) };
}
