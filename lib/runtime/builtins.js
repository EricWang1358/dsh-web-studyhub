import { Context } from '@deepseek-ai/cordis';
import { singleAudioDefinition } from '../contexts/audio/jobs/single-import.js';
import { batchAudioDefinition } from '../contexts/audio/jobs/batch-import.js';
import { subtitlesDefinition } from '../contexts/audio/jobs/subtitles.js';
import { generationDefinition, supplementDefinition } from '../contexts/generation/jobs/generation.js';
import { coachPrepDefinition } from '../contexts/coach/jobs/coach-prep.js';
import { createDailyRecapDefinition } from '../contexts/notes/jobs/daily-recap.js';
import { teachingDefinition } from '../contexts/workflows/jobs/teaching.js';
import { skeletonDefinition } from '../contexts/workflows/jobs/skeleton.js';
import { notify } from '../inbox.js';
import { retrievalIndexDefinition } from '../contexts/generation/retrieval/jobs/retrieval-index.js';
import { retrievalRuntimePort } from '../contexts/generation/retrieval/runtime-port.js';
import { StudyRuntime } from '../runtime.js';
import { fields, reads, actionGrants, writesFor } from './domain-contracts.js';
import { createStatePort } from './state-port.js';
import { modelServices } from './models.js';
import { createJobServices } from './jobs.js';
import { createJobNotifier } from './job-notice.js';
import { observeJob } from '../job-calls.js';
import { readSessionReply } from '../session-reply.js';
import { usageFrequencySchemas } from '../contexts/system/contracts.js';
import { usageLedger, recordedModels, featureOf } from '../model-usage.js';
import * as system from '../contexts/system/index.js';
import * as bank from '../contexts/bank/index.js';
import * as study from '../contexts/study/index.js';
import * as authoring from '../contexts/authoring/index.js';
import * as generation from '../contexts/generation/index.js';
import * as audio from '../contexts/audio/index.js';
import * as materials from '../contexts/materials/index.js';
import * as coach from '../contexts/coach/index.js';
import * as workflows from '../contexts/workflows/index.js';
import * as notes from '../contexts/notes/index.js';
import * as recording from '../contexts/recording/index.js';
import * as skeleton from '../contexts/skeleton/index.js';
import * as notifications from '../contexts/notifications/index.js';
import * as jobs from '../contexts/jobs/index.js';
import * as library from '../contexts/library/index.js';
import * as courses from '../contexts/courses/index.js';
import { materialsSchemas } from '../contexts/materials/contracts.js';
import { selectionSchemas } from '../contexts/generation/contracts.js';
import { translationSchemas } from '../contexts/materials/translation-contracts.js';
import { translationJobSchemas } from '../contexts/generation/translation-contracts.js';
import { createLiveRegistry } from '../live.js';
import { createUploadRegistry } from '../audio-upload.js';
import { oralAction } from '../oral-exam-service.js';
import { commitAssist } from '../assist-content.js';
import { validateDeck, defaults as settingsDefaults } from '../domain.js';
import { createWorkflowTeaching } from '../workflow-teaching.js';
import { createWorkflowSkeleton } from '../workflow-skeleton.js';
import { createWorkflowGuide } from '../workflow-guide.js';

// The job kinds each context runs on the unified runtime (their entry points choose it behind a `runtime.pilot` switch).
// What each context runs as Jobs of the unified runtime. The recap's settled-event sink writes its letter through the library's own runtime.
const managedDefinitions = runtime => ({
  audio: [singleAudioDefinition, batchAudioDefinition, subtitlesDefinition],
  coach: [coachPrepDefinition],
  generation: [generationDefinition, supplementDefinition, retrievalIndexDefinition],
  notes: [createDailyRecapDefinition({ sendLetter: letter => runtime.invoke('notes.v1', 'note.daily.letter', { letter }) })],
  workflows: [teachingDefinition, skeletonDefinition],
});
const modules = { system, bank, study, authoring, generation, audio, materials, coach, workflows, notes, recording, skeleton, notifications, jobs, library, courses };
export const fullContextIds = Object.freeze(Object.keys(fields));
const whole = new Set(['teaching', 'coach', 'feedback', 'prepared', 'inbox', 'skeletons', 'topicGroups', 'notes']);
const scalarDefaults = { settings: settingsDefaults, focus: undefined, learner: undefined, ingest: undefined, csdnHome: '' };
const defaultFor = field => Object.hasOwn(scalarDefaults, field) ? structuredClone(scalarDefaults[field]) : [];
const descriptors = Object.fromEntries(fullContextIds.map(id => [id, fields[id].filter(field => !Object.hasOwn(scalarDefaults, field)).map(name =>
  ({ name, mode: name === 'attempts' ? 'chunk' : whole.has(name) ? 'whole' : 'item', ...(name === 'attempts' ? { chunkSize: 1000 } : {}) }))]));

