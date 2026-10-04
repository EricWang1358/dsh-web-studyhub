import React, { useId } from 'react';
import { ui, uiFormat } from './i18n.js';
import { useInjectCss } from './shared.js';
import { Button } from './components/Button.jsx';
import { ProgressBar } from './components/Progress.jsx';
import { recapGroupKey, useDailyRecap } from './useDailyRecap.js';
import css from './DailyRecap.css';

export default function DailyRecap(props) {
  return <DailyRecapPanel key={JSON.stringify([props.root, props.runId, props.course])} {...props} />;
}

function presentation(group) {
  const state = group.generation?.status;
  if (state === 'running') return 'running';
  if (group.protected || state === 'protected') return 'protected';
  if (state === 'failed') return 'failed';
  if (['cancelled', 'interrupted'].includes(state)) return 'paused';
  if (group.hasContent) return group.stale ? 'update' : 'ready';
  return group.eligible ? 'available' : 'locked';
}
const stateLabels = { running: '整理中', protected: '你的版本', failed: '待重试', paused: '已停止', update: '有新作答', ready: '已留存', available: '可以生成', locked: '今日进度' };

export function DailyRecapPanel(props) {
  const { busy = false, onOpenNote, onSettings, onModelSettings } = props;
  useInjectCss(css, 'study-daily-recap');
  const recap = useDailyRecap(props), prefix = useId();
  const { status, error, working } = recap;
  const toneControl = group => <fieldset className="daily-recap-tone" aria-label={uiFormat('{0}的讲解口吻', [group.course])} disabled={busy || !!working}>
    <legend>{ui('讲解口吻')}</legend>
    {['friendly', 'professional'].map(tone => <label key={tone}>
      <input type="radio" name={prefix + '-' + recapGroupKey(group)} value={tone} checked={recap.toneFor(group) === tone}
        onChange={() => recap.setTone(group, tone)} />{ui(tone === 'friendly' ? '亲切' : '专业')}
    </label>)}
  </fieldset>;
  return <section className="daily-recap" aria-labelledby={prefix + '-title'}>
    <div className="daily-recap-heading"><h2 id={prefix + '-title'}>{ui('今日学习总结')}</h2>
      {onSettings && <Button size="sm" variant="quiet" onClick={onSettings}>{ui('生成设置')}</Button>}
    </div>
    <p className="daily-recap-lead">{ui('把今天各章的练习串起来，收好错因、思路和下一步。')}</p>
    {error && <div className="daily-recap-error" role="alert"><p>{ui('暂时没能完成这一步，请重试。')}
      <Button size="sm" variant="link" disabled={!!working} onClick={recap.refresh}>{ui('重新加载状态')}</Button></p>
      <details><summary>{ui('查看原因')}</summary><p>{error}</p></details>
      {/模型|model|provider/i.test(error) && onModelSettings && <Button size="sm" onClick={onModelSettings}>{ui('检查 AI 模型设置')}</Button>}
    </div>}
    {!status && !error && <p role="status" className="daily-recap-loading">{ui('正在读取今天的学习记录…')}</p>}
    {status && !status.groups?.length && <p className="muted">{ui('今天的练习会留在这里。完成一章后，就能查看当天的进度。')}</p>}
    {status?.groups?.map(group => {
      const phase = presentation(group), running = phase === 'running', protectedEdit = phase === 'protected';
      const retry = ['failed', 'paused'].includes(phase), canGenerate = !running && !protectedEdit && (!group.hasContent || group.stale || retry);
      const progress = group.generation?.progress;
      return <article className="daily-recap-course" data-state={phase} key={recapGroupKey(group)}>
        <div className="daily-recap-course-heading"><h3>{group.course || ui('未分配课程')}</h3>
          <span className="daily-recap-state">{ui(stateLabels[phase])}</span></div>
        <p className="daily-recap-meta">{group.day !== status.day && <>{group.day} · </>}{uiFormat('已练习 {0} 题 · 需要回顾 {1} 题', [group.answeredCount, group.wrongCount])}</p>
        {!group.eligible && !group.hasContent && <div className="daily-recap-threshold">
          <ProgressBar size="sm" className="daily-recap-bar" label={ui('今日合集生成进度')} value={group.answeredCount} max={group.answeredCount + group.remaining} />
          <p>{uiFormat('再做 {0} 道不同题目，就能生成今天的合集。', [group.remaining])}</p></div>}
        {running && <div role="status" className="daily-recap-progress"><span className="daily-recap-spinner" aria-hidden="true" />
          <div><p>{ui(progress?.phase === 'organizing' ? '正在统一语言与结构…' : '正在整理今天的讲解…')}</p>
            <small>{progress?.phase === 'explaining' && progress.total > 1 ? uiFormat('已整理 {0}/{1} 组讲解 · 你可以继续学习', [progress.completed, progress.total]) : ui('整理好后会出现在这里，你可以继续学习。')}</small></div></div>}
        {protectedEdit && <p className="daily-recap-hint">{ui('已保留你的手动修改，后续练习不会覆盖这份内容。')}</p>}
        {retry && <div className="daily-recap-hint" role={phase === 'failed' ? 'alert' : 'status'}>
          <p>{ui(phase === 'failed' ? '这次没能整理完成，可以稍后重试。' : '生成已停止，可以从已完成的讲解继续整理。')}{group.hasContent && ui('上一版仍然可以阅读。')}</p>
          {group.generation?.message && <details><summary>{ui('查看原因')}</summary><p>{group.generation.message}</p></details>}
          {/模型|model|provider/i.test(group.generation?.message || '') && onModelSettings && <Button size="sm" onClick={onModelSettings}>{ui('检查 AI 模型设置')}</Button>}
        </div>}
        {phase === 'update' && <p className="daily-recap-hint">{ui('又有新的作答了，更新后会合并进这一篇。')}</p>}
        {phase === 'available' && !group.wrongCount && !group.unassessedCount && <p className="daily-recap-hint">{ui('今天没有错题，也值得总结：回顾练习过的内容和下次复习重点。')}</p>}
        {group.preview && <blockquote className="daily-recap-preview"><small>{ui(running || phase === 'update' ? '上一版回顾' : '这一天的收获')}</small><p>{group.preview}</p></blockquote>}
        {group.unassessedCount > 0 && <p className="daily-recap-hint">{uiFormat('其中 {0} 题尚待批改，批改后可更新合集。', [group.unassessedCount])}</p>}
        <div className="daily-recap-actions">
          {canGenerate && toneControl(group)}
          <div className="daily-recap-buttons">
            {group.noteId && group.hasContent && <Button variant="primary" disabled={!onOpenNote || busy} onClick={() => onOpenNote(group.noteId)}>{ui('阅读今日合集')}</Button>}
            {canGenerate && <Button variant={group.hasContent ? 'secondary' : 'primary'} busy={working === recapGroupKey(group)} disabled={busy || !!working || !group.eligible}
              onClick={() => recap.generate(group)}>{ui(retry ? '重试生成合集' : group.hasContent ? '更新今日合集' : '生成今日合集')}</Button>}
            {running && <Button size="sm" variant="quiet" disabled={busy || !!working} onClick={() => recap.cancel(group)}>{ui('停止生成')}</Button>}
          </div>
        </div>
        {protectedEdit && <details className="daily-recap-replace"><summary>{ui('重新整理这篇合集')}</summary>
          <p>{ui('重新整理会替换你手动编辑的标题和正文，请先保存需要保留的内容。')}</p>{toneControl(group)}
          <Button size="sm" disabled={busy || !!working || !group.eligible} onClick={() => recap.generate(group, true)}>{ui('替换手动内容并重新整理')}</Button></details>}
      </article>;
    })}
    {status && <div className="daily-recap-footer"><span>{ui(status.automatic ? '自动整理已开启' : '由你决定何时生成')}</span>
      <details><summary>{ui('合集如何生成')}</summary><p>{ui('同日同课程合成一篇。累计作答 10 道不同题目后生成，重练只计一次。自动生成可在设置里开启。')}</p></details></div>}
  </section>;
}
