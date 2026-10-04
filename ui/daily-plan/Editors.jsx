import React, { useState } from 'react';
import { ui, uiFormat } from '../i18n.js';
import { Button } from '../components/Button.jsx';

const validMinutes = value => value !== '' && Number.isInteger(Number(value)) && Number(value) >= 0 && Number(value) <= 240;

export function Adjustment({ plan, onClose }) {
  const [feedback, setFeedback] = useState('');
  const [minutes, setMinutes] = useState('');
  const { proposal, budgetMinutes } = plan.state;
  return <form className="daily-plan__editor" onSubmit={async event => {
    event.preventDefault();
    if ((minutes === '' || validMinutes(minutes)) && await plan.suggest({
      feedback: feedback.trim(),
      ...(minutes !== '' ? { minutes: Number(minutes) } : {}),
      ...(proposal ? { proposalId: proposal.id } : {}),
    })) onClose();
  }}>
    <label>{ui('告诉 AI 你的想法')}<textarea autoFocus value={feedback} maxLength={2000} rows="2" disabled={!!plan.busy}
      placeholder={ui('例如：今天先顾考试，少安排阅读')} onChange={event => setFeedback(event.target.value)} /></label>
    <div className="daily-plan__editor-bottom">
      <label className="daily-plan__minutes">{ui('只调整今天')}<input type="number" min="0" max="240" value={minutes}
        placeholder={String(budgetMinutes)} disabled={!!plan.busy} onChange={event => setMinutes(event.target.value)} /><span>{ui('分钟')}</span></label>
      <div className="daily-plan__actions"><Button type="submit" busy={plan.busy === 'suggest'} disabled={!!plan.busy || (minutes !== '' && !validMinutes(minutes))}>
        {ui('按我的意见重新建议')}</Button><Button variant="quiet" disabled={!!plan.busy} onClick={onClose}>{ui('取消')}</Button></div>
    </div>
    <p className="daily-plan__footnote">{ui('今天的调整不会改变长期习惯。只发送内容标题和进度摘要，不发送资料全文。')}</p>
  </form>;
}

export function Profile({ plan, onClose }) {
  const { profile } = plan.state;
  const [weekday, setWeekday] = useState(profile.weekdayMinutes);
  const [weekend, setWeekend] = useState(profile.weekendMinutes);
  return <form className="daily-plan__editor" onSubmit={async event => {
    event.preventDefault();
    if (validMinutes(weekday) && validMinutes(weekend) && await plan.saveProfile({
      weekdayMinutes: Number(weekday), weekendMinutes: Number(weekend),
    })) onClose();
  }}>
    <p>{ui('长期习惯单独保存。今天的调整不会改掉它。')}</p>
    <div className="daily-plan__fields">
      <label>{ui('工作日（分钟）')}<input autoFocus type="number" min="0" max="240" required value={weekday}
        disabled={!!plan.busy} onChange={event => setWeekday(event.target.value)} /></label>
      <label>{ui('周末（分钟）')}<input type="number" min="0" max="240" required value={weekend}
        disabled={!!plan.busy} onChange={event => setWeekend(event.target.value)} /></label>
    </div>
    {(profile.observedWeekdayMinutes !== undefined || profile.observedWeekendMinutes !== undefined) &&
      <p className="daily-plan__footnote">{uiFormat('根据已完成日的记录：工作日约 {0} 分钟，周末约 {1} 分钟。可以据此调整，系统不会自动覆盖。',
        [profile.observedWeekdayMinutes ?? '—', profile.observedWeekendMinutes ?? '—'])}</p>}
    <div className="daily-plan__actions"><Button type="submit" disabled={!validMinutes(weekday) || !validMinutes(weekend) || !!plan.busy}>
      {ui('保存长期习惯')}</Button><Button variant="quiet" disabled={!!plan.busy} onClick={onClose}>{ui('取消')}</Button></div>
  </form>;
}