/** Registration owns plumbing; domains receive named snapshot, model, work and transaction ports. */
export function createBuiltinEnvironment(root, runtime) {
  const work = runtime.work, jobServices = createJobServices(work), owner = Symbol('runtime work owner'), definitions = managedDefinitions(runtime);
  const sessions = createLiveRegistry(), uploads = createUploadRegistry(), backup = runtime.backupPort();
  const routes = new Map();
  // Optional post-write composition keeps study independent of the notes plugin.
  const recapAfter = async (action, args, value, context) => {
    if (!has(context, 'notes')) return value;
    if (['course.rename', 'course.merge'].includes(action)) {
      await runtime.invoke('notes.v1', 'note.daily.reconcile', {}, context.services).catch(() => {});
      return value;
    }
    if (!['review.answer', 'review.move', 'review.skip', 'review.end', 'exam.submit', 'card.grade', 'oral.submit'].includes(action)) return value;
    const runId = args.runId || value?.runId;
    const final = ['review.end', 'exam.submit', 'oral.submit'].includes(action) || value?.complete === true ||
      (action === 'card.grade' && !!runId);
    // Calling the optional composer entry is safe after the study transaction has committed.
    await runtime.invoke('notes.v1', 'note.daily.advance', { ...(runId ? { runId } : {}), final }, context.services).catch(() => {});
    return value;
  };
  // What the study model uses is tallied per day and feature in the library (WP27).
  const ledger = usageLedger(root);
  runtime.liveSessions = sessions; runtime.uploads = uploads;
  const has = (context, id) => context.hasContext(id);
  const extraDependencies = { generation: ['authoring'], audio: ['generation'], jobs: ['audio', 'generation'], library: ['coach', 'jobs'] };
  const readFields = id => [...new Set(reads[id].flatMap(domain => fields[domain]))];
  // One frozen template per context: ports clone it when they read or write, so it is never handed out for mutation.
  const defaultTemplates = new Map();
  const defaultsFor = id => {
    if (!defaultTemplates.has(id)) defaultTemplates.set(id, Object.freeze(Object.fromEntries(readFields(id).map(field => [field, defaultFor(field)]))));
    return defaultTemplates.get(id);
  };
  const participantsFor = id => reads[id].filter(domain => domain !== id).map(domain => `${domain}.state`);
  const workFields = {
    bank: [], study: ['translateInflight'], authoring: ['jobs', 'generationControllers'],
    generation: ['jobs', 'queues', 'settled', 'generationControllers', 'generationMessengers', 'selectionActive', 'jobControls', 'jobOutputs'],
    audio: ['jobs', 'queues', 'settled', 'retryable', 'generationControllers', 'generationMessengers', 'audioGate', 'recoveredBatches', 'jobControls', 'jobOutputs'],
    coach: ['coachInflight', 'coachReplyInflight', 'followupInflight', 'suggestionInflight', 'coachTasks', 'coachQueues', 'rewriteSlots', 'prepPending'],
    workflows: ['workflowTeachingJobs', 'workflowSkeletonJobs', 'workflowModelCalls'], notes: ['noteJobs'],
    recording: ['captureQueues'], jobs: ['jobs', 'settled', 'generationMessengers', 'generationControllers', 'jobControls', 'jobOutputs'], library: ['jobs'],
  };
  const jobMethods = { coach: ['pruneJobs'], bank: ['assertDraftWritable'], generation: ['activeJob', 'pruneJobs'], audio: ['activeJob', 'publicJob', 'dropRetry', 'pruneJobs'],
    authoring: ['activeJob', 'checkSupplementPublication'], jobs: ['activeJob', 'publicJob', 'dropRetry', 'forgetRetry'], library: ['activeJob', 'publicJob', 'snapshotJob'] };
  const domainWork = id => Object.freeze(Object.fromEntries((workFields[id] || []).map(name => [name,
    id === 'library' && name === 'jobs' ? Object.freeze({ values: () => [...work.jobs.values()].map(job => { observeJob(job); return structuredClone(job); }).values() }) : work[name]])));
  const basePorts = (id, action, context) => {
    const state = createStatePort(root, context, { reads: reads[id].map(domain => `${domain}.v1`),
      writes: writesFor(id, action), participants: participantsFor(id), defaults: defaultsFor(id) }, id === 'library' ? backup : undefined);
    const models = recordedModels(modelServices(context.services), ledger, featureOf(id, action));
    const call = (target, args = {}) => {
      const route = routes.get(target);
      if (!route) throw new Error(`Capability unavailable: ${target}`);
      return context.invoke(route.api, route.operation, args);
    };
    const mutate = (target, state, args = {}) => {
      const route = routes.get(target);
      if (!route) throw new Error(`Capability unavailable: ${target}`);
      return context.mutate(route.api, route.operation, state, args);
    };
    const scopedWork = id === 'audio' && context.services.audioGate
      ? Object.freeze({ ...domainWork(id), audioGate: context.services.audioGate }) : domainWork(id), scopedJobs = Object.freeze(Object.fromEntries((jobMethods[id] || []).map(name => [name, jobServices[name]])));
    const workOwner = context.services.workOwner || owner;
    const worker = { store: state, ...models, workOwner };
    const ports = { state, ...models, worker, work: scopedWork, jobServices: scopedJobs, call, workOwner, announceJob: createJobNotifier(models.notify), ports: { mutate } };
    if (id === 'audio') {
      worker.runtimeJobs = context.jobs;
      worker.runtimePilot = context.services.runtimePilot;
      worker.runtimeBinding = () => { const background = basePorts(id, action, context.background()); return { worker: background.worker, work: background.work }; };
      worker.providerResources = context.services.providerResources?.scoped(workOwner, 'audio.v1');
      if (worker.providerResources?.enabled && ['audio.test', 'audio.subtitles.import', 'audio.corrections.review',
        'live.start', 'live.audio', 'live.resume', 'live.retry', 'live.correct', 'live.correct.background', 'live.generate', 'live.save'].includes(action))
        throw Object.assign(new Error('Shared provider quota is not verified for this audio path'), { code: 'capability-unverified' });
      Object.assign(worker, { sessions, uploads });
      // Cloud PDF conversion saves its merged result through the ordinary document import of the materials context.
      worker.documents = has(context, 'materials') ? Object.freeze({ import: args => context.invoke('materials.v1', 'document.import', args) }) : null;
      const publishSources = async (records, { assertCurrent } = {}) => {
        await context.state.update(state => {
          assertCurrent?.();
          for (const record of records) if (!state.audioResults.some(item => item.id === record.id)) state.audioResults.push(structuredClone(record));
        });
        assertCurrent?.();
        if (has(context, 'materials')) await context.invoke('materials.v1', 'sources.ingest', { sources: records });
      };
      publishSources.supportsAttemptGuard = true;
      worker.audioStore = Object.freeze({ root, publishSources, update: state.update, read: async () => {
        const snapshot = await state.read();
        if (!has(context, 'materials')) snapshot.sources = snapshot.audioResults;
        return snapshot;
      } });
      const audioServices = audio.createAudioWorker(worker, scopedWork, scopedJobs);
      Object.assign(ports, { audioServices, audioStore: worker.audioStore, audioSettings: worker.audioSettings, announceJob: worker.announceJob });
    }
    if (id === 'generation') ports.runtime = Object.freeze({ jobs: context.jobs, pilot: context.services.runtimePilot,
      sharedQuota: !!context.services.providerResources?.enabled, feature: featureOf(id, action) });
    if (id === 'notes') {
      // A daily recap generation runs as a Job (runtime.pilot.dailyRecap); the Job carries on in the background, not tied to this request.
      Object.assign(worker, { runtimeJobs: context.jobs, runtimePilot: context.services.runtimePilot,
        runtimeBinding: () => ({ worker: basePorts(id, action, context.background()).worker }) });
    }
    if (id === 'coach') {
      // A batch of variants runs as a Job (runtime.pilot.coach); its model is the gateway's light lane, which books the usage.
      Object.assign(worker, { runtimeJobs: context.jobs, runtimePilot: context.services.runtimePilot, pruneJobs: scopedJobs.pruneJobs,
        runtimeBinding: () => ({ worker: basePorts(id, action, context.background()).worker }) });
      Object.assign(ports, coach.createCoachWorker(worker, scopedWork));
    }
    // jobs: the final reply of a finished DSH sub-agent, read from its session on demand; never throws, null when the session cannot be read.
    if (id === 'jobs') ports.runtimeJobs = context.runtimeJobs;
    if (id === 'generation') ports.retrievalRuntime = retrievalRuntimePort(context, () => basePorts(id, action, context.background()));
    if (id === 'jobs') ports.sessions = Object.freeze({ lastReply: (childId, options) => readSessionReply(models.sessionQuery, childId, options) });
    if (id === 'workflows') {
      const outline = createWorkflowSkeleton(worker, scopedWork);
      const teaching = createWorkflowTeaching(worker, scopedWork, outline);
      const guide = createWorkflowGuide(worker, scopedWork, { ...outline, ...teaching });
      Object.assign(ports, teaching, { workflowHandlers: { ...teaching.workflowTeachingHandlers, ...outline.workflowSkeletonHandlers, ...guide.workflowGuideHandlers } });
      // A teaching and a skeleton run as Jobs (runtime.pilot.workflow); a Job carries on in the background, not tied to this request.
      ports.workflowRuns = { teaching: teaching.runTeaching, skeleton: outline.runSkeleton };
      Object.assign(worker, { runtimeJobs: context.jobs, runtimePilot: context.services.runtimePilot,
        runtimeBinding: () => ({ runs: basePorts(id, action, context.background()).workflowRuns }) });
    }
    if (id === 'library') {
      ports.usage = ledger;
      ports.coachActivity = async () => has(context, 'coach') ? context.invoke('coach.v1', 'coach.activity') : [[], 0];
      ports.coachStatus = async () => has(context, 'coach') ? context.invoke('coach.v1', 'coach.status') : { enabled: false, ready: 0, tasks: [] };
      ports.attachments = { export: documents => context.invoke('materials.v1', 'attachments.export', { documents }),
        import: attachments => context.invoke('materials.v1', 'attachments.import', { attachments }) };
    }
    return ports;
  };
  const table = (id, action, context) => {
    const ports = basePorts(id, action, context), operations = modules[id]?.createOperations?.(ports) || { handlers: {}, mutations: {} };
    if (id === 'workflows') Object.assign(operations.handlers, ports.workflowHandlers);
    return { ports, ...operations };
  };
  return { install(id) {
    if (!Object.hasOwn(fields, id)) throw new Error(`Unknown built-in context: ${id}`);
    const declaration = modules[id]?.createOperations?.({ work, jobServices, audioServices: {}, state: {}, worker: { sessions, uploads } }) || { handlers: {}, mutations: {} };
    const actions = [...Object.keys(declaration.handlers), ...Object.keys(declaration.mutations)];
    if (id === 'workflows') {
      const worker = { store: {} }, outline = createWorkflowSkeleton(worker, work), teaching = createWorkflowTeaching(worker, work, outline), guide = createWorkflowGuide(worker, work, { ...outline, ...teaching });
      actions.push(...Object.keys({ ...outline.workflowSkeletonHandlers, ...teaching.workflowTeachingHandlers, ...guide.workflowGuideHandlers }));
    }
    if (id === 'study') actions.push(...['active', 'start', 'get', 'report', 'answer', 'next', 'followup', 'submit'].map(name => `oral.${name}`), 'assist.commit');
    if (id === 'coach') actions.push('coach.activity', 'coach.idle', 'coach.flush', 'coach.queue');
    const dependencies = [...new Set([...reads[id].filter(domain => domain !== id), ...Object.keys(actionGrants[id] || {}), ...(extraDependencies[id] || [])])].map(domain => `${domain}.v1`);
    const grants = Object.fromEntries(dependencies.map(api => [api, ['state.read', ...(actionGrants[id]?.[api.replace('.v1', '')] || [])]]));
    const descriptor = { id, version: 1, fields: fields[id], collections: descriptors[id], dependencies, grants, defaults: defaultsFor(id), readFields: readFields(id),
      writes: Object.fromEntries(actions.map(action => [action, writesFor(id, action)])),
      transactions: Object.fromEntries(actions.map(action => [action, participantsFor(id)])),
      aliases: Object.fromEntries(actions.filter(action => !action.startsWith('assist.')).map(action => [action, action])),
      // `state.read` already returns a private copy of every field it names; copying that again on the way out doubled the cost of every library read.
      operations: { 'state.read': { ownsResult: true, execute: (args, context) => args?.shared ? context.state.view(args.fields) : context.state.read(args?.fields) } },
      mutate(action, state, args, context) {
        const operations = table(id, action, context), mutation = operations.mutations[action];
        if (!mutation) throw new Error(`Mutation unavailable: ${id}.v1.${action}`);
        return mutation(state, args, operations.ports.ports);
      } };
    for (const action of actions) {
      descriptor.operations[action] = { execute: async (args, context) => {
        const operations = table(id, action, context), ports = operations.ports;
        if (id === 'bank' && ['draft.save', 'draft.delete'].includes(action)) ports.jobServices.assertDraftWritable(root, action === 'draft.save' ? args.deck?.id : args.id, args.publishJobId);
        if (id === 'authoring') args = await authoring.preparePublication(action, args, ports);
        if (action === 'deck.remove' && [...work.jobs.values()].some(job => jobServices.activeJob(job) &&
          (job.deckId === args.id || job.mergeTargetId === args.id)))
          throw new Error('这个题组正在用于后台任务，请等待或取消任务后再删除');
        if (id === 'library' && action === 'source.remove') {
          if (!has(context, 'bank') || !has(context, 'study')) throw new Error('删除资料前请启用题库和学习组件，以检查已保存题目与学习记录的引用');
          const ids = new Set(args.sourceIds || [args.id]);
          if ([...work.jobs.values()].some(job => jobServices.activeJob(job) && job.sourceIds?.some(id => ids.has(id)))) throw new Error('这份资料正在用于出题，请等待或取消生成任务后再删除');
        }
        if (id === 'audio' && ['audio.import', 'audio.retry'].includes(action)) await ports.audioServices.recoverAudioBatches(ports.worker);
        if (((id === 'library' && action === 'snapshot') || id === 'jobs') && has(context, 'audio')) await context.invoke('audio.v1', 'recover', { again: action === 'job.control' && ['resume', 'retry'].includes(args.action) });
        // A coverage run the last process left running comes back as an interrupted job (lib/contexts/generation/operations.js coverage.recover); the draft is its checkpoint.
        if (((id === 'library' && action === 'snapshot') || id === 'jobs') && has(context, 'generation')) await context.invoke('generation.v1', 'coverage.recover').catch(() => {});
        if (action.startsWith('oral.')) return recapAfter(action, args, await oralAction(ports.worker, action, args), context);
        if (action === 'assist.commit') return recapAfter(args.mode === 'grade' ? 'card.grade' : action, args,
          await ports.state.update(state => commitAssist(state, args, Object.fromEntries(['card.update', 'card.link', 'card.followup.add'].map(name => [name, (state, args) => ports.ports.mutate(name, state, args)])))), context);
        if (action === 'coach.activity') return ports.coachActivity();
        if (action === 'coach.idle') return ports.coachIdle();
        if (action === 'coach.flush') return ports.flushPrep();
        if (action === 'coach.queue') return ports.queuePrep(args);
        if (action === 'settings' && !Object.keys(args).length) return (await context.state.read()).settings;
        if (operations.mutations[action]) {
          const changed = ['review.move', 'review.reveal', 'review.skip', 'review.answer'].includes(action) && typeof args.runId === 'string'
            ? { runs: new Set([args.runId]), ...(action === 'review.answer' ? { decks: 'all', attempts: true } : {}) } : null;
          const value = await ports.state.update(state => { if (args.publishJobId) jobServices.checkSupplementPublication(args); return operations.mutations[action](state, args, ports.ports); }, changed);
          if (action === 'draft.delete') for (const job of work.jobs.values()) if (job.draftId === args.id && jobServices.activeJob(job)) { job.cancelRequestedAt ||= new Date().toISOString(); work.generationControllers.get(job.id)?.abort(new Error('Draft deleted')); }
          return recapAfter(action, args, value, context);
        }
        return recapAfter(action, args, await operations.handlers[action](args), context);
      } };
      routes.set(action, { api: `${id}.v1`, operation: action });
    }
    if (id === 'materials') {
      for (const [action, schema] of Object.entries({ ...materialsSchemas, ...translationSchemas })) {
        const name = action.replace(/^materials\./, '');
        descriptor.operations[name] = { ...schema, requiresModel: ['selection.ask', 'outline.suggest', 'translation.translate'].includes(name), execute: (args, context) => {
          // The composer adds optional public bank DTOs for legacy course inference without a reverse materials dependency.
          const read = name === 'document.list' ? async () => {
            const own = await context.state.read();
            if (!has(context, 'bank')) return own;
            const related = await runtime.invoke('bank.v1', 'state.read', { fields: ['decks', 'drafts'], shared: true }, context.services);
            return { ...related, ...own };
          } : context.state.read;
          const owner = materials.createMaterialsOperations({ root, read, update: context.state.update, complete: recordedModels(modelServices(context.services), ledger, featureOf('materials', name)).complete });
          return owner.handlers[action](args, context.services);
        } }; descriptor.aliases[action] = name;
        // Pricing the one call needs no model: the panel shows the estimate before it asks for a model.
        if (name === 'outline.suggest') descriptor.operations[name].canRunWithoutModel = args => args.estimate === true;
        // Cached, reused, skipped and unlocated passages and the price need no model: the operation says plainly what it could not do.
        if (name === 'translation.translate') descriptor.operations[name].canRunWithoutModel = () => true;
      }
      descriptor.operations['sources.ingest'] = { execute: (args, context) => context.state.update(state => {
        for (const source of args.sources) { const existing = state.sources.find(item => item.id === source.id); if (existing && existing.text !== source.text) throw new Error('Source identity conflict');
          if (!existing) state.sources.push(structuredClone(source)); else existing.courses = [...new Set([...(existing.courses || []), ...(source.courses || [])])]; }
        return { sourceIds: args.sources.map(source => source.id) };
      }) };
      descriptor.operations['attachments.export'] = { execute: args => materials.exportAttachments(root, args.documents) };
      descriptor.operations['attachments.import'] = { execute: args => materials.importAttachments(root, args.attachments) };
    }
    // The usage frequency record's operations carry real input contracts like the other typed operations.
    if (id === 'system') for (const [action, schema] of Object.entries(usageFrequencySchemas)) Object.assign(descriptor.operations[action], schema);
    if (id === 'bank') { Object.assign(descriptor.operations, bank.createBankOperations()); Object.assign(descriptor.aliases, { 'bank.deck.get': 'get', 'bank.cards.list': 'cards', 'bank.decks.list': 'list', 'card.find': 'card.search' }); }
    if (id === 'authoring') descriptor.operations.validate = { execute: args => validateDeck(args.deck, args.sources || []) };
    if (id === 'notes') {
      // The letter of a settled recap Job (its definition's settled-event sink): written on its own, so a failed letter never changes how the Job ended.
      descriptor.writes['note.daily.letter'] = writesFor(id, 'note.daily.letter'); descriptor.transactions['note.daily.letter'] = participantsFor(id);
      descriptor.operations['note.daily.letter'] = { execute: (args, context) => basePorts(id, 'note.daily.letter', context).state.update(state => { notify(state, args.letter); }) };
    }
    if (id === 'audio') {
      Object.assign(descriptor.operations, audio.createAudioOperations(root, work, sessions));
      descriptor.writes.recover = writesFor(id, 'audio.import'); descriptor.transactions.recover = participantsFor(id);
      descriptor.operations.recover = { execute: (args, context) => { const ports = basePorts(id, 'audio.import', context); return ports.audioServices.recoverAudioBatches(ports.worker, { again: args?.again === true }).then(() => ({ recovered: true })); } };
      // The jobs context reads a folder again after an archived job is unarchived (the grant `jobs → audio: recover`).
      routes.set('recover', { api: 'audio.v1', operation: 'recover' });
      descriptor.operations['settings.resolved'] = { execute: (_args, context) => basePorts(id, 'audio.settings.get', context).worker.audioSettings() };
    }
    if (id === 'generation') for (const name of ['selection.supplement', 'selection.get', 'selection.commit', 'selection.review', 'selection.start', 'selection.status', 'selection.jobs', 'selection.saveAnswer']) {
      descriptor.operations[name] = { ...selectionSchemas[name], requiresModel: ['selection.supplement', 'selection.review', 'selection.start'].includes(name), execute: (args, context) => {
        // Passage supplementation runs as an ordinary background job: the job table, queue, notice and inbox of every generation job.
        const jobPorts = ['selection.start', 'selection.status', 'selection.jobs'].includes(name) ? (() => {
          const started = basePorts('generation', 'selection.start', context);
          return { work: { jobs: work.jobs, queues: work.queues, settled: work.settled, generationControllers: work.generationControllers },
            jobServices: { activeJob: jobServices.activeJob, pruneJobs: jobServices.pruneJobs, publicJob: jobServices.publicJob },
            mail: update => started.state.update(update), announce: started.announceJob };
        })() : undefined;
        const selectionOwner = generation.createSelectionOperations({ root, read: context.state.read, update: context.state.update, complete: recordedModels(modelServices(context.services), ledger, featureOf('generation', name)).complete, active: work.selectionActive, workOwner: context.services.workOwner || owner, jobs: jobPorts,
          materials: (action, payload, request) => context.invoke('materials.v1', action.replace(/^materials\./, ''), payload, request),
          bank: { get: (deckId, request) => context.invoke('bank.v1', 'get', { deckId }, request), append: (payload, request) => context.invoke('bank.v1', 'append', payload, request),
            ensureDeck: (payload, request) => context.invoke('bank.v1', 'deck.ensure', payload, request) } });
        return selectionOwner[`generation.${name}`](args, context.services);
      } };
      descriptor.operations[name].canRunWithoutModel = async (args, state) => { const job = (await state.read()).selectionJobs?.find(item => item.operationId === args.operationId); return !!job && (job.reviewPassed || !['preparing', 'writing', 'reviewing'].includes(job.status)); };
      descriptor.aliases[`generation.${name}`] = name;
    }
    // 翻译本页 / 翻译本章: the same job table, queue, notice and inbox as the passage supplement; the translations themselves are the materials context's.
    if (id === 'generation') for (const name of Object.keys(translationJobSchemas)) {
      descriptor.operations[name] = { ...translationJobSchemas[name], requiresModel: name === 'translation.start', canRunWithoutModel: args => args.estimate === true, execute: (args, context) => {
        const started = basePorts('generation', 'translation.start', context);
        const handlers = generation.createTranslationJobs({ root, workOwner: context.services.workOwner || owner, complete: recordedModels(modelServices(context.services), ledger, featureOf('generation', 'translation.start')).complete,
          materials: (action, payload, request) => context.invoke('materials.v1', action.replace(/^materials\./, ''), payload, request) },
        { work: { jobs: work.jobs, queues: work.queues, settled: work.settled, generationControllers: work.generationControllers, jobControls: work.jobControls, jobOutputs: work.jobOutputs },
          jobServices: { activeJob: jobServices.activeJob, pruneJobs: jobServices.pruneJobs, publicJob: jobServices.publicJob }, mail: update => started.state.update(update), announce: started.announceJob });
        return handlers[`generation.${name}`](args, context.services);
      } };
      descriptor.aliases[`generation.${name}`] = name;
    }
    if (id === 'generation') { descriptor.writes['selection.start'] = writesFor(id, 'selection.start'); descriptor.transactions['selection.start'] = participantsFor(id); descriptor.writes['translation.start'] = writesFor(id, 'translation.start'); descriptor.transactions['translation.start'] = participantsFor(id); }
    if (id === 'library') {
      descriptor.aliases['source.find'] = 'source.search';
      descriptor.aliases['materials.pages.cards'] = { operation: 'materials.pages.cards', priority: 1 };
      for (const action of ['source.import', 'source.courses.set']) descriptor.aliases[action] = { operation: action, priority: 1 };
    }
    if (id === 'bank') {
      descriptor.aliases['materials.links.list'] = { operation: 'material.links.list', priority: 1 };
      descriptor.operations['material.links.list'] = { execute: (args, context) => { const state = basePorts(id, 'material.links.list', context).state;
        const owner = materials.createMaterialsOperations({ root, read: state.read, update: state.update, bankCards: filter => bank.createBankOperations().cards.execute(filter, context) }); return owner.handlers['materials.links.list'](args, context.services); } };
    }
    descriptor.dispose = () => {
      for (const [action, route] of routes) if (route.api === `${id}.v1`) routes.delete(action);
      if (id === 'generation' || id === 'audio') {
        for (const job of work.jobs.values()) if (jobServices.activeJob(job) && (id === 'audio' ? ['audio-import', 'pdf-convert'].includes(job.type) : !job.type || ['draft-publish', 'draft-repair', 'supplement', 'translation'].includes(job.type))) { job.cancelRequestedAt ||= new Date().toISOString(); work.generationControllers.get(job.id)?.abort(new Error(`${id} plugin unloaded; approved content retained`)); }
        if (id === 'generation') for (const running of work.selectionActive.values()) running.controller?.abort(new Error('Generation plugin unloaded'));
        if (id === 'audio') { void sessions.activeSession(root)?.stop('音频插件已卸载'); sessions.clear(); }
      }
      if (id === 'coach') {
        for (const pending of work.prepPending.values()) clearTimeout(pending.timer); work.prepPending.clear();
        for (const tasks of work.coachTasks.values()) for (const task of tasks) task.cancelled = true;
      }
      if (id === 'notes') for (const pending of work.noteJobs.values()) pending.controller?.abort(new Error('Notes plugin unloaded'));
      if (id === 'workflows') for (const job of [...work.workflowTeachingJobs.values(), ...work.workflowSkeletonJobs.values()]) job.cancelled = true;
    };
    const dispose = runtime.register(descriptor);
    if (definitions[id]) {
      const scope = new Context(), previousDispose = descriptor.dispose;
      for (const definition of definitions[id]) runtime.registerJob(scope, `${id}.v1`, definition);
      descriptor.dispose = async () => { await scope.fiber.dispose(); previousDispose(); };
    }
    runtime.registerParticipant(`${id}.v1`, { name: `${id}.state`, fields: fields[id], validate: state => state });
    if (id === 'materials') {
      runtime.registerParticipant('materials.v1', { name: 'materials.selection', fields: ['sources', 'documents'], validate: (state, args) => materials.validateSelection(state, args.selection) });
      runtime.registerParticipant('materials.v1', { name: 'materials.evidence', fields: ['sources'], validate: state => state.sources });
    }
    return dispose;
  } };
}

export function createStudyRuntime(root, { contexts: selected = fullContextIds, ...options } = {}) {
  const runtime = new StudyRuntime(root, { services: options, storage: options.storage }), environment = createBuiltinEnvironment(root, runtime);
  for (const id of selected) environment.install(id);
  return runtime;
}
