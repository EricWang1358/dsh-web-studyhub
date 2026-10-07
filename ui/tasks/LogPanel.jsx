import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ui, uiFormat } from '../i18n.js';
import { Button, Checkbox, Tooltip } from '../components/index.js';
import { formatDateTime } from '../format.js';
import { logLines, logCounts } from './call-model.js';

/* 日志: the job's events as structured lines, newest first, with level filters and a "follow the latest" switch. A warning several files share is ONE
   line with its count, and the grouped notices sit in ONE fixed-height line above the list (nothing here ever grows a side column): the files they are
   about are marked on their own rows in the file list.
   A call of a question run has a second line in a slot of its own (one line, cut with an ellipsis, so it never changes the height of a row after it is drawn):
   the batch it belongs to and the question counts the call recorded (call-model.js callDetail; never the model, the reasoning level or the tokens). */

const FILTERS = [['all', '全部'], ['step', '步骤'], ['warn', '提醒'], ['done', '里程碑']];
const TAG = { transcribe: '转写', proofread: '校对', translate: '翻译', author: '出题', review: '审阅', plan: '规划', repair: '修复', blueprint: '情景' };

/** The grouped notices of a job as one sentence: the first one in full, the others counted. */
export function noticeLine(contract) {
  const notices = contract.detail?.notices;
  const list = Array.isArray(notices) ? notices : (Array.isArray(contract.detail?.warnings) ? contract.detail.warnings : []).map((text) => ({ code: 'warning', text, count: 1 }));
  if (!list.length) return '';
  const [first, ...rest] = list;
  const head = first.code === 'format-mismatch' ? uiFormat('{0} 个文件的扩展名与实际格式不符（实为 {1}），已按实际格式处理', [first.count, first.actualFormat])
    : first.count > 1 ? `${first.text} ×${first.count}` : first.text;
  return rest.length ? uiFormat('{0} · 另有 {1} 条', [head, rest.length]) : head;
}

export default function LogPanel({ contract }) {
  const [level, setLevel] = useState('all'), [follow, setFollow] = useState(true);
  const lines = useMemo(() => logLines(contract, level), [contract, level]);
  const counts = useMemo(() => logCounts(contract), [contract]);
  const body = useRef(null);
  // Newest first: following the latest means staying at the top; with it off the browser's scroll anchoring keeps what is being read where it is.
  useEffect(() => { if (follow && body.current) body.current.scrollTop = 0; }, [lines, follow]);
  const notice = noticeLine(contract);
  return (
    <div className="tc-log">
      <div className="tc-log__bar">
        <div className="tc-filters" role="group" aria-label={ui('日志筛选')}>
          {FILTERS.map(([id, label]) => <Button key={id} size="sm" className="tc-filter" aria-pressed={level === id} onClick={() => setLevel(id)}>{id === 'all' ? ui(label) : `${ui(label)} ${counts[id]}`}</Button>)}
        </div>
        <Checkbox label={ui('跟随最新')} checked={follow} onChange={setFollow} />
      </div>
      <p className="tc-log__notice" data-empty={notice ? undefined : 'true'}>{notice || ui('没有提醒')}</p>
      <div className="tc-log__body" role="log" aria-live="off" ref={body}>
        {lines.length === 0 && <p className="tc-empty">{ui('还没有日志。')}</p>}
        {lines.map((line) => (
          <div className="tc-line" key={line.id} data-level={line.level}>
            <span className="tc-line__time">{formatDateTime(line.at, 'timeSeconds')}</span>
            <span className="tc-line__tag">{line.tag && TAG[line.tag] ? ui(TAG[line.tag]) : ''}</span>
            <span className="tc-line__text">{line.text}</span>
            {typeof line.detail === 'string' && <Tooltip layer content={line.detail} anchorClassName="tc-line__detail-anchor"><span className="tc-line__detail" tabIndex={0}>{line.detail}</span></Tooltip>}
          </div>
        ))}
      </div>
    </div>
  );
}
