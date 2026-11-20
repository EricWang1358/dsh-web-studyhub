/* Course-level PointEvidence projection over full library state (book hid -> outline leaf -> document chapter -> deck topic).
   Uses the exact same row/span placement as `course.outline`, `book.crunch`, and `course.custom.readiness`,
   delegating all core evidence logic to the browser-safe `lib/evidence/point-evidence.js`. Zero I/O, 0-token. */

import { localDate } from '../board-model.js';
import { daysBetween, isDate } from '../crunch-plan.js';
import { crunchWindow } from '../book-settings.js';
import { currentCourse } from '../focus.js';
import { stateFocusPredicate } from '../focus-points.js';
import { courseExamByName } from '../card-schedule.js';
import { buildOutlineIndex, chapterKey, inSpan, refKey, restKey } from '../course-outline-index.js';
import { bookLayout, bookKey } from '../course-outline-book-view.js';
import { isCourseBookDocSource, isCourseOutlineSource } from '../exam-point-list.js';
import {
  companionsForPoint,
  evaluatePointEvidence,
  fallbackCourseEvidence,
  finalizeCourseEvidence,
  questionSolidity,
} from './point-evidence.js';

export {
  SOLID_DAYS,
  cardSolid,
  pointSolid,
  computeOverall,
  questionSolidity,
  evaluatePointEvidence,
  resolvePrereqGaps,
  derivePointGapHint,
} from './point-evidence.js';

// WeakMap index of course outlines & review book records over frozen `sources` arrays so O(1) checks stay sub-millisecond even on 1,000+ sources.
const sourceMetaCache = new WeakMap();
function sourceMetaOf(sources) {
  const list = Array.isArray(sources) ? sources : [];
  const frozen = Object.isFrozen(list);
  if (frozen && sourceMetaCache.has(list)) return sourceMetaCache.get(list);
  const outlinesByCourse = new Map();
  const booksByCourse = new Map();
  for (const source of list) {
    if (!source || source.archived) continue;
    if (isCourseOutlineSource(source) && source.courseOutline.version === 1) {
      const names = (source.courses || []).length ? source.courses : [''];
      for (const name of names) {
        const prev = outlinesByCourse.get(name);
        if (!prev || String(source.createdAt ?? '').localeCompare(String(prev.createdAt ?? '')) > 0
          || (String(source.createdAt ?? '') === String(prev.createdAt ?? '') && String(source.id).localeCompare(String(prev.id)) > 0)) {
          outlinesByCourse.set(name, source);
        }
      }
    } else if (isCourseBookDocSource(source)) {
      const name = source.bookDoc.course;
      if (!booksByCourse.has(name)) booksByCourse.set(name, source);
    }
  }
  const meta = { outlinesByCourse, booksByCourse };
  if (frozen) sourceMetaCache.set(list, meta);
  return meta;
}

function currentCourseOutlineLite(sources, course) {
  if (typeof course !== 'string' || course === '*') return null;
  return sourceMetaOf(sources).outlinesByCourse.get(course) ?? null;
}

const bookRecordLite = (sources, course) =>
  (typeof course === 'string' ? sourceMetaOf(sources).booksByCourse.get(course) ?? null : null);

function layoutOfIndex(index) {
  const rows = new Map();
  for (const item of index.documents) {
    const chapters = (item.chapters || []).map(chapter => ({
      key: chapterKey(item.key, chapter.index),
      kind: 'chapter',
      index: chapter.index,
      title: chapter.title,
      nodes: [chapterKey(item.key, chapter.index)],
    }));
    if (chapters.length && (index.nodes.has(restKey(item.key)) || index.draftNodes.has(restKey(item.key)))) {
      chapters.push({ key: restKey(item.key), kind: 'rest', title: item.title, nodes: [restKey(item.key)] });
    }
    for (const chapter of chapters) rows.set(chapter.key, chapter);
    rows.set(item.key, {
      key: item.key,
      kind: 'document',
      item,
      chapters,
      nodes: chapters.length ? chapters.flatMap(chapter => chapter.nodes) : [item.key],
    });
  }
  return rows;
}

function entriesForRow(index, row) {
  if (!row) return [];
  const refs = new Map();
  for (const node of row.nodes || []) {
    for (const [ref, order] of index.nodes.get(node) || []) if (!refs.has(ref)) refs.set(ref, order);
  }
  for (const span of row.spans || []) {
    for (const node of span.nodes) {
      for (const [ref, order] of index.nodes.get(node) || []) if (!refs.has(ref) && inSpan(span, order, span.sources)) refs.set(ref, order);
    }
  }
  return [...refs.keys()].map(ref => index.cards.get(ref)).filter(Boolean);
}

const flatOutlineLeaves = nodes =>
  (Array.isArray(nodes) ? nodes : []).flatMap(node => (node?.children?.length ? flatOutlineLeaves(node.children) : node ? [node] : []));

