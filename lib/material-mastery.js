/* 资料掌握度 (material mastery), the backend side: the cards that cite each source, and from them the mastery of every page,
   chapter and document (`materialMasteryIndex`, the snapshot's `materialMastery`) and the cards of one document
   (`pagesCardsView`, `materials.pages.cards`). The summary itself (the states, the percentage, the counts line) is
   lib/material-summary.js, which the browser bundle shares; see there for what the number means.

   Pure, no I/O. Everything is read through the accessors the rest of the app uses: the card levels of lib/mastery.js, the
   chapters of groupSourcesByDocument (a kept segmentation included), the parked courses of lib/course-active.js. */
import { cardLevel, latestOutcomes, isDue } from './mastery.js';
import { groupSourcesByDocument } from './source-groups.js';
import { segmentationViews, stampSegmentations } from './document-outline.js';
import { courseActivityRules } from './course-active.js';
import { summarizeLinked } from './material-summary.js';
import { cardSourcePlaces } from './card-places.js';

export { MATERIAL_STATES, FAMILIAR_AT, summarizeLinked, dueNewWeakLine } from './material-summary.js';

const refKey = (deckId, cardId) => `${deckId}|${cardId}`;

export { cardSourcePlaces };

const sourceMap = state => new Map((Array.isArray(state?.sources) ? state.sources : []).map(source => [source.id, source]));

/**
 * Every card that cites a source, by source id: `bySource` Map<sourceId, links>, a link per (card, source):
 * `{ deckId, cardId, level, due, inactive, start, end }` where `start`/`end` are where the card points into the source text
 * (its selection, else where its quote first stands; null when unknown). `levels` Map<"deckId|cardId", level>.
 * Suspended cards and archived decks are left out.
 */
export function linkedCardIndex(state, { now = Date.now() } = {}) {
  const sources = sourceMap(state);
  const outcome = latestOutcomes(Array.isArray(state?.attempts) ? state.attempts : []), rules = courseActivityRules(state || {});
  const bySource = new Map(), levels = new Map();
  for (const deck of Array.isArray(state?.decks) ? state.decks : []) {
    if (deck.archived) continue;
    const inactive = !rules.deckActive(deck);
    for (const card of deck.cards || []) {
      if (card.suspended) continue;
      const level = cardLevel(card, outcome(deck.id, card.id)), due = level !== 'new' && isDue(card, now);
      levels.set(refKey(deck.id, card.id), level);
      for (const [sourceId, { start, end }] of cardSourcePlaces(card, sources)) {
        if (!bySource.has(sourceId)) bySource.set(sourceId, []);
        bySource.get(sourceId).push({ deckId: deck.id, cardId: card.id, level, due, inactive, start, end });
      }
    }
  }
  return { bySource, levels };
}

/** A draft that is a copy of a deck that is already published (an edit in progress, or a repair): its questions are the published ones. */
const isCopyOfPublished = draft => !!draft.editingDeckId || !!draft.editorial?.repairOfDeckId;

/**
 * The questions of drafts that cite a source, apart from the published ones (a generation run's result is a draft until it is
 * published): `bySource` Map<sourceId, links>, a link per (card, source) `{ deckId: <the draft's id>, cardId, start, end }` (the
 * draft id sits in the `deckId` slot so a card key has one shape for decks and drafts). No level: a draft question has no review
 * state, so it never feeds a mastery number. Editing copies of published decks are left out, they would count twice.
 */
export function draftCardIndex(state) {
  const sources = sourceMap(state), bySource = new Map();
  for (const draft of Array.isArray(state?.drafts) ? state.drafts : []) {
    if (!draft || isCopyOfPublished(draft)) continue;
    for (const card of draft.cards || []) {
      if (!card || card.suspended) continue;
      for (const [sourceId, { start, end }] of cardSourcePlaces(card, sources)) {
        if (!bySource.has(sourceId)) bySource.set(sourceId, []);
        bySource.get(sourceId).push({ deckId: draft.id, cardId: card.id, start, end });
      }
    }
  }
  return { bySource };
}

