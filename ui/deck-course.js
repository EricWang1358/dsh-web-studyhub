/* The course a deck belongs to, in the one order every reader must agree on: `course` first, the older `folder` only when there is
   no `course` at all. A deck row always carries `folder` (an empty string when it has none), so reading `folder` first would answer ""
   for every deck that only has a course - the page would then offer "save" on an empty box and move the deck out of its course (#1328). */
export const deckCourseOf = (deck) => deck?.course ?? deck?.folder ?? '';
