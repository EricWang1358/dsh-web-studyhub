import { acquireContexts } from '../runtime/lifecycle.js';
import Schema from 'schemastery';
export const name = 'studyhub-generation';
export const inject = [];
export const Config = Schema.object({ independent: Schema.boolean().default(false) });
export function apply(ctx, config = {}) {
  acquireContexts(ctx, config.independent ? ['authoring', 'generation'] : ['materials', 'bank', 'authoring', 'generation']);
}
