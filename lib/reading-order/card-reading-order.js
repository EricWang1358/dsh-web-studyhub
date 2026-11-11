/* Pure reading-order and answer-safe source location for questions.
   Maps a card's citations/selections to (documentRank, pageRank, offsetRank) so new questions advance front-to-back (p.1 -> p.2 -> ... -> p.94)
   across source-published and already-published decks, while uncited cards stay anchored to their authored position. */
import { cardSourcePlaces } from '../card-places.js';
import { displayTitle, fileNameOf } from '../document-title.js';
import { isPagedFormat, isSlideFormat } from '../office/limits.js';
import { isJsonCardSource } from '../source-provenance.js';

const PDF_MATERIAL = /^document-([a-f0-9]{64})-pdf$/;
const PAGE_SUFFIX = /\s·\s(?:p\.\s?\d+|第\s?\d+\s?页)$/;
const PART_SUFFIX = /\s\(\d+\/\d+\)$/;
const SOURCE_ID_PAGE = /^(.*?)(?:[-:_](?:p|page[-_]?|slide[-_]?))(\d+)$/i;
const OFFICE = new Set(['docx', 'pptx', 'ppt']);

function detectFormat(source) {
  const doc = source?.document;
  if (doc && !OFFICE.has(doc.format) && (Number.isInteger(doc.page) || doc.format === 'pdf' || PDF_MATERIAL.test(doc.materialId || ''))) return 'pdf';
  const declared = String(doc?.format || '').toLowerCase();
  if (['pdf', 'docx', 'pptx', 'ppt', 'md', 'html', 'txt'].includes(declared)) return declared;
  if (source?.audio) return 'audio';
  if (isJsonCardSource(source)) return 'json';
  return 'text';
}

function documentKeyOf(source) {
  const doc = source?.document;
  if (detectFormat(source) === 'pdf') {
    const hash = doc?.id || PDF_MATERIAL.exec(doc?.materialId || '')?.[1];
    if (doc?.materialId && hash && doc.materialId !== `document-${hash}-pdf`) return `pdf:${doc.materialId}:${hash}`;
    return `pdf:${hash || doc?.materialId || source.id}`;
  }
  if (doc?.materialId) return `doc:${doc.materialId}`;
  const audio = source?.audio;
  if (audio?.batch?.id) return `audio:${audio.batch.id}`;
  if (Array.isArray(audio?.sourceIds) && audio.sourceIds.length > 1) return `audio:${audio.sourceIds[0]}`;
  return `source:${source?.id || ''}`;
}

function cleanDocumentTitle(first, format) {
  const raw = String(first?.title ?? '');
  if (format === 'pdf') return displayTitle(fileNameOf(first.document?.bookTitle || first.document?.filename || raw.replace(PAGE_SUFFIX, '')));
  if (isSlideFormat(format)) return displayTitle(fileNameOf(raw.replace(PAGE_SUFFIX, '') || first.document?.filename || raw));
  if (format === 'audio') return displayTitle(fileNameOf(first.audio?.batch?.title || raw.replace(PART_SUFFIX, '')));
  return displayTitle(fileNameOf(raw));
}

function pageNumberOf(source, format) {
  if (isPagedFormat(format) && Number.isInteger(source?.document?.page)) return source.document.page;
  if (format === 'audio' && Number.isInteger(source?.audio?.batch?.volume)) return source.audio.batch.volume;
  return null;
}

const indexCache = new WeakMap();

/** Build (and cache for frozen `sources` arrays) the reading-order lookup over `sources`. */
export function buildSourceReadingIndex(sources) {
  if (!Array.isArray(sources) || !sources.length) return { byId: new Map(), sourceMap: new Map(), fallbackGroups: new Map() };
  const frozen = Object.isFrozen(sources);
  if (frozen && indexCache.has(sources)) return indexCache.get(sources);
  const sourceMap = new Map();
  const groups = new Map();
  for (const [idx, source] of sources.entries()) {
    if (!source?.id) continue;
    sourceMap.set(source.id, source);
    if (isJsonCardSource(source)) continue;
    const key = documentKeyOf(source);
    const format = detectFormat(source);
    let group = groups.get(key);
    if (!group) groups.set(key, group = { key, rank: groups.size, format, entries: [] });
    group.entries.push({ source, idx, page: pageNumberOf(source, format) });
  }
  const byId = new Map();
  for (const group of groups.values()) {
    const sorted = [...group.entries].sort((a, b) => (a.page ?? a.idx + 1) - (b.page ?? b.idx + 1) || a.idx - b.idx);
    const first = sorted[0]?.source;
    const title = first ? cleanDocumentTitle(first, group.format) : '';
    const paged = sorted.length > 1 || sorted.some((entry) => entry.page !== null);
    const unit = isSlideFormat(group.format) ? 'slide' : group.format === 'pdf' ? 'page' : group.format === 'audio' ? 'part' : 'section';
    for (const [pos, entry] of sorted.entries()) {
      byId.set(entry.source.id, {
        docRank: group.rank,
        pageRank: entry.page ?? pos + 1,
        page: entry.page,
        documentKey: group.key,
        documentSourceId: first?.id || entry.source.id,
        title,
        unit,
        paged,
      });
    }
  }
  const built = { byId, sourceMap, fallbackGroups: new Map() };
  if (frozen) indexCache.set(sources, built);
  return built;
}

