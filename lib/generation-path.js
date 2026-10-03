/* 分步出题路径: a selection too big for one generation (or too big to generate well in one go) is cut into steps in the order of the book, each small enough to
   generate and review properly, so the learner can work through a book chapter by chapter instead of being told "select fewer chapters".

   The plan is made locally from what the app already knows (the chapters of each document, else its pages), so it is instant and always valid: every selected
   page lands in exactly one step, in order, and no step is over the budget. A model may then refine it (names, what each step practises, a suggested order and
   count) through applyPathRefinement, which can never add, drop or re-cut a step: the model only decorates a plan that is already correct. Pure, no model call.

   A step is small in pages as well as in characters (STEP_PAGES): about what one generate call can write and review well (CALL_PAGES pages, CALL_QUESTIONS
   questions; docs/large-documents.md). The front and back matter of a book (contents, copyright, index, colophon, about the author, appendices, blank pages) is
   never mixed into a content step: it forms steps of its own that are optional, off by default, and say what they are. A step is named after the chapters it covers
   (never after a cut-off word such as the letter of an index) and carries the page ranges it covers, so a wish like "p.55-76" can be mapped to pages. */

/** The size of one step in characters: well under the one-shot limit, about what retrieval hands to the author. */
export const STEP_CHARS = 150_000;
/** What one generate call may carry to be written and reviewed well (the chat agent splits a bigger step into several calls). */
export const CALL_PAGES = 20;
export const CALL_QUESTIONS = 15;
/** The size of one step in pages: one generate call's worth, so a step of 81 pages is cut instead of being handed over whole. */
export const STEP_PAGES = CALL_PAGES;
export const MAX_STEPS = 40;
const MIN_COUNT = 6, MAX_COUNT = 30;
/** A page with fewer characters than this has nothing to ask about (a blank page, a separator). */
const BLANK_CHARS = 40;

const clamp = (value, low, high) => Math.min(Math.max(value, low), high);
const clip = (value, length) => { const text = String(value ?? '').replace(/\s+/g, ' ').trim(); return text.length > length ? text.slice(0, length) : text; };

/** How many questions a step of this size deserves. */
export const suggestedCount = chars => clamp(Math.round((Number(chars) || 0) / 6000), MIN_COUNT, MAX_COUNT);

const rangeText = (from, to) => from === to ? `第 ${from} 页` : `第 ${from}–${to} 页`;

/**
 * A chapter name fit to name a step with, or '' when it is not one: a cut-off word (a single letter such as the headings of an index, a dangling hyphen or ellipsis),
 * a bare number or roman numeral, punctuation only. The page range names the step instead.
 */
export function usableTitle(title) {
  const text = String(title ?? '').replace(/\s+/g, ' ').trim();
  if (!text || /[-‐‑–—…]$/u.test(text) || /\.{2,}$/.test(text)) return '';
  const letters = text.replace(/[^\p{L}\p{N}]/gu, '');
  if (!letters || /^\p{N}+$/u.test(letters) || /^[IVXL]{1,6}$/.test(letters)) return '';
  if ([...letters].length < 2 && !/\p{Script=Han}/u.test(letters)) return '';
  return text;
}

/* Headings that are front or back matter, whole-heading matches (a chapter called "Indexing and Search" is a chapter). */
const MATTER = [
  ['index', /^(?:(?:subject|author|general|name) )?index$|^(?:主题|名词|关键词)?索引$/i],
  ['colophon', /^colophon$|^版记$|^出版说明$|^版权信息$/i],
  ['author', /^about (?:the )?(?:authors?|cover|cover image)$|^(?:关于作者|作者简介|作者介绍)$/i],
  ['acknowledgments', /^acknowledg(?:e)?ments?$|^(?:致谢|鸣谢)$/i],
  ['contents', /^(?:table of contents|(?:brief |detailed |short )?contents)$|^目\s?录$/i],
  ['copyright', /^copyright(?: (?:page|notice))?$|^版权(?:页|声明)?$/i],
  ['dedication', /^dedication$|^献词$/i],
  ['preface', /^(?:preface|foreword)\b|^(?:前言|序言|序|自序)$/i],
  ['appendix', /^(?:appendix|annex)(?:\s+(?:[a-z]|\d+|[ivx]+)\b.*)?$|^appendices$|^附录/i],
  ['bibliography', /^bibliography$|^参考文献$/i],
];
/** The kind of front or back matter a heading is ('index', 'colophon', 'author', 'acknowledgments', 'contents', 'copyright', 'dedication', 'preface', 'appendix', 'bibliography'), or ''. */
export function matterKind(title) {
  const text = String(title ?? '').replace(/\s+/g, ' ').replace(/[\s.:：。]+$/u, '').trim();
  if (!text) return '';
  return MATTER.find(([, pattern]) => pattern.test(text))?.[0] || '';
}
/* Once one of these headings is met in the second half of a book, the rest of the book is back matter (an index runs on for pages under headings of its own). */
const TAIL = new Set(['index', 'colophon', 'author']);