/** The cards that point into any of `sourceIds`, one entry per card (a card on two pages counts once), with their summary. */
export function documentCards(index, sourceIds) {
  const cards = new Map();
  for (const sourceId of sourceIds || []) for (const link of index.bySource.get(sourceId) || []) {
    const key = refKey(link.deckId, link.cardId);
    if (!cards.has(key)) cards.set(key, { deckId: link.deckId, cardId: link.cardId, level: link.level, due: link.due, inactive: link.inactive, links: [] });
    cards.get(key).links.push({ sourceId, start: link.start, end: link.end });
  }
  const list = [...cards.values()];
  return { cards: list, summary: summarizeLinked(list) };
}

/**
 * Every source id of every version of the document each source belongs to: Map<sourceId, string[]>. A document that was imported
 * again keeps its old versions as retained evidence (state.documents[].versions), and questions written from an old version still
 * belong to the document.
 */
export function versionFamilies(documents) {
  const families = new Map();
  for (const document of Array.isArray(documents) ? documents : []) {
    const ids = [...new Set((document?.versions || []).flatMap(version => version?.sourceIds || []))];
    for (const id of ids) families.set(id, ids);
  }
  return families;
}

/** The first 16 hex digits of a recording's content hash: what audio source ids carry (lib/audio-import.js audioSourceId). */
const recordingKey = hash => typeof hash === 'string' && hash ? hash.slice(0, 16) : '';

/**
 * The recordings (content hashes, 16 digits) a source was made from, as the audio import recorded them: a merged material (a batch
 * import of several files) lists its members in `audio.batch.members[].hash`; a single recording has `audio.hash`; an older single
 * import without that field still carries the hash in its id (`audio-<hash16>-<key>[-pN]`). A source that records none (a
 * merged import from before members were recorded, any non-audio material) has none: titles are never used to guess.
 */
export function sourceRecordings(source) {
  const audio = source?.audio, members = audio?.batch?.members;
  if (Array.isArray(members) && members.length) return new Set(members.map(member => recordingKey(member?.hash)).filter(Boolean));
  const own = audio ? recordingKey(audio.hash) || /^audio-([0-9a-f]{16})-/.exec(String(source.id))?.[1] || '' : '';
  return new Set(own ? [own] : []);
}

/** The materials of the library (items of groupSourcesByDocument) with the recordings each one is made of: [{ item, recordings: Set }]. */
export function recordingIndex(state, listed) {
  const sources = sourceMap(state);
  return (listed || []).map(item => {
    const recordings = new Set();
    for (const id of item.sourceIds) for (const hash of sourceRecordings(sources.get(id))) recordings.add(hash);
    return { item, recordings };
  }).filter(entry => entry.recordings.size);
}

/**
 * The other materials whose questions belong to this one by a recorded relation (never by title):
 *   same         materials made from exactly the same recording(s) (the same file imported again, with another model or setting): symmetric;
 *   constituents the single-recording materials made from recordings a MERGED material (several recordings) contains: directional, a
 *                single recording does not count the merged material's questions, which may cover other recordings.
 * `mine` is the Set of recordings of the material, `recordings` is `recordingIndex`, `ownIds` the sources that are the material's own.
 * -> { same: [item], constituents: [item] }
 */
export function relatedMaterials(mine, recordings, ownIds) {
  const result = { same: [], constituents: [] };
  if (!mine.size) return result;
  for (const entry of recordings) {
    if (entry.item.sourceIds.some(id => ownIds.has(id))) continue;
    const theirs = entry.recordings;
    if (theirs.size === mine.size && [...theirs].every(hash => mine.has(hash))) result.same.push(entry.item);
    else if (mine.size > 1 && theirs.size === 1 && [...theirs].every(hash => mine.has(hash))) result.constituents.push(entry.item);
  }
  return result;
}

/**
 * The source records whose questions are a document's questions, defined once (the 资料 row, the reader's 整份资料 range and the coverage figure all read it): the document's own records,
 * every record of every older version of it (`older`), the records of the other materials made from the same recording(s) (`same`) and of the recordings a merged material consists of (`parts`).
 * options: `families` / `listed` / `recordings` when the caller computed them once for many documents. -> { ids (all of them), own, older, same, parts }: Sets, `ids` an array.
 */
