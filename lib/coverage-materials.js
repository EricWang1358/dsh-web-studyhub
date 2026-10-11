/* MATERIALS of a run: what the learner selected, as the learner counts it (flow A of the owner's 2026-10-11 report: 「选了 8 份资料，只有 2 份出了题」). Pure, no I/O and no Node modules.
   A material is a document of lib/source-groups.js (a PDF's pages are ONE material, a recording's volumes are one), and inside a transcript of several recordings (`## N. file`)
   each recording is one: the learner imported eight lectures and expects all eight to be asked about. The versions of one document (state.documents[].versions) are one material:
   a selection that holds the old and the new import counts it once.
     materialIndex(sources, { documents, sections }) -> { list, keyOfSource, keyOfSection }   the materials in reading order, each { key, title, kind, sourceIds, sections, chars, reason? }
        reason 'no-text': nothing in it can be quoted (no leaf section with characters): it cannot get a question and is said so, never silently left out;
        reason 'sparse': every page of it has almost no text (a scan, a page of figures or tables): it is planned, and a material without a question says why.
     materialPieces(sources) -> [{ key, title, sources }]   the same materials cut out of the pieces of a plain run (lib/batch.js), for a planner that refused a whole group.
   The reports (before a run: what the plan does for each material; after it: what came of each) are made here too, so the creation form, the draft page and the job read one function. */
import { groupSourcesByDocument, sourceItemKey } from './source-groups.js';
import { sliceRangeOf, withSliceRange } from './sections.js';

/** The material a leaf section of a document belongs to: the document's, and its recording's when the transcript has recordings. */
export const sectionMaterialKey = (documentKey, section) => (section?.recording != null ? `${documentKey}#r${section.recording}` : documentKey);

/** Source id -> the key every version of its document is counted under (the first of them in the selection). */
function versionKeys(items, documents) {
  const keyOfSource = new Map();
  for (const item of items) for (const id of item.sourceIds) keyOfSource.set(id, item.key);
  for (const document of Array.isArray(documents) ? documents : []) {
    const ids = [...new Set((document?.versions || []).flatMap(version => version?.sourceIds || []))].filter(id => keyOfSource.has(id));
    if (ids.length < 2) continue;
    const first = keyOfSource.get(ids[0]), merged = new Set(ids.map(id => keyOfSource.get(id)));
    for (const [id, key] of keyOfSource) if (merged.has(key)) keyOfSource.set(id, first);
  }
  return keyOfSource;
}

/**
 * The materials of `sources` (the selection, in the library's order). `sections`: lib/sections.js sectionsOf of the same sources (the leaves say what can be asked; the recording sections give a
 * recording its name). -> { list, keyOfSource: Map(sourceId -> document key), keyOfSection(section) -> material key }
 */
