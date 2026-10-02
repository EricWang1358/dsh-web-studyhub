/* Token estimates before a run (WP27): no model call, no network.

   An estimate is built the way the run itself is built. The batching comes from
   lib/batch.js (planGeneration), the prompts from the very builders the
   pipeline sends (planPrompts, authorPrompts, reviewPrompts, caseAuthorPrompt,
   caseGradingPrompt, proofreadPrompt, ...), priced as DSH prices a message
   (`ctx.tokenMeter` when the host has it, a mirror of its rule otherwise). What
   a model WRITES cannot be built, so output sizes are measured from the bundled
   sample course (cards, cases, gradings) or taken from the length the prompt
   itself asks for.

   Every figure is a range, in DSH's own fields: 未缓存输入 / 缓存读取 / 输出,
   plus the prompt side as a whole and the total. Reasoning tokens are part of
   the output a provider reports, and nothing here measures how many a level
   adds, so a high reasoning level is only noted. Prices are not here and never
   will be: a provider's price list is the learner's to apply to the tokens. */
import { planGeneration, MAX_SELECTED_CHARS } from './batch.js';
import { planPrompts } from './assessment-quality.js';
import { authorPrompts, reviewPrompts } from './generation.js';
import { scopeExisting } from './existing-scope.js';
import { selectionEvidenceText } from './selection-evidence.js';
import { missingQuestions, continuationKindCounts } from './draft-continuation.js';
import {
  caseAuthorPrompt, caseReviewPrompt, caseCriteriaPrompt, caseGradingPrompt, caseGenerationArgs, courseProfileFromState, boundedGuidance,
  scenarioLengthRange, suggestedWords, isEnglish, isBlank,
} from './case-study.js';
import { rubricInput } from './rubric-grading.js';
import { SUGGEST_GOALS, SUGGEST_LIMITS, sourceOutlines, weakTopicsFor, suggestionSignals, buildSuggestPrompt } from './contexts/generation/suggest.js';
import { PROOFREAD_SYSTEM, TRANSLATE_SYSTEM, TRANSLATE_TO_ENGLISH_SYSTEM, TITLE_SYSTEM, proofreadPrompt, translatePrompt } from './transcript.js';
import zhSample from './sample/zh.js';
import enSample from './sample/en.js';

/* ---------- pricing text the way DSH does ---------- */

const CHARS_PER_TOKEN = 4;
const BLOCK_OVERHEAD = 4;
const ROLE_OVERHEAD = 4;

/** DSH's `estimateMessage` for one user message: a text block (chars / 4 + 4) plus role framing. */
export const dshUserTokens = (text) => Math.ceil(String(text).length / CHARS_PER_TOKEN) + BLOCK_OVERHEAD + ROLE_OVERHEAD;
/** DSH's `estimateSystemMessage`: text density plus role framing, no block overhead; empty is free. */
export const dshSystemTokens = (text) => String(text).length === 0 ? 0 : Math.ceil(String(text).length / CHARS_PER_TOKEN) + ROLE_OVERHEAD;

// DeepSeek's published conversion: a Chinese character is about 0.6 token, an English character about 0.3.
const CJK_ALL = /[　-ヿ㐀-鿿가-힯豈-﫿＀-￯]/g;
const CJK_TOKENS = 0.6, OTHER_TOKENS = 0.3;
const isCjk = (text) => { const value = String(text); return (value.match(CJK_ALL)?.length || 0) >= value.length * 0.3 && value.length > 0; };
function documentedTokens(text) {
  const value = String(text), cjk = value.match(CJK_ALL)?.length || 0;
  return Math.ceil(cjk * CJK_TOKENS + (value.length - cjk) * OTHER_TOKENS);
}

/**
 * Text pricing for estimates. The lower bound is DSH's own fixed heuristic (the `tokenMeter` service when the host
 * has it, else a mirror of its rule); the upper bound counts by DeepSeek's documented per-character rates, because
 * DSH itself says its heuristic underprices Chinese text and JSON.
 * @param services `{ tokenMeter }`: `ctx.tokenMeter` when the host provides it.
 */
