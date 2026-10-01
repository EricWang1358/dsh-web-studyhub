import { acquireContexts } from '../runtime/lifecycle.js';
export const name = 'studyhub-audio';
export const inject = [];
export function apply(ctx) { acquireContexts(ctx, ['audio']); }
