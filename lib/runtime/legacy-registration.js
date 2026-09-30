import { LegacyKernel } from '../legacy-kernel.js';

const collectionDefinitions = {
  system: [], bank: ['decks', 'drafts'], study: ['runs', { name: 'attempts', mode: 'chunk', chunkSize: 1000 }],
  materials: ['sources', 'documents'], audio: ['audioResults'], transition: [], generation: [],
};
const links = {
  system: ['bank.v1', 'study.v1', 'materials.v1', 'audio.v1', 'generation.v1', 'transition.v1'],
  bank: ['materials.v1', 'study.v1', 'generation.v1', 'transition.v1'],
  study: ['bank.v1', 'materials.v1', 'transition.v1'],
  materials: ['bank.v1', 'generation.v1'], audio: ['materials.v1', 'generation.v1', 'bank.v1'],
  generation: ['materials.v1', 'bank.v1', 'system.v1'], transition: ['bank.v1', 'study.v1', 'materials.v1', 'generation.v1'],
};

/** Private adapter for physically extracted v1 operations, never supplied to extensions. */
export function createLegacyEnvironment(root, options = {}) {
  const tables = new Map();
  let runtime;
  let persistentKernel;
  const owner = action => [...tables].find(([, table]) => Object.hasOwn(table.handlers, action) || Object.hasOwn(table.mutations, action));
  const authorize = (from, action) => {
    const target = owner(action);
    if (!target) throw new Error(`Capability unavailable: ${action}`);
    if (target[0] !== from && !links[from]?.includes(`${target[0]}.v1`)) throw new Error(`Dependency ${target[0]} is not declared by ${from}`);
    return target[1];
  };
  const bindKernel = (kernel, services) => {
    kernel.call = (action, args = {}) => runtime.call(action, args, { ...options, ...services });
    kernel.fork = next => makeKernel({ ...services, ...next });
    kernel.ports = {
      resolveHandler: action => owner(action)?.[1].handlers[action] || null,
      resolveMutation: action => owner(action)?.[1].mutations[action] || null,
      forAction: action => kernel.ports.forContext(owner(action)?.[0]),
      forContext: from => ({
        handle: (action, args, extra) => authorize(from, action).handlers[action].call(kernel, args, extra),
        mutate: (action, state, args) => authorize(from, action).mutations[action](state, args, kernel.ports.forAction(action)),
      }),
      mutations: actions => Object.fromEntries(actions.map(action => [action,
        (state, args) => kernel.ports.resolveMutation(action)(state, args, kernel.ports.forAction(action))])),
    };
    return kernel;
  };
  const makeKernel = services => bindKernel(new LegacyKernel(root, { ...options, ...services }), services);
  return {
    connect: next => { runtime = next; },
    useKernel: kernel => { persistentKernel = bindKernel(kernel, options); },
    dispatch: (action, args, services) => (persistentKernel || makeKernel(services)).dispatch(action, args),
    kernel: makeKernel(options),
    descriptor(id, handlers = {}, mutations = {}, extra = {}) {
      tables.set(id, { handlers, mutations });
      const actions = [...Object.keys(handlers), ...Object.keys(mutations)];
      return { id, version: 1, collections: [...(collectionDefinitions[id] || [])], dependencies: [...(links[id] || [])],
        aliases: Object.fromEntries(actions.map(action => [action, action])),
        operations: Object.fromEntries(actions.map(action => [action, {
          execute: (args, context) => {
            const kernel = persistentKernel || makeKernel(context.services);
            extra.prepare?.(kernel, context);
            return kernel.dispatch(action, args);
          },
        }])), ...extra,
        dispose: () => { tables.delete(id); extra.dispose?.(); },
      };
    },
  };
}
