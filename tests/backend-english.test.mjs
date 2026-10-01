import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { StudyService } from '../lib/service.js';
import { createJobNotifier } from '../lib/runtime/job-notice.js';
import { localizeAppMessage, localizeAppResponse } from '../lib/application-messages.js';
import { describeFailure } from '../lib/gemini.js';
import { modelServices } from '../lib/runtime/models.js';
import { storeDocuments, taskTracker } from '../lib/audio-job.js';
import { buildDocuments } from '../lib/transcript.js';
import { defaultTitle } from '../lib/live-save.js';
import { applyReview, itemKey } from '../lib/audio-review.js';

async function library(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'study-backend-english-'));
  const service = new StudyService(root, options);
  t.after(async () => { service.dispose(); await rm(root, { recursive: true, force: true }); });
  return service;
}

test('request language localizes audio validation without leaking into concurrent Chinese requests', async t => {
  const service = await library(t);
  const failures = await Promise.allSettled([
    service.call('audio.import', { path: 'relative.mp3', uiLanguage: 'en' }),
    service.call('audio.import', { path: 'relative.mp3', uiLanguage: 'zh' }),
    service.call('audio.import', { path: 'relative.mp3' }),
  ]);
  assert.equal(failures[0].reason.message, 'Audio file paths must be absolute');
  assert.equal(failures[1].reason.message, '音频文件路径必须是绝对路径');
  assert.equal(failures[2].reason.message, failures[1].reason.message);
  await assert.rejects(service.runtime.invoke('audio.v1', 'audio.import', { path: 'relative.mp3' }, { language: 'en' }), /Audio file paths must be absolute/);
});

test('snapshots and job.wait translate owned progress while preserving saved source, names and provider evidence', async t => {
  const service = await library(t);
  await service.store.update(state => {
    state.sources.push({ id: 'source', title: '读取音频', text: '排队中：这是用户保存的原文。' });
  });
  const job = { id: 'audio-job', root: service.store.root, type: 'audio-import', status: 'failed', filename: '排队中.mp3',
    stage: '上次导入已中断；已完成的部分已保存，点「接着做」继续',
    warnings: ['信箱通知未能保存，请在音频转录页查看任务结果。', 'Provider says: 服务暂不可用'],
    members: [{ filename: '读取音频.mp3', stage: '校对 1/3', error: 'Provider says: 服务暂不可用' }], startedAt: new Date().toISOString() };
  service.runtime.work.jobs.set(job.id, job);
  const en = await service.call('snapshot', { uiLanguage: 'en' });
  assert.equal(en.jobs[0].stage, 'The previous import was interrupted. Completed work is saved; select Resume to continue');
  assert.equal(en.jobs[0].members[0].stage, 'Proofreading 1/3');
  assert.equal(en.jobs[0].members[0].filename, '读取音频.mp3');
  assert.equal(en.sources[0].title, '读取音频');
  assert.equal(en.jobs[0].warnings[1], 'Provider says: 服务暂不可用');
  assert.equal((await service.store.read()).sources[0].text, '排队中：这是用户保存的原文。');
  assert.equal(job.stage, '上次导入已中断；已完成的部分已保存，点「接着做」继续');
  const waited = await service.call('job.wait', { jobId: job.id, uiLanguage: 'en' });
  assert.equal(waited.stage, en.jobs[0].stage);
  const zh = await service.call('snapshot', { uiLanguage: 'zh' });
  assert.equal(zh.jobs[0].stage, job.stage);
  assert.notEqual(en.fingerprint, zh.fingerprint);
});

test('English background job notifications retain user titles and describe retained work in English', () => {
  const notices = [];
  createJobNotifier(value => notices.push(value))({ language: 'en', id: 'j', type: 'audio-import', filename: '我的录音.mp3',
    status: 'complete', stage: '已存为 2 份资料，校对修正 3 处', sourceIds: ['s1', 's2'] });
  assert.match(notices[0].summary, /Audio.*我的录音.mp3.*transcript/);
  assert.match(notices[0].text, /Sources/);
  assert.doesNotMatch(notices[0].text.replaceAll('我的录音.mp3', ''), /[\u3400-\u9fff]/);
});

