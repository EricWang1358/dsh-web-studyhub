import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { summarizeLinked } from '../../../lib/material-summary.js';
import { assignCards, chapterEntryIds, entrySummaries, rangeOptions, recordVisit, refsOf, sourceIdsOf } from './practice-range.js';
import { captureAnchor, restoreTop } from './reading-position.js';
import { domPlacer, nodeTop, outlineNode } from './place-dom.js';
import { rangeLabel } from './mastery-copy.js';
import { outlineCoverage } from './coverage-outline.js';
import { useLiveEffect } from '../../use-async.js';

const useIsoLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;
const FLASH_MS = 2400, WAIT_MS = 700;

/** The page range of the converted-book chapter that holds `page` (a book converted with its own chapters). */
function chapterPagesOf(item, page) {
  if (!item?.chapters?.length || item.segmentation || !Number.isInteger(page)) return null;
  const chapter = item.chapters.find(entry => !entry.front && page >= entry.startPage && page <= entry.endPage) || item.chapters.find(entry => page >= entry.startPage && page <= entry.endPage);
  return chapter ? { from: chapter.startPage, to: chapter.endPage } : null;
}

/**
 * The reading loop of the reader (读 → 做这几页的题 → 回到阅读 → 掌握度). It reads the questions linked to this document once
 * (materials.pages.cards, again when the library changes), places each under the outline entry its passage is in, and gives the
 * reader: the outline meters, the mastery of the current section, the options of the range chooser, what the learner has read
 * in this session, the reading context to store with a practice run, and the way back to a stored position.
 *
 * params: call, document, source, version (changes when the library did), view, paged, unit ('page' | 'slide' | 'section'),
 * sections (reading sections: id, page, sourceId), outline (structured entries), activeId, chapterLevel (a kept segmentation),
 * documentItem (groupSourcesByDocument's item, for the chapters), body / scroller (refs), loading, rendered (changes when the
 * drawn text does), resume (a stored reading context to go back to: { nonce, sectionId, sectionOffset, scrollTop, progress, revision }).
 */
