const modes = ['unsupported', 'queued-only', 'checkpoint'];
/** Definitions, not a second jobs table. Every registration is a Cordis effect. */
export function createJobRegistry(onRemove) {
  const definitions = new Map();
  const key = (scope, kind) => `${scope}:${kind}`;
  return Object.freeze({
    register(ctx, scope, definition) {
      if (typeof ctx?.effect !== 'function' || !scope) throw new Error('Job registration requires a Cordis scope');
      if (!definition?.kind || !Number.isSafeInteger(definition.version) || definition.version < 1 || typeof definition.run !== 'function') throw new Error('Invalid job definition');
      const capabilities = { cancel: true, pauseMode: 'unsupported', recoveryMode: 'none', retry: false, set: false, executionModes: ['direct'], ...definition.capabilities };
      if (!modes.includes(capabilities.pauseMode) || capabilities.set || capabilities.executionModes.some(mode => !['direct', 'subagent'].includes(mode))) throw new Error('Unsupported runtime definition capability');
      if (capabilities.recoveryMode !== 'none') throw new Error('Persistent recovery requires S1-5 admission');
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
