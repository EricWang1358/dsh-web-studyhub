import { latestOutcomes, cardLevel } from '../../mastery.js';

export const COURSE_TERMS_LIMITS = Object.freeze({
  version: 1,
  maxItems: 500,
  maxTermChars: 60,
  maxAltChars: 80,
  maxPromptChars: 60,
  maxPromptItems: 100,
});

export const TERMS_OVER_LIMIT_ERROR = '生词表最多保存 500 个词，请先清理已掌握或不再需要的词';

const NEWLINE_RE = /[\r\n]/;

export function normalizeCourseTerm(value) {
  if (typeof value !== 'string' || NEWLINE_RE.test(value)) {
    throw new Error('生词不能换行，长度需在 1–60 个字以内');
  }
  const clean = value.replace(/\s+/g, ' ').trim();
  if (!clean || clean.length > COURSE_TERMS_LIMITS.maxTermChars) {
    throw new Error('生词不能换行，长度需在 1–60 个字以内');
  }
  return clean;
}

function checkedAlt(value) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string' || NEWLINE_RE.test(value)) {
    throw new Error('生词别名格式无效');
  }
  return value.replace(/\s+/g, ' ').trim().slice(0, COURSE_TERMS_LIMITS.maxAltChars);
}

function checkedCardRef(ref) {
  if (ref === undefined || ref === null) return undefined;
  if (
    !ref
    || typeof ref !== 'object'
    || Array.isArray(ref)
    || typeof ref.deckId !== 'string'
    || !ref.deckId.trim()
    || typeof ref.cardId !== 'string'
    || !ref.cardId.trim()
  ) {
    throw new Error('生词关联卡片格式无效');
  }
  return { deckId: ref.deckId.trim(), cardId: ref.cardId.trim() };
}

function checkedTimestamp(value, fallback) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new Error('生词时间格式无效');
  }
  return value;
}

function pickEarlierTimestamp(a, b) {
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (Number.isFinite(ta) && Number.isFinite(tb)) {
    return tb < ta ? { pickB: true, at: b } : { pickB: false, at: a };
  }
  return { pickB: false, at: a || b };
}

function mergeTermPair(existing, incoming) {
  const { pickB, at } = pickEarlierTimestamp(existing.at, incoming.at);
  const primary = pickB ? incoming : existing;
  const secondary = pickB ? existing : incoming;
  const alt = primary.alt || secondary.alt || '';
  const from = primary.from || secondary.from;
  const card = primary.card || secondary.card;
  return {
    term: primary.term,
    ...(alt ? { alt } : {}),
    at,
    ...(from ? { from } : {}),
    ...(card ? { card } : {}),
  };
}

/** Validate and normalize `course.terms`. Returns `undefined` when omitted, `null` when cleared/empty. */
export function checkedTerms(raw, { now = () => new Date().toISOString() } = {}) {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('生词表格式无效');
  }
  if (raw.version !== undefined && raw.version !== COURSE_TERMS_LIMITS.version) {
    throw new Error('生词表版本不支持');
  }
  if (!Array.isArray(raw.items)) {
    throw new Error('生词表格式无效');
  }

  const fallbackNow = now();
  const byKey = new Map();
  const order = [];
  for (const entry of raw.items) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error('生词格式无效');
    }
    const term = normalizeCourseTerm(entry.term);
    const alt = checkedAlt(entry.alt);
    const at = checkedTimestamp(entry.at, fallbackNow);
    const from = checkedCardRef(entry.from);
    const card = checkedCardRef(entry.card);
    const item = {
      term,
      ...(alt ? { alt } : {}),
      at,
      ...(from ? { from } : {}),
      ...(card ? { card } : {}),
    };
    const key = term.toLowerCase();
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, item);
      order.push(key);
    } else {
      byKey.set(key, mergeTermPair(existing, item));
    }
  }

  const items = order.map((key) => byKey.get(key));
  if (items.length > COURSE_TERMS_LIMITS.maxItems) {
    throw new Error(TERMS_OVER_LIMIT_ERROR);
  }
  if (!items.length) return null;
  return { version: COURSE_TERMS_LIMITS.version, items };
}