export function createTextMeasure({ tokenMeter } = {}) {
  const dsh = (text, role = 'user') => {
    const value = String(text ?? '');
    if (typeof tokenMeter?.estimateMessage === 'function') {
      try {
        const tokens = tokenMeter.estimateMessage({ role, content: role === 'system' && !value ? [] : [{ type: 'text', text: value }] });
        if (Number.isFinite(tokens) && tokens >= 0) return tokens;
      } catch { /* the mirrored rule below prices the same text */ }
    }
    return role === 'system' ? dshSystemTokens(value) : dshUserTokens(value);
  };
  /** { low, high } tokens of one message, framing included. */
  const range = (text, role = 'user') => {
    const value = String(text ?? ''), low = dsh(value, role);
    const framing = role === 'system' ? (value.length ? ROLE_OVERHEAD : 0) : BLOCK_OVERHEAD + ROLE_OVERHEAD;
    return { low, high: Math.max(low, documentedTokens(value) + framing) };
  };
  let framing;
  /** { low, high } tokens of text a model writes: no message framing. */
  const body = (text) => {
    const priced = range(text, 'user');
    framing ??= dsh('', 'user');
    return { low: Math.max(0, priced.low - framing), high: Math.max(0, priced.high - (BLOCK_OVERHEAD + ROLE_OVERHEAD)) };
  };
  return { dsh, range, body };
}

/* ---------- ranges ---------- */

const zero = () => ({ low: 0, high: 0 });
const add = (a, b) => ({ low: a.low + b.low, high: a.high + b.high });
const whole = (value) => ({ low: Math.round(value.low), high: Math.round(value.high) });
const bound = (value) => Number.isFinite(Number(value)) ? Math.max(0, Math.round(Number(value))) : 0;

const empty = (feature, notes = []) => ({ feature, uncachedInputTokens: zero(), cacheReadTokens: zero(), outputTokens: zero(), inputTokens: zero(),
  totalTokens: zero(), calls: zero(), stages: [], notes });

/** One model call: its prompts (`low`: the smallest prompt it can carry, `high`: the largest) and what it will write. */
function call(measure, id, { system, prompt, promptHigh = prompt, prefix = '', output }) {
  const sys = measure.range(system, 'system');
  const user = measure.range(prompt, 'user'), userHigh = measure.range(promptHigh, 'user');
  const input = { low: sys.low + user.low, high: sys.high + userHigh.high };
  // What every call of this kind repeats before its own data: a provider can serve it from cache after the first.
  const cacheable = Math.min(input.high, sys.high + (prefix ? measure.range(prefix, 'user').high : 0));
  return { id, input, output: whole(output), cacheable };
}

function summarize(feature, calls, { calls: callRange, notes = [], extra = {} } = {}) {
  const stages = new Map();
  let input = zero(), output = zero(), cache = 0;
  calls.forEach((item, index) => {
    input = add(input, item.input);
    output = add(output, item.output);
    if (index > 0) cache += item.cacheable;
    const stage = stages.get(item.id) || { id: item.id, calls: 0, inputTokens: zero(), outputTokens: zero() };
    stage.calls += 1;
    stage.inputTokens = add(stage.inputTokens, item.input);
    stage.outputTokens = add(stage.outputTokens, item.output);
    stages.set(item.id, stage);
  });
  const cacheRead = { low: 0, high: Math.min(cache, input.high) };
  const count = calls.length;
  return { feature, uncachedInputTokens: { low: Math.max(0, input.low - cacheRead.high), high: input.high }, cacheReadTokens: cacheRead,
    outputTokens: output, inputTokens: input, totalTokens: add(input, output),
    calls: callRange || { low: count, high: count }, stages: [...stages.values()], notes: [...new Set(notes)], ...extra };
}

/* ---------- what the sample course says about output sizes ---------- */

const memo = new WeakMap();
const SENTENCES = { zh: zhSample.document.markdown, en: enSample.document.markdown };
const language = (value) => isEnglish(value) ? 'en' : 'zh';
/** Prose of about `chars` characters in the language, for pricing text that does not exist yet. */
const prose = (lang, chars) => {
  const corpus = SENTENCES[lang], size = Math.max(0, Math.round(chars));
  return corpus.repeat(Math.ceil(size / corpus.length) + 1).slice(0, size);
};
const checkOf = (card, index) => ({ cardId: `q${index + 1}`, selfContained: 'pass', answerLeak: 'pass', optionQuality: card.options ? 'pass' : 'na',
  learningValue: 'pass', sourceSupport: 'pass', explanationQuality: 'pass', explanation: card.explanation });
const toCard = (card, index) => { const { key: _key, quote, ...rest } = card; return { id: `q${index + 1}`, ...rest, citations: [{ sourceId: 'source', quote }] }; };
const targetOf = (card) => ({ objective: card.objective, answerBoundary: card.answer, comparisonAxis: card.topic, misconception: card.misconception,
  contextNeeded: card.prompt, answerability: { mode: 'discrimination', requiredContextAvailable: true, answerOnlyInSourceList: false, criteriaWouldRevealAnswer: false },
  citations: [{ sourceId: 'source', quote: String(card.quote || card.answer).slice(0, 80) }] });

