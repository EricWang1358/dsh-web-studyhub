import React from 'react';
import { ui, uiFormat } from '../i18n.js';
import { isTransientStudyError } from '../transport.js';
import { markInboxRead } from '../quick-actions.js';
import Inbox from '../Inbox.jsx';
import { Button, Icon } from '../components/index.js';
import { useApp } from './app-context.js';

/** The folder a learner recognises: the default library is a hidden folder inside its workspace. */
export function libraryFolderName(root) {
  const text = String(root || '');
  const parts = text.split(/[\\/]+/).filter(Boolean);
  const last = parts.at(-1) || text;
  return last === '.dsh-study' && parts.length > 1 ? parts.at(-2) : last;
}

/** Top-bar "学习库：<folder>" (P03): where the library lives, one click from Settings. */
export function LibraryChip({ root, onOpen }) {
  if (!root) return null;
  return (
    <Button variant="quiet" size="sm" className="library-chip" title={root} aria-label={uiFormat('学习库位置：{0}。打开设置可更改', [root])} onClick={onOpen}>
      <Icon name="folder" size={14} />
      <span>{uiFormat('学习库：{0}', [libraryFolderName(root)])}</span>
    </Button>
  );
}

function statusText({ busy, running, publishing, syncIssue, data }) {
  if (busy) return ui('正在保存…');
  if (running) return publishing ? ui('正在发布…') : ui('正在生成…');
  if (syncIssue) return isTransientStudyError({ message: syncIssue }) ? ui('连接中断，正在重试…') : ui('学习库读取失败');
  return data ? ui('已连接') : ui('待连接');
}

/** The top bar: the crumb for the page on screen, where the library lives, whether the host is working, and the mailbox. */
export default function AppTopbar({ title }) {
  const { data, core, nav, connection, inbox } = useApp();
  const { busy, act, quick, quickApi } = core;
  const { binding, running, publishing, syncIssue } = connection;
  const idle = !busy && !running && !syncIssue && data;
  return (
    <header className="topbar">
      <nav className="crumbs" aria-label={ui('位置')}>
        <span className="crumb">{ui('StudyHub')}</span>
        <span className="breadcrumb" aria-hidden="true"><Icon name="arrow-right" size={12} /></span>
        <span className="crumb current" aria-current="page">{title}</span>
      </nav>
      <div className="top-right">
        <LibraryChip root={binding.root} onOpen={() => nav.navigate('settings', { animate: true, keepTrail: false })} />
        <span className={'top-status' + (idle ? ' idle' : '')} role="status" title={syncIssue || undefined}>
          <i className={`dot ${busy || running ? 'busy' : data && !syncIssue ? 'on' : ''}`} aria-hidden="true" />
          <span className="top-status-label">{statusText({ busy, running, publishing, syncIssue, data })}</span>
        </span>
        {data && (
          <Inbox inbox={data.inbox} busy={busy} onOpen={inbox.openInboxItem} onReadAll={() => markInboxRead(quick)} readError={quickApi.failures['inbox:read']}
            onUndo={(letter) => act(letter.kind === 'rewrite' ? 'coach.revert' : 'card.revert', { deckId: letter.deckId, cardId: letter.cardId })} />
        )}
      </div>
    </header>
  );
}
