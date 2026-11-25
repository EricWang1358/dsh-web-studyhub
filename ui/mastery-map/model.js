/* Pure data model for the Mastery Graph UI (掌握度图谱界面).
   Combines three real signals into one chapter → knowledge-point projection:
   1. Course outline hierarchy (`course.outline` book.nodes: 章 › 节 › 知识点) & question coverage gaps;
   2. FSRS / attempt mastery counts (`summary` from course.outline or `progress[deckId]` from the library snapshot);
   3. Non-compensatory PointEvidence (`overall`, `facets`, `prereqGaps`, `gapHint`) when an organised outline exists.
   Zero React, zero I/O, zero server-only lib/ imports so it stays browser-safe and testable in Node. */

export const INITIAL_VISIBLE_CHAPTERS = 24;
export const MAX_PREVIEW_DOTS = 16;

export const MASTERY_FILTERS = Object.freeze([
  'all',
  'weak',
  'uncovered',
  'learning',
  'mastered',
  'new',
]);

const EMPTY_COUNTS = Object.freeze({ mastered: 0, familiar: 0, learning: 0, weak: 0, new: 0 });

function normalizeCounts(raw, fallbackTotal = 0) {
  if (!raw || typeof raw !== 'object') {
    return { mastered: 0, familiar: 0, learning: 0, weak: 0, new: Math.max(0, fallbackTotal) };
  }
  return {
    mastered: Number(raw.mastered) || 0,
    familiar: Number(raw.familiar) || 0,
    learning: Number(raw.learning) || 0,
    weak: Number(raw.weak) || 0,
    new: Number(raw.new) || 0,
  };
}

/** Whether a chapter or point needs immediate review (weak cards, due cards, or shaky PointEvidence). */
export function isWeakOrDue(entry) {
  if (!entry) return false;
  return (entry.weak || 0) > 0 || (entry.due || 0) > 0 || entry.evidence?.overall === 'shaky';
}

/** Whether a non-pending chapter or point has neither published questions nor unpublished drafts yet. */
export function isUncovered(entry) {
  if (!entry || entry.pending) return false;
  return (entry.total || 0) === 0 && (entry.draftCards || 0) === 0;
}

/** Semantic state of one knowledge point or chapter. */
export function entryState(entry) {
  if (entry.pending) return 'pending';
  if ((entry.total || 0) === 0) return (entry.draftCards || 0) > 0 ? 'draft-only' : 'uncovered';
  if ((entry.weak || 0) > 0 || entry.evidence?.overall === 'shaky') return 'weak';
  if ((entry.learned || 0) === 0) return 'unlearned';
  if ((entry.mastery || 0) >= 80) return 'mastered';
  return 'learning';
}

/** 5-step heatmap intensity tier ('0'..'4'), plus 'gap', 'draft', 'pending' for uncovered/unbuilt nodes. */
export function masteryTier(entry) {
  if (entry.pending) return 'pending';
  if ((entry.total || 0) === 0) return (entry.draftCards || 0) > 0 ? 'draft' : 'gap';
  const mastery = Number(entry.mastery) || 0;
  const learned = Number(entry.learned) || 0;
  if (!learned && !mastery) return '0';
  if (mastery >= 80) return '4';
  if (mastery >= 55) return '3';
  if (mastery >= 25) return '2';
  return '1';
}

function shapeOutlinePoint(node, sectionTitle = '') {
  const summary = node?.summary || {};
  const total = Number(node?.total ?? summary.total ?? 0);
  const draftCards = Number(summary.draftCards || 0);
  const counts = normalizeCounts(summary.counts, total);
  const learned = Math.max(0, total - counts.new);
  const mastery = total > 0 ? Math.round(Number(summary.percent ?? 0)) : 0;
  const weak = Number(summary.weak ?? counts.weak ?? 0);
  const due = Number(summary.due ?? 0);
  const base = {
    id: node.key || node.id || '',
    key: node.key || '',
    nodeId: node.id || '',
    title: node.title || '',
    intro: node.intro || '',
    sectionTitle,
    kind: 'outline-point',
    pending: Boolean(node.pending),
    total,
    draftCards,
    learned,
    mastery,
    weak,
    due,
    counts,
    examTier: node.tier || null,
    papers: Array.isArray(node.papers) ? node.papers : [],
    resume: node.resume || null,
    evidence: node.evidence || null,
  };
  return { ...base, state: entryState(base), tier: masteryTier(base) };
}

