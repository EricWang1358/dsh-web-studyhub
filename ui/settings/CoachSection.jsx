import React, { useId, useState } from 'react';
import { LEARNER_PREFERENCES_MAX, LEARNER_PREFERENCE_MAX_CHARS } from '../../lib/learner.js';
import { ui, uiFormat } from '../i18n.js';
import { Button, Checkbox, Chip, ConfirmDialog, Field, Hint, Icon, Select, SettingsSection, TextInput, useToast } from '../components/index.js';
import { formatDateTime } from '../format.js';
import { invalidate } from '../host-query.js';
import { useStudy } from '../study-context.jsx';

const GOALS = [['', '未设定'], ['exam', '应付考试'], ['interview', '面试求职'], ['work', '工作中落地'], ['explore', '兴趣拓展']];

export const PREFERENCE_IDEAS = Object.freeze([
  '先给直觉例子再推导',
  '结合真题与评分标准',
  '苏格拉底式提问引导',
  '对比易混概念与反例',
]);

/**
 * The consent, goal and preferences actions. App's act() is single-flight, so reloading the
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
    setPreferences: (preferences) => act('coach.preferences', { preferences }, reload),
  };
}

/** 陪学: what the profile changes, the goal, free-form study preferences, a short profile with a compact feedback row, and a confirmed reset. */
export function CoachSection({ profile, setProfile, confirmForget = false }) {
  const { busy, act, call } = useStudy();
  const toast = useToast();
  const [expanded, setExpanded] = useState(false);
  const [confirm, setConfirm] = useState(confirmForget);
  const [draftPref, setDraftPref] = useState('');
  const summaryId = useId();
  const { setConsent, setGoal, setPreferences } = coachActions({ act, call, setProfile });
  const preferences = Array.isArray(profile.preferences) ? profile.preferences : [];
  const trimmedDraft = draftPref.replace(/\s+/g, ' ').trim();
  const atMax = preferences.length >= LEARNER_PREFERENCES_MAX;
  const addPref = (value) => {
    const text = String(value ?? '').replace(/\s+/g, ' ').trim();
    if (!text || preferences.includes(text) || preferences.length >= LEARNER_PREFERENCES_MAX) return;
    setPreferences([...preferences, text]);
  };
  const submitPref = () => {
    if (!trimmedDraft || atMax) return;
    if (!preferences.includes(trimmedDraft)) setPreferences([...preferences, trimmedDraft]);
    setDraftPref('');
  };
  const removePref = (item) => setPreferences(preferences.filter(entry => entry !== item));
  const availableIdeas = PREFERENCE_IDEAS.map(idea => ui(idea)).filter(label => !preferences.includes(label));
  const summary = profile.summary || '';
  const long = summary.length > 60;
  const updated = formatDateTime(profile.updatedAt, 'day');
  const stats = [['check', '懂了', profile.signals?.got], ['help', '不懂', profile.signals?.confused],
    ['thumb-up', '有用', profile.signals?.up], ['thumb-down', '没用', profile.signals?.down]];
  return (
    <SettingsSection className="coach-settings" tour="settings-profile" title={ui('陪学')}
      lead={ui('陪学记住的学习目标和画像只保存在这个学习库文件里，用来让变式题和建议更贴近你。模型调用使用最低思考档位。')}>
      <Hint>{ui('画像与学习偏好会随数据围栏发给陪学、讲解与划词追问以及发给主会话的消息，调整讲解措辞与侧重；不进出题提示词，也不改间隔复习排期。')}</Hint>
      <Checkbox label={ui('做题时在后台准备变式题和应用场景题')} checked={profile.consent === true} disabled={busy} onChange={setConsent} />
      <Field label={ui('学习目标')} hint={ui('提示语气与例子会贴近这个目标。')}>
        <Select value={profile.goal} disabled={busy} onChange={setGoal} options={GOALS.map(([id, label]) => ({ value: id, label: ui(label) }))} />
      </Field>
      <Field label={ui('学习偏好')} width="full"
        hint={ui('自由写下你喜欢的讲解或练习方式；也可以随时在主会话里直接告诉 AI 你想怎么学，经你确认后会记在这里。')}>
        {({ id, describedBy }) => (
          <div className="coach-prefs">
            {preferences.length > 0 && (
              <div className="coach-prefs__list" role="list" aria-label={ui('已保存的学习偏好')}>
                {preferences.map(item => (
                  <Chip key={item} role="listitem" size="sm" removeLabel={uiFormat('移除「{0}」', [item])}
                    onRemove={busy ? undefined : () => removePref(item)}>{item}</Chip>
                ))}
              </div>
            )}
            <div className="coach-prefs__entry">
              <TextInput id={id} aria-describedby={describedBy} value={draftPref} maxLength={LEARNER_PREFERENCE_MAX_CHARS}
                disabled={busy || atMax} placeholder={ui('例如：先给直觉例子再推导、用伪代码对比边界…')}
                onChange={event => setDraftPref(event.target.value)}
                onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); submitPref(); } }} />
              <Button variant="secondary" size="sm" lock={busy} disabled={!trimmedDraft || atMax} onClick={submitPref}>{ui('添加')}</Button>
            </div>
            {!atMax && availableIdeas.length > 0 && (
              <div className="coach-prefs__ideas">
                <span className="coach-prefs__ideas-lead">{ui('灵感示例（点一下加入，也可自由填写）：')}</span>
                <div className="coach-prefs__chips">
                  {availableIdeas.map(label => (
                    <Chip key={label} size="sm" icon="plus" disabled={busy} onClick={() => addPref(label)}>{label}</Chip>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
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
        <Button variant="secondary" lock={busy} onClick={() => setConfirm(true)}>{ui('清空画像')}</Button>
      </div>
      {confirm && <ConfirmDialog title={ui('清空陪学画像？')} confirmLabel={ui('清空画像')} busy={busy} onClose={() => setConfirm(false)}
        description={uiFormat('将删除：学习目标、学习偏好、画像摘要、反馈计数和 {0} 道未使用的定制题。', [profile.ready || 0])}
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
