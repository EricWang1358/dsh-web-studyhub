import React from 'react';
import { ui, uiFormat, uiIsEnglish, uiMessage } from '../i18n.js';
import { isTransientStudyError } from '../transport.js';
import { markInboxRead } from '../quick-actions.js';
import Inbox from '../Inbox.jsx';
import { Button, Icon, Tooltip } from '../components/index.js';
import { useInjectCss } from '../shared.js';
import { useApp } from './app-context.js';
import css from './app-shell.css';

/** The folder a learner recognises: the default library is a hidden folder inside its workspace. */
export function libraryFolderName(root) {
  const text = String(root || '');
  const parts = text.split(/[\\/]+/).filter(Boolean);
  const last = parts.at(-1) || text;
  return last === '.dsh-study' && parts.length > 1 ? parts.at(-2) : last;
}

/** Settings › 学习库与模型, with the model card in focus: the one way there from the bar (the library chip, and the status while no model is set up). */
export function openLibrarySettings(settingsEntry, nav) {
  settingsEntry.setSettingsFocus('settings-model');
  nav.navigate('settings', { animate: true, keepTrail: false });
}

/** Top-bar "学习库：<folder>" (P03): where the library lives, one click from the folder control in Settings (学习库与模型). */
export function LibraryChip({ root, onOpen }) {
  if (!root) return null;
  return (
    <Button variant="quiet" size="sm" className="library-location" title={root} aria-label={uiFormat('学习库位置：{0}。打开设置可更改', [root])} onClick={onOpen}>
      <Icon name="folder" size={14} />
      <span>{uiFormat('学习库：{0}', [libraryFolderName(root)])}</span>
    </Button>
  );
}

/** Is the failing read one that retries by itself (the host is not up yet)? The poll says so by the error's code (`syncTransient`); a caller that only has the text falls back on its words. */
const isTransient = ({ syncIssue, syncTransient }) => (syncTransient ?? isTransientStudyError({ message: syncIssue }));

const HAN = /[㐀-鿿]/;

export function statusText({ busy, running, publishing, syncIssue, syncTransient, data, noModel }) {
  if (busy) return ui('正在处理…');
  if (running) return publishing ? ui('正在发布…') : ui('后台处理中');
  if (syncIssue) return isTransient({ syncIssue, syncTransient }) ? ui('重新连接中…') : ui('读不出学习库');
  return data ? noModel ? ui('还没配模型') : ui('已连接') : ui('没有连上学习库');
}

/** The words of a short label that cannot say it all, for the Tooltip (hover or keyboard focus): what kinds of task run, or the whole sentence of a failing read
    with DSH's own error after it, in the page's language (uiMessage; an English page drops a Chinese error that has no English line). A sentence that asks for a
    click is never added: the clickable state (no model) says its action in its own accessible name. The steady states and 正在处理… have none. */
export function statusHint({ busy, running, publishing, syncIssue, syncTransient }) {
  if (busy || (running && publishing)) return undefined;
  if (running) return ui('有后台任务在进行（转换、转写、出题等）');
  if (!syncIssue) return undefined;
  if (isTransient({ syncIssue, syncTransient })) return ui('连接中断，正在重试…');
  const reason = uiMessage(syncIssue);
  return uiIsEnglish() && HAN.test(reason) ? ui('学习库读不出来，正在重试') : uiFormat('学习库读不出来，正在重试：{0}', [reason]);
}

/** The top bar: the crumb for the page on screen, where the library lives, whether the host is working, and the mailbox. */
export default function AppTopbar({ title }) {
  useInjectCss(css, 'study-app-shell');
  const { data, core, nav, connection, inbox, settingsEntry } = useApp();
  const { busy, act, quick, quickApi } = core;
  const { binding, running, publishing, syncIssue, syncTransient } = connection;
  const labelId = React.useId();
  // 已连接 is about the library (the chip beside it names the folder); with no model to run the questions the bar says so (and keeps its words in a narrow pane: it is not the steady state).
  const noModel = !!data && (data.model ? data.model.ready === false : data.modelReady === false);
  const hint = statusHint({ busy, running, publishing, syncIssue, syncTransient });
  const idle = !busy && !running && !syncIssue && data && !noModel;
  // With no model the words are the way to Settings › 学习库与模型 (the library chip's way): the whole area becomes one button that
  // looks exactly like the words it replaced, so the bar does not move. A failing read or a running action keeps its own words and is not a button.
  const fixModel = noModel && !busy && !running && !syncIssue;
  const words = statusText({ busy, running, publishing, syncIssue, syncTransient, data, noModel });
  const openLibrary = () => openLibrarySettings(settingsEntry, nav);
  const dot = <i className={`dot ${busy || running ? 'busy' : data && !syncIssue && !noModel ? 'is-online' : ''}`} aria-hidden="true" />;
  const label = <span className="top-status-label" id={labelId}>{words}</span>;
  return (
    <header className="topbar">
      <nav className="crumbs" aria-label={ui('位置')}>
        <span className="crumb">{ui('StudyHub')}</span>
        <span className="breadcrumb" aria-hidden="true"><Icon name="arrow-right" size={12} /></span>
        <span className="crumb" aria-current="page">{title}</span>
      </nav>
      <div className="top-right">
        <LibraryChip root={binding.root} onOpen={openLibrary} />
        <Tooltip layer content={hint} anchorClassName={'top-status-anchor' + (idle ? ' is-idle' : '')}>
          <span className={'top-status' + (idle ? ' idle' : '')} role="status" tabIndex={hint ? 0 : undefined} aria-labelledby={hint ? labelId : undefined}>
            {fixModel
              ? <Button variant="quiet" size="sm" className="top-status__fix" aria-label={uiFormat('{0}。打开「学习库与模型」设置', [words])} onClick={openLibrary}>{dot}{label}</Button>
              : <>{dot}{label}</>}
          </span>
        </Tooltip>
        {data && (
          <Inbox inbox={data.inbox} onOpen={inbox.openInboxItem} onReadAll={() => markInboxRead(quick)} readError={quickApi.failures['inbox:read']}
            onOpenTasks={() => nav.navigate('tasks', { animate: true, keepTrail: false })}
            onUndo={(letter) => act(letter.kind === 'rewrite' ? 'coach.revert' : 'card.revert', { deckId: letter.deckId, cardId: letter.cardId })} />
        )}
      </div>
    </header>
  );
}
