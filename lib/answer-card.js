/* 分析题答案卡 (复习全书 M5, docs/plans/review-book.md): the answer of a case / analysis question (大题) as ONE structured, checked card, never a
   short version. Pure, no Node modules: the job (lib/contexts/generation/answer-card), the study state (solution), the book and the page share it.

   card.answerCard (v1) = {
     v: 1, language: 'zh' | 'en', questionType: { id, label },
     signals:  [{ word, quote, verified, reason?, in?, at? }]      the words of the stem that name the type, each with the stem's own words around it
     facts:    [{ text, quote, verified, reason?, in?, at? }]      题干事实, each with its quote from the stem (in: 'prompt' | 'case')
     concepts: [{ name, quote, verified, reason?, where?: { sourceId, title }, at? }]   the definition as the material's own slice when it is found
     assumptions: [text], steps: [text], conclusion, justification: { goal, cost, failure, verify }, pitfalls: [text],
     marksMap: [{ point, criterionId, label, marks, sentence, found }],   评分点对照: one row per key point, the sentence of the card that earns it
     checks: { quotes: { total, verified }, coverage: { total, covered, missing }, inventedNumbers: [..], missing: [justification parts left empty],
               review: { ran, issues: [{ kind, where, text }], repaired } },
     status: 'verified' | 'partial', renderedDigest, basis }
   `at` ({ start, end } in the text it was found in) is derived position metadata, like a citation's: the fingerprint of the review leaves it out.
   The card's `answer` is never changed for an existing card (that would reset SM-2 and invalidate digests); the card is shown first at the reveal.
   被改过 (`edited`) is read, never stored: the question, its marks or its rubric changed since the card was made (`basis`), or the card itself no
   longer renders to what was checked (`renderedDigest`). 已核对 means the program's checks and the independent review passed, never that the answer is right. */
import { createLocator, MIN_KEY } from './quote-locate.js';
import { keyPointId } from './case-study.js';

export const ANSWER_CARD_VERSION = 1;
export const ANSWER_CARD_LIMITS = Object.freeze({ signals: 4, facts: 8, concepts: 6, assumptions: 5, steps: 10, pitfalls: 5, marks: 20, text: 400, step: 700, quote: 500 });
export const REVIEW_KINDS = Object.freeze(['unsupported', 'contradictsStem', 'missingCost', 'inventedNumber']);
const JUSTIFICATION = Object.freeze(['goal', 'cost', 'failure', 'verify']);

const clip = (value, max) => (typeof value === 'string' ? value.replace(/\r\n?/g, '\n').trim().slice(0, max) : '');
const line = (value, max) => clip(value, max).replace(/\s+/g, ' ');
const list = value => (Array.isArray(value) ? value : []);
const wsKey = value => String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();

/* ---------- digests (FNV-1a over UTF-16 units: change detectors, not tokens) ---------- */

const canonical = value => (Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value);
export function textDigest(text) {
  const value = String(text ?? '');
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < value.length; i++) { hash ^= BigInt(value.charCodeAt(i)); hash = BigInt.asUintN(64, hash * 0x100000001b3n); }
  return `${value.length}:${hash.toString(16).padStart(16, '0')}`;
}
/** What the card was made for: the question, its reference answer, its marks and its rubric. Any change of them reads as 被改过. */
export const answerCardBasis = card => textDigest(JSON.stringify(canonical([card?.kind, card?.prompt, card?.answer, card?.marks ?? null, card?.rubric ?? null, card?.rubricCriteria ?? null])));

/* ---------- reading the model's card ---------- */

