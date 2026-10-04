import { useCallback, useMemo, useRef, useState } from 'react';
import { languageSystem } from '../../lib/language.js';
import { ui, uiMessage, getUiLanguage } from '../i18n.js';
import { localizeRunResponse } from '../run-titles.js';
import { createActRunner } from '../act-runner.js';
import { useQuickActionsController } from '../quick-actions.js';
import { createToastApi } from '../components/Feedback.jsx';

/* What every other app hook leans on: the refs that fence late answers (library epoch, navigation request), the host call that
   honours them, the single-flight act(), the quick-action controller and the feedback slots. One place, so a hook never has
   to reach into another to learn whether an answer is still wanted. */
export function useAppCore(transportCall, host) {
  const epoch = useRef(0), navigation = useRef(0), requestSequence = useRef(0), notebookRequest = useRef(0);
  const dataRef = useRef(null), snapshotKey = useRef({}), leaveTimer = useRef(0), examLocation = useRef(null), bindingRoot = useRef('');
  const actRunner = useRef(null), actDeps = useRef(null), refreshRef = useRef(null), noticeRef = useRef(() => {}), hostRef = useRef(host);
  hostRef.current = host;
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const call = useCallback(async (action, args = {}) => {
    const started = epoch.current;
    let result;
    try { result = await transportCall(action, { ...args, uiLanguage: getUiLanguage() }); }
    catch (failure) { failure.message = uiMessage(failure.message); throw failure; }
    if (started !== epoch.current) throw new Error(ui('学习库已切换，请在当前学习库重试'));
    return localizeRunResponse(result);
  }, [transportCall]);
  const { controller: quick, api: quickApi, stamp: quickStamp } = useQuickActionsController(call);
  /* The notice slot is scoped to the page and run on screen, which are only known further down; notify() reaches it once they are. */
  const notify = useCallback((value) => noticeRef.current(value), []);
  const refresh = useCallback(() => refreshRef.current(), []);
  // One write at a time (ui/act-runner.js); the library refresh that follows never keeps busy on for long.
  actDeps.current = { call, refresh, epoch: () => epoch.current, navigation: () => navigation.current, setBusy, setError };
  actRunner.current ||= createActRunner(() => actDeps.current);
  const act = useCallback((action, args = {}, after, options) =>
    actRunner.current.act(action, args, after, { afterNavigation: action === 'restore', ...options }), []);
  const toast = useMemo(() => createToastApi({ setNotice: notify, setError }), [notify]);
  /* Hand a prompt to the conversation: into its input box when the host has one, else onto the clipboard, else on screen to copy. */
  const askInChat = useCallback(async (prompt) => {
    const text = prompt + languageSystem('', getUiLanguage());
    if (hostRef.current.askInChat?.(text)) { notify(ui('已填入对话输入框，确认后发送。')); return; }
    try {
      await navigator.clipboard.writeText(text);
      notify(ui('已复制提示词，粘贴到对话中即可。'));
    } catch {
      notify({ text, persistent: true });
    }
  }, [notify]);
  // One stable bag: hooks list it as a dependency and it must never change identity.
  const refs = useMemo(() => ({ epoch, navigation, requestSequence, notebookRequest, dataRef, snapshotKey, leaveTimer, examLocation, bindingRoot, actRunner, refreshRef, noticeRef }), []);
  return { refs,
    call, act, refresh, notify, toast, askInChat, error, setError, busy, setBusy, quick, quickApi, quickStamp };
}
