import React, { useState } from 'react';
import { Button } from '../components/Button.jsx';
import { Badge } from '../components/Badge.jsx';

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
          <strong>{progress.displayLine || '正在计算进度...'}</strong>
        </div>
        <div className="progress-sub-line">
          <span>讲解已覆盖 {progress.lectureCoveredCount || 0} 点</span>
          <span> · 隔日巩固待复习 {progress.nextDayDueCount || 0} 题</span>
        </div>
        <div className="progress-time-line">
          <span>⏱️ {estimate.message || '尚在估计，完成首个检验后更新'}</span>
        </div>
        <div className="progress-toggle-row">
          <Button
            variant="secondary"
            size="sm"
            className="guided-study-btn"
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? '收起依据' : '展开依据'}
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
                    <Badge tone={statusMeta.tone} size="sm">{statusMeta.label}</Badge>
                    <span className="progress-item-title">{item.title}</span>
                    {onDeleteItem && (
                      <Button
                        variant="quiet"
                        size="sm"
                        className="progress-item-del-btn"
                        onClick={() => onDeleteItem(item.id)}
                        title="删除检验项"
                        aria-label="删除检验项"
                      >
                        删除
                      </Button>
                    )}
                  </div>

                  {item.evidenceAttemptIds?.length > 0 && (
                    <div className="progress-item-evidence">
                      <span className="evidence-label">作答依据：</span>
                      {item.evidenceAttemptIds.map((attId, idx) => (
                        <Button
                          key={attId}
                          variant="link"
                          size="sm"
                          className="evidence-link"
                          onClick={() => onSelectAttempt?.(attId)}
                        >
                          记录 #{idx + 1}
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
                placeholder="新增检验项名称..."
                value={newItemTitle}
                onChange={(e) => setNewItemTitle(e.target.value)}
                className="progress-add-input"
              />
              <Button type="submit" variant="primary" size="sm" className="guided-study-btn">
                添加
              </Button>
            </form>
          )}
        </div>
      )}
    </div>
  );
}
