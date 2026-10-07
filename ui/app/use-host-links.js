import { useEffect, useMemo, useRef } from 'react';
import { ui } from '../i18n.js';
import { activeNotice } from '../CourseActive.jsx';
import { useStudyReferenceHandoff } from '../daily-plan.js';
import { createUsageController } from '../usage/controller.js';
import { failureText } from '../failure.js';

/* What the host reaches the app through, apart from the snapshot: a run handed over from the conversation, a study reference from
   the board, the usage frequency record, and the 有效课程 switch that any page may flip. */
export function useHostLinks({ host, core, nav, session, learn, rootRef, data, loading }) {
  const { act, call, setError, notify } = core;
  const { navigate } = nav;
  const handoff = useRef(null);
  // A run handed over by the host (in the sidebar: 在右栏打开, 选段学习). The host waits for this to settle, so it rejects instead of being silent
  // when the run cannot be opened or another write holds act() (a dropped act() resolves with nothing).
  handoff.current = async (runId) => {
    let opened;
    try { opened = await act('review.get', { runId }, session.enterRun, { rethrow: true }); }
    catch (failure) { setError(failureText(failure)); throw failure; }
    if (!opened) throw new Error(ui('正在处理上一个操作，请稍后再点一次'));
  };
  const takeHandoff = host.takeHandoff;
  useEffect(() => takeHandoff?.((runId) => handoff.current?.(runId)), [takeHandoff]);
  useStudyReferenceHandoff(host.takeStudyReference, data?.root, (reference) => learn.openBoardReference(reference).catch((failure) => setError(failure.message)));

  /* The usage frequency record (Settings › Advanced; docs/usage-frequency.md). Off by default: the controller asks the host once and installs
     nothing, no listener and no timer, until the learner turns the record on. It lives outside React (ui/usage/*), so recording re-renders nothing. */
  const usageCall = useRef(null);
  useEffect(() => { usageCall.current = call; });
  useEffect(() => {
    const root = rootRef.current;
    if (loading || !root) return undefined;
    const controller = createUsageController({ root, call: (action, args) => usageCall.current(action, args) });
    void controller.refresh();
    return () => controller.dispose();
  }, [loading, rootRef]);

  // 有效课程: park or revive a course from any page (ui/CourseActive.jsx). One write at a time like every act(); the notice carries the real numbers.
  return useMemo(() => {
    const setActive = async (course, active, options = {}) => {
      const result = await act('course.setActive', { ...(course.id ? { id: course.id } : { name: course.name }), active, ...options }, undefined, { rethrow: true });
      if (!result) throw new Error(ui('正在处理上一个操作，请稍后再点一次'));
      const note = activeNotice(result);
      notify({ text: [note.text, note.detail].filter(Boolean).join(' '), tone: note.tone });
      return result;
    };
    return { courseActive: { setActive, activate: (course) => setActive(course, true), manage: () => navigate('settings') } };
  }, [act, notify, navigate]);
}
