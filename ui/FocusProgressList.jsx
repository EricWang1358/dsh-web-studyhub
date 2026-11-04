import React, { useState } from 'react';
import { ui } from './i18n.js';
import { Badge } from './components/index.js';
import { statusLabel, statusTone, topicCounts } from './focus-progress-copy.js';
import { useStudy } from './study-context.jsx';
import { useLiveEffect } from './use-async.js';

/** The saved focus topics of a course, each with its status and what it holds (read only; the chips above it are what the learner edits). */
export function FocusProgressRows({ progress }) {
  if (!progress?.topics?.length) return null;
  return (
    <ul className="focus-progress-list" aria-label={ui('重点掌握情况')}>
      {progress.topics.map((topic) => (
        <li key={topic.topic}>
          <span className="focus-progress-list__topic">{topic.topic}</span>
          {topic.cards > 0 && <Badge size="sm" tone={statusTone(topic.status)}>{statusLabel(topic.status)}</Badge>}
          <small className={topic.cards > 0 ? undefined : 'focus-progress-list__none'}>{topicCounts(topic)}</small>
        </li>
      ))}
    </ul>
  );
}

/** Reads the readout of `course` as saved (course.focusProgress; read again when the saved topics `saved` change) and draws it; nothing while it loads or when the read fails. */
export default function FocusProgressList({ course, saved }) {
  const { call } = useStudy();
  const [progress, setProgress] = useState(null);
  useLiveEffect((live) => {
    if (!course) return;
    Promise.resolve().then(() => call('course.focusProgress', { course })).then((value) => { if (live()) setProgress(value); }).catch(() => {});
  }, [call, course, saved?.join('')]);
  return <FocusProgressRows progress={progress} />;
}
