import React, { useId, useState } from 'react';
import {
  LEARNER_BULLETS_MAX,
  LEARNER_BULLET_MAX_CHARS,
  LEARNER_PREFERENCES_MAX,
  LEARNER_PREFERENCE_MAX_CHARS,
} from '../../lib/learner.js';
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

function bulletSourceLabel(source) {
  if (source === 'user') return ui('手动记录');
  if (source === 'retell') return ui('复述归纳');
  return ui('陪学归纳');
}

function bulletRefKey(ref, idx) {
  if (ref.kind === 'card') return `card:${ref.deckId}:${ref.cardId}:${idx}`;
  if (ref.kind === 'hid') return `hid:${ref.course}:${ref.hid}:${idx}`;
  return `companion:${ref.companionId}:${ref.slide ?? ''}:${idx}`;
}

export function bulletRefLabel(ref, data = null) {
  if (!ref || typeof ref !== 'object') return '';
  if (ref.kind === 'card') {
    const deck = (data?.decks || []).find(item => item?.id === ref.deckId);
    const card = (deck?.cards || []).find(item => item?.id === ref.cardId);
    const topic = card?.topic?.trim() || deck?.title?.trim() || '';
    return topic ? uiFormat('原题 · {0}', [topic]) : ui('查看原题');
  }
  if (ref.kind === 'hid') {
    return ref.course ? uiFormat('全书 · {0} {1}', [ref.course, ref.hid]) : uiFormat('全书 · {0}', [ref.hid]);
  }
  if (ref.kind === 'companion') {
    let title = '';
    for (const courseItem of data?.courses || []) {
      const hit = (courseItem?.companions || []).find(item => item?.id === ref.companionId);
      if (hit?.title) { title = hit.title.trim(); break; }
    }
    if (title && ref.slide >= 1) return uiFormat('{0} · 伴学第 {1} 页', [title, ref.slide]);
    if (title) return title;
    if (ref.slide >= 1) return uiFormat('伴学 · 第 {0} 页', [ref.slide]);
    return ui('打开伴学页');
  }
  return '';
}

/**
 * The consent, goal, preferences and traceable bullet actions. App's act() is single-flight, so reloading the
 * profile with a nested act() inside the first one's callback was skipped and
 * the section kept showing the old profile; the reload uses call() instead.
 */
export function coachActions({ act, call, setProfile, memoryRevision }) {
  const reload = async () => {
    const next = call ? await call('coach.profile', {}) : null;
    if (next) setProfile(next);
  };
  const rev = Number.isSafeInteger(memoryRevision) ? { expectedRevision: memoryRevision } : {};
  return {
    setConsent: (prep) => act('coach.consent', { prep }, async () => { invalidate('coach.status'); await reload(); }),
    setGoal: (goal) => act('coach.goal', { goal }, reload),
    setPreferences: (preferences, onDone) => act('coach.preferences', { preferences }, async () => { await reload(); onDone?.(); }),
    addBullet: (bullet, onDone) => act('coach.profile', { addBullet: bullet, ...rev }, (next) => { setProfile(next); onDone?.(next); }),
    updateBullet: (patch, onDone) => act('coach.profile', { updateBullet: patch, ...rev }, (next) => { setProfile(next); onDone?.(next); }),
    removeBullet: (id, onDone) => act('coach.profile', { removeBullet: id, ...rev }, (next) => { setProfile(next); onDone?.(next); }),
  };
}

const isImeComposing = (event) => Boolean(event.nativeEvent?.isComposing || event.isComposing || event.keyCode === 229);

