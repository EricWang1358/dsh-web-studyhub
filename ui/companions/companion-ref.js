import { ui, uiFormat } from '../i18n.js';

function parsePositiveSlide(rawSlide, rawAnchor = '') {
  const num = Math.floor(Number(rawSlide) || 0);
  if (num >= 1) return num;
  const anchorMatch = /^#(\d+)$/.exec(String(rawAnchor || '').trim());
  return anchorMatch ? Math.max(1, Number(anchorMatch[1])) : 0;
}

function parseSlideFromQuote(quote) {
  const text = String(quote || '');
  const en = /\[Slide\s+(\d+)\]/i.exec(text) || /\bSlide\s+(\d+)\b/i.exec(text);
  if (en) return Math.max(1, Number(en[1]));
  const zh = /第\s*(\d+)\s*页/.exec(text);
  return zh ? Math.max(1, Number(zh[1])) : 0;
}

/**
 * Resolve a card's interactive companion deep-link target (`{ companionId, course, slide, anchor, label, companionTitle }`),
 * returning `null` when the card is not linked to a companion or when the companion was removed / archived.
 *
 * @param {{ card?: Record<string, any>, solution?: Record<string, any>, courses?: Array<Record<string, any>>, sources?: Array<Record<string, any>>, fallbackCourse?: string }} [opts]
 */
export function resolveCompanionTarget({ card, solution, courses, sources, fallbackCourse = '' } = {}) {
  const explicit = card?.companionRef || solution?.companionRef;
  let companionId = typeof explicit?.companionId === 'string' ? explicit.companionId.trim() : '';
  let slide = parsePositiveSlide(explicit?.slide, explicit?.anchor);
  let anchor = typeof explicit?.anchor === 'string' ? explicit.anchor.trim() : '';
  let label = typeof explicit?.label === 'string' ? explicit.label.trim() : '';
  let sourceCourse = '';

  const sourceList = Array.isArray(sources) ? sources : [];
  if (!companionId) {
    const citations = Array.isArray(solution?.citations) ? solution.citations : (Array.isArray(card?.citations) ? card.citations : []);
    for (const cite of citations) {
      const sourceId = typeof cite?.sourceId === 'string' ? cite.sourceId.trim() : '';
      if (!sourceId) continue;
      const src = sourceList.find(item => item?.id === sourceId);
      if (src?.archived) continue;
      const fromSrc = typeof src?.companionId === 'string' && src.companionId.trim()
        ? src.companionId.trim()
        : (sourceId.startsWith('src-companion-') ? sourceId.slice('src-companion-'.length).trim() : '');
      if (fromSrc) {
        companionId = fromSrc;
        slide = parseSlideFromQuote(cite?.quote);
        sourceCourse = Array.isArray(src?.courses) && src.courses[0] ? src.courses[0] : '';
        break;
      }
    }
  }

  if (!companionId) return null;

  const projectedSource = sourceList.find(
    item => item && (item.id === `src-companion-${companionId}` || item.companionId === companionId),
  );
  if (projectedSource?.archived) return null;

  let resolvedCourse = sourceCourse || String(fallbackCourse || '').trim();
  let companionTitle = '';
  let lessonMode = typeof explicit?.mode === 'string' ? explicit.mode.trim() : '';
  if (Array.isArray(courses) && courses.some(c => Array.isArray(c?.companions))) {
    let matchedCourse = null;
    let matchedCompanion = null;
    for (const courseRec of courses) {
      const hit = (courseRec?.companions || []).find(item => item?.id === companionId);
      if (hit) {
        matchedCourse = courseRec;
        matchedCompanion = hit;
        break;
      }
    }
    if (!matchedCompanion) return null;
    if (matchedCourse?.name) resolvedCourse = matchedCourse.name;
    companionTitle = typeof matchedCompanion.title === 'string' ? matchedCompanion.title : '';
    if (typeof matchedCompanion.lessonMode === 'string' && matchedCompanion.lessonMode.trim()) {
      lessonMode = matchedCompanion.lessonMode.trim();
    }
    if (slide >= 1 && Number(matchedCompanion.slideCount) > 0) {
      slide = Math.min(slide, Math.floor(Number(matchedCompanion.slideCount)));
    }
  }

  const finalAnchor = anchor || (slide >= 1 ? `#${slide}` : '');
  return {
    companionId,
    course: resolvedCourse,
    slide,
    anchor: finalAnchor,
    label,
    companionTitle,
    ...(lessonMode ? { lessonMode } : {}),
  };
}

/** Label for a flashcard / card detail deep-link button (`Open slide {slide} in companion` or `Open companion`). */
export function companionSlideButtonLabel(target) {
  if (target?.lessonMode === 'rescue') return ui('打开 4 页交互实验');
  if (target?.slide >= 1) return uiFormat('打开伴学课第 {0} 页', [target.slide]);
  return ui('打开伴学页');
}

/** Open `CompanionViewer` directly on `target` (passing `initialSlide` and `slide` for exact-slide deep-linking). */
export function openCompanionTarget(openModal, target, extra = {}) {
  if (typeof openModal !== 'function' || !target?.companionId) return;
  const returnLabel = extra.returnLabel || target.returnLabel || '';
  const from = extra.from || target.from || '';
  openModal({
    type: 'companion',
    id: target.companionId,
    ...(target.course ? { course: target.course } : {}),
    ...(target.slide >= 1 ? { slide: target.slide, initialSlide: target.slide } : {}),
    ...(target.anchor ? { anchor: target.anchor } : {}),
    ...(target.companionTitle || target.label ? { title: target.companionTitle || target.label } : {}),
    ...(returnLabel ? { returnLabel } : {}),
    ...(from ? { from } : {}),
  });
}

