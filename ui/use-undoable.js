import { useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useToast } from './components/Feedback.jsx';
import { AppContext } from './app/app-context.js';
import { createUndoable, registerUndoable, startedByKeyboard, trackInput } from './undoable.js';

/* The page's handle on ui/undoable.js: re-renders when an item is hidden or comes back, and sends what is waiting when the page is
   hidden or closed (visibilitychange, pagehide), when the component goes away, and before the learner moves the library
   (ui/app/use-library-connection.js flushUndoable). A library that changed by itself abandons what was waiting (App → ui/app/library-state.js).
   An entry remembers the library it was made in (the app's binding root) and is never sent to another one. The notice of a deletion started from the
   keyboard waits for the learner (ui/undoable.js trackInput). Sending on pagehide is best effort: the request is an ordinary call, and when the browser cuts
   it off the item is simply still there next time (never half deleted).
     const undoable = useUndoable();
     undoable.commitLater({ keys: [note.id], message: '已删除「…」', commit: () => call('note.delete', { id }) });
     list.filter((item) => !undoable.hidden(item.id));
     undoable.restoreWith({ message: '已归档「…」', restore: () => act('job.unarchive', ...) }); */
export function useUndoable() {
  const toast = useToast();
  const app = useContext(AppContext);
  const latest = useRef(toast), root = useRef('');
  latest.current = toast;
  root.current = app?.connection?.binding?.root ?? app?.data?.root ?? '';
  const [, setStamp] = useState(0);
  const unit = useMemo(() => createUndoable({ toast: () => latest.current, onChange: () => setStamp((count) => count + 1),
    keyboard: startedByKeyboard, scope: () => root.current }), []);
  useEffect(() => {
    trackInput(document);
    const hidden = () => { if (document.visibilityState === 'hidden') void unit.flush(); };
    const gone = () => { void unit.flush(); };
    document.addEventListener('visibilitychange', hidden);
    window.addEventListener('pagehide', gone);
    const unregister = registerUndoable(unit);
    return () => {
      document.removeEventListener('visibilitychange', hidden);
      window.removeEventListener('pagehide', gone);
      unregister();
      void unit.flush();
    };
  }, [unit]);
  return unit;
}
