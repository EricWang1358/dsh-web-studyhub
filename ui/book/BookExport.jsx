import React, { useRef, useState } from 'react';
import { ui, uiFormat, errorMessage } from '../i18n.js';
import { Badge, Button, Dialog, Field, Hint, LoadingState, NumberInput, RadioCard, RadioCardGroup, SegmentedControl, Tooltip } from '../components/index.js';
import { useStudy } from '../study-context.jsx';
import { useLiveEffect } from '../use-async.js';
import { PAGE_LIMIT_MAX } from '../../lib/book-settings.js';
import { downloadBytes, downloadText } from './download.js';
import { zipTextFiles } from './zip.js';

/* 「导出」 of the review book (M6, docs/plans/review-book.md): the book as the learner's printable CP (course.book.export, lib/course-book-export.js):
   查找页 first, question links as numbered questions, with or without the 答案册; one Markdown file to download, or the files of the folder in one .zip
   with book.yaml listing their order (ui/book/zip.js). The A4 page estimate of each choice, and the page limit the learner may set
   (settings.book.pageLimit), compared with it. */

/** The three choices of which questions are printed (lib/course-book-export.js QUESTION_MODES). */
const questionChoices = () => [
  { value: 'linked', title: ui('只印书里链接的题'), hint: ui('问答文件里的和你自己写了链接的题；答案册只有这些。') },
  { value: 'all', title: ui('再加每个知识点自己的题'), hint: ui('每个知识点的题都印出来，带选项，最占页数。') },
  { value: 'none', title: ui('不印题目'), hint: ui('题目链接都去掉，答案册是空的。') },
];

/** The quiet comparison of an estimate with the limit: null without a limit. */
export function budgetText(pages, limit) {
  if (!limit || !Number.isInteger(pages)) return null;
  return pages > limit ? { tone: 'warning', text: uiFormat('比上限多 {0} 页', [pages - limit]) } : { tone: 'success', text: uiFormat('在上限 {0} 页以内', [limit]) };
}

/** course; pageLimit: the saved limit (or undefined); onClose(). */
export default function BookExport({ course, pageLimit, onClose }) {
  const { call, act, notify } = useStudy();
  const [answerKey, setAnswerKey] = useState(false);
  // Which questions are printed (course.book.export `questions`): only the linked ones by default.
  const [questions, setQuestions] = useState('linked');
  const [state, setState] = useState({ done: null, error: null });
  const zipping = useRef(false);
  const [limit, setLimit] = useState(pageLimit ? String(pageLimit) : '');
  useLiveEffect(isLive => {
    setState(current => ({ ...current, error: null }));
    call('course.book.export', { course, answerKey, questions }).then(done => { if (isLive()) setState({ done, error: null }); }, error => { if (isLive()) setState({ done: null, error }); });
  }, [call, course, answerKey, questions]);
  const done = state.done?.status === 'ok' ? state.done : null, estimate = done?.estimate;
  const saveLimit = async () => {
    const value = limit.trim() === '' ? null : Number(limit);
    if (value !== null && !(Number.isInteger(value) && value >= 1 && value <= PAGE_LIMIT_MAX)) { notify({ text: uiFormat('页数上限是 1 到 {0} 的整数', [PAGE_LIMIT_MAX]), tone: 'error' }); return; }
    if ((value ?? undefined) === pageLimit) return;
    try { await act('settings.book.set', { patch: { pageLimit: value } }, () => {}, { rethrow: true }); } catch (failure) { notify({ text: errorMessage(failure), tone: 'error' }); }
  };
  const downloadZip = async () => {
    // One at a time. Not shown as busy: a busy button is disabled, which drops the focus and with it Esc; a whole book takes a moment.
    if (zipping.current) return;
    zipping.current = true;
    try {
      const folder = await call('course.book.export', { course, answerKey, questions, form: 'folder' });
      downloadBytes(`${folder.filename}.zip`, zipTextFiles([folder.manifest, ...folder.files]));
    } catch (failure) { notify({ text: errorMessage(failure), tone: 'error' }); } finally { zipping.current = false; }
  };
  const saved = Number.isInteger(pageLimit) ? pageLimit : null, budget = estimate ? budgetText(estimate.pages, saved) : null;
  const footer = <>
    <Tooltip layer content={ui('每个知识点一份文件，打包成一个 zip；book.yaml 记着顺序，用 pandoc 按这个顺序读就是整本书。')}>
      <Button variant="secondary" icon="download" className="book-export__zip" disabled={!done} onClick={downloadZip}>{ui('分文件下载（zip）')}</Button></Tooltip>
    <Button variant="primary" icon="download" disabled={!done} onClick={() => downloadText(done.filename, done.text)}>{ui('下载 Markdown')}</Button>
  </>;
  return (
    <Dialog title={ui('导出复习全书')} size="md" className="book-export" onClose={onClose} footer={footer}>
      <div className="book-export__body">
        <p className="book-export__lead">{ui('导出成你自己的开卷速查：前面是查找页（目录、按题型、按概念、易错点），题目链接换成编号的题目，标记都去掉。')}</p>
        <RadioCardGroup legend={ui('印哪些题')} className="book-export__questions">
          {questionChoices().map(choice => <RadioCard key={choice.value} name="book-export-questions" value={choice.value} checked={questions === choice.value}
            title={choice.title} hint={choice.hint} onSelect={setQuestions} />)}
        </RadioCardGroup>
        <SegmentedControl label={ui('答案册')} className="book-export__key" value={answerKey ? 'with' : 'without'} wrap onChange={value => setAnswerKey(value === 'with')}
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
      </div>
    </Dialog>
  );
}
