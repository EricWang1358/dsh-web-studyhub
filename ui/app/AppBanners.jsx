import React from 'react';
import { ui, uiFormat } from '../i18n.js';
import { Banner, Button } from '../components/index.js';
import { useAppSelector } from './app-context.js';
import { useStudyBusy } from '../study-context.jsx';
import { PracticeEndedBanner } from './PracticeReturnChip.jsx';

/* The messages that stay until their cause is gone, all as the one Banner (ui-consistency #87): a recording in progress,
   files the library could not read, and the stashed edit of this window. None of them is accent-coloured: cinnabar is for the
   one primary action of a page. */

/** 录题中: the conversation is adding questions to a deck; the learner can stop it from here. */
export function IngestBanner() {
  const ingest = useAppSelector((s) => s.data?.ingest);
  const core = useAppSelector((s) => s.core);
  const busy = useStudyBusy();
  if (!ingest) return null;
  const { deckTitle, added } = ingest;
  return (
    <Banner role="status" tone="info" title={ui('录题中')} className="app-banner"
      action={{ label: ui('停止录题'), disabled: busy, onClick: () => core.act('ingest.stop', {}, (result) => core.notify(uiFormat('已停止录题，本次录入 {0} 题。', [result.added]))) }}>
      <p>{uiFormat('题组「{0}」· 已录入 {1} 题', [deckTitle, added])}</p>
      <p className="app-banner__hint">{ui('在主会话里直接贴题目或截图即可')}</p>
    </Banner>
  );
}

/** Files the library could not read: everything else stays usable, saving waits until they are fixed. */
export function StorageIssuesBanner() {
  const storageIssues = useAppSelector((s) => s.data?.storageIssues);
  if (!storageIssues?.length) return null;
  return (
    <Banner tone="error" title={ui('这些文件读不出来，学习库的其他内容仍可查看。修好或移走它们之前不会保存新的改动，原文件保持原样。')} className="app-banner">
      <ul>{storageIssues.map((issue) => <li key={issue.file}>{issue.file}</li>)}</ul>
    </Banner>
  );
}

/** 有本窗口暂存的编辑: the draft this window kept after a reload; carry on with it or throw it away. */
export function RecoveryBanner() {
  const saved = useAppSelector((s) => s.lib?.recovery);
  const drafts = useAppSelector((s) => s.drafts);
  if (!saved) return null;
  return (
    <Banner tone="info" className="app-banner" action={{ label: ui('继续编辑'), iconEnd: 'arrow-right', onClick: () => drafts.restoreRecovery(saved) }}
      secondary={{ label: ui('丢弃暂存'), onClick: drafts.clearRecovery }}>
      {uiFormat('有本窗口暂存的编辑：{0}（尚未发布）', [saved.draft.title])}
    </Banner>
  );
}

/** Notice when returning to a question whose original run has already ended (Issue #1319). */
export function PracticeEndedNotice() {
  const learn = useAppSelector((s) => s.learn);
  if (!learn?.practiceEnded) return null;
  return (
    <PracticeEndedBanner
      ended={learn.practiceEnded}
      onPracticeAgain={learn.practiceEndedAgain}
      onDismiss={learn.dismissPracticeEnded}
    />
  );
}

/** The way back after following a link out of a page (the trail the learning navigation keeps). */
export function ContextReturn() {
  const page = useAppSelector((s) => s.nav?.page);
  const learn = useAppSelector((s) => s.learn);
  const busy = useStudyBusy();
  if (!learn.hasTrail || ['review', 'notes'].includes(page)) return null;
  if (['book', 'outline'].includes(page) && learn.trailPage === 'review') return null;
  if (learn.trailPage === 'review' && (learn.practiceStack?.length || 0) > 0) return null;
  return (
    <div className="context-return">
      <Button variant="link" size="sm" icon="arrow-left" lock={busy} onClick={learn.returnFromContext}>{learn.trailLabel}</Button>
    </div>
  );
}