function sampleMeasures(lang, measure) {
  let byLanguage = memo.get(measure);
  if (!byLanguage) memo.set(measure, byLanguage = {});
  if (byLanguage[lang]) return byLanguage[lang];
  const sample = lang === 'en' ? enSample : zhSample;
  const cards = sample.deck.cards.map(toCard);
  const average = (list, text) => {
    const items = list.length ? list : cards, priced = measure.body(items.map(text).join(''));
    return { low: priced.low / items.length, high: priced.high / items.length };
  };
  const kinds = {};
  for (const [name, list] of [['choice', cards.filter((card) => card.options)], ['plain', cards.filter((card) => !card.options)]]) kinds[name] = {
    author: average(list, (card) => JSON.stringify(card) + JSON.stringify(checkOf(card, 0)) + JSON.stringify({ cardId: card.id, summary: card.explanation.slice(0, 60) })),
    review: average(list, (card) => JSON.stringify(checkOf(card, 0))),
    target: average(list, (card) => JSON.stringify(targetOf(card))),
    card: list.length ? list : cards,
  };
  const study = sample.caseStudy;
  const perMark = (() => {
    const marks = study.questions.reduce((sum, question) => sum + question.marks, 0);
    const priced = measure.body(study.questions.map((question) => JSON.stringify({ ...question, id: 'q1', concepts: [question.topic], paragraphs: [2, 4] })).join(''));
    return { low: priced.low / marks, high: priced.high / marks };
  })();
  const graded = study.attempt.grading, criteria = graded.flatMap((item) => item.criteria);
  const gradingCriterion = (() => { const priced = measure.body(criteria.map((item) => JSON.stringify(item)).join('')); return { low: priced.low / criteria.length, high: priced.high / criteria.length }; })();
  const gradingWrapper = (() => { const priced = measure.body(graded.map((item) => JSON.stringify({ cardId: 'x', summary: item.summary, unanchored: item.unanchored || [], assumptions: item.assumptions || [] })).join('')); return { low: priced.low / graded.length, high: priced.high / graded.length }; })();
  return byLanguage[lang] = { kinds, cards, perMark, gradingCriterion, gradingWrapper, cues: study.cues, paragraphs: study.scenario.paragraphs };
}
const unit = (value, count) => ({ low: value.low * count, high: value.high * count });

/* ---------- question generation ---------- */

const sourceChars = (sources) => sources.reduce((sum, source) => sum + (typeof source?.text === 'string' ? source.text.length : 0), 0);
const cleanSources = (sources) => (Array.isArray(sources) ? sources : []).filter((source) => source && typeof source.text === 'string' && source.text.trim() && source.id !== undefined);

/** The largest prefix of the selection the pipeline accepts (it refuses more, whole sources only). */
function fitSelection(sources) {
  let chars = 0, fit = 0;
  for (const source of sources) {
    if (chars + source.text.length > MAX_SELECTED_CHARS) break;
    chars += source.text.length;
    fit += 1;
  }
  return fit;
}

