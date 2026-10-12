/* The glossary of a review book, made by the PROGRAM (no call): every inventory item an explanation of the book covers, with its one-line gist, the knowledge
   point that explains it and the page it is taught on, in alphabetical order. The lookup page lists it, each entry linking to its point. Pure. */

const GLOSSARY_MAX = 4000;

/** @param leaves [{ id, body }] the notes' leaves; `inventory` the courseInventory; `titles` Map(doc key -> title). -> [{ id, name, kind, gist, leaf, material, page? }] */
export function buildGlossary(leaves, inventory, titles, language) {
  const byId = new Map((inventory?.items || []).map(item => [item.id, item])), seen = new Set(), entries = [];
  for (const leaf of leaves) for (const id of leaf.body?.coverage?.covered || []) {
    const item = byId.get(id);
    if (!item || seen.has(id)) continue;
    seen.add(id);
    const place = item.places.find(each => each.verified) ?? item.places[0];
    entries.push({ id, name: item.name, kind: item.kind, gist: item.gist, leaf: leaf.id, material: titles.get(place.doc) ?? '',
      ...(Number.isInteger(place.page) ? { page: place.page } : {}) });
  }
  const collator = new Intl.Collator(language === 'en' ? 'en' : 'zh-Hans-CN', { sensitivity: 'base', numeric: true });
  return entries.sort((a, b) => collator.compare(a.name, b.name) || (a.id < b.id ? -1 : 1)).slice(0, GLOSSARY_MAX);
}