const flatManifestLeaves = nodes =>
  (Array.isArray(nodes) ? nodes : []).flatMap(node => (node?.leaf ? [node] : flatManifestLeaves(node?.children)));

// Small bounded memo over frozen library states / revisions (avoids recomputing across crunch, readiness, outline, learnerFacts, study.scene.get).
const summaryMemo = new Map();
const SUMMARY_MEMO_MAX = 16;

function memoKeyFor(state, course, today, root) {
  const parts = [state?.sources, state?.documents, state?.decks, state?.attempts, state?.courses, state?.learner];
  const stable = state?.revision !== undefined || parts.every(part => part === undefined || Object.isFrozen(part));
  if (!stable) return null;
  const book = bookRecordLite(state?.sources, course);
  return {
    key: JSON.stringify([root || '', state?.revision ?? null, course, today, book?.bookDoc?.revision ?? null, state?.settings?.book?.crunchWindowDays ?? null]),
    parts,
  };
}

function computeSummaryEntry(state, args = {}, { root = '', now = Date.now() } = {}) {
  const rawCourse = args?.course === undefined ? currentCourse(state) : args.course;
  if (rawCourse === null || rawCourse === undefined || rawCourse === '*' || typeof rawCourse !== 'string') {
    return {
      value: {
        status: 'no-course',
        course: null,
        basis: 'fallback',
        examDate: null,
        daysLeft: null,
        examNear: false,
        points: [],
        summary: { total: 0, unstarted: 0, shaky: 0, in_progress: 0, solid: 0 },
      },
      byCard: new Map(),
    };
  }
  const course = rawCourse;
  const today = isDate(args?.date) ? args.date : localDate(new Date(now));
  const memoInfo = memoKeyFor(state, course, today, root);
  if (memoInfo) {
    const cached = summaryMemo.get(memoInfo.key);
    if (cached && cached.parts.every((part, i) => part === memoInfo.parts[i])) return cached;
  }

  const courseRec = (state?.courses || []).find(item => item && item.name === course) ?? null;
  const examDate = courseExamByName(state, course)?.date ?? null;
  const daysLeft = isDate(examDate) ? daysBetween(today, examDate) : null;
  const windowDays = crunchWindow(state?.settings?.book);
  const examNear = daysLeft !== null && daysLeft >= 0 && daysLeft <= windowDays;
  const examAheadNow = daysLeft !== null && daysLeft >= 1;

  const exposures = state?.learner?.solutionExposures;
  const solidity = questionSolidity(state?.attempts, { exposures });
  const isFocus = stateFocusPredicate(state);
  const cardAt = new Map();
  const compCardLinks = new Map();
  for (const deck of Array.isArray(state?.decks) ? state.decks : []) {
    if (deck?.archived) continue;
    for (const card of deck?.cards || []) {
      if (!card || card.suspended) continue;
      cardAt.set(refKey(deck.id, card.id), { deck, card });
      const cid = card.companionRef?.companionId;
      if (cid) {
        if (!compCardLinks.has(cid)) compCardLinks.set(cid, []);
        compCardLinks.get(cid).push(card.id);
      }
    }
  }
  const courseCompanions = (Array.isArray(courseRec?.companions) ? courseRec.companions : []).map(comp => ({
    ...comp,
    _linkedCardIds: compCardLinks.get(comp?.id) || [],
  }));

  const outlineRec = currentCourseOutlineLite(state?.sources, course);
  const bookRec = bookRecordLite(state?.sources, course);
  const marks = bookRec?.bookDoc?.marks || {};
  const index = buildOutlineIndex(state, { course, now });
  const layout = layoutOfIndex(index);

  const shapeCard = entry => {
    const pair = cardAt.get(refKey(entry.deckId, entry.cardId));
    const card = pair?.card ?? null;
    const deck = pair?.deck ?? null;
    const sol = solidity({ ...entry, card });
    return {
      ...sol,
      deckId: entry.deckId,
      cardId: entry.cardId,
      level: entry.level,
      card,
      review: card?.review ?? null,
      answeredForExam: entry.level !== 'new',
      focus: Boolean(card && deck && isFocus(deck, card)),
    };
  };

  const examCtx = examAheadNow ? { examDate, today, settings: state?.settings } : null;
  const byCard = new Map();
  let value;

  if (outlineRec?.courseOutline) {
    const outline = outlineRec.courseOutline;
    const book = bookLayout(layout, outline);
    const manifestLeaves = flatManifestLeaves(bookRec?.bookDoc?.manifest?.nodes);
    const manifestById = new Map(manifestLeaves.map(leaf => [leaf.id, leaf]));
    const basis = manifestLeaves.length ? 'book' : 'outline';

    const leaves = flatOutlineLeaves(outline.nodes);
    const hidByNodeId = new Map();
    for (const leaf of leaves) {
      const m = manifestById.get(leaf.id);
      hidByNodeId.set(leaf.id, m?.hid || leaf.id);
    }

    const points = [];
    for (const leaf of leaves) {
      const m = manifestById.get(leaf.id);
      const hid = m?.hid || leaf.id;
      const key = bookKey(leaf.id);
      const row = book.rows.get(key);
      const entries = entriesForRow(index, row);
      const cards = entries.map(shapeCard);
      const cardIds = new Set(entries.map(entry => entry.cardId));
      const rawPrereqs = Array.isArray(leaf.prereqIds) ? leaf.prereqIds
        : Array.isArray(m?.prereqIds) ? m.prereqIds : [];
      const mappedPrereqs = rawPrereqs.map(id => hidByNodeId.get(id) || id);
      const companions = companionsForPoint(courseCompanions, { hid, nodeId: leaf.id, cardIds });
      const point = evaluatePointEvidence({
        hid,
        nodeId: leaf.id,
        key,
        title: m?.title || leaf.title || '',
        cards,
        bookRetell: marks.retell?.[hid] || marks.retell?.[leaf.id] || null,
        confusableMark: marks.confusables?.[hid] ?? marks.confusable?.[hid] ?? null,
        templateMark: marks.templates?.[hid] ?? marks.examKit?.[hid] ?? null,
        companions,
        exam: examCtx,
        prereqIds: mappedPrereqs,
      });
      points.push(point);
      for (const entry of entries) {
        const ck = refKey(entry.deckId, entry.cardId);
        if (!byCard.has(ck)) byCard.set(ck, point);
      }
    }
    value = finalizeCourseEvidence({ course, basis, examDate, daysLeft, examNear, points });
  } else if (index.documents.length > 0) {
    const points = [];
    for (const doc of index.documents) {
      const docRow = layout.get(doc.key);
      const rows = docRow?.chapters?.length ? docRow.chapters : (docRow ? [docRow] : []);
      for (const row of rows) {
        const entries = entriesForRow(index, row);
        const cards = entries.map(shapeCard);
        const cardIds = new Set(entries.map(entry => entry.cardId));
        const hid = `doc:${row.key}`;
        const point = evaluatePointEvidence({
          hid,
          key: row.key,
          title: row.title || doc.title || '',
          cards,
          companions: companionsForPoint(courseCompanions, { hid, cardIds }),
          exam: examCtx,
        });
        points.push(point);
        for (const entry of entries) {
          const ck = refKey(entry.deckId, entry.cardId);
          if (!byCard.has(ck)) byCard.set(ck, point);
        }
      }
    }
    value = finalizeCourseEvidence({ course, basis: 'fallback', examDate, daysLeft, examNear, points });
  } else {
    value = fallbackCourseEvidence(state, { course, date: today }, { now });
  }

  const entry = { parts: memoInfo?.parts ?? null, value, byCard };
  if (memoInfo) {
    summaryMemo.set(memoInfo.key, entry);
    if (summaryMemo.size > SUMMARY_MEMO_MAX) summaryMemo.delete(summaryMemo.keys().next().value);
  }
  return entry;
}

