import React, { useState } from 'react';
import { Button } from '../components/Button.jsx';
import { Badge } from '../components/Badge.jsx';
import { ui, uiFormat } from '../i18n.js';
import { LoadingState } from '../components/Loading.jsx';
import { joinMeta } from '../format.js';
import { exactTok } from '../token-usage.js';
import { NOT_ALONE_LABEL } from '../../lib/study-progress.js';

const STATUS_LABELS = {
  pending: { label: '待检验', tone: 'neutral' },
  assisted: { label: NOT_ALONE_LABEL, tone: 'info' },
  passed: { label: '已独立通过', tone: 'success' },
  needs_review: { label: '需复核', tone: 'warning' },
};

/* The line under the progress: the range, how firm it is, or that there is nothing to say yet. The words are the ones lib/study-time-estimate.js writes. */
function estimateLine(estimate) {
  if (estimate?.status === 'estimated') {
    return uiFormat(estimate.preliminary ? '预计达到本次检验目标还需 {0}–{1} 分钟（初步估计）' : '预计达到本次检验目标还需 {0}–{1} 分钟',
      [estimate.minMinutes, estimate.maxMinutes]);
  }
  if (estimate?.status === 'completed') return ui('已完成本次全部检验目标');
  if (estimate?.status === 'no_goal') return ui('设定检验项后再估计时间');
  return ui('尚在估计，完成首个检验后更新');
}

/* The four parts of what the session cost, in DSH's unit (lib/study-session-cost.js): tokens as the plugin could count them, never a price.
   What nothing measured says so instead of reading 0. */
function costRows(cost) {
  const parts = cost?.breakdown;
  if (!parts) return [];
  const rows = [];
  rows.push(parts.tutoring?.measured ? uiFormat('教学讲解与读现场：{0}', [exactTok(parts.tutoring.tokens)]) : ui('教学讲解与读现场：主会话的用量，见 DSH 的用量面板'));
  rows.push(uiFormat('复用已有题：{0} 道，0 次模型调用', [parts.reusedQuestions?.count || 0]));
  rows.push(parts.generation?.measured === false ? ui('新题生成与独立审核：用量未知，没有计入') : uiFormat('新题生成与独立审核：{0}', [exactTok(parts.generation?.tokens || 0)]));
  rows.push(parts.qaOrganize?.tokens ? uiFormat('QA 整理：{0}', [exactTok(parts.qaOrganize.tokens)]) : ui('QA 整理：复用讲解，0 额外模型调用'));
  const each = cost.costPerIndependentCheckItem;
  if (each?.measured === false) rows.push(ui('每道独立通过的题平均：有出题的用量未知，算不出'));
  else rows.push(typeof each === 'object' && each
    ? uiFormat(each.includesTutoring ? '每道独立通过的题平均：{0}' : '每道独立通过的题平均：{0}（不含主会话）', [exactTok(each.tokens)])
    : ui('每道独立通过的题的平均用量：做完第一道后计算'));
  return rows;
}

export function StudyProgressPanel({
  progress = {},
  estimate = {},
  cost = null,
  defaultExpanded = false,
  session = {},
  onUpdateItem,
  onAddItem,
  onDeleteItem,
  onSelectAttempt,
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
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
          <span>⏱️ {estimateLine(estimate)}</span>
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
              // An item whose status is not known yet (the session has not been read) carries no badge, rather than a result nobody worked out.
              const statusMeta = STATUS_LABELS[item.status];
              return (
                <div key={item.id} className="progress-item-card">
                  <div className="progress-item-header">
                    {statusMeta && <Badge tone={statusMeta.tone} size="sm">{ui(statusMeta.label)}</Badge>}
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

          {/* 本次用量：四项分开说，只用 token */}
          {costRows(cost).length > 0 && (
            <div className="progress-cost-section">
              <strong className="progress-cost-title">{ui('本次用量')}</strong>
              <ul className="progress-cost-list">
                {costRows(cost).map((row) => <li key={row}>{row}</li>)}
              </ul>
            </div>
          )}

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
