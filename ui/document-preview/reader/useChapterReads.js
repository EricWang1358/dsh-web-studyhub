/* global document window */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLiveEffect } from '../../use-async.js';
import { READ_AT, chapterRefs, drainReads, queueRead, scrollProgress } from './chapter-reads.js';

/* The learner's own input in the reader: a chapter the reader scrolled by itself (a restored place, a jump) is not read until the learner has used it. */
const INPUT = ['wheel', 'touchmove', 'keydown', 'pointerdown'];

/**
 * 已读 of the reader's chapters (#1014), kept in the study library (materials.reading.*). The chapters read are asked for once per material, revision and
 * chapter list. While `watching` (the text of chapter `current` is on screen), a chapter the learner has scrolled READ_AT through is read at once on screen;
 * the library is written when the chapter changes, when the reader closes, or when the page is hidden: never while scrolling. `unread(id)` takes a ✓ back
 * and is written at once.
 * target: { sourceId, revision } (how materials.document.get named the material) or null; chapters: the reader's (reader/chapters.js).
 * Returns { ready, read: Set of chapter ids, count, unread(id) }.
 */
export function useChapterReads({ call, target, chapters, current, scroller, root, watching }) {
  const refs = useMemo(() => chapterRefs(chapters), [chapters]);
  const signature = refs.map(chapter => `${chapter.id}:${chapter.title}:${chapter.startPage}-${chapter.endPage}`).join('|');
  const [state, setState] = useState({ key: '', read: new Set() });
  const key = target && refs.length ? `${target.sourceId}|${target.revision}|${signature}` : '';
  const latest = useRef({}); latest.current = { call, target, refs, key };
  const pending = useRef(new Map());

  useLiveEffect(live => {
    if (!key || !call) return;
    call('materials.reading.get', { ...latest.current.target, chapters: latest.current.refs })
      .then(result => { if (live()) setState({ key, read: new Set(result?.read || []) }); })
      .catch(() => { if (live()) setState({ key, read: new Set() }); });
  }, [key, call]);
  const ready = state.key === key && !!key;
  const read = ready ? state.read : EMPTY;

  // Each change is queued with the material, revision and chapter of its moment (chapter-reads.js queueRead), so a write that comes after an outline
  // was applied or a revision loaded (the cleanup below runs after `latest` names the new list) still names what was read.
  const flush = useCallback(() => {
    const send = latest.current.call;
    if (!pending.current.size || !send) return;
    for (const group of drainReads(pending.current)) {
      send('materials.reading.save', { ...group.target, chapters: group.chapters, read: group.read, unread: group.unread }).catch(() => {
        // Not kept: tried again with the next write, unless the learner changed the same chapter since.
        for (const entry of group.entries) if (!pending.current.has(entry.key)) pending.current.set(entry.key, entry);
      });
    }
  }, []);
  const change = useCallback((id, value) => {
    setState(previous => {
      if (previous.read.has(id) === value) return previous;
      const next = new Set(previous.read);
      if (value) next.add(id); else next.delete(id);
      return { ...previous, read: next };
    });
    const { target: at, refs: list } = latest.current;
    queueRead(pending.current, { target: at, chapters: list, id, value });
  }, []);
  const unread = useCallback(id => { change(id, false); flush(); }, [change, flush]);

  // Written when the chapter changes and when the reader closes (the cleanup), and when the page is hidden (another window, the app closing).
  const currentId = current?.id ?? null;
  useEffect(() => flush, [currentId, key, flush]);
  useEffect(() => {
    const hidden = () => { if (document.visibilityState === 'hidden') flush(); };
    document.addEventListener('visibilitychange', hidden);
    window.addEventListener('pagehide', flush);
    return () => { document.removeEventListener('visibilitychange', hidden); window.removeEventListener('pagehide', flush); };
  }, [flush]);

  // Read: scrolled READ_AT through the chapter on screen, by the learner. Measured at most once a frame; state changes once per chapter.
  const done = ready && currentId != null && read.has(currentId);
  useEffect(() => {
    const area = scroller.current, frame = root.current || area;
    if (!watching || !ready || currentId == null || done || !area) return undefined;
    let touched = false, tick = 0;
    const check = () => { tick = 0; if (touched && scrollProgress(area) >= READ_AT) change(currentId, true); };
    const schedule = () => { if (!tick) tick = requestAnimationFrame(check); };
    const used = () => { touched = true; schedule(); };
    for (const name of INPUT) frame.addEventListener(name, used, { passive: true });
    area.addEventListener('scroll', schedule, { passive: true });
    return () => {
      for (const name of INPUT) frame.removeEventListener(name, used);
      area.removeEventListener('scroll', schedule);
      if (tick) cancelAnimationFrame(tick);
    };
  }, [watching, ready, currentId, done, scroller, root, change]);

  const count = useMemo(() => refs.filter(chapter => read.has(chapter.id)).length, [refs, read]);
  return { ready, read, count, unread };
}

const EMPTY = new Set();
