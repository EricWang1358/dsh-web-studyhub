import { bytesHash, documentBytes, filenameFor, formatFor, mimeFor, attachmentPath, presentationFormat, projectDocument, retainOriginal, textRevision } from './files.js';
import { isPagedFormat } from '../../office/limits.js';
import { originalStatus, readOriginal } from './original-file.js';
import { createOriginalOperations } from './original-operations.js';
import { createRenameOperations } from './rename-operations.js';
import { fileNameOf, retitleSources } from '../../document-title.js';
import { resolvePosition } from './positions.js';
import { importCourses, sourcesWithCourses, knownCourseNames } from '../../source-courses.js';
import { courseScope } from '../../course-tree.js';
import { materialsSchemas } from './contracts.js';
import { currentFollowups } from '../../followup.js';
import { createOutlineHandlers, outlineDescriptor } from './outline-operations.js';
import { createTranslationHandlers } from './translation-operations.js';
import { createAnnotationHandlers } from './annotation-operations.js';
import { askSystemPrompt, normalizeIntent, normalizeTerm, normalizeThread, pageEvidence, rangeEvidence, SELECTION_CONTEXT_CHARS } from './ask-prompt.js';
import { pageRangeState } from './page-range.js';
import { isLibraryListSource, assertMaterials } from '../../exam-point-list.js';

