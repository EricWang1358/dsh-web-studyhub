import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';
import { createFakeModel } from '../scripts/fake-model.mjs';
import { caseAuthorPrompt, caseGenerationArgs, caseReviewPrompt, caseStyleLimit } from '../lib/case-study.js';
import { estimateFromState } from '../lib/token-estimate.js';
import { patchPrompts } from '../lib/generation-yield.js';
import { LOCKED_PROTOCOL_MODULE_ID, computeRequirementsDigest, normalizeModuleOverrides } from '../lib/generation-modules.js';
import { draftRequirementsMatchReview } from '../lib/review-integrity.js';
import { deriveItemStatus } from '../lib/study-progress.js';
import { loadUi } from './helpers/ui-module.mjs';

const { retryForm } = await loadUi("export { retryForm } from './ui/app/retry-generation.js';");

const LESSON_TEXT = [
  '## 第 1 节 隔离级别',
  '可串行化隔离级别通过严格并发控制阻止脏读、不可重复读与幻读，使并发事务结果等价于某种串行执行顺序。',
  '快照隔离在事务启动时读取一致快照，并在提交阶段执行首写者胜冲突检测，但若两个事务读取交集并分别写入不相交集合，仍可能出现写偏序异常。',
  '## 第 2 节 索引与锁',
  '间隙锁锁定索引记录之间的开区间，防止其他事务在该范围内插入新记录，从而在可重复读隔离级别下阻断当前读路径上的幻读。',
  '覆盖索引直接从二级索引叶子节点返回查询所需的全部列，避免回表随机读取聚簇索引数据页。',
].join('\n\n');

const SAMPLE_TEXT = 'UNTRUSTED_SAMPLE_851: 某金融系统采用快照隔离处理双账户联合风控校验，请问为何仍会发生写偏序？ A. 脏读 B. 互读旧快照后分写不同行 C. 死锁回滚 D. 日志丢失';

test('#851 A: case styleText enforces unified referenceLimits.chars without silent 12000-char slicing', async (t) => {
  assert.equal(caseStyleLimit(), 12000);
  assert.equal(caseStyleLimit({ sources: 5, chars: 20000 }), 20000);

  const overDefault = `${'样题前缀说明。'.repeat(2000)}TAIL_MARKER_15000`;
  assert.ok(overDefault.length > 12000 && overDefault.length < 20000);

  const root = await mkdtemp(join(tmpdir(), 'study-851-case-style-'));
  const service = new StudyService(root, { coach: false, complete: createFakeModel({ latencyMs: 1 }) });
  t.after(async () => { await service.dispose(); await rm(root, { recursive: true, force: true }); });
  const lesson = await service.call('source.add', { title: '并发控制', text: LESSON_TEXT });

  // Default 12,000 limit rejects 14,000+ chars rather than accepting <= 60,000 and silently truncating
  assert.throws(
    () => caseGenerationArgs({ sourceIds: [lesson.id], styleText: overDefault, questions: 2, totalMarks: 20 }),
    /12000/,
  );
  await assert.rejects(
    service.call('generate', { kind: 'case', sourceIds: [lesson.id], styleText: overDefault, questions: 2, totalMarks: 20 }),
    /12000/,
  );

  // Raising referenceLimits.chars to 20,000 preserves the tail marker in author/review prompts and token estimation
  const longStyle = `${'案例样题示范段落。'.repeat(2050)}TAIL_MARKER_18500`;
  assert.ok(longStyle.length > 18000 && longStyle.length < 20000);
  const args = caseGenerationArgs({
    sourceIds: [lesson.id],
    styleText: longStyle,
    referenceLimits: { sources: 5, chars: 20000 },
    questions: 2,
    totalMarks: 20,
  });
  const author = caseAuthorPrompt({ ...args, sources: [lesson] });
  const review = caseReviewPrompt({ questions: [] }, { ...args, sources: [lesson] });
  assert.ok(author.prompt.includes('TAIL_MARKER_18500'), 'author prompt preserves full tail marker beyond 12,000 chars');
  assert.ok(review.prompt.includes('TAIL_MARKER_18500'), 'review prompt preserves full tail marker beyond 12,000 chars');

  const estArgs = { ...args, sourceIds: [lesson.id], referenceLimits: { sources: 5, chars: 20000 } };
  const baseEst = estimateFromState('case', { ...estArgs, styleText: longStyle.slice(0, 1000) }, { sources: [lesson] });
  const fullEst = estimateFromState('case', estArgs, { sources: [lesson] });
  assert.ok(fullEst.inputTokens.low > baseEst.inputTokens.low, 'token estimate prices the full pasted styleText');
});

