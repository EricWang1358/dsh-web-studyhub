/* materials.outline.suggest / save / segment / clear: the AI re-outline of a document and its use as the document's chapters.

   One kept outline per document REVISION, stored with the document's own records: on the version of a stored document,
   or, for a document with no record (an audio transcript or a recording of several files, an early import, a pasted
   text), on the first source of the document the 资料 page shows. Applying it as the chapters (segment) only records a
   level; every consumer reads the result through groupSourcesByDocument (lib/source-groups.js). Nothing here writes a
   text, a source id, a page number, a selection or a card link, and a new revision never inherits an outline. */
import { planOutline, outlinePrompt, validateOutline } from './outline.js';
import { estimateRun, createTextMeasure } from '../../token-estimate.js';
import { addUsage } from '../../token-usage.js';
import { withUsageSink } from '../../usage-scope.js';
import { groupSourcesByDocument } from '../../source-groups.js';
import { chaptersOfOutline, groupRevision, stampSegmentations } from '../../document-outline.js';

const clone = value => structuredClone(value);
const LEVELS = [1, 2, 3];
const MODES = ['outline', 'chapters'];

/**
 * What an outline belongs to: { id, revision, legacy, sourceIds } (sourceIds in reading order). A stored document is its
 * version; a document with no record is the 资料 item its source belongs to (one PDF's pages, the files of one recording,
 * one text), whose revision is the hash of its texts, like the revision materials gives a single source.
 */
function unitOf(state, document, version) {
  const item = groupSourcesByDocument(state.sources).find(group => group.sourceIds.includes(version.sourceIds[0]));
  const same = item && item.sourceIds.length === version.sourceIds.length && version.sourceIds.every(id => item.sourceIds.includes(id));
  if (!document.legacy) return { id: document.id, revision: version.revision, legacy: false, sourceIds: same ? [...item.sourceIds] : [...version.sourceIds] };
  const ids = item ? [...item.sourceIds] : [...version.sourceIds], members = ids.map(id => state.sources.find(source => source.id === id)).filter(Boolean);
  return { id: item?.documentId || document.id, revision: groupRevision(members), legacy: true, sourceIds: ids };
}

const holderOf = (state, unit) => unit.legacy
  ? state.sources.find(source => source.id === unit.sourceIds[0])
  : state.documents.find(document => document.id === unit.id)?.versions.find(version => version.revision === unit.revision);
const keptOutline = (state, unit) => { const outline = holderOf(state, unit)?.outline; return outline?.revision === unit.revision ? outline : null; };

/** The newest outline kept for another revision of the same document, as a short note. */
function staleOutline(state, document, unit) {
  const kept = unit.legacy ? [holderOf(state, unit)?.outline] : document.versions.map(version => version.outline);
  const old = kept.filter(outline => outline && outline.revision !== unit.revision).sort((a, b) => String(b.savedAt).localeCompare(String(a.savedAt)))[0];
  return old ? { revision: old.revision, savedAt: old.savedAt, entries: old.entries.length } : null;
}

/** For a document descriptor: the kept outline of the revision, or a note that only an older revision has one. */
export function outlineDescriptor(state, document, version) {
  // A library with no outline anywhere (nearly all of them) pays nothing: a document with no record needs its group only to find one.
  if (document.legacy ? !state.sources.some(source => source.outline) : !document.versions.some(item => item.outline)) return {};
  const unit = unitOf(state, document, version), kept = keptOutline(state, unit), stale = kept ? null : staleOutline(state, document, unit);
  return { ...(kept ? { outline: clone(kept) } : {}), ...(stale ? { outlineStale: stale } : {}) };
}