function collectOutlineLeaves(node, sectionTitle = '', out = []) {
  const children = Array.isArray(node?.children) ? node.children : [];
  if (!children.length) {
    out.push(shapeOutlinePoint(node, sectionTitle));
    return out;
  }
  for (const child of children) {
    const grandChildren = Array.isArray(child?.children) ? child.children : [];
    if (grandChildren.length) {
      collectOutlineLeaves(child, child.title || sectionTitle, out);
    } else {
      out.push(shapeOutlinePoint(child, sectionTitle));
    }
  }
  return out;
}

function summarizeChapterPoints(points) {
  let coveredPoints = 0;
  let uncoveredPoints = 0;
  let draftOnlyPoints = 0;
  let weakPoints = 0;
  let masteredPoints = 0;
  for (const point of points) {
    if (point.pending) continue;
    if (point.total > 0) coveredPoints += 1;
    else if (point.draftCards > 0) draftOnlyPoints += 1;
    else uncoveredPoints += 1;
    if (isWeakOrDue(point)) weakPoints += 1;
    if (point.state === 'mastered') masteredPoints += 1;
  }
  return { coveredPoints, uncoveredPoints, draftOnlyPoints, weakPoints, masteredPoints };
}

function buildFromOutlineBook(outline) {
  const book = outline.book;
  const chapters = [];
  const nodes = Array.isArray(book.nodes) ? book.nodes : [];

  for (const node of nodes) {
    const summary = node?.summary || {};
    const total = Number(node?.total ?? summary.total ?? 0);
    const draftCards = Number(summary.draftCards || 0);
    const counts = normalizeCounts(summary.counts, total);
    const learned = Math.max(0, total - counts.new);
    const mastery = total > 0 ? Math.round(Number(summary.percent ?? 0)) : 0;
    const weak = Number(summary.weak ?? counts.weak ?? 0);
    const due = Number(summary.due ?? 0);
    const points = node.pending
      ? []
      : (Array.isArray(node.children) && node.children.length
        ? collectOutlineLeaves(node, '', [])
        : [shapeOutlinePoint(node, '')]);
    const ptStats = summarizeChapterPoints(points);
    const base = {
      id: node.key || node.id || `ch-${chapters.length}`,
      key: node.key || '',
      index: chapters.length,
      kind: 'outline-chapter',
      title: node.title || '',
      intro: node.intro || '',
      pending: Boolean(node.pending),
      pages: node.pages || null,
      total,
      draftCards,
      learned,
      mastery,
      weak,
      due,
      counts,
      resume: node.resume || null,
      points,
      ...ptStats,
    };
    chapters.push({ ...base, state: entryState(base), tier: masteryTier(base) });
  }

  if (book.other && ((book.other.total || 0) > 0 || (book.other.summary?.draftCards || 0) > 0)) {
    const otherPoint = shapeOutlinePoint(book.other, '');
    const ptStats = summarizeChapterPoints([otherPoint]);
    const base = {
      id: book.other.key || 'bk:other',
      key: book.other.key || '',
      index: chapters.length,
      kind: 'outline-other',
      title: book.other.title || '',
      intro: '',
      pending: false,
      total: otherPoint.total,
      draftCards: otherPoint.draftCards,
      learned: otherPoint.learned,
      mastery: otherPoint.mastery,
      weak: otherPoint.weak,
      due: otherPoint.due,
      counts: otherPoint.counts,
      resume: otherPoint.resume,
      points: [otherPoint],
      isOther: true,
      ...ptStats,
    };
    chapters.push({ ...base, state: entryState(base), tier: masteryTier(base) });
  }

  return finalizeModel({
    basis: 'outline',
    course: outline.course ?? null,
    chapters,
    stale: Boolean(book.stale),
    hasBookNotes: Boolean(book.notes),
    papersCount: Number(book.papers || 0),
    unplacedTotal: Number(outline.unplaced?.total || 0),
    totalCardsOverride: Number(outline.total ?? 0),
    overallSummary: outline.summary || null,
  });
}

