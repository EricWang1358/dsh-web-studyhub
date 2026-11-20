/* Pure, browser-safe state projector feeding `lib/evidence/mistake-triage.js` from frozen library snapshots.
   0-token, zero I/O, WeakMap-cached over frozen `state.sources`. Strictly ignores outline `prereqIds` (§6.3 #3). */

import { courseKey } from '../courses.js';
import { confusablePairs, confusablesView } from '../course-book-confusables.js';
import { leavesOf, withCardNumbers } from '../course-book-card-numbers.js';
import { isCourseBookDocSource, isCourseNotesSource, isCourseOutlineSource } from '../exam-point-list.js';
import { cardLevel, latestOutcomes } from '../mastery.js';
import { triageMistake } from './mistake-triage.js';

const LOOKBACK_TAGS = Object.freeze(['concept', 'condition', 'derivation', 'slip']);
const sourceIndexCache = new WeakMap();
const toPage = val => (val !== null && val !== undefined && val !== '' && Number.isFinite(Number(val)) && Number(val) > 0 ? Math.trunc(Number(val)) : null);

function flatLeaves(nodes, out = []) {
  for (const node of Array.isArray(nodes) ? nodes : []) {
    if (Array.isArray(node?.children) && node.children.length) flatLeaves(node.children, out);
    else if (node) out.push(node);
  }
  return out;
}

