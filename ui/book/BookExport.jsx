import React, { useState } from 'react';
import { ui, uiFormat, errorMessage } from '../i18n.js';
import { Badge, Button, Dialog, Field, Hint, LoadingState, NumberInput, SegmentedControl } from '../components/index.js';
import { useStudy } from '../study-context.jsx';
import { useLiveEffect } from '../use-async.js';
import { PAGE_LIMIT_MAX } from '../../lib/book-settings.js';
import { downloadText } from './download.js';

/* 「导出」 of the review book (M6, docs/plans/review-book.md): the book as the learner's printable CP (course.book.export, lib/course-book-export.js):
   查找页 first, question links as numbered questions, with or without the 答案册; one Markdown file to download, or the files of the folder one by one
   with book.yaml listing their order (the app has no zip writer). The A4 page estimate of each choice, and the page limit the learner may set
   (settings.book.pageLimit), compared with it. */

/** The quiet comparison of an estimate with the limit: null without a limit. */
export function budgetText(pages, limit) {
  if (!limit || !Number.isInteger(pages)) return null;
  return pages > limit ? { tone: 'warning', text: uiFormat('超出上限 {0} 页', [pages - limit]) } : { tone: 'success', text: uiFormat('在上限 {0} 页以内', [limit]) };
}

/** course; pageLimit: the saved limit (or undefined); onClose(). */
export default function BookExport({ course, pageLimit, onClose }) {
  const { call, act, notify } = useStudy();
  const [answerKey, setAnswerKey] = useState(false);
  const [state, setState] = useState({ done: null, error: null });
  const [folder, setFolder] = useState(null);
  const [limit, setLimit] = useState(pageLimit ? String(pageLimit) : '');
  useLiveEffect(isLive => {
    setState(current => ({ ...current, error: null }));
    call('course.book.export', { course, answerKey }).then(done => { if (isLive()) setState({ done, error: null }); }, error => { if (isLive()) setState({ done: null, error }); });
  }, [call, course, answerKey]);
  const done = state.done?.status === 'ok' ? state.done : null, estimate = done?.estimate;
  const saveLimit = async () => {
    const value = limit.trim() === '' ? null : Number(limit);
    if (value !== null && !(Number.isInteger(value) && value >= 1 && value <= PAGE_LIMIT_MAX)) { notify({ text: uiFormat('页数上限是 1 到 {0} 的整数', [PAGE_LIMIT_MAX]), tone: 'error' }); return; }
    if ((value ?? undefined) === pageLimit) return;
    try { await act('settings.book.set', { patch: { pageLimit: value } }, () => {}, { rethrow: true }); } catch (failure) { notify({ text: errorMessage(failure), tone: 'error' }); }
  };
  const openFolder = async () => {
    try { setFolder(await call('course.book.export', { course, answerKey, form: 'folder' })); } catch (failure) { notify({ text: errorMessage(failure), tone: 'error' }); }
  };
  const saved = Number.isInteger(pageLimit) ? pageLimit : null, budget = estimate ? budgetText(estimate.pages, saved) : null;
  const footer = <>
    <Button variant="secondary" icon="list" disabled={!done} onClick={folder ? () => setFolder(null) : openFolder} aria-expanded={!!folder}>{folder ? ui('收起文件清单') : ui('分文件导出…')}</Button>
    <Button variant="primary" icon="download" disabled={!done} onClick={() => downloadText(done.filename, done.text)}>{ui('下载 Markdown')}</Button>
  </>;
  return (
    <Dialog title={ui('导出复习全书')} size="md" className="book-export" onClose={onClose} footer={footer}>
      <div className="book-export__body">
        <p className="book-export__lead">{ui('导出成你自己的开卷速查：前面是查找页（目录、按题型、按概念、易错点），题目链接换成编号的题目，标记都去掉。')}</p>
        <SegmentedControl label={ui('答案册')} className="book-export__key" value={answerKey ? 'with' : 'without'} wrap onChange={value => { setAnswerKey(value === 'with'); setFolder(null); }}
          options={[{ value: 'without', label: estimate ? uiFormat('不含答案册 · 约 {0} 页', [estimate.book]) : ui('不含答案册') },
            { value: 'with', label: estimate ? uiFormat('含答案册 · 约 {0} 页', [estimate.withAnswers]) : ui('含答案册') }]} />
        {state.error ? <Hint tone="error">{errorMessage(state.error)}</Hint> : !done ? <LoadingState inline label={ui('正在准备导出…')} /> : <div className="book-export__estimate" role="status">
          <p className="book-export__pages">{uiFormat('约 {0} 页 A4', [estimate.pages])} {budget && <Badge size="sm" tone={budget.tone}>{budget.text}</Badge>}</p>
          <Hint>{uiFormat('这是估计：每页约 {0} 行，每行约 {1} 个汉字；标了不打印的段落不算。题目 {2} 道。', [estimate.rows, estimate.columns, done.questions])}</Hint>
        </div>}
        <Field label={ui('页数上限')} hint={ui('考试只许带几页时填上；留空就是不限。')} width="sm">
          <NumberInput inputMode="numeric" min={1} max={PAGE_LIMIT_MAX} step={1} value={limit} suffix={ui('页')} placeholder={ui('不限')}
            onChange={event => setLimit(event.target.value)} onBlur={saveLimit} onKeyDown={event => { if (event.key === 'Enter') saveLimit(); }} />
        </Field>
        {folder?.files && <div className="book-export__files">
          <Hint>{ui('没有打包：逐个下载到同一个文件夹，book.yaml 记着顺序，用 pandoc 按这个顺序读就是整本书。')}</Hint>
          <ul className="book-export__list">
            {[folder.manifest, ...folder.files].map(file => <li key={file.name}>
              <Button variant="link" size="sm" icon="download" className="book-export__file" onClick={() => downloadText(file.name, file.text, file.name.endsWith('.yaml') ? 'text/yaml' : 'text/markdown')}>{file.name}</Button>
            </li>)}
          </ul>
        </div>}
      </div>
    </Dialog>
  );
}