const isBlank = page => (page.chars || 0) < BLANK_CHARS;
const unitOf = (item, chapter, pages) => ({ document: item.key, documentTitle: item.title || item.key, chapter, pages, chars: pages.reduce((sum, page) => sum + (page.chars || 0), 0), matter: '' });

/** The units of one document in page order: runs of consecutive pages that belong to the same chapter (pages with no chapter form runs of their own). */
function unitsOf(item) {
  const chapterOf = new Map();
  for (const chapter of item.chapters || []) for (const id of chapter.sourceIds || []) if (!chapterOf.has(id)) chapterOf.set(id, chapter);
  const units = [];
  for (const page of item.pages || []) {
    const chapter = chapterOf.get(page.sourceId) ?? null, last = units.at(-1);
    if (last && last.chapter === chapter) { last.pages.push(page); last.chars += page.chars || 0; }
    else units.push(unitOf(item, chapter, [page]));
  }
  const whole = new Map((item.chapters || []).map(chapter => [chapter, (chapter.sourceIds || []).length]));
  for (const unit of units) unit.wholeChapter = !!unit.chapter && unit.pages.length === whole.get(unit.chapter);
  // Blank pages at the very end of a book (and a chapter that is nothing but blank pages) are not worth a question; blank pages in the middle stay where they are.
  const end = units.at(-1);
  if (end) {
    let from = end.pages.length;
    while (from > 0 && isBlank(end.pages[from - 1])) from -= 1;
    if (from === 0) end.matter = 'blank';
    else if (from < end.pages.length) {
      const tail = { ...unitOf(item, end.chapter, end.pages.slice(from)), matter: 'blank', wholeChapter: false };
      end.pages = end.pages.slice(0, from); end.chars = end.pages.reduce((sum, page) => sum + (page.chars || 0), 0); end.wholeChapter = false;
      units.push(tail);
    }
  }
  return markMatter(units);
}

/** Which units of one document are front or back matter, by the heading of their chapter (and, in the second half of the book, by what an index looks like). */
function markMatter(units) {
  const total = units.reduce((sum, unit) => sum + unit.pages.length, 0);
  const letter = unit => !!unit.chapter && !unit.chapter.front && /^\p{L}$/u.test(String(unit.chapter.title ?? '').trim());
  // Three or more chapters in a row that are one letter each are the headings of an index.
  const lettered = new Set();
  for (let at = 0; at < units.length;) {
    let end = at;
    while (end < units.length && letter(units[end]) && (end === at || units[end].chapter !== units[end - 1].chapter)) end += 1;
    if (end - at >= 3) for (let i = at; i < end; i += 1) lettered.add(i);
    at = Math.max(end, at + 1);
  }
  let seen = 0, tail = '';
  units.forEach((unit, at) => {
    const late = seen * 2 >= total;
    const own = unit.matter || (unit.chapter?.front ? 'front' : matterKind(unit.chapter?.title) || (late && lettered.has(at) ? 'index' : ''));
    if (late && TAIL.has(own)) tail = own;
    unit.matter = own || tail;
    seen += unit.pages.length;
  });
  return units;
}

/** A unit over a limit (characters or pages) is cut into balanced runs of pages (a page over the budget stays alone: pages are not cut). */
function cut(unit, budget, maxPages) {
  const count = unit.pages.length, n = Math.max(Math.ceil(unit.chars / budget), Math.ceil(count / maxPages));
  if (n <= 1 || count < 2) return [unit];
  const parts = [];
  let run = [], chars = 0, goal = Math.ceil(count / n), left = count;
  const close = () => { parts.push({ ...unit, pages: run, chars, wholeChapter: false }); left -= run.length; run = []; chars = 0; goal = Math.ceil(left / Math.max(1, n - parts.length)); };
  for (const page of unit.pages) {
    if (run.length && (chars + (page.chars || 0) > budget || (run.length >= goal && parts.length < n - 1))) close();
    run.push(page); chars += page.chars || 0;
  }
  if (run.length) close();
  return parts;
}

const MATTER_FRONT = '前言与目录';
const partOf = unit => {
  const from = unit.pages[0].page, to = unit.pages.at(-1).page;
  const front = !!unit.chapter?.front, name = front ? '' : usableTitle(unit.chapter?.title);
  const shown = name || (front ? MATTER_FRONT : '');
  return { documentKey: unit.document, documentTitle: unit.documentTitle, chapter: name, front, whole: unit.wholeChapter, from, to,
    title: shown && unit.wholeChapter ? shown : shown ? `${shown} · ${rangeText(from, to)}` : rangeText(from, to) };
};

/**
 * The name of a step from its parts: the usable chapter names (the first and last of them when there are many), with the page range added when some part has no
 * usable name, and the page range alone when none has. `text` says how things are written ({ range(from, to), front, join, ellipsis }); the default is Chinese.
 */
