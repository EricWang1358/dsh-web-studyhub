/* S1-0 evidence only. Load as a companion plugin in the isolated QA web host.
 * It registers no services, controller, tools, provider, or StudyHub implementation.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

export const name = 'studyhub-s10-host-probe';
export const inject = [];
const required = ['llm', 'agents', 'agentLoop', 'sessions', 'jobs', 'subagents', 'tools'];
const methods = {
  llm: ['stream', 'resolveCallConfig', 'resolveModelInfo', 'listProviders'],
  agents: ['create', 'get'], sessions: ['get'],
  jobs: ['start', 'get', 'list', 'wait', 'kill', 'readAt', 'remove', 'attachController'],
  subagents: ['start', 'getProvider'], tools: ['restrict'],
  agentPresets: ['mount', 'composedPreset'],
  sessionQuery: ['observeSession'], sessionPersistence: ['stat'],
  uiWorkspace: ['openSession'],
};

function below(root, target) {
  const tail = relative(resolve(root), resolve(target));
  return tail !== '' && !tail.startsWith(`..${sep}`) && tail !== '..' && !isAbsolute(tail);
}
function service(ctx, key) {
  try { return ctx.get(key); } catch { return undefined; }
}
function inventory(ctx) {
  return Object.fromEntries(Object.entries(methods).map(([key, names]) => {
    const value = service(ctx, key);
    return [key, { present: !!value, methods: Object.fromEntries(names.map(method => [method, typeof value?.[method] === 'function'])) }];
  }));
}
const eventsOf = session => Array.from({ length: Number(session.seq) }, (_, seq) => session.eventAt(seq));
const safeFailure = error => ({ name: error?.name || 'Error', code: error?.code || null,
  message: String(error?.message || error).replace(/token=\S+/g, 'token=…').slice(0, 700) });
function abortable(work, signal) {
  signal.throwIfAborted();
  let rejectAbort;
  const aborted = new Promise((_, reject) => { rejectAbort = () => reject(signal.reason); });
  signal.addEventListener('abort', rejectAbort, { once: true });
  return Promise.race([work, aborted]).finally(() => signal.removeEventListener('abort', rejectAbort));
}
async function save(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n');
  await rename(temporary, path);
}

export function apply(ctx, config) {
  // Fail closed outside the private run prepared by run-host-probe.mjs.
  const qaRoot = resolve(config.qaRoot || '.');
  const workspace = resolve(config.workspace || '.');
  const reportPath = resolve(config.reportPath || '.');
  if (process.env.SSH_TTY !== 'audit' || !below(qaRoot, process.env.DSH_HOME || '.') ||
      !below(qaRoot, workspace) || !below(qaRoot, reportPath) ||
      config.provider !== 'studyhub-qa-fake' || config.model !== 'fake-tutor') {
    throw new Error('S1-0 probe requires an isolated output/qa home, workspace and fake route');
  }
  const officialVariant = config.variant === 'official-jobs-preset';
  if (!['bare', 'official-jobs-preset'].includes(config.variant || 'bare')) throw new Error('Unknown S1-0 probe variant');
  const report = {
    schemaVersion: 1, kind: config.auditStudyHub ? 'S1-2 StudyHub binding preflight' : 'S1-0 actual-host companion probe', startedAt: new Date().toISOString(),
    done: false, ok: false, pluginScope: inventory(ctx), steps: [],
    variant: config.variant || 'bare',
    controllerLoadedByTestVariant: officialVariant,
    controllerProvisioning: officialVariant ? 'test-added official dsh-tool-jobs in s10-jobs-only preset' : 'no test controller or preset mount',
    profileDefaultUntouched: true,
    limitations: [
      config.auditStudyHub
        ? 'Also inspects the installed StudyHub fiber and submits a controlled producer through its jobs service. No production v2 executor or binding is installed.'
        : 'Measures this companion plugin and genuine agent scopes in the isolated rc.2 web host; production StudyHub plugin fiber injection is not directly intercepted.',
      'Server-side uiWorkspace presence is informational only. Browser openSession, authorization, sidebar visibility and P0 console workflow are unverified.',
      'Uses only the QA fake OpenAI endpoint. Real provider behavior, quality, SDK internal retries, 429 shared cooldown and price are unverified.',
      'Does not test continuable children, child signal cancellation under a held model request, unavailable-service unloading, or manifest recovery.',
      'No claim about atomic crash durability, reliable notification redelivery, or all session persistence backends.',
      ...(officialVariant ? ['Official-controller variant explicitly mounts the test-only s10-jobs-only preset. It does not prove bare agents.create or every default/preset composition has job controls. The baseline refusal is preserved separately.'] : []),
    ],
  };
  let started = false;
  // This readiness timer records missing dependencies; it never invents them.
  const timer = setTimeout(() => {
    if (started) return;
    report.error = { message: 'Required host services were not injected within 20 seconds' };
    report.pluginScope = inventory(ctx);
    report.done = true;
    report.finishedAt = new Date().toISOString();
    void save(reportPath, report).catch(error => ctx.logger?.error(error));
  }, 20_000);
  ctx.effect(() => () => clearTimeout(timer));
  ctx.inject(officialVariant ? [...required, 'agentPresets'] : required, live => {
    if (started || report.done) return;
    started = true;
    clearTimeout(timer);
    // Preset audits await the host loader tree. Start after our own activation
    // callback returns, so mounting cannot wait for itself to activate.
    const immediate = setImmediate(async () => {
      await runProbe(live, config, report).catch(error => { report.error = safeFailure(error); });
      report.finishedAt = new Date().toISOString();
      report.done = true;
      report.ok = !report.error && report.steps.length > 0 && report.steps.every(step => step.status === 'ok');
      await save(reportPath, report);
    });
    live.effect(() => () => clearImmediate(immediate));
  });
}

async function runProbe(ctx, config, report) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error('S1-0 host probe exceeded 45 seconds')), 45_000);
  const signal = controller.signal;
  const handles = [];
  const producers = [];
  const subscriptions = [];
  const jobs = service(ctx, 'jobs');
  const agents = service(ctx, 'agents');
  const route = { provider: config.provider, model: config.model, maxTokens: 256 };
  const officialVariant = config.variant === 'official-jobs-preset';
  let child, parentScopeDisposals = 0, parent, sibling;
  const step = async (id, work) => {
    const startedAt = new Date().toISOString();
    try {
      const evidence = await work();
      report.steps.push({ id, status: 'ok', startedAt, evidence });
      return evidence;
    } catch (error) {
      report.steps.push({ id, status: 'failed', startedAt, error: safeFailure(error) });
      throw error;
    }
  };
  try {
    report.injectedScope = inventory(ctx);
    const sdkRoot = resolve(config.sdkRoot);
    report.packageVersions = {};
    for (const packageName of ['dsh', 'dsh-agent', 'dsh-llm', 'dsh-jobs-local', 'dsh-subagent', ...(officialVariant ? ['dsh-tool-jobs', 'dsh-agent-preset', 'dsh-agent-preset-registry'] : [])]) {
      const manifest = JSON.parse(await readFile(join(sdkRoot, packageName, 'package.json'), 'utf8'));
      report.packageVersions[packageName] = manifest.version;
      assert.equal(manifest.version, '0.2.0-rc.2');
    }
    const { createUserMessage, BlockAssembler } = await import(pathToFileURL(join(sdkRoot, 'dsh-llm/lib/index.js')).href);
    const { scopeOf } = await import(pathToFileURL(join(sdkRoot, 'dsh-scope/lib/index.js')).href);
    const { until } = await import(pathToFileURL(config.waitModule).href);
    await until(() => service(ctx, 'llm').listProviders().some(provider => provider.id === route.provider),
      'the registered QA fake adapter', { timeoutMs: 10_000 });
    await step('DSH-01/04 create-live-fake-parent', async () => {
      assert.ok(service(ctx, 'llm').listProviders().some(provider => provider.id === route.provider), 'fake adapter not registered');
      const create = async (ownsEffect = false) => {
        const pending = agents.create({ sessionId: randomUUID(), meta: { cwd: config.workspace },
          agentOptions: route, signal, setup: async scoped => {
            const tools = service(scoped, 'tools');
            assert.equal(typeof tools?.restrict, 'function', 'cannot restrict parent tools');
            tools.restrict({ allow: [] });
            if (officialVariant) await service(ctx, 'agentPresets').mount(scoped, 's10-jobs-only');
            if (ownsEffect) scoped.effect(() => () => { parentScopeDisposals++; });
          } });
        // Dispose a late admission after timeout instead of abandoning its handle.
        pending.then(handle => { if (signal.aborted) void handle.dispose().catch(() => {}); }, () => {});
        const handle = await abortable(pending, signal);
        handles.push(handle);
        return handle.agent;
      };
      parent = await create(true);
      sibling = await create();
      assert.equal(agents.get(parent.id), parent);
      assert.equal(service(ctx, 'sessions').get(parent.id), parent.session);
      assert.ok(scopeOf(parent.ctx), 'real agent scope missing');
      const visibleToolNames = service(parent.ctx, 'tools').schemas(scopeOf(parent.ctx)).map(tool => tool.name);
      assert.deepEqual(visibleToolNames, [], 'test parent would expose tools to the fake model');
      if (officialVariant) {
        assert.equal(service(ctx, 'agentPresets').composedPreset(parent.ctx), 's10-jobs-only');
        report.composition = { profileDefaultId: service(ctx, 'agentPresets').defaultId,
          mountedPresetId: 's10-jobs-only', controllerModule: '@deepseek-ai/dsh-tool-jobs',
          controllerLoadedByTestVariant: true, visibleToolNames, completionDelivery: 'quiet' };
      }
      report.agentScope = inventory(parent.ctx);
      parent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'S1-0 fake parent smoke. Reply with one short line.' }] }));
      await abortable(parent.whenIdle(), signal);
      const events = eventsOf(parent.session);
      const end = events.filter(event => event.type === 'turn/end').at(-1);
      assert.equal(end?.data?.reason?.kind, 'completed');
      assert.ok(events.some(event => event.type === 'assistant/message'), 'parent produced no assistant event');
      return { exactLiveAgent: true, liveSession: true, scoped: true, parentTurnReason: end.data.reason.kind, toolsRestricted: true,
        visibleToolNames, composedPresetId: service(ctx, 'agentPresets')?.composedPreset(parent.ctx) ?? null };
    });
    if (config.auditStudyHub) await step('DSH-01/03/09 studyhub-fiber-binding-preflight', async () => {
      const root = ctx.root || ctx;
      const host = root[Symbol.for('studyhub.workbench.host.v1')];
      assert.ok(host?.fiber?.ctx, 'installed production StudyHub workbench fiber is missing');
      const api = service(root, 'studyRuntime');
      const first = await api.requestServices({ agent: parent });
      const second = await api.requestServices({ agent: sibling });
      assert.equal(first.workOwner, host.services.workOwner);
      assert.equal(second.workOwner, first.workOwner);
      assert.equal(first.audioGate, host.services.audioGate);
      assert.equal(second.audioGate, first.audioGate);
      assert.equal(first.sessionId, parent.id);
      assert.equal(second.sessionId, sibling.id);
      assert.equal(first.executor, undefined, 'baseline unexpectedly acquired a v2 executor');
      const workbenchJobs = service(host.fiber.ctx, 'jobs');
      assert.equal(typeof workbenchJobs?.start, 'function');
      let release, cancels = 0, starts = 0;
      const done = new Promise(resolve => { release = resolve; });
      producers.push(() => release({ status: 'killed' }));
      const events = [];
      subscriptions.push(service(parent.ctx, 'jobs').events.subscribe({ owners: 'scope' }, event => {
        if (event.type === 'settled') events.push(event.job.id);
      }));
      assert.throws(() => workbenchJobs.start({ kind: 's12-preflight', owner: randomUUID(),
        run: () => { starts++; return { done }; } }), /owner|agent|session/i);
      assert.equal(starts, 0, 'unknown owner must reject before producer dispatch');
      const id = workbenchJobs.start({ kind: 's12-preflight', owner: parent.id, label: 'S1-2 held cleanup',
        run: () => { starts++; return { done, cancel: () => { cancels++; } }; } });
      assert.equal(starts, 1);
      assert.equal(jobs.get(id, parent.id).owner, parent.id);
      assert.throws(() => jobs.get(id, sibling.id), /another session/);
      assert.equal(jobs.kill(id, parent.id), 'requested');
      assert.equal(jobs.get(id, parent.id).status, 'stopping');
      assert.equal(cancels, 1);
      jobs.kill(id, parent.id);
      // rc.2 repeats producer.cancel while stopping. Record the observed host
      // behavior; S1-2 still needs idempotent business control admission.
      assert.equal(cancels, 2);
      const observed = await jobs.wait(id, 5, parent.id, signal);
      assert.equal(observed.status, 'stopping', 'stop request cannot stand in for physical cleanup');
      assert.equal(events.filter(value => value === id).length, 0);
      release({ status: 'killed', detail: 'Controlled producer actually released' });
      assert.equal((await jobs.wait(id, 10_000, parent.id, signal)).status, 'killed');
      assert.equal(events.filter(value => value === id).length, 1);
      jobs.remove(id, parent.id);
      return { productionFiberObserved: true, sharedSymbolOwner: true, sharedAudioGate: true,
        distinctInitiatingSessions: true, productionExecutorBinding: false,
        unknownOwnerRejectedBeforeDispatch: true, controllerLoadedByTestVariant: true,
        heldStopRemainedStopping: true, repeatedKillCallsProducerAgain: true,
        cancelCalls: cancels, settledEvents: 1 };
    });
    await step('DSH-04/07 direct-stream-and-usage', async () => {
      const llm = service(parent.ctx, 'llm');
      const call = await llm.resolveCallConfig(route, signal);
      const assembler = new BlockAssembler();
      let chunks = 0;
      for await (const chunk of llm.stream({ ...call, sessionId: parent.id, signal,
        system: 'This is an isolated fake provider capability test.',
        messages: [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'S1-0 direct smoke.' }] })] })) {
        assembler.push(chunk); chunks++;
      }
      assert.equal(assembler.finish.kind, 'stop');
      assert.ok(assembler.blocks().some(block => block.type === 'text' && block.text.length > 0));
      assert.ok(Number.isFinite(assembler.usage?.inputTokens));
      assert.ok(Number.isFinite(assembler.usage?.outputTokens));
      const info = await llm.resolveModelInfo(route.provider, route.model, signal);
      let rejected;
      try { await llm.resolveCallConfig({ ...route, reasoningEffort: 's10-intentionally-unsupported-effort' }, signal); }
      catch (error) { rejected = safeFailure(error); }
      assert.ok(rejected, 'fake model accepted an unsupported reasoning effort');
      return { chunks, finish: assembler.finish.kind, reportedUsage: assembler.usage,
        offeredEffortCount: info?.reasoning?.efforts?.length ?? null, unsupportedEffortRejected: rejected };
    });
    await step('DSH-05/09 one-shot-child', async () => {
      const subagents = service(parent.ctx, 'subagents');
      await until(() => subagents.getProvider('spawn'), 'the host spawn provider', { timeoutMs: 10_000 });
      const provider = subagents.getProvider('spawn');
      assert.ok(provider?.capabilities?.toolFilter && provider.capabilities.agentOptions, 'spawn lacks required capabilities');
      const label = 'S1-0 fake one-shot evidence';
      const lifecycle = [];
      subscriptions.push(parent.ctx.on('subagent/start', info => { lifecycle.push({ type: 'start', ...info }); }));
      subscriptions.push(parent.ctx.on('subagent/end', info => { lifecycle.push({ type: 'end', id: info.id, runId: info.runId, stopReason: info.stopReason }); }));
      const pending = subagents.start('spawn', { parent, label, signal, toolFilter: { allow: [] }, agentOptions: route,
        prompt: [{ type: 'text', text: 'S1-0 fake child smoke. Reply with one short line.' }] });
      pending.then(run => { if (signal.aborted) void run.dispose().catch(() => {}); }, () => {});
      child = await abortable(pending, signal);
      assert.ok(child.localAgent, 'spawn did not return an in-process child');
      assert.equal(agents.get(child.id), child.localAgent);
      assert.equal(child.localAgent.session.header.parentSession, parent.id);
      assert.deepEqual(service(child.localAgent.ctx, 'tools').schemas(scopeOf(child.localAgent.ctx)).map(tool => tool.name), [],
        'test child would expose tools to the fake model');
      const result = await abortable(child.result, signal);
      assert.equal(result.stopReason, 'completed');
      assert.ok(result.output.some(block => block.type === 'text' && block.text.length > 0));
      const events = eventsOf(child.localAgent.session);
      const descriptor = events.find(event => event.type === 'subagent/descriptor')?.data;
      assert.equal(descriptor?.mode, 'one-shot');
      assert.equal(descriptor?.label, label);
      const assistantEvents = events.filter(event => event.type === 'assistant/message' || event.type === 'assistant/attempt');
      const childId = child.id;
      await abortable(child.dispose(), signal);
      await abortable(child.dispose(), signal);
      assert.equal(agents.get(childId), undefined);
      assert.equal(service(ctx, 'sessions').get(childId), undefined);
      assert.equal(lifecycle.filter(event => event.type === 'start' && event.id === childId).length, 1);
      assert.equal(lifecycle.filter(event => event.type === 'end' && event.id === childId).length, 1);
      child = undefined;
      return { providerCapabilities: provider.capabilities, stopReason: result.stopReason, persistedLabel: descriptor.label,
        parentLineage: true, assistantEventCount: assistantEvents.length, pairedLifecycleEvents: true, disposed: true };
    });
    await step(officialVariant ? 'DSH-01/03/09 owned-job-official-test-composition' : 'DSH-01/03/09 owned-job-native-controller', async () => {
      // Bare variant uses no extra controller. The official variant explicitly
      // mounts only the installed official controller through agentPresets.
      // Neither variant calls attachController() by hand.
      const scopedJobs = service(parent.ctx, 'jobs');
      const settledEvents = [];
      subscriptions.push(scopedJobs.events.subscribe({ owners: 'scope' }, event => {
        if (event.type === 'settled') settledEvents.push({ id: event.job.id, cause: event.cause, awaited: event.awaited });
      }));
      let resolveDone, cancels = 0;
      const done = new Promise(resolvePromise => { resolveDone = resolvePromise; });
      const id = scopedJobs.start({ kind: 's10-probe', label: 'S1-0 owned controlled producer', owner: parent.id,
        run: face => { face.append('S1-0 output\n'); face.updateProgress('S1-0 running'); return {
          done, cancel: () => { cancels++; resolveDone({ status: 'killed', detail: 'S1-0 fake resources released' }); },
        }; } });
      producers.push(() => resolveDone({ status: 'killed', detail: 'S1-0 cleanup' }));
      assert.equal(jobs.get(id, parent.id).owner, parent.id);
      assert.throws(() => jobs.get(id), /another session/);
      assert.throws(() => jobs.get(id, sibling.id), /another session/);
      assert.equal(jobs.list(sibling.id).some(job => job.id === id), false);
      assert.equal(jobs.readAt(id, 0, parent.id).chunks.map(chunk => chunk.text).join(''), 'S1-0 output\n');
      const observed = await jobs.wait(id, 5, parent.id, signal);
      assert.equal(observed.status, 'running');
      assert.equal(cancels, 0, 'observer timeout cancelled the producer');
      const terminal = jobs.wait(id, 10_000, parent.id, signal);
      assert.equal(jobs.kill(id, parent.id, 'S1-0 requested cancellation'), 'requested');
      assert.equal(jobs.get(id, parent.id).status, 'stopping');
      const ended = await terminal;
      assert.equal(ended.status, 'killed');
      assert.equal(cancels, 1);
      assert.equal(jobs.kill(id, parent.id), 'already-finished');
      assert.equal(settledEvents.filter(event => event.id === id).length, 1);
      assert.equal(settledEvents.find(event => event.id === id).awaited, true);
      jobs.remove(id, parent.id);
      return { controllerServesOwner: true, controllerLoadedByTestVariant: officialVariant,
        controllerProvisioning: report.controllerProvisioning, exactOwnerAccess: true, foreignAndCallerlessDenied: true,
        observerTimeoutPreservedProducer: true, transitions: ['running', 'stopping', ended.status], cancelCalls: cancels, settledEvents: 1, awaited: true };
    });
    if (config.auditStudyHub) await step('DSH-01/03 studyhub-unload-host-job-boundary', async () => {
      const root = ctx.root || ctx;
      const host = root[Symbol.for('studyhub.workbench.host.v1')];
      let release, cancels = 0;
      const done = new Promise(resolve => { release = resolve; });
      producers.push(() => release({ status: 'killed' }));
      const id = service(host.fiber.ctx, 'jobs').start({ kind: 's12-unload', owner: parent.id,
        label: 'S1-2 producer fiber disposal boundary', run: () => ({ done, cancel: () => { cancels++; } }) });
      await abortable(host.fiber.dispose(), signal);
      // Host records belong to the live Agent, not the producing plugin fiber.
      // This is a measured gap, not an accepted S1-2 unload implementation.
      assert.equal(agents.get(parent.id), parent);
      assert.equal(jobs.get(id, parent.id).status, 'running');
      assert.equal(cancels, 0);
      jobs.kill(id, parent.id);
      assert.equal(cancels, 1);
      assert.equal(jobs.get(id, parent.id).status, 'stopping');
      release({ status: 'killed', detail: 'S1-2 explicit cleanup after fiber unload' });
      assert.equal((await jobs.wait(id, 10_000, parent.id, signal)).status, 'killed');
      jobs.remove(id, parent.id);
      return { productionFiberDisposed: true, ownerStillLive: true,
        hostJobSurvivedProducerFiber: true, implicitCancelCalls: 0,
        explicitCancelCalls: cancels, explicitCleanupCompleted: true };
    });
    await step('DSH-01/03 owner-disposal-drains-job', async () => {
      let resolves, cancels = 0;
      const done = new Promise(resolvePromise => { resolves = resolvePromise; });
      const id = service(parent.ctx, 'jobs').start({ kind: 's10-probe', label: 'S1-0 owner disposal controlled producer', owner: parent.id,
        run: () => ({ done, cancel: () => { cancels++; resolves({ status: 'killed', detail: 'S1-0 released before settlement' }); } }) });
      producers.push(() => resolves({ status: 'killed', detail: 'S1-0 cleanup' }));
      await abortable(handles[0].dispose(), signal);
      await abortable(handles[0].dispose(), signal);
      assert.equal(cancels, 1);
      assert.equal(parentScopeDisposals, 1);
      assert.equal(agents.get(parent.id), undefined);
      assert.equal(service(ctx, 'sessions').get(parent.id), undefined);
      assert.throws(() => jobs.get(id, parent.id), /unknown job/);
      return { ownerUnregistered: true, sessionRemoved: true, ownedRecordRemoved: true, cancelCalls: cancels, scopeDisposals: parentScopeDisposals };
    });
  } finally {
    clearTimeout(timeout);
    if (!signal.aborted) controller.abort(new Error('S1-0 evidence work finished'));
    if (parent && agents.get(parent.id) === parent) { try { parent.cancel({ kind: 'user' }); } catch {} }
    for (const stop of producers) stop();
    for (const stop of subscriptions.reverse()) { try { await stop(); } catch {} }
    // Cleanup is separately bounded; a timeout is failure, never quiescence proof.
    let cleanupTimer;
    const cleanupLimit = new Promise((_, reject) => { cleanupTimer = setTimeout(() => reject(new Error('S1-0 cleanup did not converge within 10 seconds')), 10_000); });
    try {
      await Promise.race([Promise.all([child?.dispose(), ...handles.slice().reverse().map(handle => handle.dispose())]), cleanupLimit]);
      report.cleanup = { converged: true, parentScopeDisposals };
    } catch (error) {
      report.cleanup = { converged: false, error: safeFailure(error) };
      throw error;
    } finally { clearTimeout(cleanupTimer); }
  }
}