test('background notifications preserve bilingual results across job types and terminal statuses', () => {
  const base = { id: 'job-id', deckTitle: '读取音频', targetTitle: '读取音频', filename: '读取音频.mp3',
    mergeTargetId: 'deck-id', draftId: 'draft-id', stage: '排队中', sourceIds: ['source-id'],
    savedCount: 2, count: 3, requestedTotal: 3, publication: { added: 2, total: 10, remainingDraftId: 'remaining-id' } };
  const cases = [
    { type: 'audio-import', en: ['Audio "读取音频.mp3" saved as a bilingual transcript', 'Audio "读取音频.mp3" import incomplete', 'Audio "读取音频.mp3" import cancelled'],
      zh: ['音频「读取音频.mp3」已转写成中英对照逐字稿', '音频「读取音频.mp3」导入未完成', '音频「读取音频.mp3」导入已取消'],
      enDetail: 'Sources (source-id)', zhDetail: '资料 source-id' },
    { type: 'supplement', en: ['"读取音频" 2 questions added · 10 total', '"读取音频" supplement incomplete', '"读取音频" supplement incomplete'],
      zh: ['「读取音频」补入 2 题 · 共 10 题', '「读取音频」补题未完成', '「读取音频」补题未完成'],
      enDetail: 'remaining-id', zhDetail: 'remaining-id' },
    { type: 'draft-publish', en: ['"读取音频" publication checks complete', '"读取音频" publication incomplete', '"读取音频" publication incomplete'],
      zh: ['「读取音频」发布检查完成', '「读取音频」发布未完成', '「读取音频」发布未完成'],
      enDetail: 'publication task job-id', zhDetail: '发布任务 job-id' },
    { type: 'draft-repair', en: ['"读取音频" background repair approved · 2/3 questions', '"读取音频" background repair partially approved · 2/3 questions', '"读取音频" background repair cancelled · 2/3 questions'],
      zh: ['「读取音频」后台修题全部通过 · 2/3 题', '「读取音频」后台修题部分通过 · 2/3 题', '「读取音频」后台修题已取消 · 2/3 题'],
      enDetail: 'draft draft-id', zhDetail: '草稿 draft-id' },
    { type: 'generate', en: ['"读取音频" generation complete · 2 draft questions awaiting publication', '"读取音频" generation incomplete', '"读取音频" generation cancelled'],
      zh: ['「读取音频」生成完成 · 2 题草稿待发布', '「读取音频」生成未完成：排队中', '「读取音频」生成已取消：排队中'],
      enDetail: 'Draft draft-id', zhDetail: '草稿 draft-id' },
  ];
  for (const sample of cases) {
    for (const language of ['en', 'zh']) {
      for (const [index, status] of ['complete', 'failed', 'cancelled'].entries()) {
        const job = { ...base, type: sample.type, language, status };
        const original = structuredClone(job);
        const notices = [];
        createJobNotifier(notice => notices.push(notice))(job);
        assert.equal(notices.length, 1);
        assert.equal(notices[0].summary, sample[language][index]);
        assert.ok(notices[0].text.includes('job-id'));
        assert.ok(notices[0].text.includes(language === 'en' ? 'Queued' : '排队中'));
        if (sample.type !== 'audio-import' || status === 'complete') {
          assert.ok(notices[0].text.includes(language === 'en' ? sample.enDetail : sample.zhDetail));
        }
        if (language === 'en') assert.doesNotMatch(notices[0].text.replaceAll('读取音频', ''), /[\u3400-\u9fff]/);
        assert.deepEqual(job, original);
        assert.doesNotThrow(() => createJobNotifier(() => { throw new Error('Session ended'); })(job));
      }
    }
  }
});