export function documentSourceFamily(state, item, { families, listed, recordings } = {}) {
  const known = families || versionFamilies(state?.documents), own = new Set(item?.sourceIds || []), older = new Set(), ownIds = new Set();
  const expand = (ids, into) => { for (const id of ids) { into.add(id); for (const other of known.get(id) || []) into.add(other); } };
  expand(own, ownIds);
  for (const id of ownIds) if (!own.has(id)) older.add(id);
  const library = recordings || recordingIndex(state, listed || groupSourcesByDocument(stampSegmentations(Array.isArray(state?.sources) ? state.sources : [], segmentationViews(state)), { documents: state?.documents }));
  const sourcesById = sourceMap(state), mine = new Set();
  for (const id of ownIds) for (const hash of sourceRecordings(sourcesById.get(id))) mine.add(hash);
  const related = relatedMaterials(mine, library, ownIds), same = new Set(), parts = new Set();
  for (const other of related.same) expand(other.sourceIds, same);
  for (const other of related.constituents) expand(other.sourceIds, parts);
  return { ids: [...new Set([...ownIds, ...same, ...parts])], own, older, same, parts };
}

/**
 * THE questions of a document, defined once for the 资料 row (`materialMasteryIndex`) and the reader's 整份资料 range
 * (`pagesCardsView`): every question of a deck (not archived, not suspended) that cites a source of
 *   - the document itself: any source record of ANY version of it (a re-imported document keeps its old versions);
 *   - another material made from the same recording(s) (`relatedMaterials`: same), and, for a merged recording, the materials made
 *     from the separate recordings it contains (constituents; not the other way round),
 * each question once. `item` is an item of groupSourcesByDocument (the version listed, or the version being read); the other
 * versions come from `state.documents`, the other materials from `listed` (the library's items, current versions). The questions
 * still in drafts follow the same rule, apart.
 * options: `now`, and `index` / `draftIndex` / `families` / `listed` / `recordings` when the caller computed them once for many documents.
 * -> { sourceIds (all of the above), cards: [{ deckId, cardId, level, due, inactive, links, origin }], summary, drafts: [{ deckId: <draft id>, cardId, links }] }
 * `origin` says where a card comes from when none of its links is in `item.sourceIds`: 'older' (another version of the document),
 * 'same' (another material of the same recording), 'part' (a material of one of the recordings it contains); absent otherwise.
 */
export function documentCardSet(state, item, { now = Date.now(), index, draftIndex, families, listed, recordings } = {}) {
  const { ids, own, older, same } = documentSourceFamily(state, item, { families, listed, recordings });
  const published = documentCards(index || linkedCardIndex(state, { now }), ids);
  const originOf = entry => {
    const links = entry.links.map(link => link.sourceId);
    if (links.some(id => own.has(id))) return undefined;
    return links.some(id => older.has(id)) ? 'older' : links.some(id => same.has(id)) ? 'same' : 'part';
  };
  for (const entry of published.cards) { const origin = originOf(entry); if (origin) entry.origin = origin; }
  return { sourceIds: ids, cards: published.cards, summary: published.summary, drafts: documentCards(draftIndex || draftCardIndex(state), ids).cards };
}

/**
 * Which chapter of a document (an item of groupSourcesByDocument) a place belongs to: the chapter's `index`, or null.
 * The learner's chapters (a kept outline applied; `item.segmentation`) follow the position: the last chapter that starts at or
 * before it (a card with no known offset is on the page, which belongs to the chapter that starts it). A converted book's
 * chapters are whole pages.
 */
export function chapterIndexOf(item, sourceId, offset) {
  const chapters = item?.chapters || [];
  if (!chapters.length) return null;
  if (!item.segmentation) return chapters.find(chapter => chapter.sourceIds?.includes(sourceId))?.index ?? null;
  const at = item.sourceIds.indexOf(sourceId);
  if (at < 0) return null;
  const where = Number.isInteger(offset) ? offset : 0;
  let owner = null;
  for (const chapter of chapters) {
    if (chapter.front || chapter.startSourceId === undefined) continue;
    const start = item.sourceIds.indexOf(chapter.startSourceId);
    if (start >= 0 && (start < at || (start === at && (chapter.startOffset || 0) <= where))) owner = chapter;
  }
  return owner ? owner.index : chapters.find(chapter => chapter.front)?.index ?? null;
}

