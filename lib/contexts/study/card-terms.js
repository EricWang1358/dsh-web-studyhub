import { hasOptions } from '../../card-kinds.js';
import { parseJson } from '../../generation.js';
import { translateSource } from '../../translation-source.js';

export const MAX_CANDIDATE_TERMS = 6;
const MAX_TERM_LENGTH = 60;

export const SYSTEM = [
  'You extract up to 6 unfamiliar technical terms or concepts from a flashcard that a beginner learner is most likely not to know.',
  'Input JSON contains the flashcard fields (prompt, options, clozeText, blanks, answer, explanation) and `known` (an array of terms the learner already knows or studied).',
  'Rules:',
  '1. Pick at most 6 terms across the stem, options, cloze text/blanks, answer, and explanation that are technical concepts or domain vocabulary a beginner likely needs explained.',
  '2. Every picked term MUST appear verbatim in the flashcard text — copy the exact substring as written in the card, without translating, paraphrasing, or altering casing or punctuation.',
  '3. Do NOT pick everyday common words, function words, or generic glue words.',
  '4. Do NOT pick any term listed in `known` (case-insensitive match).',
  '5. If no suitable technical term exists (or all are already in `known`), return an empty array.',
  'Return a single JSON object ONLY: {"terms":["...","..."]} with no markdown fences or extra text.',
].join('\n');

const collapseWs = (value) => value.replace(/\s+/g, ' ').trim();

function cardTextSegments(card) {
  if (!card || typeof card !== 'object') return [];
  const raw = [card.prompt, card.answer, card.explanation];
  if (card.cloze && typeof card.cloze === 'object') {
    raw.push(card.cloze.text);
    if (Array.isArray(card.cloze.answers)) {
      for (const item of card.cloze.answers) raw.push(item?.value);
    }
  }
  if ((hasOptions(card.kind) || Array.isArray(card.options)) && Array.isArray(card.options)) {
    for (const opt of card.options) {
      raw.push(opt?.text, opt?.explanation);
    }
  }
  return raw.filter((part) => typeof part === 'string' && part.trim());
}

/** Normalizes and validates model output, keeping only deduplicated unknown verbatim substrings. */
export function normalizeCardTerms(card, value, known = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Array.isArray(value.terms)) {
    throw new Error('候选生词结果不是包含 terms 数组的 JSON 对象');
  }
  for (const item of value.terms) {
    if (typeof item !== 'string') {
      throw new Error('候选生词列表每项必须是字符串');
    }
  }

  const segments = cardTextSegments(card).map((seg) => ({
    raw: seg,
    collapsed: collapseWs(seg),
  }));
  const knownSet = new Set(
    (Array.isArray(known) ? known : [])
      .map((item) => (typeof item === 'string' ? collapseWs(item).toLowerCase() : ''))
      .filter(Boolean),
  );
  const seen = new Set();
  const terms = [];

  for (const rawTerm of value.terms) {
    const clean = collapseWs(rawTerm);
    if (clean.length < 1 || clean.length > MAX_TERM_LENGTH) continue;
    const key = clean.toLowerCase();
    if (seen.has(key) || knownSet.has(key)) continue;
    if (!segments.some((seg) => seg.raw.includes(clean) || seg.collapsed.includes(clean))) continue;
    seen.add(key);
    terms.push(clean);
    if (terms.length >= MAX_CANDIDATE_TERMS) break;
  }
  return terms;
}

/** The most model calls one extraction makes: the ask, and one more when the reply fails validation (what a pre-run estimate counts). */
export const CARD_TERMS_MAX_CALLS = 2;

/** Extracts candidate unfamiliar terms from a flashcard via a lightweight model call with one retry. */
export async function extractCardTerms(complete, card, known = []) {
  const { source, digest } = translateSource(card);
  const cleanKnown = Array.isArray(known) ? known : [];
  const payload = JSON.stringify({ ...source, known: cleanKnown });
  const ask = async (suffix = '') =>
    normalizeCardTerms(
      card,
      parseJson(await complete(SYSTEM, `${payload}${suffix}`, { task: 'card.terms' })),
      cleanKnown,
    );

  try {
    return { terms: await ask(), digest };
  } catch (error) {
    return {
      terms: await ask(
        `\n\nYour previous reply failed validation: ${error.message}. Reply again with a valid JSON object {"terms":[]} only.`,
      ),
      digest,
    };
  }
}

/** Returns cached candidate terms when present and matching the current card content digest. */
export function currentCardTerms(card) {
  const record = card?.terms;
  if (!record || typeof record !== 'object' || !Array.isArray(record.items)) return null;
  return record.digest === translateSource(card).digest ? record.items : null;
}
