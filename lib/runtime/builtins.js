import { StudyRuntime } from '../runtime.js';
import { createLegacyEnvironment } from './legacy-registration.js';
import * as system from '../contexts/system/index.js';
import * as bank from '../contexts/bank/index.js';
import * as study from '../contexts/study/index.js';
import * as generation from '../contexts/generation/index.js';
import * as audio from '../contexts/audio/index.js';
import * as materials from '../contexts/legacy-materials/index.js';
import * as transition from '../contexts/transition/index.js';
import { createBankOperations } from '../contexts/bank/api.js';
import { createMaterialsOperations, validateSelection } from '../contexts/materials/operations.js';
import { materialsSchemas } from '../contexts/materials/contracts.js';
import { createSelectionOperations } from '../contexts/generation/selection.js';
import { selectionSchemas } from '../contexts/generation/contracts.js';
import { createAudioOperations, configureAudioPublisher, disposeAudio } from '../contexts/audio/api.js';
import { disposeGenerationJobs } from '../contexts/generation/jobs.js';

const contexts = { system, bank, study, generation, audio, materials, transition };
export const fullContextIds = Object.freeze(Object.keys(contexts));

export function createBuiltinEnvironment(root, runtime, options = {}) {
  const workOwner = Symbol('runtime work owner');
  const legacy = createLegacyEnvironment(root, { ...options, workOwner });
  legacy.connect(runtime);
  return {
    legacy,
    install(id) {
      const context = contexts[id];
      if (!context) throw new Error(`Unknown built-in context: ${id}`);
      const descriptor = legacy.descriptor(id, context.handlers, context.mutations, id === 'audio' ? {
        prepare: configureAudioPublisher, dispose: () => disposeAudio(root, workOwner),
      } : {});
      if (id === 'audio') Object.assign(descriptor.operations, createAudioOperations(root));
      if (id === 'materials') descriptor.aliases['source.find'] = 'source.search';
      if (id === 'bank') {
        Object.assign(descriptor.operations, createBankOperations());
        Object.assign(descriptor.aliases, { 'bank.deck.get': 'get', 'bank.cards.list': 'cards', 'bank.decks.list': 'list' });
        descriptor.aliases['card.find'] = 'card.search';
      }
      if (id === 'transition') for (const action of ['oral.active', 'oral.start', 'oral.get', 'oral.report', 'oral.answer', 'oral.next', 'oral.followup', 'oral.submit']) {
        descriptor.operations[action] = { execute: (args, context) => legacy.dispatch(action, args, context.services) };
        descriptor.aliases[action] = action;
      }
      if (id === 'generation') {
        descriptor.collections.push('selectionJobs');
        const factories = new Set();
        for (const name of ['selection.supplement', 'selection.get', 'selection.commit', 'selection.review']) {
          descriptor.operations[name] = { ...selectionSchemas[name],
            requiresModel: ['selection.supplement', 'selection.review'].includes(name), execute: (args, context) => {
              const handlers = createSelectionOperations({ root, read: context.state.read, update: context.state.update,
                complete: context.services.complete,
                materials: (action, payload, request) => context.invoke('materials.v1', action.replace(/^materials\./, ''), payload, request),
                bank: { get: (deckId, request) => context.invoke('bank.v1', 'get', { deckId }, request), append: (payload, request) => context.invoke('bank.v1', 'append', payload, request) },
              });
              factories.add(handlers);
              return Promise.resolve(handlers[`generation.${name}`](args, context.services)).finally(() => factories.delete(handlers));
            } };
          if (name === 'selection.supplement') descriptor.operations[name].canRunWithoutModel = async (args, state) => {
            const job = (await state.read()).selectionJobs?.find(item => item.operationId === args.operationId);
            return !!job && (job.reviewPassed || !['preparing', 'writing', 'reviewing'].includes(job.status));
          };
          descriptor.aliases[`generation.${name}`] = name;
        }
        const oldDispose = descriptor.dispose;
        descriptor.dispose = () => { for (const handlers of factories) handlers.dispose(); factories.clear(); disposeGenerationJobs(root, workOwner); oldDispose(); };
      }
      if (id === 'materials') {
        for (const [action, schema] of Object.entries(materialsSchemas)) {
          const name = action.replace(/^materials\./, '');
          descriptor.operations[name] = { ...schema, requiresModel: name === 'selection.ask', execute: (args, context) => {
            const owner = createMaterialsOperations({ root, read: context.state.read, update: context.state.update,
              bankCards: context.capabilities().some(domain => domain.api === 'bank.v1') ? filter => context.invoke('bank.v1', 'cards', filter) : undefined,
              complete: context.services.complete });
            return owner.handlers[action](args, context.services);
          } };
          descriptor.aliases[action] = name;
        }
        descriptor.operations['sources.ingest'] = { description: 'Accept source DTOs published by an installed content producer without exposing material storage.',
          input: { type: 'object', properties: { sources: { type: 'array', items: { type: 'object', additionalProperties: true,
            properties: { id: { type: 'string' }, title: { type: 'string' }, text: { type: 'string' } }, required: ['id', 'title', 'text'] } } }, required: ['sources'] },
          execute: (args, context) => context.state.update(state => {
            for (const source of args.sources) {
              const existing = state.sources.find(item => item.id === source.id);
              if (existing && existing.text !== source.text) throw new Error('Source identity conflict');
              if (!existing) state.sources.push(structuredClone(source));
              else existing.courses = [...new Set([...(existing.courses || []), ...(source.courses || [])])];
            }
            return { sourceIds: args.sources.map(source => source.id) };
          }) };
      }
      const dispose = runtime.register(descriptor);
      if (id === 'materials') runtime.registerParticipant('materials.v1', { name: 'materials.selection', fields: ['sources', 'documents'],
        validate: (state, args) => validateSelection(state, args.selection) });
      if (id === 'materials') runtime.registerParticipant('materials.v1', { name: 'materials.evidence', fields: ['sources'],
        validate: state => state.sources });
      return dispose;
    },
  };
}

export function createStudyRuntime(root, { contexts: selected = fullContextIds, ...options } = {}) {
  const runtime = new StudyRuntime(root, { services: options });
  const environment = createBuiltinEnvironment(root, runtime, options);
  for (const id of selected) environment.install(id);
  return runtime;
}
