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