function buildFromDecks(decks, progress, { course = '*', route = null, outline = null } = {}) {
  const live = (Array.isArray(decks) ? decks : []).filter((d) => d && !d.archived && !d.systemKind);
  const deckById = new Map(live.map((d) => [d.id, d]));
  const orderedIds = route?.chapters?.length
    ? [...route.chapters.map((c) => c.deckId), ...live.map((d) => d.id)]
    : live.map((d) => d.id);
  const seen = new Set();
  const chapters = [];

  for (const deckId of orderedIds) {
    if (seen.has(deckId)) continue;
    seen.add(deckId);
    const deck = deckById.get(deckId);
    if (!deck) continue;
    const p = progress?.[deckId];
    const total = Number(p?.total ?? deck.available ?? 0);
    const counts = normalizeCounts(p?.counts, total);
    const learned = Math.max(0, total - counts.new);
    const mastery = total > 0 ? Math.round(Number(p?.mastery ?? 0)) : 0;
    const weak = Number(counts.weak || 0);
    const due = Number(p?.due || 0);
    const rawTopics = Array.isArray(p?.topics) ? p.topics : [];
    const points = rawTopics.map((t, idx) => {
      const tTotal = Number(t?.total || 0);
      const tCounts = normalizeCounts(t?.counts, tTotal);
      const tLearned = Math.max(0, tTotal - tCounts.new);
      const tMastery = tTotal > 0 ? Math.round(Number(t?.mastery || 0)) : 0;
      const tWeak = Number(tCounts.weak || 0);
      const tDue = Number(t?.due || 0);
      const pBase = {
        id: `${deckId}::${t.name || idx}`,
        key: '',
        deckId,
        topic: t.name || '',
        title: t.name || '',
        sectionTitle: '',
        kind: 'deck-topic',
        pending: false,
        total: tTotal,
        draftCards: 0,
        learned: tLearned,
        mastery: tMastery,
        weak: tWeak,
        due: tDue,
        counts: tCounts,
        examTier: null,
        papers: [],
        resume: null,
        evidence: null,
      };
      return { ...pBase, state: entryState(pBase), tier: masteryTier(pBase) };
    });
    const ptStats = summarizeChapterPoints(points);
    const base = {
      id: deckId,
      key: '',
      deckId,
      index: chapters.length,
      kind: 'deck',
      title: deck.title || '',
      course: deck.course ?? deck.folder ?? '',
      intro: '',
      pending: false,
      total,
      draftCards: 0,
      learned,
      mastery,
      weak,
      due,
      counts,
      resume: null,
      points,
      ...ptStats,
    };
    chapters.push({ ...base, state: entryState(base), tier: masteryTier(base) });
  }

  // Also include uncovered course documents (materials with 0 questions) when outline documents are known.
  const docs = Array.isArray(outline?.documents) ? outline.documents : [];
  for (const doc of docs) {
    const docTotal = Number(doc?.total ?? doc?.summary?.total ?? 0);
    const docDrafts = Number(doc?.summary?.draftCards ?? 0);
    if (docTotal > 0 || docDrafts > 0) continue;
    const docPoint = shapeOutlinePoint({ ...doc, total: 0, summary: doc.summary || {} }, '');
    const ptStats = summarizeChapterPoints([docPoint]);
    const base = {
      id: doc.key || `doc-${chapters.length}`,
      key: doc.key || '',
      index: chapters.length,
      kind: 'document-gap',
      title: doc.title || '',
      intro: '',
      pending: false,
      total: 0,
      draftCards: 0,
      learned: 0,
      mastery: 0,
      weak: 0,
      due: 0,
      counts: { ...EMPTY_COUNTS },
      resume: null,
      points: [docPoint],
      ...ptStats,
    };
    chapters.push({ ...base, state: entryState(base), tier: masteryTier(base) });
  }

  return finalizeModel({
    basis: live.length ? 'decks' : docs.length ? 'documents' : 'empty',
    course,
    chapters,
    stale: false,
    hasBookNotes: false,
    papersCount: 0,
    unplacedTotal: Number(outline?.unplaced?.total || 0),
    totalCardsOverride: null,
    overallSummary: null,
    hasOutlineMaterials: docs.length > 0,
  });
}

