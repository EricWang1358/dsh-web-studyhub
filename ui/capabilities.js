import { pageFlag, pageNeeds } from './pages.js';

// Older hosts and the offline demo do not publish a capability list.
export function hasContext(data, id) {
  return !Array.isArray(data?.contexts) || data.contexts.includes(id);
}
/** Is the page usable here? What a page needs is its row in ui/pages.js; a page behind a host switch (default off) also needs the snapshot to say it is on. */
export function pageAvailable(data, page) {
  const flag = pageFlag(page);
  if (flag && data?.features?.[flag] !== true) return false;
  return pageNeeds(page).every(id => hasContext(data, id));
}
