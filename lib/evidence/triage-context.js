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
const docKeyOf = src => (typeof src?.document?.id === 'string' && src.document.id.trim() ? `doc:${src.document.id.trim()}` : '');

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
    const p = toPage(page), sid = typeof sourceId === 'string' ? sourceId.trim() : '', key = `${sid}|${p}`;
    if (p === null || seen.has(key)) return;
    seen.add(key);
    out.push({ ...(sid ? { sourceId: sid } : {}), page: p });
  };
  const scanCite = cite => {
    if (!cite || typeof cite !== 'object') return;
    const sid = cite.selection?.sourceId || cite.sourceId || '', src = sid ? sourceById.get(sid) : null;
    const pg = cite.selection?.page ?? cite.page ?? src?.page ?? src?.document?.page;
    add(sid, pg);
    const dk = docKeyOf(src);
    if (dk) add(dk, pg);
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
  const numbered = withCardNumbers(hydrate(rawTree)), leafByCode = new Map();
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
    const noteLeaves = notesSrc?.courseNotes?.leaves || [], pagesByLeaf = new Map(), hidBySourcePage = new Map();
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
  const result = { byId, getCourse };
  if (Object.isFrozen(list)) sourceIndexCache.set(list, result);
  return result;
}

function wrongOptionsOf(card, feedback, attempt) {
  const selected = Array.isArray(feedback?.selected) ? feedback.selected : Array.isArray(attempt?.selected) ? attempt.selected : [];
  if (!selected.length || !Array.isArray(card?.options)) return [];
  const picked = new Set(selected);
  return card.options.filter(o => o && picked.has(o.id) && o.correct !== true && typeof o.text === 'string' && o.text.trim()).map(o => o.text.trim());
}

function resolveCardCitations(card, byId) {
  const out = [];
  for (const c of [...(card?.citations || []), ...(card?.selections || [])]) {
    if (!c || typeof c !== 'object') continue;
    const sid = c.selection?.sourceId || c.sourceId || '', src = sid ? byId.get(sid) : null;
    const pg = toPage(c.selection?.page ?? c.page ?? src?.page ?? src?.document?.page), dk = docKeyOf(src);
    out.push(pg !== null ? { ...c, ...(sid ? { sourceId: sid } : {}), page: pg } : c);
    if (dk && pg !== null) out.push({ sourceId: dk, page: pg });
  }
  return out;
}

/** Build a reusable per-snapshot triage projector (O(1) amortized per row; zero I/O, 0-token). */
export function createTriageProjector(state = {}) {
  const index = buildCourseIndex(state.sources), outcome = latestOutcomes(state.attempts);
  const decksById = new Map((Array.isArray(state.decks) ? state.decks : []).map(d => [d.id, d]));
  const runsById = new Map((Array.isArray(state.runs) ? state.runs : []).map(r => [r.id, r]));
  const sessionsById = new Map((Array.isArray(state.studySessions) ? state.studySessions : []).map(s => [s.id, s]));

  function buildInput({ deck, card, entryCard = null, feedback = null, attempt = null, errorReason, stubborn = false, location = null, returnDepth }) {
    const resolvedDeck = deck || (card?.deckId ? decksById.get(card.deckId) : null);
    const course = resolvedDeck?.course ?? resolvedDeck?.folder ?? '', ctx = index.getCourse(course);
    const run = attempt?.runId ? runsById.get(attempt.runId) : null;
    let resolvedFeedback = feedback, shownCard = entryCard || card;
    if (!resolvedFeedback && run) {
      const entry = run.entries?.findLast(e => e?.card?.id === card?.id && (!resolvedDeck?.id || (e.deckId ?? run.deckId) === resolvedDeck.id) && !e.retry && e.feedback);
      if (entry) { resolvedFeedback = entry.feedback; shownCard = entry.card || shownCard; }
    }
    const citations = resolveCardCitations(card, index.byId);
    const sourceId = location?.sourceId ?? card?.sourceId ?? citations[0]?.selection?.sourceId ?? citations[0]?.sourceId ?? '';
    const topSrc = sourceId ? index.byId.get(sourceId) : null, topDoc = docKeyOf(topSrc);
    const page = location?.page ?? card?.page ?? citations[0]?.page ?? topSrc?.page ?? topSrc?.document?.page ?? null;
    if (topDoc && toPage(page) !== null) citations.push({ sourceId: topDoc, page: toPage(page) });
    let hid = String(card?.hid || (sourceId && page != null ? ctx.hidBySourcePage.get(`${sourceId}|${page}`) : '') || (topDoc && page != null ? ctx.hidBySourcePage.get(`${topDoc}|${page}`) : '') || '').trim();
    if (!hid) for (const c of citations) { if (c?.sourceId && c?.page != null) { hid = ctx.hidBySourcePage.get(`${c.sourceId}|${c.page}`) || ''; if (hid) break; } }
    // STRICTLY obey §6.3 #3: prerequisites come ONLY from card.requires, never outline prereqIds.
    const prereqCards = (Array.isArray(card?.requires) ? card.requires : []).flatMap(ref => {
      const preDeck = decksById.get(ref?.deckId);
      const preCard = preDeck && !preDeck.archived && preDeck.systemKind !== 'slain' ? (preDeck.cards || []).find(c => c.id === ref?.cardId && !c.suspended) : null;
      return preCard ? [{ deckId: preDeck.id, cardId: preCard.id, level: cardLevel(preCard, outcome(preDeck.id, preCard.id)), topic: preCard.topic || '', prompt: preCard.prompt || '' }] : [];
    });
    const session = run?.branchOf?.sessionId ? sessionsById.get(run.branchOf.sessionId) : null;
    return {
      errorReason: errorReason !== undefined ? errorReason : (attempt?.errorReason ?? null),
      stubborn: Boolean(stubborn), wrongOptions: wrongOptionsOf(shownCard, resolvedFeedback, attempt),
      hid, hasBook: ctx.hasBook, page, sourceId, citations, confusables: ctx.confusables, prereqCards,
      returnDepth: returnDepth !== undefined ? returnDepth : (session?.returnPath?.length ?? 0), course,
    };
  }

  return {
    projectCard: opts => triageMistake(buildInput(opts)),
    projectRowTriage(opts) {
      const base = buildInput(opts), triage = triageMistake(base);
      const triageByReason = { default: triageMistake({ ...base, errorReason: null }) };
      for (const tag of LOOKBACK_TAGS) triageByReason[tag] = triageMistake({ ...base, errorReason: tag });
      return { triage, triageByReason, hid: base.hid || '' };
    },
  };
}
