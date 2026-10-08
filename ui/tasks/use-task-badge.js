import { useEffect, useState } from 'react';
import { markSeenAt, readSeenAt } from './seen-tasks.js';
import { taskBadge } from './task-model.js';

/**
 * The count on the sidebar's 任务 entry: what is still running and what ended since the learner last had the console open ({ running, unseen, failed, total }).
 * While the 任务 page is showing, what ended is seen at once, so opening the console clears the news and a job that ends in front of the learner never becomes news.
 * `root` is the library (each has its own last visit).
 */
export function useTaskBadge({ root, data, viewing }) {
  const [seen, setSeen] = useState(() => ({ root, at: readSeenAt(root) }));
  const at = seen.root === root ? seen.at : readSeenAt(root);
  const badge = taskBadge(data, at);
  const pending = viewing && badge.unseen > 0;
  useEffect(() => {
    if (!pending) return;
    const now = Date.now();
    markSeenAt(root, now);
    setSeen({ root, at: now });
  }, [pending, root, badge.unseen]);
  // The page that is showing is where the news is read: it is not drawn as news on the way.
  return viewing ? { ...badge, unseen: 0, failed: 0, total: badge.running } : badge;
}