/**
 * Pure course-level PointEvidence summary (`course.evidence.summary` & unified planner input).
 */
export function courseEvidenceSummary(state, args = {}, options = {}) {
  return computeSummaryEntry(state, args, options).value;
}

/**
 * Look up the PointEvidence owning a given `(deckId, cardId)` in a course (used by study.scene.get & daily-plan).
 * Pass `{ outlineOnly: true }` for O(1) short-circuit when the course has no outline/review book.
 */
export function pointEvidenceForCard(state, { course, deckId, cardId, outlineOnly = false }, options = {}) {
  if (!deckId || !cardId) return null;
  const deck = (state?.decks || []).find(item => item?.id === deckId);
  const resolvedCourse = course !== undefined ? course : (deck?.course ?? deck?.folder ?? currentCourse(state));
  if (typeof resolvedCourse !== 'string' || resolvedCourse === '*') return null;
  if (outlineOnly && !currentCourseOutlineLite(state?.sources, resolvedCourse)) return null;

  const { value, byCard } = computeSummaryEntry(state, { course: resolvedCourse }, options);
  if (value.status !== 'ok' || !value.points.length) return null;
  const direct = byCard.get(refKey(deckId, cardId));
  if (direct) return direct;
  if (outlineOnly) return null;

  if (deck) {
    const card = (deck.cards || []).find(item => item?.id === cardId);
    if (card) {
      const topic = card.topic || '未分类';
      return value.points.find(point => point.hid === `topic:${deckId}:${topic}`) ?? null;
    }
  }
  return null;
}
