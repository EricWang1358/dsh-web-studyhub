import test from 'node:test';
import assert from 'node:assert/strict';
import { createAssistService } from '../lib/assist.js';
import { createAssistChildren } from '../lib/assist-child.js';
import { StudyService } from '../lib/service.js';
import { loadUi } from './helpers/ui-module.mjs';
import { readActions, readCard } from './helpers/console-card.mjs';
import { until } from './helpers/wait.mjs';
import { gate, privateRoot } from './helpers/model-family-baseline.mjs';
import { managedRuntimeOptions } from './helpers/runtime-switch.mjs';
import { card, ended, evidence, nativeHost, reply as askReply } from './helpers/assist-library.mjs';

const taskUi = await loadUi(`
  export { taskKindOf } from './ui/tasks/task-model.js';
  export { taskSummary } from './ui/tasks/task-summary.js';
  export { callLabel } from './ui/tasks/call-model.js';
  export { resultOpener } from './ui/tasks/task-actions.js';
  export { setUiLanguage } from './ui/i18n.js';
`);

const TERMS_REPLY = JSON.stringify({
  ladder: [
    {
      term: '抽象层',
      layer: 1,
      needs: [],
      problem: '高层接口与底层实现紧耦合时难以独立演化。',
      plain: '抽象层就是把「对外怎么用」和「内部怎么做」隔开的界面。',
      formal: '抽象层（Abstraction）是对外暴露高层语义并把具体实现委托给实现层次的结构。',
      example: '遥控器定义开关与换台接口，不同电视品牌各自实现内部电路。',
      card: {
        kind: 'flashcard',
        topic: '抽象层 检查',
        objective: '掌握抽象层的正式定义',
        prompt: '在桥接模式中，抽象层（Abstraction）的核心职责是什么？',
        answer: '对外暴露高层操作接口，并将底层具体实现委托给实现层次。',
        hint: '想想桥接模式分离的哪一侧。',
        misconception: '以为抽象层直接编写所有平台相关代码。',
        citations: [{ sourceId: 's', quote: evidence }],
      },
    },
  ],
  deeper: [],
  skipped: [],
});

async function seedLibrary(t, { complete, host = null, pilot = { assist: false }, withExecutor = true } = {}) {
  const root = await privateRoot(t, 'terms-subagent-job-');
  const runtimeOpts = withExecutor
    ? (() => {
        const managed = managedRuntimeOptions({ complete, paths: [], host: host || undefined });
        return {
          workOwner: managed.workOwner,
          jobExecutor: managed.jobExecutor,
          jobModelHost: managed.jobModelHost,
          runtimePilot: pilot,
        };
      })()
    : { runtimePilot: pilot };
  const service = new StudyService(root, { complete, ...runtimeOpts });
  const assist = createAssistService({ children: createAssistChildren() });
  t.after(async () => {
    assist.dispose();
    await service.dispose();
  });
  await service.store.update(state => {
    state.sources.push({ id: 's', title: 'Lecture', text: evidence });
    state.decks.push({ id: 'd', title: 'Patterns', course: 'Software', cards: [structuredClone(card)] });
  });
  return { root, service, assist };
}

const jobsOf = service => [...service.runtime.work.jobs.values()].filter(job => job.type === 'assist');
const settledJob = (service, index = 0) => until(
  () => jobsOf(service)[index]?.contract.finishedAt && jobsOf(service)[index],
  'the assist terms Job to settle',
);

const termsRequest = (service, root, extra = {}) => ({
  root,
  service,
  sessionId: 'parent',
  mode: 'terms',
  ref: { deckId: 'd', cardId: 'c' },
  text: '',
  helpChoices: [],
  terms: ['抽象层'],
  card,
  deckTitle: 'Patterns',
  route: { provider: 'fixture', model: 'fixture' },
  ...extra,
});