test('completed supplements without publication receipts report no confirmed addition in both languages', () => {
  for (const language of ['en', 'zh']) {
    const notices = [];
    assert.doesNotThrow(() => createJobNotifier(notice => notices.push(notice))({
      language, id: 'job-id', type: 'supplement', status: 'complete', stage: '排队中',
      mergeTargetId: 'deck-id', targetTitle: '读取音频', savedCount: 0, requestedTotal: 3,
    }));
    assert.equal(notices.length, 1);
    assert.equal(notices[0].summary, language === 'en' ? '"读取音频" supplement incomplete' : '「读取音频」补题未完成');
    assert.ok(notices[0].text.includes(language === 'en' ? 'No addition is confirmed; do not report success.' : '未确认有题目并入，请勿报告成功。'));
    assert.ok(notices[0].text.includes('0/3'));
  }
});

test('snapshots and job.wait localize repair execution steps without changing learner requirements or sources', async t => {
  const service = await library(t);
  const source = { id: 'source', title: '读取音频', text: '排队中：这是用户保存的原文。' };
  await service.store.update(state => { state.sources.push(source); });
  const job = { id: 'repair-job', root: service.store.root, type: 'draft-repair', status: 'failed',
    stage: '修复第 1/2 题 · 第 2 次',
    steps: [{ stage: '修复第 1/2 题 · 第 2 次', note: '此阶段使用一次性子代理，缺少：活跃父代理。补充要求用于后续阶段。' },
      { stage: '独立复审 读取音频：card-id' }],
    messages: [{ text: '排队中' }, { text: '独立复审 读取音频：card-id' }], startedAt: new Date().toISOString() };
  const original = structuredClone(job);
  service.runtime.work.jobs.set(job.id, job);
  const en = await service.call('snapshot', { uiLanguage: 'en' });
  const waited = await service.call('job.wait', { jobId: job.id, uiLanguage: 'en' });
  for (const projected of [en.jobs[0], waited]) {
    assert.equal(projected.stage, 'Repairing question 1/2 · Attempt 2');
    assert.equal(projected.steps[0].stage, 'Repairing question 1/2 · Attempt 2');
    assert.equal(projected.steps[0].note, 'This stage uses a one-off child agent; missing: Active parent agent. Additional requirements apply to later stages.');
    assert.equal(projected.steps[1].stage, 'Independent review 读取音频：card-id');
    assert.deepEqual(projected.messages, original.messages);
  }
  assert.equal(en.sources[0].title, source.title);
  assert.equal(en.sources[0].text, source.text);
  assert.deepEqual((await service.store.read()).sources[0], source);
  assert.deepEqual(job, original);
  assert.deepEqual((await service.call('snapshot', { uiLanguage: 'zh' })).jobs[0].steps, original.steps);
});

test('provider failure wrappers, limits and nested workflow metadata are English while provider evidence and saved prose survive', () => {
  const evidence = '供应商原始错误: INVALID_KEY';
  const message = describeFailure(403, { error: { message: evidence } }, 'free');
  assert.equal(localizeAppMessage(message), `Free API key rejected (403): ${evidence}`);
  assert.equal(localizeAppMessage('免费额度今日用完，其余请求改用付费密钥'), 'Free daily quota exhausted; remaining requests use the paid API key');
  const session = { topic: '排队中', records: { lesson: { content: '读取音频', teaching: { status: 'failed', message: '讲解生成超时，请稍后重试' } } },
    skeletonJob: { message: '骨架生成超时，可以稍后重试' } };
  const response = localizeAppResponse({ session }, 'workflow.session.get', 'en');
  assert.equal(response.session.records.lesson.teaching.message, 'Explanation generation timed out; retry later');
  assert.equal(response.session.records.lesson.content, '读取音频');
  assert.equal(response.session.topic, '排队中');
  assert.equal(session.records.lesson.teaching.message, '讲解生成超时，请稍后重试');
});

