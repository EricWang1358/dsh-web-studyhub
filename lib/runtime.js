import { Store } from './store.js';

const clone = value => value === undefined ? undefined : structuredClone(value);
const objectSchema = Object.freeze({ type: 'object', additionalProperties: true });

function validate(value, schema, path = 'arguments') {
  if (!schema) return;
  if (schema.oneOf) {
    const accepted = schema.oneOf.filter(option => { try { validate(value, option, path); return true; } catch { return false; } });
    if (accepted.length !== 1) throw new Error(`${path} does not match exactly one schema`);
  }
  const types = { object: v => v && typeof v === 'object' && !Array.isArray(v), array: Array.isArray,
    string: v => typeof v === 'string', number: v => typeof v === 'number' && Number.isFinite(v),
    integer: Number.isInteger, boolean: v => typeof v === 'boolean', null: v => v === null };
  if (schema.type && !types[schema.type]?.(value)) throw new Error(`${path} must be ${schema.type}`);
  if (schema.enum && !schema.enum.includes(value)) throw new Error(`${path} is not an allowed value`);
  if (Object.hasOwn(schema, 'const') && value !== schema.const) throw new Error(`${path} has an unexpected value`);
  if (schema.type === 'object') {
    for (const key of schema.required || []) if (value[key] === undefined) throw new Error(`${path}.${key} is required`);
    for (const [key, next] of Object.entries(value)) {
      if (schema.properties?.[key]) validate(next, schema.properties[key], `${path}.${key}`);
      else if (schema.additionalProperties === false) throw new Error(`${path}.${key} is not supported`);
    }
  }
  if (schema.type === 'array' && schema.items) value.forEach((next, i) => validate(next, schema.items, `${path}[${i}]`));
}

