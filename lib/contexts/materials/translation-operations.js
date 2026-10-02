/* materials.translation.*: the bilingual reading of a document's text (the reader's 译).

   A translation is kept per document REVISION, beside the document's own records, like a kept AI outline: on the version of a
   stored document, or, for a document with no record (a recording, an early import, a pasted text), on the first source of
   the document the 资料 page shows. The glossary and the chosen target language belong to the document, not to one revision.
   A new revision never inherits a translation: the old ones are listed as stale (and their words are reused where a passage is
   unchanged, which costs no model call). Nothing here writes a text, a source id, a page number, a selection, a citation or a
   card link; the pure rules (paragraphs, keys, language, glossary, prompt, checks) are lib/passage-translation.js.

   A passage is a paragraph of the stored text (the reader sends the paragraph it drew and which occurrence of it that is) or a
   selected passage (with the context the reader captured). Passages are checked against the stored text of the revision, so
   only text the document holds is ever translated. */
import {
  TARGETS, TRANSLATION_LIMITS, cacheKey, compactText, defaultTarget, glossaryFor, glossaryHash, needsTranslation, normalizeGlossary,
  paragraphKey, parseTranslationReply, locateParagraph, planBatches, splitForModel, splitParagraphs, textHash, translationPrompt, validateTranslation,
} from '../../passage-translation.js';
import { estimateRun, createTextMeasure } from '../../token-estimate.js';
import { addUsage } from '../../token-usage.js';
import { withUsageSink } from '../../usage-scope.js';
import { groupSourcesByDocument } from '../../source-groups.js';
import { chaptersOfOutline, stampSegmentations } from '../../document-outline.js';
import { holderOf, unitOf } from './outline-operations.js';

const clone = value => structuredClone(value);
const iso = () => new Date().toISOString();
const MAX_PASSAGES = 500, MAX_PASSAGE_CHARS = 20000, AFFECTED_LIMIT = 200;
const LINE_FORMATS = new Set(['md', 'html']);
const text = value => typeof value === 'string' ? value : '';
/** Calls that named a requestId, so the reader can stop one it is waiting for (materials.translation.cancel). */
const inflight = new Map();

const concurrencyOf = value => {
  const { min, max, default: fallback } = TRANSLATION_LIMITS.concurrency;
  return Number.isInteger(value) ? Math.min(max, Math.max(min, value)) : fallback;
};
const targetFrom = value => {
  if (!TARGETS.includes(value)) throw new Error('Translation target must be zh or en');
  return value;
};

/** An item as the reader gets it. */
const view = (item, outdated = false) => ({ key: item.key, kind: item.kind || 'paragraph', sourceId: item.sourceId, start: item.start, end: item.end, ordinal: item.ordinal ?? 0, hash: item.hash,
  quote: item.quote, ...(item.prefix !== undefined ? { prefix: item.prefix, suffix: item.suffix } : {}), target: item.target, text: item.text, version: item.version,
  ...(item.comment ? { comment: item.comment } : {}), history: clone(item.history || []), warnings: [...(item.warnings || [])], parts: item.parts || 1,
  ...(item.reused ? { reused: true } : {}), at: item.at, updatedAt: item.updatedAt, outdated });