function generateEstimate(inputs, measure) {
  let sources = cleanSources(inputs.sources);
  const count = Math.min(30, Math.max(1, bound(inputs.count) || 10));
  if (!sources.length) return empty('generate');
  const notes = ['cache-depends', 'retries'];
  const chars = sourceChars(sources);
  let blocked;
  if (chars > MAX_SELECTED_CHARS) {
    const fitSources = Math.max(1, fitSelection(sources));
    blocked = { code: 'over-limit', chars, limit: MAX_SELECTED_CHARS, fitSources, totalSources: sources.length };
    sources = sources.slice(0, fitSources);
    notes.push('over-limit');
  }
  const kind = inputs.kind || 'quiz', lang = language(inputs.language);
  const measures = sampleMeasures(lang, measure);
  const request = { count, kind, difficulty: inputs.difficulty || 'mixed', language: inputs.language || '中文', focus: inputs.focus || '', constraints: inputs.constraints,
    role: inputs.role || '', ...(inputs.course !== undefined ? { course: inputs.course } : {}), ...(inputs.title ? { title: inputs.title } : {}) };
  // A passage supplement is one part however many questions it asks for (lib/contexts/generation/selection.js).
  const planned = inputs.singlePart ? [{ sources, kind, count }] : planGeneration({ sources, count, kind, kindCounts: inputs.kindCounts });
  const groups = [...new Set(planned.map((part) => part.sources))];
  if (groups.length > 1) notes.push('large-selection');
  if (isCjk(sources.map((source) => source.text).join('').slice(0, 4000)) || lang === 'zh' && isCjk(prose('zh', 100))) notes.push('cjk-higher');
  const bundle = (kindName) => measures.kinds[['quiz', 'multi'].includes(kindName) ? 'choice' : 'plain'];
  const targetsFor = (part, total) => Array.from({ length: total }, (_, index) => {
    const card = bundle(part.kind).card[index % bundle(part.kind).card.length];
    const source = part.sources[index % part.sources.length];
    return { ...targetOf(card), citations: [{ sourceId: source.id, quote: source.text.slice(0, 60) }] };
  });
  // The run sends the targets of the library that these materials could repeat, then the ones it plans itself (lib/batch.js).
  const scoped = new Map();
  const libraryOf = (chunk) => {
    if (!scoped.has(chunk)) scoped.set(chunk, scopeExisting(inputs.existing, chunk, { pinned: inputs.pinnedExisting }));
    return scoped.get(chunk);
  };
  const reserved = [];
  const calls = [];
  for (const chunk of groups) {
    const parts = planned.filter((part) => part.sources === chunk);
    const total = parts.reduce((sum, part) => sum + part.count, 0), kinds = new Set(parts.map((part) => part.kind));
    const { system, prompt } = planPrompts({ ...request, sources: chunk, count: total, kind: kinds.size === 1 ? parts[0].kind : 'mixed', existing: [...libraryOf(chunk), ...reserved] });
    const outputs = parts.map((part) => unit(bundle(part.kind).target, part.count)).reduce(add, zero());
    calls.push(call(measure, 'plan', { system, prompt, prefix: prompt.slice(0, prompt.indexOf('REQUEST DATA:')), output: add(outputs, { low: 20, high: 30 }) }));
    reserved.push(...parts.flatMap((part) => targetsFor(part, part.count).map((target) => target.objective)));
  }
  for (const part of planned) {
    const own = new Set(targetsFor(part, part.count).map((target) => target.objective));
    const others = [...libraryOf(part.sources), ...reserved.filter((objective) => !own.has(objective))];
    // The plan decides which pages a batch carries; each question is assumed to draw on one to two of them.
    const bySize = [...part.sources].sort((a, b) => a.text.length - b.text.length);
    const smallest = bySize.slice(0, Math.min(bySize.length, Math.max(1, Math.ceil(part.count / 2))));
    const largest = bySize.slice(Math.max(0, bySize.length - Math.min(bySize.length, part.count * 2)));
    const plan = { targets: targetsFor(part, part.count) };
    const deck = { title: 'Deck', cards: Array.from({ length: part.count }, (_, index) => bundle(part.kind).card[index % bundle(part.kind).card.length]) };
    const author = (used) => authorPrompts({ ...request, ...part, sources: used, assessmentPlan: plan, existing: others }, plan);
    const lowAuthor = author(smallest), highAuthor = author(largest);
    const marker = lowAuthor.prompt.indexOf('REQUEST DATA:');
    calls.push(call(measure, 'author', { system: lowAuthor.system, prompt: lowAuthor.prompt, promptHigh: highAuthor.prompt, prefix: lowAuthor.prompt.slice(0, marker),
      output: add(unit(bundle(part.kind).author, part.count), { low: 30, high: 40 }) }));
    const review = (used) => reviewPrompts({ sources: used, deck, kind: part.kind, count: part.count, structuralErrors: [], role: request.role, difficulty: request.difficulty, focus: request.focus, constraints: request.constraints });
    const lowReview = review(smallest), highReview = review(largest);
    calls.push(call(measure, 'review', { system: lowReview.system, prompt: lowReview.payload, promptHigh: highReview.payload,
      output: add(unit(bundle(part.kind).review, part.count), { low: 40, high: 60 }) }));
  }
  if (/high|max/i.test(String(inputs.reasoningEffort || ''))) notes.push('effort-high');
  return summarize('generate', calls, { notes, calls: { low: calls.length, high: calls.length + groups.length }, extra: blocked ? { blocked } : {} });
}

/* ---------- case papers ---------- */