/** Union two course term lists by lowercase term, keeping the earlier `at` and any attached card. */
export function mergeCourseTerms(left, right) {
  const leftItems = Array.isArray(left?.items) ? left.items : [];
  const rightItems = Array.isArray(right?.items) ? right.items : [];
  if (!leftItems.length && !rightItems.length) return undefined;

  const merged = new Map();
  const order = [];
  for (const raw of [...leftItems, ...rightItems]) {
    if (!raw || typeof raw !== 'object') continue;
    let term;
    try {
      term = normalizeCourseTerm(raw.term);
    } catch {
      continue;
    }
    const alt = typeof raw.alt === 'string' && !NEWLINE_RE.test(raw.alt)
      ? raw.alt.replace(/\s+/g, ' ').trim().slice(0, COURSE_TERMS_LIMITS.maxAltChars)
      : '';
    const at = typeof raw.at === 'string' && Number.isFinite(Date.parse(raw.at))
      ? raw.at
      : new Date(0).toISOString();
    let from;
    let card;
    try { from = checkedCardRef(raw.from); } catch { /* a damaged reference is left out; the term is kept */ }
    try { card = checkedCardRef(raw.card); } catch { /* a damaged reference is left out; the term is kept */ }
    const item = {
      term,
      ...(alt ? { alt } : {}),
      at,
      ...(from ? { from } : {}),
      ...(card ? { card } : {}),
    };
    const key = term.toLowerCase();
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, item);
      order.push(key);
    } else {
      merged.set(key, mergeTermPair(existing, item));
    }
  }

  let items = order.map((key) => merged.get(key));
  if (!items.length) return undefined;
  if (items.length > COURSE_TERMS_LIMITS.maxItems) {
    items = [...items]
      .sort((a, b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0))
      .slice(0, COURSE_TERMS_LIMITS.maxItems);
  }
  return { version: COURSE_TERMS_LIMITS.version, items };
}

/**
 * Derive current term mastery state dynamically from the linked check card's FSRS level.
 * Never persisted on the course record.
 */
export function termState(item, levelOf) {
  if (!item?.card?.deckId || !item?.card?.cardId) return 'unknown';
  const level = typeof levelOf === 'function' ? levelOf(item.card.deckId, item.card.cardId) : null;
  if (!level || level === 'new' || level === 'weak') return 'unknown';
  if (level === 'learning') return 'learned';
  if (level === 'familiar' || level === 'mastered') return 'known';
  return 'unknown';
}

const normCourseKey = (name) => (typeof name === 'string' ? name.normalize('NFKC').replace(/\s+/g, ' ').trim() : '');

function resolveCourseRecord(state, courseNameOrId) {
  const courses = Array.isArray(state?.courses) ? state.courses : [];
  if (typeof courseNameOrId !== 'string' || !courseNameOrId.trim()) return null;
  const byId = courses.find((c) => c?.id === courseNameOrId);
  if (byId) return byId;
  const key = normCourseKey(courseNameOrId);
  if (!key) return null;
  return (
    courses.find((c) => normCourseKey(c?.name) === key)
    || courses.find((c) => Array.isArray(c?.aliases) && c.aliases.some((alias) => normCourseKey(alias) === key))
    || null
  );
}

/** Resolve a card ref against non-archived, non-slain decks. Returns `{ deck, card }` or `null`. */
export function findLiveTermCard(decks, ref) {
  if (!ref?.cardId) return null;
  const active = (Array.isArray(decks) ? decks : []).filter(
    (deck) => deck && !deck.archived && deck.systemKind !== 'slain',
  );
  const directDeck = ref.deckId ? active.find((deck) => deck.id === ref.deckId) : null;
  const directCard = directDeck?.cards?.find((card) => card?.id === ref.cardId);
  if (directCard) return { deck: directDeck, card: directCard };
  for (const deck of active) {
    const card = deck?.cards?.find((c) => c?.id === ref.cardId);
    if (card) return { deck, card };
  }
  return null;
}

