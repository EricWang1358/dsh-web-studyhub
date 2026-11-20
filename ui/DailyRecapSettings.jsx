import React, { useEffect, useRef, useState } from 'react';
import { ui, uiFormat, uiLocale, errorMessage } from './i18n.js';
import { recapTimeZone } from './useDailyRecap.js';
import { Button, Checkbox, Field, Hint, Select, SettingsSection, useToast } from './components/index.js';
import { useStudy } from './study-context.jsx';

const valuesFor = saved => ({ automatic: saved?.automatic === true, tone: saved?.tone === 'professional' ? 'professional' : 'friendly', timeZone: recapTimeZone(saved) });

export default function DailyRecapSettings(props) {
  return <DailyRecapSettingsForm key={props.root} {...props} />;
}

export function DailyRecapSettingsForm({ root, saved }) {
  const { busy, act } = useStudy();
  const toast = useToast();
  const incoming = JSON.stringify(valuesFor(saved));
  const [editor, setEditor] = useState(() => ({ baseline: incoming, values: JSON.parse(incoming) }));
  const [working, setWorking] = useState(false), [error, setError] = useState('');
  const deviceTimeZone = recapTimeZone();
  const timeZoneName = new Intl.DateTimeFormat(uiLocale(), { timeZone: editor.values.timeZone, timeZoneName: 'longGeneric' })
    .formatToParts(new Date()).find(part => part.type === 'timeZoneName')?.value || editor.values.timeZone;
  const owner = useRef(null), pending = useRef(null), version = useRef(0);
  useEffect(() => {
    const token = { root, live: true }; owner.current = token;
    return () => { token.live = false; };
  }, [root]);
  useEffect(() => {
    setEditor(previous => ({ baseline: incoming, values: JSON.stringify(previous.values) === previous.baseline ? JSON.parse(incoming) : previous.values }));
  }, [incoming]);
  const edit = patch => { version.current++; setError(''); setEditor(previous => ({ ...previous, values: { ...previous.values, ...patch } })); };
  async function save(event) {
    event.preventDefault();
    if (busy || pending.current || !act || JSON.stringify(editor.values) === editor.baseline) return;
    const token = owner.current, revision = version.current, operation = {};
    pending.current = operation; setWorking(true); setError('');
    const live = () => token?.live && owner.current === token && pending.current === operation;
    try {
      await act('settings', { dailyRecap: editor.values }, (result, context) => {
        if (!live() || context?.isCurrent?.() === false) return;
        const next = valuesFor(result.dailyRecap || editor.values);
        setEditor(previous => ({ baseline: JSON.stringify(next), values: version.current === revision ? next : previous.values }));
        toast.success(ui('每日合集设置已保存'));
      }, { rethrow: true });
    } catch (cause) { if (live()) setError(errorMessage(cause)); }
    finally { if (live()) { pending.current = null; setWorking(false); } }
  }
  const dirty = JSON.stringify(editor.values) !== editor.baseline;
  const sameTimeZone = editor.values.timeZone === deviceTimeZone;
  return <form className="settings-form" onSubmit={save}>
    <SettingsSection tour="settings-daily-recap" disabled={busy || working} title={ui('每日讲解合集')}
      lead={ui('同一天同一门课答满 10 道不同题才生成，重点讲错题（错题不足 10 道也会总结要点，重复重练不重复计数）；开启后自动调用当前模型。')}>
      <Checkbox name="automatic" label={ui('自动准备并生成每日合集')} checked={editor.values.automatic} onChange={automatic => edit({ automatic })}
        hint={ui('默认关闭。开启后答满 10 道不同题会自动调用当前模型准备并整理合集，重点讲错题；你的手动修改会保留。')} />
      <Field label={ui('默认讲解口吻')} hint={ui('亲切：像一起复盘的助教；专业：简洁、严谨地讲清判断依据。手动生成时可单独调整。')}>
        <Select name="tone" value={editor.values.tone} onChange={tone => edit({ tone })}
          options={[{ value: 'friendly', label: ui('亲切') }, { value: 'professional', label: ui('专业') }]} />
      </Field>
      <Field group label={uiFormat('当天统计时区：{0}', [timeZoneName])}
        hint={ui('每天按保存的时区划分；继续做新题会更新今天的同一篇合集。')}>
        {sameTimeZone
          ? <Hint>{ui('与当前设备一致；跨时区后可在这里同步。')}</Hint>
          : <Button onClick={() => edit({ timeZone: deviceTimeZone })}>{ui('使用当前设备时区')}</Button>}
      </Field>
      {error && <Hint tone="error" role="alert">{error}</Hint>}
      <div className="settings-actions">
        <Button type="submit" variant="primary" disabled={!dirty} busy={working} busyLabel={ui('保存中…')} lock={busy}>{ui('保存每日合集设置')}</Button>
      </div>
      <Hint role="status">{ui(dirty ? '有未保存的修改；保存后对之后的合集生效。' : '改动后点上方按钮保存。')}</Hint>
    </SettingsSection>
  </form>;
}
