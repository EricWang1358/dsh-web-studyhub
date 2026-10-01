import { acquireContexts } from '../runtime/lifecycle.js';
export const name = 'studyhub-materials';
export const inject = [];
export function apply(ctx) { acquireContexts(ctx, ['materials']); }
