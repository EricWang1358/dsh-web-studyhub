import React from 'react';
import { Button } from '../components/Button.jsx';
import { Badge } from '../components/Badge.jsx';
import { TeachingArtifactBlock } from './TeachingArtifactBlock.jsx';
import './guided-study.css';

export default function GuidedStudyWorkbench({
  session,
  run,
  modelReady = true,
  onPause,
  onEnd,
  onAnswer,
  onReveal,
  onAnchorClick,
}) {
  const isArtifactFocus = session?.focus?.kind === 'artifact' || session?.focus?.kind === 'source';
  const adaptiveClass = isArtifactFocus
    ? 'guided-study-adaptive-artifact'
    : 'guided-study-adaptive-card';

  const currentArtifact = session?.artifactRefs?.find((a) => a.id === session?.focus?.id) ||
    session?.artifactRefs?.at(-1) || null;

  const currentEntry = run?.entries ? run.entries[run.index] : null;

  return (
    <div className={`guided-study-workbench ${adaptiveClass}`}>
      {/* 1. 顶部紧凑目标栏 */}
      <div className="guided-study-topbar">
        <div className="guided-study-topbar-info">
          <Badge size="sm">{session?.courseId || '带学课程'}</Badge>
          <span className="guided-study-title">{session?.goal?.title || '未设定目标'}</span>
        </div>
        <div className="guided-study-actions">
          {session?.status === 'active' && (
            <Button
              variant="secondary"
              size="sm"
              className="guided-study-btn"
              onClick={() => onPause?.(session.id)}
            >
              暂停
            </Button>
          )}
          <Button
            variant="secondary"
            size="sm"
            className="guided-study-btn"
            onClick={() => onEnd?.(session.id)}
          >
            结束
          </Button>
        </div>
      </div>

      {/* UC-10 模型不可用降级提示 */}
      {!modelReady && (
        <div className="guided-study-model-warning" role="alert">
          当前模型不可用：AI 带学讲解与出题已暂停，你仍可正常阅读资料、做已有练习、复习与查看 QA。
        </div>
      )}

      {/* 主工作区：根据动作自适应展开 */}
      <div className="guided-study-main">
        {/* 2. 当前教学内容区 */}
        <div className="guided-study-artifact-section">
          <TeachingArtifactBlock
            artifact={currentArtifact}
            onAnchorClick={onAnchorClick}
          />
        </div>

        {/* 3. 当前练习区 */}
        <div className="guided-study-practice-section">
          {currentEntry ? (
            <div className="guided-study-card-view">
              <div className="guided-study-card-prompt">
                {currentEntry.card?.prompt}
              </div>

              {currentEntry.revealed && currentEntry.card?.explanation && (
                <div className="guided-study-card-explanation">
                  {currentEntry.card.explanation}
                </div>
              )}

              <div className="guided-study-card-actions">
                {!currentEntry.revealed && (
                  <Button
                    variant="primary"
                    size="sm"
                    className="guided-study-btn"
                    onClick={() => onReveal?.(run.id)}
                  >
                    揭晓答案
                  </Button>
                )}
              </div>
            </div>
          ) : (
            <div className="guided-study-practice-empty">
              <span>当前无正在进行的题目</span>
            </div>
          )}
        </div>
      </div>

      {/* 4. 底部状态与 QA 折叠栏 */}
      <div className="guided-study-footer">
        <div className="guided-study-footer-status">
          <span>会话状态: {session?.status || 'active'}</span>
          {session?.returnPath?.length > 0 && (
            <span> · 支线深度: {session.returnPath.length}</span>
          )}
        </div>
      </div>
    </div>
  );
}
