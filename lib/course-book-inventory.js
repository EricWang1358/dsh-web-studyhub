import { createHash } from 'node:crypto';
import { COURSE_INVENTORY_PROVENANCE, isCourseInventorySource } from './exam-point-list.js';

/* 资料清点 (the inventory of a course's materials): what every page range of every material teaches, listed by the model and checked by the program. It is
   the ground of 总纲 and 复习全书 coverage: a knowledge point is a group of these items, and a book is complete when every item of its points is explained.

   A special source record like the 总纲 (`provenance: 'course-outline-inventory'`, the structured `courseInventory`): machine-owned, hidden from every list,
   never evidence (lib/exam-point-list.js isLibraryListSource, assertMaterials). A new 清点 replaces the old one (removed, not archived: it is a cache).
     ranges     [{ key, doc, print, status: 'read' | 'failed', chars, from?, to? }] every page range read (whole pages of at most ~15,000 characters), keyed by
                `print` (its text and the language): an unchanged range is never asked again.
     items      [{ id, kind, name, gist, key?, places: [{ range, doc, sourceId, start, end, page?, quote, verified }] }] near-duplicates merged (one id per
                name across ranges and versions of a document); a quote not found word for word in the range is kept with `verified: false`.
     documents  [{ key, title, pages, ranges, read (ranges), pagesRead, reason? ('no-text' | 'paper') }] per material: its pages and ranges, how many were read, or why none.
     cache      { clusters: [{ key, answer }], order: { key, answer } | null } the 总纲's grouping answers, reused while their items are the same.
   Pure; nothing here calls a model. */

export const COURSE_INVENTORY_VERSION = 1;
export const INVENTORY_KINDS = Object.freeze(['term', 'definition', 'concept', 'formula', 'step', 'rule', 'example', 'claim', 'warning']);
export const INVENTORY_LIMITS = Object.freeze({ items: 8000, places: 8, nameChars: 80, gistChars: 200, quoteChars: 240, ranges: 4000, documents: 2000, clusters: 400 });
const PRINT = /^[0-9a-f]{16}$/;

const sha = value => createHash('sha1').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
export const short16 = value => sha(value).slice(0, 16);
const line = (value, max) => { const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : ''; return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text; };
const whole = value => Number.isInteger(value) && value >= 0;
const fail = message => { throw new Error(message); };

const CJK = /[㐀-鿿豈-﫿]/;
const TRAILING_GLOSS = /^(.*?)\s*[(（]([^()（）]+)[)）]\s*$/;
/** A name without its trailing TRANSLATION gloss: "威胁建模（threat modelling）" -> "威胁建模", "Threat modelling (威胁建模)" -> "Threat modelling". A gloss in the
    same script is part of the name ("Mean (average)" and "Mean (expected value)" are two things), and so is any bracket inside it ("P(A|B)", "O(n log n)"). */
export function bareName(name) {
  const text = String(name ?? '').normalize('NFKC').trim(), found = TRAILING_GLOSS.exec(text);
  return found && found[1].trim() && CJK.test(found[1]) !== CJK.test(found[2]) ? found[1].trim() : text;
}
/** The kinds that name the same sort of thing (a term, its definition and the concept are one item); every other kind is its own. */
const KIND_CLASS = Object.freeze({ term: 'concept', definition: 'concept', concept: 'concept' });
/**
 * The key two items of one thing share: their kind (term, definition and concept as one) and their name without a trailing translation gloss, NFKC, lower
 * case, without spaces, hyphens, underscores and trailing punctuation. A formula keeps every symbol and bracket; so does any other name ("E[X]" is not "E(X)").
 */
export function nameKey(name, kind = 'concept') {
  const bare = bareName(name).toLowerCase();
  const own = kind === 'formula' ? bare.replace(/\s+/g, '') : bare.replace(/[\s\-_·•‧]+/g, '').replace(/[.:：;；,，。、]+$/u, '');
  return `${KIND_CLASS[kind] ?? kind}:${own || bare}`;
}
/** The stable id of an item: its key. */
export const itemId = (name, kind) => `i${sha(['item', nameKey(name, kind)]).slice(0, 11)}`;
/** The forms of a name a text may use: the whole name, the name without any bracketed gloss (also one inside it: "TCP（传输控制协议）三次握手" -> "TCP三次握手"),
    and each gloss of the other script alone (a bilingual book may use the Chinese name or the English one). */
export function nameForms(name) {
  const text = String(name ?? '').normalize('NFKC').trim(), forms = new Set([text]);
  const stripped = text.replace(/\s*[(（][^()（）]*[)）]\s*/g, ' ').trim();
  if (stripped) forms.add(stripped);
  for (const [, inner] of text.matchAll(/[(（]([^()（）]+)[)）]/g)) if (CJK.test(inner) !== CJK.test(stripped)) forms.add(inner.trim());
  return [...forms].filter(Boolean);
}

function normalizePlace(raw) {
  const range = line(raw?.range, 300), doc = line(raw?.doc, 300), sourceId = line(raw?.sourceId, 200);
  if (!range || !doc || !sourceId || !whole(raw.start) || !whole(raw.end) || raw.end < raw.start) return null;
  return { range, doc, sourceId, start: raw.start, end: raw.end, ...(whole(raw.page) ? { page: raw.page } : {}), quote: line(raw.quote, INVENTORY_LIMITS.quoteChars),
    verified: raw.verified === true };
}