test('mode=terms enters snapshot.jobs by default (even with runtimePilot.assist=false) and runs via bounded subagent; ask stays off-runtime', async t => {
  let directCalls = 0;
  const native = nativeHost(TERMS_REPLY);
  const f = await seedLibrary(t, {
    complete: async () => { directCalls++; return askReply; },
    host: native,
    pilot: { assist: false },
  });

  // 1. Non-terms mode (`ask`) must remain untouched when runtimePilot.assist is false.
  await f.assist.startAssist({}, {
    root: f.root, service: f.service, sessionId: 'parent', mode: 'ask',
    ref: { deckId: 'd', cardId: 'c' }, text: 'Explain it', helpChoices: [],
    card, deckTitle: 'Patterns', route: { provider: 'fixture', model: 'fixture' },
  });
  await ended(f.assist, f.root);
  assert.equal(jobsOf(f.service).length, 0, 'non-terms assist does not enter work.jobs when runtimePilot.assist is false');
  assert.equal(directCalls, 1);

  // 2. `mode: 'terms'` enters work.jobs / snapshot.jobs by default and uses a bounded DSH subagent.
  const started = await f.assist.startAssist(native.ctx, termsRequest(f.service, f.root));
  assert.equal(started.runtime, 'subagent');
  await ended(f.assist, f.root);

  const job = await settledJob(f.service, 0);
  const { contract } = job;
  assert.equal(directCalls, 1, 'terms subagent call bypassed direct service.complete');
  assert.equal(native.calls.started.length, 1);
  assert.deepEqual(native.calls.started[0].toolFilter, { allow: [] });
  assert.equal(native.calls.disposed.length, 1);

  assert.equal(contract.kind, 'assist');
  assert.equal(contract.status, 'complete');
  assert.equal(contract.execution.mode, 'subagent');
  assert.deepEqual(contract.detail.terms, ['抽象层']);
  assert.equal(contract.detail.mode, 'terms');
  assert.equal(contract.detail.deckId, 'd');
  assert.equal(contract.calls.length, 1);
  assert.deepEqual(
    [contract.calls[0].stepKey, contract.calls[0].stage, contract.calls[0].runner, contract.calls[0].childId, contract.calls[0].parentId],
    ['assist:1', 'terms', 'subagent', 'child-1', 'parent'],
  );

  // Snapshot exposes the job to TaskConsole (`snapshot.jobs`).
  const snapshot = await f.service.call('snapshot');
  assert.ok(snapshot.jobs.some(item => item.contract?.jobId === contract.jobId), 'terms job is visible in snapshot.jobs');

  // Assist task record preserves outcome and childId.
  const termsTask = f.assist.assistView(f.root).tasks.at(-1);
  assert.equal(termsTask.status, 'done');
  assert.equal(termsTask.runtime, 'subagent');
  assert.equal(termsTask.childId, 'child-1');
  assert.equal(termsTask.outcome, 'linked');
});

test('mode=terms falls back to direct inside the runtime Job when no native subagent exists, streams live output, and supports one repair step', async t => {
  let attempt = 0;
  const f = await seedLibrary(t, {
    complete: async (_sys, _prompt, options) => {
      attempt++;
      if (attempt === 1) {
        options?.onOutput?.('{"ladder":');
        return '{"ladder":';
      }
      options?.onOutput?.(TERMS_REPLY);
      return TERMS_REPLY;
    },
    pilot: { assist: false },
  });

  const started = await f.assist.startAssist({}, termsRequest(f.service, f.root));
  assert.equal(started.runtime, 'direct');
  await ended(f.assist, f.root);

  const job = await settledJob(f.service, 0);
  const { contract } = job;
  assert.equal(contract.status, 'complete');
  assert.equal(contract.execution.mode, 'direct');
  assert.deepEqual(
    contract.calls.map(c => [c.stepKey, c.stage, c.kind, c.runner, c.fallbackReason]),
    [
      ['assist:1', 'terms', 'other', 'direct', 'agent-unavailable'],
      ['repair:1', 'terms-repair', 'repair', 'direct', 'agent-unavailable'],
    ],
  );
  // Output was captured under the Job's legacy id and readable via job.output.
  const out = await f.service.call('job.output', { jobId: contract.jobId, callId: contract.calls[1].callId });
  assert.ok(out.text.includes('抽象层'), 'repair step output is stored in work.jobOutputs');

  const termsTask = f.assist.assistView(f.root).tasks.at(-1);
  assert.equal(termsTask.status, 'done');
  assert.equal(termsTask.repaired, true);
  assert.equal(termsTask.outcome, 'linked');
});

