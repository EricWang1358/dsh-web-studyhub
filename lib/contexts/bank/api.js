import { createHash } from 'node:crypto';
import { initialReview, norm, validateDeck } from '../../domain.js';
import { id } from '../../util.js';

const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
const fingerprint = value => createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
const object = { type: 'object', additionalProperties: true };
const deckInput = { ...object, properties: { deckId: { type: 'string' }, id: { type: 'string' } } };
const appendInput = { ...object, properties: { deckId: { type: 'string' }, cards: { type: 'array', items: object },
  operationId: { type: 'string' }, expectedVersion: { type: 'integer' }, selection: object },
required: ['deckId', 'cards', 'operationId', 'expectedVersion'] };

/** New bank contracts use owned content ports; historical operations live separately. */
export function createBankOperations() {
  return {
    list: { input: object, description: 'List available destination decks and their content versions.', execute: async (_args, context) => ({
      decks: (await context.state.read()).decks.map(deck => ({ id: deck.id, title: deck.title, archived: !!deck.archived,
        contentVersion: deck.contentVersion || 0, cards: deck.cards.length })),
    }) },
    get: { input: deckInput, description: 'Read a JSON deck and its optimistic content version.', execute: async (args, context) => {
      const deck = (await context.state.read()).decks.find(candidate => candidate.id === (args.deckId || args.id));
      if (!deck) throw new Error('Deck not found');
      return { deck, version: deck.contentVersion || 0 };
    } },
    cards: { input: object, description: 'Read card and explanation DTOs for cross-plugin links.', execute: async (args, context) =>
      (await context.state.read()).decks.flatMap(deck => deck.cards.filter(card =>
        (!args.cardId || card.id === args.cardId) && (!args.deckId || deck.id === args.deckId) &&
        (!args.sourceId || card.citations?.some(citation => citation.sourceId === args.sourceId)) &&
        (!args.documentId || card.selections?.some(selection => selection.documentId === args.documentId) ||
          card.citations?.some(citation => citation.selection?.documentId === args.documentId)))
        .map(card => ({ ...card, deckId: deck.id, deckTitle: deck.title }))) },
    append: { input: appendInput, description: 'Atomically append accepted cards once, retaining all prior progress.', execute: async (args, context) => {
      if (!args.operationId.trim() || !args.cards.length) throw new Error('Append requires an operation ID and cards');
      const digest = fingerprint({ deckId: args.deckId, cards: args.cards, selection: args.selection });
      const replay = state => {
        const prior = state.decks.find(deck => deck.id === args.deckId)?.appendOperations?.[args.operationId];
        if (!prior) return undefined;
        if (prior.fingerprint !== digest) throw new Error('Append operation conflict: payload changed');
        return { ...prior.receipt, replayed: true };
      };
      const previous = replay(await context.state.read());
      if (previous) return previous;
      return context.coordinate(args, (state, checked) => {
        const deck = state.decks.find(candidate => candidate.id === args.deckId);
        if (!deck || deck.archived || deck.systemKind) throw new Error('Append target must be an active ordinary deck');
        const prior = deck.appendOperations?.[args.operationId];
        if (prior) {
          if (prior.fingerprint !== digest) throw new Error('Append operation conflict: payload changed');
          return { ...prior.receipt, replayed: true };
        }
        if ((deck.contentVersion || 0) !== args.expectedVersion) throw new Error('Deck version conflict');
        const selection = checked['materials.selection'];
        const ids = new Set(deck.cards.map(card => card.id));
        const prompts = new Set(deck.cards.map(card => norm(card.prompt)));
        const objectives = new Set(deck.cards.map(card => norm(card.objective)));
        const cards = args.cards.map(candidate => {
          const card = structuredClone(candidate);
          card.id ||= id();
          if (ids.has(card.id) || prompts.has(norm(card.prompt)) || objectives.has(norm(card.objective))) throw new Error('Append card duplicates an existing question');
          ids.add(card.id); prompts.add(norm(card.prompt)); objectives.add(norm(card.objective));
          card.review ||= initialReview();
          if (selection) {
            card.selections = [...(card.selections || []).filter(item => fingerprint(item) !== fingerprint(selection)), selection];
          }
          return card;
        });
        const errors = validateDeck({ title: deck.title, cards }, checked['materials.evidence'] || []).errors;
        if (errors.length) throw new Error(errors.join('\n'));
        deck.cards.push(...cards);
        deck.contentVersion = (deck.contentVersion || 0) + 1;
        const receipt = { deckId: deck.id, added: cards.length, total: deck.cards.length,
          cardIds: cards.map(card => card.id), version: deck.contentVersion, operationId: args.operationId };
        (deck.appendOperations ||= {})[args.operationId] = { fingerprint: digest, receipt };
        return receipt;
      }, [...(args.selection ? ['materials.selection'] : []),
        ...(args.cards.some(card => card.citations?.length) ? ['materials.evidence'] : [])], replay);
    } },
    'deck.ensure': { input: { ...object, properties: { course: { type: 'string' }, title: { type: 'string' }, purpose: { type: 'string', enum: ['source-qa'] } }, required: ['title', 'purpose'] },
      description: 'Find or create the one active ordinary deck of a course that is kept for a stated purpose (grounded Q&A cards). The course is written exactly as given.',
      execute: (args, context) => context.state.update(state => {
        const title = String(args.title || '').trim().slice(0, 200), course = typeof args.course === 'string' ? args.course.trim() : '';
        if (!title || args.purpose !== 'source-qa') throw new Error('A purpose and a deck title are required');
        let deck = state.decks.find(candidate => !candidate.archived && !candidate.systemKind && candidate.purpose === args.purpose && (candidate.course ?? candidate.folder ?? '') === course);
        const created = !deck;
        if (!deck) {
          const now = new Date().toISOString();
          deck = { id: id(), title, folder: '', course, purpose: args.purpose, contentVersion: 0, cards: [], createdAt: now, publishedAt: now };
          state.decks.push(deck);
        }
        return { deckId: deck.id, title: deck.title, version: deck.contentVersion || 0, created };
      }) },
    'schedule.update': { input: { ...object, properties: { deckId: { type: 'string' }, cardId: { type: 'string' }, review: object },
      required: ['deckId', 'cardId', 'review'] }, description: 'Study policy writes only a card review schedule.', execute: (args, context) => context.state.update(state => {
      const card = state.decks.find(deck => deck.id === args.deckId)?.cards.find(candidate => candidate.id === args.cardId);
      if (!card) throw new Error('Card not found');
      card.review = structuredClone(args.review);
      return { deckId: args.deckId, cardId: card.id, review: card.review };
    }) },
  };
}
