import React, { useEffect, useId, useRef, useState } from 'react';
import { ui, uiFormat, errorMessage } from '../i18n.js';
import { Button, Field, Hint, Icon, NumberInput, SettingsSection, Tooltip, useToast } from '../components/index.js';
import { LIMITS, previewSchedule } from '../../lib/sm2.js';
import { syncScheduleSettings } from '../schedule-settings.js';
import { formatList } from '../format.js';
import { useStudy } from '../study-context.jsx';

/* ---------- 间隔复习 · FSRS-6 ---------- */

/* The two numbers a learner may change (lib/sm2.js defaults). The target recall is saved as 0.9 and shown as 90%. Each label has its
   explanation in a hover Tooltip. */
const FIELDS = [
  { key: 'request_retention', label: '目标记忆率', unit: '%', scale: 100, ...LIMITS.request_retention,
    tip: '下次复习时，希望还有多大把握记得这道题。调高：复习更勤，记得更牢；调低：复习更少，忘得也更多。默认 90%，可设 70%–97%。' },
  { key: 'maximum_interval', label: '最长间隔', unit: '天', scale: 1, ...LIMITS.maximum_interval,
    tip: '两次复习之间最多隔几天。离考试不远时，可以设成离考试天数的一半：之后排出的间隔都不会超过它。已经排好的复习日期不会提前，要等那道题下次作答时才按新的上限排。默认 36500 天，相当于不设上限。' },
];
const numbers = (settings = {}) => Object.fromEntries(FIELDS.map(({ key }) => [key, Number(settings[key])]));
/** What the input shows: 0.9 → 90; blank stays blank. */
const shown = (field, value) => (value === undefined || value === null || Number.isNaN(value) ? '' : Math.round(value * field.scale * 100) / 100);
const dayList = points => formatList(points.map(point => point.day));
const TICKS = [[1, '1 天'], [7, '1 周'], [30, '1 个月'], [90, '3 个月'], [180, '半年'], [365, '1 年'], [730, '2 年'], [1825, '5 年'], [3650, '10 年']];
const PREVIEW_REVIEWS = 5;

/** The predicted review days for "熟练" and "勉强答对" answers, drawn on a square-root time axis. */
function SchedulePreview({ good, hard }) {
  const titleId = useId(), descId = useId();
  if (!good) return <Hint className="sm2-preview">{ui('填好两个数值后，这里会显示复习时间预览。')}</Hint>;
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

/** FSRS-6 settings: two number fields with their explanations on hover, a live preview and save/undo. The defaults just work. */
export function ScheduleSection({ root, settings = {}, saved = {}, setSettings }) {
  const { busy, act } = useStudy();
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
  const dirty = FIELDS.some(({ key }) => Number(settings[key]) !== baseline[key]);
  const current = numbers(settings);
  const good = previewSchedule(current, { grade: 4, reviews: PREVIEW_REVIEWS }), hard = good && previewSchedule(current, { grade: 3, reviews: PREVIEW_REVIEWS });
  const save = async event => {
    event.preventDefault();
    if (busy || pending.current || !dirty || !good) return;
    const changes = Object.fromEntries(FIELDS.filter(({ key }) => current[key] !== baseline[key]).map(({ key }) => [key, current[key]]));
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
      <SettingsSection className="sm2-settings" title={ui('间隔复习 · FSRS-6')} lead={ui('每次作答后，按上次复习到现在实际隔了几天、这次答得怎样，估算这道题还能记多久，在预计还记得的把握降到目标时安排下一次复习。答错会缩短间隔，但不一定回到 1 天。')}>
        <div className="sm2-fields">
          {FIELDS.map(field => <Field key={field.key} width="sm" label={<>{ui(field.label)}{' '}<Tooltip layer content={ui(field.tip)}>
              <span tabIndex={0} className="sm2-field-tip" aria-label={uiFormat('「{0}」是什么', [ui(field.label)])}><Icon name="info" size={16} /></span>
            </Tooltip></>}>
            <NumberInput required min={field.min * field.scale} max={field.max * field.scale} step="1" suffix={field.unit === '%' ? '%' : ui(field.unit)} value={shown(field, settings[field.key])} disabled={busy}
              onChange={(e) => { const value = e.target.value === '' ? NaN : Number(e.target.value) / field.scale; setError(''); setSettings(previous => ({ ...previous, [field.key]: value })); }} />
          </Field>)}
        </div>
        <Hint>{ui('默认值就能用；只有想复习得更勤或更少时才需要改。')}</Hint>
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
