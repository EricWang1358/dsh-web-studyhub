import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StudyService } from '../lib/service.js';
import { assistantRefusal } from '../lib/assistant-boundary.js';
import { SHIPPED_SKILLS, studySkills } from '../lib/study-skills.js';
import { cardLevel, latestOutcomes } from '../lib/mastery.js';
import { loadUi } from './helpers/ui-module.mjs';

const execFileAsync = promisify(execFile);
const STUDY_CLI = fileURLToPath(new URL('../scripts/study-cli.mjs', import.meta.url));

async function setupLibrary(t) {
  const root = await mkdtemp(join(tmpdir(), 'study-voice-coach-'));
  const service = new StudyService(root);
  t.after(async () => {
    await service.dispose();
    await rm(root, { recursive: true, force: true });
  });

  await service.call('source.add', {
    id: 'src-net-1',
    title: '计算机网络 · 传输层笔记',
    courses: ['计网速成'],
    text: 'TCP 三次握手建立可靠连接，SYN Flood 通过只发 SYN 不回 ACK 耗尽服务器半连接队列；UDP 是无连接协议，UDP Flood 与反射放大攻击会耗尽带宽；WHOIS 使用端口 43，标准查询走 TCP/43。',
  });

  const imported = await service.call('deck.import', {
    course: '计网速成',
    text: JSON.stringify({
      title: '传输层高频题',
      course: '计网速成',
      cards: [
        {
          id: 'c-handshake',
          kind: 'flashcard',
          topic: 'TCP',
          objective: '掌握 TCP 三次握手核心步骤',
          prompt: 'TCP 三次握手的三步分别发送什么报文？',
          answer: 'SYN → SYN-ACK → ACK',
          hint: '客户端先发起同步请求',
          explanation: '确认双方收发能力并同步初始序列号。',
          misconception: '误以为两次握手就够确认双向收发',
          citations: [{ sourceId: 'src-net-1', quote: 'TCP 三次握手建立可靠连接' }],
        },
        {
          id: 'c-syn-flood',
          kind: 'flashcard',
          topic: '网络安全',
          objective: '区分 SYN Flood 的资源耗尽机制',
          prompt: 'SYN Flood 攻击消耗的是服务器的什么资源？',
          answer: '服务器内存中的半连接队列（SYN Queue）资源',
          hint: '发生在三次握手未完成阶段',
          explanation: '攻击者狂发 SYN 但故意不回 ACK，占满半连接队列。',
          misconception: '和 UDP 放大攻击的带宽耗尽混淆',
          citations: [{ sourceId: 'src-net-1', quote: 'SYN Flood 通过只发 SYN 不回 ACK 耗尽服务器半连接队列' }],
        },
        {
          id: 'c-udp-flood',
          kind: 'flashcard',
          topic: '网络安全',
          objective: '理解 UDP Flood 与反射放大攻击的本质',
          prompt: 'UDP Flood 放大攻击主要打垮系统的哪一环？',
          answer: '目标链路或全网带宽',
          hint: 'UDP 无需握手，小请求换大响应',
          explanation: '伪造源 IP 利用 DNS/NTP 等服务把放大几十倍的回包砸向目标。',
          misconception: '误以为消耗的是 TCP 连接队列',
          citations: [{ sourceId: 'src-net-1', quote: 'UDP Flood 与反射放大攻击会耗尽带宽' }],
        },
        {
          id: 'c-whois',
          kind: 'flashcard',
          topic: '应用层端口',
          objective: '区分 TCP/43 与 UDP/43',
          prompt: '端口 43 上标准 WHOIS 查询使用什么传输协议？',
          answer: 'TCP/43，建立可靠连接后查询并返回完整结果',
          hint: '需要保证查询结果完整不丢包',
          explanation: '标准 WHOIS 走 TCP/43；UDP/43 仅见于极少数简化高速查询场景。',
          misconception: '误以为所有 43 端口都是无连接广播',
          citations: [{ sourceId: 'src-net-1', quote: 'WHOIS 使用端口 43，标准查询走 TCP/43' }],
        },
      ],
    }),
  });

  const deck = (await service.store.read()).decks.find((d) => d.title === '传输层高频题');
  assert.ok(deck && deck.cards.length === 4, `expected imported deck with 4 cards, got ${JSON.stringify(imported)}`);
  return { root, service, deck, cardIds: deck.cards.map((c) => c.id) };
}