test('cancelling a running mode=terms Job via job.control stops the subagent cleanly', async t => {
  const held = gate();
  const native = nativeHost(TERMS_REPLY, held.promise);
  const f = await seedLibrary(t, {
    complete: async () => TERMS_REPLY,
    host: native,
    pilot: { assist: false },
  });

  await f.assist.startAssist(native.ctx, termsRequest(f.service, f.root));
  await until(() => native.calls.started.length === 1, 'subagent to start');

  const job = jobsOf(f.service)[0];
  assert.ok(job, 'terms job should be registered while running');
  await f.service.call('job.control', { jobId: job.contract.jobId, action: 'cancel' });

  held.release();
  await ended(f.assist, f.root);
  const settled = await settledJob(f.service, 0);
  assert.equal(settled.contract.status, 'cancelled');
  assert.equal(native.calls.started[0].signal.aborted, true);
  assert.equal(f.assist.assistView(f.root).tasks.at(-1).status, 'failed');
});

test('in-process fallback (no jobExecutor, e.g. preview server) still uses one-shot subagent when native capability exists', async t => {
  let directCalls = 0;
  const native = nativeHost(TERMS_REPLY);
  const f = await seedLibrary(t, {
    complete: async () => { directCalls++; return TERMS_REPLY; },
    withExecutor: false,
    pilot: { assist: false },
  });

  const started = await f.assist.startAssist(native.ctx, termsRequest(f.service, f.root));
  assert.equal(started.runtime, 'subagent');
  await ended(f.assist, f.root);

  assert.equal(directCalls, 0, 'in-process terms used native one-shot subagent');
  assert.equal(native.calls.started.length, 1);
  assert.equal(native.calls.disposed.length, 1);
  assert.equal(f.assist.assistView(f.root).tasks.at(-1).status, 'done');
  assert.equal(f.assist.assistView(f.root).tasks.at(-1).outcome, 'linked');
});

test('TaskConsole helpers render assist terms kind, stages, calls, and deck opener in zh and en', async t => {
  const native = nativeHost(TERMS_REPLY);
  const f = await seedLibrary(t, { complete: async () => TERMS_REPLY, host: native, pilot: { assist: false } });
  await f.assist.startAssist(native.ctx, termsRequest(f.service, f.root));
  await ended(f.assist, f.root);
  const job = await settledJob(f.service, 0);

  taskUi.setUiLanguage('zh');
  t.after(() => taskUi.setUiLanguage('zh'));

  // Full TaskConsole card contract check (reusing tests/helpers/console-card.mjs).
  const checkedContract = readCard(job, { side: 'runtime', name: 'terms' }, { uiKind: 'assist' });
  readActions(checkedContract, { side: 'runtime', name: 'terms' }, { running: false });

  assert.equal(taskUi.taskKindOf(job), 'assist');
  const zhSummary = taskUi.taskSummary(job);
  assert.equal(zhSummary.kind, 'assist');
  assert.equal(zhSummary.kindLabel, '补齐生词');
  assert.equal(taskUi.callLabel(job.contract.calls[0]), '补齐生词');
  assert.equal(taskUi.callLabel({ kind: 'repair', stage: 'terms-repair' }), '修复补词格式');

  const opened = [];
  const opener = taskUi.resultOpener(job, {
    data: { decks: [{ id: 'd', title: 'Patterns' }] },
    intents: { openDeck: deckId => opened.push(deckId) },
  });
  assert.equal(opener?.label, '打开题组');
  opener.run();
  assert.deepEqual(opened, ['d']);

  taskUi.setUiLanguage('en');
  assert.equal(taskUi.taskSummary(job).kindLabel, 'Fill in terms');
  assert.equal(taskUi.callLabel(job.contract.calls[0]), 'Fill in terms');
  assert.equal(taskUi.callLabel({ kind: 'repair', stage: 'terms-repair' }), 'Repair term-ladder format');
});

const makeTermReply = (term, prompt) => JSON.stringify({
  ladder: [
    {
      term,
      layer: 1,
      needs: [],
      problem: `${term}解决编译或运行期的重复计算与调用开销问题。`,
      plain: `${term}就是编译器提前把能算或能展开的地方直接替换掉。`,
      formal: `${term}是编译器在编译期执行的经典静态优化技术之一。`,
      example: `例如对 final 常量表达式应用${term}，可直接生成目标值。`,
      card: {
        kind: 'flashcard',
        topic: `${term} 检查`,
        objective: `掌握${term}的核心定义`,
        prompt,
        answer: `${term}在编译期完成对应静态替换优化。`,
        hint: `回忆${term}发生的阶段。`,
        misconception: `以为${term}只在运行期动态解释时才生效。`,
        citations: [{ sourceId: 's', quote: evidence }],
      },
    },
  ],
  deeper: [],
  skipped: [],
});

