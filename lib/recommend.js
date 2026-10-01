import { learningScope } from './learning-scope.js';
import { isJsonCardSource } from './source-provenance.js';
import { normalizeTopic, promptTokens, deckShortTitles } from './recommend-text.js';

export { normalizeTopic, promptTokens, deckShortTitles };

/* "为你推荐" (WP26): similar EXISTING questions for the learner's current
   mistakes. Pure and model-free: same normalised topic, the same page (or a
   neighbouring page) of the same document, or shared key terms in the prompt.
   Reasons are structured so the UI can say why in either language. */

const NEAR_PAGES = 2;
const isLatin = (token) => /^[a-z]/.test(token);
const WEIGHT = { topic: 6, page: 5, near: 3 };
const key = (deckId, cardId) => JSON.stringify([deckId, cardId]);

function sourceFacts(state) {
  const facts = new Map();
  for (const source of state.sources || []) {
    if (isJsonCardSource(source)) continue;
    const document = source.document;
    facts.set(source.id, {
      id: source.id,
      title: document?.filename || String(source.title || source.id).replace(/\s*·\s*p\.\d+$/i, ''),
      docId: document?.id ?? null,
      page: Number.isInteger(document?.page) ? document.page : null,
    });
  }
  return facts;
}
const citedSources = (card, facts) => [...new Set((card.citations || []).map((ref) => ref?.sourceId))]
  .map((id) => facts.get(id)).filter(Boolean);

function citationReason(a, b) {
  let best = null;
  for (const x of a) for (const y of b) {
    if (x.id === y.id && x.page !== null) return { type: 'page', sourceTitle: y.title, page: y.page };
    if (x.docId && x.docId === y.docId && x.page !== null && y.page !== null) {
      const distance = Math.abs(x.page - y.page);
      if (distance === 0) return { type: 'page', sourceTitle: y.title, page: y.page };
      if (distance <= NEAR_PAGES && (!best || distance < best.distance)) best = { distance, reason: { type: 'near', sourceTitle: y.title, page: y.page } };
    }
  }
  return best?.reason ?? null;
}
const shareSource = (a, b) => a.some((x) => b.some((y) => x.id === y.id));

/**
 * Similar existing questions for `mistakes` ([{deckId, cardId}]) within `course`
 * ('*' or undefined = whole library). Excludes the mistakes, every card still
 * in the wrong book and cards answered correctly in the last `days` days.
 */
