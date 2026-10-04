import React, { useEffect, useRef, useState } from 'react';
import { ui, uiFormat, uiLocale, errorMessage } from './i18n.js';
import { recapTimeZone } from './useDailyRecap.js';
import { Button, Checkbox, Field, Hint, Select, SettingsSection, useToast } from './components/index.js';

const valuesFor = saved => ({ automatic: saved?.automatic === true, tone: saved?.tone === 'professional' ? 'professional' : 'friendly', timeZone: recapTimeZone(saved) });

export default function DailyRecapSettings(props) {
  return <DailyRecapSettingsForm key={props.root} {...props} />;
}

export function DailyRecapSettingsForm({ root, saved, busy = false, act }) {
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
  return <form className="settings-form" onSubmit={save}>
    <SettingsSection tour="settings-daily-recap" disabled={busy || working} title={ui('每日错题讲解合集')}
      lead={ui('同一天、同一课程只保留一篇合集，累计完成 10 道不同题目才生成；错题不足 10 道也可以，重复重练不重复计数。')}>
      <Checkbox name="automatic" label={ui('自动准备并生成每日合集')} checked={editor.values.automatic} onChange={automatic => edit({ automatic })} />
      <Hint>{ui('默认关闭。开启后会使用当前 AI 模型：做题时逐步准备讲解，章节结束后统一整理语言和顺序。你的手动修改会保留。')}</Hint>
      <Field label={ui('默认讲解口吻')} hint={ui('亲切：像一起复盘的助教；专业：简洁、严谨地讲清判断依据。手动生成时可单独调整。')}>
        <Select name="tone" value={editor.values.tone} onChange={event => edit({ tone: event.target.value })}>
          <option value="friendly">{ui('亲切')}</option><option value="professional">{ui('专业')}</option>
        </Select>
      </Field>
      <Hint>{ui('每天按保存的时区划分；继续做新题会更新今天的同一篇合集。')}</Hint>
      <Field group label={uiFormat('当天统计时区：{0}', [timeZoneName])}>
        {editor.values.timeZone !== deviceTimeZone && <Button onClick={() => edit({ timeZone: deviceTimeZone })}>{ui('使用当前设备时区')}</Button>}
      </Field>
      {error && <Hint tone="error" role="alert">{error}</Hint>}
      <div className="settings-actions"><Button type="submit" variant="primary" disabled={busy || working || JSON.stringify(editor.values) === editor.baseline}>{ui(working ? '保存中…' : '保存每日合集设置')}</Button></div>
    </SettingsSection>
  </form>;
}
