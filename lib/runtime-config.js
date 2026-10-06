import Schema from 'schemastery';

/** Migration switches of the unified job runtime. Each routes NEW submissions of one job family through the runtime;
 * all default off, and an Attempt already running keeps the executor it started with. One line per family. */
export const MIGRATION_SWITCHES = Object.freeze({
  audioSingle: 'Single-file audio import and retry (S2-1)',
  audioBatch: 'Multi-file (batch) audio import and retry (S2-2)',
  coach: 'Preparation batches of 为你定制 (S4-4)',
  dailyRecap: 'Generations of the daily study recap (S4-5)',
  workflow: 'Teachings and skeletons of the learning workflow (S4-6)',
  generation: 'Question generation and supplements (S3-1)',
  retrievalIndex: 'Search-index builds of the retrieval extension (S5-5)',
});

const switches = () => Schema.object(Object.fromEntries(Object.entries(MIGRATION_SWITCHES)
  .map(([key, what]) => [key, Schema.boolean().default(false).description(what)])));

/** Host-owned provider resources (S1-3): quota domains shared by legacy and runtime paths. */
const resources = () => Schema.object({
  sharedProviderQuota: Schema.boolean().default(false),
  queueTimeoutMs: Schema.number().min(0).default(30000),
  bindings: Schema.array(Schema.object({
    resourceRef: Schema.string().required(), quotaDomainRef: Schema.string().required(),
    limit: Schema.number().min(1).step(1).required(),
    providerObservation: Schema.union(['none', 'external-request', 'host-attempt']).default('none'),
    routes: Schema.array(Schema.union(['free', 'paid', 'groq', 'siliconflow'])).required(),
  })).default([]),
});

/** The `runtime` section of the plugin Config. */
export const RuntimeConfig = Schema.object({ pilot: switches(), resources: resources() });