test('#851 B: retryForm restores reference context, non-uniform quotas, and modules, and clears stale references', () => {
  const sources = [{ id: 's1', title: '讲义' }, { id: 'ref1', title: '样题' }];
  const currentGen = {
    kind: 'quiz',
    kinds: ['quiz'],
    referenceSourceIds: ['ref1'],
    referenceLimits: { sources: 8, chars: 24000 },
    referenceFormat: 'strict',
  };

  // Retrying a job that had NO references clears stale referenceSourceIds when merged onto currentGen
  const noRefJob = {
    sourceIds: ['s1'],
    kinds: ['quiz', 'open'],
    asked: {
      count: 4,
      kindCounts: { quiz: 3, open: 1 },
      moduleOverrides: { reasoning: { enabled: true, instruction: '考查边界反例' } },
      referenceSourceIds: [],
      referenceLimits: { sources: 5, chars: 12000 },
      referenceFormat: 'balanced',
      coverageLevel: 'standard',
      autoComplete: false,
      tokenBudget: '500000',
      role: '后端架构师',
    },
  };
  const restoredNoRef = retryForm(noRefJob, { sources });
  const mergedNoRef = { ...currentGen, ...restoredNoRef.patch };
  assert.deepEqual(mergedNoRef.referenceSourceIds, []);
  assert.equal(mergedNoRef.referenceFormat, 'balanced');
  assert.deepEqual(mergedNoRef.kindCounts, { quiz: 3, open: 1 });
  assert.equal(mergedNoRef.customCount, '4');
  assert.equal(mergedNoRef.role, '后端架构师');
  assert.equal(mergedNoRef.tokenBudget, '500000');
  assert.equal(mergedNoRef.autoComplete, false);
  assert.equal(mergedNoRef.moduleOverrides?.reasoning?.instruction, '考查边界反例');

  // Retrying a job whose reference material was deleted reports goneReferences and filters missing IDs
  const deletedRefJob = {
    sourceIds: ['s1'],
    kinds: ['quiz'],
    asked: {
      referenceSourceIds: ['ref1', 'gone-ref'],
      referenceFormat: 'strict',
      referenceLimits: { sources: 6, chars: 18000 },
    },
  };
  const restoredWithGone = retryForm(deletedRefJob, { sources });
  assert.deepEqual(restoredWithGone.patch.referenceSourceIds, ['ref1']);
  assert.equal(restoredWithGone.goneReferences, 1);
  assert.equal(restoredWithGone.patch.referenceFormat, 'strict');
});

