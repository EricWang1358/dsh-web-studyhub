import React, { useId, useState } from 'react';
import { ui, uiFormat } from '../i18n.js';
import { Button, Checkbox, ConfirmDialog, Field, Hint, Icon, Select, SettingsSection, useToast } from '../components/index.js';
import { formatDateTime } from '../format.js';
import { invalidate } from '../host-query.js';

const GOALS = [['', '未设定'], ['exam', '应付考试'], ['interview', '面试求职'], ['work', '工作中落地'], ['explore', '兴趣拓展']];

/**
 * The consent and goal toggles. App's act() is single-flight, so reloading the
 * profile with a nested act() inside the first one's callback was skipped and
 * the section kept showing the old profile; the reload uses call() instead.
 */
export function coachActions({ act, call, setProfile }) {
  const reload = async () => {
    const next = call ? await call('coach.profile', {}) : null;
    if (next) setProfile(next);
  };
  return {
    setConsent: (prep) => act('coach.consent', { prep }, async () => { invalidate('coach.status'); await reload(); }),
    setGoal: (goal) => act('coach.goal', { goal }, reload),
  };
}

/** 陪学: what the profile changes, the goal, a short profile with a compact feedback row, and a confirmed reset. */
export function CoachSection({ profile, busy, act, call, setProfile, confirmForget = false }) {
  const toast = useToast();
  const [expanded, setExpanded] = useState(false);
  const [confirm, setConfirm] = useState(confirmForget);
  const summaryId = useId();
  const { setConsent, setGoal } = coachActions({ act, call, setProfile });
  const summary = profile.summary || '';
  const long = summary.length > 60;
  const updated = formatDateTime(profile.updatedAt, 'day');
  const stats = [['check', '懂了', profile.signals?.got], ['help', '不懂', profile.signals?.confused],
    ['thumb-up', '有用', profile.signals?.up], ['thumb-down', '没用', profile.signals?.down]];
  return (
    <SettingsSection className="coach-settings" title={ui('陪学')}
      lead={ui('陪学记住的学习目标和画像只保存在这个学习库文件里，用来让变式题和建议更贴近你。模型调用使用最低思考档位。')}>
      <Hint>{ui('画像只影响陪学：答错后的提示、追问、改题、强化变式题和每轮复盘的措辞与侧重；不影响出题和复习排期。')}</Hint>
      <Checkbox label={ui('做题时在后台准备变式题和应用场景题')} checked={profile.consent === true} disabled={busy} onChange={setConsent} />
      <Field label={ui('学习目标')} hint={ui('提示语气与例子会贴近这个目标。')}>
        <Select value={profile.goal} disabled={busy} onChange={(e) => setGoal(e.target.value)}>
          {GOALS.map(([id, label]) => <option key={id} value={id}>{ui(label)}</option>)}
        </Select>
      </Field>
      <div className="coach-profile">
        <div className="coach-profile__head">
          <strong>{ui('画像')}</strong>
          {updated && <small>{uiFormat('上次更新 {0}', [updated])}</small>}
        </div>
        {summary
          ? <p id={summaryId} className={`coach-profile__summary${long && !expanded ? ' is-clamped' : ''}`}>{summary}</p>
          : <Hint>{ui('还没有画像：做完一轮后，陪学会根据表现写一段简短摘要。')}</Hint>}
        {long && <Button variant="link" size="sm" className="coach-profile__more" aria-expanded={expanded} aria-controls={summaryId}
          onClick={() => setExpanded(value => !value)}>{expanded ? ui('收起') : ui('展开')}</Button>}
        <ul className="coach-stats" aria-label={ui('你的反馈')}>
          {stats.map(([icon, label, count]) => <li key={label}><Icon name={icon} size={16} />{`${ui(label)} `}<strong>{count || 0}</strong></li>)}
          {profile.ready ? <li className="coach-stats__ready">{uiFormat('已备 {0} 道定制题', [profile.ready])}</li> : null}
        </ul>
      </div>
      <div className="settings-actions">
        <Button variant="secondary" disabled={busy} onClick={() => setConfirm(true)}>{ui('清空画像')}</Button>
      </div>
      {confirm && <ConfirmDialog title={ui('清空陪学画像？')} confirmLabel={ui('清空画像')} busy={busy} onClose={() => setConfirm(false)}
        description={uiFormat('将删除：学习目标、画像摘要、反馈计数和 {0} 道未使用的定制题。', [profile.ready || 0])}
        onConfirm={() => act('coach.forget', {}, (next) => {
          invalidate('coach.status'); // the debrief and the 错题 page drop what was prepared
          setProfile(next);
          toast.success(ui('已清空陪学画像和未使用的定制题；练习记录不受影响。'));
        }, { rethrow: true })}>
        <Hint>{ui('练习记录和复习进度不受影响；之后做完一轮，陪学会重新写画像。')}</Hint>
      </ConfirmDialog>}
    </SettingsSection>
  );
}
