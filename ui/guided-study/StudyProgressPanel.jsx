import React, { useState } from 'react';
import { Button } from '../components/Button.jsx';
import { Badge } from '../components/Badge.jsx';
import { ui, uiFormat } from '../i18n.js';
import { LoadingState } from '../components/Loading.jsx';
import { joinMeta } from '../format.js';

const STATUS_LABELS = {
  pending: { label: '待检验', tone: 'neutral' },
  assisted: { label: '借助提示完成', tone: 'info' },
  passed: { label: '已独立通过', tone: 'success' },
  needs_review: { label: '需复核', tone: 'warning' },
};

export function StudyProgressPanel({
  progress = {},
  estimate = {},
  session = {},
  onUpdateItem,
  onAddItem,
  onDeleteItem,
  onSelectAttempt,
}) {
  const [expanded, setExpanded] = useState(false);
  const [newItemTitle, setNewItemTitle] = useState('');

  const items = progress.items || [];

  const handleAddItem = (e) => {
    e.preventDefault();
    if (newItemTitle.trim() && onAddItem) {
      onAddItem(newItemTitle.trim());
      setNewItemTitle('');
    }
  };

  return (
    <div className="study-progress-panel">
      {/* 紧凑首屏概览 */}
      <div className="progress-summary-row">
        <div className="progress-main-line">
          {progress.displayLine ? <strong>{progress.displayLine}</strong> : <LoadingState label={ui('正在计算进度…')} />}
        </div>
        <div className="progress-sub-line">
          <span>{joinMeta([uiFormat('讲解已覆盖 {0} 点', [progress.lectureCoveredCount || 0]), uiFormat('隔日巩固待复习 {0} 题', [progress.nextDayDueCount || 0])])}</span>
        </div>
        <div className="progress-time-line">
          <span>⏱️ {estimate.message || ui('还在估计，做完第一项检验后更新')}</span>
        </div>
        <div className="progress-toggle-row">
          <Button
            variant="secondary"
            size="sm"
            className="guided-study-btn"
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? ui('收起依据') : ui('展开依据')}
          </Button>
        </div>
      </div>

      {/* 依据与明细展开区 */}
      {expanded && (
        <div className="progress-details-section">
          <div className="progress-items-list">
            {items.map((item) => {
              const statusMeta = STATUS_LABELS[item.status] || STATUS_LABELS.pending;
              return (
                <div key={item.id} className="progress-item-card">
                  <div className="progress-item-header">
                    <Badge tone={statusMeta.tone} size="sm">{ui(statusMeta.label)}</Badge>
                    <span className="progress-item-title">{item.title}</span>
                    {onDeleteItem && (
                      <Button
                        variant="quiet"
                        size="sm"
                        className="progress-item-del-btn"
                        onClick={() => onDeleteItem(item.id)}
                        title={ui('删除检验项')}
                        aria-label={ui('删除检验项')}
                      >
                        {ui('删除')}
                      </Button>
                    )}
                  </div>

                  {item.evidenceAttemptIds?.length > 0 && (
                    <div className="progress-item-evidence">
                      <span className="evidence-label">{ui('作答依据：')}</span>
                      {item.evidenceAttemptIds.map((attId, idx) => (
                        <Button
                          key={attId}
                          variant="link"
                          size="sm"
                          className="evidence-link"
                          onClick={() => onSelectAttempt?.(attId)}
                        >
                          {uiFormat('记录 #{0}', [idx + 1])}
                        </Button>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* 添加新检验项表单 */}
          {onAddItem && (
            <form onSubmit={handleAddItem} className="progress-add-form">
              <input
                type="text"
                placeholder={ui('新检验项的名称…')}
                value={newItemTitle}
                onChange={(e) => setNewItemTitle(e.target.value)}
                className="progress-add-input"
              />
              <Button type="submit" variant="primary" size="sm" className="guided-study-btn">
                {ui('添加')}
              </Button>
            </form>
          )}
        </div>
      )}
    </div>
  );
}