function finalizeModel({
  basis,
  course,
  chapters,
  stale,
  hasBookNotes,
  papersCount,
  unplacedTotal,
  totalCardsOverride,
  overallSummary,
  hasOutlineMaterials = false,
}) {
  const totals = {
    chaptersCount: chapters.length,
    pointsCount: 0,
    coveredPoints: 0,
    uncoveredPoints: 0,
    draftOnlyPoints: 0,
    masteredPoints: 0,
    learningPoints: 0,
    weakPoints: 0,
    unlearnedPoints: 0,
    totalCards: 0,
    learnedCards: 0,
    masteredCards: 0,
    familiarCards: 0,
    learningCards: 0,
    weakCards: 0,
    newCards: 0,
    dueCards: 0,
    overallMastery: 0,
  };

  const weakKeys = [];
  const weakScopes = [];
  const uncoveredTitles = [];
  const seenWeakKeys = new Set();
  const seenUncovered = new Set();

  let weightedSum = 0;
  let weightedCards = 0;

  for (const ch of chapters) {
    if (!ch.pending) {
      totals.totalCards += ch.total;
      totals.learnedCards += ch.learned;
      totals.masteredCards += ch.counts.mastered;
      totals.familiarCards += ch.counts.familiar;
      totals.learningCards += ch.counts.learning;
      totals.weakCards += ch.counts.weak;
      totals.newCards += ch.counts.new;
      totals.dueCards += ch.due;
      if (ch.total > 0) {
        weightedSum += ch.mastery * ch.total;
        weightedCards += ch.total;
      }
    }

    const items = ch.points.length ? ch.points : [ch];
    for (const pt of items) {
      if (pt.pending) continue;
      totals.pointsCount += 1;
      if (pt.total > 0) totals.coveredPoints += 1;
      else if (pt.draftCards > 0) totals.draftOnlyPoints += 1;
      else totals.uncoveredPoints += 1;

      if (pt.state === 'mastered') totals.masteredPoints += 1;
      else if (pt.state === 'weak') totals.weakPoints += 1;
      else if (pt.state === 'learning') totals.learningPoints += 1;
      else if (pt.state === 'unlearned') totals.unlearnedPoints += 1;

      if (isWeakOrDue(pt) && pt.total > 0) {
        if (pt.key && !seenWeakKeys.has(pt.key)) {
          seenWeakKeys.add(pt.key);
          weakKeys.push(pt.key);
        } else if (pt.deckId) {
          weakScopes.push(pt.topic ? { deckId: pt.deckId, topic: pt.topic } : { deckId: pt.deckId });
        }
      }
      if (isUncovered(pt) && pt.title && !seenUncovered.has(pt.title)) {
        seenUncovered.add(pt.title);
        uncoveredTitles.push(pt.title);
      }
    }
  }

  if (overallSummary && overallSummary.total > 0) {
    totals.totalCards = overallSummary.total;
    totals.masteredCards = overallSummary.counts?.mastered || 0;
    totals.familiarCards = overallSummary.counts?.familiar || 0;
    totals.learningCards = overallSummary.counts?.learning || 0;
    totals.weakCards = overallSummary.counts?.weak || 0;
    totals.newCards = overallSummary.counts?.new || 0;
    totals.learnedCards = Math.max(0, overallSummary.total - totals.newCards);
    totals.dueCards = overallSummary.due || 0;
    totals.overallMastery = Math.round(Number(overallSummary.percent ?? 0));
  } else {
    if (totalCardsOverride != null && totalCardsOverride > 0 && totals.totalCards === 0) {
      totals.totalCards = totalCardsOverride;
    }
    totals.overallMastery = weightedCards > 0 ? Math.round(weightedSum / weightedCards) : 0;
  }

  const countsByFilter = {
    all: chapters.length,
    weak: 0,
    uncovered: 0,
    learning: 0,
    mastered: 0,
    new: 0,
  };
  for (const ch of chapters) {
    if (chapterMatchesFilter(ch, 'weak')) countsByFilter.weak += 1;
    if (chapterMatchesFilter(ch, 'uncovered')) countsByFilter.uncovered += 1;
    if (chapterMatchesFilter(ch, 'learning')) countsByFilter.learning += 1;
    if (chapterMatchesFilter(ch, 'mastered')) countsByFilter.mastered += 1;
    if (chapterMatchesFilter(ch, 'new')) countsByFilter.new += 1;
  }

  const barNode = {
    counts: {
      mastered: totals.masteredCards,
      familiar: totals.familiarCards,
      learning: totals.learningCards,
      weak: totals.weakCards,
      new: totals.newCards,
    },
    total: totals.totalCards,
    due: totals.dueCards,
    mastery: totals.overallMastery,
    status: !totals.totalCards || totals.newCards === totals.totalCards ? 'todo'
      : totals.overallMastery >= 80 && !totals.weakCards ? 'done' : 'active',
  };

  return {
    basis,
    course,
    chapters,
    totals,
    barNode,
    countsByFilter,
    weakKeys,
    weakScopes,
    uncoveredTitles,
    stale,
    hasBookNotes,
    papersCount,
    unplacedTotal,
    hasOutlineMaterials,
  };
}

/** Build the unified Mastery Map model from `course.outline` (when available) and library deck progress. */
export function buildMasteryMapModel({ outline = null, decks = [], progress = {}, course = '*', route = null } = {}) {
  if (outline?.status === 'ok' && outline.book && Array.isArray(outline.book.nodes) && outline.book.nodes.length > 0) {
    return buildFromOutlineBook(outline);
  }
  return buildFromDecks(decks, progress, { course, route, outline });
}

