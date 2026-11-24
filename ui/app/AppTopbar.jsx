import React from 'react';
import { ui, uiFormat, uiIsEnglish, uiMessage } from '../i18n.js';
import { isTransientStudyError } from '../transport.js';
import { markInboxRead, markInboxUnread } from '../quick-actions.js';
import Inbox from '../Inbox.jsx';
import DeskAtelierButton from '../desk-atelier/DeskAtelierButton.jsx';
import { Button, Icon, IconBox, Tooltip } from '../components/index.js';
import { useInjectCss } from '../shared.js';
import { useAppSelector } from './app-context.js';
import { useStudyBusy } from '../study-context.jsx';
import { useNavAlert } from './use-nav-alert.js';
import { hostPart } from '../host-parts.js';
import { modelReadiness } from '../generation-status.js';
import { PracticeReturnChip } from './PracticeReturnChip.jsx';
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
      <Icon className="sh-icon--inline" name="folder" />
      <span>{uiFormat('学习库：{0}', [libraryFolderName(root)])}</span>
    </Button>
  );
}

/** Top-bar "模型：<label>": the model every question, explanation and grading goes to, so nobody spends on one by accident. It looks and shrinks like the library chip
    (the narrow-pane rules are one set) and opens the same place; the full words are the Tooltip's, with the host's own sentence on how the model is paid for. */
