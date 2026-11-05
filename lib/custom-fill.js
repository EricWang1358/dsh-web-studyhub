import { readinessModel } from './custom-readiness.js';
import { courseRowsOf } from './course-outline.js';
import { currentCourseOutline } from './course-outline-book.js';
import { documentIndex, leafSegments } from './course-book-inputs.js';
import { estimateFromState } from './token-estimate.js';

/* 补齐 (深度定制 S5): one button that fills what a chapter is missing, by starting EXISTING work and nothing of its own. It decides from the readiness model
   (lib/custom-readiness.js) and calls the ops the app already has; it writes nothing itself, so a job it starts is an ordinary job of the 任务 console.

   course.custom.fill { course?, chapters?: [chapter id], estimate?: true }
   -> { status: 'ok' | 'nothing' | 'no-course' | 'no-book' | 'no-outline', course, chapters: [id] (the ones asked about), unknownChapters, estimate: boolean,
        book: null | { chapters, points, calls }, questions: null | { points, chapters, calls }, variants: null | { cards, points, calls },
        calls: { low, high } | null (the sum of what is known), started?: { book?, questions?, variants? } }
   WHAT IS MISSING, and the op that makes it (the plan's ticked parts only; a chapter without a plan counts everything):
     points without a written explanation  -> generation.courseBook.build { course, chapters } (it keeps the points already written, costs nothing for them and
                                              refuses a second build of the course: the running one is answered, `alreadyRunning`)
     points with no question, published or in a draft -> generate { sourceIds: the pages of exactly those points, course, coverageLevel, kinds }: one draft, never
                                              published by itself. A repeat starts nothing while that job runs (a job over the same pages), and once its draft exists
                                              the points have a question in a draft, so they are not asked again.
     points with a weak question (answered wrong last) -> coach.variants { cards } when the plan ticks 变式题: the coach's own preparation, which skips what is ready or
                                              being prepared and asks the learner's consent first (`needsConsent`).
   `estimate: true` starts nothing and says the rough calls: the build's own estimate (`estimate: true` of the op), the question run's estimate (lib/token-estimate.js, as
   the generate form prices it), a call a weak question for the variants. No price. */

const unique = list => [...new Set(list)];
const words = (language, zh, en) => (language === 'en' ? en : zh);

function questionCalls(state, args, language) {
  try { const { calls } = estimateFromState('generate', args, state, { language }); return calls?.high > 0 ? { low: calls.low, high: calls.high } : null; } catch { return null; }
}

/** The questions to make: the pages of exactly the points that have none (`ids`), as the book's own reader finds them for each point. */
function questionStep(state, course, ids, custom, chapters, language) {
  const outline = currentCourseOutline(state.sources, course).courseOutline, nodes = new Map();
  const walk = list => (list || []).forEach(node => { nodes.set(node.id, node); walk(node.children); });
  walk(outline.nodes);
  const docs = documentIndex(courseRowsOf(state, course).index.allDocuments), byId = new Map((state.sources || []).map(source => [source.id, source]));
  const found = ids.map(id => ({ id, sources: unique(leafSegments(byId, docs, nodes.get(id)?.anchors).map(segment => segment.sourceId)) })).filter(item => item.sources.length);
  if (!found.length) return null;
  const sourceIds = unique(found.flatMap(item => item.sources)), titles = chapters.map(chapter => chapter.title).join('、');
  const args = { sourceIds, course, title: `${course ? `${course} · ` : ''}${titles}`.slice(0, 120), ...(custom?.questions.make ? { coverageLevel: custom.questions.strength } : {}),
    ...(custom?.questions.kinds?.length ? { kinds: custom.questions.kinds } : {}) };
  return { points: found.length, chapters: chapters.length, sourceIds, args, calls: questionCalls(state, args, language) };
}

