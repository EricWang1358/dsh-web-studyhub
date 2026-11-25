/* Pure helpers for Desk Serendipity Slip («随手抽一签») and the 5-stage
   Origami Progress Mark. Zero I/O, zero DOM, 100% deterministic in tests. */

import { resolvePracticeSettings } from '../../lib/practice-settings.js';
import { plainPrompt } from '../shared.js';

export const ORIGAMI_STAGES = Object.freeze([
  Object.freeze({ stage: 0, label: '素笺待折', caption: '方纸铺案，随时落第一折' }),
  Object.freeze({ stage: 1, label: '初折定角', caption: '已起对角折痕，手感渐热' }),
  Object.freeze({ stage: 2, label: '菱骨初成', caption: '折线收拢成形，节奏正稳' }),
  Object.freeze({ stage: 3, label: '展翼将成', caption: '双翼微扬，离今日目标只差几步' }),
  Object.freeze({ stage: 4, label: '纸鹤落案', caption: '今日一轮已收齐，纸鹤稳稳停在案头' }),
]);

const two = (n) => (n < 10 ? `0${n}` : String(n));

/** Local calendar key YYYY-MM-DD, matching lib/insights.js dayKey(). */
export function localDateKey(dateLike) {
  const d = dateLike instanceof Date ? dateLike : new Date(dateLike);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
}

/** Compute today's completed/goal ratio and 0..4 origami folding stage from StudyMap's `data` snapshot. */
export function computeTodayOrigami(data, now = new Date()) {
  const todayKey = localDateKey(now);
  const attempts = Array.isArray(data?.attempts) ? data.attempts : [];
  let done = 0;
  for (const attempt of attempts) {
    if (!attempt || attempt.retry) continue;
    const stamp = attempt.timestamp ?? attempt.at ?? attempt.createdAt;
    if (stamp && localDateKey(stamp) === todayKey) done += 1;
  }
  const goal = resolvePracticeSettings(data?.settings?.practice).roundSize;
  const ahead = Boolean(data?.today?.ahead);
  const ratio = done >= goal || (ahead && done > 0)
    ? 1
    : Math.max(0, Math.min(1, done / Math.max(1, goal)));

  let stage = 0;
  if (ratio >= 1) stage = 4;
  else if (ratio >= 0.7) stage = 3;
  else if (ratio >= 0.35) stage = 2;
  else if (ratio > 0) stage = 1;

  const meta = ORIGAMI_STAGES[stage];
  return {
    done,
    goal,
    ahead,
    ratio,
    percent: Math.round(ratio * 100),
    stage,
    label: meta.label,
    caption: meta.caption,
  };
}

/** Active, non-archived decks with at least one available card. Prefers learner decks over system decks. */
export function eligibleDecksForSlip(decks) {
  if (!Array.isArray(decks)) return [];
  const active = decks.filter((deck) => {
    if (!deck || !deck.id || deck.archived || deck.inactive) return false;
    const count = Number.isFinite(deck.available) ? deck.available : Number(deck.count || 0);
    return count > 0;
  });
  const own = active.filter((deck) => !deck.systemKind);
  return own.length ? own : active;
}

/** Pick one deck ID to lazily load via `call('deck.get', { id })`. Prefers decks outside `excludeIds` when available. */
export function pickDeckId(decks, excludeIds = [], rng = Math.random) {
  const eligible = eligibleDecksForSlip(decks);
  if (!eligible.length) return null;
  const exclude = new Set(excludeIds || []);
  const fresh = eligible.filter((deck) => !exclude.has(deck.id));
  const pool = fresh.length ? fresh : eligible;
  const index = Math.min(pool.length - 1, Math.floor(Math.max(0, Math.min(0.999999, rng())) * pool.length));
  return pool[index].id;
}

/** Pick one non-suspended card with a non-empty prompt, avoiding immediate repetition when >= 2 cards exist. */
export function pickRandomCard(cards, lastCardId = null, rng = Math.random) {
  if (!Array.isArray(cards)) return null;
  const valid = cards.filter((card) => card && !card.suspended && typeof card.prompt === 'string' && card.prompt.trim().length > 0);
  if (!valid.length) return null;
  const withoutLast = lastCardId && valid.length > 1 ? valid.filter((card) => card.id !== lastCardId) : valid;
  const pool = withoutLast.length ? withoutLast : valid;
  const index = Math.min(pool.length - 1, Math.floor(Math.max(0, Math.min(0.999999, rng())) * pool.length));
  return pool[index];
}

function cleanMarkdown(value) {
  return String(value ?? '').replace(/\r\n/g, '\n').trim();
}

function resolveCardAnswer(card) {
  if (!card || typeof card !== 'object') return '';
  const direct = typeof card.answer === 'string' ? card.answer.trim() : '';
  if (Array.isArray(card.options) && card.options.length) {
    const right = card.options.filter((opt) => opt && opt.correct && typeof opt.text === 'string' && opt.text.trim());
    if (right.length) {
      const joined = right.map((opt) => opt.text.trim()).join('；');
      // For option cards where `answer` is just an option id ("A"/"true"), show the readable option text.
      if (!direct || direct.length <= 6 || right.some((opt) => opt.id === direct)) return joined;
    }
  }
  if (direct) return direct;
  if (card.cloze && Array.isArray(card.cloze.answers)) {
    const filled = card.cloze.answers.map((item) => String(item?.value ?? '').trim()).filter(Boolean);
    if (filled.length) return filled.join(' · ');
  }
  return typeof card.explanation === 'string' ? card.explanation.trim() : '';
}

function extractSlipOptions(card) {
  if (!Array.isArray(card?.options) || !card.options.length) return [];
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const result = [];
  for (let i = 0; i < card.options.length; i += 1) {
    const opt = card.options[i];
    if (!opt || typeof opt !== 'object') continue;
    const text = cleanMarkdown(opt.text);
    if (!text) continue;
    const rawId = typeof opt.id === 'string' && opt.id.trim() ? opt.id.trim() : (letters[i] || String(i + 1));
    const label = /^[a-z]$/i.test(rawId) ? rawId.toUpperCase() : (letters[i] || rawId);
    result.push({ id: rawId, label, text, correct: Boolean(opt.correct) });
  }
  return result;
}

/** Build the compact Serendipity Slip view-model from a full card + deck object. */
export function extractSlipCard(card, deck) {
  if (!card || !deck) return null;
  const prompt = cleanMarkdown(plainPrompt(card.prompt));
  if (!prompt) return null;
  const options = extractSlipOptions(card);
  const answer = cleanMarkdown(resolveCardAnswer(card));
  const rawExplanation = cleanMarkdown(card.explanation);
  const explanation = rawExplanation && rawExplanation !== answer ? rawExplanation : '';
  return {
    deckId: deck.id,
    deckTitle: deck.title || '',
    course: deck.course || deck.folder || '',
    cardId: card.id || '',
    topic: card.topic || '',
    kind: card.kind || 'flashcard',
    prompt,
    options,
    answer,
    explanation,
  };
}