export function materialIndex(sources, { documents, sections = [] } = {}) {
  const list = (Array.isArray(sources) ? sources : []).filter(source => source && typeof source.id === 'string');
  // A source no material list holds (an older version, a source that is not a document) is still a selected material: itself.
  const items = groupSourcesByDocument(list, { documents }), listed = new Set(items.flatMap(item => item.sourceIds));
  for (const source of list) if (!listed.has(source.id)) items.push({ key: `${sourceItemKey(source)}`, title: String(source.title ?? ''), sourceIds: [source.id] });
  const keyOfSource = versionKeys(items, documents), titleOf = new Map(items.map(item => [item.key, item.title]));
  const ownKey = section => sectionMaterialKey(keyOfSource.get(section.sourceId) ?? `source:${section.sourceId}`, section);
  // A recording that carries on in the next volume (lib/sections.js `continued`) is the same recording, also when the volumes were not imported as one batch.
  const alias = new Map(), seen = new Map();
  for (const section of sections) {
    if (section.recording == null) continue;
    const key = ownKey(section), before = (seen.get(section.recording) || []).filter(item => item.sourceId !== section.sourceId).at(-1);
    if (section.continued && before && before.key !== key && !alias.has(key)) alias.set(key, alias.get(before.key) ?? before.key);
    if (!seen.has(section.recording)) seen.set(section.recording, []);
    seen.get(section.recording).push({ key, sourceId: section.sourceId });
  }
  const keyOfSection = section => { const key = ownKey(section); return alias.get(key) ?? key; };
  const recordingTitle = new Map();
  for (const section of sections) if (section.kind === 'recording' && section.recording != null) { const key = keyOfSection(section); if (!recordingTitle.has(key) && section.title) recordingTitle.set(key, section.title); }
  const byKey = new Map(), order = [];
  const entry = (key, base) => {
    let found = byKey.get(key);
    if (!found) { found = { key, title: recordingTitle.get(key) || titleOf.get(base) || '', kind: key === base ? 'document' : 'recording', sourceIds: [], sections: 0, chars: 0 }; byKey.set(key, found); order.push(found); }
    return found;
  };
  // Every document is a material, the one whose leaves are all empty too; a transcript's recordings are materials of their own.
  for (const source of list) {
    const base = keyOfSource.get(source.id), own =sections.filter(section => section.sourceId === source.id && section.leaf);
    const keys = [...new Set(own.map(keyOfSection))];
    if (!keys.length) keys.push(base);
    for (const key of keys) { const found = entry(key, base); if (!found.sourceIds.includes(source.id)) found.sourceIds.push(source.id); }
    for (const section of own) { const found = entry(keyOfSection(section), base); if (Number(section.chars) > 0) { found.sections += 1; found.chars += Number.isFinite(section.evidenceChars) ? section.evidenceChars : Number(section.chars) || 0; } }
  }
  const sparse = new Set(list.filter(source => source.document?.sparseText === true).map(source => source.id));
  for (const found of order) {
    if (!found.sections) found.reason = 'no-text';
    else if (found.sourceIds.every(id => sparse.has(id))) found.reason = 'sparse';
  }
  return { list: order, keyOfSource, keyOfSection };
}

/** The materials that can get a question (the others are said with their reason). */
export const usableMaterials = index => index.list.filter(item => item.reason !== 'no-text');

/* ---------- a plain run (lib/batch.js): the same materials in the pieces of a group ---------- */

const RECORDING_HEAD = /^## (\d{1,3})\.[ \t]+(\S[^\n]*?)[ \t]*\r?$/gm;

/**
 * The pieces of a group cut by material: the pieces of one document together, and a transcript cut at its recordings (`## N. file`). Each piece remembers where it was cut
 * (lib/sections.js withSliceRange), so a quote from it still checks against the whole source. -> [{ key, title, sources }] in reading order.
 */
export function materialPieces(sources) {
  const out = [], byKey = new Map();
  const add = (key, title, piece) => { let found = byKey.get(key); if (!found) { found = { key, title, sources: [] }; byKey.set(key, found); out.push(found); } found.sources.push(piece); };
  for (const source of Array.isArray(sources) ? sources : []) {
    if (!source || typeof source.text !== 'string') continue;
    const base = sourceItemKey(source), title = String(source.title ?? '');
    const heads = source.audio ? [...source.text.matchAll(RECORDING_HEAD)] : [];
    if (!heads.length) { add(base, title, source); continue; }
    const range = sliceRangeOf(source);
    // The text before the first heading: at the start of a source it is the file's title, read with the first recording; in a slice cut inside a recording it carries on that recording, a piece of its own.
    const carried = range.start > 0 && heads[0].index > 0 && source.text.slice(0, heads[0].index).trim();
    const cuts = [...(carried ? [{ at: 0, key: `${base}#cont`, title }] : []),
      ...heads.map((match, index) => ({ at: index === 0 && !carried ? 0 : match.index, key: `${base}#r${match[1]}`, title: match[2] }))];
    cuts.forEach((cut, index) => {
      const end = index + 1 < cuts.length ? cuts[index + 1].at : source.text.length;
      if (!source.text.slice(cut.at, end).trim()) return;
      add(cut.key, cut.title, withSliceRange({ ...source, text: source.text.slice(cut.at, end) }, range.start + cut.at, range.start + end));
    });
  }
  return out;
}

