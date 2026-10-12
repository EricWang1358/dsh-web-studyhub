import React from 'react';
import { ui, uiFormat } from '../i18n.js';

/* 知识点 of a 复习全书 build: each knowledge point being worked on and where it is (waiting, writing, reviewing, complete, short, not written), with its
   concept coverage once it is judged (the build's `detail.book.board`). Its calls are the lanes of the timeline above, one lane per point. */

const STATE = { waiting: 'queued', writing: 'run', reviewing: 'run', ok: 'done', short: 'fail', failed: 'fail' };
const WORD = { waiting: '等待', writing: '在写', reviewing: '在审阅', ok: '达标', short: '未达标', failed: '没写成' };

export default function BookBoard({ contract }) {
  const rows = contract.detail.book?.board || [];
  return (
    <div className="tc-files">
      <div className="tc-scroll">
        {rows.map(row => (
          <div className="tc-batch" key={row.id} data-point={row.id} data-status={row.status}>
            <span className="tc-dot" data-state={STATE[row.status] || 'run'} aria-hidden="true" />
            <span className="tc-batch__text">{row.title}</span>
            {['ok', 'short'].includes(row.status) && <span className="tc-batch__time">{uiFormat('概念 {0}/{1}', [Math.max(0, row.must - (row.missing ?? 0)), row.must])}</span>}
            <span className="tc-num" data-state={STATE[row.status] || 'run'}>{ui(WORD[row.status] || '等待')}</span>
          </div>
        ))}
        {rows.length === 0 && <p className="tc-empty">{ui('知识点都没变，不用重写。')}</p>}
      </div>
    </div>
  );
}
