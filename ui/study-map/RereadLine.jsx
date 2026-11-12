import React, { useState } from 'react';
import { ui, uiFormat } from '../i18n.js';
import { Button, Tooltip } from '../components/index.js';
import { useStudy } from '../study-context.jsx';
import { useLiveEffect } from '../use-async.js';
import { resolvePracticeSettings } from '../../lib/practice-settings.js';
import { localDate } from '../../lib/board-model.js';

/* 今日 「重读 N 段」 (#1018): the highlighter and bold marks of the reader that are worth re-reading today (materials.marks.reread: not looked at for
   3 days, in a chapter or page with due or weak questions, at most 3 a day). One quiet line in the today card; nothing at all when there is
   nothing to re-read, or when 设置 › 练习 turned it off. Asked after the home is drawn, once per library revision, course and day (the answer
   is kept here, so coming back to the home asks nothing); while a newer revision's answer is on its way the last one of the same course and day
   stays, so the line does not blink after each answer. A click opens the reader at the first passage, the way a citation opens it. The line sits
   under the day's button (TodayCard's `extra`), so it coming or going never moves that button. */
const kept = new Map();
const KEPT_MAX = 8;
const keyOf = (data, course, day) => JSON.stringify([data?.root ?? '', data?.revision ?? '', course, day]);
/** The same library, course and day at any revision: an answer of this place may stand in while the current one is asked. */
const placeOf = (data, course, day) => JSON.stringify([data?.root ?? '', course, day]);

/** The places of the passages, for the hint: 「Patterns.pdf 第 3 页、Notes」. */
const places = items => items.map(item => item.page ? uiFormat('{0} 第 {1} 页', [item.title, item.page]) : item.title)
  .filter((place, index, all) => all.indexOf(place) === index).join(ui('、'));

export function useReread(data) {
  const { call } = useStudy();
  const on = resolvePracticeSettings(data?.settings?.practice).rereadMarks;
  const course = typeof data?.focus?.course === 'string' ? data.focus.course : '', day = localDate();
  const key = keyOf(data, course, day), place = placeOf(data, course, day);
  const [answer, setAnswer] = useState(() => kept.get(key) || null);
  useLiveEffect(isLive => {
    if (!on || !data?.root) { setAnswer(null); return; }
    if (kept.has(key)) { setAnswer(kept.get(key)); return; }
    const todayStart = new Date(`${day}T00:00:00`).getTime();
    call('materials.marks.reread', { ...(course ? { course } : {}), todayStart }).then(result => {
      const value = { key, place, items: Array.isArray(result?.items) ? result.items : [] };
      kept.set(key, value);
      while (kept.size > KEPT_MAX) kept.delete(kept.keys().next().value);
      if (isLive()) setAnswer(value);
    }, () => { if (isLive()) setAnswer(null); });
  }, [call, on, key]);
  return on && (answer?.key === key || answer?.place === place) ? answer.items : [];
}

/** The line itself. `data`: the snapshot. */
export default function RereadLine({ data }) {
  const { openModal, busy } = useStudy();
  const items = useReread(data);
  if (!items.length) return null;
  const open = () => {
    const first = items[0], source = (data.sources || []).find(item => item.id === first.selection.sourceId);
    if (!source) return;
    openModal({ type: 'source', source: { ...source, selection: first.selection }, quote: first.selection.quote, reread: { items, index: 0 } });
  };
  return (
    <p className="today-reread" data-reread={items.length}>
      <span>{ui('划过的重点')}</span>
      <Tooltip layer content={uiFormat('3 天没再看、所在章节或页有到期或薄弱题：{0}', [places(items)])}>
        <Button variant="link" size="sm" wrap lock={busy} data-usage="home.reread" onClick={open}>{uiFormat('重读 {0} 段', [items.length])}</Button>
      </Tooltip>
    </p>
  );
}