/**
 * Partition `requestedTerms` for `courseNameOrId` into `hasCard` (terms whose course word-list entry
 * has a `card` resolving to a live card in `state.decks`) and `missing` (all remaining terms).
 */
export function partitionCourseTermCards(state, courseNameOrId, requestedTerms = []) {
  const requested = Array.isArray(requestedTerms) ? requestedTerms : [];
  if (!requested.length || !courseNameOrId) {
    return { hasCard: [], missing: [...requested] };
  }
  const course = courseNameOrId && typeof courseNameOrId === 'object'
    ? courseNameOrId
    : resolveCourseRecord(state, courseNameOrId);
  const rawItems = Array.isArray(course?.terms?.items) ? course.terms.items : [];
  if (!rawItems.length) {
    return { hasCard: [], missing: [...requested] };
  }
  const decks = Array.isArray(state?.decks) ? state.decks : [];
  const liveByKey = new Map();
  for (const item of rawItems) {
    if (!item?.term || !item?.card) continue;
    const found = findLiveTermCard(decks, item.card);
    if (!found) continue;
    liveByKey.set(item.term.toLowerCase(), { deckId: found.deck.id, cardId: found.card.id });
  }
  const hasCard = [];
  const missing = [];
  for (const term of requested) {
    const liveRef = typeof term === 'string' ? liveByKey.get(term.toLowerCase()) : undefined;
    if (liveRef) hasCard.push({ term, card: liveRef });
    else missing.push(term);
  }
  return { hasCard, missing };
}

function promptExcerpt(raw, max = COURSE_TERMS_LIMITS.maxPromptChars) {
  if (typeof raw !== 'string') return '';
  const clean = raw.replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean;
}

/** Return course term items enriched with live `state` and optional `fromPrompt` excerpt. */
export function courseTermsWithState(state, courseNameOrId) {
  const course = courseNameOrId && typeof courseNameOrId === 'object'
    ? courseNameOrId
    : resolveCourseRecord(state, courseNameOrId);
  const rawItems = Array.isArray(course?.terms?.items) ? course.terms.items : [];
  if (!rawItems.length) return [];

  const decks = Array.isArray(state?.decks) ? state.decks : [];
  const outcome = latestOutcomes(state?.attempts || []);
  const levelOf = (deckId, cardId) => {
    const found = findLiveTermCard(decks, { deckId, cardId });
    if (!found) return null;
    return cardLevel(found.card, outcome(found.deck.id, found.card.id));
  };

  return rawItems.map((item) => {
    const stateValue = termState(item, levelOf);
    const fromFound = item.from ? findLiveTermCard(decks, item.from) : null;
    const fromPrompt = fromFound ? promptExcerpt(fromFound.card?.prompt) : '';
    return {
      term: item.term,
      ...(item.alt ? { alt: item.alt } : {}),
      at: item.at,
      ...(item.from ? { from: item.from } : {}),
      ...(item.card ? { card: item.card } : {}),
      state: stateValue,
      ...(fromPrompt ? { fromPrompt } : {}),
    };
  });
}

/** Return up to 100 most recent known/learned and up to 100 most recent unknown term strings for assist prompts. */
export function coursePromptTerms(state, courseName) {
  const items = courseTermsWithState(state, courseName);
  if (!items.length) return { known: [], unknown: [] };
  const sorted = items
    .map((item, idx) => ({ item, idx, ts: Date.parse(item.at) || 0 }))
    .sort((a, b) => (b.ts - a.ts) || (b.idx - a.idx));

  const known = [];
  const unknown = [];
  for (const { item } of sorted) {
    if (item.state === 'known' || item.state === 'learned') {
      if (known.length < COURSE_TERMS_LIMITS.maxPromptItems) known.push(item.term);
    } else if (unknown.length < COURSE_TERMS_LIMITS.maxPromptItems) {
      unknown.push(item.term);
    }
    if (
      known.length >= COURSE_TERMS_LIMITS.maxPromptItems
      && unknown.length >= COURSE_TERMS_LIMITS.maxPromptItems
    ) {
      break;
    }
  }
  return { known, unknown };
}
