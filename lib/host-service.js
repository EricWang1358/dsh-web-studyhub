/** A host service (llm, settings, credentials…), or undefined. A DSH (cordis) context that did not inject it throws on
    `ctx[name]` (「cannot get property "llm" without inject」: a session agent's context, which the per-task 模型 choice
    used), while the registry lookup `ctx.get(name)` answers from any context; a plain object (tests) may carry it as its own.
    Its own file, with no imports, because the page bundles lib/reasoning-effort.js too. */
export function hostService(ctx, name) {
  let value;
  try { value = ctx?.get?.(name); } catch { value = undefined; }
  return value ?? (ctx && Object.hasOwn(ctx, name) ? ctx[name] : undefined);
}
