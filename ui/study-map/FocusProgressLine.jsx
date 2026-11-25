import React from 'react';
import { ui } from '../i18n.js';
import { Button, Icon, Tooltip } from '../components/index.js';
import { summaryPieces } from '../focus-progress-copy.js';

/** 重点 × 掌握度 on the home, under the course progress (lib/focus-progress.js): the counts of the course's focus topics in one line, whose press opens the course settings
    (the topics are listed there), and, when some focus questions are weak, a link that practises exactly those (or, when none are weak and some have no questions yet, a link into 创建题组). How a topic is counted is a hover Tooltip.
    The summary's words are pieces (summaryPieces: the head, then each count with its words) that never break inside, so the line wraps only between them; being data to the look gate
    (tests/helpers/go-on.mjs), it is an entry that opens the settings, not an action to give an arrow. */
export default function FocusProgressLine({ progress, courseId, lock, start, onCourseSettings, onGenerateFocus }) {
  if (!progress?.total) return null;
  const emptyTopics = progress.none > 0 && !progress.weakScope?.length && onGenerateFocus
    ? (progress.topics || []).filter((item) => item.status === 'none').map((item) => item.topic)
    : [];
  const { head, gap, parts } = summaryPieces(progress);
  const allMastered = progress.total > 0 && progress.done === progress.total && !progress.weak && !progress.none;
  return (
    <p className="focus-progress" data-all-mastered={allMastered ? 'true' : undefined}>
      <Tooltip layer content={ui('题目按主题、考点说明或题干里出现的重点词归入重点，一道题可以属于几条重点。有薄弱题的重点算「还不会」，掌握度 80% 以上又没有薄弱题的算「已掌握」，其余算「学习中」。')}>
        <Button variant="quiet" size="sm" wrap className="focus-progress__summary" onClick={() => onCourseSettings?.(courseId)}>
          <span className="focus-progress__words">
            <span className="focus-progress__piece">{head}</span>{gap}
            {parts.map((part, index) => <React.Fragment key={part}>{index > 0 && ' '}<span className="focus-progress__piece">{part}</span></React.Fragment>)}
          </span>
        </Button>
      </Tooltip>
      {progress.weakScope?.length > 0 && <Button variant="link" wrap iconEnd="arrow-right" iconEndClassName="sh-icon--inline sh-icon--trail" lock={lock} onClick={() => start({ mode: 'path', scope: progress.weakScope })}>{ui('练还不会的重点')}</Button>}
      {emptyTopics.length > 0 && <Button variant="link" wrap iconEnd="arrow-right" iconEndClassName="sh-icon--inline sh-icon--trail" lock={lock} onClick={() => onGenerateFocus(emptyTopics, progress.course)}>{ui('去出缺题重点')}</Button>}
      {allMastered && (
        <span className="focus-progress__done" data-testid="focus-all-mastered">
          <Icon name="check" className="sh-icon--inline" />
          <span>{ui('全部已掌握')}</span>
        </span>
      )}
    </p>
  );
}
