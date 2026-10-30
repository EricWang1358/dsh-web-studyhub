import React from 'react';
import { Button } from '../components/Button.jsx';

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
          <span className="question-prep-title">正在准备新题目（独立审核中）...</span>
        </div>
        <p className="question-prep-desc">
          系统正在比对讲义原文、设计选项并执行独立审核，预计耗时 10–20 秒。
        </p>
        <div className="question-prep-actions">
          <Button
            variant="secondary"
            size="sm"
            className="guided-study-btn"
            onClick={onCancel}
          >
            取消准备
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
          <span className="question-prep-title">题目未通过审核</span>
        </div>
        <p className="question-prep-reason">
          {prepState.message || prepState.reason || '所选段落未能核对出可作答引文'}
        </p>
        <div className="question-prep-actions">
          <Button
            variant="secondary"
            size="sm"
            className="guided-study-btn"
            onClick={onFallbackToExisting}
          >
            改用已有题练习
          </Button>
        </div>
      </div>
    );
  }

  return null;
}
