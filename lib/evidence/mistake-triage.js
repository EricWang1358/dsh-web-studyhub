/* Deterministic 0-Token Mistake-Triage Routing Engine (StudyHub 5.0.0 §3.5.3 #2):
   Pure, browser-safe, zero I/O, zero model calls.
   - Explicit errorReason routing: slip, concept, condition, derivation, prerequisite (card.requires ONLY per §6.3 #3), bad_question.
   - Mandatory 3-step unlabeled default route: 1) C001 confusable match -> concept, 2) Stubborn -> rescue_companion, 3) fsrs_only.
   - Fragile-correct helper (slowCorrect / barely 3) recommending 0-token lookover/retell/variant without polluting FSRS. */

export const TRIAGE_REASONS = Object.freeze(['concept', 'condition', 'derivation', 'slip', 'prerequisite', 'bad_question']);
export const TRIAGE_ROUTES = Object.freeze(['fsrs_only', 'confusable_contrast', 'book_retell', 'rescue_companion', 'prereq_branch', 'fix_question']);
export const FRAGILE_ROUTES = Object.freeze(['book_lookover', 'book_retell', 'unseen_variant']);
export const MAX_PREREQ_BRANCH_DEPTH = 5;

const REASON_SET = new Set(TRIAGE_REASONS);
const SLOW_MIN_MS = 25_000;
const SLOW_SOLO_MS = 60_000;

const norm = value => String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
const cleanId = value => (typeof value === 'string' ? value.trim() : '');
const toPage = value => (value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)) && Number(value) > 0 ? Math.trunc(Number(value)) : null);

function collectCardPageRefs({ page = null, sourceId = '', citations = [] } = {}) {
  const refs = [], seen = new Set();
  const push = (sid, pg) => {
    const p = toPage(pg);
    if (p === null) return;
    const s = cleanId(sid), key = `${s}|${p}`;
    if (seen.has(key)) return;
    seen.add(key);
    refs.push({ sourceId: s, page: p });
  };
  for (const cite of Array.isArray(citations) ? citations : []) {
    if (cite && typeof cite === 'object') push(cite.selection?.sourceId || cite.sourceId || sourceId, cite.selection?.page ?? cite.page);
  }
  push(sourceId, page);
  return refs;
}

function pairHasPage(pair, cardRefs) {
  if (!cardRefs.length) return false;
  for (const sp of Array.isArray(pair?.sourcePages) ? pair.sourcePages : []) {
    const p = toPage(sp?.page ?? sp), sid = cleanId(sp?.sourceId);
    if (p !== null && cardRefs.some(ref => ref.page === p && (!sid || !ref.sourceId || sid === ref.sourceId))) return true;
  }
  for (const raw of Array.isArray(pair?.pages) ? pair.pages : []) {
    const p = toPage(raw);
    if (p !== null && cardRefs.some(ref => ref.page === p)) return true;
  }
  return false;
}

function pairMatchesOption(pair, wrongNorms) {
  if (!wrongNorms.length) return false;
  const terms = [...(Array.isArray(pair?.names) ? pair.names : []), ...(Array.isArray(pair?.alts) ? pair.alts : [])]
    .map(norm).filter(term => term.length >= 2);
  return terms.length > 0 && wrongNorms.some(opt => terms.some(term => opt === term || opt.includes(term) || (opt.length >= 3 && term.includes(opt))));
}

function compactConfusable(pair, matchBy) {
  return {
    id: cleanId(pair.id),
    items: Array.isArray(pair.items) ? [...pair.items] : [],
    names: Array.isArray(pair.names) ? [...pair.names] : [],
    hids: Array.isArray(pair.hids) ? [...pair.hids] : [],
    rows: Array.isArray(pair.rows) ? pair.rows.map(r => ({ aspect: r.aspect, cells: [...(r.cells || [])] })) : [],
    matchBy,
  };
}

/** Match a missed card against course C001 confusable pairs by wrong option text, hid, or source page (first specificity tier wins). */
export function matchConfusablePair(confusables, { wrongOptions = [], hid = '', page = null, sourceId = '', citations = [] } = {}) {
  const pairs = Array.isArray(confusables) ? confusables.filter(p => p && typeof p === 'object') : [];
  if (!pairs.length) return null;

  const wrongNorms = (Array.isArray(wrongOptions) ? wrongOptions : []).map(norm).filter(Boolean);
  if (wrongNorms.length) {
    const hit = pairs.find(pair => pairMatchesOption(pair, wrongNorms));
    if (hit) return compactConfusable(hit, 'wrong_option');
  }

  const hidNorm = norm(hid);
  if (hidNorm) {
    const hit = pairs.find(pair => [...(Array.isArray(pair.hids) ? pair.hids : []), ...(Array.isArray(pair.leafIds) ? pair.leafIds : [])].some(id => norm(id) === hidNorm));
    if (hit) return compactConfusable(hit, 'hid');
  }

  const cardRefs = collectCardPageRefs({ page, sourceId, citations });
  if (cardRefs.length) {
    const hit = pairs.find(pair => pairHasPage(pair, cardRefs));
    if (hit) return compactConfusable(hit, 'page');
  }

  return null;
}

/**
 * Compute deterministic 0-token triage route for a missed question.
 * Strictly ignores outline `prereqIds` / `prereqGaps` (§6.3 #3): `prerequisite` uses ONLY unresolved `prereqCards` from `card.requires`.
 */
