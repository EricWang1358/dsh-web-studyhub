/** A host service (llm, settings, credentials…), or undefined. A DSH (cordis) context that did not inject it throws on
    `ctx[name]` (「cannot get property "llm" without inject」: a session agent's context, which the per-task 模型 choice
    used), while the registry lookup `ctx.get(name)` answers from any context; a plain object (tests) may carry it as its own.
    `can` names a method the caller needs: the first of the two that has it wins, else the registry's, else the own one.
    Its own file, with no imports, because the page bundles lib/reasoning-effort.js too. */
export function hostService(ctx, name, can) {
  let registered;
  try { registered = ctx?.get?.(name); } catch { registered = undefined; }
  const own = ctx && Object.hasOwn(ctx, name) ? ctx[name] : undefined;
  if (can && typeof registered?.[can] !== 'function' && typeof own?.[can] === 'function') return own;
  return registered ?? own;
}