/** How many materials a group of pieces holds (the planner is told to spread its points over all of them when there are several). */
export const materialCount = sources => materialPieces(sources).length;

/** Share `count` over `sizes` by size (largest remainder, then the earlier one), then at least one each while the count allows: a share of 0 takes one from the largest share (never below one). */
export function shareAtLeastOne(sizes, count) {
  const n = sizes.length, total = Math.max(0, Math.floor(count));
  if (!n) return [];
  if (total < n) {
    // Fewer questions than materials: the largest get one each (reading order on ties).
    const shares = new Array(n).fill(0);
    [...sizes.keys()].sort((a, b) => sizes[b] - sizes[a] || a - b).slice(0, total).forEach(index => { shares[index] = 1; });
    return shares;
  }
  const sum = sizes.reduce((acc, value) => acc + Math.max(0, value), 0) || 1, raw = sizes.map(value => Math.max(0, value) / sum * total), shares = raw.map(Math.floor);
  let left = total - shares.reduce((acc, value) => acc + value, 0);
  const order = raw.map((value, index) => [value - Math.floor(value), index]).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (let k = 0; left > 0; k++, left--) shares[order[k % n][1]] += 1;
  for (let index = 0; index < n; index++) {
    if (shares[index] > 0) continue;
    const donor = shares.reduce((best, value, at) => (value > shares[best] ? at : best), 0);
    shares[donor] -= 1; shares[index] = 1;
  }
  return shares;
}

/* ---------- what is said about the materials ---------- */

/** The most materials a report names one by one (the count says how many more). */
export const REPORT_ROWS = 12;
const MAX_KEYS = 120;

/**
 * BEFORE a run (the creation form, lib/token-estimate.js): what the plan does for each material, from the same plan the run is made with.
 * `rounds`: lib/coverage-plan.js coveragePlan's (their assignments carry `material`); `auto`: whether the rounds after the first run by themselves (else only round 1 is made before the learner presses again).
 * -> { selected, planned, missing: [{ key, title, reason: 'no-text' | 'squeezed' | 'round', round? }], more, raised? }   `planned`: the materials that get a question in what runs now.
 */
export function materialForecast({ materials, plan, rounds = [], auto = true } = {}) {
  const list = materials?.list || [], firstRound = new Map();
  rounds.forEach((round, index) => { for (const item of round.assignments || []) if (item.material && !firstRound.has(item.material)) firstRound.set(item.material, index + 1); });
  const missing = [];
  for (const item of list) {
    if (item.reason === 'no-text') missing.push({ key: item.key, title: item.title, reason: 'no-text' });
    else if (!firstRound.has(item.key)) missing.push({ key: item.key, title: item.title, reason: 'squeezed' });
    else if (!auto && firstRound.get(item.key) > 1) missing.push({ key: item.key, title: item.title, reason: 'round', round: firstRound.get(item.key) });
  }
  return { selected: list.length, planned: list.length - missing.length, missing: missing.slice(0, REPORT_ROWS), more: Math.max(0, missing.length - REPORT_ROWS), ...(plan?.raised ? { raised: plan.raised } : {}) };
}

const STOPPED = new Set(['learner', 'budget', 'sections-left', 'no-progress', 'refused', 'round-failed']);

