import { courseIndex } from '../../../courses.js';
import { courseKnown, courseScope } from '../../../course-tree.js';
import { knownCourseNames } from '../../../source-courses.js';
import { linkPrerequisite } from '../../../prereq.js';
import { coursePromptTerms, findLiveTermCard } from '../../courses/contracts.js';
import { currentCardTerms, extractCardTerms } from '../../study/contracts.js';

export const MAX_PREREQS_PER_CARD = 12;
export const MAX_SKIPPED_SAMPLE = 50;
/** The origin every link of this batch job carries, so a batch can be undone without touching hand-made links. */
export const AUTO_LINK_ORIGIN = 'course-organize';
const MAX_LINKS_ADDED_PER_CARD = 4;

const GENERIC_TOPICS = new Set([
  '未分类', '综合', '基础', '总览', '导论', '概念', '原理', '应用', '进阶', '练习', '测验', '复习', '其他',
  'general', 'basics', 'overview', 'intro', 'introduction', 'summary', 'misc', 'other', 'review', 'quiz', 'uncategorized',
]);

const HAN_RE = /[\u4e00-\u9fff]/;

const norm = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const normKey = value => norm(value).toLowerCase();

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isUsefulTerm(raw) {
  const clean = norm(raw);
  if (!clean || clean.length > 60) return false;
  const key = clean.toLowerCase();
  if (GENERIC_TOPICS.has(key)) return false;
  if (HAN_RE.test(clean)) return clean.length >= 2;
  return clean.length >= 3 && /[a-zA-Z]/.test(clean);
}

function textMentionsTerm(haystack, term) {
  if (!haystack || !term) return false;
  if (HAN_RE.test(term)) return haystack.toLowerCase().includes(term.toLowerCase());
  const pattern = new RegExp(`(^|[^a-zA-Z0-9_])${escapeRegExp(term)}([^a-zA-Z0-9_]|$)`, 'i');
  return pattern.test(haystack);
}

function cardSearchText(card) {
  if (!card || typeof card !== 'object') return '';
  const parts = [card.prompt || ''];
  if (card.cloze?.text) parts.push(card.cloze.text);
  if (Array.isArray(card.options)) {
    for (const opt of card.options) {
      if (opt?.text) parts.push(opt.text);
    }
  }
  return parts.join('\n');
}

/** Collect all active (non-archived, non-slain) decks belonging to `courseName` (including sub-courses). */
export function courseDecksForOrganize(state, courseName) {
  const clean = norm(courseName);
  if (!clean) return [];
  const known = courseKnown(knownCourseNames(state));
  const resolved = courseIndex(state).resolve(clean)?.name || clean;
  const inScope = courseScope(resolved, known);
  return (Array.isArray(state?.decks) ? state.decks : []).filter(deck => {
    if (!deck || deck.archived || deck.systemKind === 'slain') return false;
    const dc = deck.course ?? deck.folder ?? '';
    return typeof dc === 'string' && dc.trim() && inScope(dc);
  });
}

function courseRecordFor(state, courseName) {
  const clean = norm(courseName);
  if (!clean) return null;
  const resolved = courseIndex(state).resolve(clean);
  if (resolved && !resolved.virtual) {
    const found = (state.courses || []).find(item => item.id === resolved.id);
    if (found) return found;
  }
  const key = normKey(clean);
  return (state.courses || []).find(item => normKey(item?.name) === key) || null;
}

/**
 * Deterministically plan acyclic prerequisite links and pending card-term extractions for a course.
 * Zero model calls; respects deck order (earlier decks/cards act as prerequisites for later ones),
 * existing `card.requires`, and the 12-prerequisite cap per card.
 */