test('concurrent mode=terms jobs on the same card run in parallel without blocking and persist both terms without clobbering', async t => {
  const hold1 = gate();
  const hold2 = gate();
  const requestedTerms = [];
  const f = await seedLibrary(t, {
    complete: async (_sys, prompt) => {
      const parsed = JSON.parse(prompt);
      const reqTerms = parsed.request?.terms || [];
      requestedTerms.push(reqTerms);
      if (reqTerms.includes('常量折叠')) {
        await hold1.promise;
        return makeTermReply('常量折叠', '编译期常量折叠的核心作用是什么？');
      }
      if (reqTerms.includes('内联')) {
        await hold2.promise;
        return makeTermReply('内联', '编译期方法或常量内联的核心作用是什么？');
      }
      throw new Error(`Unexpected requested terms: ${JSON.stringify(reqTerms)}`);
    },
    pilot: { assist: false },
  });

  // 1. Start Job 1 for 常量折叠 and wait until its model call is in-flight.
  const task1 = await f.assist.startAssist({}, termsRequest(f.service, f.root, { terms: ['常量折叠'] }));
  await until(() => requestedTerms.length === 1, 'first term job to enter model call');
  assert.deepEqual(task1.terms, ['常量折叠']);
  assert.equal(f.assist.assistView(f.root).tasks.filter(item => item.status === 'running').length, 1);

  // 2. While Job 1 is still running, start Job 2 for 内联 -> must NOT be blocked or collapsed onto Job 1.
  const task2 = await f.assist.startAssist({}, termsRequest(f.service, f.root, { terms: ['内联'] }));
  await until(() => requestedTerms.length === 2, 'second term job to enter model call in parallel');
  assert.notEqual(task2.id, task1.id);
  assert.deepEqual(task2.terms, ['内联']);

  const runningJobs = jobsOf(f.service);
  assert.equal(runningJobs.length, 2, 'both term-fill jobs are live in work.jobs concurrently');
  assert.notEqual(runningJobs[0].contract.jobId, runningJobs[1].contract.jobId);
  assert.deepEqual(runningJobs.map(j => j.contract.detail.terms), [['常量折叠'], ['内联']]);

  // 3. Release both concurrently and verify both settle complete and persist safely into the store.
  hold1.release();
  hold2.release();
  await until(
    () => f.assist.assistView(f.root).tasks.every(item => item.status !== 'running'),
    'both concurrent term-fill tasks to finish',
  );
  const job1 = await settledJob(f.service, 0);
  const job2 = await settledJob(f.service, 1);
  assert.equal(job1.contract.status, 'complete');
  assert.equal(job2.contract.status, 'complete');

  const finalTasks = f.assist.assistView(f.root).tasks;
  assert.equal(finalTasks.length, 2);
  assert.ok(finalTasks.every(item => item.status === 'done' && item.outcome === 'linked'));

  const state = await f.service.store.read();
  const deck = state.decks.find(d => d.id === 'd');
  const orig = deck.cards.find(c => c.id === 'c');
  const foldCard = deck.cards.find(c => c.topic === '常量折叠 检查');
  const inlineCard = deck.cards.find(c => c.topic === '内联 检查');
  assert.ok(foldCard, '常量折叠 check card persisted');
  assert.ok(inlineCard, '内联 check card persisted');
  assert.ok(orig.requires?.some(r => r.cardId === foldCard.id), '常量折叠 linked as prerequisite');
  assert.ok(orig.requires?.some(r => r.cardId === inlineCard.id), '内联 linked as prerequisite');
  assert.equal(orig.followups?.filter(item => item.kind === 'terms').length, 2, 'both term-fill followups preserved');

  const course = state.courses.find(item => item.name === 'Software');
  const foldTerm = course?.terms?.items?.find(item => item.term === '常量折叠');
  const inlineTerm = course?.terms?.items?.find(item => item.term === '内联');
  assert.equal(foldTerm?.card?.cardId, foldCard.id, '常量折叠 attached in course terms');
  assert.equal(inlineTerm?.card?.cardId, inlineCard.id, '内联 attached in course terms');
});

