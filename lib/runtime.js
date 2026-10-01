import { Store } from './store.js';
import { createRuntimeWork } from './runtime/work.js';
import { createTaskService } from './runtime/tasks.js';
import { workOwnedBy } from './runtime/work-ownership.js';

const clone = value => value === undefined ? undefined : structuredClone(value);
const isDeepStrictEqual = (left, right) => JSON.stringify(left) === JSON.stringify(right);
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
  #actionCandidates = new Map();
  #services;
  #participants = new Map();
  #tasks;
  #cancelledOwners = new Set();
  constructor(root, { services = {}, storage, ...requestServices } = {}) {
    this.#store = storage || new Store(root);
    this.#services = { ...services, ...requestServices };
    this.work = createRuntimeWork();
    this.#tasks = createTaskService(root, this.work);
  }
  get storage() { return this.#store; }
  cancelOwner(owner) {
    if (owner !== undefined) this.#cancelledOwners.add(owner);
    this.#tasks.cancelOwner(owner);
    for (const pending of this.work.selectionActive.values()) if (workOwnedBy(pending, owner))
      pending.controller.abort(new Error('Work owner unloaded'));
    for (const job of this.work.jobs.values()) if (workOwnedBy(job, owner) && ['queued', 'running', 'cancelling'].includes(job.status)) {
      job.cancelRequestedAt ||= new Date().toISOString();
      this.work.generationControllers.get(job.id)?.abort(new Error('Work owner unloaded'));
    }
    for (const job of [...this.work.workflowTeachingJobs.values(), ...this.work.workflowSkeletonJobs.values()])
      if (workOwnedBy(job, owner)) job.cancelled = true;
    for (const [key, pending] of this.work.prepPending) if (workOwnedBy(pending, owner)) {
      clearTimeout(pending.timer); this.work.prepPending.delete(key);
    }
    for (const tasks of this.work.coachTasks.values()) for (const task of tasks) if (workOwnedBy(task, owner)) task.cancelled = true;
    for (const pending of this.work.noteJobs.values()) if (workOwnedBy(pending, owner)) {
      pending.cancelled = true; pending.controller?.abort(new Error('Work owner unloaded'));
    }
    const session = this.liveSessions?.activeSession(this.#store.root);
    if (session && workOwnedBy(session, owner)) return session.stop('学习插件已关闭，实录已保存');
  }
  replaceStorage(storage) {
    this.#store = storage;
    for (const domain of this.#domains.values()) domain.state = this.#scoped(domain.fields);
  }
  #scoped(fields) {
    if (this.#store.scoped) return this.#store.scoped(fields);
    const project = state => Object.fromEntries(fields.map(field => [field, clone(state[field])]));
    return Object.freeze({ read: async () => { const state = await this.#store.read(); return { revision: state.revision, ...project(state) }; },
      update: update => this.#store.update(async state => { const owned = project(state), value = await update(owned); for (const field of fields) state[field] = clone(owned[field]); return value; }) });
  }
  /** Only the administrative library facade receives these backup operations. */
  backupPort() { return Object.freeze({ export: async () => { if (this.#store.load) { const entry = await this.#store.load(); this.#store.assertWritable?.(entry); } return this.#store.read(); }, restore: backup => this.#store.restore(backup),
    stamp: () => this.#store.stamp(), inspect: async () => {
      const entry = this.#store.load ? await this.#store.load() : null;
      return { stamp: entry?.stamp ?? await this.#store.stamp(), storageIssues: entry?.storageIssues || [] };
    } }); }
  register(definition) {
    const { id, version = 1, operations = {}, collections = [], dependencies = [], aliases = {} } = definition;
    if (!/^[a-z][a-z0-9-]*$/.test(id) || !Number.isInteger(version) || version < 1) throw new Error('Invalid context identity');
    if (this.#domains.has(id)) throw new Error(`Context registration conflict: ${id}`);
    const api = `${id}.v${version}`;
    const cleanOperations = new Map(Object.entries(operations).map(([name, operation]) => [name,
      typeof operation === 'function' ? { execute: operation } : operation]));
    const routes = new Map();
    for (const name of cleanOperations.keys()) routes.set(`${id}.${name}`, { name, priority: 0 });
    // Explicit public aliases can select an optional richer provider without
    // adding a reverse dependency to either provider's qualified API.
    for (const [action, alias] of Object.entries(aliases)) {
      const route = typeof alias === 'string' ? { name: alias, priority: 0 } : { name: alias?.operation, priority: alias?.priority };
      if (!cleanOperations.has(route.name) || !Number.isInteger(route.priority) || route.priority < 0)
        throw new Error(`Invalid action alias: ${action}`);
      routes.set(action, route);
    }
    for (const [action, route] of routes) if ((this.#actionCandidates.get(action) || []).some(candidate => candidate.priority === route.priority))
      throw new Error(`Action registration conflict: ${action}`);
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
      const state = this.#scoped(fields);
      domain = { id, api, definition, operations: cleanOperations, dependencies: [...dependencies], state, fields, collectionDisposers, workOwner: Symbol(id) };
    } catch (error) {
      for (const dispose of collectionDisposers.reverse()) dispose();
      throw error;
    }
    this.#domains.set(id, domain);
    for (const [action, route] of routes) {
      const candidates = [...(this.#actionCandidates.get(action) || []), { api, ...route }].sort((a, b) => b.priority - a.priority);
      this.#actionCandidates.set(action, candidates);
      this.#actions.set(action, candidates[0]);
    }
    let disposed = false;
    domain.dispose = () => {
      if (disposed) return;
      disposed = true;
      this.#tasks.cancelDomain(api);
      this.#domains.delete(id);
      for (const action of routes.keys()) {
        const candidates = this.#actionCandidates.get(action).filter(route => route.api !== api);
        if (candidates.length) { this.#actionCandidates.set(action, candidates); this.#actions.set(action, candidates[0]); }
        else { this.#actionCandidates.delete(action); this.#actions.delete(action); }
      }
      for (const [name, participant] of this.#participants) if (participant.api === api) this.#participants.delete(name);
      for (const dispose of collectionDisposers) dispose();
      return definition.dispose?.();
    };
    return domain.dispose;
  }
  async invoke(api, name, args = {}, requestServices = {}) {
    return this.#invoke(api, name, args, requestServices);
  }
  async #invoke(api, name, args, requestServices, snapshot) {
    const domain = [...this.#domains.values()].find(candidate => candidate.api === api);
    if (!domain) throw new Error(`Capability unavailable: ${api}`);
    const operation = domain.operations.get(name);
    if (!operation) throw new Error(`Operation unavailable: ${api}.${name}`);
    validate(args, operation.input || objectSchema);
    const { storage: _storage, contexts: _contexts, runtime: _runtime, ...request } = { ...this.#services, ...requestServices };
    const services = Object.freeze(request);
    if (operation.requiresModel && !services.complete && !await operation.canRunWithoutModel?.(args, domain.state))
      return { available: false, reason: 'model_unavailable', api, operation: name };
    const context = this.#context(domain, name, services, snapshot);
    const result = await operation.execute(args, context);
    if (operation.output) validate(result, operation.output, 'result');
    return clone(result);
  }
  #context(domain, name, services, snapshot) {
    const api = domain.api;
    const writable = () => { if (snapshot) throw new Error('A committed read snapshot is read-only'); };
    const authorize = (dependencyApi, dependencyOperation) => {
      if (dependencyApi !== api && !domain.dependencies.includes(dependencyApi))
        throw new Error(`Dependency ${dependencyApi} is not declared by ${api}`);
      const grant = domain.definition.grants?.[dependencyApi];
      if (dependencyApi !== api && grant && !grant.includes(dependencyOperation))
        throw new Error(`Operation ${dependencyApi}.${dependencyOperation} is not granted to ${api}`);
    };
    const state = Object.freeze({ read: snapshot ? async () => ({ revision: snapshot.revision,
      ...Object.fromEntries(domain.fields.map(field => [field, clone(snapshot[field] ?? (this.#store.collections?.has(field) ? [] : undefined))])) }) : domain.state.read,
    update: update => { writable(); return domain.state.update(async owned => {
      this.#assertActive(domain, services);
      const result = await update(owned);
      this.#assertActive(domain, services);
      return result;
    }); } });
    return Object.freeze({ api, state, services,
      hasCapability: dependencyApi => [...this.#domains.values()].some(target => target.api === dependencyApi),
      work: this.#tasks.scoped(services.workOwner || domain.workOwner, api, () => this.#assertActive(domain, services)),
      readSnapshot: async apis => {
        this.#assertActive(domain, services);
        for (const target of apis) authorize(target, 'state.read');
        const current = snapshot || await this.#store.read();
        return Promise.all(apis.map(target => this.#invoke(target, 'state.read', {}, services, current)));
      },
      coordinate: (argumentsValue, update, participants = [], replay) => { writable(); return this.#coordinate(domain, argumentsValue, update, participants, replay, services); },
      transaction: (update, participants = [], fields = [], changed = null) => { writable(); return this.#transaction(domain, name, update, participants, fields, services, changed); },
      mutate: (dependencyApi, dependencyOperation, state, args) => {
        writable();
        if (dependencyApi !== api && (!domain.dependencies.includes(dependencyApi) || !domain.definition.grants?.[dependencyApi]?.includes(dependencyOperation)))
          throw new Error(`Operation ${dependencyApi}.${dependencyOperation} is not granted to ${api}`);
        const target = [...this.#domains.values()].find(candidate => candidate.api === dependencyApi);
        if (!target?.definition.mutate) throw new Error(`Mutation unavailable: ${dependencyApi}.${dependencyOperation}`);
        const fields = target.definition.readFields || target.fields;
        const projected = Object.fromEntries(fields.map(field => [field, clone(state[field] ?? target.definition.defaults?.[field])]));
        const before = clone(projected);
        const result = target.definition.mutate(dependencyOperation, projected, args, this.#context(target, dependencyOperation, services));
        for (const field of fields) if (!isDeepStrictEqual(projected[field], before[field])) {
          if (!target.definition.writes?.[dependencyOperation]?.includes(field)) throw new Error(`State field ${field} is read-only in ${dependencyApi}.${dependencyOperation}`);
          state[field] = projected[field];
        }
        return result;
      },
      invoke: (dependencyApi, dependencyOperation, dependencyArgs = {}, overrides = {}) => {
        authorize(dependencyApi, dependencyOperation);
        if (snapshot) return this.#invoke(dependencyApi, dependencyOperation, dependencyArgs, { ...services, ...overrides }, snapshot);
        return this.invoke(dependencyApi, dependencyOperation, dependencyArgs, { ...services, ...overrides });
      },
      capabilities: () => this.capabilities(services),
    });
  }
  #assertActive(domain, services) {
    if (this.#domains.get(domain.id) !== domain) throw new Error(`Capability unavailable: ${domain.api}`);
    if (services.workOwner !== undefined && this.#cancelledOwners.has(services.workOwner)) throw new Error('Work owner unloaded');
    services.signal?.throwIfAborted();
  }
  registerParticipant(api, { name, fields, validate }) {
    const domain = [...this.#domains.values()].find(candidate => candidate.api === api);
    if (!domain || fields.some(field => !domain.fields.includes(field))) throw new Error('Participant must use owned fields');
    if (this.#participants.has(name)) throw new Error(`Participant registration conflict: ${name}`);
    const participant = { api, fields: fields.slice(), validate };
    this.#participants.set(name, participant);
    return () => { if (this.#participants.get(name) === participant) this.#participants.delete(name); };
  }
  async #transaction(domain, operation, update, participantNames, writable, services, changed) {
    const grants = domain.definition.transactions?.[operation] || [];
    const participants = participantNames.map(name => {
      const participant = this.#participants.get(name);
      if (!participant) throw new Error(`Transaction participant unavailable: ${name}`);
      if (participant.api !== domain.api && !domain.dependencies.includes(participant.api)) throw new Error(`Dependency ${participant.api} is not declared`);
      if (participant.api !== domain.api && !grants.includes(name)) throw new Error(`Transaction participant ${name} is not granted to ${domain.api}.${operation}`);
      return participant;
    });
    const allowed = new Set([...domain.fields, ...participants.flatMap(participant => participant.fields)]);
    return this.#store.update(async current => {
      this.#assertActive(domain, services);
      // Store.update supplies a private draft reconstructed from committed text.
      // Sharing that draft here avoids copying large writable histories twice.
      const projected = { ...clone(domain.definition.defaults || {}), ...Object.fromEntries([...allowed].map(field => [field,
        current[field] ?? clone(domain.definition.defaults?.[field])])) };
      projected.revision = current.revision;
      const before = new Map(Object.entries(projected).filter(([field]) => !allowed.has(field) || !writable.includes(field))
        .map(([field, value]) => [field, JSON.stringify(value)]));
      const value = await update(projected);
      this.#assertActive(domain, services);
      for (const field of new Set([...before.keys(), ...Object.keys(projected)])) {
        if ((!allowed.has(field) || !writable.includes(field)) && JSON.stringify(projected[field]) === before.get(field)) continue;
        if (!allowed.has(field)) throw new Error(`State field ${field} is not granted to ${domain.api}.${operation}`);
        if (!writable.includes(field)) throw new Error(`State field ${field} is read-only in ${domain.api}.${operation}`);
        if (this.#store.collections?.has(field) && !Array.isArray(projected[field])) throw new Error(`Invalid collection ${field}: expected an array`);
        current[field] = projected[field];
      }
      return value;
    }, changed, { reads: [...allowed], writes: writable.filter(field => allowed.has(field)) });
  }
  async #coordinate(domain, args, update, participantNames, replay, services) {
    const participants = participantNames.map(name => {
      const participant = this.#participants.get(name);
      if (!participant) throw new Error(`Transaction participant unavailable: ${name}`);
      if (participant.api !== domain.api && !domain.dependencies.includes(participant.api)) throw new Error(`Dependency ${participant.api} is not declared`);
      return [name, participant];
    });
    return this.#store.update(async current => {
      this.#assertActive(domain, services);
      const owned = Object.fromEntries(domain.fields.map(field => [field, current[field] ?? []]));
      const receipt = replay?.(clone(owned));
      if (receipt !== undefined) return receipt;
      services.signal?.throwIfAborted();
      const checked = {};
      for (const [name, participant] of participants) {
        checked[name] = await participant.validate(Object.fromEntries(participant.fields.map(field => [field, clone(current[field] ?? [])])), args);
        services.signal?.throwIfAborted();
      }
      const value = await update(owned, Object.freeze(checked));
      this.#assertActive(domain, services);
      for (const field of domain.fields) {
        if (this.#store.collections.has(field) && !Array.isArray(owned[field])) throw new Error(`Invalid collection ${field}: expected an array`);
        current[field] = owned[field];
      }
      return value;
    }, null, { reads: [...new Set([...domain.fields, ...participants.flatMap(([, participant]) => participant.fields)])], writes: domain.fields });
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
    this.#tasks.dispose();
    for (const domain of this.#domains.values()) domain.dispose();
    this.#participants.clear();
  }
}
