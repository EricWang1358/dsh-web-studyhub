import { acquireContexts } from '../runtime/lifecycle.js';
export const name = 'studyhub-runtime';
export const inject = [];
export function apply(ctx) { acquireContexts(ctx); }