const cleanUsage = usage => {
  const fields = ['uncachedInputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'calls'];
  if (!usage || typeof usage !== 'object' || !fields.every(field => usage[field] === undefined || Number.isSafeInteger(usage[field]) && usage[field] >= 0)) return null;
  return Object.fromEntries(fields.map(field => [field, usage[field] ?? 0]));
};
const modeOf = value => value === undefined ? 'outline' : MODES.includes(value) ? value : (() => { throw new Error('Outline mode must be outline or chapters'); })();
const levelOf = value => { if (!LEVELS.includes(value)) throw new Error('Segmentation level must be 1, 2 or 3'); return value; };

const chapterRow = chapter => ({ index: chapter.index, title: chapter.title, level: chapter.level, front: !!chapter.front, startPage: chapter.startPage, endPage: chapter.endPage,
  sources: chapter.sourceIds.length, chars: chapter.chars, partial: !!chapter.partial, startOffset: chapter.startOffset ?? 0, ...(chapter.startSourceId ? { startSourceId: chapter.startSourceId } : {}) });
const sameChapter = chapter => `${chapter.title}|${chapter.level}|${chapter.sourceIds.join(',')}|${chapter.startOffset ?? 0}`;

export function createOutlineHandlers({ read, update, complete, findDocument, versionOf, empty }) {
  const targetOf = (state, args) => {
    const document = findDocument(state, args), version = versionOf(document, document.legacy ? undefined : args.revision), unit = unitOf(state, document, version);
    if (document.legacy && args.revision && ![unit.revision, version.revision].includes(args.revision)) throw new Error('Material document revision not found');
    return { document, version, unit };
  };
  const recordsOf = (state, unit) => unit.sourceIds.map(id => state.sources.find(source => source.id === id)).filter(Boolean);

  /** The chapters of a document as the accessor reads them, with `outline` applied at `level` (none: as it is without one). */
  const chaptersWith = (state, unit, outline, level) => {
    const members = recordsOf(state, unit);
    const view = level ? [{ documentId: unit.id, revision: unit.revision, sourceIds: unit.sourceIds, level, chapters: chaptersOfOutline(outline, level), savedAt: outline.savedAt }] : [];
    const item = groupSourcesByDocument(stampSegmentations(members, view)).find(group => group.sourceIds.includes(unit.sourceIds[0]));
    return { chapters: item?.chapters || [], applied: !!item?.segmentation, unit: item?.chapterUnit };
  };
  const levelView = (state, unit, outline, level) => {
    const { chapters, applied } = chaptersWith(state, unit, outline, level);
    return { count: applied ? chapters.length : 0, partialCount: chapters.filter(chapter => chapter.partial).length, chapters: applied ? chapters.map(chapterRow) : [] };
  };

  const handlers = {
    'materials.outline.suggest': async (args, request = {}) => {
      const state = empty(await read()), { document, unit } = targetOf(state, args), mode = modeOf(args.mode);
      const plan = planOutline(recordsOf(state, unit)), base = { documentId: unit.id, revision: unit.revision, mode };
      if (!plan.units.length) return { status: 'empty', ...base, message: 'This document has no text to outline.' };
      const coverage = { blocks: plan.blocks, units: plan.units.length, chars: plan.chars, condensed: plan.condensed, sources: unit.sourceIds.length };
      const model = complete || request.complete, { system, prompt } = outlinePrompt(plan, { title: document.title, language: args.language, mode });
      if (args.estimate === true) return { status: 'estimate', ...base, coverage, modelAvailable: !!model,
        estimate: estimateRun('outline', { system, prompt, units: plan.units.length, mode }, { measure: createTextMeasure({ tokenMeter: request.tokenMeter }) }) };
      if (!model) return { status: 'unavailable', capability: 'model', ...base, coverage, message: 'A model connection is required to propose an outline.' };
      request.signal?.throwIfAborted();
      // One call; what the provider reports for it comes back with the answer (the ledger hears about it as for any call).
      let usage = null;
      const answer = await withUsageSink({ key: `outline:${unit.id}:${unit.revision}`, sink: (report, meta = {}) => { usage = addUsage(usage, { ...report, calls: meta.calls ?? 1 }); } },
        () => model(system, prompt, { signal: request.signal }));
      request.signal?.throwIfAborted();
      const checked = validateOutline(answer, plan, { mode });
      if (!checked.ok) return { status: 'rejected', ...base, coverage, code: checked.code, message: checked.message, usage };
      return { status: 'proposed', ...base, coverage, entries: checked.entries, warnings: checked.warnings, usage };
    },

    'materials.outline.save': async args => {
      if (!Array.isArray(args.entries)) throw new Error('Outline entries are required');
      const usage = cleanUsage(args.usage), mode = modeOf(args.mode), level = args.segmentLevel === undefined ? null : levelOf(args.segmentLevel);
      return update(state => {
        const { unit } = targetOf(empty(state), args), plan = planOutline(recordsOf(empty(state), unit));
        const checked = validateOutline({ outline: args.entries.map(({ title, level: entryLevel, startBlock }) => ({ title, level: entryLevel, startBlock })) }, plan, { mode });
        if (!checked.ok) throw new Error(`Outline is not valid (${checked.code}): ${checked.message}`);
        const holder = holderOf(empty(state), unit);
        if (!holder) throw new Error('Material document revision not found');
        const now = new Date().toISOString(), outline = { revision: unit.revision, savedAt: now, source: 'ai', mode, entries: checked.entries, units: plan.units.length, condensed: plan.condensed,
          ...(usage ? { usage } : {}) };
        if (level) {
          if (!chaptersOfOutline(outline, level).length) throw new Error('Segmentation level has no entries in this outline');
          outline.segmentation = { level, appliedAt: now };
        }
        holder.outline = outline;
        return { saved: true, documentId: unit.id, revision: unit.revision, warnings: checked.warnings, outline: clone(outline) };
      });
    },

    'materials.outline.segment': async args => {
      const state = empty(await read()), { unit } = targetOf(state, args), outline = keptOutline(state, unit);
      if (!outline) throw new Error('Keep an outline for this document revision before segmenting by it');
      const base = { documentId: unit.id, revision: unit.revision }, now = chaptersWith(state, unit, outline, outline.segmentation?.level);
      if (args.preview === true || args.level === undefined) {
        const heuristic = outline.segmentation ? chaptersWith(state, unit, outline, null).chapters.length : now.chapters.length;
        return { status: 'preview', ...base, applied: outline.segmentation?.level ?? null, unit: now.unit || chaptersWith(state, unit, outline, 1).unit || 'text',
          current: { count: now.chapters.length, source: outline.segmentation ? 'segmentation' : heuristic ? 'converted' : 'none' },
          levels: Object.fromEntries(LEVELS.map(level => [level, levelView(state, unit, outline, level)])) };
      }
      const level = args.level === null ? null : levelOf(args.level);
      let after = { chapters: now.chapters, applied: !!outline.segmentation };
      if (level) {
        after = chaptersWith(state, unit, outline, level);
        if (!after.applied) throw new Error('This document cannot be segmented by this outline');
      } else if (outline.segmentation) after = chaptersWith(state, unit, outline, null);
      const beforeKeys = new Set(now.chapters.map(sameChapter)), afterKeys = new Set(after.chapters.map(sameChapter));
      const result = { ...base, level, chapters: level ? after.chapters.length : 0, previous: now.chapters.length,
        changed: level ? after.chapters.filter(chapter => !beforeKeys.has(sameChapter(chapter))).length : 0,
        removed: now.chapters.filter(chapter => !afterKeys.has(sameChapter(chapter))).length };
      if (level && outline.segmentation?.level === level) return { applied: true, ...result };
      if (!level && !outline.segmentation) return { applied: false, cleared: false, ...result };
      await update(own => {
        const holder = holderOf(empty(own), unit);
        if (!holder?.outline || holder.outline.revision !== unit.revision) throw new Error('Material document revision not found');
        if (level) holder.outline.segmentation = { level, appliedAt: new Date().toISOString() };
        else delete holder.outline.segmentation;
      });
      return level ? { applied: true, ...result } : { applied: false, cleared: true, ...result };
    },

    'materials.outline.clear': async args => {
      const state = empty(await read()), { unit } = targetOf(state, args), kept = keptOutline(state, unit), base = { documentId: unit.id, revision: unit.revision };
      if (!kept) return { cleared: false, hadSegmentation: false, ...base };
      await update(own => { delete holderOf(empty(own), unit)?.outline; });
      return { cleared: true, hadSegmentation: !!kept.segmentation, ...base };
    },
  };
  return handlers;
}