/** 陪学: what the profile changes, the goal, free-form study preferences, traceable editable learner bullets (with legacy summary fallback), and a confirmed reset. */
export function CoachSection({ data = null, profile, setProfile, onOpenRef = null, confirmForget = false }) {
  const { busy, act, call, host } = useStudy();
  const canChat = host?.capabilities?.chat !== false;
  const toast = useToast();
  const [expanded, setExpanded] = useState(false);
  const [confirm, setConfirm] = useState(confirmForget);
  const [draftPref, setDraftPref] = useState('');
  const [prefHint, setPrefHint] = useState('');
  const [draftBullet, setDraftBullet] = useState('');
  const [editingId, setEditingId] = useState('');
  const [editingText, setEditingText] = useState('');
  const summaryId = useId();
  const { setConsent, setGoal, setPreferences, addBullet, updateBullet, removeBullet } = coachActions({
    act, call, setProfile, memoryRevision: profile.memoryRevision,
  });
  const preferences = Array.isArray(profile.preferences) ? profile.preferences : [];
  const bullets = Array.isArray(profile.bullets) ? profile.bullets : [];
  const trimmedDraft = draftPref.replace(/\s+/g, ' ').trim();
  const atMax = preferences.length >= LEARNER_PREFERENCES_MAX;
  const trimmedBullet = draftBullet.replace(/\s+/g, ' ').trim();
  const atBulletMax = bullets.length >= LEARNER_BULLETS_MAX;
  const trimmedEdit = editingText.replace(/\s+/g, ' ').trim();
  const addPref = (value) => {
    const text = String(value ?? '').replace(/\s+/g, ' ').trim();
    if (!text || preferences.includes(text) || preferences.length >= LEARNER_PREFERENCES_MAX) return;
    setPrefHint('');
    setPreferences([...preferences, text]);
  };
  const submitPref = () => {
    if (!trimmedDraft || atMax || busy) return;
    if (preferences.includes(trimmedDraft)) {
      setPrefHint(ui('这条偏好已经记过了。'));
      return;
    }
    setPrefHint('');
    setPreferences([...preferences, trimmedDraft], () => setDraftPref(''));
  };
  const removePref = (item) => setPreferences(preferences.filter(entry => entry !== item));
  const addUserBullet = () => {
    if (!trimmedBullet || atBulletMax || busy) return;
    const activeCourse = typeof data?.focus?.course === 'string' && data.focus.course.trim() ? data.focus.course.trim() : undefined;
    addBullet({ text: trimmedBullet, ...(activeCourse ? { course: activeCourse } : {}), source: 'user', refs: [] }, () => setDraftBullet(''));
  };
  const selectBullet = (bullet) => {
    setEditingId(bullet.id);
    setEditingText(bullet.text || '');
  };
  const cancelEdit = () => {
    setEditingId('');
    setEditingText('');
  };
  const saveBullet = () => {
    if (!editingId || !trimmedEdit || busy) return;
    updateBullet({ id: editingId, text: trimmedEdit }, () => cancelEdit());
  };
  const deleteBullet = (id) => {
    if (busy) return;
    removeBullet(id, () => { if (editingId === id) cancelEdit(); });
  };
  const availableIdeas = PREFERENCE_IDEAS.filter(idea => !preferences.includes(idea) && !preferences.includes(ui(idea))).map(idea => ui(idea));
  const summary = profile.summary || '';
  const long = summary.length > 60;
  const updated = formatDateTime(profile.updatedAt, 'day');
  const stats = [['check', '懂了', profile.signals?.got], ['help', '不懂', profile.signals?.confused],
    ['thumb-up', '有用', profile.signals?.up], ['thumb-down', '没用', profile.signals?.down]];
  return (
    <SettingsSection className="coach-settings" tour="settings-profile" title={ui('学习画像与陪学')}
      lead={ui('陪学记住的学习目标和画像只保存在这个学习库文件里，用来让变式题和建议更贴近你。模型调用使用最低思考档位。')}>
      <Hint>{canChat
        ? ui('画像与学习偏好会用于陪学、讲解、划词追问、错题变式以及发给主会话的消息，调整讲解措辞与侧重；不进出题提示词，也不改间隔复习排期。')
        : ui('画像与学习偏好会用于陪学、讲解、划词追问与错题变式，调整讲解措辞与侧重；不进出题提示词，也不改间隔复习排期。')}</Hint>
      <Checkbox label={ui('做题时在后台准备变式题和应用场景题')}
        hint={ui('答错或出现薄弱点时，在后台用最低推理档位预备 1–2 道变式题（消耗少量模型用量），出现在复盘与错题本里；关掉后仅手动触发。')}
        checked={profile.consent === true} disabled={busy} onChange={setConsent} />
      <Field label={ui('学习目标')} hint={ui('提示语气与例子会贴近这个目标。')}>
        <Select value={profile.goal} disabled={busy} onChange={setGoal} options={GOALS.map(([id, label]) => ({ value: id, label: ui(label) }))} />
      </Field>
      <Field label={ui('学习偏好')} width="full"
        hint={canChat
          ? ui('自由写下你喜欢的讲解或练习方式；也可以随时在主会话里直接告诉 AI 你想怎么学，经你确认后会记在这里。')
          : ui('自由写下你喜欢的讲解或练习方式，用来调整讲解措辞与侧重。')}>
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
              <TextInput id={id} className="learner-pref-input" aria-describedby={describedBy} value={draftPref} maxLength={LEARNER_PREFERENCE_MAX_CHARS}
                disabled={busy || atMax} placeholder={ui('例如：先给直觉例子再推导、用伪代码对比边界…')}
                onChange={event => { setDraftPref(event.target.value); if (prefHint) setPrefHint(''); }}
                onKeyDown={event => { if (isImeComposing(event)) return; if (event.key === 'Enter') { event.preventDefault(); submitPref(); } }} />
              <Button variant="secondary" size="sm" lock={busy} disabled={!trimmedDraft || atMax} onClick={submitPref}>{ui('添加')}</Button>
            </div>
            {prefHint && <Hint className="coach-prefs__hint" role="status">{prefHint}</Hint>}
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
          <small className="coach-profile__count">{`${bullets.length} / ${LEARNER_BULLETS_MAX}`}</small>
          {updated && <small>{uiFormat('上次更新 {0}', [updated])}</small>}
        </div>
        {bullets.length > 0 ? (
          <ul className="coach-bullets" aria-label={ui('学习画像要点')}>
            {bullets.map(bullet => {
              const editing = editingId === bullet.id;
              return (
                <li key={bullet.id} className="coach-bullet" data-bullet-id={bullet.id} data-bullet-source={bullet.source}>
                  {editing ? (
                    <div className="coach-bullet__editor">
                      <TextInput className="coach-bullet-input" aria-label={ui('编辑')} value={editingText} maxLength={LEARNER_BULLET_MAX_CHARS}
                        disabled={busy} onChange={event => setEditingText(event.target.value)}
                        onKeyDown={event => {
                          if (isImeComposing(event)) return;
                          if (event.key === 'Enter') { event.preventDefault(); saveBullet(); }
                          if (event.key === 'Escape') { event.preventDefault(); cancelEdit(); }
                        }} />
                      <div className="coach-bullet__actions">
                        <Button variant="primary" size="sm" lock={busy} disabled={!trimmedEdit} onClick={saveBullet}>{ui('保存')}</Button>
                        <Button variant="quiet" size="sm" lock={busy} onClick={cancelEdit}>{ui('取消')}</Button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div className="coach-bullet__body">
                        <p className="coach-bullet__text">{bullet.text}</p>
                        <div className="coach-bullet__meta">
                          {bullet.course && <span className="coach-bullet__tag">{bullet.course}</span>}
                          <span className="coach-bullet__source">{bulletSourceLabel(bullet.source)}</span>
                          {(bullet.refs || []).map((ref, idx) => {
                            const label = bulletRefLabel(ref, data);
                            if (!label) return null;
                            const key = bulletRefKey(ref, idx);
                            return onOpenRef ? (
                              <Button key={key} variant="link" size="sm" iconEnd="arrow-right" wrap className="coach-bullet__ref"
                                data-bullet-ref={ref.kind} onClick={() => onOpenRef(ref)}>{label}</Button>
                            ) : (
                              <span key={key} className="coach-bullet__ref-text" data-bullet-ref={ref.kind}>{label}</span>
                            );
                          })}
                        </div>
                      </div>
                      <div className="coach-bullet__actions">
                        <Button variant="quiet" size="sm" lock={busy} onClick={() => selectBullet(bullet)}>{ui('编辑')}</Button>
                        <Button variant="quiet" size="sm" lock={busy} onClick={() => deleteBullet(bullet.id)}>{ui('删除')}</Button>
                      </div>
                    </>
                  )}
                </li>
              );
            })}
          </ul>
        ) : summary ? (
          <div className="coach-profile__legacy">
            <span className="coach-profile__legacy-label">{ui('旧版画像摘要')}</span>
            <p id={summaryId} className={`coach-profile__summary${long && !expanded ? ' is-clamped' : ''}`}>{summary}</p>
            {long && <Button variant="link" size="sm" className="coach-profile__more" aria-expanded={expanded} aria-controls={summaryId}
              onClick={() => setExpanded(value => !value)}>{expanded ? ui('收起') : ui('展开')}</Button>}
          </div>
        ) : (
          <Hint>{ui('还没有画像：做完一轮后，陪学会根据表现写一段简短摘要。')}</Hint>
        )}
        <div className="coach-bullets__entry">
          <TextInput className="coach-bullet-input" aria-label={ui('新增画像要点')} value={draftBullet} maxLength={LEARNER_BULLET_MAX_CHARS}
            disabled={busy || atBulletMax} placeholder={ui('补充一条易错规律或学习注意点…')}
            onChange={event => setDraftBullet(event.target.value)}
            onKeyDown={event => { if (isImeComposing(event)) return; if (event.key === 'Enter') { event.preventDefault(); addUserBullet(); } }} />
          <Button variant="secondary" size="sm" lock={busy} disabled={!trimmedBullet || atBulletMax} onClick={addUserBullet}>{ui('添加要点')}</Button>
        </div>
        <ul className="coach-stats" aria-label={ui('你的反馈')}>
          {stats.map(([icon, label, count]) => <li key={label}><Icon className="sh-icon--inline" name={icon} />{`${ui(label)} `}<strong>{count || 0}</strong></li>)}
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
        <Hint>{ui('练习记录和复习进度不受影响，考试教练方案与样题暴露记录也会保留；之后做完一轮，陪学会重新写画像。')}</Hint>
      </ConfirmDialog>}
    </SettingsSection>
  );
}
