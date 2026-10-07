import Schema from 'schemastery';

/** Migration switches of the unified job runtime. Each routes NEW submissions of one job family through the runtime;
 * all default off, and an Attempt already running keeps the executor it started with. One line per family. */
export const MIGRATION_SWITCHES = Object.freeze({
  audioSingle: 'Single-file audio import and retry (S2-1)',
  audioLiveSave: 'Proofread save of a live class (S2-6)',
  audioLiveCorrection: 'Context correction of a live class (S2-5)',
  audioReview: 'Review of the unsure fixes of a transcript (S2-5)',
  audioSubtitles: 'Subtitle file imports (S2-4)',
  audioBatch: 'Multi-file (batch) audio import and retry (S2-2)',
  coach: 'Preparation batches of 为你定制 (S4-4)',
  dailyRecap: 'Generations of the daily study recap (S4-5)',
  workflow: 'Teachings and skeletons of the learning workflow (S4-6)',
  examBlueprint: 'The exam blueprint build: a list of exam points from lecture slides and a sample paper (3.1 step 2)',
  dailyRecapAgent: 'Daily recap generations ask a host sub-agent when there is one (S4-8)',
  workflowAgent: 'Learning-workflow teachings and skeletons ask a host sub-agent when there is one (S4-8)',
  assist: 'Requests of the learner\'s assistant (S4-7)',
  generation: 'Question generation and supplements (S3-1)',
  generationRestart: 'Generation runs survive a restart: kept on disk, interrupted, continued where the draft stopped (S3-3; needs generation)',
  generationRepair: 'Background repair of rejected draft cards (S3-5; needs generation: without it this switch does nothing)',
  generationPublish: 'Publication of a draft: the check, then the one write, which is never done twice after a crash (S3-6; needs generation: without it this switch does nothing)',
  markerInstall: 'The one-click Marker install (S5-3)',
  mineruSetup: 'The local MinerU setup: models and managed mode (S5-4)',
  noteGenerate: 'The AI draft of a note (S4-10)',
  pdfConvert: 'Cloud and local PDF conversion (Marker and MinerU) (S5-2)',
  retrievalIndex: 'Search-index builds of the retrieval extension (S5-5)',
  translation: 'Page and chapter translations (S4-2)',
  translationParallel: 'Translations no longer wait for whole-library generation (S4-3)',
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
    routes: Schema.array(Schema.union(['free', 'paid', 'groq', 'siliconflow', 'instant-text'])).required(),
  })).default([]),
});

/** The `runtime` section of the plugin Config. */
export const RuntimeConfig = Schema.object({ pilot: switches(), resources: resources() });