/** Why a material that has no question has none, from what the draft already holds (its plan, the attempts of its sections, the marker of its run, the plain run's record). */
function reasonOf(item, sections, { spec, marker, needsTopUp = [] }) {
  if (item.reason === 'no-text' || !sections.length) return { reason: 'no-text' };
  const keys = new Set(sections.map(section => section.key));
  const gap = needsTopUp.find(entry => entry?.key === item.key || (entry?.title === item.title && (entry.sourceIds || []).some(id => item.sourceIds.includes(id))));
  const attempts = Object.entries(spec?.attempts || {}).filter(([key]) => keys.has(key)).map(([, record]) => record).sort((a, b) => (b.round || 0) - (a.round || 0) || (b.n || 0) - (a.n || 0));
  if (attempts.some(record => record?.short?.why === 'refused' || record?.reason === 'refused')) return { reason: 'refused' };
  if (attempts.length) { const code = attempts[0].reason || 'other'; return ['plan-short', 'unavailable'].includes(code) ? { reason: code, tries: attempts[0].n || 1 } : { reason: 'failed', code, tries: attempts[0].n || 1 }; }
  if (gap) return { reason: 'insufficient-evidence' };
  if (spec?.quotas) {
    const planned = new Set(spec.quotas.map(entry => entry.sectionId));
    if (![...keys].some(key => planned.has(key))) {
      if ((spec.droppedKeys || []).some(key => keys.has(key))) return { reason: 'squeezed' };
      return { reason: spec.level === 'lean' ? 'lean' : 'not-planned' };
    }
    // Its sections wait in a round that has not run (for them).
    const waiting = (Array.isArray(spec.rounds) ? spec.rounds : []).findIndex(round => round?.status !== 'done' && round?.status !== 'skipped' && (round?.sectionIds || []).some(key => keys.has(key)) && !(round?.triedKeys || []).some(key => keys.has(key)));
    if (waiting >= 0) {
      const round = spec.rounds[waiting].round ?? waiting + 1;
      if (marker?.stop && STOPPED.has(marker.stop.reason)) return { reason: 'stopped', stop: marker.stop.reason, round };
      if (marker?.state === 'running') return { reason: 'running', round };
      return { reason: 'waiting', round };
    }
  }
  const failed = sections.find(section => section.state === 'planned-failed' && section.reason);
  if (failed) return ['plan-short', 'unavailable', 'refused'].includes(failed.reason) ? { reason: failed.reason } : { reason: 'failed', code: failed.reason };
  return { reason: 'not-planned' };
}

/**
 * AFTER a run (the draft page, the `coverage.get` of a draft): what came of each material, read LIVE from the coverage of the draft (lib/coverage.js coverageOf over its questions now), never from
 * the snapshot one run left. `coverage`: the draft's coverage (its sections with their state); `spec` / `marker`: editorial.coverageSpec / coverageRun; `needsTopUp`: the plain run's record.
 * -> { selected, covered, missing, rows: [{ key, title, kind, sections, reason, round?, stop?, code?, tries?, sparse?, keys }], more, raised?, missingSources? }
 *    `rows` are the materials WITHOUT a question (the reason and the sections a 补题 for it asks: `keys`, at most MAX_KEYS).
 */
export function materialReport({ materials, coverage, spec, marker, needsTopUp, missingSources = 0 } = {}) {
  const list = materials?.list || [], bySection = new Map();
  for (const section of coverage?.sections || []) { const key = materials.keyOfSection(section); if (!bySection.has(key)) bySection.set(key, []); bySection.get(key).push(section); }
  const rows = [];
  let covered = 0;
  for (const item of list) {
    const sections = bySection.get(item.key) || [];
    if (sections.some(section => section.state === 'covered')) { covered += 1; continue; }
    rows.push({ key: item.key, title: item.title, kind: item.kind, sections: sections.length, ...reasonOf(item, sections, { spec, marker, needsTopUp: Array.isArray(needsTopUp) ? needsTopUp : [] }),
      ...(item.reason === 'sparse' ? { sparse: true } : {}), keys: sections.map(section => section.key).slice(0, MAX_KEYS) });
  }
  return { selected: list.length, covered, missing: rows.length, rows: rows.slice(0, REPORT_ROWS), more: Math.max(0, rows.length - REPORT_ROWS),
    ...(spec?.raised ? { raised: spec.raised } : {}), ...(missingSources > 0 ? { missingSources } : {}) };
}
