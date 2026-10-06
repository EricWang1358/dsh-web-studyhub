const modes = ['unsupported', 'queued-only', 'checkpoint'];
const RECOVERY_MODES = ['none', 'retry-from-start', 'resume-checkpoint'], EXECUTION_MODES = ['direct', 'subagent'];
// Accessors the kernel defines on every work.jobs record; a definition cannot shadow them.
const RESERVED_FIELDS = ['root', 'contract', 'id', 'type', 'status', 'stage', 'startedAt', 'finishedAt', 'constructor', 'prototype'];
const legacyFieldValid = key => typeof key === 'string' && /^[a-zA-Z][\w]*$/.test(key) && !RESERVED_FIELDS.includes(key);
/** Definitions, not a second jobs table. Every registration is a Cordis effect. */
export function createJobRegistry(onRemove) {
  const definitions = new Map();
  const key = (scope, kind) => `${scope}:${kind}`;
  return Object.freeze({
    register(ctx, scope, definition) {
      if (typeof ctx?.effect !== 'function' || !scope) throw new Error('Job registration requires a Cordis scope');
      if (!definition?.kind || !Number.isSafeInteger(definition.version) || definition.version < 1 || typeof definition.run !== 'function') {
        throw new Error('Invalid job definition');
      }
      const capabilities = { cancel: true, pauseMode: 'unsupported', recoveryMode: 'none', retry: false, set: false, executionModes: ['direct'], ...definition.capabilities };
      if (!modes.includes(capabilities.pauseMode) || capabilities.executionModes.some(mode => !EXECUTION_MODES.includes(mode))) {
        throw new Error('Unsupported runtime definition capability');
      }
      if (definition.admit !== undefined && typeof definition.admit !== 'function') throw new Error('Invalid admission adapter');
      if (definition.legacyId !== undefined && typeof definition.legacyId !== 'function') throw new Error('Invalid legacy id');
      if (definition.legacyFields !== undefined && (!Array.isArray(definition.legacyFields) || !definition.legacyFields.every(legacyFieldValid))) {
        throw new Error('Invalid legacy presentation fields');
      }
      if (!RECOVERY_MODES.includes(capabilities.recoveryMode) || (capabilities.recoveryMode !== 'none' && typeof definition.persistence?.open !== 'function')) {
        throw new Error('Persistent recovery requires S1-5 admission');
      }
      if (definition.persistence && typeof definition.persistence.open !== 'function') throw new Error('Invalid persistence adapter');
      if (definition.initialPresentation !== undefined && typeof definition.initialPresentation !== 'function') throw new Error('Invalid initial presentation');
      // Durable definitions declare sinks on their persistence port; others may declare in-process settlement sinks here.
      if (definition.notifications !== undefined && (definition.persistence || !Array.isArray(definition.notifications)
        || definition.notifications.some(sink => typeof sink?.channel !== 'string' || !sink.channel || typeof sink.deliver !== 'function'))) {
        throw new Error('Invalid notification adapters');
      }
      const name = key(scope, definition.kind);
      if (definitions.has(name)) throw new Error(`Job definition conflict: ${name}`);
      const entry = Object.freeze({ ...definition, scope, capabilities: Object.freeze(structuredClone(capabilities)) });
      definitions.set(name, entry);
      let closing;
      const remove = () => {
        if (!closing) { if (definitions.get(name) === entry) definitions.delete(name); closing = Promise.resolve(onRemove(entry)); }
        return closing;
      };
      ctx.effect(() => remove);
      return remove;
    },
    removeScope(scope) {
      const selected = [...definitions.entries()].filter(([, entry]) => entry.scope === scope);
      for (const [name] of selected) definitions.delete(name);
      return Promise.all(selected.map(([, entry]) => onRemove(entry)));
    },
    get(scope, kind) { const definition = definitions.get(key(scope, kind)); if (!definition) throw new Error(`Job definition unavailable: ${scope}:${kind}`); return definition; },
    has: entry => definitions.get(key(entry.scope, entry.kind)) === entry,
  });
}
