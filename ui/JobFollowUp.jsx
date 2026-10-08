import React from 'react';
import { ui, uiFormat } from './i18n.js';
import { Button } from './components/index.js';
import { useInjectCss } from './shared.js';
import css from './job-follow.css';

/* A finished import's second step, under its card: make questions from the materials it saved. The same words as the toast of a finished document import
   (用它出题), for a PDF conversion and a transcription that ran in the background. The wrapper is always there, so the card is not remounted when
   the job ends; the link shows only once the job is complete and saved something. */
export default function JobFollowUp({ job, sourceIds, onGenerate, children }) {
  useInjectCss(css, 'study-job-follow');
  const ready = job?.status === 'complete' && sourceIds?.length > 0 && typeof onGenerate === 'function';
  return (
    <div className="job-follow">
      {children}
      {ready && <Button variant="link" size="sm" aria-label={uiFormat('用它出题：{0}', [job.filename || job.title || ''])} onClick={() => onGenerate(sourceIds)}>{ui('用它出题')}</Button>}
    </div>
  );
}