/** Public capability registry. Domain handlers receive only their owned state port. */
export class StudyRuntime {
  #store;
  #domains = new Map();
  #actions = new Map();
  #services;
  #participants = new Map();
  constructor(root, { services = {}, storage, ...requestServices } = {}) {
    this.#store = storage || new Store(root);
    this.#services = { ...services, ...requestServices };
  }
  register(definition) {
    const { id, version = 1, operations = {}, collections = [], dependencies = [], aliases = {} } = definition;
    if (!/^[a-z][a-z0-9-]*$/.test(id) || !Number.isInteger(version) || version < 1) throw new Error('Invalid context identity');
    if (this.#domains.has(id)) throw new Error(`Context registration conflict: ${id}`);
    const api = `${id}.v${version}`;
    const cleanOperations = new Map(Object.entries(operations).map(([name, operation]) => [name,
      typeof operation === 'function' ? { execute: operation } : operation]));
    const routes = new Map();
    for (const name of cleanOperations.keys()) routes.set(`${id}.${name}`, name);
    for (const [action, operation] of Object.entries(aliases)) routes.set(action, operation);
    for (const action of routes.keys()) if (this.#actions.has(action)) throw new Error(`Action registration conflict: ${action}`);
    const fields = definition.fields || collections.map(collection => typeof collection === 'string' ? collection : collection.name);
    for (const field of fields) if ([...this.#domains.values()].some(domain => domain.fields.includes(field)))
      throw new Error(`Collection ownership conflict: ${field}`);
    const collectionDisposers = [];
    let domain;
    try {
      for (const collection of collections) {
        const name = typeof collection === 'string' ? collection : collection.name;
        collectionDisposers.push(this.#store.registerCollection(name, typeof collection === 'string' ? { mode: 'item' } : collection));
      }
      const state = this.#store.scoped(fields);
      domain = { id, api, definition, operations: cleanOperations, dependencies: [...dependencies], state, fields, collectionDisposers };
    } catch (error) {
      for (const dispose of collectionDisposers.reverse()) dispose();
      throw error;
    }
    this.#domains.set(id, domain);
    for (const [action, name] of routes) this.#actions.set(action, { api, name });
    let disposed = false;
    domain.dispose = () => {
      if (disposed) return;
      disposed = true;
      this.#domains.delete(id);
      for (const [action, route] of this.#actions) if (route.api === api) this.#actions.delete(action);
      for (const [name, participant] of this.#participants) if (participant.api === api) this.#participants.delete(name);
      for (const dispose of collectionDisposers) dispose();
      return definition.dispose?.();
    };
    return domain.dispose;
  }
  async invoke(api, name, args = {}, requestServices = {}) {
    const domain = [...this.#domains.values()].find(candidate => candidate.api === api);
    if (!domain) throw new Error(`Capability unavailable: ${api}`);
    const operation = domain.operations.get(name);
    if (!operation) throw new Error(`Operation unavailable: ${api}.${name}`);
    validate(args, operation.input || objectSchema);
    const services = Object.freeze({ ...this.#services, ...requestServices });
    if (operation.requiresModel && !services.complete && !await operation.canRunWithoutModel?.(args, domain.state))
      return { available: false, reason: 'model_unavailable', api, operation: name };
    const context = Object.freeze({ api, state: domain.state, services,
      coordinate: (argumentsValue, update, participants = [], replay) => this.#coordinate(domain, argumentsValue, update, participants, replay, services),
      invoke: (dependencyApi, dependencyOperation, dependencyArgs = {}, overrides = {}) => {
        if (dependencyApi !== api && !domain.dependencies.includes(dependencyApi))
          throw new Error(`Dependency ${dependencyApi} is not declared by ${api}`);
        return this.invoke(dependencyApi, dependencyOperation, dependencyArgs, { ...services, ...overrides });
      },
      capabilities: () => this.capabilities(services),
    });
    const result = await operation.execute(args, context);
    if (operation.output) validate(result, operation.output, 'result');
    return clone(result);
  }
  registerParticipant(api, { name, fields, validate }) {
    const domain = [...this.#domains.values()].find(candidate => candidate.api === api);
    if (!domain || fields.some(field => !domain.fields.includes(field))) throw new Error('Participant must use owned fields');
    if (this.#participants.has(name)) throw new Error(`Participant registration conflict: ${name}`);
    const participant = { api, fields: fields.slice(), validate };
    this.#participants.set(name, participant);
    return () => { if (this.#participants.get(name) === participant) this.#participants.delete(name); };
  }
  async #coordinate(domain, args, update, participantNames, replay, services) {
    const participants = participantNames.map(name => {
      const participant = this.#participants.get(name);
      if (!participant) throw new Error(`Transaction participant unavailable: ${name}`);
      if (participant.api !== domain.api && !domain.dependencies.includes(participant.api)) throw new Error(`Dependency ${participant.api} is not declared`);
      return [name, participant];
    });
    return this.#store.update(async current => {
      const owned = Object.fromEntries(domain.fields.map(field => [field, clone(current[field] ?? [])]));
      const receipt = replay?.(clone(owned));
      if (receipt !== undefined) return receipt;
      services.signal?.throwIfAborted();
      const checked = {};
      for (const [name, participant] of participants) {
        checked[name] = await participant.validate(Object.fromEntries(participant.fields.map(field => [field, clone(current[field] ?? [])])), args);
        services.signal?.throwIfAborted();
      }
      const value = await update(owned, Object.freeze(checked));
      services.signal?.throwIfAborted();
      for (const field of domain.fields) {
        if (this.#store.collections.has(field) && !Array.isArray(owned[field])) throw new Error(`Invalid collection ${field}: expected an array`);
        current[field] = clone(owned[field]);
      }
      return value;
    });
  }
  async call(action, args = {}, services = {}) {
    if (action === 'runtime.describe') return this.describe();
    if (action === 'runtime.capabilities') return this.capabilities(services);
    const route = this.#actions.get(action);
    if (!route) throw new Error(`Capability unavailable: ${action}`);
    return this.invoke(route.api, route.name, args, services);
  }
  hasAction(action) { return ['runtime.describe', 'runtime.capabilities'].includes(action) || this.#actions.has(action); }
  disposeContext(id) { return this.#domains.get(id)?.dispose(); }
  describe() {
    return [...this.#domains.values()].map(domain => ({ id: domain.id, api: domain.api,
      dependencies: domain.dependencies.slice(), operations: [...domain.operations].map(([name, operation]) => ({ name,
        description: operation.description || '', input: clone(operation.input || objectSchema),
        output: clone(operation.output || {}), requiresModel: !!operation.requiresModel })) }));
  }
  capabilities(services = {}) {
    const available = { ...this.#services, ...services };
    return this.describe().map(domain => ({ ...domain, available: true, operations: domain.operations.map(operation => ({
      ...operation, available: !operation.requiresModel || !!available.complete,
      ...(!operation.requiresModel || available.complete ? {} : { reason: 'model_unavailable' }),
    })) }));
  }
  dispose() {
    for (const domain of this.#domains.values()) domain.dispose();
    this.#participants.clear();
  }
}