const required = (value, label) => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required`);
  return value;
};
const safeClone = value => structuredClone(value);
const empty = state => ({ sources: state.sources || [], documents: state.documents || [] });

function legacyDocument(sources, source) {
  const id = source.document?.materialId || (source.document?.id ? `legacy-${source.document.id}` : `source-${source.id}`);
  const members = source.document?.id ? sources.filter(item => item.document?.id === source.document.id) : [source];
  const format = source.document?.page ? 'pdf' : source.format === 'markdown' ? 'md' : source.format || 'txt';
  const revision = members.length === 1 ? textRevision(source.text) : textRevision(JSON.stringify(members.map(item => [item.id, item.text])));
  return { id, title: source.title, archived: members.every(item => item.archived === true), filename: source.document?.filename || source.title, format, currentRevision: revision,
    legacy: true, versions: [{ revision, sourceIds: members.map(item => item.id), importedAt: source.importedAt || source.createdAt || null, attachment: null }] };
}

function findDocument(state, args) {
  const requested = args.documentId || args.id;
  const source = state.sources.find(item => item.id === (args.sourceId || requested));
  const document = state.documents.find(item => item.id === requested);
  if (document) return safeClone(document);
  if (!args.documentId && source) {
    const owner = state.documents.find(item => item.versions?.some(version => version.sourceIds?.includes(source.id)));
    return owner ? safeClone(owner) : legacyDocument(state.sources, source);
  }
  const member = requested && state.sources.find(item => item.document?.id === requested || `legacy-${item.document?.id}` === requested || `source-${item.id}` === requested);
  if (member) return legacyDocument(state.sources, member);
  throw new Error('Material document or source not found');
}

const versionOf = (document, revision) => {
  const version = document.versions.find(item => item.revision === (revision || document.currentRevision));
  if (!version) throw new Error('Material document revision not found');
  return version;
};

const sourceRecords = (state, version) => version.sourceIds.map(id => state.sources.find(source => source.id === id)).filter(Boolean);

export function resolveSelectionState(rawState, input) {
  const state = empty(rawState); let document;
  try { document = findDocument(state, input); }
  catch (error) { if (error.message !== 'Material document or source not found') throw error; return { status: 'missing', message: error.message }; }
  const current = versionOf(document), sources = sourceRecords(state, current);
  const legacySource = !input.documentId && input.sourceId && document.legacy && state.sources.find(source => source.id === input.sourceId);
  if (legacySource) return resolvePosition([legacySource], input, { revision: textRevision(legacySource.text) });
  if (input.sourceId && !input.documentId && !current.sourceIds.includes(input.sourceId)) {
    const historical = document.versions.find(version => version.sourceIds.includes(input.sourceId));
    if (historical) return resolvePosition(sourceRecords(state, historical), input, { documentId: document.id, revision: historical.revision });
  }
  const currentInput = input.revalidate && input.revision !== document.currentRevision
    ? { ...input, sourceId: current.sourceIds.includes(input.sourceId) ? input.sourceId : undefined, start: undefined, end: undefined }
    : input;
  return resolvePosition(sources, currentInput, { documentId: document.id, revision: document.currentRevision });
}

/**
 * The page a question with scope 'page' is about (the 原始 PDF view has no selection): the one source of the document's current
 * revision with that page number (or that sourceId). Resolved as a selection over the whole page text, without a quote (the page is
 * the evidence and is not repeated); a page that is not there is 'missing', one with no saved text 'missing' with reason 'empty',
 * an older revision 'stale', like a selection.
 */
export function resolvePageState(rawState, input = {}) {
  const state = empty(rawState); let document;
  if (!input.sourceId && !Number.isInteger(input.page)) throw new Error('A page or sourceId is required for a page question');
  try { document = findDocument(state, input); }
  catch (error) { if (error.message !== 'Material document or source not found') throw error; return { status: 'missing', message: error.message }; }
  if (input.revision !== undefined && input.revision !== document.currentRevision)
    return { status: 'stale', currentRevision: document.currentRevision, requestedRevision: input.revision, message: 'Document revision changed; open the current document before asking about this page.' };
  if (input.to !== undefined) return pageRangeState({ documentId: document.id, revision: document.currentRevision, records: sourceRecords(state, versionOf(document)), from: input.page, to: input.to });
  const eligible = sourceRecords(state, versionOf(document)).filter(source => (!input.sourceId || source.id === input.sourceId)
    && (!Number.isInteger(input.page) || source.document?.page === input.page));
  if (eligible.length !== 1) return { status: eligible.length ? 'ambiguous' : 'missing', currentRevision: document.currentRevision,
    message: eligible.length ? 'More than one source has this page; name the sourceId.' : 'This page has no saved text in the current document.' };
  const [source] = eligible, text = source.text || '', page = source.document?.page;
  if (!text.trim()) return { status: 'missing', reason: 'empty', currentRevision: document.currentRevision, ...(page ? { page } : {}), message: 'This page has no saved text to answer from.' };
  return { status: 'resolved', currentRevision: document.currentRevision, selection: { documentId: document.id, revision: document.currentRevision, sourceId: source.id,
    start: 0, end: text.length, ...(page ? { page } : {}) } };
}

/** Used by a runtime transaction participant while the library lock is held. */
export function validateSelection(state, selection) {
  if (!selection || typeof selection.revision !== 'string' || typeof selection.sourceId !== 'string' ||
      !Number.isInteger(selection.start) || !Number.isInteger(selection.end)) throw new Error('A resolved, versioned material selection is required');
  const owner = selection.documentId
    ? state.documents?.find(document => document.id === selection.documentId && document.versions.some(version => version.sourceIds.includes(selection.sourceId)))
    : state.documents?.find(document => document.versions.some(version => version.sourceIds.includes(selection.sourceId)));
  if (owner && (selection.revision !== owner.currentRevision || !versionOf(owner).sourceIds.includes(selection.sourceId)))
    throw new Error('Material selection is stale; resolve it again before committing');
  const resolved = resolveSelectionState(state, { ...selection, revalidate: false });
  if (resolved.status !== 'resolved') throw new Error(`Material selection is ${resolved.status}; resolve it again before committing`);
  if (resolved.selection.quote !== selection.quote) throw new Error('Material selection quote changed; resolve it again before committing');
  return resolved.selection;
}

async function describe(root, state, document, requestedRevision, { withOutline = false } = {}) {
  const version = versionOf(document, requestedRevision), sources = sourceRecords(state, version);
  // `original` says where the original stands: a copy in the library, a reference to the learner's own file, or none (and why).
  const original = await originalStatus(root, version), available = original.status === 'ok', copy = available && original.mode === 'copy';
  // A kept outline travels beside the version list, not inside it; the document list never carries one.
  return { ...document, versions: document.versions.map(({ outline: _outline, translations: _translations, annotations: _annotations, ...rest }) => rest), ...(withOutline ? outlineDescriptor(state, document, version) : {}),
    documentId: document.id, revision: version.revision, sourceIds: [...version.sourceIds], sources: safeClone(sources).map(({ translations: _translations, annotations: _annotations, ...rest }) => rest),
    originalAvailable: available, original,
    preview: { kind: copy ? 'file' : available ? 'reference' : 'extracted', available, format: document.format, mime: mimeFor(document.format),
      ...(copy ? { path: attachmentPath(root, version.attachment), absolutePath: attachmentPath(root, version.attachment) }
        : available ? {} : { reason: 'Original file is unavailable; retained extracted text remains readable.' }),
      sourceIds: [...version.sourceIds] },
    capabilities: { original: available, selection: sources.length > 0, ...(isPagedFormat(document.format) ? { pageRequiredForRepeatedQuotes: true } : {}) } };
}

/** The library can supply citation-derived courses; a standalone materials context needs only its own records. */
async function listMaterialDocuments(root, rawState, args = {}) {
  const state = empty(rawState), documents = state.documents.map(safeClone), known = new Set(documents.flatMap(document => document.versions.flatMap(version => version.sourceIds)));
  for (const source of state.sources) {
    if (known.has(source.id) || isLibraryListSource(source)) continue; // a 考点清单 or 课程总纲 is not a material (lib/exam-point-list.js)
    const document = legacyDocument(state.sources, source);
    if (!documents.some(item => item.id === document.id)) documents.push(document);
  }
  const courses = new Map(sourcesWithCourses(rawState).map(source => [source.id, source.courses]));
  const within = typeof args.course === 'string' && args.course !== '' && args.course !== '*' ? courseScope(args.course, knownCourseNames(rawState)) : null;
  const query = String(args.query || '').toLowerCase();
  const matches = documents.filter(document => (args.includeArchived === true || !document.archived) && versionOf(document).sourceIds.some(id => courses.has(id)) &&
    (!query || `${document.title} ${document.filename}`.toLowerCase().includes(query)) &&
    (args.course === undefined || args.course === '*' || versionOf(document).sourceIds.some(id => args.course === '' ? !(courses.get(id) || []).length : (courses.get(id) || []).some(within))));
  const offset = Math.max(0, Math.floor(Number(args.offset) || 0)), limit = Math.min(200, Math.max(1, Math.floor(Number(args.limit) || 50)));
  const items = await Promise.all(matches.slice(offset, offset + limit).map(async document => {
    const descriptor = await describe(root, state, document);
    const { sources, versions, ...summary } = descriptor;
    return { ...summary, chars: sources.reduce((total, source) => total + source.text.length, 0), versions: versions.map(({ revision, sourceIds, importedAt }) => ({ revision, sourceIds, importedAt })) };
  }));
  return { documents: items, total: matches.length, offset, limit };
}

/** Owns only material records. Bank access is a read-only public DTO port. */
export function createMaterialsOperations({ root, read, update, bankCards, complete } = {}) {
  if (typeof root !== 'string' || typeof read !== 'function' || typeof update !== 'function') throw new Error('Materials requires its library root and scoped persistence port');

  const importDocument = async args => {
    const named = formatFor(args), filename = filenameFor(args, named), bytes = await documentBytes(args, named);
    const format = presentationFormat(bytes, named);
    const projection = await projectDocument(bytes, { format, filename, pages: args.pages });
    // Converter output has no original file to keep (WP28); everything else keeps its bytes.
    const attachment = projection.converted ? null : await retainOriginal(root, bytes, format);
    const recordFormat = projection.recordFormat || format;
    const revision = `${bytesHash(bytes)}-${format}-${projection.converted ? 'conv1' : format === 'pdf' ? 'text2' : 'text1'}`;
    const snapshot = empty(await read());
    let existing;
    if (args.documentId) existing = findDocument(snapshot, args);
    const documentId = existing?.id || `document-${bytesHash(bytes)}-${format}`;
    if (existing && existing.format !== recordFormat) throw new Error('Document refresh must retain the original format');
    const title = args.title !== undefined ? fileNameOf(required(args.title, 'Document title')) : existing?.title || projection.title || filename;
    const now = new Date().toISOString();
    const courses = args.courses !== undefined || args.course !== undefined || !existing ? importCourses(args)
      : [...new Set(sourceRecords(snapshot, versionOf(existing)).flatMap(source => source.courses || []))];
    const projected = projection.sources.map((source, index) => ({ ...source,
      id: source.id || `${documentId}-${revision}-${projection.converted ? `p${source.document.page}` : `s${index + 1}`}`, title: source.title || title,
      createdAt: now, importedAt: now, courses,
      document: { ...source.document, materialId: documentId, materialRevision: revision, format: recordFormat, filename,
        ...(projection.converted ? { bookTitle: title } : {}) } }));
    // A document the learner renamed keeps its name when a revised original is attached: the new pages follow the title, not the file name.
    if (existing?.titleHistory?.length) {
      const original = sourceRecords(snapshot, versionOf(existing)).find(source => typeof source.renamedFrom === 'string')?.renamedFrom;
      if (original) for (const source of projected) source.renamedFrom = original;
      retitleSources(projected, { from: projection.title || filename, to: title, filename });
    }
    const result = await update(state => {
      state.sources ||= []; state.documents ||= [];
      let document = state.documents.find(item => item.id === documentId);
      if (!document) { document = existing ? safeClone(existing) : { id: documentId, format: recordFormat, filename, title, currentRevision: revision, versions: [] }; state.documents.push(document); }
      const prior = document.versions.find(item => item.revision === revision);
      const foreignSources = new Set(state.documents.filter(item => item.id !== documentId)
        .flatMap(item => item.versions.flatMap(version => version.sourceIds)));
      const sourcesById = new Map();
      for (const source of state.sources) if (!sourcesById.has(source.id)) sourcesById.set(source.id, source);
      const priorIds = new Set(prior?.sourceIds || []);
      // PDF extraction names a page by bytes. Reusing those bytes in a different document needs its own projection;
      // existing revisions retain every historical source id, including shared pages from older imports.
      const importedSources = projected.map((source, index) => {
        const present = sourcesById.get(source.id);
        const foreign = foreignSources.has(source.id) || present?.document?.materialId && present.document.materialId !== documentId;
        return foreign && !priorIds.has(source.id)
          ? { ...source, id: `${documentId}-${revision}-${source.document?.page ? `p${source.document.page}` : `s${index + 1}`}` }
          : source;
      });
      let added = 0;
      for (const source of importedSources) {
        // Use the archive state under the lock, including a concurrent archive or restore.
        if (document.archived) source.archived = true;
        const present = sourcesById.get(source.id);
        if (!present) { state.sources.push(source); sourcesById.set(source.id, source); added++; }
        else if (present.text !== source.text) throw new Error('Existing material projection differs; retain the original citation evidence');
        else if (!foreignSources.has(source.id)) {
          present.document = { ...source.document, ...present.document, materialId: documentId, materialRevision: revision };
          if (courses.length) present.courses = [...new Set([...(present.courses || []), ...courses])];
        }
      }
      if (!prior) document.versions.push({ revision, attachment, sourceIds: importedSources.map(source => source.id), importedAt: now,
        ...(projection.warnings.length ? { warnings: projection.warnings } : {}), ...(projection.totalPages ? { totalPages: projection.totalPages } : {}) });
      else {
        prior.attachment = attachment;
        prior.sourceIds = [...new Set([...prior.sourceIds, ...importedSources.map(source => source.id)])];
      }
      document.currentRevision = revision;
      document.title = title; document.filename = filename;
      delete document.legacy;
      if (args.path) document.externalPath = args.path;
      return { documentId, revision, sourceIds: [...versionOf(document).sourceIds], added, warnings: projection.warnings,
        ...(projection.selectedPages ? { selectedPages: projection.selectedPages, skippedPages: projection.skippedPages, sparsePages: projection.sparsePages }
          : projection.skippedPages ? { skippedPages: projection.skippedPages } : {}), originalAvailable: !projection.converted };
    });
    // A converted book answers without its page texts (hundreds of pages); the learner already has them in the library.
    const described = await getDocument({ id: documentId });
    return { ...result, document: projection.converted ? { ...described, sources: described.sources.map(({ text, ...source }) => ({ ...source, chars: text.length })) } : described };
  };

  const getDocument = async args => {
    let state = empty(await read());
    if (args.path) {
      let matchedVersion;
      const match = state.documents.find(document => {
        const version = document.versions.find(version => version.attachment && attachmentPath(root, version.attachment) === args.path);
        if (version) { matchedVersion = version; return true; }
        return document.externalPath === args.path;
      });
      if (!match) throw new Error('Material document or source not found');
      if (args.documentId && args.documentId !== match.id) throw new Error('Document path does not match the requested material');
      if (matchedVersion && args.revision && args.revision !== matchedVersion.revision) throw new Error('Document path does not match the requested revision');
      args = { ...args, documentId: match.id, revision: args.revision || matchedVersion?.revision };
    }
    let document = findDocument(state, args);
    // A versioned source citation names its retained evidence, even without a stored selection revision.
    // Extracted-only legacy sources, explicit revisions and refresh requests retain their existing meaning.
    const cited = args.sourceId && state.sources.find(source => source.id === args.sourceId);
    if (cited?.document?.materialRevision && args.revision === undefined && !args.refresh && !versionOf(document).sourceIds.includes(args.sourceId)) {
      const historical = document.versions.find(version => version.sourceIds.includes(args.sourceId));
      if (historical) args = { ...args, revision: historical.revision };
    }
    if (args.refresh) {
      if (!document.externalPath) throw new Error('This document has no external file to refresh; import an updated original explicitly');
      await importDocument({ path: document.externalPath, documentId: document.id, format: document.format, title: document.title });
      state = empty(await read()); document = findDocument(state, { id: document.id });
    }
    return describe(root, state, document, args.revision, { withOutline: true });
  };

  const resolveSelection = async args => {
    const input = args.selection ? { ...args.selection, ...Object.fromEntries(Object.entries(args).filter(([key]) => key !== 'selection')) } : args;
    required(input.quote, 'Selected quote');
    return resolveSelectionState(await read(), input);
  };

  const handlers = {
    'materials.document.import': importDocument,
    'materials.document.get': getDocument,
    'materials.document.bytes': async args => {
      const state = empty(await read()), document = findDocument(state, args), version = versionOf(document, args.revision);
      // Only the original stored for this revision is read (a copy in the library, or the one path recorded when it was attached); nothing the caller sends names a file.
      const original = await readOriginal(root, version);
      if (original.status !== 'ok') return { status: 'unavailable', revision: version.revision, reason: original.reason, ...(original.path ? { path: original.path } : {}),
        message: original.reason === 'none' ? 'The original file was not retained or is unavailable.' : `The referenced original file is ${original.reason === 'missing' ? 'missing' : original.reason === 'unreadable' ? 'unreadable' : 'no longer the file that was verified'}.` };
      return { dataBase64: original.bytes.toString('base64'), mime: mimeFor(document.format), filename: document.filename, format: document.format, revision: version.revision, mode: original.mode };
    },
    'materials.document.list': async args => listMaterialDocuments(root, await read(), args),
    'materials.document.attach': async args => {
      const state = empty(await read()), document = findDocument(state, args);
      return importDocument({ ...args, documentId: document.id, format: args.format || document.format });
    },
    'materials.selection.resolve': resolveSelection,
    'materials.selection.ask': async (args, request = {}) => {
      // scope 'page' (the 原始 PDF view): the question is about the whole page the selection names, not a passage of it.
      if (args.scope !== undefined && args.scope !== 'selection' && args.scope !== 'page') throw new Error('scope must be "selection" or "page"');
      const page = args.scope === 'page';
      const selected = page ? resolvePageState(await read(), args.selection || {}) : await resolveSelection(args.selection || args);
      if (selected.status !== 'resolved') return selected;
      const model = request.complete || complete;
      if (!model) return { status: 'unavailable', capability: 'model', selection: selected.selection, message: 'A model connection is required to answer questions.' };
      required(args.question, 'Question'); request.signal?.throwIfAborted();
      // A term and an earlier thread are optional (a question asked inside an answer); both are untrusted content like the question.
      // A preset (翻译 / 按知识点拆分 / 提取公式与代码 …) only chooses a fixed instruction sentence; it never travels in the untrusted input.
      const term = normalizeTerm(args.term), thread = normalizeThread(args.thread), intent = normalizeIntent(args.intent);
      const state = empty(await read()), source = state.sources.find(item => item.id === selected.selection.sourceId);
      const selection = selected.selection;
      const language = request.language || args.language || '中文';
      const extra = { ...(term ? { term } : {}), ...(thread.length ? { thread } : {}) };
      // A selection travels with the text around it; a page is its own evidence, one window of it (lib/ask-prompt.js pageEvidence), never sent twice. A range is its pages' text, marked.
      const range = selected.pages ? selected : null, emptyPages = range?.emptyPages.length ? { emptyPages: range.emptyPages } : {}, to = selection.to ? { to: selection.to } : {};
      const window = { offset: args.offset ?? 0 }, cut = !page ? null : range ? rangeEvidence(range.pages, window) : pageEvidence(source.text, window);
      if (cut && !cut.context.trim()) return { status: 'missing', reason: 'past-end', selection, message: 'There is no more text after this point.' };
      const input = page ? { question: args.question, scope: 'page', page: selection.page ?? null, ...to, context: cut.context, ...(cut.truncated ? { truncated: true } : {}), ...(cut.offset ? { offset: cut.offset } : {}), ...emptyPages, language, ...extra }
        : { question: args.question, selection, context: source.text.slice(Math.max(0, selection.start - SELECTION_CONTEXT_CHARS), Math.min(source.text.length, selection.end + SELECTION_CONTEXT_CHARS)), language, ...extra };
      const answer = await model(askSystemPrompt({ question: args.question, term, thread, language, terms: args.terms === true, scope: page ? 'page' : 'selection', intent, range: !!range, continued: !!cut?.offset }),
        JSON.stringify(input), { signal: request.signal });
      request.signal?.throwIfAborted();
      const text = typeof answer === 'string' ? answer : String(answer);
      if (page) return { status: 'answered', answer: text, scope: 'page', selection, evidence: { page: selection.page ?? null, ...to, chars: cut.chars, used: cut.used, truncated: cut.truncated, ...(cut.offset ? { offset: cut.offset } : {}), ...(range ? { pages: cut.pages } : {}), ...emptyPages },
        citations: range ? range.pages.filter(item => cut.pages.includes(item.page)).map(item => ({ sourceId: item.sourceId, page: item.page, selection })) : [{ sourceId: selection.sourceId, ...(selection.page ? { page: selection.page } : {}), selection }] };
      return { status: 'answered', answer: text, selection, citations: [{ sourceId: selection.sourceId, quote: selection.quote, selection }] };
    },
    ...createOutlineHandlers({ read, update, complete, findDocument, versionOf, empty }),
    ...createTranslationHandlers({ read, update, complete, findDocument, versionOf, empty }),
    ...createAnnotationHandlers({ read, update, findDocument, versionOf, empty, resolveSelection: resolveSelectionState }),
    'materials.links.list': async args => {
      if (!bankCards) return { links: [], capability: 'bank', status: 'unavailable' };
      const response = await bankCards({ ...(args.cardId ? { cardId: args.cardId } : {}), ...(args.sourceId ? { sourceId: args.sourceId } : {}), ...(args.documentId ? { documentId: args.documentId } : {}) });
      const cards = Array.isArray(response) ? response : response.cards || [];
      const state = await read();
      const links = [];
      for (const entry of cards) {
        const card = entry.card || entry;
        if (args.cardId && card.id !== args.cardId && entry.cardId !== args.cardId) continue;
        const selections = [...(card.selections || []), ...(card.citations || []).flatMap(citation => citation.selection ? [citation.selection] : [])];
        const seen = new Set();
        for (const selection of selections) {
          if ((args.documentId && selection.documentId !== args.documentId) || (args.sourceId && selection.sourceId !== args.sourceId)) continue;
          if (args.selection && (selection.documentId !== args.selection.documentId || selection.revision !== args.selection.revision || selection.sourceId !== args.selection.sourceId || selection.start !== args.selection.start || selection.end !== args.selection.end)) continue;
          const key = JSON.stringify(selection); if (seen.has(key)) continue; seen.add(key);
          const resolution = resolveSelectionState(state, selection);
          links.push({ deckId: entry.deckId || card.deckId, deckTitle: entry.deckTitle || card.deckTitle, cardId: card.id || entry.cardId,
            kind: card.kind, sourceQa: card.sourceQa === true, prompt: card.prompt, answer: card.answer, explanation: card.explanation,
            // The extra Q&A of the card (讲解追问), stored oldest first, shown newest first; only answers to the card as it reads now.
            followups: currentFollowups(card).map(({ id, at, question, answer }) => ({ id, at, question, answer })).reverse(),
            selection: safeClone(selection), status: resolution.status, currentRevision: resolution.currentRevision });
        }
      }
      return { links, total: links.length };
    },
    // The cards live in the library context (it also reads the review state); this module only owns the contract.
    'materials.pages.cards': async () => ({ status: 'unavailable', capability: 'library', cards: [], sourceIds: [] }),
    'materials.enrich': async args => {
      const wanted = args.sourceIds === undefined ? null : new Set(args.sourceIds);
      const unresolved = [], changes = [];
      await update(state => {
        // A 考点清单 is not a material to complete: naming one is refused, and a pass over everything leaves the lists alone.
        assertMaterials(wanted ? state.sources.filter(source => wanted.has(source.id)) : []);
        const normalized = new Map(sourcesWithCourses({ sources: state.sources }).map(source => [source.id, source]));
        for (const source of state.sources) {
          if ((wanted && !wanted.has(source.id)) || isLibraryListSource(source)) continue;
          const fields = [];
          const knownCourses = normalized.get(source.id).courses;
          // Keep missing attribution inferable by consumers with bank context.
          if (source.courses === undefined && knownCourses.length) { source.courses = knownCourses; fields.push('courses'); }
          if (source.format === undefined) { source.format = source.document?.format || (source.document?.page ? 'pdf' : 'txt'); fields.push('format'); }
          if (source.contentRevision === undefined) { source.contentRevision = textRevision(source.text || ''); fields.push('contentRevision'); }
          if (fields.length) changes.push({ id: source.id, fields });
          const document = state.documents.find(item => item.versions?.some(version => version.sourceIds.includes(source.id)));
          const missing = [];
          if (!document?.versions.some(version => version.attachment || version.external)) missing.push('original');
          if (!source.importedAt && !source.createdAt) missing.push('importedAt');
          if (missing.length) unresolved.push({ id: source.id, fields: missing });
        }
      });
      return { updated: changes.length, changes, unresolved };
    },
  };
  const locate = (state, args) => {
    const own = empty(state), document = findDocument(own, args), version = versionOf(document, args.revision);
    return { document, version, sources: sourceRecords(own, version) };
  };
  Object.assign(handlers, createOriginalOperations({ root, read, update, locate }));
  Object.assign(handlers, createRenameOperations({ read, update, locate }));
  return { handlers, schemas: materialsSchemas };
}
