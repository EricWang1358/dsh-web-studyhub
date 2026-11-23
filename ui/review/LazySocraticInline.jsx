/* Lightweight on-demand loader for SocraticInlineDrawer.jsx so the Socratic drawer,
   its stylesheet, and transcript formatter stay out of the workspace first-load closure
   until the learner actually opens inline Socratic tutoring (#1316). */
import React from 'react';
import { ui } from '../i18n.js';
import { Button, LoadingState } from '../components/index.js';

let cachedDrawer = null;

/** Local drawer open/dismiss/P2-confirm state for inline Socratic tutoring inside QuestionRun (#1316). */
export function useSocraticInlineState({ run, closeAssist, reviewBodyRef }) {
  const [open, setOpen] = React.useState(false);
  const [dismissedKey, setDismissedKey] = React.useState('');
  const [confirmedRunId, setConfirmedRunId] = React.useState('');
  const allowed = run?.mode !== 'exam' && !run?.complete && Boolean(run?.card?.id);
  const modelConfirmed = Boolean(run?.id && confirmedRunId === run.id);
  const cardAnswered = Boolean(run?.feedback);
  const retryQueued = Boolean(
    run?.feedback && run?.mode !== 'exam'
    && (run.feedback.correct === false || (Number.isInteger(run.feedback.grade) && run.feedback.grade <= 1)),
  );
  const saveModelConfirm = React.useCallback(() => {
    if (run?.id) setConfirmedRunId(run.id);
  }, [run?.id]);
  const toggle = React.useCallback(() => {
    if (run?.mode === 'exam' || run?.complete) return;
    setOpen((prev) => !prev);
  }, [run?.mode, run?.complete]);
  const activate = React.useCallback(() => {
    if (run?.mode === 'exam' || run?.complete) return;
    closeAssist?.();
    setOpen(true);
  }, [closeAssist, run?.mode, run?.complete]);
  const close = React.useCallback(() => setOpen(false), []);
  const returnToQuestion = React.useCallback(() => {
    setOpen(false);
    requestAnimationFrame(() => reviewBodyRef?.current?.querySelector?.('.question-card')?.focus?.({ preventScroll: true }));
  }, [reviewBodyRef]);
  return {
    open: open && allowed,
    allowed,
    dismissedKey,
    setDismissedKey,
    modelConfirmed,
    saveModelConfirm,
    cardAnswered,
    retryQueued,
    toggle,
    activate,
    close,
    returnToQuestion,
  };
}

/** One-line optional nudge shown after a wrong answer (never auto-opens the drawer). */
export function SocraticWrongNudge({ show, entryKey, dismissedKey, onToggleSocratic, onDismiss }) {
  if (!show || dismissedKey === entryKey) return null;
  return (
    <div className="socratic-nudge" data-testid="socratic-wrong-nudge" role="status">
      <span className="socratic-nudge__text">{ui('要我用提问的方式带你想清楚吗？')}</span>
      <span className="socratic-nudge__actions">
        <Button variant="quiet" size="sm" onClick={onToggleSocratic}>{ui('苏格拉底带学')}</Button>
        <Button variant="quiet" size="sm" aria-label={ui('关闭带学提示')} onClick={() => onDismiss(entryKey)}>{ui('不用')}</Button>
      </span>
    </div>
  );
}

export default function LazySocraticInlineDrawer(props) {
  const [Drawer, setDrawer] = React.useState(() => cachedDrawer);

  React.useEffect(() => {
    if (Drawer) return undefined;
    let cancelled = false;
    import('./SocraticInlineDrawer.jsx')
      .then((mod) => {
        const Comp = mod?.default || null;
        if (!Comp) return;
        cachedDrawer = Comp;
        if (!cancelled) setDrawer(() => Comp);
      })
      .catch(() => { /* Keep QuestionRun uninterrupted if chunk load fails. */ });
    return () => { cancelled = true; };
  }, [Drawer]);

  if (!Drawer) {
    return (
      <aside className="socratic-inline-drawer" aria-label={ui('苏格拉底带学')}>
        <LoadingState label={ui('正在载入带学进度…')} />
      </aside>
    );
  }
  return <Drawer {...props} />;
}