/** Whether a single knowledge point / topic matches the selected status filter. */
export function pointMatchesFilter(point, filter) {
  switch (filter) {
    case 'weak':
      return isWeakOrDue(point);
    case 'uncovered':
      return isUncovered(point);
    case 'learning':
      return point.total > 0 && point.learned > 0 && !(point.mastery >= 80 && point.weak === 0);
    case 'mastered':
      return point.total > 0 && point.mastery >= 80 && point.weak === 0;
    case 'new':
      return point.total > 0 && point.learned === 0;
    case 'all':
    default:
      return true;
  }
}

/** Whether a chapter matches the selected status filter (based on its points when present, or chapter-level summary otherwise). */
export function chapterMatchesFilter(chapter, filter) {
  const points = chapter.points || [];
  switch (filter) {
    case 'weak':
      return isWeakOrDue(chapter) || points.some((pt) => isWeakOrDue(pt));
    case 'uncovered':
      return (chapter.uncoveredPoints || 0) > 0 || isUncovered(chapter) || points.some((pt) => isUncovered(pt));
    case 'learning':
      return points.length > 0
        ? points.some((pt) => pointMatchesFilter(pt, 'learning'))
        : (chapter.total > 0 && chapter.learned > 0 && !(chapter.mastery >= 80 && chapter.weak === 0));
    case 'mastered':
      return points.length > 0
        ? points.some((pt) => pointMatchesFilter(pt, 'mastered'))
        : (chapter.total > 0 && chapter.mastery >= 80 && chapter.weak === 0);
    case 'new':
      return points.length > 0
        ? points.some((pt) => pointMatchesFilter(pt, 'new'))
        : (chapter.total > 0 && chapter.learned === 0);
    case 'all':
    default:
      return true;
  }
}

/** Filter chapters and annotate matched points when a filter or search query is active. */
export function filterMasteryChapters(chapters, { filter = 'all', query = '' } = {}) {
  const activeFilter = MASTERY_FILTERS.includes(filter) ? filter : 'all';
  const needle = String(query ?? '').trim().toLowerCase();
  const out = [];

  for (const ch of chapters || []) {
    if (!chapterMatchesFilter(ch, activeFilter)) continue;
    if (!needle) {
      const matchedPoints = activeFilter === 'all'
        ? ch.points
        : ch.points.filter((pt) => pointMatchesFilter(pt, activeFilter));
      out.push({ ...ch, matchedPoints });
      continue;
    }
    const chapterHit = (ch.title || '').toLowerCase().includes(needle)
      || (ch.intro || '').toLowerCase().includes(needle);
    const pointHits = ch.points.filter((pt) => (
      pointMatchesFilter(pt, activeFilter)
      && (
        (pt.title || '').toLowerCase().includes(needle)
        || (pt.sectionTitle || '').toLowerCase().includes(needle)
        || (pt.intro || '').toLowerCase().includes(needle)
      )
    ));
    if (chapterHit || pointHits.length > 0) {
      out.push({
        ...ch,
        matchedPoints: pointHits.length > 0
          ? pointHits
          : (activeFilter === 'all' ? ch.points : ch.points.filter((pt) => pointMatchesFilter(pt, activeFilter))),
      });
    }
  }
  return out;
}

/** Compact list of point-state dots to preview a chapter's internal knowledge points on its heatmap tile. */
export function chapterPreviewDots(chapter, max = MAX_PREVIEW_DOTS) {
  const points = Array.isArray(chapter?.points) ? chapter.points : [];
  if (!points.length) return [];
  const slice = points.slice(0, max);
  return slice.map((pt) => ({
    id: pt.id,
    title: pt.title,
    state: pt.state,
    tier: pt.tier,
  }));
}

/** Roving keyboard index navigation for the responsive chapter heatmap grid. */
export function nextMasteryGridIndex(current, key, length, cols = 4) {
  if (!Number.isInteger(length) || length <= 0) return null;
  const step = Math.max(1, Number.isInteger(cols) ? cols : 4);
  const idx = Number.isInteger(current) ? Math.max(0, Math.min(length - 1, current)) : 0;
  switch (key) {
    case 'ArrowRight': return Math.min(length - 1, idx + 1);
    case 'ArrowLeft': return Math.max(0, idx - 1);
    case 'ArrowDown': return Math.min(length - 1, idx + step);
    case 'ArrowUp': return Math.max(0, idx - step);
    case 'Home': return 0;
    case 'End': return length - 1;
    default: return null;
  }
}
