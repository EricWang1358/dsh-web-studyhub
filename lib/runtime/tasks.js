import { randomUUID } from 'node:crypto';
import { ownWork, workOwnedBy } from './work-ownership.js';

const active = task => ['queued', 'running', 'cancelling'].includes(task.status);
const view = ({ root: _root, ...task }) => structuredClone(task);

/** The same task service is available to third-party contexts and the host. */
export function createTaskService(root, registry) {
  const queues = new Map(), entries = new Map(), owners = new Map();
  const prune = () => {
    const finished = [...entries.values()].filter(entry => entry.finished);
    for (const entry of finished.slice(0, Math.max(0, finished.length - 100))) { entries.delete(entry.task.id); registry.jobs.delete(entry.task.id); }
  };
  const owned = (id, owner, domain) => {
    const entry = entries.get(id);
    if (!entry || (!workOwnedBy(entry.task, owner) || entry.domain !== domain)) throw new Error('Task not found for this owner');
    return entry;
  };
  const cancelEntry = (entry, reason = new Error('Task cancelled')) => {
    if (!active(entry.task)) return view(entry.task);
    entry.task.cancelRequestedAt ||= new Date().toISOString();
    entry.task.status = entry.task.status === 'queued' ? 'cancelled' : 'cancelling';
    entry.controller.abort(reason);
    return view(entry.task);
  };
  const scoped = (owner, domain, assertActive = () => {}) => Object.freeze({
    start(options, run) {
      assertActive();
      if (typeof run !== 'function') throw new Error('Task work must be a function');
      if (options.key) {
        const existing = [...entries.values()].find(entry => entry.domain === domain && workOwnedBy(entry.task, owner) && entry.key === options.key && active(entry.task));
        if (existing) return view(existing.task);
      }
      const queue = options.queue || `${domain}.default`;
      if (!owners.has(owner)) owners.set(owner, new Map());
      const ownerQueues = owners.get(owner);
      if (!ownerQueues.has(domain)) ownerQueues.set(domain, new Map());
      const domainQueues = ownerQueues.get(domain);
      if (!domainQueues.has(queue)) domainQueues.set(queue, Symbol(queue));
      const queueKey = domainQueues.get(queue), previous = queues.get(queueKey);
      const task = ownWork({ id: randomUUID(), root, type: 'extension', provider: domain, label: options.label || options.key || 'Background task',
        queue, status: previous ? 'queued' : 'running', stage: previous ? 'Queued' : 'Starting', startedAt: new Date().toISOString() }, owner);
      const controller = new AbortController(), entry = { task, controller, domain, key: options.key };
      entries.set(task.id, entry); registry.jobs.set(task.id, task); registry.generationControllers.set(task.id, controller);
      const execute = async () => {
        try {
          assertActive();
          controller.signal.throwIfAborted();
          task.status = 'running';
          task.result = structuredClone(await run(Object.freeze({ signal: controller.signal,
            progress: progress => { if (!controller.signal.aborted) for (const name of ['stage', 'done', 'total', 'phase']) if (progress[name] !== undefined) task[name] = structuredClone(progress[name]); },
          })));
          controller.signal.throwIfAborted();
          task.status = 'complete';
        } catch (error) { task.status = controller.signal.aborted ? 'cancelled' : 'failed'; task.stage = error?.message || String(error); }
        finally { entry.finished = true; task.finishedAt = new Date().toISOString(); registry.generationControllers.delete(task.id); registry.settled.delete(task.id); prune(); }
        return view(task);
      };
      entry.promise = (previous || Promise.resolve()).catch(() => {}).then(execute);
      queues.set(queueKey, entry.promise); registry.settled.set(task.id, entry.promise);
      void entry.promise.finally(() => { if (queues.get(queueKey) === entry.promise) queues.delete(queueKey); });
      return view(task);
    },
    get: id => view(owned(id, owner, domain).task),
    list: () => [...entries.values()].filter(entry => entry.domain === domain && workOwnedBy(entry.task, owner)).map(entry => view(entry.task)),
    cancel: id => cancelEntry(owned(id, owner, domain)),
    async wait(id, { timeoutMs } = {}) {
      const entry = owned(id, owner, domain);
      if (timeoutMs === undefined) return entry.promise;
      let timer;
      try { return await Promise.race([entry.promise, new Promise(resolve => { timer = setTimeout(() => resolve(view(entry.task)), Math.max(0, timeoutMs)); })]); }
      finally { clearTimeout(timer); }
    },
  });
  return Object.freeze({ scoped,
    cancelOwner: owner => { for (const entry of entries.values()) if (workOwnedBy(entry.task, owner)) cancelEntry(entry, new Error('Task owner unloaded')); owners.delete(owner); },
    cancelDomain: domain => { for (const entry of entries.values()) if (entry.domain === domain) cancelEntry(entry, new Error('Context unloaded')); for (const [owner, domains] of owners) { domains.delete(domain); if (!domains.size) owners.delete(owner); } },
    dispose: () => { for (const entry of entries.values()) cancelEntry(entry, new Error('Runtime disposed')); owners.clear(); },
  });
}