test('#851 C: patchPrompts, draft.repair, and draft.publish propagate stored reference context & moduleOverrides and bind reviewedCards to requirements digest', async (t) => {
  const lessonObj = { id: 's1', title: '并发讲义', text: LESSON_TEXT };
  const sampleObj = { id: 'ref1', title: '真题样例', text: SAMPLE_TEXT };

  // 1. patchPrompts forwards reference context and moduleOverrides
  const patched = patchPrompts({
    entries: [],
    kind: 'quiz',
    sources: [lessonObj],
    questionReferences: [sampleObj],
    referenceFormat: 'strict',
    moduleOverrides: { distractors: { enabled: true, instruction: 'CUSTOM_DISTRACTOR_RULE_851' } },
  });
  assert.ok(patched.prompt.includes('UNTRUSTED_SAMPLE_851'));
  assert.ok(patched.prompt.includes('Closely preserve'));
  assert.ok(patched.prompt.includes('CUSTOM_DISTRACTOR_RULE_851'));

  // 2. End-to-end StudyService generation -> edit card -> repair & publish check reference propagation and missing-reference gate
  const root = await mkdtemp(join(tmpdir(), 'study-851-repair-publish-'));
  const fake = createFakeModel({ latencyMs: 1 });
  const recordedPrompts = [];
  const service = new StudyService(root, {
    coach: false,
    complete: async (system, prompt, ctx) => {
      recordedPrompts.push({ system, prompt, stage: ctx?.stage });
      return fake(system, prompt, ctx);
    },
  });
  t.after(async () => { await service.dispose(); await rm(root, { recursive: true, force: true }); });

  const lesson = await service.call('source.add', { title: lessonObj.title, text: lessonObj.text });
  const sample = await service.call('source.add', { title: sampleObj.title, text: sampleObj.text });
  const started = await service.call('generate', {
    sourceIds: [lesson.id],
    referenceSourceIds: [sample.id],
    referenceFormat: 'strict',
    moduleOverrides: { reasoning: { enabled: true, instruction: 'MUST_TEST_WRITE_SKEW_BOUNDARY' } },
    count: 1,
    kind: 'flashcard',
  });
  const job = await service.call('job.wait', { jobId: started.jobId, timeoutSeconds: 30 });
  assert.equal(job.status, 'complete');

  let draft = (await service.call('export')).drafts.find((d) => d.id === job.draftId);
  assert.ok(draft.editorial?.reviewedRequirementsDigest, 'initial generation records reviewedRequirementsDigest');
  const currentDigest = computeRequirementsDigest({
    ...draft.editorial.generation,
    questionReferences: [sample],
  }).digest;
  assert.equal(draftRequirementsMatchReview(draft, { currentRequirementsDigest: currentDigest }).valid, true);

  // Modifying moduleOverrides invalidates stale review credentials
  const mutatedGen = {
    ...draft.editorial.generation,
    moduleOverrides: { reasoning: { enabled: true, instruction: 'DIFFERENT_RULE_AFTER_REVIEW' } },
  };
  const mutatedDigest = computeRequirementsDigest({ ...mutatedGen, questionReferences: [sample] }).digest;
  assert.equal(
    draftRequirementsMatchReview(draft, { currentRequirementsDigest: mutatedDigest }).valid,
    false,
    'digest mismatch invalidates reviewedCards reuse',
  );

  // Mark a card with rejectedIssues, then run draft.repair and verify reference + module context reaches repair/review
  const editedCard = { ...draft.cards[0], prompt: `${draft.cards[0].prompt}（补充边界提问）` };
  const saved = await service.call('draft.save', {
    deck: {
      ...draft,
      cards: [editedCard],
      editorial: { ...draft.editorial, rejectedIssues: { [editedCard.id]: ['题干缺少场景限定'] } },
    },
  });
  recordedPrompts.length = 0;
  const repairStart = await service.call('draft.repair', { id: draft.id, draftVersion: saved.draftVersion });
  const repairJob = await service.call('job.wait', { jobId: repairStart.jobId, timeoutSeconds: 30 });
  assert.equal(repairJob.status, 'complete');
  assert.ok(
    recordedPrompts.some((p) => p.prompt.includes('UNTRUSTED_SAMPLE_851') && p.prompt.includes('MUST_TEST_WRITE_SKEW_BOUNDARY')),
    'draft.repair forwards stored questionReferences and moduleOverrides',
  );

  // Delete sample source: unreviewed publish fails closed without allowMissingReferences, then succeeds with allowMissingReferences and reports referenceGap
  draft = (await service.call('export')).drafts.find((d) => d.id === job.draftId);
  const savedUnreviewed = await service.call('draft.save', {
    deck: { ...draft, cards: [{ ...draft.cards[0], prompt: `${draft.cards[0].prompt}？` }] },
  });
  await service.call('source.archive', { id: sample.id, archived: true });
  await service.call('source.remove', { id: sample.id, confirm: true });

  await assert.rejects(
    service.call('draft.publish', { id: draft.id, draftVersion: savedUnreviewed.draftVersion }),
    /allowMissingReferences/,
  );
  const published = await service.call('draft.publish', {
    id: draft.id,
    draftVersion: savedUnreviewed.draftVersion,
    allowMissingReferences: true,
  });
  assert.ok(published.deckId);
  assert.equal(published.referenceGap?.missingIds?.length, 1);
});

