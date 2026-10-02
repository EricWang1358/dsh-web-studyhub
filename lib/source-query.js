import { sourcesWithCourses, sourceMatchesCourse, libraryCourses, knownCourseNames } from './source-courses.js';
import { courseScope } from './course-tree.js';
import { isJsonCardSource, selfCitedCardCount } from './source-provenance.js';
import { libraryContracts } from './study-contracts.js';
import { currentCourse } from './focus.js';

const integer = (value, fallback, max) => Math.max(0, Math.min(max, Math.trunc(Number(value)) || fallback));
export function page(items, a = {}, defaultLimit = 50, max = 200) {
  const offset = integer(a.offset, 0, items.length), limit = Math.max(1, integer(a.limit, defaultLimit, max));
  return { total: items.length, offset, limit, nextOffset: offset + limit < items.length ? offset + limit : null,
    items: items.slice(offset, offset + limit) };
}

/* Preserve legacy display inference; inferred timestamps are never import dates. */
export function datedSources(s) {
  const earliest = new Map();
  const note = (sourceId, at) => {
    if (typeof at !== 'string' || !Number.isFinite(Date.parse(at))) return;
    const seen = earliest.get(sourceId);
    if (!seen || at < seen) earliest.set(sourceId, at);
  };
  for (const deck of [...s.decks, ...s.drafts])
    for (const card of deck.cards || [])
      for (const c of card.citations || []) note(c.sourceId, card.capturedAt || deck.createdAt);
  return s.sources.map(x => x.createdAt || !earliest.has(x.id) ? x
    : { ...x, createdAt: earliest.get(x.id), createdAtInferred: true });
}

/** The first characters of a source kept as its list excerpt (the sources page shows one line per material). */
export const SOURCE_EXCERPT_CHARS = 160;

/**
 * What the panel's snapshot carries of each source: everything but the text, plus its length (`chars`) and the
 * excerpt. The text is read on demand (materials.document.get / source.get). `keepText` names the sources whose text the
 * pages read straight from the snapshot: the scenario of a case set, a few paragraphs.
 */
export function snapshotSources(sources, keepText = new Set()) {
  return sources.map(({ text, ...source }) => {
    const body = typeof text === 'string' ? text : '';
    return { ...source, chars: body.length, excerpt: body.slice(0, SOURCE_EXCERPT_CHARS), ...(keepText.has(source.id) ? { text: body } : {}) };
  });
}

