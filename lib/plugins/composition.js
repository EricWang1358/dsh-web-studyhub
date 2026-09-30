import { acquireContexts } from '../runtime/lifecycle.js';
import { fullContextIds } from '../runtime/builtins.js';
export const name = 'studyhub-composition';
export const inject = [];
export function apply(ctx, config = {}) { acquireContexts(ctx, config.contexts || fullContextIds); }