export function planCourseOrganize(state, courseName, { maxLinksPerCard = MAX_LINKS_ADDED_PER_CARD } = {}) {
  const decks = courseDecksForOrganize(state, courseName);
  const totalCards = decks.reduce((sum, deck) => sum + (Array.isArray(deck.cards) ? deck.cards.length : 0), 0);
  const courseRecord = courseRecordFor(state, courseName);
  const allDecks = Array.isArray(state?.decks) ? state.decks : [];

  // 1. Glossary terms with attached live check-cards
  const conceptProviders = [];
  const providerSeen = new Set();
  const addProvider = (term, deckId, cardId, deckOrder, cardOrder, source, via) => {
    if (!isUsefulTerm(term)) return;
    const key = `${normKey(term)}::${deckId}::${cardId}`;
    if (providerSeen.has(key)) return;
    providerSeen.add(key);
    conceptProviders.push({ term: norm(term), deckId, cardId, deckOrder, cardOrder, source, via });
  };

  for (const item of Array.isArray(courseRecord?.terms?.items) ? courseRecord.terms.items : []) {
    if (!item?.term || !item?.card) continue;
    const live = findLiveTermCard(allDecks, item.card);
    if (!live) continue;
    const deckOrder = decks.findIndex(d => d.id === live.deck.id);
    const cardOrder = live.deck.cards.findIndex(c => c.id === live.card.id);
    addProvider(item.term, live.deck.id, live.card.id, deckOrder >= 0 ? deckOrder : -1, cardOrder >= 0 ? cardOrder : 0, 'glossary', 'glossary');
    if (item.alt) addProvider(item.alt, live.deck.id, live.card.id, deckOrder >= 0 ? deckOrder : -1, cardOrder >= 0 ? cardOrder : 0, 'glossary', 'glossary');
  }

  // 2. Earlier foundational/topic cards inside the course decks
  const topicFirstCard = new Map();
  decks.forEach((deck, deckOrder) => {
    (deck.cards || []).forEach((card, cardOrder) => {
      if (!card?.id || card.suspended) return;
      const candidates = [card.prereqTerm, card.topic].filter(Boolean);
      for (const raw of candidates) {
        if (!isUsefulTerm(raw)) continue;
        const k = normKey(raw);
        const via = card.prereqTerm === raw ? 'prereq-gap' : 'topic';
        const existing = topicFirstCard.get(k);
        // Prefer prereqGap / flashcard or earliest card in deck order
        const rank = card.prereqGap ? 0 : card.kind === 'flashcard' ? 1 : 2;
        if (!existing || rank < existing.rank || (rank === existing.rank && (deckOrder < existing.deckOrder || (deckOrder === existing.deckOrder && cardOrder < existing.cardOrder)))) {
          topicFirstCard.set(k, { term: norm(raw), deckId: deck.id, cardId: card.id, deckOrder, cardOrder, rank, via });
        }
      }
    });
  });
  for (const entry of topicFirstCard.values()) {
    addProvider(entry.term, entry.deckId, entry.cardId, entry.deckOrder, entry.cardOrder, 'topic', entry.via);
  }

  const linkCandidates = [];
  const preSkipped = [];
  const uncachedTermCards = [];
  let cachedTermCards = 0;

  decks.forEach((deck, deckOrder) => {
    (deck.cards || []).forEach((card, cardOrder) => {
      if (!card?.id) return;
      if (currentCardTerms(card) !== null) {
        cachedTermCards += 1;
      } else if (!card.suspended) {
        uncachedTermCards.push({ deckId: deck.id, cardId: card.id, card });
      }
      if (card.suspended) return;

      const existingReqs = Array.isArray(card.requires) ? card.requires : [];
      const existingSet = new Set(existingReqs.map(r => `${r.deckId}::${r.cardId}`));
      const text = cardSearchText(card);
      let plannedForCard = 0;

      for (const provider of conceptProviders) {
        if (provider.deckId === deck.id && provider.cardId === card.id) continue;
        // Enforce natural course direction: glossary cards or strictly earlier decks/cards only
        if (provider.source !== 'glossary') {
          if (provider.deckOrder > deckOrder) continue;
          if (provider.deckOrder === deckOrder && provider.cardOrder >= cardOrder) continue;
        }
        if (!textMentionsTerm(text, provider.term)) continue;

        const pairKey = `${provider.deckId}::${provider.cardId}`;
        if (existingSet.has(pairKey)) {
          preSkipped.push({ deckId: deck.id, cardId: card.id, requiresCardId: provider.cardId, reason: 'already-linked' });
          continue;
        }
        // Same-topic siblings in one deck are alternatives, not prerequisites of each
        // other: the planner's "first card of this topic" would link the rest to it.
        if (provider.via === 'topic' && provider.deckId === deck.id
          && normKey(card.topic) && normKey(card.topic) === normKey(provider.term)) {
          preSkipped.push({ deckId: deck.id, cardId: card.id, requiresCardId: provider.cardId, reason: 'same-topic-sibling' });
          continue;
        }
        if (existingReqs.length + plannedForCard >= MAX_PREREQS_PER_CARD) {
          preSkipped.push({ deckId: deck.id, cardId: card.id, requiresCardId: provider.cardId, reason: 'max-prerequisites' });
          continue;
        }
        if (plannedForCard >= maxLinksPerCard) continue;

        existingSet.add(pairKey);
        plannedForCard += 1;
        linkCandidates.push({
          dependent: { deckId: deck.id, cardId: card.id },
          requires: { deckId: provider.deckId, cardId: provider.cardId },
          term: provider.term,
          source: provider.source,
          via: provider.via,
          origin: AUTO_LINK_ORIGIN,
        });
      }
    });
  });

  return {
    course: courseIndex(state).resolve(norm(courseName))?.name || norm(courseName),
    decks: decks.map(d => ({ id: d.id, title: d.title, cards: (d.cards || []).length })),
    totalCards,
    linkCandidates,
    preSkipped,
    uncachedTermCards,
    cachedTermCards,
  };
}