export function ModelChip({ label, note, onOpen }) {
  if (!label) return null;
  const words = [ui('出题、讲解和批改都会调用这个模型。'), note].filter(Boolean).join(uiIsEnglish() ? ' ' : '');
  return (
    <Tooltip layer content={words} anchorClassName="model-in-use-anchor">
      <Button variant="quiet" size="sm" className="library-location model-in-use" data-tour="topbar-model" aria-label={uiFormat('当前模型：{0}。打开设置可更换', [label])} onClick={onOpen}>
        <Icon className="sh-icon--inline" name="model" />
        <span>{uiFormat('模型：{0}', [label])}</span>
      </Button>
    </Tooltip>
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
  if (running) return hostPart('runningNote')?.() || ui('有后台任务在进行（转换、转写、出题等）');
  if (!syncIssue) return undefined;
  if (isTransient({ syncIssue, syncTransient })) return ui('连接中断，正在重试…');
  const reason = uiMessage(syncIssue);
  return uiIsEnglish() && HAN.test(reason) ? ui('学习库读不出来，正在重试') : uiFormat('学习库读不出来，正在重试：{0}', [reason]);
}

/** The way to the sidebar while it is a drawer (#657: a narrow window, or the learner put it away): one button at the start of the bar. It carries
    the sidebar's attention dot (ui/nav-alert.js) and says its reason; the drawer itself has every label. */
function NavMenuButton() {
  const shell = useAppSelector((s) => s.shell);
  const { reason } = useNavAlert();
  return (
    <Tooltip layer content={reason || ui('打开导航：全部功能都在这里')} anchorClassName="nav-menu-anchor">
      <Button variant="quiet" size="sm" className={'nav-menu-toggle' + (reason ? ' has-alert' : '')} data-tour="nav-menu" data-usage="nav.menu"
        aria-label={ui('打开导航')} aria-haspopup="dialog" aria-expanded={shell.navOpen} onClick={() => shell.setNavOpen(true)}>
        <IconBox className={reason ? 'nav-dot-icon' : undefined}><Icon name="panel" size={18} />{reason && <span className="nav-dot" />}</IconBox>
      </Button>
    </Tooltip>
  );
}

/** Leaf status indicator subscribing to `busy` alone so AppTopbar does not re-render on every single-flight RPC. */
function TopbarStatus({ data, core, running, publishing, syncIssue, syncTransient, onOpenLibrary }) {
  const busy = useStudyBusy() || !!core?.busy;
  const labelId = React.useId();
  // 已连接 is about the library (the chip beside it names the folder); with no model to run the questions the bar says so (and keeps its words in a narrow pane: it is not the steady state).
  const noModel = !!data && (data.model ? data.model.ready === false : data.modelReady === false);
  const hint = statusHint({ busy, running, publishing, syncIssue, syncTransient });
  const idle = !busy && !running && !syncIssue && data && !noModel;
  // With no model the words are the way to Settings › 学习库与模型 (the library chip's way): the whole area becomes one button that
  // looks exactly like the words it replaced, so the bar does not move. A failing read or a running action keeps its own words and is not a button.
  const fixModel = noModel && !busy && !running && !syncIssue;
  const words = statusText({ busy, running, publishing, syncIssue, syncTransient, data, noModel });
  const dot = <i className={`dot ${busy || running ? 'busy' : data && !syncIssue && !noModel ? 'is-online' : ''}`} aria-hidden="true" />;
  const label = <span className="top-status-label" id={labelId}>{words}</span>;
  return (
    <Tooltip layer content={hint} anchorClassName={'top-status-anchor' + (idle ? ' is-idle' : '')}>
      <span className={'top-status' + (idle ? ' idle' : '')} role="status" tabIndex={hint ? 0 : undefined} aria-labelledby={hint ? labelId : undefined}>
        {fixModel
          ? <Button variant="quiet" size="sm" className="top-status__fix" aria-label={uiFormat('{0}。打开「学习库与模型」设置', [words])} onClick={onOpenLibrary}>{dot}{label}</Button>
          : <>{dot}{label}</>}
      </span>
    </Tooltip>
  );
}

/** The top bar: the crumb for the page on screen, where the library lives, whether the host is working, and the mailbox. */
const AppTopbar = React.memo(function AppTopbar({ title }) {
  useInjectCss(css, 'study-app-shell');
  const data = useAppSelector((s) => s.data);
  const core = useAppSelector((s) => s.core);
  const nav = useAppSelector((s) => s.nav);
  const connection = useAppSelector((s) => s.connection);
  const inbox = useAppSelector((s) => s.inbox);
  const settingsEntry = useAppSelector((s) => s.settingsEntry);
  const shell = useAppSelector((s) => s.shell);
  const learn = useAppSelector((s) => s.learn);
  const session = useAppSelector((s) => s.session);
  const modal = useAppSelector((s) => s.lib?.modal);
  const { act, quick, quickApi } = core;
  const { binding, running, publishing, syncIssue, syncTransient } = connection;
  const model = modelReadiness(data);
  const openLibrary = React.useCallback(() => openLibrarySettings(settingsEntry, nav), [settingsEntry, nav]);
  return (
    <header className="topbar">
      {shell?.navDrawer && <NavMenuButton />}
      <nav className="crumbs" aria-label={ui('位置')}>
        <span className="crumb">{ui('StudyHub')}</span>
        <span className="breadcrumb" aria-hidden="true"><Icon className="sh-icon--inline" name="chevron" /></span>
        <span className="crumb" aria-current="page">{title}</span>
      </nav>
      {learn && (
        <PracticeReturnChip
          stack={learn.practiceStack}
          page={nav?.page}
          run={session?.run}
          modal={modal}
          lastPractice={learn.lastPractice}
          onRestore={learn.returnFromPracticeStack}
          onPracticeResume={learn.resumeLastPractice}
        />
      )}
      <div className="top-right">
        <LibraryChip root={binding.root} onOpen={openLibrary} />
        <ModelChip label={model.ready ? model.label : ''} note={hostPart('modelCostNote')?.(binding)} onOpen={openLibrary} />
        <TopbarStatus data={data} core={core} running={running} publishing={publishing} syncIssue={syncIssue} syncTransient={syncTransient} onOpenLibrary={openLibrary} />
        {data && (
          <Inbox inbox={data.inbox} onOpen={inbox.openInboxItem} onReadAll={() => markInboxRead(quick)}
            onToggleRead={(letter) => (letter.read ? markInboxUnread(quick, { ids: [letter.id] }) : markInboxRead(quick, { ids: [letter.id] }))}
            readError={quickApi.failures['inbox:read'] || Object.entries(quickApi.failures).find(([key]) => key.startsWith('inbox:read:') || key.startsWith('inbox:unread:'))?.[1] || ''}
            onOpenTasks={() => nav.navigate('tasks', { animate: true, keepTrail: false })}
            onUndo={(letter) => act(letter.kind === 'rewrite' ? 'coach.revert' : 'card.revert', { deckId: letter.deckId, cardId: letter.cardId })} />
        )}
        <DeskAtelierButton />
      </div>
    </header>
  );
});

export default AppTopbar;
