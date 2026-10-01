import React from 'react';
import { getUiLanguage } from './i18n.js';

const t = (zh, en) => getUiLanguage() === 'en' ? en : zh;

export default function LiveNotes({ correction, onSentence, onRetry, disabled }) {
  const { memory, notes = [], background = {} } = correction;
  const references = ids => <div className="live-note-refs">{(ids || []).map(id => <button key={id} className="link-btn" onClick={() => onSentence(id)}>
    {t(`句 ${id}`, `Sentence ${id}`)}</button>)}</div>;
  return <details className="live-notes">
    <summary>{t('查看课堂笔记', 'View class notes')} · {notes.length} {t('条', 'entries')}</summary>
    <p className="muted">{t('每批校正后更新；下一批参考累计摘要与最近笔记。点句子编号可回看原文。', 'Updated after each correction batch; the next batch uses the summary and recent notes. Select a reference to return to the transcript.')}</p>
    <h3>{t('累计摘要', 'Cumulative summary')}</h3>
    <p className="live-note-text">{memory?.text || t('首批校正完成后，这里会出现课堂摘要。', 'The class summary appears after the first correction batch.')}</p>
    {references(memory?.refs)}
    <h3>{t('分批笔记', 'Notes by batch')}</h3>
    <div className="live-note-list">{notes.map((note, index) => <article key={index}>
      {note.kind === 'amendment' && <strong>{t('历史校正补记', 'Historical correction note')}</strong>}
      <p className="live-note-text">{note.text}</p>{references(note.refs)}
    </article>)}</div>
    {!notes.length && <p className="muted">{t('有新的课程要点时自动记录。', 'New learning points will be recorded here.')}</p>}
    <h3>{t('历史歧义校正', 'Historical ambiguity correction')}</h3>
    <p className="muted">{t('使用音频设置中选择的文字模型在后台处理，实录与逐批校正继续进行。未完成的请求会保留，方便重试。', 'Processed in the background using the text model selected in audio settings, while recording and batch correction continue. Incomplete requests remain available for retry.')}</p>
    <p role="status">{t(`待处理 ${background.pending || 0} · 未完成 ${background.failed || 0}`, `${background.pending || 0} pending · ${background.failed || 0} incomplete`)}</p>
    {(background.tasks || []).map(task => <details key={task.id} className="live-note-task"><summary>{({ queued: t('排队中', 'Queued'), running: t('后台处理中', 'Working in background'), done: t('已完成', 'Completed'), failed: t('待重试', 'Retry needed') })[task.status]} · {task.reason}</summary>
      {references(task.ids)}{task.error && <p>{task.error}</p>}
    </details>)}
    {background.failed > 0 && <button disabled={disabled || background.running} onClick={onRetry}>{t('重试历史歧义校正', 'Retry historical correction')}</button>}
    <small className="muted">{t('保存为资料时，会另外保存一份课堂笔记，包含摘要、分批记录和引用。', 'Saving sources also saves class notes containing the summary, batch entries and references.')}</small>
  </details>;
}