function calendar(timeZone) {
  try { return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }); }
  catch { throw new Error('Invalid time zone / 无效时区'); }
}
const calendarDay = (formatter, at) => {
  const parts = Object.fromEntries(formatter.formatToParts(new Date(at)).map(x => [x.type, x.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
};
export function dateScope(a = {}) {
  const timeZone = a.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const formatter = calendar(timeZone), today = calendarDay(formatter, Date.now());
  const resolve = value => {
    if (value === undefined) return null;
    if (value === 'today') return today;
    if (value === 'yesterday') {
      const d = new Date(`${today}T12:00:00Z`); d.setUTCDate(d.getUTCDate() - 1);
      return d.toISOString().slice(0, 10);
    }
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
        !Number.isFinite(Date.parse(`${value}T00:00:00Z`)) || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value)
      throw new Error('Invalid calendar date / 无效日期');
    return value;
  };
  if (a.importedOn !== undefined && (a.importedFrom !== undefined || a.importedTo !== undefined))
    throw new Error('Use one date or a date range / 单日与日期区间不能混用');
  const importedOn = resolve(a.importedOn), importedFrom = resolve(a.importedFrom), importedTo = resolve(a.importedTo);
  if (importedFrom && importedTo && importedFrom > importedTo) throw new Error('Invalid date range / 日期区间倒置');
  return { timeZone, today, importedOn, importedFrom, importedTo, formatter };
}
function sourceTime(source, formatter) {
  const entries = [['importedAt', source.importedAt], ['document.importedAt', source.document?.importedAt],
    ['audio.importedAt', source.audio?.importedAt], [source.createdAtInferred ? 'inferred' : 'createdAt', source.createdAt]];
  const found = entries.find(([, value]) => typeof value === 'string' && Number.isFinite(Date.parse(value)));
  if (!found) return { at: null, date: null, basis: 'unknown', recorded: false };
  return { at: found[1], date: calendarDay(formatter, found[1]), basis: found[0], recorded: found[0] !== 'inferred' };
}
/** A course filter (`*` / '' / a course name) prepared for a loop: a course name also takes in the courses inside it. */
const scopeOf = (state, course) => typeof course === 'string' && course !== '' && course !== '*' ? courseScope(course, knownCourseNames(state)) : course;
export function querySources(state, a = {}) {
  const { formatter, ...dates } = dateScope(a);
  const wanted = Array.isArray(a.sourceIds) ? new Set(a.sourceIds) : null;
  const sources = datedSources({ ...state, sources: sourcesWithCourses(state) })
    .filter(source => (!wanted || wanted.has(source.id)) && sourceMatchesCourse(source, scopeOf(state, a.course)))
    .map(source => ({ ...source, time: sourceTime(source, formatter) }));
  const dateCounts = { recorded: 0, inferred: 0, unknown: 0 };
  for (const source of sources) dateCounts[source.time.recorded ? 'recorded' : source.time.basis]++;
  const dated = !!(dates.importedOn || dates.importedFrom || dates.importedTo);
  return { sources: sources.filter(({ time }) => !dated || (time.recorded &&
    (!dates.importedOn || time.date === dates.importedOn) && (!dates.importedFrom || time.date >= dates.importedFrom) &&
    (!dates.importedTo || time.date <= dates.importedTo))),
  filters: { ...dates, course: a.course ?? '*', sourceIds: wanted ? [...wanted] : null }, dateCounts };
}

export function sourceSummary(source, a = {}) {
  const used = page(source.usedBy || [], { offset: a.relationOffset, limit: a.relationLimit }, 20, 100);
  return { id: source.id, title: source.title, chars: source.text.length,
    courses: source.courses, coursesInferred: source.coursesInferred, time: source.time,
    provenance: isJsonCardSource(source) ? 'json-card-self-reference' : 'independent-source',
    usedBy: used.items, relations: { total: used.total, offset: used.offset, nextOffset: used.nextOffset },
    ...(source.document ? { document: { id: source.document.id, page: source.document.page }, page: source.document.page } : {}),
    ...(source.audio?.batch ? { audioBatch: { id: source.audio.batch.id, volume: source.audio.batch.volume } } : {}) };
}
export function sourceGroups(sources, a = {}) {
  if (a.groupBy === undefined) return sources.map(source => sourceSummary(source, a));
  if (a.groupBy !== 'document') throw new Error('groupBy must be document');
  const groups = new Map();
  for (const source of sources) {
    const group = source.document?.id ? { kind: 'pdf', id: source.document.id }
      : source.audio?.batch?.id ? { kind: 'audio', id: source.audio.batch.id } : { kind: 'source', id: source.id };
    const key = `${group.kind}:${group.id}`;
    if (!groups.has(key)) groups.set(key, { group, sources: [] });
    groups.get(key).sources.push(source);
  }
  return [...groups.values()].map(({ group, sources: members }) => {
    const selected = page(members, { offset: a.memberOffset, limit: a.memberLimit }, 50, 200);
    const relations = [...new Map(members.flatMap(source => source.usedBy).map(ref => [`${ref.kind}:${ref.id}`, ref])).values()];
    const used = page(relations, { offset: a.relationOffset, limit: a.relationLimit }, 20, 100);
    return { group, title: members[0].audio?.batch?.title || members[0].title,
      chars: members.reduce((n, source) => n + source.text.length, 0),
      courses: [...new Set(members.flatMap(source => source.courses))],
      usedBy: used.items, relations: { total: used.total, offset: used.offset, nextOffset: used.nextOffset },
      members: { total: selected.total, offset: selected.offset, nextOffset: selected.nextOffset,
        sourceIds: selected.items.map(source => source.id), sources: selected.items.map(source => sourceSummary(source, a)) } };
  });
}

export function exactDecks(state, a = {}) {
  const ids = Array.isArray(a.deckIds) ? a.deckIds : a.deckId !== undefined ? [a.deckId] : null;
  if (ids) for (const id of ids) if (!state.decks.some(deck => deck.id === id)) throw new Error(`Deck not found / 题组不存在: ${id}`);
  const within = courseScope(a.course, knownCourseNames(state));
  return state.decks.filter(deck => ids ? ids.includes(deck.id) : within(deck.course ?? deck.folder ?? ''));
}

export function sourceCoverage(state, a = {}) {
  const { sources, filters, dateCounts } = querySources(state, a);
  const independent = sources.filter(source => !isJsonCardSource(source));
  const ids = new Set(independent.map(source => source.id)), selected = new Set(sources.map(source => source.id));
  const decks = exactDecks(state, a).filter(deck => !deck.systemKind);
  const within = courseScope(a.course, knownCourseNames(state));
  const drafts = a.deckIds !== undefined || a.deckId !== undefined ? [] : state.drafts.filter(deck => !deck.systemKind &&
    within(deck.course ?? deck.folder ?? ''));
  const cited = new Set();
  const target = deck => {
    const cards = (deck.cards || []).filter(card => (card.citations || []).some(ref => selected.has(ref.sourceId)));
    const direct = cards.filter(card => (card.citations || []).some(ref => ids.has(ref.sourceId)));
    for (const card of direct) for (const ref of card.citations || []) if (ids.has(ref.sourceId)) cited.add(ref.sourceId);
    const p = page(cards, { offset: a.cardOffset, limit: a.cardLimit }, 20, 100);
    return { id: deck.id, title: deck.title, course: deck.course ?? deck.folder ?? '', cards: (deck.cards || []).length,
      directCitedCards: direct.length, selfCitedCards: selfCitedCardCount(deck.cards || [], state.sources),
      cardIndex: { total: p.total, offset: p.offset, nextOffset: p.nextOffset,
        cards: p.items.map(card => ({ id: card.id, topic: card.topic, prompt: String(card.prompt || '').slice(0, 160),
          citationSourceCount: new Set((card.citations || []).filter(ref => selected.has(ref.sourceId)).map(ref => ref.sourceId)).size,
          sourceIds: [...new Set((card.citations || []).filter(ref => selected.has(ref.sourceId)).map(ref => ref.sourceId))].slice(0, 100) })) } };
  };
  const active = decks.filter(deck => !deck.archived).map(target), archived = decks.filter(deck => deck.archived).map(target), draftTargets = drafts.map(target);
  const targetPages = Object.fromEntries(Object.entries({ active, archived, drafts: draftTargets }).map(([kind, items]) =>
    [kind, page(items, { offset: a.targetOffset, limit: a.targetLimit }, 20, 100)]));
  const sourcePage = page(sourceGroups(sources, a), a);
  return { filters: { ...filters, deckIds: a.deckIds ?? (a.deckId === undefined ? null : [a.deckId]), groupBy: a.groupBy ?? null }, dateCounts,
    semanticCoverage: 'unassessed',
    directReferences: { numerator: cited.size, denominator: independent.length, unit: 'source', meaning: 'Selected independent sources directly cited by the selected decks and drafts; not knowledge coverage.' },
    selfReferences: { sources: sources.length - independent.length, excludedFromIndependentEvidence: true },
    targets: Object.fromEntries(Object.entries(targetPages).map(([kind, p]) => [kind, p.items])),
    targetPages: Object.fromEntries(Object.entries(targetPages).map(([kind, { items, ...p }]) => [kind, p])),
    sources: sourcePage.items, total: sourcePage.total, offset: sourcePage.offset, nextOffset: sourcePage.nextOffset };
}

export function libraryContext(state, a = {}, root) {
  const { timeZone, today } = dateScope(a);
  if (a.area !== undefined && !Object.hasOwn(libraryContracts, a.area)) throw new Error(`Unknown library.context area: ${a.area}`);
  const courses = page(libraryCourses(state), a, 30, 100);
  return { library: root, timeZone, today,
    focus: { mode: state.focus?.mode === 'interview' ? 'interview' : 'class', course: currentCourse(state), role: state.focus?.role || '' },
    counts: { sources: state.sources.length, decks: state.decks.filter(d => !d.archived && !d.systemKind).length,
      archivedDecks: state.decks.filter(d => d.archived).length, drafts: state.drafts.length,
      cards: state.decks.filter(d => !d.archived && !d.systemKind).reduce((n, d) => n + d.cards.length, 0) },
    courses: courses.items, coursesPage: { total: courses.total, offset: courses.offset, nextOffset: courses.nextOffset },
    areas: Object.keys(libraryContracts), ...(a.area ? { area: a.area, contract: libraryContracts[a.area] } : {}) };
}
