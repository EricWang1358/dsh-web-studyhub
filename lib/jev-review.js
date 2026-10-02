import { noul } from './jev.js';
import { replaceWithJev } from './jev-decide.js';
import { jevFallbackMessage } from './jev-messages.js';

/* EXPERIMENTAL. 独立复审 with Jev as an OPTIONAL REPLACEMENT (site `cardReview`, lib/jev-sites.js).

   Today one model call reviews a candidate deck and returns, per card, pass/fail on six dimensions (lib/assessment-quality.js
   QUALITY_CRITERIA, REVIEW_SHAPE) plus a few free-text findings. A card with any failed dimension is dropped; the rest are kept.
   When the learner switches this site on, each card instead gets one tiny typed request: the six dimensions as yes/no questions
   (`noul`, "yes" is the good answer). The line is the learner's confidence setting (default 80%):

     every dimension that applies is at least that sure to pass   -> accepted by Jev
     one dimension is at least that sure to FAIL                  -> rejected by Jev
     anything else (a middling answer, a card Jev cannot judge)    -> that card goes to the unchanged model review

   The cards the model reviews are sent in ONE call (the same prompt builder, a deck of just those cards); when Jev is off, down or
   unsure about every card, that call is exactly the review a run without Jev makes. The verdicts are applied exactly like the model's
   (a rejected card is dropped with its reason), only because the learner switched the site on, and the draft records who decided
   what (`editorial.jevDecided`), so nothing is ever passed off as the model's review.

   What Jev cannot do is write the review's free text: the findings it contributes are built from its own numbers ("answerLeak
   failed, Jev 97% sure"), never from the card. Multi-answer cards, cards without evidence or an explanation, and anything else the
   six questions do not fit are not sent at all. */

const clip = (text, max) => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const round = value => Math.round(value * 1e4) / 1e4;
const evidenceOf = card => (card.citations || []).map(ref => clip(ref?.quote, 600)).filter(Boolean).slice(0, 2);
const HAS_OPTIONS = card => card.kind === 'quiz' && Array.isArray(card.options) && card.options.length >= 2;

/** The six dimensions: `yes` is the good answer. `applies` says which cards the question makes sense for. */
export const REVIEW_CHECKS = Object.freeze([
  { id: 'selfContained', applies: () => true,
    instructions: 'Can this question be understood and answered without any slide, diagram, earlier card or teacher commentary that is not shown with it (is everything needed to understand what is being asked in the question itself)?',
    criteria: { true: 'It stands on its own.', false: 'It depends on material the learner is not shown.' },
    text: { en: 'the question depends on context that is not shown', zh: '题目依赖没有给出的上下文' } },
  { id: 'answerLeak', applies: () => true,
    instructions: 'Do the question text and the hint avoid stating the requested answer, and avoid letting someone earn full credit just by paraphrasing the question?',
    criteria: { true: 'The wording does not give the answer away.', false: 'The wording states or strongly implies the answer.' },
    text: { en: 'the question or hint gives the answer away', zh: '题干或提示泄露了答案' } },
  { id: 'optionQuality', applies: HAS_OPTIONS,
    instructions: 'Do all options answer the same question on the same comparison axis with comparable detail, with exactly one defensible correct option and every other option a believable but clearly wrong near-miss?',
    criteria: { true: 'Exactly one option is defensible and the distractors are believable near-misses.', false: 'Zero or several options are defensible, or a distractor is absurd or gives itself away.' },
    text: { en: 'the options are not comparable or more than one is defensible', zh: '选项不可比或不止一个说得通' } },
  { id: 'learningValue', applies: () => true,
    instructions: 'Is this one useful, gradable learning target, rather than trivia about slide layout, a circular definition, or an overloaded multi-part question?',
    criteria: { true: 'One useful, gradable target.', false: 'Trivia, circular, or several targets at once.' },
    text: { en: 'the question is not a single useful, gradable target', zh: '题目不是单一、有用、可评分的目标' } },
  { id: 'sourceSupport', applies: card => evidenceOf(card).length > 0,
    instructions: 'Is the stated answer directly supported by the evidence quote(s) given with the question?',
    criteria: { true: 'The evidence states or clearly implies the answer.', false: 'The evidence does not support the stated answer.' },
    text: { en: 'the answer is not supported by the cited evidence', zh: '答案没有被引用的原文支持' } },
  { id: 'explanationQuality', applies: card => clip(card.explanation, 1).length > 0,
    instructions: 'Does the explanation actually teach why the answer is right (the decisive condition or derivation and a reusable distinction), rather than restating the answer or just saying it is correct?',
    criteria: { true: 'It teaches the reasoning.', false: 'It restates the answer or skips the decisive steps.' },
    text: { en: 'the explanation does not teach the reasoning', zh: '解析没有讲清推理' } },
]);