function fallbackRankOf(sourceId, fallbackGroups) {
  const match = typeof sourceId === 'string' ? SOURCE_ID_PAGE.exec(sourceId) : null;
  if (!match) return null;
  const prefix = match[1] || sourceId;
  let docRank = fallbackGroups.get(prefix);
  if (docRank === undefined) {
    docRank = 1_000_000 + fallbackGroups.size;
    fallbackGroups.set(prefix, docRank);
  }
  return { docRank, pageRank: Number(match[2]) };
}

/** Earliest `(docRank, pageRank, offsetRank)` of `card` in `index`, or `null` when the card carries no resolvable material citation. */
export function cardReadingRank(card, index) {
  if (!card) return null;
  const places = cardSourcePlaces(card, index.sourceMap);
  let best = null;
  const consider = (docRank, pageRank, start) => {
    const offsetRank = Number.isInteger(start) && start >= 0 ? start : Number.MAX_SAFE_INTEGER;
    if (!best || docRank < best.docRank || (docRank === best.docRank && (pageRank < best.pageRank || (pageRank === best.pageRank && offsetRank < best.offsetRank)))) {
      best = { docRank, pageRank, offsetRank };
    }
  };
  for (const [sourceId, range] of places.entries()) {
    const info = index.byId.get(sourceId) || fallbackRankOf(sourceId, index.fallbackGroups);
    if (info) consider(info.docRank, info.pageRank, range?.start);
  }
  return best;
}

function compareRanks(a, b) {
  if (!a && !b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  return a.docRank - b.docRank || a.pageRank - b.pageRank || a.offsetRank - b.offsetRank;
}

/** Comparator over cards or `{ card }` entries by earliest reading position in `sources`. Returns `0` when neither side resolves or positions tie. */
export function createReadingOrder(sources) {
  const index = buildSourceReadingIndex(sources);
  const rankCache = new WeakMap();
  const rankOf = (item) => {
    const card = item?.card ?? item;
    if (!card || typeof card !== 'object') return null;
    if (rankCache.has(card)) return rankCache.get(card);
    const rank = cardReadingRank(card, index);
    rankCache.set(card, rank);
    return rank;
  };
  return (left, right) => compareRanks(rankOf(left), rankOf(right));
}

/**
 * Return a new array with `cards` sorted in reading order (`p.1 -> p.2 -> ...`).
 * Uncited cards inside a deck inherit their nearest cited neighbor's rank so they stay anchored in place rather than jumping to the end;
 * completely uncited or JSON-imported decks return in exact original order.
 */
export function sortCardsByReadingOrder(cards, sources) {
  if (!Array.isArray(cards) || cards.length < 2) return Array.isArray(cards) ? [...cards] : [];
  const index = buildSourceReadingIndex(sources);
  const ranks = cards.map((card) => cardReadingRank(card, index));
  if (ranks.every((rank) => rank === null)) return [...cards];
  for (let i = 1; i < ranks.length; i++) {
    if (!ranks[i] && ranks[i - 1]) ranks[i] = ranks[i - 1];
  }
  for (let i = ranks.length - 2; i >= 0; i--) {
    if (!ranks[i] && ranks[i + 1]) ranks[i] = ranks[i + 1];
  }
  return cards
    .map((card, at) => ({ card, rank: ranks[at], at }))
    .sort((a, b) => compareRanks(a.rank, b.rank) || a.at - b.at)
    .map(({ card }) => card);
}

/**
 * Answer-safe material location of `card` for practice UI (`{ sourceId, documentSourceId, documentKey, title, page, unit, paged }`).
 * Never includes `quote`, `selection`, or answer offsets so showing where a question sits cannot spoil the answer.
 */
export function cardReadingLocation(card, sources) {
  if (!card || !Array.isArray(sources) || !sources.length) return null;
  const index = buildSourceReadingIndex(sources);
  const places = cardSourcePlaces(card, index.sourceMap);
  let chosen = null, chosenOffset = Number.MAX_SAFE_INTEGER;
  for (const [sourceId, range] of places.entries()) {
    const info = index.byId.get(sourceId);
    if (!info) continue;
    const offset = Number.isInteger(range?.start) && range.start >= 0 ? range.start : Number.MAX_SAFE_INTEGER;
    if (!chosen || info.docRank < chosen.docRank || (info.docRank === chosen.docRank && (info.pageRank < chosen.pageRank || (info.pageRank === chosen.pageRank && offset < chosenOffset)))) {
      chosen = { sourceId, ...info };
      chosenOffset = offset;
    }
  }
  if (!chosen) return null;
  return {
    sourceId: chosen.sourceId,
    documentSourceId: chosen.documentSourceId,
    documentKey: chosen.documentKey,
    title: chosen.title,
    page: chosen.page,
    unit: chosen.unit,
    paged: chosen.paged,
  };
}
