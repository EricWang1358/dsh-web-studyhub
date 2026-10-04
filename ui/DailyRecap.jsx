import React, { useEffect, useId, useRef, useState } from 'react';
import { ui, uiFormat } from './i18n.js';
import { useInjectCss } from './shared.js';
import css from './DailyRecap.css';

export function recapTimeZone(saved) {
  return saved?.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai';
}

/** Mount a new request owner for every library, round, or course. Reads never start generation. */
export default function DailyRecap(props) {
  return <DailyRecapPanel key={JSON.stringify([props.root, props.runId, props.course])} {...props} />;
}

export function DailyRecapPanel({ root, runId, course, saved, call, act, busy = false, onOpenNote, onSettings, onModelSettings, poll = false }) {
  useInjectCss(css, 'study-daily-recap');
  const [status, setStatus] = useState(null), [error, setError] = useState('');
  const [working, setWorking] = useState(''), [tones, setTones] = useState({});
  const owner = useRef(null), pending = useRef(null), refreshRef = useRef(null);
  const prefix = useId(), timeZone = recapTimeZone(saved);
  // Keep stable request identity even when the parent supplies a fresh callback each render.
  const callbacks = useRef({ call, act }); callbacks.current = { call, act };
  useEffect(() => {
    const token = { root, runId, course, live: true, timer: null };
    owner.current = token;
    setStatus(null); setError(''); setWorking(''); setTones({}); pending.current = null;
    const refresh = async () => {
      clearTimeout(token.timer);
      try {
        const next = await callbacks.current.call('note.daily.status', { timeZone, ...(runId ? { runId } : {}),
          ...(course !== undefined && course !== '*' ? { course } : {}) });
        if (!token.live || owner.current !== token) return;
        setStatus(next); setError('');
        if (poll && next.groups?.some(group => group.generation?.status === 'running')) token.timer = setTimeout(refresh, 3000);
      } catch (cause) {
        if (token.live && owner.current === token) setError(cause.message || String(cause));
      }
    };
    refreshRef.current = refresh;
    refresh();
    return () => { token.live = false; clearTimeout(token.timer); if (owner.current === token) owner.current = null; };
  }, [root, runId, course, timeZone, poll]);
  async function generate(group, force = false) {
    if (busy || pending.current || !group.eligible) return;
    const token = owner.current, operation = {};
    pending.current = operation; setWorking(group.courseId || group.course); setError('');
    const live = () => token?.live && owner.current === token && pending.current === operation;
    try {
      const args = { course: group.courseId || group.course, day: group.day, timeZone,
        tone: tones[group.courseId || group.course] || status?.tone || saved?.tone || 'friendly', ...(force ? { force: true } : {}) };
      let result;
      // App's action boundary refreshes the library and suppresses departed-library callbacks.
      if (callbacks.current.act) await callbacks.current.act('note.daily.generate', args, next => { result = next; }, { rethrow: true });
      else result = await callbacks.current.call('note.daily.generate', args);
      if (!live() || !result) return;
      setStatus(previous => ({ ...previous, groups: previous.groups.map(item => item.day === group.day && item.courseId === group.courseId && item.course === group.course
        ? { ...item, noteId: result.id, protected: result.status === 'protected', hasContent: result.status === 'done' || item.hasContent,
          generation: { status: result.status }, stale: result.status === 'done' ? false : item.stale }
        : item) }));
      if (result.status === 'running' && poll) token.timer = setTimeout(() => refreshRef.current?.(), 1500);
    } catch (cause) { if (live()) setError(cause.message || String(cause)); }
    finally { if (live()) { pending.current = null; setWorking(''); } }
  }
  async function cancel(group) {
    if (busy || pending.current || !group.noteId) return;
    const token = owner.current, operation = {};
    pending.current = operation; setWorking(group.courseId || group.course); setError('');
    const live = () => token?.live && owner.current === token && pending.current === operation;
    try {
      let result;
      if (callbacks.current.act) await callbacks.current.act('note.daily.cancel', { id: group.noteId }, next => { result = next; }, { rethrow: true });
      else result = await callbacks.current.call('note.daily.cancel', { id: group.noteId });
      if (!live() || !result) return;
      clearTimeout(token.timer);
      setStatus(previous => ({ ...previous, groups: previous.groups.map(item => item.noteId === group.noteId
        ? { ...item, generation: result.generation || { status: 'cancelled' } } : item) }));
    } catch (cause) { if (live()) setError(cause.message || String(cause)); }
    finally { if (live()) { pending.current = null; setWorking(''); } }
  }
  return <section className="daily-recap" aria-labelledby={`${prefix}-title`}>
    <div className="daily-recap-heading"><div><p className="daily-recap-kicker">{ui('学完，留下今天的收获')}</p>
      <h2 id={`${prefix}-title`}>{ui('今日错题讲解合集')}</h2></div>
      {onSettings && <button type="button" className="link-btn" onClick={onSettings}>{ui('生成设置')}</button>}
    </div>
    <p className="daily-recap-lead">{ui('同一天、同一课程合成一篇：串起错因、正确思路和复习建议。累计完成 10 道不同题目后可生成，重练只计一次。')}</p>
    {error && <div className="daily-recap-error" role="alert"><p>{error}</p>
      <button type="button" disabled={!!working} onClick={() => refreshRef.current?.()}>{ui('重新加载状态')}</button></div>}
    {error && /模型|model|provider/i.test(error) && onModelSettings && <button type="button" onClick={onModelSettings}>{ui('检查 AI 模型设置')}</button>}
    {!status && !error && <p role="status" className="muted">{ui('正在读取今天的学习记录…')}</p>}
    {status && !status.groups?.length && <p className="muted">{ui('今天还没有这门课程的作答记录。做完一章后，回来领取总结。')}</p>}
    {status?.groups?.map(group => {
      const key = group.courseId || group.course, running = group.generation?.status === 'running';
      const stopped = ['cancelled', 'interrupted'].includes(group.generation?.status);
      const failed = group.generation?.status === 'failed' || stopped, protectedEdit = group.protected || group.generation?.status === 'protected';
      const tone = tones[key] || status.tone || saved?.tone || 'friendly';
      return <div className="daily-recap-course" key={JSON.stringify([group.day, key])}>
        <div className="daily-recap-course-heading"><h3>{group.course || ui('未分配课程')}</h3>
          <small>{group.day !== status.day && <>{group.day} · </>}{uiFormat('已练习 {0} 题 · 需要回顾 {1} 题', [group.answeredCount, group.wrongCount])}</small></div>
        {!group.eligible && <p className="muted">{uiFormat('再做 {0} 道不同题目，就能生成今天的合集。', [group.remaining])}</p>}
        {group.unassessedCount > 0 && <p className="muted">{uiFormat('其中 {0} 题尚待批改，合集先回顾作答内容，批改后可更新。', [group.unassessedCount])}</p>}
        {group.eligible && !group.wrongCount && !group.unassessedCount && <p className="muted">{ui('今天没有错题，也值得总结：回顾练习过的内容和下次复习重点。')}</p>}
        {running && <p role="status" className="daily-recap-progress"><span className="daily-recap-spinner" aria-hidden="true" />{ui('正在整理今天的讲解与总结，你可以继续学习。')}</p>}
        {stopped ? <p role="status">{ui('生成已停止，已完成的合集仍然保留。')}</p> : failed && <p role="alert">{ui('合集生成未完成：')}{group.generation.message || ui('请重试。')}</p>}
        {failed && /模型|model|provider/i.test(group.generation?.message || '') && onModelSettings && <button type="button" onClick={onModelSettings}>{ui('检查 AI 模型设置')}</button>}
        {group.stale && group.hasContent && !running && <p className="muted">{ui('今天又有新的作答，更新合集会合并到同一篇。')}</p>}
        {protectedEdit && <p className="muted">{ui('这篇合集有手动修改，已保留你的版本。可以先阅读，再决定是否重新整理。')}</p>}
        <div className="daily-recap-actions">
          {running && <button type="button" disabled={busy || !!working} onClick={() => cancel(group)}>{ui('停止生成')}</button>}
          {group.noteId && group.hasContent && <button type="button" className="primary" disabled={!onOpenNote || busy} onClick={() => onOpenNote(group.noteId)}>{ui('阅读今日合集')}</button>}
          {!running && (!group.hasContent || group.stale || failed) && <>
            <label className="daily-recap-tone">{ui('讲解口吻')}<select aria-label={uiFormat('{0}的讲解口吻', [group.course])} value={tone} disabled={busy || !!working || !group.eligible}
              onChange={event => setTones(previous => ({ ...previous, [key]: event.target.value }))}>
              <option value="friendly">{ui('亲切')}</option><option value="professional">{ui('专业')}</option>
            </select></label>
            <button type="button" className={group.hasContent ? '' : 'primary'} disabled={busy || !!working || !group.eligible}
              onClick={() => generate(group)}>{ui(failed ? '重试生成合集' : group.hasContent ? '更新今日合集' : '生成今日错题讲解合集')}</button>
          </>}
        </div>
        {protectedEdit && !running && <details className="daily-recap-replace"><summary>{ui('重新整理这篇合集')}</summary>
          <p>{ui('重新整理会替换你手动编辑的标题和正文，请先保存需要保留的内容。')}</p>
          <button type="button" disabled={busy || !!working || !group.eligible} onClick={() => generate(group, true)}>{ui('替换手动内容并重新整理')}</button></details>}
      </div>;
    })}
    {status && <p className="daily-recap-footnote">{ui(status.automatic ? '已开启自动生成：做题时逐步准备，章节结束后整理成文。' : '当前为手动生成。可以在设置里主动开启自动生成。')}</p>}
  </section>;
}