test('batch warning lookup preserves filename prefixes, duplicates and unknown evidence', () => {
  const job = { members: [{ filename: 'a' }, { filename: 'a：b.mp3' }, { filename: 'a：b.mp3' }],
    warnings: ['a：b.mp3：排队中', 'a：排队中', 'a：b.mp3：Provider says: 服务暂不可用', 'unmatched：供应商原文'] };
  assert.deepEqual(localizeAppResponse(job, 'job.wait', 'en').warnings,
    ['a：b.mp3: Queued', 'a: Queued', 'a：b.mp3: Provider says: 服务暂不可用', 'unmatched：供应商原文']);
  const simple = { members: [{ filename: 'a.mp3' }, { filename: 'a.mp3' }], warnings: ['a.mp3：排队中', 'a.mp3'] };
  assert.deepEqual(localizeAppResponse(simple, 'job.wait', 'en').warnings, ['a.mp3: Queued', 'a.mp3']);
});

test('language metadata does not violate strict selection response contracts', async t => {
  const service = await library(t);
  await assert.rejects(service.call('generation.selection.get', { operationId: 'missing', uiLanguage: 'en' }), error => {
    assert.doesNotMatch(error.message, /uiLanguage.*not supported/);
    return true;
  });
});

test('English model requests and child-agent progress labels use request language before display', async () => {
  let request;
  const model = modelServices({ language: 'en', complete: async (_system, _prompt, options) => { request = options; return 'ok'; } });
  const job = { language: 'en' };
  await taskTracker(job)({ stage: '校对 1/3' }, task => model.complete('Tutor', '{}', { stage: task.stage, jobId: 'opaque-id' }));
  assert.equal(job.tasks[0].stage, 'Proofreading 1/3');
  assert.equal(request.stage, 'Proofreading 1/3');
  assert.equal(request.jobId, 'opaque-id');
  let lightSystem;
  await modelServices({ language: 'en', light: async system => { lightSystem = system; return 'ok'; } }).light('Chinese tutor', '{}');
  assert.match(lightSystem, /Application language preference: English/);
});

test('new English transcript scaffolding and default class titles are English while bilingual content remains reviewable', async () => {
  const part = { titleZh: '分区', titleEn: 'Partitions', english: ['split the table into a patient'], chinese: ['拆分为病人'] };
  const documents = buildDocuments({ filename: '我的录音.mp3', titleEn: 'Partitions', parts: [part], language: 'en' });
  assert.match(documents[0], /\[English original\]/);
  assert.doesNotMatch(documents[0], /全量中英对照逐字稿|英文原句|中文对照/);
  const suggestion = { wrong: 'patient', right: 'partition', context: 'split the table into a patient', skipped: 'low-confidence' };
  const reviewed = applyReview({ texts: documents, corrections: { applied: [], skipped: [suggestion] },
    decisions: new Map([[itemKey(suggestion), { verdict: 'apply', right: 'partition', translation: { wrong: '病人', right: '分区' }, reason: 'Database term' }]]) });
  assert.equal(reviewed.applied, 1);
  assert.match(reviewed.texts[0], /into a partition/);
  assert.match(reviewed.texts[0], /拆分为分区/);
  let saved;
  await storeDocuments({ store: { publishSources: async records => { saved = records; } }, ids: ['s'], documents,
    title: '我的录音', meta: {}, corrections: { applied: [], skipped: [] }, language: 'en' });
  assert.equal(saved[0].title, '我的录音 · Bilingual transcript');
  assert.equal(saved[0].text, documents[0]);
  assert.match(defaultTitle(new Date('2026-01-01T12:00:00'), 'en'), /^Live class recording /);
  assert.match(defaultTitle(new Date('2026-01-01T12:00:00')), /^课堂实录 /);
});