/** How many draft ids a snapshot carries per document (the count itself is exact). */
export const DRAFT_IDS_MAX = 20;
/** How many draft questions `materials.pages.cards` places for the reader (the count `draftCards` stays exact). */
export const DRAFT_ENTRIES_MAX = 400;

/** The links of one document's listed version grouped as its pages and its chapters (one entry per card in a chapter). The document itself is `documentCardSet`. */
function gatherLinks(item, bySource) {
  const chapters = new Map(), pages = new Map();
  for (const sourceId of item.sourceIds) {
    const links = bySource.get(sourceId);
    if (!links) continue;
    pages.set(sourceId, links);
    for (const link of links) {
      const key = refKey(link.deckId, link.cardId);
      const chapter = chapterIndexOf(item, sourceId, link.start);
      if (chapter === null) continue;
      if (!chapters.has(chapter)) chapters.set(chapter, new Map());
      if (!chapters.get(chapter).has(key)) chapters.get(chapter).set(key, { ...link, sourceId });
    }
  }
  return { chapters, pages };
}

/** The summary of some published links, with the number of draft questions of the same scope when there are any. */
const summaryOf = (links, drafts) => drafts > 0 ? { ...summarizeLinked(links), draftCards: drafts } : summarizeLinked(links);

/**
 * The mastery of every document that has a question, for the 资料 page: `{ [item.key]: { document, pages: { [sourceId]: summary },
 * chapters: { [chapter.index]: summary } } }` keyed like groupSourcesByDocument. A page, chapter or document with no question
 * has no entry (the row says 还没出题). The chapters are read through the one accessor, so a kept segmentation counts.
 *
 * Questions still in DRAFTS (a generation run's result, until it is published) are counted apart and never feed the mastery:
 * a summary of a scope that a draft cites carries `draftCards` (its number of draft questions), and a document's entry carries
 * `drafts: { cards, draftIds }` (bounded ids). A scope with only drafts has the "none" summary plus `draftCards`, so the row
 * says 还没发布 · 草稿里有 N 题 instead of 还没出题.
 */
export function materialMasteryIndex(state, { now = Date.now() } = {}) {
  const index = linkedCardIndex(state, { now }), drafts = draftCardIndex(state);
  if (!index.bySource.size && !drafts.bySource.size) return {};
  const sources = stampSegmentations(Array.isArray(state.sources) ? state.sources : [], segmentationViews(state));
  const result = {}, families = versionFamilies(state.documents), listed = groupSourcesByDocument(sources, { documents: state.documents }), recordings = recordingIndex(state, listed);
  for (const item of listed) {
    const whole = documentCardSet(state, item, { index, draftIndex: drafts, families, listed, recordings });
    if (!whole.cards.length && !whole.drafts.length) continue;
    const published = gatherLinks(item, index.bySource), drafted = gatherLinks(item, drafts.bySource);
    const pages = {}, chapters = {};
    for (const sourceId of item.sourceIds) {
      const links = published.pages.get(sourceId), pending = drafted.pages.get(sourceId)?.length || 0;
      if (links || pending) pages[sourceId] = summaryOf(links || [], pending);
    }
    for (const chapter of new Set([...published.chapters.keys(), ...drafted.chapters.keys()]))
      chapters[chapter] = summaryOf([...(published.chapters.get(chapter)?.values() || [])], drafted.chapters.get(chapter)?.size || 0);
    const draftIds = [...new Set(whole.drafts.map(entry => entry.deckId))];
    result[item.key] = { document: summaryOf(whole.cards, whole.drafts.length), pages, chapters,
      ...(whole.drafts.length ? { drafts: { cards: whole.drafts.length, draftIds: draftIds.slice(0, DRAFT_IDS_MAX) } } : {}) };
  }
  return result;
}