test('#852: non-uniform kindCounts (including explicit 0), locked safety protocol, zero-call generate.preview, job.trace redaction, and solution exposure enforcement', async (t) => {
  // Locked safety protocol cannot be disabled via moduleOverrides
  assert.throws(() => normalizeModuleOverrides({ [LOCKED_PROTOCOL_MODULE_ID]: { enabled: false } }), /read-only and cannot be disabled/);
  assert.throws(() => normalizeModuleOverrides({ disableReview: true }), /read-only and cannot be disabled/);

  const root = await mkdtemp(join(tmpdir(), 'study-852-trace-exposure-'));
  const fake = createFakeModel({ latencyMs: 1 });
  let modelCallCount = 0;
  const service = new StudyService(root, {
    coach: false,
    complete: async (system, prompt, ctx) => {
      modelCallCount += 1;
      return fake(system, prompt, ctx);
    },
  });
  t.after(async () => { await service.dispose(); await rm(root, { recursive: true, force: true }); });

  const lesson = await service.call('source.add', { title: '隔离与索引', text: LESSON_TEXT, course: '数据库' });
  const sample = await service.call('source.add', { title: '样题集', text: SAMPLE_TEXT, course: '数据库' });

  const genArgs = {
    course: '数据库',
    sourceIds: [lesson.id],
    referenceSourceIds: [sample.id],
    referenceFormat: 'balanced',
    kinds: ['quiz', 'open', 'flashcard'],
    kindCounts: { quiz: 2, open: 1, flashcard: 0 },
    count: 3,
    moduleOverrides: {
      templateName: '期末辨析模板',
      reasoning: { enabled: true, instruction: 'VERIFY_ISOLATION_ANOMALY_STEP' },
      distractors: { enabled: true, instruction: 'MAP_EACH_DISTRACTOR_TO_LOCK_CONFUSION' },
    },
  };

  // 1. Zero-call generate.preview
  const jobsBefore = (await service.call('snapshot')).jobs.length;
  const preview = await service.call('generate.preview', genArgs);
  assert.equal(modelCallCount, 0, 'generate.preview makes zero model calls');
  assert.equal((await service.call('snapshot')).jobs.length, jobsBefore, 'generate.preview creates zero jobs');
  assert.equal(preview.modelCalls, 0);
  assert.equal(preview.origins.quota, 'explicit');
  assert.deepEqual(preview.summary.kindCounts, { quiz: 2, open: 1, flashcard: 0 });
  assert.ok(preview.requirementsVersion.startsWith('req-'));
  assert.ok(preview.conflicts.some((c) => c.code === 'zero-quota-kinds'), 'surfaces ticked 0-quota notice');
  assert.equal(preview.stages.length, 4);

  // 2. Run generation with non-uniform quotas (flashcard: 0 must stay 0)
  const started = await service.call('generate', genArgs);
  const job = await service.call('job.wait', { jobId: started.jobId, timeoutSeconds: 30 });
  assert.equal(job.status, 'complete');
  const draft = (await service.call('export')).drafts.find((d) => d.id === job.draftId);
  assert.equal(draft.cards.filter((c) => c.kind === 'flashcard').length, 0, 'ticked kind with 0 quota produces 0 items');
  assert.equal(draft.cards.filter((c) => c.kind === 'quiz').length, 2);
  assert.equal(draft.cards.filter((c) => c.kind === 'open').length, 1);
  assert.equal(draft.cards.length, 3);

  // 3. Inspect job.trace: Stage 1 unredacted with zero exposure; Stage 2/3/4 redacted by default
  const redactedTrace = await service.call('job.trace', { jobId: started.jobId, revealSolutions: false });
  assert.equal(Boolean(redactedTrace.exposureReceipt), false);
  assert.equal((await service.call('export')).learner?.solutionExposures?.length || 0, 0, 'viewing redacted trace records no exposure');

  const planCall = redactedTrace.calls.find((c) => c.purpose === 'plan' && !c.mechanical);
  const blueprintCall = redactedTrace.calls.find((c) => c.purpose === 'blueprint');
  const authorCall = redactedTrace.calls.find((c) => c.purpose === 'author');
  assert.ok(planCall && !planCall.containsSolution && !planCall.redacted, 'Stage 1 plan/evidence is visible without exposure');
  assert.ok(planCall.prompt.includes('VERIFY_ISOLATION_ANOMALY_STEP'), 'Stage 1 trace contains effective modular reasoning rule');
  assert.ok(blueprintCall && blueprintCall.containsSolution && blueprintCall.redacted && blueprintCall.prompt === undefined, 'Stage 2 blueprint is redacted by default');
  assert.ok(authorCall && authorCall.containsSolution && authorCall.redacted && authorCall.prompt === undefined, 'Stage 3 author is redacted by default');

  // 4. Reveal Stage 2 blueprint -> full prompt returned + irreversible exposure receipt persisted
  const revealed = await service.call('job.trace', {
    jobId: started.jobId,
    callId: blueprintCall.callId,
    revealSolutions: true,
    action: 'reveal',
  });
  assert.ok(revealed.exposureReceipt?.id, 'revealing solution-bearing stage records exposureReceipt');
  const revealedBlueprint = revealed.calls.find((c) => c.callId === blueprintCall.callId);
  assert.equal(revealedBlueprint.redacted, false);
  assert.ok(revealedBlueprint.prompt.includes('MAP_EACH_DISTRACTOR_TO_LOCK_CONFUSION'));

  // 5. Delete in-memory trace -> text cleared, exposure receipt remains intact
  const delRes = await service.call('job.trace.delete', { jobId: started.jobId });
  assert.ok(delRes.removed >= 1);
  const afterDelete = await service.call('job.trace', { jobId: started.jobId, revealSolutions: false });
  assert.equal(afterDelete.unavailableReason, 'deleted-by-user');
  assert.ok(afterDelete.calls.every((c) => !c.retained && c.unavailableReason === 'deleted-by-user'));
  assert.equal((await service.call('export')).learner?.solutionExposures?.length, 1, 'deleting trace never erases solution exposure record');

  // 6. Publish draft and answer a quiz card from the exposed batch -> cannot count as unseen independent pass!
  const pub = await service.call('draft.publish', { id: draft.id, draftVersion: draft.draftVersion });
  const pubDeck = (await service.call('export')).decks.find((d) => d.id === pub.deckId);
  const quizCard = pubDeck.cards.find((c) => c.kind === 'quiz');
  assert.ok(quizCard);
  const run = await service.call('review.start', {
    mode: 'path',
    scope: [{ deckId: pub.deckId, cardId: quizCard.id }],
    fresh: true,
  });
  const answerResult = await service.call('review.answer', {
    runId: run.id,
    cardId: quizCard.id,
    selected: [quizCard.options.find((o) => o.correct).id],
  });
  const exportedAfterAnswer = await service.call('export');
  const cardAttempts = exportedAfterAnswer.attempts.filter((att) => att.quiz_id === quizCard.id);
  assert.equal(cardAttempts.length, 1);
  const lastAttempt = cardAttempts[0];
  assert.equal(lastAttempt.grade, 4);
  assert.equal(lastAttempt.assistance.used, true, 'blueprint-exposed attempt is marked assisted');
  assert.equal(lastAttempt.assistance.blueprintExposed, true);
  assert.equal(lastAttempt.assistance.unseenStatus, 'exposed');
  assert.equal(deriveItemStatus({ id: quizCard.id }, cardAttempts).status, 'assisted', 'exposed correct attempt is assisted, never independent passed');
  assert.equal(answerResult.current?.feedback?.credited || 0, 0, 'exposed attempt never auto-credits prerequisites');
});