function caseEstimate(inputs, measure) {
  const lang = language(inputs.language), measures = sampleMeasures(lang, measure);
  const imported = typeof inputs.scenario === 'string' && inputs.scenario.trim();
  const questions = imported ? (inputs.items || []).length : Math.max(1, bound(inputs.questions) || 2);
  const totalMarks = imported ? (inputs.items || []).reduce((sum, item) => sum + (Number(item?.marks) || 0), 0) : Math.max(4, bound(inputs.totalMarks) || 20);
  const sources = cleanSources(inputs.sources);
  const wordRange = scenarioLengthRange(inputs.language);
  const perUnit = wordRange.unit === 'words' ? 6 : 1;
  const scenarioLow = prose(lang, wordRange.min * perUnit), scenarioHigh = prose(lang, wordRange.max * perUnit);
  const scenarioOut = { low: measure.body(scenarioLow).low, high: measure.body(scenarioHigh).high };
  const questionOut = unit(measures.perMark, totalMarks);
  const calls = [];
  if (imported) {
    const { system, prompt } = caseCriteriaPrompt({ scenario: inputs.scenario, questions: inputs.items, sources, guidance: inputs.guidance || '', language: inputs.language });
    calls.push(call(measure, 'author', { system, prompt, prefix: prompt.slice(0, prompt.indexOf('DATA:')), output: add(questionOut, { low: 60, high: 90 }) }));
  } else {
    const { system, prompt } = caseAuthorPrompt({ language: inputs.language, questions, totalMarks, focusTopics: inputs.focusTopics || [], sources,
      styleText: inputs.styleText || '', guidance: inputs.guidance || '', focus: inputs.focus || '' });
    calls.push(call(measure, 'author', { system, prompt, prefix: prompt.slice(0, prompt.indexOf('REQUEST DATA:')), output: add(add(scenarioOut, questionOut), { low: 60, high: 90 }) }));
  }
  const paper = (text) => ({ title: 'Case', scenario: { title: 'Case', paragraphs: text.match(/[\s\S]{1,900}/g) || [] }, cues: measures.cues,
    questions: Array.from({ length: questions }, (_, index) => ({ id: `q${index + 1}`, prompt: 'question', marks: totalMarks / questions })) });
  const reviewLow = caseReviewPrompt({ ...paper(scenarioLow), questions: paper(scenarioLow).questions.map((question) => ({ ...question, ...unitQuestion(measures, totalMarks / questions) })) }, { styleText: inputs.styleText || '', language: inputs.language });
  const reviewHigh = caseReviewPrompt({ ...paper(scenarioHigh), questions: paper(scenarioHigh).questions.map((question) => ({ ...question, ...unitQuestion(measures, totalMarks / questions) })) }, { styleText: inputs.styleText || '', language: inputs.language });
  calls.push(call(measure, 'review', { system: reviewLow.system, prompt: reviewLow.prompt, promptHigh: reviewHigh.prompt, output: { low: 90, high: 160 } }));
  const notes = ['cache-depends', 'retries'];
  if (lang === 'zh') notes.push('cjk-higher');
  if (/high|max/i.test(String(inputs.reasoningEffort || ''))) notes.push('effort-high');
  return summarize('case', calls, { notes, calls: { low: calls.length, high: calls.length + 1 } });
}
/** Question fields at about the size of the sample's: prompt, criteria, answer, explanation, hint, misconception. */
function unitQuestion(measures, marks) {
  const sample = enSample.caseStudy.questions[0];
  const factor = Math.max(0.5, marks / sample.marks);
  const clip = (text) => String(text).repeat(Math.ceil(factor)).slice(0, Math.ceil(String(text).length * factor));
  return { prompt: sample.prompt, marks, criteria: sample.criteria, answer: clip(sample.answer), explanation: sample.explanation, hint: sample.hint, misconception: sample.misconception };
}

/** Marking one or more answered questions of a paper. */
function gradeEstimate(inputs, measure) {
  const lang = language(inputs.language), measures = sampleMeasures(lang, measure);
  const paper = inputs.paper;
  if (!paper?.questions?.length) return empty('grade');
  const answers = inputs.answers && typeof inputs.answers === 'object' ? inputs.answers : {};
  const answered = paper.questions.filter((question) => !isBlank(answers[question.cardId]));
  if (!answered.length) return empty('grade');
  const { system, prompt } = caseGradingPrompt({ title: paper.title, paragraphs: paper.paragraphs, cues: paper.cues, questions: paper.questions, answers,
    guidance: inputs.guidance || '', language: inputs.language });
  const criteria = answered.reduce((sum, question) => sum + (question.criteria?.length || 1), 0);
  const output = add(add(unit(measures.gradingCriterion, criteria), unit(measures.gradingWrapper, answered.length)), { low: 30, high: 60 });
  const notes = ['cache-depends', 'retries'];
  if (/high|max/i.test(String(inputs.reasoningEffort || ''))) notes.push('effort-high');
  return summarize('grade', [call(measure, 'grade', { system, prompt, output })], { notes, calls: { low: 1, high: 2 } });
}

/* ---------- 帮我想想 ---------- */