export function stepTitleOf(parts, text = { range: rangeText, front: MATTER_FRONT, join: '、', ellipsis: ' … ' }) {
  if (!parts.length) return '';
  const first = parts[0], last = parts.at(-1), sameDocument = parts.every(part => part.documentKey === first.documentKey);
  const range = sameDocument ? text.range(first.from, last.to) : `${text.range(first.from, first.to)}${text.ellipsis}${text.range(last.from, last.to)}`;
  const name = part => part.chapter || (part.front ? text.front : '');
  const named = parts.filter(part => name(part));
  if (!named.length) return range;
  if (parts.length === 1) return first.whole ? name(first) : `${name(first)} · ${text.range(first.from, first.to)}`;
  const names = named.map(name);
  const joined = names.length === 1 ? names[0] : names.length === 2 && parts.length === 2 ? `${names[0]}${text.join}${names[1]}` : `${names[0]}${text.ellipsis}${names.at(-1)}`;
  return named.length < parts.length ? `${joined} · ${range}` : joined;
}

function build(units, budget, maxPages) {
  const steps = [];
  let current = null;
  for (const unit of units.flatMap(item => cut(item, budget, maxPages))) {
    const optional = !!unit.matter;
    // Matter and content never share a step: the learner can leave the matter out as a whole.
    if (current && current.optional === optional && current.chars + unit.chars <= budget && current.pages + unit.pages.length <= maxPages) { current.units.push(unit); current.chars += unit.chars; current.pages += unit.pages.length; }
    else { current = { units: [unit], chars: unit.chars, pages: unit.pages.length, optional }; steps.push(current); }
  }
  return steps;
}

/** The runs of consecutive pages a step covers, per document: [{ document, from, to }]. */
function rangesOf(units) {
  const ranges = [];
  for (const unit of units) for (const { page } of unit.pages) {
    const last = ranges.at(-1);
    if (last && last.key === unit.document && page === last.to + 1) last.to = page;
    else ranges.push({ key: unit.document, document: unit.documentTitle, from: page, to: page });
  }
  return ranges.map(({ document, from, to }) => ({ document, from, to }));
}

/**
 * The plan for a selection. `items` are the grouped documents of the selection (lib/source-groups.js groupSourcesByDocument, restricted to the selected pages).
 * Resolves { basis: 'chapters' | 'pages', budget, maxPages, totalChars, steps: [{ id, order, title, parts, ranges, sourceIds, pages, chars, count, focus, reason, optional,
 * matter, included }] }: `ranges` are the page runs of each document the step covers; an `optional` step (front or back matter, blank pages; `matter` says which kind)
 * is `included: false` until the learner turns it on, unless everything selected is matter.
 */
export function planGenerationPath(items, { budget = STEP_CHARS, maxSteps = MAX_STEPS, maxPages = STEP_PAGES } = {}) {
  const documents = (Array.isArray(items) ? items : []).filter(item => item?.pages?.length);
  const units = documents.flatMap(unitsOf);
  const totalChars = units.reduce((sum, unit) => sum + unit.chars, 0), totalPages = units.reduce((sum, unit) => sum + unit.pages.length, 0);
  let size = Math.max(1, budget), limit = Math.max(1, maxPages), steps = build(units, size, limit);
  // A very long book: widen the steps (in characters and in pages) instead of dropping pages, so there are never more than maxSteps of them.
  for (let guard = 0; steps.length > maxSteps && guard < 12; guard += 1) {
    size = Math.ceil(Math.max(size * 1.2, (totalChars / maxSteps) * 1.1));
    limit = Math.ceil(Math.max(limit * 1.2, (totalPages / maxSteps) * 1.1));
    steps = build(units, size, limit);
  }
  // Nothing is skipped when everything selected is matter: the learner chose it.
  const skipping = steps.some(step => !step.optional);
  return {
    basis: documents.some(item => item.chapters?.some(chapter => chapter.sourceIds?.length)) ? 'chapters' : 'pages',
    budget: size, maxPages: limit, totalChars,
    steps: steps.map((step, index) => {
      const parts = step.units.map(partOf), sourceIds = step.units.flatMap(unit => unit.pages.map(page => page.sourceId)), optional = step.optional && skipping;
      return { id: `step-${index + 1}`, order: index + 1, title: stepTitleOf(parts), parts, ranges: rangesOf(step.units), sourceIds, pages: sourceIds.length, chars: step.chars,
        count: suggestedCount(step.chars), focus: '', reason: '', optional, matter: optional ? step.units[0].matter : '', included: !optional };
    }),
  };
}

/** The list of refinements in a model's reply, whatever it wrapped it in: a bare list, { steps }, { path }, { plan: { steps } }, { result: { steps } }. */
const listOf = reply => {
  if (Array.isArray(reply)) return reply;
  for (const candidate of [reply?.steps, reply?.path, reply?.plan?.steps, reply?.plan, reply?.result?.steps, reply?.result]) if (Array.isArray(candidate)) return candidate;
  return [];
};
const first = (item, names) => { for (const name of names) if (item?.[name] !== undefined && item[name] !== null && item[name] !== '') return item[name]; return undefined; };

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