const kindFits = card => card && typeof card === 'object' && ['flashcard', 'quiz', 'cloze', 'open'].includes(card.kind);

/**
 * The typed request for one card, or null when Jev cannot judge it (a multi-answer card, a card with no prompt, evidence or
 * explanation, a quiz without options): such a card goes to the model review.
 */
export function buildReviewRequest(card) {
  if (!kindFits(card) || !clip(card.prompt, 1) || !evidenceOf(card).length || !clip(card.explanation, 1)) return null;
  if (card.kind === 'quiz' && !HAS_OPTIONS(card)) return null;
  const ids = REVIEW_CHECKS.filter(check => check.applies(card));
  const state = { question: clip(card.prompt, 1500), kind: card.kind, ...(clip(card.hint, 1) ? { hint: clip(card.hint, 400) } : {}),
    ...(HAS_OPTIONS(card) ? { options: card.options.map(option => ({ text: clip(option.text, 400), correct: option.correct === true })) } : {}),
    answer: clip(card.answer, 800), explanation: clip(card.explanation, 1500), evidence: evidenceOf(card) };
  return { state, questions: Object.fromEntries(ids.map(check => [check.id, noul(check.instructions, check.criteria)])) };
}

/**
 * Read the answers for one card against the learner's `threshold`: { value: { verdict, failed, checks }, confidence } (the shape
 * lib/jev-decide.js wants), or null when an answer is missing. `confidence` is how sure Jev is of the verdict (0 for "unsure", so the
 * card goes to the model).
 */
export function readReview(card, answers, { threshold = 0.8 } = {}) {
  const asked = REVIEW_CHECKS.filter(check => check.applies(card)), checks = {}, failed = [];
  let weakestPass = 1, strongestFail = 0, unsure = false;
  for (const check of asked) {
    const p = answers?.[check.id]?.noul;
    if (typeof p !== 'number') return null;
    const pass = round(p), fail = round(1 - p);
    checks[check.id] = { p: pass, state: fail >= threshold ? 'fail' : pass >= threshold ? 'pass' : 'unsure' };
    if (fail >= threshold) { failed.push(check.id); strongestFail = Math.max(strongestFail, fail); }
    else if (pass >= threshold) weakestPass = Math.min(weakestPass, pass);
    else unsure = true;
  }
  if (failed.length) return { value: { verdict: 'reject', failed, checks }, confidence: round(strongestFail) };
  if (unsure) return { value: { verdict: 'unsure', failed, checks }, confidence: 0 };
  return { value: { verdict: 'accept', failed, checks }, confidence: round(weakestPass) };
}

const pct = value => `${Math.round(value * 100)}%`;
// The words that stay with the draft (findings, issues, summary) never name Jev: a learner who hides experimental features sees a draft that reads like
// any other, while editorial.jevDecided and the "由 Jev 判定" marks (shown only with the features) say who decided what.
const RAW = { zh: { head: '实验性判定', accept: '通过', reject: '不通过' }, en: { head: 'Decided by the experimental reviewer', accept: 'passed', reject: 'failed' } };

/**
 * The model-review entry a Jev verdict stands for: { check, issues } in the shape REVIEW_SHAPE and `reviewIssues` read. The finding is
 * built from Jev's numbers only (never from the card's text); a rejected card's issues name the card, like the model's do.
 */
export function critiqueFor(card, value, language = 'zh') {
  const say = RAW[language === 'en' ? 'en' : 'zh'], english = language === 'en';
  const check = { cardId: card.id };
  for (const spec of REVIEW_CHECKS) {
    if (!spec.applies(card)) { check[spec.id] = spec.id === 'optionQuality' ? 'na' : 'pass'; continue; }
    // A dimension counts as passed only when Jev was sure; on a rejected card the others are "failed or not checked", like the model's.
    check[spec.id] = value.checks[spec.id]?.state === 'pass' ? 'pass' : 'fail';
  }
  const numbers = REVIEW_CHECKS.filter(spec => spec.applies(card)).map(spec => `${spec.id} ${pct(value.checks[spec.id]?.p ?? 0)}`).join(', ');
  check.explanation = value.verdict === 'accept'
    ? `${say.head}: ${english ? 'every check passed' : '各项检查都通过'} (${numbers}).`
    : `${say.head}: ${english ? 'failed' : '不通过'} ${value.failed.join(', ')} (${numbers}).`;
  const issues = value.verdict === 'reject' ? value.failed.map(id => {
    const spec = REVIEW_CHECKS.find(item => item.id === id);
    return `${card.id}: ${id} failed (experimental reviewer, ${pct(1 - (value.checks[id]?.p ?? 0))} sure): ${spec.text[english ? 'en' : 'zh']}`;
  }) : [];
  return { check, issues };
}