function suggestEstimate(inputs, measure) {
  if (typeof inputs.system !== 'string' || typeof inputs.prompt !== 'string') return empty('suggest');
  // The reply: 3 to 5 focuses of at most 40 characters, a count, a difficulty and one short sentence (all stated in the prompt).
  const lang = language(inputs.language);
  const low = measure.body(prose(lang, 3 * 14 + 80)), high = measure.body(prose(lang, 5 * 40 + 160));
  return summarize('suggest', [call(measure, 'suggest', { system: inputs.system, prompt: inputs.prompt, output: { low: low.low, high: high.high } })], { notes: ['cache-depends'] });
}

/* ---------- the outline of a document ---------- */

const OUTLINE_ENTRY_CHARS = 58; // {"title":"…","level":2,"startBlock":123}, with a title of 10 to 20 characters
function outlineEstimate(inputs, measure) {
  if (typeof inputs.system !== 'string' || typeof inputs.prompt !== 'string') return empty('outline');
  // The reply: a handful of entries for a short document, up to the 120 the prompt allows for a long one; titles may be Chinese.
  const units = bound(inputs.units) || 10, few = Math.min(units, 6);
  // Chapters only (mode 'chapters'): one entry per chapter, a fraction of the lines of a full outline.
  const most = inputs.mode === 'chapters' ? Math.min(60, Math.max(6, Math.ceil(units / 8))) : Math.min(120, Math.max(units, 6));
  const low = measure.body(prose('en', few * OUTLINE_ENTRY_CHARS)), high = measure.body(prose('zh', most * OUTLINE_ENTRY_CHARS));
  return summarize('outline', [call(measure, 'outline', { system: inputs.system, prompt: inputs.prompt, output: { low: low.low, high: high.high } })], { notes: ['cache-depends'] });
}

/* ---------- a lesson of a learning flow ---------- */

const LESSON_LENGTH = { lesson: [600, 2500], improve: [600, 2500], example: [400, 1800], steps: [400, 1800], prerequisite: [400, 1800], remedy: [180, 900] };
function flowEstimate(inputs, measure) {
  if (typeof inputs.system !== 'string' || !inputs.input) return empty('flow');
  const mode = LESSON_LENGTH[inputs.mode] ? inputs.mode : 'lesson', [min, max] = LESSON_LENGTH[mode];
  const out = { low: measure.body(prose('zh', min)).low + 40, high: measure.body(prose('zh', max)).high + 120 };
  const article = { markdown: prose('zh', max), citations: [] };
  const first = call(measure, 'article', { system: inputs.system, prompt: JSON.stringify({ ...inputs.input, repair: '' }), output: out });
  const review = call(measure, 'review', { system: inputs.reviewSystem || '', prompt: JSON.stringify({ ...inputs.input, candidate: { markdown: prose('zh', min), citations: [] } }),
    promptHigh: JSON.stringify({ ...inputs.input, candidate: article }), output: { low: 60, high: 160 } });
  return summarize('flow', [first, review], { notes: ['cache-depends', 'retries'], calls: { low: 2, high: 4 } });
}

/* ---------- the text steps of a recording ---------- */