export function createTranslationHandlers({ read, update, complete, findDocument, versionOf, empty }) {
  const targetOf = (state, args) => {
    const document = findDocument(state, args), version = versionOf(document, document.legacy ? undefined : args.revision), unit = unitOf(state, document, version);
    if (document.legacy && args.revision && ![unit.revision, version.revision].includes(args.revision)) throw new Error('Material document revision not found');
    return { document, version, unit };
  };
  const recordsOf = (state, unit) => unit.sourceIds.map(id => state.sources.find(source => source.id === id)).filter(Boolean);
  const currentOf = (state, unit) => { const kept = holderOf(state, unit)?.translations; return kept?.revision === unit.revision ? kept : null; };
  /** Where a document's glossary and target live: its record, or, with no record, its first source. */
  const settingsHolder = (state, unit, document) => document.legacy ? state.sources.find(source => source.id === unit.sourceIds[0]) : state.documents.find(item => item.id === document.id);
  const settingsOf = (state, unit, document, args, request) => {
    const saved = settingsHolder(state, unit, document)?.translationSettings || {};
    const asked = args.target === undefined || args.target === null ? undefined : targetFrom(args.target);
    return { target: asked ?? (TARGETS.includes(saved.target) ? saved.target : defaultTarget(request.language)),
      targetSource: asked ? 'request' : TARGETS.includes(saved.target) ? 'document' : 'default', glossary: normalizeGlossary(saved.glossary) };
  };
  /** Items of other revisions of the same document (stored documents keep one record per version). */
  const otherRecords = (state, document, unit) => document.legacy ? [] : (state.documents.find(item => item.id === document.id)?.versions || [])
    .filter(version => version.revision !== unit.revision && version.translations?.items?.length).map(version => ({ revision: version.revision, items: version.translations.items, savedAt: version.translations.updatedAt }));
  const formatOf = document => LINE_FORMATS.has(document.format);
  /** The chapters of a document as every other consumer reads them: the accessor of lib/source-groups.js, with the kept outline applied as the segmentation. */
  const chaptersOf = (state, unit) => {
    const outline = holderOf(state, unit)?.outline, kept = outline?.revision === unit.revision && outline.segmentation ? outline : null;
    const views = kept ? [{ documentId: unit.id, revision: unit.revision, sourceIds: unit.sourceIds, level: kept.segmentation.level, chapters: chaptersOfOutline(kept, kept.segmentation.level), savedAt: kept.savedAt }] : [];
    return groupSourcesByDocument(stampSegmentations(recordsOf(state, unit), views)).find(group => group.sourceIds.includes(unit.sourceIds[0]))?.chapters || [];
  };

  /* ---------- which passages ---------- */

  const unlocated = (index, input, code, message) => ({ index, input, status: 'unlocated', code, message });

  /** Explicit passages (a paragraph the reader drew, a selection) located in the stored text of the revision. */
  function fromPassages(records, format, passages) {
    if (!Array.isArray(passages)) throw new Error('Passages are required');
    if (passages.length > MAX_PASSAGES) throw new Error(`Translate at most ${MAX_PASSAGES} passages at a time`);
    const blocks = new Map(records.map(record => [record.id, splitParagraphs(record.text, { lines: format })]));
    return passages.map((input, index) => {
      if (!input || typeof input !== 'object' || !text(input.text).trim()) return unlocated(index, input, 'empty', 'The passage has no text.');
      if (input.text.length > MAX_PASSAGE_CHARS) return unlocated(index, input, 'too-long', 'The passage is too long to translate in one piece.');
      const record = records.find(item => item.id === input.sourceId) || (!input.sourceId && records.length === 1 ? records[0] : null);
      if (!record) return unlocated(index, input, 'source', 'The passage is not in this document.');
      const selection = input.kind === 'selection';
      const hit = selection ? locateParagraph(record.text, input.text, Number.isInteger(input.ordinal) ? input.ordinal : undefined, { prefix: text(input.prefix), suffix: text(input.suffix) })
        : locateParagraph(record.text, input.text, Number.isInteger(input.ordinal) && input.ordinal >= 0 ? input.ordinal : 0);
      if (hit.status !== 'resolved') return unlocated(index, input, hit.status, hit.status === 'ambiguous' ? 'The selected text appears more than once; select a little more around it.' : 'The passage is not in this document.');
      const stored = record.text.slice(hit.start, hit.end), block = blocks.get(record.id).find(item => item.start === hit.start && item.end === hit.end);
      if (selection && !block) return { index, input, kind: 'selection', sourceId: record.id, start: hit.start, end: hit.end, ordinal: 0, text: stored, prefix: text(input.prefix).slice(-80), suffix: text(input.suffix).slice(0, 80),
        key: `sel:${record.id}|${textHash(stored)}|${hit.start}`, force: input.force === true };
      const ordinal = Number.isInteger(input.ordinal) && input.ordinal >= 0 && !selection ? input.ordinal : block?.ordinal ?? 0;
      return { index, input, kind: 'paragraph', sourceId: record.id, start: hit.start, end: hit.end, ordinal, text: stored, key: paragraphKey(record.id, { text: stored, ordinal }), force: input.force === true };
    });
  }

  /**
   * Every paragraph of some sources, or of one chapter, the way the reader draws them. A chapter is what the effective segmentation says:
   * whole pages, and where a chapter starts inside a page (or inside a single text) only the paragraphs from there to where the next one starts.
   */
  function fromScope(records, format, scope, chapters = []) {
    const ranges = new Map();
    if (Number.isInteger(scope?.chapter)) {
      const at = chapters.findIndex(item => item.index === scope.chapter), chapter = chapters[at], next = chapters[at + 1];
      if (!chapter) return [];
      const clip = (id, from, to) => { const old = ranges.get(id) || [0, Infinity]; ranges.set(id, [Math.max(old[0], from), Math.min(old[1], to)]); };
      for (const id of chapter.sourceIds) clip(id, 0, Infinity);
      if (chapter.startSourceId) clip(chapter.startSourceId, chapter.startOffset || 0, Infinity);
      if (next?.startSourceId && ranges.has(next.startSourceId)) clip(next.startSourceId, 0, next.startOffset || 0);
    } else {
      for (const id of Array.isArray(scope?.sourceIds) ? scope.sourceIds.filter(item => typeof item === 'string') : records.map(record => record.id)) ranges.set(id, [0, Infinity]);
    }
    const entries = [];
    for (const record of records) {
      const range = ranges.get(record.id);
      if (!range) continue;
      for (const block of splitParagraphs(record.text, { lines: format }).filter(item => item.start >= range[0] && item.start < range[1])) entries.push({ index: entries.length, input: block, kind: 'paragraph', sourceId: record.id, start: block.start, end: block.end,
        ordinal: block.ordinal, text: block.text, key: paragraphKey(record.id, block), force: false });
    }
    return entries;
  }

  /**
   * Decide, for each located passage, what happens to it: 'cached' (it has a translation), 'skipped' (nothing to translate),
   * 'reused' (the same words are translated already, here or in an older revision), or it goes to the model ('todo').
   */
  function classify(entries, { current, others, target, glossary, retranslate }) {
    const existing = new Map((current?.items || []).filter(item => item.target === target).map(item => [item.key, item]));
    const reusable = new Map();
    for (const item of [...(current?.items || []), ...others.flatMap(record => record.items)]) if (item.target === target && item.cache && !reusable.has(item.cache)) reusable.set(item.cache, item);
    for (const entry of entries) {
      if (entry.status === 'unlocated') continue;
      entry.glossary = glossaryFor(entry.text, glossary);
      entry.cache = cacheKey({ text: entry.text, target, glossary });
      const prior = existing.get(entry.key);
      if (prior) entry.prior = prior;
      if (prior && !retranslate) {
        entry.status = 'cached'; entry.item = prior; entry.outdated = prior.cache !== entry.cache;
      } else if (!entry.force && !needsTranslation(entry.text, target)) {
        entry.status = 'skipped'; entry.code = 'same-language';
      } else if (!retranslate && reusable.has(entry.cache)) {
        entry.status = 'reused'; entry.from = reusable.get(entry.cache);
      } else entry.status = 'todo';
    }
    return entries;
  }

  const stateOf = entry => entry.status === 'todo' ? 'todo' : entry.status === 'cached' ? 'done' : entry.status === 'reused' ? 'reuse' : entry.status === 'skipped' ? 'skip' : 'missing';

  /** The model's work: leaders (one per set of identical words) cut into parts, batched. */
  function tasksOf(entries, { retranslate }) {
    const leaders = new Map(), tasks = [];
    for (const entry of entries.filter(item => item.status === 'todo')) {
      const same = retranslate ? null : leaders.get(entry.cache);
      if (same) { same.followers.push(entry); continue; }
      const { parts, split } = splitForModel(entry.text);
      const task = { id: tasks.length, entry, followers: [], parts, split, answers: new Map(), left: parts.length };
      tasks.push(task);
      if (!retranslate) leaders.set(entry.cache, task);
    }
    return tasks;
  }
  const unitsOf = tasks => tasks.flatMap(task => task.parts.map((part, at) => ({ id: task.parts.length > 1 ? `p${task.id}.${at}` : `p${task.id}`, text: part, task, part: at })));
  const batchGlossary = (units, glossary) => {
    const seen = new Map();
    for (const unit of units) for (const entry of glossaryFor(unit.text, glossary)) seen.set(entry.term.toLowerCase(), entry);
    return [...seen.values()];
  };

  /* ---------- storing ---------- */

  const itemOf = (entry, { text: translated, warnings = [], parts = 1, comment = '', from = null }) => {
    const prior = entry.prior, now = iso(), selection = entry.kind === 'selection';
    const history = prior ? [...(prior.history || []), { version: prior.version, text: prior.text, ...(prior.comment ? { comment: prior.comment } : {}), at: prior.updatedAt || prior.at }].slice(-TRANSLATION_LIMITS.maxHistory) : [];
    return { key: entry.key, kind: entry.kind, sourceId: entry.sourceId, start: entry.start, end: entry.end, ordinal: entry.ordinal, hash: textHash(entry.text), cache: entry.cache,
      quote: selection ? entry.text : entry.text.slice(0, 80), ...(selection ? { prefix: entry.prefix || '', suffix: entry.suffix || '' } : {}),
      target: from?.target ?? entry.target, text: translated, glossaryHash: glossaryHash(entry.glossary), version: (prior?.version || 0) + 1, ...(comment ? { comment } : {}), history,
      warnings, parts, ...(from ? { reused: true } : {}), at: prior?.at ?? now, updatedAt: now };
  };

  /** Write items to the revision's record (one transaction, atomic). Returns the items as stored. */
  const persist = (args, items) => items.length ? update(state => {
    const own = empty(state), { unit } = targetOf(own, args), holder = holderOf(own, unit);
    if (!holder) throw new Error('Material document revision not found');
    const record = holder.translations?.revision === unit.revision ? holder.translations : (holder.translations = { revision: unit.revision, items: [] });
    for (const item of items) {
      const at = record.items.findIndex(kept => kept.key === item.key && kept.target === item.target);
      if (at >= 0) record.items[at] = item; else record.items.push(item);
    }
    record.updatedAt = iso();
    return items.length;
  }) : Promise.resolve(0);

  /* ---------- the model's turn ---------- */

  async function runTasks({ tasks, model, target, glossary, comment, title, signal, concurrency, onTaskDone }) {
    const units = unitsOf(tasks), batches = planBatches(units.map(unit => ({ ...unit })));
    let next = 0;
    const finishTask = async task => {
      if (task.done) return;
      task.done = true;
      const texts = [...task.answers.entries()].sort((a, b) => a[0] - b[0]).map(([, answer]) => answer.text);
      const joined = texts.join(target === 'zh' ? '' : ' '), warnings = [...new Set([...task.answers.values()].flatMap(answer => answer.warnings))];
      await onTaskDone(task, { text: joined, warnings, parts: task.parts.length });
    };
    const failTask = (task, failure) => { if (!task.failure) { task.failure = failure; task.done = true; } };
    const doBatch = async batch => {
      let pending = batch;
      const failures = new Map();
      for (const attempt of [0, 1]) {
        if (!pending.length) break;
        signal?.throwIfAborted();
        const single = pending.length === 1 && pending[0].task.entry.prior && pending[0].task.parts.length === 1 ? pending[0].task.entry.prior.text : '';
        const { system, prompt } = translationPrompt({ target, passages: pending.map(unit => ({ id: unit.id, text: unit.text })), glossary: batchGlossary(pending, glossary), comment, previous: single, title,
          retry: attempt ? [...new Set([...failures.values()].map(failure => failure.code))].join(', ') : '' });
        // A low temperature is asked for; a model path that has no such knob ignores it.
        const raw = await model(system, prompt, { signal, stage: 'Translating passages', temperature: 0.2 });
        signal?.throwIfAborted();
        const read = parseTranslationReply(raw, pending), again = [];
        for (const unit of pending) {
          const got = read?.get(unit.id);
          const checked = got === undefined ? { ok: false, code: read ? 'missing' : 'format', message: read ? 'The model did not answer for this passage.' : 'The model did not answer in the requested format.' }
            : validateTranslation(unit.text, got, { target });
          if (checked.ok) { failures.delete(unit.id); if (!unit.task.failure) unit.task.answers.set(unit.part, checked); continue; }
          failures.set(unit.id, checked);
          if (attempt === 0) again.push(unit); else failTask(unit.task, checked);
        }
        pending = again;
      }
      for (const unit of batch) if (!unit.task.failure && unit.task.answers.size === unit.task.parts.length) await finishTask(unit.task);
    };
    const worker = async () => {
      for (;;) {
        signal?.throwIfAborted();
        const at = next; next += 1;
        if (at >= batches.length) return;
        await doBatch(batches[at]);
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, batches.length) }, worker));
    return tasks.filter(task => task.failure);
  }

  /* ---------- the operations ---------- */

  const handlers = {
    'materials.translation.list': async (args, request = {}) => {
      const state = empty(await read()), { document, unit } = targetOf(state, args), records = recordsOf(state, unit);
      const settings = settingsOf(state, unit, document, args, request), current = currentOf(state, unit);
      const byId = new Map(records.map(record => [record.id, record]));
      // In reading order, whichever batch finished first.
      const order = new Map(records.map((record, index) => [record.id, index]));
      const items = (current?.items || []).filter(item => item.target === settings.target).sort((a, b) => (order.get(a.sourceId) ?? 0) - (order.get(b.sourceId) ?? 0) || a.start - b.start || a.end - b.end).map(item => {
        const source = byId.get(item.sourceId)?.text, passage = source === undefined ? '' : source.slice(item.start, item.end);
        return view(item, !!passage && textHash(passage) === item.hash && glossaryHash(glossaryFor(passage, settings.glossary)) !== (item.glossaryHash || ''));
      });
      const stale = otherRecords(state, document, unit).map(record => ({ revision: record.revision, count: record.items.length, savedAt: record.savedAt }));
      if (document.legacy) {
        const held = holderOf(state, unit)?.translations;
        if (held && held.revision !== unit.revision && held.items?.length) stale.push({ revision: held.revision, count: held.items.length, savedAt: held.updatedAt });
      }
      return { documentId: unit.id, revision: unit.revision, target: settings.target, targetSource: settings.targetSource, glossary: settings.glossary, items, stale,
        otherTarget: (current?.items || []).filter(item => item.target !== settings.target).length, modelAvailable: !!(complete || request.complete) };
    },

    'materials.translation.plan': async (args, request = {}) => {
      const state = empty(await read()), { document, unit } = targetOf(state, args), records = recordsOf(state, unit), settings = settingsOf(state, unit, document, args, request);
      const chapters = chaptersOf(state, unit);
      const entries = classify(fromScope(records, formatOf(document), args.scope, chapters), { current: currentOf(state, unit), others: otherRecords(state, document, unit), ...settings, retranslate: false });
      const passages = entries.map(entry => ({ sourceId: entry.sourceId, ordinal: entry.ordinal, kind: 'paragraph', text: entry.text, key: entry.key, hash: textHash(entry.text), chars: compactText(entry.text).length,
        state: stateOf(entry), ...(entry.outdated ? { outdated: true } : {}) }));
      const todo = entries.filter(entry => entry.status === 'todo');
      const counts = { paragraphs: entries.length, todo: todo.length, done: entries.filter(entry => entry.status === 'cached').length, reuse: entries.filter(entry => entry.status === 'reused').length,
        skipped: entries.filter(entry => entry.status === 'skipped').length, chars: todo.reduce((total, entry) => total + compactText(entry.text).length, 0),
        parts: todo.reduce((total, entry) => total + splitForModel(entry.text).parts.length, 0) };
      return { documentId: unit.id, revision: unit.revision, title: document.title, sourceIds: [...unit.sourceIds], scopeSourceIds: [...new Set(entries.map(entry => entry.sourceId))], target: settings.target, glossary: settings.glossary, passages, counts,
        chapters: chapters.map(({ index, title, level, front, startPage, endPage, partial }) => ({ index, title, level, front: !!front, startPage, endPage, partial: !!partial })), modelAvailable: !!(complete || request.complete) };
    },

    'materials.translation.translate': async (args, request = {}) => {
      const requestId = typeof args.requestId === 'string' ? args.requestId.slice(0, 120) : '', own = requestId ? new AbortController() : null;
      if (own) inflight.set(requestId, own);
      const signal = own ? (request.signal ? AbortSignal.any([request.signal, own.signal]) : own.signal) : request.signal;
      try {
      const state = empty(await read()), { document, unit } = targetOf(state, args), records = recordsOf(state, unit), settings = settingsOf(state, unit, document, args, request);
      const { target, glossary } = settings, retranslate = args.retranslate === true, comment = text(args.comment).trim().slice(0, TRANSLATION_LIMITS.maxComment);
      const located = args.scope ? fromScope(records, formatOf(document), args.scope, Number.isInteger(args.scope.chapter) ? chaptersOf(state, unit) : []) : fromPassages(records, formatOf(document), args.passages);
      const entries = classify(located, { current: currentOf(state, unit), others: otherRecords(state, document, unit), target, glossary, retranslate });
      for (const entry of entries) entry.target = target;
      const base = { documentId: unit.id, revision: unit.revision, title: document.title, target }, model = complete || request.complete, tasks = tasksOf(entries, { retranslate });
      const count = status => entries.filter(entry => entry.status === status).length;
      const split = { paragraphs: tasks.filter(task => task.split).length, parts: tasks.filter(task => task.split).reduce((total, task) => total + task.parts.length, 0) };
      const counts = () => ({ passages: entries.length, translated: count('translated'), cached: count('cached'), reused: count('reused'), skipped: count('skipped'), rejected: count('rejected'), unlocated: count('unlocated'),
        toTranslate: count('todo') });
      const resultOf = entry => ({ key: entry.key, sourceId: entry.sourceId, ordinal: entry.ordinal, kind: entry.kind, status: entry.status, ...(entry.code ? { code: entry.code } : {}),
        ...(entry.message ? { message: entry.message } : {}), ...(entry.outdated ? { outdated: true } : {}), ...(entry.item ? { item: view(entry.item, !!entry.outdated) } : {}), index: entry.index });
      const results = () => entries.map(resultOf);
      if (args.estimate === true) {
        const units = unitsOf(tasks), calls = planBatches(units).map(batch => {
          const { system, prompt } = translationPrompt({ target, passages: batch.map(unit => ({ id: unit.id, text: unit.text })), glossary: batchGlossary(batch, glossary), comment, title: document.title });
          return { system, prompt, chars: batch.reduce((total, unit) => total + compactText(unit.text).length, 0), items: batch.length };
        });
        return { status: 'estimate', ...base, counts: counts(), split, modelAvailable: !!model, results: results(),
          estimate: estimateRun('translate', { calls, target }, { measure: createTextMeasure({ tokenMeter: request.tokenMeter }) }) };
      }
      // Words that are translated already (here or in an older revision) cost nothing: they are kept for this revision at once.
      const reuse = entries.filter(entry => entry.status === 'reused');
      if (reuse.length) {
        const items = reuse.map(entry => itemOf(entry, { text: entry.from.text, warnings: entry.from.warnings || [], parts: entry.from.parts || 1, from: entry.from }));
        await persist(args, items);
        reuse.forEach((entry, at) => { entry.item = items[at]; });
      }
      if (tasks.length && !model) return { status: 'unavailable', capability: 'model', ...base, counts: counts(), split, results: results(), message: 'A model connection is required to translate.' };
      let usage = null;
      if (tasks.length) {
        signal?.throwIfAborted();
        const finished = [];
        const onTaskDone = async (task, answer) => {
          const lead = itemOf(task.entry, { ...answer, comment });
          const copies = task.followers.map(follower => itemOf(follower, { ...answer, comment }));
          await persist(args, [lead, ...copies]);
          task.entry.status = 'translated'; task.entry.item = lead;
          task.followers.forEach((follower, at) => { follower.status = 'translated'; follower.item = copies[at]; });
          finished.push(task);
        };
        await withUsageSink({ key: `translation:${unit.id}:${unit.revision}:${Math.random()}`, sink: (report, meta = {}) => { usage = addUsage(usage, { ...report, calls: meta.calls ?? 1 }); } },
          () => runTasks({ tasks, model, target, glossary, comment, title: document.title, signal, concurrency: concurrencyOf(args.concurrency), onTaskDone }));
        for (const task of tasks.filter(item => item.failure)) for (const entry of [task.entry, ...task.followers]) {
          entry.status = 'rejected'; entry.code = task.failure.code; entry.message = task.failure.message;
        }
        for (const entry of entries.filter(item => item.status === 'todo')) { entry.status = 'rejected'; entry.code = 'missing'; entry.message = 'The passage was not translated.'; }
      }
      const failed = count('rejected') + count('unlocated'), good = count('translated') + count('cached') + count('reused') + count('skipped');
      return { status: failed === 0 ? 'done' : good > 0 ? 'partial' : 'failed', ...base, counts: counts(), split, results: results(), usage };
      } finally { if (own && inflight.get(requestId) === own) inflight.delete(requestId); }
    },

    'materials.translation.cancel': async args => {
      const running = inflight.get(typeof args.requestId === 'string' ? args.requestId : '');
      if (!running) return { cancelled: false };
      running.abort(new Error('Translation cancelled'));
      return { cancelled: true };
    },

    'materials.translation.save': async (args, request = {}) => {
      const state = empty(await read()), { document, unit } = targetOf(state, args), records = recordsOf(state, unit), settings = settingsOf(state, unit, document, args, request);
      if (Array.isArray(args.restore)) {
        const byId = new Map(records.map(record => [record.id, record.text])), items = [];
        for (const item of args.restore) {
          const source = byId.get(item?.sourceId);
          if (source === undefined || !Number.isInteger(item.start) || !Number.isInteger(item.end) || textHash(source.slice(item.start, item.end)) !== item.hash || !text(item.text).trim() || !TARGETS.includes(item.target))
            throw new Error('A restored translation does not match the text of this document');
          items.push({ key: item.key, kind: item.kind === 'selection' ? 'selection' : 'paragraph', sourceId: item.sourceId, start: item.start, end: item.end, ordinal: item.ordinal || 0, hash: item.hash,
            cache: cacheKey({ text: source.slice(item.start, item.end), target: item.target, glossary: settings.glossary }), quote: String(item.quote ?? '').slice(0, item.kind === 'selection' ? MAX_PASSAGE_CHARS : 80),
            ...(item.kind === 'selection' ? { prefix: text(item.prefix).slice(-80), suffix: text(item.suffix).slice(0, 80) } : {}), target: item.target,
            text: text(item.text).slice(0, TRANSLATION_LIMITS.maxTranslation), glossaryHash: glossaryHash(glossaryFor(source.slice(item.start, item.end), settings.glossary)), version: Math.max(1, Number(item.version) || 1),
            ...(item.comment ? { comment: String(item.comment).slice(0, TRANSLATION_LIMITS.maxComment) } : {}), history: (Array.isArray(item.history) ? item.history : []).slice(-TRANSLATION_LIMITS.maxHistory),
            warnings: Array.isArray(item.warnings) ? item.warnings.filter(code => typeof code === 'string') : [], parts: item.parts || 1, at: item.at || iso(), updatedAt: iso() });
        }
        await persist(args, items);
        return { saved: items.length, documentId: unit.id, revision: unit.revision };
      }
      const entries = classify(fromPassages(records, formatOf(document), (args.passages || []).map(({ translation: _t, ...rest }) => rest)), { current: currentOf(state, unit), others: [], target: settings.target, glossary: settings.glossary, retranslate: true });
      const items = (args.passages || []).map((input, at) => {
        const entry = entries[at];
        if (!entry || entry.status === 'unlocated') throw new Error('The passage is not in this document');
        if (!text(input.translation).trim()) throw new Error('The translation is empty');
        entry.target = settings.target;
        return itemOf(entry, { text: input.translation.trim().slice(0, TRANSLATION_LIMITS.maxTranslation) });
      });
      await persist(args, items);
      return { saved: items.length, documentId: unit.id, revision: unit.revision, items: items.map(item => view(item)) };
    },

    'materials.translation.delete': async (args, request = {}) => {
      const wanted = Array.isArray(args.keys) ? new Set(args.keys.filter(key => typeof key === 'string')) : null;
      if (!wanted && args.all !== true) throw new Error('Name the translations to delete, or pass all:true');
      return update(state => {
        const own = empty(state), { document, unit } = targetOf(own, args), settings = settingsOf(own, unit, document, args, request), record = currentOf(own, unit);
        if (!record) return { deleted: 0, removed: [], documentId: unit.id, revision: unit.revision };
        const removed = record.items.filter(item => item.target === settings.target && (args.all === true || wanted.has(item.key)));
        const gone = new Set(removed);
        record.items = record.items.filter(item => !gone.has(item));
        record.updatedAt = iso();
        return { deleted: removed.length, removed: removed.map(item => clone(item)), documentId: unit.id, revision: unit.revision };
      });
    },

    'materials.translation.glossary.get': async (args, request = {}) => {
      const state = empty(await read()), { document, unit } = targetOf(state, args), settings = settingsOf(state, unit, document, args, request);
      return { documentId: unit.id, target: settings.target, targetSource: settings.targetSource, glossary: settings.glossary };
    },

    'materials.translation.glossary.set': async (args, request = {}) => {
      if (args.target !== undefined && args.target !== null) targetFrom(args.target);
      await update(state => {
        const own = empty(state), { document, unit } = targetOf(own, args), holder = settingsHolder(own, unit, document);
        if (!holder) throw new Error('Material document or source not found');
        const saved = holder.translationSettings || {}, next = { ...saved };
        if (args.glossary !== undefined) next.glossary = normalizeGlossary(args.glossary);
        if (args.target === null) delete next.target; else if (args.target !== undefined) next.target = args.target;
        if (next.glossary && !next.glossary.length) delete next.glossary;
        if (Object.keys(next).length) holder.translationSettings = next; else delete holder.translationSettings;
        return true;
      });
      const state = empty(await read()), { document, unit } = targetOf(state, args), settings = settingsOf(state, unit, document, {}, request), records = recordsOf(state, unit);
      const byId = new Map(records.map(record => [record.id, record.text])), affected = [];
      for (const item of currentOf(state, unit)?.items || []) {
        if (item.target !== settings.target) continue;
        const source = byId.get(item.sourceId), passage = source === undefined ? '' : source.slice(item.start, item.end);
        if (!passage || textHash(passage) !== item.hash || glossaryHash(glossaryFor(passage, settings.glossary)) === (item.glossaryHash || '')) continue;
        affected.push({ sourceId: item.sourceId, ordinal: item.ordinal || 0, kind: item.kind || 'paragraph', text: passage, ...(item.kind === 'selection' ? { prefix: item.prefix, suffix: item.suffix } : {}) });
      }
      return { documentId: unit.id, target: settings.target, targetSource: settings.targetSource, glossary: settings.glossary, affected: { count: affected.length, passages: affected.slice(0, AFFECTED_LIMIT) } };
    },
  };
  return handlers;
}
