import { cleanFocusTopics, courseFocusTopics } from '../../../focus-points.js';
import { courseSkeleton } from '../../../custom-skeleton.js';
import { formatCoverageNote } from './messages.js';
import { buildChapterSurfaces } from './exam-scope-surfaces.js';
import {
  aliasForms, extractChapterRefs, formMatchesText, isChapterRefOnly,
  meaningfulTokens, parseGuidanceTopics, parseNoteTopics,
} from './exam-scope-text.js';

/* True Exam-Scope Slicing (StudyHub 5.0.0 Evolution 2 Item #4): 0-token deterministic matching of exam scope inputs
   (`course.focusTopics`, `scope.note`, `course.guidanceSourceIds`) against material TOC, `courseInventory`, and/or
   `courseOutline` chapters. Pure, zero I/O, zero model calls. Exported via `lib/contexts/generation/contracts.js`.
   Never silently drops exam topics: every topic is either attributed to >= 1 matched chapter or surfaced in
   `unmatchedTopics` for learner confirmation before writing `scope.resolvedChapters`. */

const GUIDANCE_TEXT_CAP = 8_000;
const MAX_GUIDANCE_SOURCES = 10;

/** Deterministic match of a single topic against one chapter surface: { confidence, reason } | null. */
export function matchChapterToTopics(surface, topic) {
  const forms = aliasForms(topic);
  if (!forms.length) return null;
  for (const form of forms) {
    if (formMatchesText(form, surface.headingLower, surface.headingCompact)) return { confidence: 'high', reason: 'heading' };
  }
  if (surface.invLower) {
    for (const form of forms) {
      if (formMatchesText(form, surface.invLower, surface.invCompact)) return { confidence: 'high', reason: 'inventory' };
    }
  }
  if (surface.contentLower) {
    for (const form of forms) {
      if (formMatchesText(form, surface.contentLower, '')) return { confidence: 'medium', reason: 'content' };
    }
  }
  const tokens = meaningfulTokens(forms.join(' '));
  if (tokens.length >= 2 && surface.tokenBag?.size) {
    const overlap = tokens.filter(token => surface.tokenBag.has(token)).length;
    if (overlap >= Math.max(2, Math.ceil(tokens.length * 0.6))) return { confidence: 'medium', reason: 'tokens' };
  }
  return null;
}

/** Extract exam scope topics and explicit chapter refs from course focusTopics, scope.note, and guidanceSourceIds. */
export function examScopeTopics(state, course, { scope = null, focusTopics = null, guidanceSourceIds = null, note = null, language = 'zh' } = {}) {
  const record = (state?.courses || []).find(item => item && item.name === course) ?? null;
  const rawFocus = Array.isArray(focusTopics) ? focusTopics : courseFocusTopics(state, course, { includeDescendants: true });
  const rawNote = typeof note === 'string' ? note : (typeof scope?.note === 'string' ? scope.note : '');
  const rawGuidanceIds = Array.isArray(guidanceSourceIds)
    ? guidanceSourceIds
    : (Array.isArray(record?.guidanceSourceIds) ? record.guidanceSourceIds : []);
  const byId = new Map((Array.isArray(state?.sources) ? state.sources : []).map(source => [source.id, source]));
  const guidanceSources = rawGuidanceIds.map(id => byId.get(id)).filter(src => src && !src.archived).slice(0, MAX_GUIDANCE_SOURCES);

  const chapterRefsByNum = new Map();
  const addRefs = text => {
    for (const ref of extractChapterRefs(text, language)) {
      if (!chapterRefsByNum.has(ref.num)) chapterRefsByNum.set(ref.num, ref);
    }
  };
  addRefs(rawNote);
  for (const topic of rawFocus) addRefs(topic);
  for (const src of guidanceSources) addRefs(typeof src.text === 'string' ? src.text.slice(0, GUIDANCE_TEXT_CAP) : '');

  const focusCleaned = cleanFocusTopics(rawFocus, { limit: 100 }).filter(topic => !isChapterRefOnly(topic));
  const noteTopics = parseNoteTopics(rawNote);
  const guidanceTopics = parseGuidanceTopics(guidanceSources, { allowShortLines: !focusCleaned.length && !noteTopics.length, textCap: GUIDANCE_TEXT_CAP });
  const topics = cleanFocusTopics([...focusCleaned, ...noteTopics, ...guidanceTopics], { limit: 100 });
  return { topics, chapterRefs: [...chapterRefsByNum.values()] };
}

/**
 * Pure 0-token exam-scope slicer.
 * Returns `{ basis, matchedChapters, unmatchedTopics, topics, totalChapters, coverageNote }`.
 */
export function sliceExamScope(state, course, options = {}) {
  const language = options.language === 'en' ? 'en' : 'zh';
  const skeleton = options.skeleton ?? courseSkeleton(state, course);
  const record = (state?.courses || []).find(item => item && item.name === course) ?? null;
  const rawGuidanceIds = Array.isArray(options.guidanceSourceIds)
    ? options.guidanceSourceIds
    : (Array.isArray(record?.guidanceSourceIds) ? record.guidanceSourceIds : []);
  const surfaces = buildChapterSurfaces(state, course, skeleton, new Set(rawGuidanceIds));
  const { topics, chapterRefs } = examScopeTopics(state, course, { ...options, language });

  const hitsByChapter = new Map();
  const recordHit = (surface, topicLabel, confidence, reason) => {
    let entry = hitsByChapter.get(surface.id);
    if (!entry) {
      entry = { surface, confidence, matchedTopics: [], reasons: new Set() };
      hitsByChapter.set(surface.id, entry);
    }
    if (confidence === 'high') entry.confidence = 'high';
    if (!entry.matchedTopics.includes(topicLabel)) entry.matchedTopics.push(topicLabel);
    entry.reasons.add(reason);
  };

  const unmatchedTopics = [];
  const addUnmatched = label => { if (!unmatchedTopics.includes(label)) unmatchedTopics.push(label); };

  for (const ref of chapterRefs) {
    let matched = surfaces.filter(surface => surface.chapterNum === ref.num);
    if (!matched.length) matched = surfaces.filter(surface => surface.fallbackNum === ref.num);
    if (matched.length) for (const surface of matched) recordHit(surface, ref.label, 'high', 'chapter_ref');
    else addUnmatched(ref.label);
  }

  for (const topic of topics) {
    let anyHit = false;
    for (const surface of surfaces) {
      const hit = matchChapterToTopics(surface, topic);
      if (hit) { anyHit = true; recordHit(surface, topic, hit.confidence, hit.reason); }
    }
    if (!anyHit) addUnmatched(topic);
  }

  const matchedChapters = [...hitsByChapter.values()]
    .sort((a, b) => a.surface.order - b.surface.order)
    .map(({ surface, confidence, matchedTopics, reasons }) => ({
      id: surface.id,
      title: surface.title,
      ...(surface.doc !== undefined ? { doc: surface.doc } : {}),
      ...(surface.pages !== undefined ? { pages: surface.pages } : {}),
      ...(surface.chars !== undefined ? { chars: surface.chars } : {}),
      ...(surface.points !== undefined ? { points: surface.points } : {}),
      confidence,
      matchedTopics,
      reasons: [...reasons],
    }));

  const coverageNote = formatCoverageNote({
    matchedCount: matchedChapters.length,
    totalChapters: surfaces.length,
    unmatchedCount: unmatchedTopics.length,
    topicCount: topics.length,
    refCount: chapterRefs.length,
    language,
  });

  return { basis: skeleton.basis, matchedChapters, unmatchedTopics, topics, totalChapters: surfaces.length, coverageNote };
}
