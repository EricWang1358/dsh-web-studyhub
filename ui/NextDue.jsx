import React from 'react';
import { ui, uiFormat } from './i18n.js';
import { formatDateTime, formatGap } from './format.js';
import { Disclosure } from './components/index.js';

/* The line under a practice answer, drawn inside the question's card right after the explanation: what happened to the question and when it comes back,
   in plain words ("答对了 · 下次大约 3 天后再见"). The word follows the SAME level function as every mastery view
   (lib/mastery.js cardLevel, which the host puts on the feedback as `level`; ui/mastery-terms.js says what each level means): after one correct answer a question is
   学习中 (its interval is not yet 6 days), so the line says 答对了, and only a question whose level really is 已掌握 is called that.
   The numbers behind the date (the interval, the memory estimate the scheduler keeps) are one click away under 「为什么是 N 天」, each with a plain explanation (#672). */

const DAY = 24 * 60 * 60 * 1000;
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
  if (feedback.selfReported || feedback.assessment === 'self-report') return ui('自报，未验收');
  if (!feedback.correct) return ui('↻ 将继续巩固');
  return feedback.level === 'mastered' ? ui('✓ 已掌握') : ui('答对了');
}

/** How long until the question comes back, in the learner's words: 「3 天」 (formatGap), or '' when it is due within the day. */
export function nextDueGap(feedback = {}, now = Date.now()) {
  const due = Date.parse(feedback.nextDue);
  return Number.isFinite(due) ? formatGap(Math.round((due - now) / DAY)) : '';
}

/** 「下次大约 3 天后再见」, or 「下次今天内再见」 when the question is due within the day. */
export const nextDueWhen = (feedback = {}, now = Date.now()) => {
  const gap = nextDueGap(feedback, now);
  return gap ? uiFormat('下次大约 {0}后再见', [gap]) : ui('下次今天内再见');
};

export function NextDue({ feedback, telemetry = null, now = Date.now() }) {
  if (!feedback) return null;
  const meta = telemetry || feedback;
  const promoted = meta.beforeLevel && feedback.level && (LEVEL_RANK[feedback.level] ?? -1) > (LEVEL_RANK[meta.beforeLevel] ?? -1)
    && LEVEL_WORDS[meta.beforeLevel] && LEVEL_WORDS[feedback.level];
  const selfReported = !!(feedback.selfReported || feedback.assessment === 'self-report');
  const hasAfterDays = Number.isFinite(meta.afterDays) && meta.afterDays > 0;
  const beforeDays = Number.isFinite(meta.beforeDays) ? meta.beforeDays : 0;
  const gapChip = hasAfterDays
    ? (beforeDays > 0 && meta.afterDays !== beforeDays
      ? uiFormat('间隔 {0} 天 → {1} 天', [beforeDays, meta.afterDays])
      : (!beforeDays && (feedback.correct || selfReported) ? uiFormat('首轮间隔 {0} 天', [meta.afterDays]) : ''))
    : '';
  const lit = stabilitySteps(meta.stability);
  const credited = Number.isInteger(feedback.credited) && feedback.credited > 0 ? feedback.credited : 0;
  const gap = nextDueGap(feedback, now);
  // The numbers behind the date: shown only when the learner asks, each with its plain meaning.
  const hasWhy = !!(promoted || gapChip || lit > 0 || feedback.nextDue);
  return (
    <div className={`next-due${feedback.correct || selfReported ? '' : ' retry'}`} data-level={feedback.level || undefined}>
      <p className="next-due__lead">
        {uiFormat('{0} · {1}', [nextDueWord(feedback), nextDueWhen(feedback, now)])}
        {feedback.retryQueued && <span>{' · '}{ui('这道题放到了本轮最后，会再出现一次')}</span>}
      </p>
      {(feedback.focusScheduled || credited > 0) && (
        <div className="next-due__telemetry">
          {feedback.focusScheduled && <span className="next-due__chip">{ui('重点加密复习')}</span>}
          {' '}
          {credited > 0 && (
            <span className="next-due__chip next-due__chip--credit">
              {uiFormat('顺带推进 {0} 道前置题', [credited])}
            </span>
          )}
        </div>
      )}
      {hasWhy && (
        <Disclosure className="next-due__why" summary={gap ? uiFormat('为什么是 {0}', [gap]) : ui('为什么是这个时间')}>
          <div className="next-due__telemetry" data-testid="fsrs-telemetry">
            {feedback.nextDue && <span className="next-due__chip">{uiFormat('下次复习 {0}', [date(feedback.nextDue)])}</span>}
            {promoted && (
              <span className="next-due__chip next-due__chip--up">
                {uiFormat('{0} → {1}', [ui(LEVEL_WORDS[meta.beforeLevel]), ui(LEVEL_WORDS[feedback.level])])}
              </span>
            )}
            {gapChip && <span className="next-due__chip">{gapChip}</span>}
            {lit > 0 && (
              <span className="next-due__chip next-due__chip--stability">
                <span>{uiFormat('稳定度 {0} 天', [meta.stability])}</span>
                <span className="next-due__pips" aria-hidden="true">
                  {[1, 2, 3, 4, 5].map((step) => <i key={step} data-lit={step <= lit ? 'true' : undefined} />)}
                </span>
              </span>
            )}
          </div>
          <p className="muted small next-due__explain">
            {ui('复习间隔：这道题隔多少天再出现。答对会拉长，答错会缩短。')}
            {lit > 0 && <>{' '}{ui('稳定度：系统估计你能把这道题记住多久，越稳，下次隔得越久。')}</>}
          </p>
        </Disclosure>
      )}
    </div>
  );
}

export default NextDue;
