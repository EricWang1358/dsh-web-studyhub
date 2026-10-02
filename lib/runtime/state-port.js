/** Compose named snapshot ports and atomic participants; unrestricted storage never leaves the runtime. */
export function createStatePort(root, context, { reads, writes, participants, defaults }, backup) {
  const available = api => context.hasCapability(api);
  /** `wanted` names the fields a caller needs: the others are neither read nor copied, so a status badge does not copy the library. */
  const project = async wanted => {
    const only = Array.isArray(wanted) ? new Set(wanted) : null;
    const result = structuredClone(only ? Object.fromEntries(Object.entries(defaults).filter(([field]) => only.has(field))) : defaults);
    const snapshots = await context.readSnapshot(reads.filter(available), only ? [...only] : undefined);
    for (const snapshot of snapshots) Object.assign(result, snapshot);
    return result;
  };
  /** The committed, shared library state (read-only) with this domain's defaults under it; nothing is copied. */
  const viewed = entry => entry.state ? { ...entry, state: { ...structuredClone(defaults), ...entry.state } } : entry;
  return Object.freeze({ root,
    read: project,
    update: (update, changed = null) => context.transaction(state => {
      for (const [field, value] of Object.entries(defaults)) if (state[field] === undefined) state[field] = structuredClone(value);
      return update(state);
    }, participants.filter(participant => available(participant.replace(/\.state$/, '.v1'))), writes, changed),
    ...(backup ? { stamp: backup.stamp, load: async () => viewed(await backup.inspect()),
      restore: backup.restore, export: backup.export } : {}),
  });
}
