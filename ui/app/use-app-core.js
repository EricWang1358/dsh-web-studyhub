import { useCallback, useMemo, useRef, useState } from 'react';
import { ui, uiMessage, getUiLanguage } from '../i18n.js';
import { localizeRunResponse } from '../run-titles.js';
import { createActRunner } from '../act-runner.js';
import { useQuickActionsController } from '../quick-actions.js';
import { createToastApi } from '../components/Feedback.jsx';
import { deliverToChat } from '../hand-off/use-hand-off.js';

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
  /* 「发给主会话」: the one writer of the main chat's input box and its one set of receipts (ui/hand-off/use-hand-off.js deliverToChat). Never sends;
     never over the learner's own words. askInChat(prompt, { said }) -> 'filled' | 'kept' | 'copied' | 'shown'. The full-text card it may open
     (ui/hand-off/HandOffSheet.jsx) is `handOffSheet`, drawn by App; closeHandOffSheet() forgets it. */
  const [handOffSheet, setHandOffSheet] = useState(null);
  const closeHandOffSheet = useCallback(() => setHandOffSheet(null), []);
  const askInChat = useCallback((prompt, { said = '' } = {}) => deliverToChat({ host: hostRef.current, prompt, said, notify, openSheet: setHandOffSheet }), [notify]);
  // One stable bag: hooks list it as a dependency and it must never change identity.
  const refs = useMemo(() => ({ epoch, navigation, requestSequence, notebookRequest, dataRef, snapshotKey, leaveTimer, examLocation, bindingRoot, actRunner, refreshRef, noticeRef }), []);
  return { refs,
    call, act, refresh, notify, toast, askInChat, handOffSheet, closeHandOffSheet, error, setError, busy, setBusy, quick, quickApi, quickStamp };
}
