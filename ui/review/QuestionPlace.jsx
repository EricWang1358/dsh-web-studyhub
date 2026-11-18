import React from 'react';
import { ui, uiFormat } from '../i18n.js';
import { Button, Tooltip } from '../components/index.js';
import { useStudy } from '../study-context.jsx';
import { reviewEntryKey } from '../async.js';
import { createFlightSet } from './session-logic.js';
import { pageAvailable } from '../capabilities.js';
import { displayTitle } from '../../lib/document-title.js';

const MAX_ROUND_CACHE = 200;

function hasCourseMaterials(sources, course) {
  const list = (Array.isArray(sources) ? sources : []).filter((source) => !source?.archived);
  if (!list.length) return false;
  if (typeof course !== 'string' || !course) return true;
  return list.some((source) => !Array.isArray(source.courses) || !source.courses.length
    || source.courses.some((item) => item === course || course.startsWith(`${item}/`) || item.startsWith(`${course}/`)));
}

/**
 * Quiet source trail under the practice page heading: `出处 · {资料名} › {章名}` (or `出处 · {资料名}` without a chapter).
 * Fetches `card.place` once per question entry in the round (`reviewEntryKey`), reserves no space while loading, hides
 * when unplaced or during exams/results, and navigates to the course outline when available.
 */
export default function QuestionPlace({ data, run, onOpenOutline }) {
  const { call } = useStudy();
  const cacheRef = React.useRef({ runId: null, places: new Map() });
  const flightsRef = React.useRef(createFlightSet());
  const mountedRef = React.useRef(true);
  const activeKeyRef = React.useRef('');
  const [, setVersion] = React.useState(0);

  React.useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  if (cacheRef.current.runId !== (run?.id ?? null)) {
    cacheRef.current = { runId: run?.id ?? null, places: new Map() };
  }

  const hidden = !run || run.mode === 'exam' || run.complete || !run.card?.id;
  const entryKey = hidden ? '' : reviewEntryKey(run);
  const cardId = hidden ? '' : run.card.id;
  const deckId = hidden ? '' : (run.deckId || run.card?.deckId || '');
  activeKeyRef.current = entryKey;

  const cached = entryKey && cacheRef.current.places.has(entryKey) ? cacheRef.current.places.get(entryKey) : undefined;
  const preset = !hidden && run.cardPlace !== undefined ? run.cardPlace : undefined;
  const place = cached !== undefined ? cached : preset;

  React.useEffect(() => {
    if (hidden || preset !== undefined || !entryKey || typeof call !== 'function') return;
    const store = cacheRef.current.places;
    if (store.has(entryKey)) return;
    const flightKey = `${run.id ?? ''}:${entryKey}`;
    if (!flightsRef.current.begin(flightKey)) return;
    Promise.resolve(call('card.place', { ...(deckId ? { deckId } : {}), cardId }))
      .then((result) => {
        store.set(entryKey, result ?? null);
        if (store.size > MAX_ROUND_CACHE) store.delete(store.keys().next().value);
        if (mountedRef.current && activeKeyRef.current === entryKey) {
          setVersion((value) => value + 1);
        }
      })
      .catch(() => {})
      .finally(() => {
        flightsRef.current.end(flightKey);
      });
  }, [call, cardId, deckId, entryKey, hidden, preset, run?.id]);

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