/** The model's card as plain data, every field cut to size (nothing checked yet). `types`: the catalogue (lib/case-types.js). */
export function normalizeAnswerCard(raw, { types = [], language = 'zh' } = {}) {
  const L = ANSWER_CARD_LIMITS, source = raw && typeof raw === 'object' ? raw : {};
  const typeId = line(typeof source.questionType === 'string' ? source.questionType : source.questionType?.id, 40);
  const type = types.find(item => item.id === typeId) || types.find(item => item.id === 'general') || { id: 'general', label: '' };
  const label = typeof type.label === 'string' ? type.label : (language === 'en' ? type.label?.en : type.label?.zh) || type.id;
  const justification = Object.fromEntries(JUSTIFICATION.map(key => [key, clip(source.justification?.[key], L.step)]));
  return {
    v: ANSWER_CARD_VERSION, language: language === 'en' ? 'en' : 'zh', questionType: { id: type.id, label },
    signals: list(source.signals).map(item => ({ word: line(item?.word, 60), quote: line(item?.quote, L.quote) })).filter(item => item.word && item.quote).slice(0, L.signals),
    facts: list(source.facts).map(item => ({ text: line(item?.text, L.text), quote: line(item?.quote, L.quote) })).filter(item => item.text || item.quote).slice(0, L.facts),
    concepts: list(source.concepts).map(item => ({ name: line(item?.name, 80), ref: line(item?.ref, 12), quote: line(item?.definition ?? item?.quote, L.quote) }))
      .filter(item => item.name && item.quote).slice(0, L.concepts),
    assumptions: list(source.assumptions).map(item => line(item, L.text)).filter(Boolean).slice(0, L.assumptions),
    steps: list(source.steps).map(item => clip(item, L.step).replace(/^\s*(?:\d+[.)、]|[-*])\s+/, '')).filter(Boolean).slice(0, L.steps),
    conclusion: clip(source.conclusion, L.step), justification,
    pitfalls: list(source.pitfalls).map(item => line(item, L.text)).filter(Boolean).slice(0, L.pitfalls),
    marksMap: list(source.marks ?? source.marksMap).map(item => ({ point: line(item?.point, 40), sentence: line(item?.sentence, L.step) })).filter(item => item.point).slice(0, L.marks),
  };
}

/* ---------- quotes, word for word ---------- */

const ELLIPSIS = /…|⋯|\.{3}|(?:\.\s){2,}\./u;
const HTML = /<\/?(?:table|thead|tbody|tr|td|th|div|span|p|br|img|sup|sub|a|b|i|em|strong|ul|ol|li|h[1-6]|font|center)\b[^>]*>|&(?:[a-z]+|#\d+|#x[0-9a-f]+);/i;
const keyLength = text => [...String(text ?? '').normalize('NFKC')].filter(char => /[\p{L}\p{N}\p{M}]/u.test(char)).length;
/** Does a text hold HTML (tags or entities)? Quotes in it cannot be checked word for word: they stay 未核实. */
export const holdsHtml = text => HTML.test(String(text ?? ''));

/**
 * Where a quote stands in some texts ([{ id, text, title? }], in order of preference): { verified, reason?, in?, quote, at? }. A found quote is replaced by
 * the text's own slice (so what the card shows is the material's words). Never found: an elided quote (…), one of fewer than MIN_KEY letters and digits,
 * one whose text holds HTML, one in no text. Reasons: 'ellipsis' | 'short' | 'html' | 'missing'.
 */
export function locateIn(texts, quote) {
  const wanted = String(quote ?? '').trim();
  if (ELLIPSIS.test(wanted)) return { verified: false, reason: 'ellipsis', quote: wanted };
  if (keyLength(wanted) < MIN_KEY) return { verified: false, reason: 'short', quote: wanted };
  let html = false;
  for (const item of texts) {
    if (!item || typeof item.text !== 'string' || !item.text) continue;
    if (holdsHtml(item.text)) { html = true; continue; }
    const found = createLocator(item.text)(wanted);
    if (found) return { verified: true, in: item.id, quote: item.text.slice(found.start, found.end), at: { start: found.start, end: found.end } };
  }
  return { verified: false, reason: html ? 'html' : 'missing', quote: wanted };
}
const kept = (item, check) => ({ ...item, quote: check.quote, verified: check.verified, ...(check.reason ? { reason: check.reason } : {}),
  ...(check.in ? { in: check.in } : {}), ...(check.at ? { at: check.at } : {}) });

/**
 * The quotes of a card checked: signals and facts in the stem (`stem`: [{ id: 'prompt', text }, { id: 'case', text }]), concepts in the materials
 * (`materials`: [{ id, ref, title, text }]; the material the model named first, then the others). A signal's word must stand inside its quote.
 */
export function verifyQuotes(card, { stem = [], materials = [] } = {}) {
  const signals = card.signals.map(item => {
    const check = locateIn(stem, item.quote);
    return kept(item, check.verified && !wsKey(check.quote).includes(wsKey(item.word)) ? { ...check, verified: false, reason: 'missing', at: undefined, in: undefined } : check);
  });
  const facts = card.facts.map(item => kept(item, locateIn(stem, item.quote)));
  const concepts = card.concepts.map(({ ref, ...item }) => {
    const ordered = [...materials.filter(part => part.ref === ref), ...materials.filter(part => part.ref !== ref)];
    const check = locateIn(ordered, item.quote), part = check.verified ? materials.find(candidate => candidate.id === check.in) : null;
    const { in: _in, ...rest } = kept(item, check);
    return { ...rest, ...(part ? { where: { sourceId: part.id, title: part.title || '' } } : {}) };
  });
  return { ...card, signals, facts, concepts };
}

/* ---------- numbers that come from nowhere ---------- */

const NUMBER = /(?<![\p{L}\d.])(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?\s*(%)?/gu;
const valuesOf = text => [...String(text ?? '').matchAll(NUMBER)].map(match => ({ raw: match[0].trim(), value: Number(`${match[1].replace(/,/g, '')}${match[2] ? `.${match[2]}` : ''}`),
  percent: !!match[3], index: match.index }));
const near = (a, b) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));