/** What 补齐 would start for these chapters (or all of the plan's), decided from what the library holds. No call, nothing written. */
export function fillPlan(state, args = {}, { language } = {}) {
  const model = readinessModel(state, args);
  if (model.status !== 'ok') return { status: model.status, course: model.course, chapters: [], unknownChapters: [], estimate: args.estimate === true, book: null, questions: null, variants: null, calls: null };
  if (args.chapters !== undefined && (!Array.isArray(args.chapters) || args.chapters.some(id => typeof id !== 'string'))) throw new Error(words(language, '章节需为编号列表', 'chapters must be a list of chapter ids'));
  const asked = args.chapters ? unique(args.chapters) : null, chapters = model.chapters.filter(chapter => !asked || asked.includes(chapter.id));
  const base = { course: model.course, chapters: chapters.map(chapter => chapter.id), unknownChapters: asked ? asked.filter(id => !model.chapters.some(chapter => chapter.id === id)) : model.unknownChapters,
    estimate: args.estimate === true };
  if (model.basis !== 'outline') return { ...base, status: 'no-outline', book: null, questions: null, variants: null, calls: null };
  const record = (state.courses || []).find(item => item?.name === model.course), custom = record?.custom ?? null;
  const writing = chapters.filter(chapter => chapter.detail.explain.length), asking = chapters.filter(chapter => chapter.detail.questions.length);
  const book = writing.length ? { chapters: writing.map(chapter => chapter.id), points: writing.reduce((sum, chapter) => sum + chapter.detail.explain.length, 0), calls: null } : null;
  const questions = asking.length ? questionStep(state, model.course, asking.flatMap(chapter => chapter.detail.questions), custom, asking, language) : null;
  const weak = custom?.questions.make && custom.questions.variants ? chapters.flatMap(chapter => chapter.detail.weak) : [];
  const variants = weak.length ? { cards: weak.map(entry => ({ deckId: entry.deckId, cardId: entry.cardId })), points: chapters.reduce((sum, chapter) => sum + chapter.todo.weak, 0),
    calls: { low: weak.length, high: weak.length } } : null;
  const status = book || questions || variants ? 'ok' : 'nothing';
  return { ...base, status, book, questions, variants, calls: null };
}

/** What the caller is told: the steps without the pages and cards themselves (a whole book is hundreds of them), only how many. */
const told = plan => ({ ...plan, questions: plan.questions && { points: plan.questions.points, chapters: plan.questions.chapters, sources: plan.questions.sourceIds.length, calls: plan.questions.calls },
  variants: plan.variants && { cards: plan.variants.cards.length, points: plan.variants.points, calls: plan.variants.calls } });
const sumCalls = steps => { const known = steps.filter(step => step?.calls); return known.length ? { low: known.reduce((sum, step) => sum + step.calls.low, 0), high: known.reduce((sum, step) => sum + step.calls.high, 0) } : null; };
const attempt = async work => { try { return await work(); } catch (error) { return { error: error?.message ?? String(error), ...(error?.code ? { code: error.code } : {}) }; } };

/** course.custom.fill: the plan, then (unless `estimate`) the existing ops it names. `call` reaches the other contexts' ops; `running(sourceIds)` says a question job over
    those pages is running. The answer is the plan with `started`: what each op answered (a refusal is `{ error }`, so one refused step does not stop the others). */
export async function fillCourse(state, args, { call, running, language }) {
  const plan = fillPlan(state, args, { language });
  if (plan.status !== 'ok') return told(plan);
  const { book, questions, variants } = plan;
  if (args.estimate === true) {
    if (book) { const scale = await attempt(() => call('generation.courseBook.build', { course: plan.course, chapters: book.chapters, estimate: true })); book.calls = scale?.scale?.calls ?? null; }
    return told({ ...plan, calls: sumCalls([book, questions, variants]) });
  }
  const started = {};
  if (book) started.book = await attempt(() => call('generation.courseBook.build', { course: plan.course, chapters: book.chapters }));
  if (questions) started.questions = running(questions.sourceIds) ? { alreadyRunning: true } : await attempt(() => call('generate', questions.args));
  if (variants) started.variants = await attempt(() => call('coach.variants', { cards: variants.cards }));
  return told({ ...plan, started });
}
