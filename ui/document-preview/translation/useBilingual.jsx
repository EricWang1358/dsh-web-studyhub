import React, { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ui, uiFormat, useUiLanguage } from '../../i18n.js';
import { needsTranslation } from '../../../lib/passage-translation.js';
import { gateMessage } from '../../ModelSetupGate.jsx';
import { useToast } from '../../components/index.js';
import { locateGroups } from '../links/link-ranges.js';
import { captureSelection } from '../selection.js';
import { createHost, createMark, paragraphAround, scanParagraphs } from './dom.js';
import {
  SIDE_MIN_COLUMN, blockState, buttonState, effectiveMode, hostShown, initialState, isShown, jobActive, jobToShow, keyedParagraphs, loadTranslationSettings, passageOf, reducer, saveTranslationSettings,
} from './model.js';
import TranslationBlock from './TranslationBlock.jsx';
import GlossaryDialog from './GlossaryDialog.jsx';
import FloatingTranslation from './FloatingTranslation.jsx';
import { SelectionChip, TranslationDisplayRow, TranslationJobCard, TranslationMenu } from './TranslationMenu.jsx';

/* The bilingual reading of the reader (译), as one hook the viewer calls once. It owns the translations of the document, the
   inline 译 marks, the translation blocks, the selection chip, the page / chapter job and the glossary, and hands the viewer
   four nodes to place: `displayRow` (inside the Aa popover), `toolbar` (the 译 button), `notice` (the job's progress line)
   and `layer` (portals into the reading column and the glossary dialog).

   The reading column is React's and is never rewritten: marks go at the end of a paragraph, blocks are siblings after it
   (portals into hosts), all of them data-study-marker, so selection capture, find, the link underlines and the outline skip them.
   Without the backend operations (an older plugin) the hook stays inert. */

const useIsoLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;
const UNDO_MS = 8000;
const escapeAttribute = value => String(value).replace(/["\\]/g, '\\$&');
let counter = 0;
const nextId = prefix => `${prefix}-${Date.now().toString(36)}-${(counter += 1)}`;

const emptyLayer = () => ({ paragraphs: [], byKey: new Map(), byElement: new Map(), marks: new Map(), hosts: new Map(), pinned: new Map(), origOpen: new Set(), active: null, requests: new Map(), timers: new Map() });

function teardown(layer) {
  for (const mark of layer.marks.values()) mark.remove();
  for (const host of layer.hosts.values()) host.remove();
  for (const { element } of layer.paragraphs) { delete element.dataset.trClamp; }
  layer.marks = new Map(); layer.hosts = new Map(); layer.paragraphs = []; layer.byKey = new Map(); layer.byElement = new Map(); layer.active = null;
}

/** Paragraphs of the current page (section) and chapter, from where the reader is. */
function spansOf({ layer, body, scroller, outline, activeId, chapterLevel, paged }) {
  const offered = layer.paragraphs.filter(paragraph => paragraph.offered);
  if (!body) return { page: offered, chapter: null };
  if (paged) {
    const area = scroller?.getBoundingClientRect(), pages = [...body.querySelectorAll('[data-study-page]')];
    const here = pages.find(page => !area || page.getBoundingClientRect().bottom > area.top + 60) || pages[0];
    if (!here) return { page: offered, chapter: null };
    const page = offered.filter(paragraph => here.contains(paragraph.element));
    return { page, chapter: null, pageLabel: ui('翻译本页') };
  }
  const entries = (outline || []).map(item => ({ item, element: body.querySelector(`[data-outline-id="${escapeAttribute(item.id)}"],[data-ai-outline-id="${escapeAttribute(item.id)}"]`) })).filter(entry => entry.element);
  const at = entries.findIndex(entry => entry.item.id === activeId);
  if (!entries.length || at < 0) return { page: offered, chapter: null };
  const sectionOf = paragraph => {
    let found = -1;
    for (let index = 0; index < entries.length; index += 1) {
      const element = entries[index].element;
      if (element === paragraph.element || element.contains(paragraph.element) || element.compareDocumentPosition(paragraph.element) & 4) found = index; else break;
    }
    return found;
  };
  const top = Math.min(...entries.map(entry => entry.item.level)), isChapter = entry => entry.item.level <= (chapterLevel || top);
  let from = at; while (from > 0 && !isChapter(entries[from])) from -= 1;
  let to = at + 1; while (to < entries.length && !isChapter(entries[to])) to += 1;
  const spans = offered.map(paragraph => ({ paragraph, section: sectionOf(paragraph) }));
  const page = spans.filter(span => span.section === at).map(span => span.paragraph);
  const chapter = spans.filter(span => span.section >= from && span.section < to).map(span => span.paragraph);
  return { page, chapter: chapter.length > page.length ? chapter : null };
}

const selectionPassage = capture => ({ sourceId: capture.sourceId, kind: 'selection', text: capture.quote, prefix: capture.prefix || '', suffix: capture.suffix || '' });

/**
 * @param props call, document (materials.document.get), source, view ('read' | 'text' | 'original'), paged, narrow, body / scroller (refs),
 *   rendered (changes whenever the drawn text does), outline / activeId / chapterLevel (the reader's contents)
 */
export default function useBilingual({ call, document: doc, source, view, paged, narrow, body, scroller, rendered, outline, activeId, chapterLevel, enabled = true }) {
  const language = useUiLanguage();
  const toast = useToast();
  const onNotice = useCallback(({ text, tone }) => toast.show({ tone, message: text }), [toast]);
  const [settings, setSettings] = useState(loadTranslationSettings), [state, dispatch] = useReducer(reducer, initialState);
  const [available, setSupported] = useState(false), [version, setVersion] = useState(0), [hosts, setHosts] = useState(() => new Map()), [page, setPage] = useState(null);
  const supported = enabled && available;
  const [chip, setChip] = useState(null), [floating, setFloating] = useState(null), [menuOpen, setMenuOpen] = useState(false), [scopes, setScopes] = useState([]);
  const [glossaryOpen, setGlossaryOpen] = useState(false), [jobs, setJobs] = useState([]), [dismissed, setDismissed] = useState(() => new Set()), [now, setNow] = useState(() => Date.now());
  const layer = useRef(emptyLayer()), latest = useRef({}), scopeDefs = useRef([]), reading = view === 'read';
  const identity = useMemo(() => doc ? { documentId: doc.documentId || doc.id, ...(doc.revision ? { revision: doc.revision } : {}) } : null, [doc]);
  const identityKey = identity ? JSON.stringify(identity) : '';
  // 左右分栏 needs room: the reader's own narrow width, or a reading column squeezed by the outline and the learning panel, draws 逐段对照 instead.
  const [roomy, setRoomy] = useState(true), crowded = narrow || !roomy;
  useEffect(() => {
    const element = scroller.current;
    if (!element || typeof ResizeObserver === 'undefined') return undefined;
    const measure = () => setRoomy(element.clientWidth >= SIDE_MIN_COLUMN);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [scroller]);
  const target = state.target, mode = effectiveMode(settings.mode, crowded ? 0 : 1000);
  useEffect(() => { saveTranslationSettings(settings); }, [settings]);

  /* ---------- the translations of this revision ---------- */
  const refresh = useCallback(async () => {
    if (!enabled || !identityKey) return;
    try {
      const list = await call('materials.translation.list', JSON.parse(identityKey));
      if (list?.items) { dispatch({ type: 'loaded', list }); setSupported(true); } else setSupported(false);
    } catch { setSupported(false); }
  }, [call, identityKey, enabled]);
  useEffect(() => { dispatch({ type: 'reset' }); void refresh(); }, [refresh]);

  /* ---------- the layer in the reading column ---------- */
  // Marks: one 译 at the end of each paragraph that has something to translate. The glyph is CSS, so it is no text of the paragraph.
  useIsoLayoutEffect(() => {
    const container = body.current, own = layer.current;
    teardown(own);
    if (!container || !supported || !reading) { setVersion(count => count + 1); return undefined; }
    const scanned = keyedParagraphs(scanParagraphs(container, source.id));
    own.paragraphs = scanned;
    own.byKey = new Map(scanned.map(paragraph => [paragraph.key, paragraph]));
    own.byElement = new Map(scanned.map(paragraph => [paragraph.element, paragraph]));
    const label = target === 'en' ? 'EN' : ui('译');
    for (const paragraph of scanned) {
      paragraph.offered = needsTranslation(paragraph.text, target);
      if (!paragraph.offered) continue;
      const mark = createMark(container.ownerDocument, { label, title: ui('翻译这一段') });
      paragraph.element.append(mark);
      own.marks.set(paragraph.key, mark);
    }
    setVersion(count => count + 1);
    return () => teardown(own);
  }, [body, supported, reading, rendered, target, source.id, language]);
  useIsoLayoutEffect(() => {
    const element = (reading || view === 'text') && supported ? body.current?.closest('.reader-page') || null : null;
    setPage(current => current === element ? current : element);
  }, [body, reading, view, supported, rendered]);

  // Blocks: a host after the paragraph (or after the block a selection ends in) for everything that has a translation, a call out, a reason or an undo.
  const wanted = useMemo(() => [...new Set([...Object.keys(state.items), ...Object.keys(state.pending), ...Object.keys(state.undo),
    ...Object.entries(state.errors).filter(([, error]) => error.code !== 'same-language').map(([key]) => key)])], [state.items, state.pending, state.undo, state.errors]);
  const wantedSignature = wanted.join('\u0001');
  useIsoLayoutEffect(() => {
    const own = layer.current, container = body.current;
    if (!container || !supported || !reading) { if (own.hosts.size) { own.hosts.forEach(host => host.remove()); own.hosts = new Map(); } setHosts(current => current.size ? new Map() : current); return; }
    let changed = false;
    const keep = new Set(wanted);
    for (const [key, host] of own.hosts) if (!keep.has(key) || !host.isConnected) { host.remove(); own.hosts.delete(key); changed = true; }
    // Selections kept earlier are found again by their words and context, like the link underlines are.
    const lost = wanted.filter(key => !own.hosts.has(key) && state.items[key]?.kind === 'selection' && !(own.pinned.get(key)?.isConnected));
    if (lost.length) {
      const found = locateGroups(container, lost.map(key => ({ key, selection: { sourceId: state.items[key].sourceId, quote: state.items[key].quote, prefix: state.items[key].prefix, suffix: state.items[key].suffix } })));
      for (const { group, range } of found) { const block = paragraphAround(range.endContainer, own.byElement); if (block) own.pinned.set(group.key, block); }
    }
    for (const key of wanted) {
      if (own.hosts.has(key)) continue;
      const item = state.items[key];
      const anchor = own.pinned.get(key)?.isConnected ? own.pinned.get(key) : item?.kind === 'selection' ? null : own.byKey.get(key)?.element;
      if (!anchor) continue;
      const host = createHost(container.ownerDocument, key);
      anchor.after(host); own.hosts.set(key, host); changed = true;
    }
    setHosts(current => !changed && current.size === own.hosts.size && [...own.hosts].every(([key, host]) => current.get(key) === host) ? current : new Map(own.hosts));
  }, [wantedSignature, version, supported, reading, body]);

  // What the reader sees follows the state: the mode on the column, each mark's state, which blocks are open, which originals are folded.
  useIsoLayoutEffect(() => {
    const own = layer.current;
    if (page) { if (supported && reading) page.dataset.trMode = mode; else delete page.dataset.trMode; }
    for (const [key, mark] of own.marks) {
      const current = buttonState(state, key);
      mark.dataset.trState = current;
      const button = mark.firstChild;
      const words = current === 'translating' ? ui('取消翻译') : current === 'none' || current === 'error' ? ui('翻译这一段') : isShown(state, key, mode) ? ui('收起译文') : ui('展开译文');
      button.title = words; button.setAttribute('aria-label', words);
      button.setAttribute('aria-pressed', current === 'has' || current === 'stale' ? String(isShown(state, key, mode)) : 'false');
    }
    for (const [key, host] of own.hosts) host.dataset.shown = String(hostShown(state, key, mode));
    for (const paragraph of own.paragraphs) {
      const folded = mode === 'only' && state.items[paragraph.key] && isShown(state, paragraph.key, mode) && !own.origOpen.has(paragraph.key);
      if (folded) paragraph.element.dataset.trClamp = 'true'; else delete paragraph.element.dataset.trClamp;
    }
  }, [state, mode, page, supported, reading, version, hosts]);

  /* ---------- asking ---------- */
  const spanKeys = useCallback(() => { const spans = spansOf({ layer: layer.current, body: body.current, scroller: scroller.current, outline, activeId, chapterLevel, paged }); return spans; }, [body, scroller, outline, activeId, chapterLevel, paged]);

  const send = useCallback(async (entries, { retranslate = false, comment = '' } = {}) => {
    if (!identity || !entries.length) return;
    const keys = entries.map(entry => entry.key), requestId = nextId('tr'), own = layer.current;
    entries.forEach(entry => { own.requests.set(entry.key, requestId); });
    dispatch({ type: 'pending', keys, kind: retranslate ? 'retranslate' : 'translate' });
    try {
      const result = await call('materials.translation.translate', { ...identity, target, requestId, passages: entries.map(entry => entry.passage), ...(retranslate ? { retranslate: true, comment } : {}) });
      if (result?.available === false || result?.status === 'unavailable') { dispatch({ type: 'unavailable', keys }); return; }
      const results = result.results.map(item => ({ ...item, key: item.key || entries[item.index]?.key }));
      // A selection's block is anchored where the selection ended; the key the backend gives it replaces the one it had while waiting.
      for (const item of results) { const wasTemp = entries[item.index]?.key; if (item.item && wasTemp && wasTemp !== item.key && own.pinned.has(wasTemp)) own.pinned.set(item.key, own.pinned.get(wasTemp)); }
      dispatch({ type: 'settled', results, keys, reveal: latest.current.mode === 'hidden' });
      return results;
    } catch (error) {
      if (/cancel/i.test(error?.message || '')) dispatch({ type: 'cancelled', keys }); else dispatch({ type: 'failed', keys, message: error?.message });
    } finally { keys.forEach(key => { own.requests.delete(key); }); }
  }, [call, identity, target]);

  const cancel = useCallback(async key => {
    const requestId = layer.current.requests.get(key);
    if (requestId) { try { await call('materials.translation.cancel', { requestId }); } catch { /* it ended on its own */ } }
  }, [call]);

  const paragraphEntry = paragraph => ({ key: paragraph.key, passage: passageOf(paragraph) });
  const entryOfItem = useCallback(item => {
    if (item.kind === 'selection') return { key: item.key, passage: { sourceId: item.sourceId, kind: 'selection', text: item.quote, prefix: item.prefix, suffix: item.suffix } };
    const paragraph = layer.current.byKey.get(item.key);
    return paragraph ? paragraphEntry(paragraph) : null;
  }, []);

  const onMark = useCallback(key => {
    const paragraph = layer.current.byKey.get(key);
    if (!paragraph) return;
    const current = buttonState(state, key);
    if (current === 'translating') { void cancel(key); return; }
    if (current === 'none' || current === 'error') { void send([paragraphEntry(paragraph)]); return; }
    const open = isShown(state, key, mode);
    dispatch({ type: 'show', keys: [key], value: !open });
    if (!open) setTimeout(() => layer.current.hosts.get(key)?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' }), 50);
  }, [state, mode, send, cancel]);

  const translateSelection = useCallback(capture => {
    const container = body.current;
    if (!capture || !container) return;
    const tempKey = `tmp:${nextId('sel')}`;
    const block = reading ? paragraphAround(capture.range.endContainer, layer.current.byElement) : null;
    if (block) layer.current.pinned.set(tempKey, block);
    else {
      const area = page?.getBoundingClientRect(), rects = capture.range.getClientRects(), last = rects[rects.length - 1];
      if (area && last) setFloating({ key: tempKey, left: Math.max(0, Math.min(last.left - area.left, area.width - 320)), top: last.bottom - area.top + 6 });
    }
    setChip(null);
    // In the 原文 view the card follows the selection's translation from the call out to the kept one.
    void send([{ key: tempKey, passage: selectionPassage({ ...capture, sourceId: capture.sourceId || source.id }) }]).then(results => {
      const made = results?.[0];
      if (!block && made?.item) setFloating(current => current?.key === tempKey ? { ...current, key: made.key } : current);
    });
  }, [body, reading, page, send, source.id]);

  /* The active paragraph (hover or focus) and the selection: the two things Alt+T and the chip act on. */
  useEffect(() => {
    const container = body.current;
    if (!container || !supported || view === 'original') return undefined;
    const own = layer.current;
    const track = event => {
      const paragraph = event.target ? paragraphAround(event.target, own.byElement) : null;
      if (paragraph === own.active) return;
      own.marks.get(own.byElement.get(own.active)?.key)?.firstChild?.setAttribute('tabindex', '-1');
      own.active = paragraph;
      own.marks.get(own.byElement.get(paragraph)?.key)?.firstChild?.setAttribute('tabindex', '0');
    };
    const click = event => {
      const mark = event.target.closest?.('[data-tr-mark]');
      if (mark) {
        event.preventDefault(); event.stopPropagation();
        const paragraph = paragraphAround(mark, own.byElement);
        if (paragraph) latest.current.onMark(own.byElement.get(paragraph).key);
        return;
      }
      const folded = event.target.closest?.('[data-tr-clamp]');
      if (folded && !event.target.closest('a, button') && window.getSelection?.()?.isCollapsed) {
        const key = own.byElement.get(folded)?.key;
        if (key) { if (own.origOpen.has(key)) own.origOpen.delete(key); else own.origOpen.add(key); delete folded.dataset.trClamp; if (!own.origOpen.has(key)) folded.dataset.trClamp = 'true'; }
      }
    };
    // The pointer leaving the text means no paragraph is under it any more: Alt+T then acts on the first one in view.
    const leave = () => track({ target: null });
    container.addEventListener('pointerover', track);
    container.addEventListener('pointerleave', leave);
    container.addEventListener('focusin', track);
    container.addEventListener('click', click, true);
    return () => { container.removeEventListener('pointerover', track); container.removeEventListener('pointerleave', leave); container.removeEventListener('focusin', track); container.removeEventListener('click', click, true); };
  }, [body, supported, view, version]);
  useEffect(() => { latest.current = { onMark, mode }; });

  // The chip follows a selection of words worth translating, at its end.
  useEffect(() => {
    if (!supported || !(reading || view === 'text')) { setChip(null); return undefined; }
    let frame = 0;
    const measure = () => {
      frame = 0;
      const container = body.current, area = container?.closest('.reader-page');
      const capture = container ? captureSelection(container) : null;
      if (!capture || !area || !needsTranslation(capture.quote, target) || capture.quote.trim().length < 2) { setChip(current => current ? null : current); return; }
      const rects = capture.range.getClientRects(), last = rects[rects.length - 1], box = area.getBoundingClientRect();
      if (!last) { setChip(null); return; }
      const next = { left: Math.round(Math.min(last.right - box.left + 4, box.width - 36)), top: Math.round(last.bottom - box.top + 4), text: capture.quote.slice(0, 60) };
      setChip(current => current && current.left === next.left && current.top === next.top && current.text === next.text ? current : next);
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(measure); };
    document.addEventListener('selectionchange', schedule);
    return () => { document.removeEventListener('selectionchange', schedule); if (frame) cancelAnimationFrame(frame); };
  }, [body, supported, reading, view, target, rendered]);

  const translateCurrent = useCallback(() => {
    const capture = captureSelection(body.current);
    if (capture && needsTranslation(capture.quote, target)) { translateSelection(capture); return; }
    const own = layer.current, area = scroller.current?.getBoundingClientRect();
    const paragraph = own.active ? own.byElement.get(own.active) : own.paragraphs.find(item => item.offered && (!area || item.element.getBoundingClientRect().bottom > area.top + 40));
    if (paragraph?.offered) onMark(paragraph.key);
  }, [body, scroller, target, translateSelection, onMark]);
  useEffect(() => {
    const viewer = body.current?.closest('.study-document-viewer');
    if (!viewer || !supported) return undefined;
    const onKeyDown = event => { if (event.altKey && !event.ctrlKey && !event.metaKey && event.key.toLowerCase() === 't' && view !== 'original') { event.preventDefault(); translateCurrent(); } };
    viewer.addEventListener('keydown', onKeyDown);
    return () => viewer.removeEventListener('keydown', onKeyDown);
  }, [body, supported, view, translateCurrent, version]);

  /* ---------- a block's actions ---------- */
  const remove = useCallback(async key => {
    try {
      const result = await call('materials.translation.delete', { ...identity, target, keys: [key] });
      if (!result.deleted) { await refresh(); return; }
      dispatch({ type: 'removed', keys: [key], removed: result.removed });
      const own = layer.current;
      clearTimeout(own.timers.get(key));
      own.timers.set(key, setTimeout(() => { dispatch({ type: 'undo-expired', keys: [key] }); own.timers.delete(key); }, UNDO_MS));
    } catch (error) { dispatch({ type: 'failed', keys: [key], message: error?.message }); }
  }, [call, identity, target, refresh]);
  const undo = useCallback(async key => {
    const removed = state.undo[key];
    if (!removed?.length) return;
    clearTimeout(layer.current.timers.get(key));
    try { await call('materials.translation.save', { ...identity, target, restore: removed }); await refresh(); dispatch({ type: 'undone', keys: [key] }); }
    catch (error) { dispatch({ type: 'failed', keys: [key], message: error?.message }); }
  }, [call, identity, target, state.undo, refresh]);
  useEffect(() => () => layer.current.timers.forEach(timer => clearTimeout(timer)), []);

  /* ---------- the page / chapter job ---------- */
  const loadJobs = useCallback(async () => {
    if (!identity) return;
    try { const listed = await call('generation.translation.jobs', { documentId: identity.documentId }); setJobs(listed?.jobs || []); } catch { /* the job list is a convenience */ }
  }, [call, identity]);
  useEffect(() => { if (supported) void loadJobs(); }, [supported, loadJobs]);
  const [finishedHere, setFinishedHere] = useState(() => new Set());
  // A running job is always shown; a finished one only if it ended while this reader was open (an old result is not news).
  const job = jobs.find(jobActive) || jobToShow(jobs.filter(item => finishedHere.has(item.id) && !dismissed.has(item.id)));
  const active = jobs.some(jobActive);
  const seen = useRef(new Map());
  useEffect(() => {
    if (!active) return undefined;
    const timer = setInterval(() => { setNow(Date.now()); void loadJobs(); }, 1500);
    return () => clearInterval(timer);
  }, [active, loadJobs]);
  useEffect(() => {
    for (const item of jobs) {
      const before = seen.current.get(item.id);
      seen.current.set(item.id, jobActive(item) ? 'active' : 'done');
      if (before === 'active' && !jobActive(item)) {
        void refresh();
        setFinishedHere(set => new Set(set).add(item.id));
        const tone = item.status === 'complete' ? (item.rejected ? 'warning' : 'success') : item.status === 'cancelled' ? 'info' : 'error';
        onNotice({ text: item.status === 'complete' ? uiFormat('已译好 {0} 段。', [item.savedCount ?? item.translated ?? 0]) : item.status === 'cancelled' ? ui('已停止翻译，已译的段落保留。') : ui('翻译没有完成，已译的段落保留。'), tone });
      }
    }
  }, [jobs, refresh, onNotice]);

  const openMenu = useCallback(async open => {
    setMenuOpen(open);
    if (!open || !identity) return;
    const spans = spanKeys();
    const defs = [{ id: 'page', label: paged ? ui('翻译本页') : ui('翻译本节'), short: paged ? ui('本页') : ui('本节'), paragraphs: spans.page },
      ...(spans.chapter ? [{ id: 'chapter', label: ui('翻译本章'), short: ui('本章'), paragraphs: spans.chapter }] : [])];
    scopeDefs.current = defs;
    setScopes(defs.map(def => ({ id: def.id, label: def.label, status: 'loading' })));
    for (const def of defs) {
      try {
        const priced = await call('generation.translation.start', { ...identity, target, passages: def.paragraphs.map(passageOf), estimate: true });
        setScopes(list => list.map(scope => scope.id === def.id ? { ...scope, status: 'ready', counts: priced.counts, estimate: priced.estimate, modelAvailable: priced.modelAvailable } : scope));
      } catch { setScopes(list => list.map(scope => scope.id === def.id ? { ...scope, status: 'error' } : scope)); }
    }
  }, [call, identity, target, spanKeys, paged]);

  const start = useCallback(async scopeId => {
    const def = scopeDefs.current.find(item => item.id === scopeId);
    if (!def || !identity) return;
    try {
      const started = await call('generation.translation.start', { ...identity, target, passages: def.paragraphs.map(passageOf), label: def.short });
      if (started?.available === false) { dispatch({ type: 'unavailable', keys: [] }); return; }
      setMenuOpen(false);
      if (started.status === 'nothing') { onNotice({ text: ui('这里没有还需要翻译的段落。'), tone: 'info' }); return; }
      onNotice({ text: started.alreadyRunning ? ui('这部分已经在翻译了。') : uiFormat('已开始翻译，共 {0} 段，后台进行，完成后进信箱。', [started.job?.total ?? 0]), tone: 'info' });
      await loadJobs();
    } catch (error) { onNotice({ text: error?.message || ui('出现未知错误'), tone: 'error' }); }
  }, [call, identity, target, loadJobs, onNotice]);
  const stopJob = useCallback(async () => { if (job) { try { await call('job.cancel', { jobId: job.id }); } catch { /* it had ended */ } await loadJobs(); } }, [call, job, loadJobs]);

  const setTarget = useCallback(async next => {
    if (!identity || next === target) return;
    try { await call('materials.translation.glossary.set', { ...identity, target: next }); await refresh(); void openMenu(true); } catch (error) { onNotice({ text: error?.message || ui('出现未知错误'), tone: 'error' }); }
  }, [call, identity, target, refresh, onNotice, openMenu]);

  const showAll = useCallback(value => {
    const spans = spanKeys(), keys = spans.page.map(paragraph => paragraph.key).filter(key => state.items[key]);
    // Folding everything in 隐藏译文 hides them again; in the other modes it leaves each block's bar.
    if (keys.length) dispatch({ type: 'show', keys, value: value || mode !== 'hidden' ? value : undefined });
    setMenuOpen(false);
  }, [spanKeys, state.items, mode]);

  const saveGlossary = useCallback(async glossary => {
    const result = await call('materials.translation.glossary.set', { ...identity, glossary });
    dispatch({ type: 'glossary', glossary: result.glossary, target: result.target });
    await refresh();
    return result;
  }, [call, identity, refresh]);
  const priceAgain = useCallback(async passages => { try { return (await call('generation.translation.start', { ...identity, target, passages, retranslate: true, estimate: true })).estimate; } catch { return null; } }, [call, identity, target]);
  const retranslateMany = useCallback(async passages => {
    const started = await call('generation.translation.start', { ...identity, target, passages, retranslate: true, label: ui('术语表更新') });
    if (started?.available === false) throw new Error(gateMessage('translate'));
    await loadJobs();
  }, [call, identity, target, loadJobs]);

  /* ---------- what the viewer places ---------- */
  const blockFor = key => {
    const item = state.items[key], pending = state.pending[key], error = state.errors[key], undoable = state.undo[key];
    const common = { target, onGlossary: () => setGlossaryOpen(true) };
    if (undoable && !item) return <TranslationBlock {...common} state="undo" onUndo={() => undo(key)} />;
    if (pending && !item) return <TranslationBlock {...common} state="pending" onCancel={() => cancel(key)} />;
    if (error && !item) return <TranslationBlock {...common} state="error" error={error} onRetry={() => { const paragraph = layer.current.byKey.get(key); if (paragraph) void send([paragraphEntry(paragraph)]); }} onDismiss={() => { dispatch({ type: 'dismiss-error', keys: [key] }); layer.current.pinned.delete(key); }} />;
    if (!item) return null;
    const entry = () => entryOfItem(item);
    return <TranslationBlock {...common} state={pending ? 'pending' : 'ok'} item={item} pendingKind={pending} open={blockState(state, key, mode) === 'open'}
      onToggle={() => dispatch({ type: 'show', keys: [key], value: blockState(state, key, mode) !== 'open' })} onDelete={() => remove(key)} onCancel={() => cancel(key)}
      onRetranslate={comment => { const made = entry(); if (made) void send([made], { retranslate: true, comment }); }} />;
  };
  const layerNodes = <>
    {[...hosts].map(([key, host]) => createPortal(blockFor(key), host, key))}
    {page && chip && !floating && createPortal(<SelectionChip left={chip.left} top={chip.top} target={target} onClick={() => translateSelection(captureSelection(body.current))} />, page)}
    {page && floating && blockFor(floating.key) && createPortal(<FloatingTranslation left={floating.left} top={floating.top} onClose={() => setFloating(null)}>{blockFor(floating.key)}</FloatingTranslation>, page)}
    {glossaryOpen && <GlossaryDialog glossary={state.glossary} target={target} onSave={saveGlossary} onPrice={priceAgain} onRetranslate={retranslateMany} onClose={() => setGlossaryOpen(false)} />}
  </>;
  const hasTranslations = Object.keys(state.items).length > 0;
  return {
    supported,
    displayRow: supported ? <TranslationDisplayRow mode={settings.mode} target={target} narrow={crowded} onChange={next => { dispatch({ type: 'show-reset' }); setSettings({ mode: next }); }} /> : null,
    toolbar: supported && view !== 'original' ? <TranslationMenu open={menuOpen} onOpenChange={openMenu} scopes={scopes} target={target} modelAvailable={state.modelAvailable} stale={state.stale}
      busy={active} mode={mode} hasTranslations={hasTranslations} onStart={start} onExpandAll={() => showAll(true)} onCollapseAll={() => showAll(false)} onGlossary={() => { setMenuOpen(false); setGlossaryOpen(true); }} onTarget={setTarget} /> : null,
    notice: supported && job ? <TranslationJobCard key="translation-job" job={job} now={now} onStop={stopJob} onDismiss={() => setDismissed(set => new Set(set).add(job.id))} /> : null,
    layer: supported ? layerNodes : null,
  };
}