function recordSkip(skipped, skippedReasons, entry) {
  const reason = entry.reason || 'skipped';
  skippedReasons[reason] = (skippedReasons[reason] || 0) + 1;
  if (skipped.length < MAX_SKIPPED_SAMPLE) skipped.push(entry);
}

/**
 * Execute course-level batch organization:
 * 1. Apply acyclic prerequisite links (offline, zero model calls, via `applyLink` or `linkPrerequisite`).
 * 2. Extract missing `card.terms` via light model when `ask` is available; explicitly report `no-model` when unavailable.
 */
export async function runCourseOrganize({
  state,
  course,
  mode = 'all',
  ask = null,
  applyLink = null,
  saveCardTerms = null,
  signal = null,
  onProgress = null,
} = {}) {
  const runPrereqs = mode === 'all' || mode === 'prereqs';
  const runTerms = mode === 'all' || mode === 'terms';
  const plan = planCourseOrganize(state, course);

  const skipped = [];
  const skippedReasons = {};
  for (const item of plan.preSkipped) {
    if (runPrereqs) recordSkip(skipped, skippedReasons, item);
  }
  if (runTerms && plan.cachedTermCards > 0) {
    skippedReasons['terms-cached'] = plan.cachedTermCards;
  }

  const totalWork = (runPrereqs ? plan.linkCandidates.length : 0) + (runTerms ? plan.uncachedTermCards.length : 0);
  let doneWork = 0;
  let linksAdded = 0;
  let termsExtracted = 0;
  let termsSkippedNoModel = 0;
  let termsNote = '';

  const report = (stage) => {
    onProgress?.({
      stage,
      done: doneWork,
      total: Math.max(totalWork, 1),
      linksAdded,
      termsExtracted,
      termsCached: plan.cachedTermCards,
      termsSkippedNoModel,
      skippedReasons: { ...skippedReasons },
      termsNote,
    });
  };

  report('prereqs');

  // Step 1: Deterministic acyclic prerequisite links
  if (runPrereqs) {
    for (const candidate of plan.linkCandidates) {
      signal?.throwIfAborted?.();
      try {
        let res;
        if (typeof applyLink === 'function') {
          res = await applyLink(candidate);
        } else {
          res = linkPrerequisite(state, candidate.dependent, candidate.requires, false, candidate.origin);
        }
        if (res?.existing) {
          recordSkip(skipped, skippedReasons, {
            deckId: candidate.dependent.deckId,
            cardId: candidate.dependent.cardId,
            requiresCardId: candidate.requires.cardId,
            reason: 'already-linked',
          });
        } else if (res?.linked !== false) {
          linksAdded += 1;
        }
      } catch (error) {
        const msg = String(error?.message || '');
        const reason = /depend on each other|cycle|环/i.test(msg)
          ? 'would-create-cycle'
          : /at most 12|12/i.test(msg)
            ? 'max-prerequisites'
            : /require itself/i.test(msg)
              ? 'self-link'
              : 'link-failed';
        recordSkip(skipped, skippedReasons, {
          deckId: candidate.dependent.deckId,
          cardId: candidate.dependent.cardId,
          requiresCardId: candidate.requires.cardId,
          reason,
        });
      }
      doneWork += 1;
      report('prereqs');
    }
  }

  // Step 2: Batch pre-extract card.terms for cards without valid cache
  if (runTerms && plan.uncachedTermCards.length > 0) {
    if (typeof ask !== 'function') {
      termsNote = 'no-model';
      termsSkippedNoModel = plan.uncachedTermCards.length;
      for (const entry of plan.uncachedTermCards) {
        recordSkip(skipped, skippedReasons, {
          deckId: entry.deckId,
          cardId: entry.cardId,
          reason: 'no-model',
        });
      }
      doneWork += plan.uncachedTermCards.length;
      report('done');
    } else {
      const { known } = coursePromptTerms(state, plan.course);
      report('terms');
      for (const entry of plan.uncachedTermCards) {
        signal?.throwIfAborted?.();
        try {
          const extracted = await extractCardTerms(ask, entry.card, known);
          const record = {
            at: new Date().toISOString(),
            digest: extracted.digest,
            items: extracted.terms,
          };
          if (typeof saveCardTerms === 'function') {
            await saveCardTerms(entry.deckId, entry.cardId, record);
          } else {
            entry.card.terms = record;
          }
          termsExtracted += 1;
        } catch (error) {
          if (signal?.aborted || error?.name === 'AbortError') throw error;
          recordSkip(skipped, skippedReasons, {
            deckId: entry.deckId,
            cardId: entry.cardId,
            reason: 'terms-failed',
          });
        }
        doneWork += 1;
        report('terms');
      }
    }
  }

  report('done');
  return {
    course: plan.course,
    totalCards: plan.totalCards,
    linksAdded,
    termsExtracted,
    termsCached: plan.cachedTermCards,
    termsSkippedNoModel,
    skipped,
    skippedReasons,
    termsNote,
  };
}

