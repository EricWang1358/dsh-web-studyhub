import { acquireContexts } from '../runtime/lifecycle.js';
export const name = 'studyhub-bank';
export const inject = [];
export function apply(ctx) { acquireContexts(ctx, ['bank']); }
