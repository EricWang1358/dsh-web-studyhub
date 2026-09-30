import { acquireContexts } from '../runtime/lifecycle.js';
export const name = 'studyhub-generation';
export const inject = [];
export function apply(ctx) { acquireContexts(ctx, ['materials', 'bank', 'generation']); }