/**
 * Remove the prerequisite links this batch job made for a course. Links from any
 * other origin (a hand-made one, another tool) are left alone; `removed` is what went.
 */
export async function undoCourseOrganize({ state, course, removeLinks = null } = {}) {
  const links = [];
  for (const deck of courseDecksForOrganize(state, course)) {
    for (const card of Array.isArray(deck.cards) ? deck.cards : []) {
      for (const ref of Array.isArray(card.requires) ? card.requires : []) {
        if (ref?.origin !== AUTO_LINK_ORIGIN) continue;
        links.push({
          deckId: deck.id,
          cardId: card.id,
          requires: { deckId: ref.deckId, cardId: ref.cardId },
          remove: true,
          origin: AUTO_LINK_ORIGIN,
        });
      }
    }
  }
  const name = courseIndex(state).resolve(norm(course))?.name || norm(course);
  if (!links.length) return { course: name, removed: 0 };

  let removed = 0;
  if (typeof removeLinks === 'function') {
    removed = Number((await removeLinks(links))?.linked) || 0;
  } else {
    for (const link of links) {
      const card = state.decks.find(item => item.id === link.deckId)?.cards?.find(item => item.id === link.cardId);
      if (!card) continue;
      const before = Array.isArray(card.requires) ? card.requires : [];
      card.requires = before.filter(ref => !(ref.deckId === link.requires.deckId && ref.cardId === link.requires.cardId && ref.origin === AUTO_LINK_ORIGIN));
      if (card.requires.length !== before.length) removed += 1;
    }
  }
  return { course: name, removed };
}