function collectLeafPages(leaf, sourceById) {
  const out = [], seen = new Set();
  const add = (sourceId, page) => {
    const p = toPage(page);
    if (p === null) return;
    const sid = typeof sourceId === 'string' ? sourceId.trim() : '', key = `${sid}|${p}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ ...(sid ? { sourceId: sid } : {}), page: p });
  };
  const scanCite = cite => {
    if (!cite || typeof cite !== 'object') return;
    const sid = cite.selection?.sourceId || cite.sourceId || '', src = sid ? sourceById.get(sid) : null;
    add(sid, cite.selection?.page ?? cite.page ?? src?.page ?? src?.document?.page);
  };
  for (const cite of leaf?.body?.cites || []) scanCite(cite);
  for (const unit of leaf?.body?.units || []) {
    for (const r of unit?.read || []) scanCite(r);
    for (const c of unit?.cites || []) scanCite(c);
  }
  for (const anchor of leaf?.anchors || []) {
    const m = typeof anchor === 'string' ? /#p?(\d+)$/i.exec(anchor) : null;
    if (m) add('', Number(m[1]));
  }
  return out;
}

function indexConfusables({ bookSrc, notesSrc, outlineSrc, noteLeaves, hidByLeafId, pagesByLeaf }) {
  const stored = notesSrc?.courseNotes?.confusables;
  if (!Array.isArray(stored) || !stored.length) return [];
  const cardsByLeaf = new Map(noteLeaves.map(l => [l.id, (l.body?.units || []).flatMap(u => u.cards || [])]));
  const rawTree = Array.isArray(bookSrc?.bookDoc?.manifest?.nodes) && bookSrc.bookDoc.manifest.nodes.length
    ? bookSrc.bookDoc.manifest.nodes
    : Array.isArray(outlineSrc?.courseOutline?.nodes)
      ? outlineSrc.courseOutline.nodes
      : noteLeaves.map(l => ({ id: l.id, hid: l.id, leaf: true, title: l.title, cards: cardsByLeaf.get(l.id) || [] }));
  const hydrate = nodes => (Array.isArray(nodes) ? nodes : []).map(node => {
    if (Array.isArray(node?.children) && node.children.length) return { ...node, children: hydrate(node.children) };
    const cards = Array.isArray(node?.cards) && node.cards.length ? node.cards : (cardsByLeaf.get(node.id) || []);
    return { ...node, hid: node.hid || hidByLeafId.get(node.id) || node.id, leaf: true, cards };
  });
  const numbered = withCardNumbers(hydrate(rawTree));
  const leafByCode = new Map();
  for (const leaf of leavesOf(numbered)) {
    for (const card of leaf.cards || []) leafByCode.set(card.code, { id: leaf.id, hid: leaf.hid || leaf.id });
  }
  const pairByKey = new Map(confusablePairs(numbered).map(p => [`${p.a.code}|${p.b.code}`, p]));
  return confusablesView(stored, numbered).map(view => {
    const meta = pairByKey.get(`${view.items[0]}|${view.items[1]}`);
    const aInfo = leafByCode.get(view.items[0]), bInfo = leafByCode.get(view.items[1]);
    return {
      ...view,
      hids: [...new Set([aInfo?.hid, bInfo?.hid].filter(Boolean))],
      leafIds: [...new Set([aInfo?.id, bInfo?.id].filter(Boolean))],
      alts: [meta?.a?.alt, meta?.b?.alt].filter(Boolean),
      sourcePages: [...(pagesByLeaf.get(aInfo?.id) || []), ...(pagesByLeaf.get(bInfo?.id) || [])],
    };
  });
}

function buildCourseIndex(sources) {
  const list = Array.isArray(sources) ? sources : [];
  if (Object.isFrozen(list) && sourceIndexCache.has(list)) return sourceIndexCache.get(list);
  const byId = new Map(), books = new Map(), notes = new Map(), outlines = new Map();
  for (const src of list) {
    if (!src?.id) continue;
    byId.set(src.id, src);
    if (src.archived) continue;
    if (isCourseBookDocSource(src)) { const k = courseKey(src.bookDoc?.course || src.courses?.[0]); if (k) books.set(k, src); }
    else if (isCourseNotesSource(src)) { const k = courseKey(src.courseNotes?.course || src.courses?.[0]); if (k) notes.set(k, src); }
    else if (isCourseOutlineSource(src)) { const k = courseKey(src.courseOutline?.course || src.courses?.[0]); if (k) outlines.set(k, src); }
  }
  const cache = new Map();
  const getCourse = course => {
    const k = courseKey(course);
    if (!k) return { hasBook: false, confusables: [], hidBySourcePage: new Map() };
    if (cache.has(k)) return cache.get(k);
    const bookSrc = books.get(k) || null, notesSrc = notes.get(k) || null, outlineSrc = outlines.get(k) || null;
    const manifestLeaves = flatLeaves(bookSrc?.bookDoc?.manifest?.nodes);
    const hidByLeafId = new Map(manifestLeaves.map(l => [l.id, l.hid || l.id]));
    const noteLeaves = notesSrc?.courseNotes?.leaves || [];
    const pagesByLeaf = new Map(), hidBySourcePage = new Map();
    for (const leaf of noteLeaves) {
      if (!leaf?.id) continue;
      const pages = collectLeafPages(leaf, byId), hid = hidByLeafId.get(leaf.id) || leaf.id;
      pagesByLeaf.set(leaf.id, pages);
      for (const sp of pages) if (sp.sourceId) hidBySourcePage.set(`${sp.sourceId}|${sp.page}`, hid);
    }
    const entry = {
      hasBook: Boolean(manifestLeaves.length || noteLeaves.length),
      confusables: indexConfusables({ bookSrc, notesSrc, outlineSrc, noteLeaves, hidByLeafId, pagesByLeaf }),
      hidBySourcePage,
    };
    cache.set(k, entry);
    return entry;
  };
  const result = { getCourse };
  if (Object.isFrozen(list)) sourceIndexCache.set(list, result);
  return result;
}

function wrongOptionsOf(card, feedback, attempt) {
  const selected = Array.isArray(feedback?.selected) ? feedback.selected : Array.isArray(attempt?.selected) ? attempt.selected : [];
  if (!selected.length || !Array.isArray(card?.options)) return [];
  const picked = new Set(selected);
  return card.options.filter(o => o && picked.has(o.id) && o.correct !== true && typeof o.text === 'string' && o.text.trim()).map(o => o.text.trim());
}

/** Build a reusable per-snapshot triage projector (O(1) amortized per row; zero I/O, 0-token). */
export function createTriageProjector(state = {}) {
  const index = buildCourseIndex(state.sources);
  const outcome = latestOutcomes(state.attempts);
  const decksById = new Map((Array.isArray(state.decks) ? state.decks : []).map(d => [d.id, d]));
  const runsById = new Map((Array.isArray(state.runs) ? state.runs : []).map(r => [r.id, r]));
  const sessionsById = new Map((Array.isArray(state.studySessions) ? state.studySessions : []).map(s => [s.id, s]));

  function buildInput({ deck, card, entryCard = null, feedback = null, attempt = null, errorReason, stubborn = false, location = null, returnDepth }) {
    const resolvedDeck = deck || (card?.deckId ? decksById.get(card.deckId) : null);
    const course = resolvedDeck?.course ?? resolvedDeck?.folder ?? '';
    const ctx = index.getCourse(course);
    let resolvedFeedback = feedback, shownCard = entryCard || card;
    if (!resolvedFeedback && attempt?.runId) {
      const entry = runsById.get(attempt.runId)?.entries?.findLast(e => e?.card?.id === card?.id && !e.retry && e.feedback);
      if (entry) { resolvedFeedback = entry.feedback; shownCard = entry.card || shownCard; }
    }
    const page = location?.page ?? card?.page ?? card?.citations?.[0]?.selection?.page ?? card?.citations?.[0]?.page ?? card?.selections?.[0]?.page ?? null;
    const sourceId = location?.sourceId ?? card?.sourceId ?? card?.citations?.[0]?.selection?.sourceId ?? card?.citations?.[0]?.sourceId ?? card?.selections?.[0]?.sourceId ?? '';
    const hid = String(card?.hid || (sourceId && page != null ? ctx.hidBySourcePage.get(`${sourceId}|${page}`) : '') || '').trim();
    // STRICTLY obey §6.3 #3: prerequisites come ONLY from card.requires, never outline prereqIds.
    const prereqCards = (Array.isArray(card?.requires) ? card.requires : []).flatMap(ref => {
      const preDeck = decksById.get(ref?.deckId);
      const preCard = preDeck && !preDeck.archived && preDeck.systemKind !== 'slain'
        ? (preDeck.cards || []).find(c => c.id === ref?.cardId && !c.suspended) : null;
      if (!preCard) return [];
      return [{ deckId: preDeck.id, cardId: preCard.id, level: cardLevel(preCard, outcome(preDeck.id, preCard.id)), topic: preCard.topic || '', prompt: preCard.prompt || '' }];
    });
    const run = attempt?.runId ? runsById.get(attempt.runId) : null;
    const session = run?.branchOf?.sessionId ? sessionsById.get(run.branchOf.sessionId) : null;
    return {
      errorReason: errorReason !== undefined ? errorReason : (attempt?.errorReason ?? null),
      stubborn: Boolean(stubborn),
      wrongOptions: wrongOptionsOf(shownCard, resolvedFeedback, attempt),
      hid,
      hasBook: ctx.hasBook,
      page,
      sourceId,
      citations: [...(card?.citations || []), ...(card?.selections || [])],
      confusables: ctx.confusables,
      prereqCards,
      returnDepth: returnDepth !== undefined ? returnDepth : (session?.returnPath?.length ?? 0),
      course,
    };
  }

  return {
    projectCard: opts => triageMistake(buildInput(opts)),
    projectRowTriage(opts) {
      const base = buildInput(opts);
      const triage = triageMistake(base);
      const triageByReason = { default: triageMistake({ ...base, errorReason: null }) };
      for (const tag of LOOKBACK_TAGS) triageByReason[tag] = triageMistake({ ...base, errorReason: tag });
      return { triage, triageByReason, hid: base.hid || '' };
    },
  };
}