/**
 * Resolve an interactive companion target from a projected `src-companion-<id>` source record
 * (optionally preserving a `[Slide N]` quote jump when opened from a citation).
 */
export function resolveSourceCompanionTarget({ source, quote = '', courses, sources } = {}) {
  if (!source || source.archived) return null;
  const rawId = typeof source.companionId === 'string' && source.companionId.trim()
    ? source.companionId.trim()
    : (typeof source.id === 'string' && source.id.startsWith('src-companion-')
      ? source.id.slice('src-companion-'.length).trim()
      : '');
  if (!rawId) return null;
  const slide = parseSlideFromQuote(quote);
  return resolveCompanionTarget({
    card: { companionRef: { companionId: rawId, ...(slide >= 1 ? { slide } : {}) } },
    courses,
    sources,
    fallbackCourse: Array.isArray(source.courses) && source.courses[0] ? source.courses[0] : '',
  });
}

/**
 * Find the best active interactive companion linked to a Review Book knowledge point (`hid` / `nodeId` / `questions`).
 * Prefers uncompleted or rescue companions linked directly via `hid`, then via `targetCardIds` or question `card.companionRef`.
 */
export function findPointCompanion({ hid = '', nodeId = '', questions = [], course = '', courses = [], decks = [], sources = [] } = {}) {
  const cleanHid = String(hid || '').trim();
  const cleanNodeId = String(nodeId || '').trim();
  const cleanCourse = String(course || '').trim();
  const courseList = Array.isArray(courses) ? courses : [];
  const sourceList = Array.isArray(sources) ? sources : [];
  const deckList = Array.isArray(decks) ? decks : [];
  const questionList = Array.isArray(questions) ? questions : [];
  const questionCardIds = new Set(questionList.map(q => q?.cardId).filter(Boolean));

  const archivedCompanionIds = new Set();
  for (const src of sourceList) {
    if (!src?.archived) continue;
    if (typeof src.companionId === 'string' && src.companionId.trim()) archivedCompanionIds.add(src.companionId.trim());
    if (typeof src.id === 'string' && src.id.startsWith('src-companion-')) archivedCompanionIds.add(src.id.slice('src-companion-'.length).trim());
  }

  const cardSlideByComp = new Map();
  if (questionCardIds.size > 0) {
    for (const deck of deckList) {
      for (const card of deck?.cards || []) {
        if (!card || !questionCardIds.has(card.id)) continue;
        const ref = card.companionRef;
        const cid = typeof ref?.companionId === 'string' ? ref.companionId.trim() : '';
        if (!cid || archivedCompanionIds.has(cid)) continue;
        const slide = parsePositiveSlide(ref.slide, ref.anchor);
        if (!cardSlideByComp.has(cid) || (slide >= 1 && (cardSlideByComp.get(cid) || 0) < 1)) {
          cardSlideByComp.set(cid, slide);
        }
      }
    }
  }

  const lowerCourse = cleanCourse.toLowerCase();
  const matchedCourseRec = cleanCourse
    ? (courseList.find(c => c?.name === cleanCourse)
      || courseList.find(c => String(c?.name || '').trim().toLowerCase() === lowerCourse)
      || null)
    : null;
  const searchCourses = matchedCourseRec ? [matchedCourseRec] : courseList;

  const candidates = [];
  for (const courseRec of searchCourses) {
    const cName = typeof courseRec?.name === 'string' ? courseRec.name : cleanCourse;
    for (const comp of Array.isArray(courseRec?.companions) ? courseRec.companions : []) {
      if (!comp?.id || archivedCompanionIds.has(comp.id)) continue;
      const compHid = typeof comp.hid === 'string' ? comp.hid.trim() : '';
      const directHid = Boolean((cleanHid && compHid === cleanHid) || (cleanNodeId && compHid === cleanNodeId));
      const targetMatch = !directHid && Array.isArray(comp.targetCardIds) && comp.targetCardIds.some(id => questionCardIds.has(id));
      const cardRefMatch = !directHid && !targetMatch && cardSlideByComp.has(comp.id);
      if (!directHid && !targetMatch && !cardRefMatch) continue;

      const isRescue = comp.lessonMode === 'rescue' || comp.mode === 'rescue';
      const completed = comp.progress?.completed === true;
      let slide = cardSlideByComp.get(comp.id) || parsePositiveSlide(comp.progress?.slide, '');
      if (slide < 1) slide = 1;
      if (Number(comp.slideCount) > 0) slide = Math.min(slide, Math.floor(Number(comp.slideCount)));
      const score = (completed ? 0 : 8) + (directHid ? 4 : 0) + (isRescue ? 2 : 0);
      const stamp = String(comp.updatedAt || comp.createdAt || '');
      candidates.push({
        score,
        stamp,
        target: {
          companionId: comp.id,
          course: cName,
          slide,
          anchor: `#${slide}`,
          label: '',
          companionTitle: typeof comp.title === 'string' ? comp.title : '',
          ...(isRescue ? { lessonMode: 'rescue' } : (comp.lessonMode ? { lessonMode: comp.lessonMode } : {})),
          completed,
        },
      });
    }
  }

  if (candidates.length > 0) {
    candidates.sort((a, b) => (b.score - a.score) || (a.stamp < b.stamp ? 1 : a.stamp > b.stamp ? -1 : 0));
    return candidates[0].target;
  }

  if (cardSlideByComp.size > 0 && !courseList.some(c => Array.isArray(c?.companions))) {
    const [companionId, rawSlide] = cardSlideByComp.entries().next().value;
    const slide = rawSlide >= 1 ? rawSlide : 1;
    return {
      companionId,
      course: cleanCourse,
      slide,
      anchor: `#${slide}`,
      label: '',
      companionTitle: '',
    };
  }

  return null;
}