/** Plain sentence for the summary of a review that Jev took part in. */
const summaryLine = (meta, language) => {
  if (language === 'en') return meta.model
    ? `An experimental reviewer judged ${meta.judged} of ${meta.judged + meta.model} cards (${meta.accepted} accepted, ${meta.rejected} rejected); the independent model review judged the other ${meta.model}.`
    : `An experimental reviewer judged all ${meta.judged} cards (${meta.accepted} accepted, ${meta.rejected} rejected); the independent model review was not needed.`;
  return meta.model
    ? `实验性判定服务判定了 ${meta.judged}/${meta.judged + meta.model} 道题（通过 ${meta.accepted}，不通过 ${meta.rejected}），其余 ${meta.model} 道由独立模型复审。`
    : `实验性判定服务判定了全部 ${meta.judged} 道题（通过 ${meta.accepted}，不通过 ${meta.rejected}），没有调用独立模型复审。`;
};

/**
 * One `jevDecided` for a whole generation run, from the ones of its parts (lib/batch.js): the counts add up, the cards are the ones that
 * stay in the draft (`keep(id)`), and the fallback is ONE notice for the run (the reason of the first part that had one, the counts of all).
 */
export function mergeJevDecided(parts, keep = () => true) {
  const metas = parts.filter(Boolean);
  if (!metas.length) return undefined;
  const sum = key => metas.reduce((total, meta) => total + (meta[key] || 0), 0);
  const first = metas.find(meta => meta.fallback)?.fallback, count = metas.reduce((total, meta) => total + (meta.fallback?.count || 0), 0);
  const head = metas[0];
  return { version: 1, site: 'cardReview', threshold: head.threshold, language: head.language, provider: head.provider,
    judged: sum('judged'), model: sum('model'), accepted: sum('accepted'), rejected: sum('rejected'),
    cards: Object.fromEntries(metas.flatMap(meta => Object.entries(meta.cards || {})).filter(([id]) => keep(id))),
    fallback: first ? { reason: first.reason, count, message: jevFallbackMessage(first.reason, { count, threshold: head.threshold, language: head.language, provider: head.provider }) } : null };
}

/**
 * The hook lib/generation.js hands the review to (`request.jevReview`): `jevReview({ deck, review })` resolves the critique the model
 * review would have returned (issues, summary, one check per card), plus `jevDecided` (who decided what). `review(subDeck)` is the
 * unchanged model review. Never throws for anything Jev, the network or the settings can do; a failing model review rejects as before.
 */
export function createReviewHook({ runtime, threshold = 0.8, language = 'zh', concurrency = 4 }) {
  return async function jevReview({ deck, review, signal }) {
    let model = null;
    const { results, summary } = await replaceWithJev({
      runtime, site: 'cardReview', items: deck.cards, threshold, language, signal, concurrency,
      build: card => buildReviewRequest(card),
      read: (answers, card) => readReview(card, answers, { threshold }),
      fallback: async cards => {
        model = await review({ ...deck, cards });
        return cards.map(card => (Array.isArray(model?.checks) ? model.checks.find(check => check?.cardId === card.id) : undefined));
      },
    });
    const decided = results.filter(entry => entry.by === 'jev');
    const jevIssues = [], checks = [], marks = {};
    let accepted = 0, rejected = 0;
    for (const entry of results) {
      if (entry.by === 'model') { if (entry.value) checks.push(entry.value); continue; }
      const { check, issues } = critiqueFor(entry.item, entry.value, language);
      checks.push(check); jevIssues.push(...issues);
      if (entry.value.verdict === 'reject') rejected++; else accepted++;
      marks[entry.item.id] = { verdict: entry.value.verdict, confidence: entry.confidence };
    }
    const { provider } = await runtime.gate('cardReview');
    const meta = { version: 1, site: 'cardReview', threshold, language: language === 'en' ? 'en' : 'zh', provider, judged: decided.length, model: results.length - decided.length, accepted, rejected,
      cards: Object.fromEntries(Object.entries(marks).filter(([, mark]) => mark.verdict === 'accept')), fallback: summary.fallback,
      ...(decided.length ? { usage: summary.usage } : {}) };
    if (!decided.length && model) return { ...model, jevDecided: meta };
    const modelSummary = String(model?.summary ?? '').trim();
    return { ...(model ?? {}), issues: [...jevIssues, ...(Array.isArray(model?.issues) ? model.issues : [])], checks,
      summary: [modelSummary, decided.length ? summaryLine(meta, language) : ''].filter(Boolean).join(' '), jevDecided: meta };
  };
}