test('overlapping mode=terms submissions dedupe in-flight terms cleanly while starting new terms in parallel', async t => {
  const hold1 = gate();
  const hold2 = gate();
  const requestedTerms = [];
  const f = await seedLibrary(t, {
    complete: async (_sys, prompt) => {
      const parsed = JSON.parse(prompt);
      const reqTerms = parsed.request?.terms || [];
      requestedTerms.push(reqTerms);
      if (reqTerms.includes('常量折叠')) {
        await hold1.promise;
        return makeTermReply('常量折叠', '什么是常量折叠优化？');
      }
      if (reqTerms.includes('内联')) {
        await hold2.promise;
        return makeTermReply('内联', '什么是内联优化？');
      }
      throw new Error(`Unexpected requested terms: ${JSON.stringify(reqTerms)}`);
    },
    pilot: { assist: false },
  });

  // Start Job 1 for 常量折叠.
  const task1 = await f.assist.startAssist({}, termsRequest(f.service, f.root, { terms: ['常量折叠'] }));
  await until(() => requestedTerms.length === 1, 'Job 1 running');

  // Exact overlap returns existing running task without spawning a duplicate job.
  const dup = await f.assist.startAssist({}, termsRequest(f.service, f.root, { terms: ['常量折叠'] }));
  assert.equal(dup.id, task1.id);
  assert.equal(jobsOf(f.service).length, 1);

  // Partial overlap strips already-in-flight 常量折叠 and starts a fresh Job 2 for only 内联.
  const task2 = await f.assist.startAssist({}, termsRequest(f.service, f.root, { terms: ['常量折叠', '内联'] }));
  await until(() => requestedTerms.length === 2, 'Job 2 running for 内联 only');
  assert.notEqual(task2.id, task1.id);
  assert.deepEqual(task2.terms, ['内联']);
  assert.deepEqual(requestedTerms, [['常量折叠'], ['内联']]);

  hold1.release();
  hold2.release();
  await until(
    () => f.assist.assistView(f.root).tasks.every(item => item.status !== 'running'),
    'both deduplicated term jobs to settle',
  );
  await settledJob(f.service, 0);
  await settledJob(f.service, 1);
  assert.equal(f.assist.assistView(f.root).tasks.length, 2);
  assert.ok(f.assist.assistView(f.root).tasks.every(item => item.status === 'done'));
});

test('simultaneous Promise.all overlapping mode=terms calls dedupe synchronously before store read completes', async t => {
  const hold1 = gate();
  const hold2 = gate();
  const requestedTerms = [];
  const f = await seedLibrary(t, {
    complete: async (_sys, prompt) => {
      const parsed = JSON.parse(prompt);
      const reqTerms = parsed.request?.terms || [];
      requestedTerms.push(reqTerms);
      if (reqTerms.includes('常量折叠')) {
        await hold1.promise;
        return makeTermReply('常量折叠', '常量折叠在何时执行？');
      }
      if (reqTerms.includes('内联')) {
        await hold2.promise;
        return makeTermReply('内联', '内联在何时执行？');
      }
      throw new Error(`Unexpected requested terms: ${JSON.stringify(reqTerms)}`);
    },
    pilot: { assist: false },
  });

  const [t1, tDup, t2] = await Promise.all([
    f.assist.startAssist({}, termsRequest(f.service, f.root, { terms: ['常量折叠'] })),
    f.assist.startAssist({}, termsRequest(f.service, f.root, { terms: ['常量折叠'] })),
    f.assist.startAssist({}, termsRequest(f.service, f.root, { terms: ['常量折叠', '内联'] })),
  ]);
  assert.equal(tDup.id, t1.id, 'concurrent duplicate joins first task');
  assert.notEqual(t2.id, t1.id, 'partial overlap spawns independent task for new term');
  assert.deepEqual(t1.terms, ['常量折叠']);
  assert.deepEqual(t2.terms, ['内联']);

  await until(() => requestedTerms.length === 2, 'both unique requests started');
  hold1.release();
  hold2.release();
  await until(
    () => f.assist.assistView(f.root).tasks.every(item => item.status !== 'running'),
    'all simultaneous term tasks to settle',
  );
  await settledJob(f.service, 0);
  await settledJob(f.service, 1);
  assert.equal(requestedTerms.length, 2);
});
