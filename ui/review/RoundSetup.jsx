import React, { useState } from 'react';
import { ui, uiFormat } from '../i18n.js';
import { Button, Field, Hint, IconButton, NumberInput, Popover, SegmentedControl, Select, useToast } from '../components/index.js';
import { cx } from '../components/css.js';
import { useInjectCss } from '../shared.js';
import { useStudy } from '../study-context.jsx';
import { ROUND_SIZE_LIMITS, isRoundSize, resolvePracticeSettings } from '../../lib/practice-settings.js';
import { chaptersOf, rememberPatch, roundArgs, roundChoice, roundDefaults, roundKey, sameRound } from './round-setup.js';
import css from './round-setup.css';

/* 本轮设置 (#1010): the small popover beside a start button (the home's 开始今日学习, the result page's next round). It is optional: the button beside it
   starts exactly what it always started, and the popover is one more click for the learner who wants this round to be 10 wrong questions or one chapter.
   Nothing here is a second settings system: it opens on the defaults of 设置 › 练习 (or the course's last choice), a change affects this round only, 设为默认 writes the
   size through the same settings.practice.set, and the round is the ordinary review.start whose bounds are the settings' own (ui/review/round-setup.js has the rules). */

const PRESETS = [10, 20, 30];
const RANGE_HINTS = {
  mixed: '先复习到期的，再练错题，最后补新题，和首页的「今日学习」排法相同。',
  due: '只出已经到了复习时间的题。',
  new: '只出还没学过的新题。',
  wrong: '只练最近一次答错的题。',
};
const rangeOptions = () => [{ value: 'mixed', label: ui('混合') }, { value: 'due', label: ui('到期') }, { value: 'new', label: ui('新题') }, { value: 'wrong', label: ui('错题') }];

function Form({ data, context, chapterRefs, onStart, onPickPages, close }) {
  const { act, call, busy } = useStudy();
  const toast = useToast();
  const practice = data?.settings?.practice;
  const defaults = roundDefaults(practice, context), saved = resolvePracticeSettings(practice).lastRounds?.[roundKey(context.course)];
  const [choice, setChoice] = useState(() => roundChoice(practice, context, data));
  const [text, setText] = useState(() => String(choice.size));
  const chapters = chaptersOf(data, chapterRefs);
  const sizeOk = isRoundSize(Number(text)) && Number.isInteger(Number(text)) && text.trim() !== '';
  const picked = sizeOk ? { ...choice, size: Number(text) } : choice;
  const setSize = (size) => { setText(String(size)); setChoice((current) => ({ ...current, size })); };
  const typeSize = (value) => { setText(value); const number = Number(value); if (value.trim() !== '' && isRoundSize(number)) setChoice((current) => ({ ...current, size: number })); };
  const go = async (event) => {
    event.preventDefault();
    if (!sizeOk) return;
    const patch = rememberPatch(picked, context, defaults);
    // Remembering is a convenience: a failure here never stops the round.
    if (patch && JSON.stringify(patch.lastRounds[roundKey(context.course)] ?? null) !== JSON.stringify(saved ?? null)) { try { await call('settings.practice.set', { patch }); } catch { /* not remembered */ } }
    close();
    onStart(roundArgs(picked, context, defaults));
  };
  const setDefault = () => act('settings.practice.set', { patch: { roundSize: picked.size } }, () => toast.success(ui('练习设置已保存')));
  const differs = !sameRound(picked, defaults);
  return <form className="round-setup__form" onSubmit={go} data-round-setup noValidate>
    <Field group label={ui('题数')} width="full">
      <SegmentedControl size="sm" fill label={ui('题数')} value={PRESETS.includes(picked.size) && sizeOk ? picked.size : null} onChange={setSize}
        options={PRESETS.map((size) => ({ value: size, label: String(size) }))} />
    </Field>
    <div className="round-setup__custom">
      <Field label={ui('自定义')} width="full" error={sizeOk ? undefined : uiFormat('题数需为 {0}–{1} 的整数', [ROUND_SIZE_LIMITS.min, ROUND_SIZE_LIMITS.max])}>
        <NumberInput inputMode="numeric" name="round-size" className="round-setup__size" min={ROUND_SIZE_LIMITS.min} max={ROUND_SIZE_LIMITS.max} step="1" value={text} suffix={ui('题')}
          onChange={(event) => typeSize(event.target.value)} />
      </Field>
      {sizeOk && picked.size !== defaults.size && (
        <Button size="sm" variant="quiet" className="round-setup__default" lock={busy} onClick={setDefault}>{ui('设为默认')}</Button>
      )}
    </div>
    <Field group label={ui('范围')} width="full" hint={ui(RANGE_HINTS[picked.range])}>
      <SegmentedControl size="sm" fill label={ui('范围')} value={picked.range} onChange={(range) => setChoice((current) => ({ ...current, range }))} options={rangeOptions()} />
    </Field>
    {chapters.length > 0 && (
      <Field label={ui('只练某章')} width="full">
        <Select name="round-chapter" value={picked.chapter ? JSON.stringify([picked.chapter.deckId, picked.chapter.topic]) : ''}
          onChange={(value) => setChoice((current) => ({ ...current, chapter: chapters.find((item) => item.value === value)?.ref ?? null }))}
          options={[{ value: '', label: ui('整个范围') }, ...chapters.map((item) => ({ value: item.value, label: item.label }))]} />
      </Field>
    )}
    {typeof onPickPages === 'function' && (
      <Button variant="link" size="sm" className="round-setup__pages" onClick={() => { close(); onPickPages(); }}>{ui('按页码选题…')}</Button>
    )}
    <div className="round-setup__actions">
      {differs && <Button size="sm" variant="quiet" onClick={() => { const fresh = roundDefaults(practice, context); setChoice(fresh); setText(String(fresh.size)); }}>{ui('恢复默认')}</Button>}
      <Button type="submit" variant="primary" className="round-setup__start" lock={busy} disabled={!sizeOk} data-usage="round.setup.start">{ui('开始本轮')}</Button>
    </div>
    <Hint size="xs">{ui('只对这一轮有效；想让题数一直这样，点「设为默认」。')}</Hint>
  </form>;
}

/**
 * The 本轮设置 button and its popover. `context`: { course, scope, range, base } (ui/review/round-setup.js); `chapterRefs`: the decks whose topics are the
 * chapters ({ deckId }[]); `onStart(args)`: starts the round (the page's own review.start); `onPickPages`: the reader's page choice, when the page has one.
 */
export default function RoundSetup({ data, context, chapterRefs, onStart, onPickPages, className, size = 'md' }) {
  useInjectCss(css, 'study-round-setup');
  const [open, setOpen] = useState(false);
  return <Popover open={open} onOpenChange={setOpen} label={ui('本轮设置')} className={cx('round-setup', className)} panelClassName="round-setup__panel" placement="bottom-end"
    trigger={({ props, ref }) => <IconButton ref={ref} icon="settings" label={ui('本轮设置')} variant="secondary" size={size} className="round-setup__trigger" data-usage="round.setup" {...props} />}>
    <Form data={data} context={context} chapterRefs={chapterRefs} onStart={onStart} onPickPages={onPickPages} close={() => setOpen(false)} />
  </Popover>;
}