/** Is the number at `index` of a line a computed result: right after =, ≈ or →, with a calculation (a digit) between that sign and the one before it? */
function isResult(text, index) {
  const head = text.slice(0, index), sign = /[=≈→]\s*$/.exec(head);
  if (!sign) return false;
  const before = head.slice(0, sign.index);
  return /\d/.test(before.slice(Math.max(before.lastIndexOf('='), before.lastIndexOf('≈'), before.lastIndexOf('→')) + 1));
}

/**
 * The numbers of the steps, the conclusion and the justification that stand in none of `allowed` (the stem, the facts, the assumptions, the concepts, the
 * type's formulas) and are not a computed result ("1000 / (1000 + 2) = 0.998": the 0.998, which later steps may use; "MTBF = 5000" is no result).
 * 0, 1 and 100 are free; a percentage matches its fraction. -> [raw numbers], in order, once each.
 */
export function inventedNumbers(card, allowedTexts = []) {
  const allowed = [0, 1, 100];
  const allow = value => { allowed.push(value, value / 100, value * 100); };
  for (const text of allowedTexts) for (const number of valuesOf(text)) allow(number.value);
  const invented = [];
  const parts = [...card.steps, card.conclusion, ...JUSTIFICATION.map(key => card.justification?.[key] || '')];
  for (const text of parts.flatMap(part => String(part ?? '').split('\n'))) {
    for (const number of valuesOf(text)) {
      if (isResult(text, number.index)) { allow(number.value); continue; }
      if (!allowed.some(value => near(value, number.value)) && !invented.includes(number.raw)) invented.push(number.raw);
    }
  }
  return invented;
}

/* ---------- the rubric, covered by sentences of the card ---------- */

/** The key points of a rubric: [{ point, criterionId, label, marks, text }] (a criterion without key points is one point). */
export function rubricPoints(criteria = []) {
  return list(criteria).flatMap(criterion => {
    const points = list(criterion?.keyPoints).filter(Boolean);
    if (!points.length) return [{ point: criterion.id, criterionId: criterion.id, label: criterion.label, marks: Number(criterion.marks) || 0, text: criterion.descriptor || criterion.label }];
    return points.map((text, at) => ({ point: keyPointId(criterion.id, at), criterionId: criterion.id, label: criterion.label, marks: (Number(criterion.marks) || 0) / points.length, text }));
  });
}
const ownText = card => [...card.facts.map(item => item.text), ...card.assumptions, ...card.steps, card.conclusion, ...JUSTIFICATION.map(key => card.justification?.[key] || '')].join('\n');

/**
 * The marks map of a card: one row per key point of the rubric, in rubric order ({ point, criterionId, label, marks, sentence, found }), the sentence the
 * model named for it (the first one per point); `found`: that sentence really is in the card. Coverage counts the found ones, computed here, never by the model.
 */
export function rubricCoverage(card, criteria = []) {
  const points = rubricPoints(criteria), body = wsKey(ownText(card));
  const marksMap = points.map(point => {
    const sentence = card.marksMap.find(item => item.point === point.point && item.sentence)?.sentence || '';
    const found = !!sentence && keyLength(sentence) >= MIN_KEY && body.includes(wsKey(sentence));
    return { point: point.point, criterionId: point.criterionId, label: line(point.label, 80), marks: Math.round(point.marks * 100) / 100, sentence, found };
  });
  return { marksMap, coverage: { total: points.length, covered: marksMap.filter(item => item.found).length, missing: marksMap.filter(item => !item.found).map(item => item.point) } };
}

/* ---------- the independent review ---------- */

