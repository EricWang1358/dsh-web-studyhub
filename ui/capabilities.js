import { pageNeeds } from './pages.js';

// Older hosts and the offline demo do not publish a capability list.
export function hasContext(data, id) {
  return !Array.isArray(data?.contexts) || data.contexts.includes(id);
}
/** Is the page usable here? What a page needs is its row in ui/pages.js. */
export function pageAvailable(data, page) {
  return pageNeeds(page).every(id => hasContext(data, id));
}