export function triageMistake(input = {}) {
  const rawReason = cleanId(input.errorReason);
  const reason = REASON_SET.has(rawReason) ? rawReason : null;
  const stubborn = Boolean(input.stubborn);
  const hid = cleanId(input.hid);
  const hasBook = input.hasBook !== undefined ? Boolean(input.hasBook) : Boolean(hid);
  const returnDepth = Number.isInteger(input.returnDepth) && input.returnDepth >= 0 ? input.returnDepth : 0;
  const course = cleanId(input.course);
  const base = { ...(course ? { course } : {}), ...(hid ? { hid } : {}) };
  const confusable = matchConfusablePair(input.confusables, {
    wrongOptions: input.wrongOptions, hid, page: input.page, sourceId: input.sourceId, citations: input.citations,
  });

  if (reason) {
    if (reason === 'slip') return { route: 'fsrs_only', reason: 'slip', source: 'explicit', tokens: 'zero' };
    if (reason === 'concept') {
      if (confusable) return { route: 'confusable_contrast', reason: 'concept', source: 'explicit', tokens: 'zero', ...base, confusable };
      if (hasBook && hid) return { route: 'book_retell', reason: 'concept', source: 'explicit', tokens: 'light', ...base };
      if (stubborn) return { route: 'rescue_companion', reason: 'concept', source: 'explicit', tokens: 'light', ...base, rescueFocus: 'concept', fallback: true };
      return { route: 'fsrs_only', reason: 'concept', source: 'explicit', tokens: 'zero', fallback: true };
    }
    if (reason === 'condition' || reason === 'derivation') {
      return { route: 'rescue_companion', reason, source: 'explicit', tokens: 'light', ...base, rescueFocus: reason };
    }
    if (reason === 'prerequisite') {
      const unresolved = (Array.isArray(input.prereqCards) ? input.prereqCards : [])
        .filter(item => item && item.deckId && item.cardId && item.level !== 'mastered' && item.mastered !== true);
      if (unresolved.length > 0 && returnDepth < MAX_PREREQ_BRANCH_DEPTH) {
        const first = unresolved[0];
        return {
          route: 'prereq_branch',
          reason: 'prerequisite',
          source: 'explicit',
          tokens: 'zero',
          ...base,
          prereq: { deckId: first.deckId, cardId: first.cardId, ...(first.topic ? { topic: first.topic } : {}), ...(first.prompt ? { prompt: first.prompt } : {}) },
          prereqRefs: unresolved.map(item => ({ deckId: item.deckId, cardId: item.cardId })),
        };
      }
      if (hasBook && hid) return { route: 'book_retell', reason: 'prerequisite', source: 'explicit', tokens: 'light', ...base, fallback: true };
      return { route: 'rescue_companion', reason: 'prerequisite', source: 'explicit', tokens: 'light', ...base, rescueFocus: 'prerequisite', fallback: true };
    }
    if (reason === 'bad_question') return { route: 'fix_question', reason: 'bad_question', source: 'explicit', tokens: 'light', ...base };
  }

  // Unlabeled mandatory 3-step default route (first match wins):
  if (confusable) return { route: 'confusable_contrast', reason: 'concept', source: 'default', tokens: 'zero', ...base, confusable };
  if (stubborn) return { route: 'rescue_companion', reason: null, source: 'default', tokens: 'light', ...base, rescueFocus: 'stubborn' };
  return { route: 'fsrs_only', reason: null, source: 'default', tokens: 'zero' };
}

/**
 * Pure 0-token recommendation for fragile-correct answers (slowCorrect / hesitant / barely grade 3) without altering errorReason or FSRS.
 * Returns null when the answer was not correct or not fragile.
 */
export function triageFragileCorrect(input = {}) {
  const grade = Number.isFinite(input.grade) ? Number(input.grade) : null;
  const passed = input.passed !== undefined ? Boolean(input.passed) : (grade !== null ? grade >= 3 : false);
  if (!passed) return null;

  const elapsedMs = Number.isFinite(input.elapsedMs) ? Number(input.elapsedMs) : null;
  const medianMs = Number.isFinite(input.medianMs) && input.medianMs > 0 ? Number(input.medianMs) : null;
  const isSlow = Boolean(input.slowCorrect || input.hesitant)
    || (elapsedMs !== null && ((medianMs !== null && elapsedMs >= SLOW_MIN_MS && elapsedMs >= medianMs * 3) || elapsedMs >= SLOW_SOLO_MS));
  const isBarely = grade === 3;
  if (!isSlow && !isBarely) return null;

  const hid = cleanId(input.hid);
  const hasBook = input.hasBook !== undefined ? Boolean(input.hasBook) : Boolean(hid);
  const course = cleanId(input.course);
  const signal = isSlow ? 'slow_correct' : 'barely_pass';
  const route = hasBook ? (hid && input.retellGap ? 'book_retell' : 'book_lookover') : 'unseen_variant';

  return {
    route,
    signal,
    tokens: 'zero',
    pollutesFsrs: false,
    ...(course ? { course } : {}),
    ...(hid ? { hid } : {}),
    alternatives: hasBook ? ['book_lookover', 'book_retell', 'unseen_variant'] : ['unseen_variant'],
  };
}