/** The reviewer's reply, trusted only in its shape: [{ kind, where, text }] of the four kinds, at most 8. */
export function normalizeCardReview(raw) {
  return list(raw?.issues).filter(item => item && REVIEW_KINDS.includes(item.kind) && line(item.text, 300))
    .map(item => ({ kind: item.kind, where: line(item.where, 60), text: line(item.text, 300) })).slice(0, 8);
}

/* ---------- checks and status ---------- */

/**
 * Every check of the program on a card: quotes found, rubric covered, invented numbers, the justification's parts written. `context`: { stem, materials,
 * criteria, numbers (the type's formulas and anything else that may carry a number) }. -> the card with marksMap set and its `checks` (review: not yet).
 */
export function checkAnswerCard(card, { stem = [], materials = [], criteria = [], numbers = [] } = {}) {
  const verified = verifyQuotes(card, { stem, materials });
  const { marksMap, coverage } = rubricCoverage(verified, criteria);
  const quotes = [...verified.signals, ...verified.facts, ...verified.concepts];
  const allowed = [...stem.map(item => item.text), ...verified.facts.flatMap(item => [item.text, item.quote]), ...verified.assumptions,
    ...verified.concepts.flatMap(item => [item.name, item.quote]), ...numbers];
  return { ...verified, marksMap, checks: { quotes: { total: quotes.length, verified: quotes.filter(item => item.verified).length }, coverage,
    inventedNumbers: inventedNumbers(verified, allowed), missing: JUSTIFICATION.filter(key => !verified.justification[key]),
    review: { ran: false, issues: [], repaired: false } } };
}

/** What still needs fixing, as short lines for a repair call (empty: nothing). */
export function cardProblems(card) {
  const { checks } = card, problems = [];
  for (const [field, items] of [['signals', card.signals], ['facts', card.facts], ['concepts', card.concepts]])
    items.forEach((item, at) => { if (!item.verified) problems.push(`${field}[${at}]: the quote is not word for word in the ${field === 'concepts' ? 'materials' : 'stem or the case'} (${item.reason})`); });
  if (checks.coverage.missing.length) problems.push(`marks: no sentence of the card earns ${checks.coverage.missing.join(', ')}`);
  if (checks.inventedNumbers.length) problems.push(`numbers not in the stem, the facts, the assumptions or the concepts: ${checks.inventedNumbers.join(', ')} (state them as assumptions or leave them out)`);
  if (checks.missing.length) problems.push(`justification: write ${checks.missing.join(', ')}`);
  for (const issue of checks.review.issues) problems.push(`review ${issue.kind}${issue.where ? ` at ${issue.where}` : ''}: ${issue.text}`);
  return problems;
}

/** 已核对 (`verified`): every quote found, every key point covered, no invented number, nothing left empty, the review ran and found nothing (or its
    findings were repaired once). Anything else: 部分未核对 (`partial`). */
export function cardStatus(checks) {
  const clean = checks.quotes.verified === checks.quotes.total && !checks.coverage.missing.length && !checks.inventedNumbers.length && !checks.missing.length;
  return clean && checks.review.ran && (!checks.review.issues.length || checks.review.repaired) ? 'verified' : 'partial';
}

/** The stored card: checks, status, the digest of what it renders to and the basis of the question it was made for. */
export function finishAnswerCard(card, { review = { ran: false, issues: [], repaired: false }, basis }) {
  const checks = { ...card.checks, review };
  const done = { ...card, checks, status: cardStatus(checks), basis };
  return { ...done, renderedDigest: textDigest(renderAnswerCard(done)) };
}

/** The card's state now: null (none), 'verified', 'partial' or 'edited' (the question or the card changed since it was checked). */
export function answerCardState(card) {
  const answerCard = card?.answerCard;
  if (!answerCard || typeof answerCard !== 'object') return null;
  if (answerCard.basis !== answerCardBasis(card) || answerCard.renderedDigest !== textDigest(renderAnswerCard(answerCard))) return 'edited';
  return answerCard.status === 'verified' ? 'verified' : 'partial';
}

/** The shape check of card.answerCard (lib/domain.js optionalCardShapeErrors): an object of this version with its lists as lists. */
export function answerCardShapeErrors(value) {
  if (value === undefined) return [];
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.v !== ANSWER_CARD_VERSION) return ['answerCard must be an answer card object (v1)'];
  const lists = ['signals', 'facts', 'concepts', 'assumptions', 'steps', 'pitfalls', 'marksMap'];
  if (lists.some(key => !Array.isArray(value[key])) || typeof value.conclusion !== 'string' || !value.justification || typeof value.justification !== 'object')
    return ['answerCard has an invalid shape'];
  return [];
}

