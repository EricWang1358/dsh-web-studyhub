import React from 'react';
import { ui, uiFormat } from '../i18n.js';
import { Badge, Button, Tooltip } from '../components/index.js';
import { RubricResult } from '../CaseResult.jsx';
import { useStudy } from '../study-context.jsx';
import { useInjectCss } from '../shared.js';
import css from '../voice/voice.css';

/**
 * Post-attempt evaluation + correction display (#1031):
 * - Spoken transcript ("你的口述原话")
 * - Strict FSRS evaluation (`RubricResult` + 0-5 manual override)
 * - Separated Post-Attempt Correction ("关键词扩写订正", "表达不专业修正", never inflating FSRS)
 * - 3-step gate button ("我看懂了 · 加入重练") when `feedback.correctionPending` is true
 */
export default function CorrectionCard({ feedback, onAdjustGrade, onAckCorrection, compact = false, showRubric = true }) {
  useInjectCss(css, 'study-voice');
  const { busy } = useStudy();
  if (!feedback) return null;

  const transcript = feedback.transcript || (feedback.spoken ? feedback.answer : '');
  const correction = feedback.correction;
  const hasRubric = showRubric && !!feedback.rubric;
  const showCard = !!(transcript || hasRubric || correction || feedback.correctionPending);
  if (!showCard) return null;

  return (
    <section className="voice-correction-card" aria-label={ui('评估与订正反馈')}>
      {transcript && (
        <div className="voice-correction-transcript">
          <span className="voice-correction-transcript__label">{ui('你的口述原话')}</span>
          <div>{transcript}</div>
        </div>
      )}

      {hasRubric && <RubricResult rubric={feedback.rubric} compact={compact} />}

      {Number.isInteger(feedback.grade) && (
        <div className="voice-grade-bar">
          <Badge size="sm" tone={feedback.grade >= 3 ? 'success' : 'warning'}>
            {uiFormat('当前 FSRS 评分：{0} 分', [feedback.grade])}
          </Badge>
          {feedback.gradeAdjusted && <Badge size="sm">{ui('已手动微调')}</Badge>}
          {correction?.fragmentsOnly && <Badge size="sm" tone="warning">{ui('仅关键词碎片 · 保底低分')}</Badge>}
          {onAdjustGrade && (
            <Tooltip layer content={ui('手动微调 0–5 分（仅更新记忆间隔，不改动已保存的订正内容）')}>
              <div className="voice-grade-pills" role="group" aria-label={ui('微调评分')}>
                {[0, 1, 2, 3, 4, 5].map((g) => (
                  <Button
                    key={g}
                    type="button"
                    size="sm"
                    variant="quiet"
                    lock={busy}
                    className="voice-grade-pill"
                    aria-pressed={feedback.grade === g}
                    onClick={() => onAdjustGrade(g)}
                  >
                    {g}
                  </Button>
                ))}
              </div>
            </Tooltip>
          )}
        </div>
      )}

      {correction && (
        <div className="voice-correction-box">
          <div className="voice-correction-box__head">
            <strong>{ui('订正反馈（不计入 FSRS 评分）')}</strong>
            <Badge size="sm">{ui('仅作纠偏与扩写练习')}</Badge>
          </div>

          {correction.keywordExpansion && (
            <div>
              <span className="voice-correction-section__label">{ui('关键词扩写订正')}</span>
              <p className="md-compact">{correction.keywordExpansion}</p>
            </div>
          )}

          {correction.phrasingUpgrade?.professional && (
            <div>
              <span className="voice-correction-section__label">{ui('表达不专业修正')}</span>
              <div className="voice-phrasing-diff">
                {correction.phrasingUpgrade.informal && (
                  <div className="voice-phrasing-diff__col voice-phrasing-diff__col--informal">
                    <span className="voice-correction-section__label">{ui('口语原表达')}</span>
                    <div>{correction.phrasingUpgrade.informal}</div>
                  </div>
                )}
                <div className="voice-phrasing-diff__col voice-phrasing-diff__col--pro">
                  <span className="voice-correction-section__label">{ui('专业规范表达')}</span>
                  <div>{correction.phrasingUpgrade.professional}</div>
                </div>
              </div>
            </div>
          )}

          {correction.missingLinks?.length > 0 && (
            <div>
              <span className="voice-correction-section__label">{ui('遗漏的关键推导 / 边界')}</span>
              <ul>
                {correction.missingLinks.map((item, idx) => <li key={idx}>{item}</li>)}
              </ul>
            </div>
          )}
        </div>
      )}

      {feedback.correctionPending && onAckCorrection && (
        <div className="voice-grade-bar">
          <Button type="button" variant="primary" size="sm" lock={busy} onClick={onAckCorrection}>
            {ui('我看懂了 · 加入重练')}
          </Button>
          <span className="muted small">{ui('先看清订正再排入本轮尾部重练（不重复计入记忆调度）')}</span>
        </div>
      )}

      {!feedback.correctionPending && feedback.correctionViewed && (
        <div className="muted small">
          {feedback.retryQueued ? ui('✓ 已看懂订正并排入本轮尾部重练') : ui('✓ 已看懂订正')}
        </div>
      )}
    </section>
  );
}
