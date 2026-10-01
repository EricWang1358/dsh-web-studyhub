import { createHash, randomUUID } from 'node:crypto';
import { generateDeck, mentionsCard, reviewDeck } from '../../generation.js';
import { validateDeck } from '../../domain.js';
import { answerLeakIssues, explanationIssues, learnerContextIssues, reviewIssues } from '../../assessment-quality.js';
import { ownWork } from '../../runtime/work-ownership.js';

const kinds = ['quiz', 'multi', 'open', 'flashcard', 'cloze'];
const clone = value => structuredClone(value);
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
const digest = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const errorText = error => error?.message || String(error);

/** Model orchestration owns its candidates; publication is exclusively a bank API. */
export function createSelectionOperations({ root, read, update, materials, bank, complete, active = new Map(), workOwner }) {
  const ownedControllers = new Set();
  const get = async operationId => clone((await read()).selectionJobs.find(job => job.operationId === operationId));
  const save = async (operationId, patch) => update(state => {
    state.selectionJobs ||= [];
    const job = state.selectionJobs.find(item => item.operationId === operationId);
    if (!job) throw new Error('Selection operation does not exist');
    Object.assign(job, clone(patch), { updatedAt: new Date().toISOString() });
    return job;
  });
  const requireJob = async args => {
    const job = await get(args.operationId);
    if (!job) throw new Error('Selection operation does not exist');
    return job;
  };
  const modelFor = request => {
    const model = request?.complete || complete;
    if (typeof model !== 'function') throw Object.assign(new Error('A model is required for selected-text generation'), { code: 'CAPABILITY_UNAVAILABLE' });
    return (system, prompt) => {
      request?.signal?.throwIfAborted();
      return model(system, prompt, { signal: request?.signal, stage: 'Selection generation', resultOwner: 'plugin' });
    };
  };
  const resolve = async (selection, request) => {
    const result = await materials('materials.selection.resolve', selection, request);
    if (result.status !== 'resolved')
      throw Object.assign(new Error(`Selection is ${result.status}; select the current passage again`), { code: 'POSITION_CONFLICT' });
    return result.selection;
  };
  const evidence = async (selection, request) => {
    const document = await materials('materials.document.get', { documentId: selection.documentId, sourceId: selection.sourceId }, request);
    const source = document.sources?.find(item => item.id === selection.sourceId);
    if (!source) throw new Error('Selection source is unavailable');
    // A short table cell needs its nearby labels as evidence. The selected position
    // remains exact; bounded surrounding text supplies context to the question.
    const text = selection.quote.length >= 12 ? selection.quote
      : source.text.slice(Math.max(0, selection.start - 300), Math.min(source.text.length, selection.end + 300));
    return [{ id: source.id, title: source.title || document.title || 'Selected material', text }];
  };
  const commit = async (job, expectedVersion, request) => {
    if (job.status === 'complete') return job;
    if (!job.accepted?.length || !job.reviewPassed) throw new Error('No independently reviewed questions are available to append');
    try {
      request?.signal?.throwIfAborted();
      // Bank owns validation under the commit lock and replays an existing receipt
      // before checking a now-stale document. A preflight here would block recovery.
      const receipt = await bank.append({ deckId: job.deckId, cards: job.accepted, selection: job.selection,
        operationId: job.operationId, expectedVersion: expectedVersion ?? job.expectedVersion }, request);
      return save(job.operationId, { status: 'complete', receipt, error: null });
    } catch (error) {
      return save(job.operationId, { status: request?.signal?.aborted ? 'cancelled' : 'conflict', error: errorText(error), errorCode: error.code });
    }
  };
  const exclusive = (operationId, request, run, fingerprint = null) => {
    const key = `${root}\0${operationId}`;
    const current = active.get(key);
    if (current) {
      if (fingerprint && current.fingerprint !== fingerprint) throw new Error('Operation ID was already used for a different concurrent request');
      return current.promise;
    }
    const controller = new AbortController();
    ownedControllers.add(controller);
    const signal = request?.signal ? AbortSignal.any([request.signal, controller.signal]) : controller.signal;
    const promise = Promise.resolve().then(() => run({ ...request, signal })).finally(() => {
      active.delete(key);
      ownedControllers.delete(controller);
    });
    active.set(key, ownWork({ fingerprint, promise, controller }, request?.workOwner ?? workOwner));
    return promise;
  };
  const supplement = async (args, request = {}) => {
    if (typeof args.deckId !== 'string' || !args.deckId) throw new Error('Choose an existing destination deck');
    if (typeof args.operationId !== 'string' || !args.operationId || args.operationId.length > 200)
      throw new Error('A stable operationId is required');
    if (!args.selection || typeof args.selection.quote !== 'string') throw new Error('A material selection is required');
    const count = args.count ?? 1, kind = args.kind || 'flashcard';
    if (!Number.isInteger(count) || count < 1 || count > 20) throw new Error('Question count must be between 1 and 20');
    if (!kinds.includes(kind)) throw new Error('Unsupported question kind');
    const fingerprint = digest({ ...args, count, kind });
    const previous = await get(args.operationId);
    if (previous && previous.fingerprint !== fingerprint) throw new Error('Operation ID was already used for a different request');
    if (previous?.status === 'reviewed' && previous.reviewPassed)
      return exclusive(args.operationId, request, scoped => commit(previous, undefined, scoped), fingerprint);
    if (previous && !['preparing', 'writing', 'reviewing'].includes(previous.status)) return previous;
    modelFor(request);
    return exclusive(args.operationId, request, async scopedRequest => {
      const existing = await get(args.operationId);
      if (existing && existing.fingerprint !== fingerprint) throw new Error('Operation ID was already used for a different request');
      if (existing?.reviewPassed) return commit(existing, undefined, scopedRequest);
      const selection = await resolve(args.selection, scopedRequest);
      const destination = await bank.get(args.deckId);
      const deck = destination.deck || destination;
      if (!Array.isArray(deck.cards)) throw new Error('Destination deck is unavailable');
      const expectedVersion = args.expectedVersion ?? destination.version ?? deck.contentVersion ?? 0;
      const sources = await evidence(selection, scopedRequest);
      await update(state => {
        state.selectionJobs ||= [];
        if (state.selectionJobs.some(job => job.operationId === args.operationId)) return;
        state.selectionJobs.push({ operationId: args.operationId, fingerprint, deckId: args.deckId, expectedVersion,
          selection, request: { count, kind, focus: args.focus || '' }, sources, status: 'preparing', candidates: [], accepted: [],
          reviewPassed: false, createdAt: new Date().toISOString() });
      });
      try {
        const draft = await generateDeck(modelFor(scopedRequest), {
          count, kind, sources, existing: deck.cards.map(card => card.objective).filter(Boolean),
          language: args.language || (scopedRequest.language === 'en' ? 'English' : '中文'), focus: `${args.focus || ''}\nSelected passage: ${selection.quote}`,
          onAuthored: draft => save(args.operationId, { candidates: draft.cards, candidateTitle: draft.title, status: 'reviewing' }),
          onReviewed: review => save(args.operationId, { review }),
        }, stage => scopedRequest.onProgress?.({ stage, operationId: args.operationId }));
        const accepted = draft.cards.map(card => ({ ...card, selections: [clone(selection)] }));
        const job = await save(args.operationId, { accepted, editorial: draft.editorial, reviewPassed: true, status: 'reviewed' });
        return commit(job, undefined, scopedRequest);
      } catch (error) {
        return save(args.operationId, { status: scopedRequest.signal.aborted ? 'cancelled' : 'review-failed', error: errorText(error), accepted: [], reviewPassed: false });
      }
    }, fingerprint);
  };
  const handlers = {
    'generation.selection.supplement': supplement,
    'generation.selection.get': args => requireJob(args),
    'generation.selection.commit': async (args, request = {}) => {
      const job = await requireJob(args);
      return exclusive(job.operationId, request, scoped => commit(job, args.expectedVersion, scoped));
    },
    'generation.selection.review': async (args, request = {}) => {
      modelFor(request);
      const job = await requireJob(args);
      if (job.status === 'complete') return job;
      if (!job.candidates?.length) throw new Error('There are no saved candidates to review');
      return exclusive(job.operationId, request, async scoped => {
        try {
          const selection = await resolve(job.selection, scoped);
          const sources = await evidence(selection, scoped);
          const deck = { title: job.candidateTitle || 'Selected material', cards: clone(job.candidates) };
          const structural = [...validateDeck(deck, sources).errors, ...learnerContextIssues(deck), ...explanationIssues(deck), ...answerLeakIssues(deck)];
          const review = await reviewDeck(modelFor(scoped), { sources, deck, kind: job.request.kind, count: deck.cards.length, structuralErrors: structural, singleRound: true });
          const issues = [...structural, ...reviewIssues(review, deck)];
          const unattributed = issues.some(issue => !deck.cards.some(card => mentionsCard(issue, card, deck)));
          const accepted = unattributed ? [] : deck.cards.filter(card =>
            card.kind === job.request.kind && !issues.some(issue => mentionsCard(issue, card, deck)))
            .slice(0, job.request.count).map(card => ({ ...card, id: randomUUID(), selections: [clone(selection)] }));
          const saved = await save(job.operationId, { accepted, review, reviewPassed: accepted.length > 0,
            status: accepted.length ? 'reviewed' : 'review-failed', error: accepted.length ? null : issues.join('; ') });
          return accepted.length ? commit(saved, args.expectedVersion, scoped) : saved;
        } catch (error) {
          return save(job.operationId, { status: scoped.signal.aborted ? 'cancelled' : 'review-failed', error: errorText(error), reviewPassed: false, accepted: [] });
        }
      });
    },
  };
  Object.defineProperty(handlers, 'dispose', { value: () => { for (const controller of ownedControllers) controller.abort(); } });
  return handlers;
}