/* ---------- Markdown ---------- */

const WORDS = {
  zh: { type: '题型', signals: '识别信号', facts: '题干事实', concepts: '概念', assumptions: '假设', steps: '推理链', conclusion: '结论', goal: '为什么满足目标',
    cost: '代价', failure: '失败处理', verify: '如何验证', pitfalls: '易错检查', marks: '评分点对照', point: '评分点', value: '分值', sentence: '对应的句子',
    unverified: '未核实', missing: '没有句子对应', from: '资料', check: '核对', verified: '已核对', partial: '部分未核对', notice: '已核对 ≠ 答案正确',
    quotes: (a, b) => `引文 ${a}/${b} 已在原文找到`, covered: (a, b) => `评分点 ${a}/${b}`, sep: '：', open: '「', close: '」', none: '（无）' },
  en: { type: 'Question type', signals: 'Signals', facts: 'Stem facts', concepts: 'Concepts', assumptions: 'Assumptions', steps: 'Reasoning', conclusion: 'Conclusion',
    goal: 'Why it meets the goal', cost: 'Cost', failure: 'Failure handling', verify: 'How to verify', pitfalls: 'Pitfalls', marks: 'Marks map', point: 'Point',
    value: 'Marks', sentence: 'Sentence', unverified: 'not verified', missing: 'no sentence', from: 'Material', check: 'Checks', verified: 'Checked', partial: 'Partly unchecked',
    notice: 'checked ≠ correct', quotes: (a, b) => `${a}/${b} quotes found in the original`, covered: (a, b) => `${a}/${b} points`, sep: ': ', open: '“', close: '”', none: '(none)' },
};
/** The words of the card's parts in a language (the page uses the same ones). */
export const answerCardWords = language => WORDS[language === 'en' ? 'en' : 'zh'];
const cell = text => String(text ?? '').replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
const marks = value => (Number.isInteger(value) ? String(value) : String(Math.round(value * 100) / 100));

/**
 * The card as deterministic Markdown (no time, no model name; the same card always gives the same bytes): what the book holds and what `answer` is
 * for a new card. Bold labels, not headings, so a book file that holds it gets no new heading.
 */
export function renderAnswerCard(card, language = card?.language) {
  if (!card || typeof card !== 'object') return '';
  const w = answerCardWords(language), out = [];
  const flag = item => (item.verified ? '' : `（${w.unverified}）`);
  const quoted = text => `${w.open}${String(text ?? '').replace(/\s+/g, ' ').trim()}${w.close}`;
  const section = (label, body) => { if (body.length) out.push(`**${label}**`, '', ...body, ''); };
  out.push(`**${w.type}${w.sep}**${card.questionType?.label || card.questionType?.id || ''}`, '');
  section(w.signals, list(card.signals).map(item => `- ${quoted(item.word)}${w.sep}${quoted(item.quote)}${flag(item)}`));
  section(w.facts, list(card.facts).map(item => `- ${item.text}${item.quote ? ` —— ${quoted(item.quote)}` : ''}${flag(item)}`));
  section(w.concepts, list(card.concepts).map(item => `- **${item.name}**${item.where?.title ? `（${w.from}${w.sep}${item.where.title}）` : ''}${w.sep}${quoted(item.quote)}${flag(item)}`));
  section(w.assumptions, list(card.assumptions).map(item => `- ${item}`));
  section(w.steps, list(card.steps).map((item, at) => `${at + 1}. ${item.replace(/\n+/g, ' ')}`));
  section(w.conclusion, card.conclusion ? [card.conclusion] : []);
  for (const key of JUSTIFICATION) section(w[key], card.justification?.[key] ? [card.justification[key]] : []);
  section(w.pitfalls, list(card.pitfalls).map(item => `- ${item}`));
  const rows = list(card.marksMap).map(item => `| ${cell(`${item.label || item.criterionId} · ${item.point}`)} | ${marks(Number(item.marks) || 0)} | ${item.found ? cell(item.sentence) : w.missing} |`);
  if (rows.length) section(w.marks, [`| ${w.point} | ${w.value} | ${w.sentence} |`, '| --- | --- | --- |', ...rows]);
  const checks = card.checks;
  if (checks) out.push(`*${w.check}${w.sep}${card.status === 'verified' ? w.verified : w.partial} · ${w.quotes(checks.quotes.verified, checks.quotes.total)} · ${w.covered(checks.coverage.covered, checks.coverage.total)} · ${w.notice}*`);
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