const memo = { root: undefined, revision: undefined, minute: -1, value: null };
/** The snapshot's `materialMastery`, computed once per library revision and minute (due dates move with time), not per poll. */
export function materialMasteryOf(state, { root = '', now = Date.now() } = {}) {
  const minute = Math.floor(now / 60000), revision = state?.revision;
  if (memo.value && memo.root === root && memo.revision === revision && revision !== undefined && memo.minute === minute) return memo.value;
  const value = materialMasteryIndex(state, { now });
  Object.assign(memo, { root, revision, minute, value });
  return value;
}

const clip = (value, max) => { const text = String(value ?? ''); return text.length > max ? `${text.slice(0, max)}…` : text; };

/** The selection of `card` that points into `sourceId`: the stored one, else one made of the cited quote (no context). */
function selectionInto(card, sourceId) {
  const stored = [...(card.selections || []), ...(card.citations || []).map(citation => citation?.selection)]
    .find(selection => selection?.sourceId === sourceId && selection.quote);
  if (stored) return stored;
  const cited = (card.citations || []).find(citation => citation?.sourceId === sourceId && citation.quote);
  return cited ? { sourceId, quote: cited.quote, prefix: '', suffix: '' } : null;
}

/**
 * `materials.pages.cards`: the cards that point into a document (or into some of its pages), for the reader.
 * args: `documentId` or `sourceId` (any page of it) and optionally `sourceIds` to narrow to some pages.
 * -> { status: 'ok' | 'missing', documentId, key, sourceIds, cards: [{ deckId, deckTitle, course, cardId, kind, sourceQa, prompt, level, due,
 *      inactive, links: [{ sourceId, start, end, selection? }] }], summary, inactiveCourses,
 *      draftCards, drafts: { cards, draftIds }, draftEntries: [{ draftId, cardId, links }] }  (the questions still in drafts, apart)
 * Without `sourceIds` the cards are the whole document's (`documentCardSet`: every version and source record, as the 资料 row counts them);
 * a card with no link into the version being read (`sourceIds`) is flagged `otherVersion` (counted in `olderCards`), or `otherMaterial`
 * 'same' (another material of the same recording: `sameRecordingCards`) / 'part' (a material of a recording this merged one contains: `partCards`).
 * A card on two pages is one entry with two links. Cards of parked courses are listed and flagged `inactive`: the learner
 * is reading this document, so they are offered, and said to be parked.
 */