function normalizeItem(raw) {
  const name = line(raw?.name, INVENTORY_LIMITS.nameChars);
  if (!name) return null;
  const places = (Array.isArray(raw.places) ? raw.places : []).map(normalizePlace).filter(Boolean).slice(0, INVENTORY_LIMITS.places);
  if (!places.length) return null;
  return { id: typeof raw.id === 'string' && /^i[0-9a-f]{11}$/.test(raw.id) ? raw.id : itemId(name, raw.kind), kind: INVENTORY_KINDS.includes(raw.kind) ? raw.kind : 'concept', name,
    gist: line(raw.gist, INVENTORY_LIMITS.gistChars), ...(raw.key === true ? { key: true } : {}), places };
}

/** Check and shape the inventory. Throws a plain Error naming the first problem. */
export function normalizeInventory(input) {
  if (!input || typeof input !== 'object' || typeof input.course !== 'string') fail('An inventory names its course');
  const ranges = (Array.isArray(input.ranges) ? input.ranges : []).slice(0, INVENTORY_LIMITS.ranges).map(raw => {
    if (!line(raw?.key, 300) || !line(raw?.doc, 300) || !PRINT.test(String(raw?.print))) fail('A range of the inventory needs a key, its document and its print');
    return { key: line(raw.key, 300), doc: line(raw.doc, 300), print: raw.print, status: raw.status === 'read' ? 'read' : 'failed', chars: whole(raw.chars) ? raw.chars : 0,
      ...(whole(raw.from) && whole(raw.to) ? { from: raw.from, to: raw.to } : {}) };
  });
  const ids = new Set(), items = [];
  for (const raw of Array.isArray(input.items) ? input.items : []) {
    const item = normalizeItem(raw);
    if (!item || ids.has(item.id) || items.length >= INVENTORY_LIMITS.items) continue;
    ids.add(item.id); items.push(item);
  }
  const documents = (Array.isArray(input.documents) ? input.documents : []).slice(0, INVENTORY_LIMITS.documents).map(raw => ({ key: line(raw?.key, 300), title: line(raw?.title, 200),
    pages: whole(raw?.pages) ? raw.pages : 0, ranges: whole(raw?.ranges) ? raw.ranges : 0, read: whole(raw?.read) ? raw.read : 0, pagesRead: whole(raw?.pagesRead) ? raw.pagesRead : 0,
    ...(['no-text', 'paper'].includes(raw?.reason) ? { reason: raw.reason } : {}) })).filter(doc => doc.key);
  const clusters = (Array.isArray(input.cache?.clusters) ? input.cache.clusters : []).filter(entry => typeof entry?.key === 'string' && entry.answer)
    .slice(-INVENTORY_LIMITS.clusters).map(entry => ({ key: entry.key, answer: entry.answer }));
  const order = typeof input.cache?.order?.key === 'string' && input.cache.order.answer ? { key: input.cache.order.key, answer: input.cache.order.answer } : null;
  return { version: COURSE_INVENTORY_VERSION, course: input.course, language: input.language === 'en' ? 'en' : 'zh', fingerprint: short16(['inventory', ranges.map(range => range.print)]),
    ranges, items, documents, cache: { clusters, order } };
}

/** The pages of a course read by the inventory: { documents: { used, total }, pages: { read, total }, items, unverified, unreadable: [{ key, title, reason }] }. */
export function inventoryCoverage(inventory) {
  const docs = (inventory?.documents || []).filter(doc => doc.reason !== 'paper'), readable = docs.filter(doc => !doc.reason);
  const pages = readable.reduce((sum, doc) => sum + (doc.pages || 1), 0);
  const read = readable.reduce((sum, doc) => sum + Math.min(doc.pages || 1, doc.pagesRead), 0);
  const items = inventory?.items || [];
  return { documents: { used: readable.filter(doc => doc.read > 0).length, total: docs.length }, pages: { read, total: pages }, items: items.length,
    unverified: items.filter(item => !item.places.some(place => place.verified)).length, unreadable: docs.filter(doc => doc.reason).map(({ key, title, reason }) => ({ key, title, reason })) };
}

/** A source record for the library (`materials.v1 sources.ingest`); the id is a fingerprint of the content. `text` is a one-line notice for older releases. */
export function inventoryMaterial({ title, notice, ...input } = {}) {
  const name = line(title, 200) || fail('Title is required');
  const inventory = normalizeInventory(input);
  const id = `course-outline-inventory-${createHash('sha256').update(JSON.stringify([name, inventory])).digest('hex').slice(0, 40)}`;
  return { id, title: name, text: line(notice, 400) || name, format: 'md', courses: inventory.course ? [inventory.course] : [], provenance: COURSE_INVENTORY_PROVENANCE,
    courseInventory: inventory };
}

/** The inventory of a course: the newest one, filed under exactly that course (an empty string: the uncategorised one). */
export function currentInventory(sources, course) {
  if (typeof course !== 'string' || course === '*') return null;
  const mine = (Array.isArray(sources) ? sources : []).filter(source => isCourseInventorySource(source) && !source.archived && source.courseInventory.version === COURSE_INVENTORY_VERSION
    && (course === '' ? !(source.courses || []).length : (source.courses || []).includes(course)));
  return mine.sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')) || String(a.id).localeCompare(String(b.id)))[0] ?? null;
}

/** Are two inventories the same content (nothing to write)? */
export const sameInventory = (a, b) => !!a && !!b && JSON.stringify([a.ranges, a.items, a.documents, a.cache]) === JSON.stringify([b.ranges, b.items, b.documents, b.cache]);

export { isCourseInventorySource };
