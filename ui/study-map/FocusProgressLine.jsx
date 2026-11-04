import React from 'react';
import { ui, uiFormat } from '../i18n.js';
import { Button, Tooltip } from '../components/index.js';
import { summaryParts } from '../focus-progress-copy.js';

/** 重点 × 掌握度 on the home, under the course progress (lib/focus-progress.js): the counts of the course's focus topics in one line, whose press opens the course settings
    (the topics are listed there), and, when some focus questions are weak, a link that practises exactly those. How a topic is counted is a hover Tooltip. */
export default function FocusProgressLine({ progress, courseId, lock, start, onCourseSettings }) {
  if (!progress?.total) return null;
  return (
    <p className="focus-progress">
      <Tooltip layer content={ui('题目按主题、考点说明或题干里出现的重点词归入重点，一道题可以属于几条重点。有薄弱题的重点算「还不会」，掌握度 80% 以上又没有薄弱题的算「已掌握」，其余算「学习中」。')}>
        <Button variant="quiet" size="sm" wrap className="focus-progress__summary" onClick={() => onCourseSettings?.(courseId)}>
          {uiFormat('重点 {0} 条：{1}', [progress.total, summaryParts(progress).join(' · ')])}
        </Button>
      </Tooltip>
      {progress.weakScope?.length > 0 && <Button variant="link" lock={lock} onClick={() => start({ mode: 'path', scope: progress.weakScope })}>{ui('练还不会的重点 →')}</Button>}
    </p>
  );
}
