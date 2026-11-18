import React from 'react';
import { ui, uiFormat } from '../i18n.js';
import { Button, Tooltip } from '../components/index.js';
import { useStudy } from '../study-context.jsx';
import { reviewEntryKey } from '../async.js';
import { createFlightSet } from './session-logic.js';
import { pageAvailable } from '../capabilities.js';
import { displayTitle } from '../../lib/document-title.js';

const MAX_ROUND_CACHE = 200;
const CALL_CACHES = new WeakMap();

function placeStoreFor(call, fallbackRef) {
  if (typeof call !== 'function') return fallbackRef.current;
  let store = CALL_CACHES.get(call);
  if (!store) {
    store = { runId: null, places: new Map(), flights: createFlightSet(), listeners: new Set() };
    CALL_CACHES.set(call, store);
  }
  return store;
}

/**
 * Fetches `card.place` at most once per question entry in a round (`(run.id, reviewEntryKey(run))`),
 * sharing cache and in-flight requests across callers backed by the same `call` function.
 */
export function useCardPlace({ call, run, enabled = true } = {}) {
  const localRef = React.useRef({ runId: null, places: new Map(), flights: createFlightSet(), listeners: new Set() });
  const store = placeStoreFor(call, localRef);
  const runId = run?.id ?? null;
  if (store.runId !== runId) {
    store.runId = runId;
    store.places.clear();
  }

  const hidden = !enabled || !run || run.mode === 'exam' || run.complete || !run.card?.id;
  const entryKey = hidden ? '' : reviewEntryKey(run);
  const cardId = hidden ? '' : run.card.id;
  const deckId = hidden ? '' : (run.deckId || run.card?.deckId || '');
  const preset = !hidden && run.cardPlace !== undefined ? run.cardPlace : undefined;
  const cached = entryKey && store.places.has(entryKey) ? store.places.get(entryKey) : undefined;
  const [, setVersion] = React.useState(0);

  React.useEffect(() => {
    if (hidden || preset !== undefined || !entryKey || typeof call !== 'function') return undefined;
    const listener = (updatedKey) => {
      if (updatedKey === entryKey) setVersion((value) => value + 1);
    };
    store.listeners.add(listener);
    if (store.places.has(entryKey)) {
      if (cached === undefined) setVersion((value) => value + 1);
    } else {
      const flightKey = `${runId ?? ''}:${entryKey}`;
      if (store.flights.begin(flightKey)) {
        const expectedRunId = runId;
        Promise.resolve(call('card.place', { ...(deckId ? { deckId } : {}), cardId }))
          .then((result) => {
            if (store.runId !== expectedRunId) return;
            store.places.set(entryKey, result ?? null);
            if (store.places.size > MAX_ROUND_CACHE) store.places.delete(store.places.keys().next().value);
            for (const notify of store.listeners) notify(entryKey);
          })
          .catch(() => {})
          .finally(() => {
            store.flights.end(flightKey);
          });
      }
    }
    return () => {
      store.listeners.delete(listener);
    };
  }, [cached, call, cardId, deckId, entryKey, hidden, preset, runId, store]);

  if (hidden) return null;
  if (cached !== undefined) return cached;
  return preset !== undefined ? preset : null;
}

function hasCourseMaterials(sources, course) {
  const list = (Array.isArray(sources) ? sources : []).filter((source) => !source?.archived);
  if (!list.length) return false;
  if (typeof course !== 'string' || !course) return true;
  return list.some((source) => !Array.isArray(source.courses) || !source.courses.length
    || source.courses.some((item) => item === course || course.startsWith(`${item}/`) || item.startsWith(`${course}/`)));
}

/**
 * Quiet source trail under the practice page heading: `出处 · {资料名} › {章名}` (or `出处 · {资料名}` without a chapter).
 * Fetches `card.place` once per question entry in the round (`reviewEntryKey`) when `place` is omitted, reserves no space
 * while loading, hides when unplaced or during exams/results, and navigates to the course outline when available.
 */
export default function QuestionPlace({ data, run, place: placeProp, onOpenOutline }) {
  const { call } = useStudy();
  const fetchedPlace = useCardPlace({ call, run, enabled: placeProp === undefined });
  const place = placeProp !== undefined ? placeProp : fetchedPlace;
  const hidden = !run || run.mode === 'exam' || run.complete || !run.card?.id;

  if (hidden || !place || (!place.document && !place.chapter && !place.leaf)) return null;

  const docTitle = place.document?.title ? displayTitle(place.document.title) : '';
  const chapterTitle = place.chapter?.title || '';
  const pathText = docTitle
    ? (chapterTitle ? `${docTitle} › ${chapterTitle}` : docTitle)
    : (place.leaf?.title || '');
  if (!pathText) return null;

  const targetKey = place.chapter?.key || place.document?.key || place.leaf?.key || '';
  const clickable = Boolean(
    onOpenOutline
    && pageAvailable(data, 'outline')
    && targetKey
    && hasCourseMaterials(data?.sources, place.course),
  );
  const fullTip = clickable
    ? uiFormat('出处：{0}\n点此打开总纲定位到这一处', [pathText])
    : uiFormat('出处：{0}', [pathText]);

  const label = (
    <span className="review-place__text">
      <span className="review-context__label">{ui('出处 ·')}</span>
      {' '}
      {pathText}
    </span>
  );

  if (!clickable) {
    return (
      <Tooltip layer anchorClassName="review-place__anchor" content={fullTip}>
        <span className="review-context__part review-place review-place-static" tabIndex={0} data-review-place="">
          {label}
        </span>
      </Tooltip>
    );
  }

  return (
    <Tooltip layer anchorClassName="review-place__anchor" content={fullTip}>
      <Button
        variant="quiet"
        size="sm"
        iconEnd="arrow-right"
        className="review-context__part review-place review-place-link"
        data-review-place=""
        onClick={() => onOpenOutline(place)}
      >
        {label}
      </Button>
    </Tooltip>
  );
}
