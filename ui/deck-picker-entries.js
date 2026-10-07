/* The deck list as Combobox entries (components/option-list.js): the one place that turns the library's decks into the grouped list every
   deck picker shows ("补充到现有题组", "放进哪个题组", "合并到题组"), so they cannot drift apart. The sibling of course-picker-entries.js.

   Decks are grouped by their course: `course`, else the legacy `folder`, else 「未分类」 (last). A chapter ("Course / 05 Chapter") is not a
   group of its own: its deck sits under the course and the chapter leads the item's hint. Groups: the course in focus first, then the
   most recently used, then by name (Chinese-aware); inside a group the most recently changed deck first. Archived and system decks are
   not offered. Pure: no React, no I/O. */
import { ui, uiFormat } from './i18n.js';
import { courseKnown, courseSegments } from '../lib/course-tree.js';

const squash = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
const fold = (value) => squash(value).normalize('NFKC').toLowerCase();
const collator = new Intl.Collator(['zh-Hans-CN', 'en'], { numeric: true, sensitivity: 'base' });
const time = (value) => Date.parse(value) || 0;

/** The course a deck is filed under, as written ('' for none). */
export const courseOfDeck = (deck) => squash(deck?.course ?? deck?.folder);

/** [root, chapter] of a course name: the top-level course and the rest of the path ('' when it is the course itself). */
function rootAndChapter(name, known) {
  const parts = courseSegments(name, known);
  return parts.length ? [parts[0], parts.slice(1).join(' / ')] : ['', ''];
}

/**
 * The decks a picker offers, ready for deckEntries: the listing (any list of decks, even the bare `bank.decks.list` one) completed with
 * what the library snapshot knows about them (`details`: course, folder, count, dates) and stamped with the focus (the course being
 * studied and when each course was last used), which is what orders the groups. `snapshot` is { decks, focus }; both are optional.
 */
export function deckChoices(listed = [], snapshot) {
  const { decks: details = [], focus } = snapshot || {};
  const byId = new Map(details.map((deck) => [deck.id, deck]));
  const names = [...(focus?.courses || []).map((course) => course?.name), ...details.map(courseOfDeck), ...listed.map(courseOfDeck)].filter(Boolean);
  const known = courseKnown(names);
  const usedByRoot = new Map();
  for (const course of focus?.courses || []) {
    if (!course?.lastUsedAt || !course.name) continue;
    const root = fold(rootAndChapter(course.name, known)[0]);
    if (time(course.lastUsedAt) > time(usedByRoot.get(root))) usedByRoot.set(root, course.lastUsedAt);
  }
  return listed.filter(Boolean).map((deck) => {
    const detail = byId.get(deck.id);
    const merged = { ...detail, ...deck };
    const count = [deck.count, detail?.count, deck.cards].find((value) => typeof value === 'number');
    const root = fold(rootAndChapter(courseOfDeck(merged), known)[0]);
    return { ...merged, count, focusCourse: focus?.course ?? '', courseUsedAt: usedByRoot.get(root) || '', courseNames: names };
  });
}

const hintOf = (deck, chapter, date) => {
  const count = typeof deck.count === 'number' ? uiFormat('{0} 题', [deck.count]) : '';
  return [chapter, count, date].filter(Boolean).join(' · ') || undefined;
};

/** The grouped entries of a deck picker: [{ group, indent, options: [{ value, label, hint, keywords, wrap }] }]. See the file comment. */
export function deckEntries(decks = []) {
  const offered = decks.filter((deck) => deck && !deck.archived && !deck.systemKind);
  if (!offered.length) return [];
  const known = courseKnown([...new Set(offered.flatMap((deck) => [...(deck.courseNames || []), courseOfDeck(deck)]))].filter(Boolean));
  const current = fold(rootAndChapter(offered.find((deck) => deck.focusCourse)?.focusCourse || '', known)[0]);
  const groups = new Map();
  offered.forEach((deck, index) => {
    const course = courseOfDeck(deck);
    const [root, chapter] = rootAndChapter(course, known);
    const key = fold(root);
    if (!groups.has(key)) groups.set(key, { key, label: root || ui('未分类'), uncategorised: !root, decks: [], used: 0 });
    const group = groups.get(key);
    const changed = Math.max(time(deck.updatedAt), time(deck.publishedAt), time(deck.createdAt));
    group.decks.push({ deck, index, chapter, course, changed });
    group.used = Math.max(group.used, changed, time(deck.courseUsedAt));
  });
  const order = [...groups.values()].sort((a, b) => (a.uncategorised - b.uncategorised) || ((b.key === current && !!current) - (a.key === current && !!current))
    || (b.used - a.used) || collator.compare(a.label, b.label));
  return order.map((group) => {
    group.decks.sort((a, b) => (b.changed - a.changed) || (a.index - b.index));
    // Two decks with one title in one group are told apart by the day they were made, so the list never shows twins.
    const titles = new Map();
    for (const { deck } of group.decks) titles.set(fold(deck.title), (titles.get(fold(deck.title)) || 0) + 1);
    return {
      group: group.label, indent: true,
      options: group.decks.map(({ deck, chapter, course }) => {
        const twin = titles.get(fold(deck.title)) > 1;
        const date = twin ? String(deck.createdAt || deck.publishedAt || '').slice(0, 10) : '';
        return { value: deck.id, label: squash(deck.title) || String(deck.id), hint: hintOf(deck, chapter, date), keywords: course ? [course] : [], wrap: true };
      }),
    };
  });
}
