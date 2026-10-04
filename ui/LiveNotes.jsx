import React from 'react';
import { ui, uiFormat } from './i18n.js';
import { Button } from './components/index.js';

export default function LiveNotes({ correction, onSentence, onRetry, disabled }) {
  const { memory, notes = [], background = {} } = correction;
  const references = ids => <div className="live-note-refs">{(ids || []).map(id => <Button variant="link" size="sm" key={id} onClick={() => onSentence(id)}>
    {uiFormat('句 {0}', [id])}</Button>)}</div>;
  return <details className="live-notes">
    <summary>{uiFormat('查看课堂笔记 · {0} 条', [notes.length])}</summary>
    <p className="muted">{ui('每批校正后更新；下一批参考累计摘要与最近笔记。点句子编号可回看原文。')}</p>
    <h3>{ui('累计摘要')}</h3>
    <p className="live-note-text">{memory?.text || ui('首批校正完成后，这里会出现课堂摘要。')}</p>
    {references(memory?.refs)}
    <h3>{ui('分批笔记')}</h3>
    <div className="live-note-list">{notes.map((note, index) => <article key={index}>
      {note.kind === 'amendment' && <strong>{ui('历史校正补记')}</strong>}
      <p className="live-note-text">{note.text}</p>{references(note.refs)}
    </article>)}</div>
    {!notes.length && <p className="muted">{ui('有新的课程要点时自动记录。')}</p>}
    <h3>{ui('历史歧义校正')}</h3>
    <p className="muted">{ui('使用音频设置中选择的文字模型在后台处理，实录与逐批校正继续进行。未完成的请求会保留，方便重试。')}</p>
    <p role="status">{uiFormat('待处理 {0} · 未完成 {1}', [background.pending || 0, background.failed || 0])}</p>
    {(background.tasks || []).map(task => <details key={task.id} className="live-note-task"><summary>{({ queued: ui('排队中'), running: ui('后台处理中'), done: ui('已完成'), failed: ui('待重试') })[task.status]} · {task.reason}</summary>
      {references(task.ids)}{task.error && <p>{task.error}</p>}
    </details>)}
    {background.failed > 0 && <Button disabled={disabled || background.running} onClick={onRetry}>{ui('重试历史歧义校正')}</Button>}
    <small className="muted">{ui('保存为资料时，会另外保存一份课堂笔记，包含摘要、分批记录和引用。')}</small>
  </details>;
}