export function recommendSimilar(state, { mistakes = [], course, days = 7, limit = 10, now = Date.now() } = {}) {
  const selection = learningScope(state, { course });
  const inScope = (deck) => !deck.archived && !deck.systemKind && (selection.all || selection.scope.some((ref) => ref.deckId === deck.id));
  const facts = sourceFacts(state);

  const deckOrder = new Map(), cardIndex = new Map(), byRef = new Map();
  state.decks.forEach((deck, d) => {
    deckOrder.set(deck.id, d);
    deck.cards.forEach((card, c) => { cardIndex.set(key(deck.id, card.id), c); byRef.set(key(deck.id, card.id), { deck, card }); });
  });

  const last = new Map(), recentCorrect = new Set(), attempted = new Set();
  const since = now - days * 86400000;
  for (const attempt of state.attempts || []) {
    if (attempt.retry) continue;
    const ref = key(attempt.deckId, attempt.quiz_id);
    const previous = last.get(ref);
    if (!previous || attempt.timestamp >= previous.timestamp) last.set(ref, attempt);
    if (attempt.implicit) continue;
    attempted.add(ref);
    if (attempt.grade >= 3 && Date.parse(attempt.timestamp) >= since) recentCorrect.add(ref);
  }
  const stillWrong = new Set([...last].filter(([, attempt]) => attempt.grade < 3).map(([ref]) => ref));

  const mistakeRefs = new Set();
  const sources = [];
  for (const ref of mistakes) {
    const found = byRef.get(key(ref?.deckId, ref?.cardId));
    if (!found || mistakeRefs.has(key(ref.deckId, ref.cardId))) continue;
    mistakeRefs.add(key(ref.deckId, ref.cardId));
    sources.push({ ref: key(ref.deckId, ref.cardId), cardId: found.card.id, card: found.card, topic: normalizeTopic(found.card.topic), rawTopic: String(found.card.topic).trim(),
      cited: citedSources(found.card, facts), tokens: promptTokens(found.card.prompt) });
  }
  if (!sources.length) return { items: [], considered: 0 };

  const pool = [];
  for (const deck of state.decks) {
    if (!inScope(deck)) continue;
    for (const card of deck.cards) {
      const ref = key(deck.id, card.id);
      if (card.suspended || mistakeRefs.has(ref) || stillWrong.has(ref) || recentCorrect.has(ref)) continue;
      pool.push({ ref, deck, card, topic: normalizeTopic(card.topic), cited: citedSources(card, facts), tokens: promptTokens(card.prompt) });
    }
  }

  // Terms found in many prompts say nothing about *this* concept.
  const frequency = new Map();
  for (const entry of [...pool, ...sources]) for (const token of entry.tokens) frequency.set(token, (frequency.get(token) || 0) + 1);
  const ceiling = Math.max(3, Math.floor((pool.length + sources.length) * 0.25));
  const informative = (token) => (frequency.get(token) || 0) <= ceiling;

  const items = [];
  for (const candidate of pool) {
    const related = [];
    for (const mistake of sources) {
      const reasons = [];
      let score = 0;
      if (mistake.topic && mistake.topic === candidate.topic) {
        reasons.push({ type: 'topic', topic: mistake.rawTopic });
        score += WEIGHT.topic;
      }
      const cite = citationReason(mistake.cited, candidate.cited);
      if (cite) { reasons.push(cite); score += WEIGHT[cite.type]; }
      const shared = [...candidate.tokens].filter((token) => mistake.tokens.has(token) && informative(token));
      const strength = shared.reduce((sum, token) => sum + (isLatin(token) ? 2 : 1), 0);
      if (strength >= 2) {
        shared.sort((a, b) => Number(isLatin(b)) - Number(isLatin(a)) || b.length - a.length);
        reasons.push({ type: 'terms', terms: shared.slice(0, 3) });
        score += Math.min(4, strength * 0.8);
      }
      if (reasons.length && !cite && shareSource(mistake.cited, candidate.cited)) {
        const source = candidate.cited.find((x) => mistake.cited.some((y) => y.id === x.id));
        reasons.push({ type: 'source', sourceTitle: source.title });
        score += 1;
      }
      if (score > 0 && reasons.length) related.push({ mistake, reasons, score });
    }
    if (!related.length) continue;
    related.sort((a, b) => b.score - a.score);
    const [best] = related;
    items.push({
      deckId: candidate.deck.id, deckTitle: candidate.deck.title, cardId: candidate.card.id, topic: candidate.card.topic || '',
      kind: candidate.card.kind, prompt: candidate.card.prompt,
      score: best.score + Math.min(2, (related.length - 1) * 0.5),
      reasons: best.reasons, forCardIds: related.map((entry) => entry.mistake.cardId),
      // Why it fits each related mistake, for the opened-row view.
      matches: related.map((entry) => ({ cardId: entry.mistake.cardId, reasons: entry.reasons, score: entry.score })),
      _tie: [attempted.has(candidate.ref) ? 1 : 0, deckOrder.get(candidate.deck.id), cardIndex.get(candidate.ref)],
    });
  }
  items.sort((a, b) => b.score - a.score || a._tie[0] - b._tie[0] || a._tie[1] - b._tie[1] || a._tie[2] - b._tie[2]);
  const cap = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 50) : 10;
  return { items: items.slice(0, cap).map(({ _tie, ...item }) => item), considered: pool.length };
}