export function useReadingLoop({ call, document, source, version, view, paged, unit, sections, outline, activeId, chapterLevel, documentItem, body, scroller, loading, rendered, resume }) {
  const documentId = document?.documentId || document?.id;
  const [state, setState] = useState({ status: 'loading', cards: [], summary: summarizeLinked([]), inactiveCourses: [], drafts: [] });
  const [reloads, setReloads] = useState(0), [open, setOpenState] = useState(false), [choice, setChoice] = useState(null);
  const [visited, setVisited] = useState([]), [note, setNote] = useState('');
  // 覆盖 (lib/coverage.js): which sections of this document have a question, drafts included; asked again when the library changes, like the questions themselves.
  const [coverage, setCoverage] = useState({ status: 'loading', view: null });

  // 1. The questions linked to this document, with their review state.
  useLiveEffect(live => {
    if (!call || !documentId) return;
    (async () => {
      try {
        const result = await call('materials.pages.cards', { documentId, sourceId: source.id });
        if (!live()) return;
        if (result?.status === 'unavailable') setState(current => ({ ...current, status: 'unavailable' }));
        else setState({ status: 'ready', cards: result?.cards || [], summary: result?.summary || summarizeLinked([]), inactiveCourses: result?.inactiveCourses || [],
          // The questions still in drafts (not published, so not practisable), placed like the published ones: `deckId` holds the draft id.
          drafts: (result?.draftEntries || []).map(entry => ({ deckId: entry.draftId, cardId: entry.cardId, links: entry.links || [] })) });
      } catch (error) { if (live()) setState(current => ({ ...current, status: 'error', message: error.message })); }
    })();
  }, [call, documentId, source.id, version, reloads]);
  useLiveEffect(live => {
    if (!call || !documentId) return;
    Promise.resolve().then(() => call('coverage.get', { documentId, sourceId: source.id })).then(
      view => { if (live()) setCoverage(view?.status === 'ok' ? { status: 'ready', view } : { status: 'missing', view: null }); },
      () => { if (live()) setCoverage(current => ({ status: 'error', view: current.view })); });
  }, [call, documentId, source.id, version, reloads]);
  const reload = useCallback(() => { setState(current => ({ ...current, status: 'loading' })); setReloads(count => count + 1); }, []);

  // 2. Where each question is in what is drawn. Pages of a PDF or slides are their own sections; anything else is read from the text.
  const [placed, setPlaced] = useState({ assigned: new Map(), unplaced: [], draftAssigned: new Map() });
  const pageSections = useMemo(() => paged && outline.length > 0 && sections.length > 0 && outline.every(item => sections.some(section => section.id === item.id)), [paged, outline, sections]);
  useIsoLayoutEffect(() => {
    if (state.status !== 'ready') return;
    if (pageSections) {
      const bySource = new Map(sections.filter(section => section.sourceId).map(section => [section.sourceId, section.id]));
      const place = link => bySource.get(link.sourceId) ?? null;
      setPlaced({ ...assignCards(state.cards, place), draftAssigned: assignCards(state.drafts, place).assigned });
    } else if (!loading && outline.length) {
      const place = domPlacer({ root: body.current, items: outline, cards: [...state.cards, ...state.drafts] });
      setPlaced({ ...assignCards(state.cards, place), draftAssigned: assignCards(state.drafts, place).assigned });
    } else setPlaced({ assigned: new Map(), unplaced: state.cards, draftAssigned: new Map() });
  }, [state.status, state.cards, state.drafts, pageSections, sections, outline, loading, rendered, body]);

  // 3. What has been read in this session: the entries the reading position passed through.
  useEffect(() => { setVisited([]); }, [documentId, source.id]);
  useEffect(() => { if (activeId !== null && activeId !== undefined) setVisited(list => recordVisit(list, activeId)); }, [activeId]);

  const meters = useMemo(() => entrySummaries(outline, placed.assigned), [outline, placed.assigned]);
  const here = useMemo(() => outline.find(item => item.id === activeId) || null, [outline, activeId]);
  const chapter = useMemo(() => chapterEntryIds(outline, activeId, { chapterLevel, chapterPages: pageSections ? chapterPagesOf(documentItem, here?.page) : null }), [outline, activeId, chapterLevel, pageSections, documentItem, here]);
  const options = useMemo(() => state.status === 'ready'
    ? rangeOptions({ outline, activeId, visited, assigned: placed.assigned, chapter, all: state.cards, draftAssigned: placed.draftAssigned, draftAll: state.drafts }) : [],
  [state.status, outline, activeId, visited, placed.assigned, placed.draftAssigned, chapter, state.cards, state.drafts]);
  const hasChapters = !!chapterLevel || !!documentItem?.chapters?.length;
  const fallback = (hasChapters && options.find(option => option.kind === 'chapter')) || options.find(option => option.kind === 'here') || options[0] || null;
  const selected = (choice && options.find(option => option.kind === choice)) || fallback;
  const setOpen = useCallback(next => { setOpenState(next); setChoice(null); }, []);

  // The reading context to keep with a practice run: where the viewport is, in terms that survive another window width.
  const capture = useCallback(option => {
    const element = scroller.current, node = activeId !== null && element ? outlineNode(element, activeId) : null;
    const anchor = captureAnchor({ scrollTop: element?.scrollTop || 0, clientHeight: element?.clientHeight || 0, scrollHeight: element?.scrollHeight || 0, sectionTop: node ? nodeTop(element, node) : undefined });
    return { documentId, revision: document?.revision || '', sourceId: source.id, page: here?.page ?? source.document?.page ?? null, sectionId: activeId ?? null,
      sectionTitle: here?.title || '', ...anchor, scope: { kind: option.kind, count: Math.max(1, option.count), label: rangeLabel(option, unit) } };
  }, [scroller, activeId, documentId, document?.revision, source, here, unit]);
  const start = useCallback(option => ({ refs: refsOf(option.cards), reading: capture(option) }), [capture]);
  const generateIds = useCallback(option => sourceIdsOf(option.ids, { sections: pageSections ? sections : [], documentSourceIds: document?.sourceIds || [source.id] }), [pageSections, sections, document?.sourceIds, source.id]);

  // 4. Back to a stored position: the section and the offset into it lead, the scroll offset and the progress follow.
  const resumed = useRef(null);
  useEffect(() => {
    if (!resume || loading || view === 'original' || resumed.current === resume.nonce) return undefined;
    const element = scroller.current;
    if (!element) return undefined;
    const node = resume.sectionId ? outlineNode(element, resume.sectionId) : null;
    const updated = !!(resume.revision && document?.revision && resume.revision !== document.revision);
    const apply = () => {
      resumed.current = resume.nonce;
      const saved = updated ? { ...resume, sectionOffset: 0, scrollTop: 0 } : resume;
      element.scrollTo({ top: restoreTop({ saved, sectionTop: node ? nodeTop(element, node) : undefined, clientHeight: element.clientHeight, scrollHeight: element.scrollHeight }), behavior: 'auto' });
      if (node) { node.setAttribute('data-returned', 'true'); setTimeout(() => node.removeAttribute('data-returned'), FLASH_MS); }
      setNote(updated ? 'updated' : '');
    };
    if (node || !resume.sectionId || outline.length) { apply(); return undefined; }
    const timer = setTimeout(apply, WAIT_MS);
    return () => clearTimeout(timer);
  }, [resume, loading, view, outline, rendered, document?.revision, scroller]);

  // What each outline entry has: the marks beside the entries and the counts on the parts above them (practice/coverage-outline.js).
  const outlineCov = useMemo(() => coverage.view?.coverage && outline.length ? outlineCoverage(outline, coverage.view.coverage, { sourceId: source.id, sections }) : null, [coverage.view, outline, source.id, sections]);
  const documentSummary = state.summary;
  const current = (activeId !== null && meters.get(activeId)) || (outline.length ? summarizeLinked([]) : documentSummary);
  return { status: state.status, message: state.message, options, selected, kind: selected?.kind, setKind: setChoice, open, setOpen, reload, inactiveCourses: state.inactiveCourses,
    meters, current, documentSummary, start, generateIds, resumeNote: note, total: state.cards.length,
    coverage: coverage.view?.coverage || null, outlineCoverage: outlineCov };
}
