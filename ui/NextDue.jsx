import React from 'react';
import { ui, uiFormat } from './i18n.js';
import { formatDateTime } from './format.js';

/* The line under a practice answer: what happened to the question and when it comes back. The word follows the SAME level function as every mastery view
   (lib/mastery.js cardLevel, which the host puts on the feedback as `level`; ui/mastery-terms.js says what each level means): after one correct answer a question is
   学习中 (its interval is not yet 6 days), so the line says 答对了, and only a question whose level really is 已掌握 is called that. */

const date = (value) => (value ? formatDateTime(value, 'stamp') : ui('现在'));

const LEVEL_RANK = { new: 0, weak: 1, learning: 2, familiar: 3, mastered: 4 };
const LEVEL_WORDS = { new: '未学', weak: '薄弱', learning: '学习中', familiar: '熟悉', mastered: '已掌握' };

function stabilitySteps(days) {
  if (!Number.isFinite(days) || days <= 0) return 0;
  if (days >= 21) return 5;
  if (days >= 12) return 4;
  if (days >= 6) return 3;
  if (days >= 2) return 2;
  return 1;
}

/** 「答对了」 / 「✓ 已掌握」 / 「↻ 将继续巩固」: what the answer did, by the level the question has now. */
export function nextDueWord(feedback = {}) {
  if (!feedback.correct) return ui('↻ 将继续巩固');
  return feedback.level === 'mastered' ? ui('✓ 已掌握') : ui('答对了');
}

export function NextDue({ feedback, telemetry = null }) {
  if (!feedback) return null;
  const meta = telemetry || feedback;
  const promoted = meta.beforeLevel && feedback.level && (LEVEL_RANK[feedback.level] ?? -1) > (LEVEL_RANK[meta.beforeLevel] ?? -1)
    && LEVEL_WORDS[meta.beforeLevel] && LEVEL_WORDS[feedback.level];
  const hasAfterDays = Number.isFinite(meta.afterDays) && meta.afterDays > 0;
  const beforeDays = Number.isFinite(meta.beforeDays) ? meta.beforeDays : 0;
  const gapChip = hasAfterDays
    ? (beforeDays > 0 && meta.afterDays !== beforeDays
      ? uiFormat('间隔 {0} 天 → {1} 天', [beforeDays, meta.afterDays])
      : (!beforeDays && feedback.correct ? uiFormat('首轮间隔 {0} 天', [meta.afterDays]) : ''))
    : '';
  const lit = stabilitySteps(meta.stability);
  const credited = Number.isInteger(feedback.credited) && feedback.credited > 0 ? feedback.credited : 0;
  const hasTelemetry = !!(promoted || gapChip || lit > 0 || credited > 0);
  return (
    <div className={`next-due${feedback.correct ? '' : ' retry'}`} data-level={feedback.level || undefined}>
      <p className="next-due__lead">
        {uiFormat('{0} · 下次复习 {1}', [nextDueWord(feedback), date(feedback.nextDue)])}
        {feedback.retryQueued && <span>{' · '}{ui('这道题放到了本轮最后，会再出现一次')}</span>}
      </p>
      {hasTelemetry && (
        <div className="next-due__telemetry" data-testid="fsrs-telemetry">
          {' '}
          {promoted && (
            <span className="next-due__chip next-due__chip--up">
              {uiFormat('{0} → {1}', [ui(LEVEL_WORDS[meta.beforeLevel]), ui(LEVEL_WORDS[feedback.level])])}
            </span>
          )}
          {' '}
          {gapChip && <span className="next-due__chip">{gapChip}</span>}
          {' '}
          {lit > 0 && (
            <span className="next-due__chip next-due__chip--stability">
              <span>{uiFormat('稳定度 {0} 天', [meta.stability])}</span>
              <span className="next-due__pips" aria-hidden="true">
                {[1, 2, 3, 4, 5].map((step) => <i key={step} data-lit={step <= lit ? 'true' : undefined} />)}
              </span>
            </span>
          )}
          {' '}
          {credited > 0 && (
            <span className="next-due__chip next-due__chip--credit">
              {uiFormat('顺带推进 {0} 道前置题', [credited])}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

export default NextDue;
