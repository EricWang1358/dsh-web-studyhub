/** Compose named snapshot ports and atomic participants; unrestricted storage never leaves the runtime. */
export function createStatePort(root, context, { reads, writes, participants, defaults }, backup) {
  const available = api => context.hasCapability(api);
  const project = async () => {
    const result = structuredClone(defaults);
    const snapshots = await context.readSnapshot(reads.filter(available));
    for (const snapshot of snapshots) Object.assign(result, snapshot);
    return result;
  };
  return Object.freeze({ root,
    read: project,
    update: (update, changed = null) => context.transaction(state => {
      for (const [field, value] of Object.entries(defaults)) if (state[field] === undefined) state[field] = structuredClone(value);
      return update(state);
    }, participants.filter(participant => available(participant.replace(/\.state$/, '.v1'))), writes, changed),
    ...(backup ? { stamp: backup.stamp, load: backup.inspect,
      restore: backup.restore, export: backup.export } : {}),
  });
}