const PROOF_WINDOW = 6000;
const TRANSLATE_WINDOW = 3500;
// Speech runs at about 120 to 170 English words (about 6 characters each, spaces included) or 180 to 280 Chinese characters a minute.
const CHARS_PER_MINUTE = { en: { low: 720, high: 1020 }, zh: { low: 180, high: 280 } };
// A translation is shorter than its source in Chinese characters and longer in English letters.
const TRANSLATION_RATIO = { en: { low: 0.45, high: 0.65 }, zh: { low: 2.2, high: 3 } };
function audioEstimate(inputs, measure) {
  const lang = inputs.language === 'zh' || inputs.language === 'en' ? inputs.language : language(inputs.language);
  const exact = bound(inputs.transcriptChars);
  const minutes = Number(inputs.minutes) > 0 ? Number(inputs.minutes) : 0;
  const chars = exact ? { low: exact, high: exact } : { low: Math.round(minutes * CHARS_PER_MINUTE[lang].low), high: Math.round(minutes * CHARS_PER_MINUTE[lang].high) };
  if (!chars.high) return empty('audio');
  const vocabulary = Array.from({ length: Math.min(100, bound(inputs.terms)) }, (_, index) => `term${index + 1}`);
  const subject = typeof inputs.subject === 'string' ? inputs.subject : '';
  const target = lang === 'zh' ? 'en' : 'zh', other = target;
  const windows = (size, window) => ({ low: Math.max(1, Math.ceil(size.low / window)), high: Math.max(1, Math.ceil(size.high / window)) });
  const proof = windows(chars, PROOF_WINDOW), translate = windows(chars, TRANSLATE_WINDOW);
  const calls = [];
  const windowCalls = (id, count, window, build) => {
    for (let index = 0; index < count.high; index++) {
      const highChars = Math.min(window, Math.max(0, chars.high - index * window)), lowChars = Math.min(window, Math.max(0, chars.low - index * window));
      const item = build(id, lowChars || highChars, highChars);
      // A window that only exists when the recording is at the long end of the range costs nothing at the short end.
      if (index >= count.low) { item.input.low = 0; item.output.low = 0; }
      calls.push(item);
    }
  };
  windowCalls('proofread', proof, PROOF_WINDOW, (id, lowChars, highChars) => call(measure, id, { system: PROOFREAD_SYSTEM,
    prompt: proofreadPrompt({ subject, vocabulary, known: [], text: prose(lang, lowChars) }),
    promptHigh: proofreadPrompt({ subject, vocabulary, known: [], text: prose(lang, highChars) }),
    prefix: '', output: { low: measure.body('{"corrections":[]}').low, high: measure.body(prose('zh', 4 * 160)).high } }));
  const translateSystem = target === 'en' ? TRANSLATE_TO_ENGLISH_SYSTEM : TRANSLATE_SYSTEM;
  windowCalls('translate', translate, TRANSLATE_WINDOW, (id, lowChars, highChars) => {
    const out = (size, ratio) => measure.body(prose(other, size * ratio) + prose('en', 120));
    return call(measure, id, { system: translateSystem, prompt: translatePrompt({ subject, vocabulary, previousTitles: [], paragraphs: [prose(lang, lowChars)] }),
      promptHigh: translatePrompt({ subject, vocabulary, previousTitles: [], paragraphs: [prose(lang, highChars)] }),
      output: { low: out(lowChars, TRANSLATION_RATIO[lang].low).low, high: out(highChars, TRANSLATION_RATIO[lang].high).high } });
  });
  calls.push(call(measure, 'title', { system: TITLE_SYSTEM, prompt: JSON.stringify({ filename: 'recording.m4a', parts: Array.from({ length: translate.high }, (_, index) => `Part ${index + 1}`) }), output: { low: 12, high: 30 } }));
  const notes = ['cache-depends', 'transcribe-separate', ...(exact ? [] : ['transcript-estimated']), ...(lang === 'zh' ? ['cjk-higher'] : [])];
  const result = summarize('audio', calls, { notes });
  result.calls = { low: proof.low + translate.low + 1, high: proof.high + translate.high + 1 };
  return result;
}

/* ---------- entry points ---------- */

const BUILDERS = { generate: generateEstimate, case: caseEstimate, grade: gradeEstimate, suggest: suggestEstimate, flow: flowEstimate, audio: audioEstimate, outline: outlineEstimate };

/** What a job keeps of its estimate for the comparison with what it used: the totals, not the stages. */
export const compactEstimate = (estimate) => ({ feature: estimate.feature, inputTokens: estimate.inputTokens, outputTokens: estimate.outputTokens,
  totalTokens: estimate.totalTokens, calls: estimate.calls });

/**
 * Estimate one run. `feature`: 'generate' | 'case' | 'grade' | 'suggest' | 'flow' | 'audio' | 'outline'; `inputs` as each builder above reads them.
 * @param services `{ measure }` from {@link createTextMeasure}; defaults to DSH's mirrored heuristic.
 * @returns `{ feature, uncachedInputTokens, cacheReadTokens, outputTokens, inputTokens, totalTokens, calls, stages, notes, blocked? }`;
 *   every figure is `{ low, high }`; an unknown feature or nothing to send is an empty estimate.
 */
export function estimateRun(feature, inputs = {}, { measure = createTextMeasure() } = {}) {
  const build = BUILDERS[feature];
  if (!build) return empty(String(feature));
  try { return build(inputs || {}, measure); } catch { return empty(feature); }
}

const asList = (value, name) => { if (!Array.isArray(value)) throw new Error(`${name} must be a list`); return value; };
/**
 * Resolve an estimate request against the library, as the matching action would, and estimate it.
 * @param args what the form knows: `sourceIds`, `count`, `kind`, `language`, ... (see each feature)
 * @param services `{ tokenMeter }` (`ctx.tokenMeter`) and `language` of the application.
 */