test('assistant boundary allows study.voicePack and card.review.batch while preserving HB-1', () => {
  assert.equal(assistantRefusal('study.voicePack'), null);
  assert.equal(assistantRefusal('card.review.batch'), null);
  for (const panelOnly of ['review.answer', 'exam.submit', 'oral.answer', 'oral.submit', 'review.undo']) {
    assert.match(assistantRefusal(panelOnly) || '', /HB-1/, panelOnly);
  }
});

test('study-coach-team skill is shipped and covers 4 specialist TAs + Head Coach tools', () => {
  assert.ok(SHIPPED_SKILLS.includes('study-coach-team'));
  const skill = studySkills().find((s) => s.name === 'study-coach-team');
  assert.ok(skill, 'study-coach-team skill loaded');
  for (const token of ['study.voicePack', 'card.review.batch', 'card.followup.add', 'card.link.batch', 'supplement', 'capture', 'panel.open']) {
    assert.ok(skill.content.includes(token), `skill mentions ${token}`);
  }
});

test('study.voicePack exports cram-prioritized anti-drift prompt with [cardId] anchors in zh and en', async (t) => {
  const { service, deck, cardIds } = await setupLibrary(t);
  const [cHandshake, cSyn, cUdp, cWhois] = cardIds;

  // Mark cHandshake mastered (grade 5), cSyn weak + focus (grade 1), leave cUdp and cWhois new.
  await service.call('card.review.batch', {
    items: [
      { cardId: cHandshake, grade: 5, evidence: '能一口气讲清 SYN / SYN-ACK / ACK' },
      { cardId: cSyn, grade: 1, focus: true, evidence: '和 UDP 放大搞混了' },
    ],
  });

  await service.call('course.save', {
    name: '计网速成',
    focusTopics: ['SYN Flood', 'UDP 放大攻击'],
    exam: { format: 'closed-book', date: '2026-12-10' },
  });
  await service.call('coach.goal', { goal: 'interview' });

  const zhPack = await service.call('study.voicePack', {
    course: '计网速成',
    only: 'cram',
    limit: 3,
    minutes: 25,
    goal: '3 周速成面试高频计网',
    language: 'zh',
  });
  assert.equal(zhPack.count, 3);
  assert.equal(zhPack.totalAvailable, 4);
  assert.equal(zhPack.cards[0].cardId, cSyn, 'focus + weak card comes first in cram mode');
  assert.ok(!zhPack.cards.some((c) => c.cardId === cHandshake), 'already mastered card skipped in cram mode');
  assert.equal(zhPack.progress.total, 4);
  assert.equal(zhPack.progress.counts.mastered, 1);
  assert.equal(zhPack.progress.counts.weak, 1);
  assert.equal(zhPack.progress.counts.new, 2);
  assert.equal(zhPack.progress.exam?.date, '2026-12-10');
  assert.deepEqual(zhPack.progress.focusTopics, ['SYN Flood', 'UDP 放大攻击']);
  assert.match(zhPack.markdown, /当前学习进度快照/);
  assert.match(zhPack.markdown, /2026-12-10/);
  assert.match(zhPack.markdown, /SYN Flood、UDP 放大攻击/);
  assert.match(zhPack.markdown, new RegExp(`\\[${cSyn}\\]`));
  assert.match(zhPack.markdown, /今天先到这，给我结算/);
  assert.match(zhPack.markdown, /\[进度 k\/3 · 本题第 t\/3 轮/);
  assert.match(zhPack.markdown, /单题 3 轮熔断/);
  assert.match(zhPack.markdown, /允许轻度闲聊/);
  assert.match(zhPack.markdown, /study-coach-team/);
  assert.match(zhPack.markdown, /3 周速成面试高频计网/);

  const enPack = await service.call('study.voicePack', {
    deckId: deck.id,
    only: 'weak',
    banter: 'strict',
    language: 'en',
  });
  assert.equal(enPack.count, 1);
  assert.equal(enPack.cards[0].cardId, cSyn);
  assert.equal(enPack.banter, 'strict');
  assert.equal(enPack.progress.total, 4, 'progress snapshot reflects full scope even when only=weak');
  assert.match(enPack.markdown, /Current Study Progress Snapshot/);
  assert.match(enPack.markdown, /Zero-tangent pacing/);
  assert.match(enPack.markdown, /\[Progress k\/1 · Turn t\/3/);
  assert.match(enPack.markdown, /Anti-Drift Voice Tutor Prompt/);
  assert.match(enPack.markdown, /Wrap up today/);
  assert.ok([cUdp, cWhois].every((id) => !enPack.markdown.includes(`[${id}]`)));
});

test('card.review.batch syncs FSRS mastery, pre-filled plain QA, focus, slay, and per-item errors cleanly', async (t) => {
  const { service, deck, cardIds } = await setupLibrary(t);
  const [cHandshake, cSyn, cUdp, cWhois] = cardIds;

  const result = await service.call('card.review.batch', {
    sessionTitle: 'Gemini 语音带学 · 传输层',
    items: [
      {
        cardId: cSyn,
        grade: 2,
        focus: true,
        evidence: '记得 SYN 半开放但混淆了带宽和连接队列',
        reason: '语音卡壳点',
        followup: {
          question: '怎么一句话区分 SYN Flood 和 UDP 放大攻击？',
          answer: 'SYN Flood 占死服务器的半连接队列（连接资源），UDP 放大攻击是用大回包堵死全网带宽。',
        },
      },
      {
        cardId: cUdp,
        followup: {
          question: '为什么 UDP 容易被用来做放大攻击？',
          answer: 'UDP 不握手，攻击者可以伪造受害者源 IP 发小请求，让 DNS/NTP 把大几十倍的回包全砸过去。',
        },
      },
      {
        cardId: cHandshake,
        grade: 4,
        evidence: '自己讲清了三次握手确认双向收发',
      },
      {
        cardId: cWhois,
        slay: true,
      },
      {
        cardId: 'non-existent-card-id',
        grade: 3,
      },
    ],
  });

  assert.equal(result.updated, 4);
  assert.equal(result.failed, 1);
  assert.equal(result.graded, 2);
  assert.equal(result.followupsAdded, 2);
  assert.equal(result.focusChanged, 1);
  assert.equal(result.slain, 1);
  assert.equal(result.results[4].ok, false);

  const state = await service.store.read();
  const liveDeck = state.decks.find((d) => d.id === deck.id);
  const outcome = latestOutcomes(state.attempts);

  const syn = liveDeck.cards.find((c) => c.id === cSyn);
  assert.equal(syn.focus, true);
  assert.equal(cardLevel(syn, outcome(deck.id, cSyn)), 'weak');
  assert.equal(syn.followups.length, 1);
  assert.equal(syn.followups[0].source, 'assistant');
  assert.match(syn.followups[0].answer, /半连接队列/);

  const udp = liveDeck.cards.find((c) => c.id === cUdp);
  assert.equal(cardLevel(udp, outcome(deck.id, cUdp)), 'new', 'QA-only item leaves FSRS level untouched');
  assert.equal(udp.followups.length, 1);

  const handshake = liveDeck.cards.find((c) => c.id === cHandshake);
  assert.ok(['learning', 'familiar'].includes(cardLevel(handshake, outcome(deck.id, cHandshake))));
  assert.ok(handshake.review?.due_at);

  const slainDeck = state.decks.find((d) => d.systemKind === 'slain');
  assert.ok(slainDeck?.cards.some((c) => c.id === cWhois), 'slain card moved cleanly');

  const coachAttempts = state.attempts.filter((a) => a.assessment === 'coach-sync');
  assert.equal(coachAttempts.length, 2);
  assert.equal(coachAttempts[0].via, 'coach-sync');
  assert.match(coachAttempts[0].learnerAnswer, /半开放/);

  // Deduplication check: re-adding the same followup question does not duplicate it.
  const dup = await service.call('card.review.batch', {
    items: [
      {
        cardId: cUdp,
        followup: {
          question: '为什么 UDP 容易被用来做放大攻击？',
          answer: '重复内容不应重复插入',
        },
      },
    ],
  });
  assert.equal(dup.followupsAdded, 0);
  assert.equal(dup.results[0].followupDuplicate, true);
});

test('scripts/study-cli.mjs bridges Codex/agy/external CLIs safely (pack, batch sync, HB-1 guard)', async (t) => {
  const { root, service, deck, cardIds } = await setupLibrary(t);
  const [cHandshake, cSyn] = cardIds;
  const workDir = await mkdtemp(join(tmpdir(), 'study-cli-out-'));
  t.after(() => rm(workDir, { recursive: true, force: true }));

  // 1. Export voice pack Markdown directly to disk via `pack --out`
  const outMd = join(workDir, 'net-pack.md');
  const packRun = await execFileAsync(process.execPath, [
    STUDY_CLI,
    'pack',
    '--root', root,
    '--course', '计网速成',
    '--limit', '10',
    '--out', outMd,
  ]);
  const packSummary = JSON.parse(packRun.stdout);
  assert.equal(packSummary.ok, true);
  assert.equal(packSummary.count, 4);
  const mdText = await readFile(outMd, 'utf8');
  assert.match(mdText, /当前学习进度快照/);
  assert.match(mdText, new RegExp(`\\[${cSyn}\\]`));

  // 2. Sync mastery & plain QA via `call card.review.batch --file`
  const planPath = join(workDir, 'sync-plan.json');
  await writeFile(planPath, JSON.stringify({
    sessionTitle: '外部 CLI 结算测试',
    items: [
      {
        cardId: cHandshake,
        grade: 4,
        evidence: '能用大白话讲清三次握手',
      },
      {
        cardId: cSyn,
        grade: 1,
        focus: true,
        followup: {
          question: 'SYN Flood 卡死的是什么？',
          answer: '服务器内存里的半连接队列。',
        },
      },
    ],
  }), 'utf8');

  const syncRun = await execFileAsync(process.execPath, [
    STUDY_CLI,
    'call',
    'card.review.batch',
    '--root', root,
    '--file', planPath,
  ]);
  const syncSummary = JSON.parse(syncRun.stdout);
  assert.equal(syncSummary.updated, 2);
  assert.equal(syncSummary.graded, 2);
  assert.equal(syncSummary.followupsAdded, 1);

  const state = await service.store.read();
  const outcome = latestOutcomes(state.attempts);
  const liveDeck = state.decks.find((d) => d.id === deck.id);
  const syn = liveDeck.cards.find((c) => c.id === cSyn);
  assert.equal(cardLevel(syn, outcome(deck.id, cSyn)), 'weak');
  assert.equal(syn.focus, true);
  assert.equal(syn.followups.length, 1);

  // 3. Panel-only HB-1 action is still rejected by the CLI bridge
  await assert.rejects(
    execFileAsync(process.execPath, [STUDY_CLI, 'call', 'review.answer', '{}', '--root', root]),
    /HB-1/,
  );
});

test('coach.debrief hand-off composes cleanly in zh and en without crashing, and composeMessage rejects unknown tail keys', async () => {
  const ui = await loadUi(`
    export { handOffText } from './ui/agent-prompts/index.js';
    export { coachDebriefPrompt } from './ui/agent-prompts/coach-team.js';
    export { MESSAGE_TAILS, composeMessage, messageParts, withLearnerFence } from './ui/agent-prompts/message.js';
  `);
  assert.equal(ui.MESSAGE_TAILS.debrief, '以下是本次语音 / 外部对话记录：');
  assert.equal(ui.coachDebriefPrompt({ course: 'OS' }, 'zh').tail, 'debrief');
  assert.equal(ui.coachDebriefPrompt({ course: 'OS' }, 'en').tail, 'debrief');

  const zh = ui.handOffText('coach.debrief', { course: 'OS', deckTitle: 'Memory' }, 'zh');
  assert.ok(zh.endsWith('\n\n以下是本次语音 / 外部对话记录：'), zh);
  assert.equal(ui.messageParts(zh, 'zh').tail, '以下是本次语音 / 外部对话记录：');
  assert.ok(ui.withLearnerFence(zh, { goal: '应付考试' }, 'zh').endsWith('\n\n以下是本次语音 / 外部对话记录：'));

  const en = ui.handOffText('coach.debrief', { course: 'OS', deckTitle: 'Memory' }, 'en');
  assert.ok(en.endsWith('\n\nPaste your voice / external chat transcript below:'), en);
  assert.equal(ui.messageParts(en, 'en').tail, 'Paste your voice / external chat transcript below:');
  assert.ok(ui.withLearnerFence(en, { goal: 'Pass an exam' }, 'en').endsWith('\n\nPaste your voice / external chat transcript below:'));

  assert.throws(
    () => ui.composeMessage({ ask: 'Hello', tail: 'not-a-valid-tail-key' }, { language: 'en' }),
    /Unknown message tail/,
  );
});

test('study.voicePack maps learner.goal="explore" cleanly in English and card.review.batch supports batchId/idempotencyKey and atomic validation', async (t) => {
  const { service, deck, cardIds } = await setupLibrary(t);
  const [cHandshake, cSyn, cUdp, cWhois] = cardIds;

  // 1. GOAL_LABELS_EN maps `explore` -> `Personal interest` instead of falling back to raw `explore`
  await service.call('coach.goal', { goal: 'explore' });
  const enPack = await service.call('study.voicePack', { deckId: deck.id, language: 'en' });
  assert.equal(enPack.progress.learnerGoal, 'Personal interest');
  assert.match(enPack.markdown, /Learner goal\*\*: Personal interest/);

  // 2. Idempotent batchId retry does not double-push FSRS, duplicate attempts, or spam inbox notifications
  const firstBatch = await service.call('card.review.batch', {
    batchId: 'voice-debrief-2026-11-21-01',
    sessionTitle: 'Voice Debrief #1',
    items: [
      { cardId: cHandshake, grade: 4, evidence: 'Explained 3-way handshake clearly' },
      { cardId: cWhois, grade: 5, slay: true, evidence: 'Knew TCP/43 immediately' },
    ],
  });
  assert.equal(firstBatch.batchId, 'voice-debrief-2026-11-21-01');
  assert.equal(firstBatch.graded, 2);
  assert.equal(firstBatch.deduplicated, 0);
  assert.equal(firstBatch.slain, 1);

  const stateAfterFirst = await service.store.read();
  const reviewAfterFirst = structuredClone(stateAfterFirst.decks.find((d) => d.id === deck.id).cards.find((c) => c.id === cHandshake).review);
  const attemptsAfterFirst = stateAfterFirst.attempts.length;
  const inboxAfterFirst = stateAfterFirst.inbox.length;

  // Retry exact same batch using `idempotencyKey` alias
  const retryBatch = await service.call('card.review.batch', {
    idempotencyKey: 'voice-debrief-2026-11-21-01',
    sessionTitle: 'Voice Debrief #1',
    items: [
      { cardId: cHandshake, grade: 4, evidence: 'Explained 3-way handshake clearly' },
      { cardId: cWhois, grade: 5, slay: true, evidence: 'Knew TCP/43 immediately' },
    ],
  });
  assert.equal(retryBatch.graded, 0, 'retry must not push FSRS a second time');
  assert.equal(retryBatch.deduplicated, 2);
  assert.equal(retryBatch.failed, 0);
  assert.equal(retryBatch.results[0].gradeDuplicate, true);
  assert.equal(retryBatch.results[1].gradeDuplicate, true);
  assert.equal(retryBatch.results[1].alreadySlain, true);

  const stateAfterRetry = await service.store.read();
  assert.deepEqual(
    stateAfterRetry.decks.find((d) => d.id === deck.id).cards.find((c) => c.id === cHandshake).review,
    reviewAfterFirst,
    'FSRS review state stays byte-identical on idempotent retry',
  );
  assert.equal(stateAfterRetry.attempts.length, attemptsAfterFirst, 'no duplicate attempts appended');
  assert.equal(stateAfterRetry.inbox.length, inboxAfterFirst, 'no duplicate inbox notification on replay');

  // 3. Intra-item atomicity: invalid followup must NOT leave `focus` partially mutated on the same card
  const partialRes = await service.call('card.review.batch', {
    items: [
      { cardId: cSyn, focus: true, followup: { question: 'Why SYN queue?', answer: '   ' } },
    ],
  });
  assert.equal(partialRes.failed, 1);
  assert.equal(partialRes.focusChanged, 0);
  const synAfterFail = (await service.store.read()).decks.find((d) => d.id === deck.id).cards.find((c) => c.id === cSyn);
  assert.equal(Boolean(synAfterFail.focus), false, 'failed item must not partially mutate card.focus');

  // 4. `atomic: true` rejects the entire batch before mutating any card when any item fails validation
  await assert.rejects(
    () => service.call('card.review.batch', {
      atomic: true,
      items: [
        { cardId: cUdp, grade: 4, focus: true },
        { cardId: 'non-existent-card', grade: 3 },
      ],
    }),
    /批量校验失败/,
  );
  const udpAfterAtomicAbort = (await service.store.read()).decks.find((d) => d.id === deck.id).cards.find((c) => c.id === cUdp);
  assert.equal(Boolean(udpAfterAtomicAbort.focus), false, 'atomic abort leaves earlier valid items untouched');
  assert.equal((await service.store.read()).attempts.length, attemptsAfterFirst, 'atomic abort adds zero attempts');
});
