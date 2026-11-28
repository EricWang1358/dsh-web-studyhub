/* What the CLI card edits: the model and effort of either CLI, and for agy also when it is started ahead of a call. One place for
   the starting values, for telling an unsaved change, and for what is sent when saving or testing. */

/** The same default as the backend's (packages/studyhub-desktop/domain/agy-warm-policy.js): a config saved before the setting existed has none. */
export const DEFAULT_AGY_PREWARM = 'after-use';

export function cliDraftOf(providerId, saved) {
  return {
    model: saved?.model || '',
    effort: saved?.effort || '',
    ...(providerId === 'agy' ? { prewarm: saved?.prewarm || DEFAULT_AGY_PREWARM } : {}),
  };
}

export function cliDraftState(provider, savedConfig, draft) {
  const saved = cliDraftOf(provider.id, savedConfig);
  const dirty = Object.keys(saved).some((key) => draft[key] !== saved[key]);
  const payload = {
    executablePath: provider.executablePath || savedConfig?.executablePath || '',
    ...draft,
    model: draft.model.trim(),
  };
  return { dirty, payload };
}