export function estimateFromState(feature, args = {}, state, services = {}) {
  const measure = createTextMeasure({ tokenMeter: services.tokenMeter });
  const ids = (name) => new Set(asList(args[name], name).filter((item) => typeof item === 'string').slice(0, 500));
  const chosen = (name = 'sourceIds') => { const wanted = ids(name); return (state.sources || []).filter((source) => wanted.has(source.id)); };
  if (feature === 'generate' && args.resumeDraftId !== undefined) {
    // Topping up a short draft: only the missing questions, from the materials it was made from, as the generate action does.
    const draft = (state.drafts || []).find((item) => item.id === args.resumeDraftId);
    if (!draft) throw new Error('Draft not found');
    const generation = draft.editorial?.generation || {}, count = missingQuestions(draft);
    if (!count || !Array.isArray(generation.sourceIds)) return empty('generate');
    const wanted = new Set(generation.sourceIds), sources = (state.sources || []).filter((source) => wanted.has(source.id));
    const targetId = draft.mergeTargetId ?? generation.mergeTargetId, target = targetId !== undefined ? (state.decks || []).find((deck) => deck.id === targetId) : null;
    const own = [...(target?.cards || []), ...draft.cards].map((card) => card.objective);
    const existing = target ? own : [...(state.decks || []), ...(state.drafts || [])].flatMap((deck) => (deck.cards || []).map((card) => card.objective));
    return estimateRun('generate', { sources, count, kind: generation.kind, kindCounts: continuationKindCounts(draft), difficulty: generation.difficulty, language: generation.language,
      focus: generation.focus, role: generation.role, constraints: generation.constraints, course: draft.course ?? generation.course, title: draft.title,
      existing, pinnedExisting: own, reasoningEffort: args.reasoningEffort }, { measure });
  }
  if (feature === 'generate') {
    const sources = chosen();
    const existing = [...(state.decks || []), ...(state.drafts || [])].flatMap((deck) => (deck.cards || []).map((card) => card.objective));
    return estimateRun('generate', { sources, count: args.count, kind: args.kind, difficulty: args.difficulty, language: args.language, focus: args.focus, role: args.role,
      course: args.course, title: args.title, constraints: args.constraints, existing, reasoningEffort: args.reasoningEffort }, { measure });
  }
  if (feature === 'selection') {
    // Questions written from one selected passage into an existing deck: one plan, one write, one review of the whole set.
    const selection = args.selection;
    if (!selection || typeof selection.quote !== 'string' || typeof selection.sourceId !== 'string') throw new Error('usage.estimate needs a selection for the selection feature');
    const source = (state.sources || []).find((item) => item.id === selection.sourceId);
    if (!source) throw new Error('Selection source is unavailable');
    const deck = (state.decks || []).find((item) => item.id === args.deckId);
    const own = (deck?.cards || []).map((card) => card.objective).filter(Boolean);
    return estimateRun('generate', { sources: [{ id: source.id, title: source.title, text: selectionEvidenceText(source.text, selection) }],
      count: Math.min(20, Math.max(1, bound(args.count) || 1)), kind: args.kind || 'flashcard', language: args.language,
      focus: `Selected passage: ${selection.quote}`, existing: own, pinnedExisting: own, singlePart: true, reasoningEffort: args.reasoningEffort }, { measure });
  }
  if (feature === 'case') {
    const profile = courseProfileFromState(state, args.course || '');
    const request = { ...args, sourceIds: args.sourceIds };
    const prepared = caseGenerationArgs({ ...request, kind: 'case' }, { profile });
    const guidance = boundedGuidance((state.sources || []).filter((source) => prepared.guidanceSourceIds.includes(source.id)));
    return estimateRun('case', { language: args.language, ...prepared, guidance, sources: chosen(), reasoningEffort: args.reasoningEffort }, { measure });
  }
  if (feature === 'grade') {
    const input = rubricInput(state, { deckId: args.deckId, cardId: args.cardId }, { guidanceSourceIds: courseProfileFromState(state, args.course || '').guidanceSourceIds });
    const answer = typeof args.answer === 'string' ? args.answer : 'x'.repeat(Math.max(1, bound(args.answerChars) || suggestedWords(input.card.marks, input.language).max));
    return estimateRun('grade', { language: input.language, paper: input.paper, guidance: input.guidance, answers: { [input.card.id]: answer }, reasoningEffort: args.reasoningEffort }, { measure });
  }
  if (feature === 'suggest') {
    const sources = chosen(), outlines = sourceOutlines(sources), course = typeof args.course === 'string' ? args.course : undefined;
    const weakTopics = weakTopicsFor(state, course), profile = courseProfileFromState(state, course || '');
    const { system, prompt } = buildSuggestPrompt(suggestionSignals({ course, profile: profile.courseId ? profile : null, outlines, weakTopics,
      goal: SUGGEST_GOALS.includes(args.goal) ? args.goal : undefined }), { language: services.language });
    return estimateRun('suggest', { system, prompt, language: args.language }, { measure });
  }
  if (feature === 'audio') return estimateRun('audio', { minutes: args.minutes, transcriptChars: args.transcriptChars, language: args.language, subject: args.subject, terms: args.terms }, { measure });
  return empty(String(feature));
}

export { SUGGEST_LIMITS };