export function pagesCardsView(state, args = {}, { now = Date.now() } = {}) {
  const anchor = args.sourceId || (Array.isArray(args.sourceIds) ? args.sourceIds[0] : undefined);
  const documents = state?.documents || [];
  const owner = args.documentId ? documents.find(document => document.id === args.documentId)
    : documents.find(document => document.versions?.some(version => version.revision === document.currentRevision && version.sourceIds?.includes(anchor)))
      || documents.find(document => document.versions?.some(version => version.sourceIds?.includes(anchor)));
  // An explicit historical page opens that version's linked questions; a document alone opens its current revision.
  const version = owner?.versions?.find(version => version.revision === owner.currentRevision && (!anchor || version.sourceIds?.includes(anchor)))
    || owner?.versions?.find(version => anchor && version.sourceIds?.includes(anchor));
  const members = version && new Set(version.sourceIds);
  const sources = (Array.isArray(state?.sources) ? state.sources : []).filter(source => !members || members.has(source.id));
  const items = groupSourcesByDocument(stampSegmentations(sources, segmentationViews(state)), { documents: version ? undefined : documents });
  // The document the id names (a stored document, `legacy-<hash>`, or `source-<id>` for a source with no document record: any part of it),
  // else the one the anchor page belongs to. Never "the first material of the library".
  const named = args.documentId && items.find(entry => entry.documentId === args.documentId || entry.key === args.documentId
    || entry.sourceIds.some(id => `source-${id}` === args.documentId));
  const item = named || (anchor !== undefined && items.find(entry => entry.sourceIds.includes(anchor))) || (version && !args.documentId ? items[0] : undefined);
  if (!item) return { status: 'missing', cards: [], summary: summarizeLinked([]), inactiveCourses: [], sourceIds: [] };
  // 整份资料 is the one definition of a document's questions (documentCardSet: every version, every source record), the very set the 资料 row counts;
  // a page range reads only those pages.
  const index = linkedCardIndex(state, { now }), draftIndex = draftCardIndex(state);
  const listed = version ? groupSourcesByDocument(stampSegmentations(Array.isArray(state?.sources) ? state.sources : [], segmentationViews(state)), { documents }) : items;
  const whole = documentCardSet(state, item, { now, index, draftIndex, listed });
  const narrowed = Array.isArray(args.sourceIds) && args.sourceIds.length > 0;
  const pages = narrowed ? args.sourceIds.filter(id => item.sourceIds.includes(id)) : item.sourceIds;
  // One chapter (`chapter`: its index, as the 资料 row lists it): exactly the cards that chapter's mastery counts (gatherLinks, chapterIndexOf), so the
  // chapter row's 练这一章 practises the set its number is about, whatever the chapter's shape (whole pages, or starting inside a page).
  const chapter = Number.isInteger(args.chapter) ? args.chapter : null;
  const inChapter = (links, withLevels) => [...(links.get(chapter)?.values() || [])].map(link => ({ deckId: link.deckId, cardId: link.cardId,
    ...(withLevels ? { level: link.level, due: link.due, inactive: link.inactive } : {}), links: [{ sourceId: link.sourceId, start: link.start, end: link.end }] }));
  const chapterSet = () => { const list = inChapter(gatherLinks(item, index.bySource).chapters, true); return { cards: list, summary: summarizeLinked(list) }; };
  const { cards, summary } = chapter !== null ? chapterSet() : narrowed ? documentCards(index, pages) : whole;
  const decks = new Map((state.decks || []).map(deck => [deck.id, deck])), rules = courseActivityRules(state);
  const courses = new Set();
  const view = cards.map(entry => {
    const deck = decks.get(entry.deckId), card = deck.cards.find(candidate => candidate.id === entry.cardId), course = rules.nameOfDeck(deck) || '';
    if (entry.inactive) courses.add(course);
    return { deckId: deck.id, deckTitle: deck.title, course, cardId: card.id, kind: card.kind, sourceQa: card.sourceQa === true, prompt: clip(card.prompt, 300),
      level: entry.level, due: entry.due, inactive: entry.inactive,
      // A question of the document's other versions (otherVersion), or of another material made from the same recording (otherMaterial
      // 'same') or from one of the recordings it contains ('part'): none of its links is in the version being read.
      ...(entry.origin === 'older' ? { otherVersion: true } : entry.origin ? { otherMaterial: entry.origin } : {}),
      links: entry.links.map(link => { const selection = selectionInto(card, link.sourceId); return { sourceId: link.sourceId, start: link.start, end: link.end, ...(selection ? { selection } : {}) }; }) };
  });
  // The questions of drafts that cite these pages: counted apart (they are not published, so not practisable), with where each
  // one points so the reader can place them under its sections like the published ones.
  const pending = chapter !== null ? inChapter(gatherLinks(item, draftIndex.bySource).chapters, false) : narrowed ? documentCards(draftIndex, pages).cards : whole.drafts, drafts = new Map((state.drafts || []).map(draft => [draft.id, draft]));
  const draftIds = [...new Set(pending.map(entry => entry.deckId))];
  const draftEntries = pending.slice(0, DRAFT_ENTRIES_MAX).map(entry => {
    const card = drafts.get(entry.deckId)?.cards?.find(candidate => candidate.id === entry.cardId);
    return { draftId: entry.deckId, cardId: entry.cardId,
      links: entry.links.map(link => { const selection = card && selectionInto(card, link.sourceId); return { sourceId: link.sourceId, start: link.start, end: link.end, ...(selection ? { selection } : {}) }; }) };
  });
  return { status: 'ok', documentId: item.documentId, key: item.key, sourceIds: [...item.sourceIds], cards: view, summary, inactiveCourses: [...courses],
    olderCards: view.filter(entry => entry.otherVersion).length, sameRecordingCards: view.filter(entry => entry.otherMaterial === 'same').length,
    partCards: view.filter(entry => entry.otherMaterial === 'part').length,
    draftCards: pending.length, drafts: { cards: pending.length, draftIds: draftIds.slice(0, DRAFT_IDS_MAX) }, draftEntries };
}
