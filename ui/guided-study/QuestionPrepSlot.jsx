import React from 'react';
import { Button } from '../components/Button.jsx';
import { ui } from '../i18n.js';

export function QuestionPrepSlot({
  prepState = {},
  onCancel,
  onFallbackToExisting,
}) {
  const status = prepState.status || 'running';

  if (status === 'queued' || status === 'running') {
    return (
      <div className="question-prep-slot question-prep-running" role="status">
        <div className="question-prep-header">
          <span className="question-prep-spinner" />
          <span className="question-prep-title">{ui('正在出一道新题')}</span>
        </div>
        {/* What the job really does (the ordinary supplement: plan, answer, author, citation check, independent review): no promised duration. */}
        <p className="question-prep-desc">
          {ui('按资料出题，核对引文并独立审核；通过后这道题会加入题组并在这里打开。')}
        </p>
        {prepState.stage && <p className="question-prep-stage">{prepState.stage}</p>}
        <div className="question-prep-actions">
          <Button
            variant="secondary"
            size="sm"
            className="guided-study-btn"
            onClick={onCancel}
          >
            {ui('取消准备')}
          </Button>
        </div>
      </div>
    );
  }

  if (status === 'failed') {
    return (
      <div className="question-prep-slot question-prep-failed" role="alert">
        <div className="question-prep-header">
          <span className="question-prep-warning-icon">⚠️</span>
          <span className="question-prep-title">{ui('这道题没有加入题组')}</span>
        </div>
        <p className="question-prep-reason">
          {prepState.reason || prepState.message || ui('出题没有完成')}
        </p>
        <div className="question-prep-actions">
          <Button
            variant="secondary"
            size="sm"
            className="guided-study-btn"
            onClick={onFallbackToExisting}
          >
            {ui('改用已有题练习')}
          </Button>
        </div>
      </div>
    );
  }

  return null;
}
