import React, { useEffect, useId, useRef, useState } from 'react';
import { ui, uiFormat, errorMessage } from '../i18n.js';
import { Button, Field, Hint, NumberInput, SettingsSection, useToast } from '../components/index.js';
import { previewSchedule } from '../../lib/sm2.js';
import { syncScheduleSettings } from '../schedule-settings.js';
import { formatList } from '../format.js';

/* ---------- 间隔复习 · SM-2 ---------- */

const SM2_FIELDS = [
  ['first_interval_days', '首次间隔', '天', 1, 1],
  ['second_interval_days', '第二次间隔', '天', 1, 1],
  ['initial_ease_factor', '初始熟练系数', '', 0.1, 0.1],
  ['minimum_ease_factor', '最低熟练系数', '', 0.1, 0.1],
];
const numbers = (settings = {}) => Object.fromEntries(SM2_FIELDS.map(([key]) => [key, Number(settings[key])]));
const dayList = points => formatList(points.map(point => point.day));
const TICKS = [[1, '1 天'], [7, '1 周'], [30, '1 个月'], [90, '3 个月'], [180, '半年'], [365, '1 年'], [730, '2 年']];

/** The predicted review days for "熟练" and "勉强答对" answers, drawn on a square-root time axis. */
function SchedulePreview({ good, hard }) {
  const titleId = useId(), descId = useId();
  if (!good) return <Hint className="sm2-preview">{ui('填好四个数值后，这里会显示复习时间预览。')}</Hint>;
  const width = 640, left = 16, right = 24, max = Math.max(30, good.at(-1).day, hard?.at(-1).day || 0);
  const x = day => left + Math.sqrt(day / max) * (width - left - right);
  const rows = [[good, 46, 'is-good'], ...(hard ? [[hard, 92, 'is-hard']] : [])];
  return <figure className="sm2-preview">
    <svg viewBox="0 0 640 150" role="img" aria-labelledby={titleId} aria-describedby={descId} preserveAspectRatio="xMinYMid meet">
      <title id={titleId}>{ui('复习时间预览')}</title>
      <desc id={descId}>{uiFormat('一直答「{0}」：第 {1} 天复习', [ui('熟练'), dayList(good)])}</desc>
      {TICKS.filter(([day]) => day <= max * 1.02).map(([day, label]) => <g key={day} className="sm2-tick">
        <line x1={x(day)} x2={x(day)} y1="16" y2="122" /><text x={x(day)} y="144" textAnchor="middle">{ui(label)}</text>
      </g>)}
      {rows.map(([points, y, tone]) => <g key={tone} className={`sm2-series ${tone}`}>
        <line className="sm2-track" x1={x(0)} x2={x(points.at(-1).day)} y1={y} y2={y} />
        {points.map(point => <g key={point.review}>
          <circle cx={x(point.day)} cy={y} r="5" />
          <text x={x(point.day)} y={tone === 'is-good' ? y - 12 : y + 20} textAnchor="middle">{point.day}</text>
        </g>)}
      </g>)}
    </svg>
    <figcaption>
      <span className="sm2-key is-good">{uiFormat('一直答「{0}」：第 {1} 天复习', [ui('熟练'), dayList(good)])}</span>
      {hard && <span className="sm2-key is-hard">{uiFormat('一直答「{0}」：第 {1} 天复习', [ui('勉强答对'), dayList(hard)])}</span>}
    </figcaption>
  </figure>;
}

/** SM-2 parameters: one compact row of number fields, a live preview and save/undo. */
export function ScheduleSection({ root, settings = {}, saved = {}, setSettings, act, busy }) {
  const toast = useToast();
  const savedKey = JSON.stringify(numbers(saved));
  const [baseline, setBaseline] = useState(() => numbers(saved));
  const [working, setWorking] = useState(false), [error, setError] = useState('');
  const previousSaved = useRef({ root, key: savedKey, values: numbers(saved) });
  const scope = useRef({ root, live: true }), pending = useRef(null);
  useEffect(() => {
    const owner = { root, live: true }; scope.current = owner; pending.current = null;
    setWorking(false); setError('');
    return () => { owner.live = false; };
  }, [root]);
  useEffect(() => {
    const before = previousSaved.current;
    if (before.root === root && before.key === savedKey) return;
    const incoming = JSON.parse(savedKey);
    previousSaved.current = { root, key: savedKey, values: incoming };
    setBaseline(incoming);
    setSettings(current => before.root === root ? syncScheduleSettings(current, before.values, incoming) : { ...current, ...incoming });
  }, [root, savedKey, setSettings]);
  const dirty = SM2_FIELDS.some(([key]) => Number(settings[key]) !== baseline[key]);
  const current = numbers(settings);
  const good = previewSchedule(current, { grade: 4, reviews: 6 }), hard = good && previewSchedule(current, { grade: 3, reviews: 6 });
  const save = async event => {
    event.preventDefault();
    if (busy || pending.current || !dirty || !good) return;
    const changes = Object.fromEntries(SM2_FIELDS.filter(([key]) => current[key] !== baseline[key]).map(([key]) => [key, current[key]]));
    const owner = scope.current, operation = {};
    pending.current = operation; setWorking(true); setError('');
    const isCurrent = () => owner.live && owner.root === root && scope.current === owner && pending.current === operation;
    try {
      await act('settings', changes, (result, context) => {
        if (!isCurrent() || context?.isCurrent?.() === false) return;
        const next = numbers(result);
        setBaseline(next);
        setSettings(previous => syncScheduleSettings(previous, current, next));
        toast.success(ui('复习调度已保存'));
      }, { rethrow: true });
    } catch (cause) { if (isCurrent()) setError(errorMessage(cause)); }
    finally { if (isCurrent()) { pending.current = null; setWorking(false); } }
  };
  return (
    <form className="settings-form" onSubmit={save}>
      <SettingsSection className="sm2-settings" title={ui('间隔复习 · SM-2')} lead={ui('答对时，下一次复习的间隔逐次拉长；答错时回到 1 天。')}>
        <div className="sm2-fields">
          {SM2_FIELDS.map(([key, label, unit, min, step]) => <Field key={key} label={ui(label)} width="sm">
            <NumberInput required min={min} max="365" step={step} suffix={unit ? ui(unit) : undefined} value={settings[key] ?? ''} disabled={busy}
              onChange={(e) => { const value = Number(e.target.value); setError(''); setSettings(previous => ({ ...previous, [key]: value })); }} />
          </Field>)}
        </div>
        <Hint>{ui('熟练系数越大，间隔增长越快；答得吃力时会下降，但不低于最低系数。')}</Hint>
        <SchedulePreview good={good} hard={hard} />
        {error && <Hint tone="error" role="alert">{error}</Hint>}
        <div className="settings-actions">
          <Button type="submit" variant="primary" busy={working} disabled={busy || !dirty || !good}>{ui('保存复习设置')}</Button>
          <Button variant="quiet" disabled={busy || working || !dirty} onClick={() => { setError(''); setSettings(previous => ({ ...previous, ...baseline })); }}>{ui('撤销未保存修改')}</Button>
        </div>
      </SettingsSection>
    </form>
  );
}
