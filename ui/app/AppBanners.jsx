import React from 'react';
import { ui, uiFormat } from '../i18n.js';
import { Banner, Button } from '../components/index.js';
import { useApp } from './app-context.js';

/* The messages that stay until their cause is gone, all as the one Banner (ui-consistency #87): a recording in progress,
   files the library could not read, and the stashed edit of this window. None of them is accent-coloured: cinnabar is for the
   one primary action of a page. */

/** 录题中: the conversation is adding questions to a deck; the learner can stop it from here. */
export function IngestBanner() {
  const { data, core } = useApp();
  if (!data?.ingest) return null;
  const { deckTitle, added } = data.ingest;
  return (
    <Banner role="status" tone="info" title={ui('录题中')} className="app-banner"
      action={{ label: ui('停止录题'), disabled: core.busy, onClick: () => core.act('ingest.stop', {}, (result) => core.notify(uiFormat('已停止录题，本次录入 {0} 题。', [result.added]))) }}>
      <p>{uiFormat('题组「{0}」· 已录入 {1} 题', [deckTitle, added])}</p>
      <p className="app-banner__hint">{ui('在对话里直接贴题目或截图即可')}</p>
    </Banner>
  );
}

/** Files the library could not read: everything else stays usable, saving waits until they are fixed. */
export function StorageIssuesBanner() {
  const { data } = useApp();
  if (!data?.storageIssues?.length) return null;
  return (
    <Banner tone="error" title={ui('部分文件无法读取，其他内容仍可查看。修复前暂停保存，原文件保留。')} className="app-banner">
      <ul>{data.storageIssues.map((issue) => <li key={issue.file}>{issue.file}</li>)}</ul>
    </Banner>
  );
}

/** 有本窗口暂存的编辑: the draft this window kept after a reload; carry on with it or throw it away. */
export function RecoveryBanner() {
  const { lib, drafts } = useApp();
  const saved = lib.recovery;
  if (!saved) return null;
  return (
    <Banner tone="info" className="app-banner" action={{ label: ui('继续编辑'), onClick: () => drafts.restoreRecovery(saved) }}
      secondary={{ label: ui('丢弃暂存'), onClick: drafts.clearRecovery }}>
      {uiFormat('有本窗口暂存的编辑：{0}（尚未发布）', [saved.draft.title])}
    </Banner>
  );
}

/** The way back after following a link out of a page (the trail the learning navigation keeps). */
export function ContextReturn() {
  const { nav, learn, core } = useApp();
  if (!learn.hasTrail || ['review', 'notes'].includes(nav.page)) return null;
  return (
    <div className="context-return">
      <Button variant="link" size="sm" icon="arrow-left" disabled={core.busy} onClick={learn.returnFromContext}>{learn.trailLabel}</Button>
    </div>
  );
}
