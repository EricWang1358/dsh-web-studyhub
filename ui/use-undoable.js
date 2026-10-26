import { useEffect, useMemo, useRef, useState } from 'react';
import { useToast } from './components/Feedback.jsx';
import { createUndoable, registerUndoable } from './undoable.js';

/* The page's handle on ui/undoable.js: re-renders when an item is hidden or comes back, and sends what is waiting when the page is
   hidden or closed (visibilitychange, pagehide), when the component goes away, and before the learner moves the library
   (ui/app/use-library-connection.js flushUndoable). A library that changed by itself abandons what was waiting (ui/app/library-state.js).
     const undoable = useUndoable();
     undoable.commitLater({ keys: [note.id], message: '已删除「…」', commit: () => call('note.delete', { id }) });
     list.filter((item) => !undoable.hidden(item.id));
     undoable.restoreWith({ message: '已归档「…」', restore: () => act('job.unarchive', ...) }); */
export function useUndoable() {
  const toast = useToast();
  const latest = useRef(toast);
  latest.current = toast;
  const [, setStamp] = useState(0);
  const unit = useMemo(() => createUndoable({ toast: () => latest.current, onChange: () => setStamp((count) => count + 1) }), []);
  useEffect(() => {
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
