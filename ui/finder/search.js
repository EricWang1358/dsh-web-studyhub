/* 找功能: the search over the finder's entries (ui/finder/entries.js). Pure: no DOM, no state.

   The query and every text it is compared with are normalised the same way (case, full-width letters, spaces and punctuation), so 「Translate」,
   「ｔｒａｎｓｌａｔｅ」 and 「translate!」 are one word and 「花费 上限」 is 「花费上限」. An entry is compared on its Chinese source AND on its English
   rendering (`translate` is ui() in the English interface), so someone who reads English types English.

   Ranking, best first (an entry is ranked by the best way it matches; ties keep the order of the index):
     0 the title is the query      1 the title starts with it      2 an alias is the query      3 the title contains it
     4 an alias contains it        5 the path contains it          6 the sentence contains it */

const STRIP = /[\s\p{P}+=<>|~^$`]/gu;

/** The comparison form of a word or a query: NFKC (full-width to half-width), lower case, no spaces or punctuation. */
export const normalizeQuery = (text) => String(text ?? '').normalize('NFKC').toLowerCase().replace(STRIP, '');

const forms = (text, translate) => [...new Set([normalizeQuery(text), normalizeQuery(translate(text))])].filter(Boolean);

/** How well one entry matches a normalised query: a rank (0 is best), or -1 for no match. */
function rankOf(entry, query, translate) {
  const titles = forms(entry.title, translate);
  if (titles.includes(query)) return 0;
  if (titles.some((title) => title.startsWith(query))) return 1;
  const aliases = (entry.aliases || []).map(normalizeQuery).filter(Boolean);
  if (aliases.includes(query)) return 2;
  if (titles.some((title) => title.includes(query))) return 3;
  if (aliases.some((alias) => alias.includes(query))) return 4;
  const path = (entry.path || []).flatMap((crumb) => forms(crumb, translate));
  if (path.some((crumb) => crumb.includes(query))) return 5;
  if (forms(entry.what, translate).some((sentence) => sentence.includes(query))) return 6;
  return -1;
}

/** The entries that match `query`, best first; an empty query is every entry, in the order of the index. `translate` renders a source string in the interface language (ui). */
export function searchFeatures(entries, query, { translate = (text) => text } = {}) {
  const wanted = normalizeQuery(query);
  if (!wanted) return [...entries];
  return entries.map((entry, order) => ({ entry, order, rank: rankOf(entry, wanted, translate) })).filter((item) => item.rank >= 0)
    .sort((a, b) => a.rank - b.rank || a.order - b.order).map((item) => item.entry);
}

/** The entries under their areas, in the order of `areas`; an area with none of them is left out. */
export function groupByArea(entries, areas) {
  return areas.map((area) => ({ area, entries: entries.filter((entry) => entry.area === area.id) })).filter((group) => group.entries.length > 0);
}
