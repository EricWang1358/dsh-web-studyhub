#!/usr/bin/env node
/**
 * Deterministic Offline Prompt & Skill Contract Evaluator (zero API key, zero runtime bundle cost).
 * Evaluates all 4 core StudyHub agent contracts defined in `evals/cases/*.json` against real StudyHub
 * engines (`lib/study-scene.js`, `lib/contexts/study/voice-handoff.js`, `lib/assistant-boundary.js`,
 * `lib/generation.js`, `lib/contexts/generation/content-language.js`, `lib/study-skills.js`,
 * `lib/calculation-check.js`, `lib/chemistry-balance.js`, and `ui/agent-prompts/*`).
 */
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildCompactScene } from '../lib/study-scene.js';
import { applyCardReviewBatch, buildVoicePack } from '../lib/contexts/study/voice-handoff.js';
import { assistantRefusal } from '../lib/assistant-boundary.js';
import { parseJson, salvageAuthoredCards } from '../lib/generation.js';
import { languageIssues, notEnglish, withContentLanguage } from '../lib/contexts/generation/content-language.js';
import { parseSkill } from '../lib/study-skills.js';
import { checkCalculation } from '../lib/calculation-check.js';
import { balanceEquation } from '../lib/chemistry-balance.js';
import { loadUi } from '../tests/helpers/ui-module.mjs';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const DEFAULT_CASES_DIR = join(REPO_ROOT, 'evals', 'cases');
const HAN_RE = /\p{Script=Han}/u;
const CJK_BRACKETS_RE = /[《》「」『』]/;
const PASSIVE_EVIDENCE_RE = /^(?:嗯+|哦+|好(?:的)?|懂了|明白了|知道了|了解|没问题|ok(?:ay)?|yeah|yes|got it|makes sense|i see|understood|sure|clear|[\s,，。.!！~～]+)+$/i;

let cachedAgentPromptsPromise = null;
function loadAgentPrompts() {
  cachedAgentPromptsPromise ??= loadUi(`
    export { handOffText } from './ui/agent-prompts/index.js';
    export { coachDebriefPrompt } from './ui/agent-prompts/coach-team.js';
    export { MESSAGE_TAILS, composeMessage, dataFence, messageParts, withLearnerFence } from './ui/agent-prompts/message.js';
  `);
  return cachedAgentPromptsPromise;
}

function makeFixtureState({ englishLibrary = false, learnerGoal = 'interview' } = {}) {
  if (englishLibrary) {
    return {
      settings: {},
      learner: { goal: learnerGoal, preferences: ['intuition first'] },
      courses: [{ id: 'course-os', name: 'Operating Systems', focusTopics: ['TLB'], exam: { date: '2026-12-15', format: 'closed-book' } }],
      sources: [{ id: 'src-os-1', title: 'OS Virtual Memory', courses: ['Operating Systems'], text: 'A TLB caches page table entries to speed up virtual-to-physical translation.' }],
      decks: [{
        id: 'deck-os',
        title: 'Virtual Memory Core',
        course: 'Operating Systems',
        cards: [
          {
            id: 'c-tlb',
            kind: 'flashcard',
            topic: 'TLB',
            focus: true,
            prompt: 'What happens on a TLB miss?',
            answer: 'The hardware or OS performs a page table walk and loads the entry into the TLB.',
            hint: 'Think about where the full page table lives.',
            misconception: 'Assuming every TLB miss is a page fault.',
            citations: [{ sourceId: 'src-os-1', quote: 'A TLB caches page table entries' }],
          },
          {
            id: 'c-paging',
            kind: 'flashcard',
            topic: 'Paging',
            prompt: 'Why do multi-level page tables save memory?',
            answer: 'Unallocated virtual address subtrees need no leaf page tables.',
            citations: [{ sourceId: 'src-os-1', quote: 'speed up virtual-to-physical translation' }],
          },
        ],
      }],
      attempts: [
        { id: 'a-tlb-1', quiz_id: 'c-tlb', deckId: 'deck-os', grade: 1, timestamp: '2026-11-20T10:00:00.000Z' },
      ],
      inbox: [],
    };
  }

  return {
    settings: {},
    learner: { goal: learnerGoal, preferences: ['先给大白话类比'] },
    courses: [{ id: 'course-net', name: '计网速成', focusTopics: ['SYN Flood', 'UDP 放大攻击'], exam: { date: '2026-12-10', format: 'closed-book' } }],
    sources: [{
      id: 'src-net-1',
      title: '计算机网络 · 传输层笔记',
      courses: ['计网速成'],
      text: 'TCP 三次握手建立可靠连接，SYN Flood 通过只发 SYN 不回 ACK 耗尽服务器半连接队列；UDP 是无连接协议，UDP Flood 与反射放大攻击会耗尽带宽；WHOIS 使用端口 43，标准查询走 TCP/43。',
    }],
    decks: [{
      id: 'deck-net',
      title: '传输层高频题',
      course: '计网速成',
      cards: [
        {
          id: 'c-handshake',
          kind: 'flashcard',
          topic: 'TCP',
          prompt: 'TCP 三次握手的三步分别发送什么报文？',
          answer: 'SYN → SYN-ACK → ACK',
          hint: '客户端先发起同步请求',
          misconception: '误以为两次握手就够确认双向收发',
          review: { reps: 3, interval: 14, stability: 14, due_at: '2026-12-05T00:00:00.000Z', state: 2 },
          citations: [{ sourceId: 'src-net-1', quote: 'TCP 三次握手建立可靠连接' }],
        },
        {
          id: 'c-syn-flood',
          kind: 'flashcard',
          topic: '网络安全',
          focus: true,
          prompt: 'SYN Flood 攻击消耗的是服务器的什么资源？',
          answer: '服务器内存中的半连接队列（SYN Queue）资源',
          hint: '发生在三次握手未完成阶段',
          misconception: '和 UDP 放大攻击的带宽耗尽混淆',
          citations: [{ sourceId: 'src-net-1', quote: 'SYN Flood 通过只发 SYN 不回 ACK 耗尽服务器半连接队列' }],
        },
        {
          id: 'c-udp-flood',
          kind: 'flashcard',
          topic: '网络安全',
          prompt: 'UDP Flood 放大攻击主要打垮系统的哪一环？',
          answer: '目标链路或全网带宽',
          hint: 'UDP 无需握手，小请求换大响应',
          misconception: '误以为消耗的是 TCP 连接队列',
          citations: [{ sourceId: 'src-net-1', quote: 'UDP Flood 与反射放大攻击会耗尽带宽' }],
        },
        {
          id: 'c-whois',
          kind: 'flashcard',
          topic: '应用层端口',
          prompt: '端口 43 上标准 WHOIS 查询使用什么传输协议？',
          answer: 'TCP/43，建立可靠连接后查询并返回完整结果',
          hint: '需要保证查询结果完整不丢包',
          misconception: '误以为所有 43 端口都是无连接广播',
          citations: [{ sourceId: 'src-net-1', quote: 'WHOIS 使用端口 43，标准查询走 TCP/43' }],
        },
      ],
    }],
    attempts: [
      { id: 'a-hs', quiz_id: 'c-handshake', deckId: 'deck-net', grade: 5, timestamp: '2026-11-20T09:00:00.000Z' },
      { id: 'a-syn', quiz_id: 'c-syn-flood', deckId: 'deck-net', grade: 1, timestamp: '2026-11-20T09:05:00.000Z' },
    ],
    inbox: [],
  };
}

/** Deterministic anti-spoiling reply auditor for cue_only / hint tiers. */
export function detectAnswerLeak(reply, { tier, secretAnswer, correctOptionId, correctOptionText }) {
  if (tier === 'full') return { leaked: false, reasons: [] };
  const text = String(reply ?? '');
  const reasons = [];
  const norm = (s) => String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
  const normReply = norm(text);
  const coreAnswer = norm(secretAnswer).replace(/[（(][^）)]*[）)]/g, '').trim();
  if (coreAnswer.length >= 4 && normReply.includes(coreAnswer)) {
    reasons.push('leaks_secret_answer');
  }
  const coreOpt = norm(correctOptionText);
  if (coreOpt.length >= 6 && normReply.includes(coreOpt)) {
    reasons.push('leaks_correct_option_text');
  }
  if (correctOptionId) {
    const idEsc = String(correctOptionId).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const optRevealRe = new RegExp(
      `(?:选项|选择|选|答案(?:是|为)?|correct\\s+option(?:\\s+is)?|option)\\s*[:：]?\\s*${idEsc}(?![A-Za-z0-9])`,
      'i',
    );
    if (optRevealRe.test(text)) reasons.push('leaks_correct_option_id');
  }
  if (/(?:首字(?:母)?是|starts with the letter|first letter is)/i.test(text)) {
    reasons.push('leaks_answer_initial');
  }
  return { leaked: reasons.length > 0, reasons };
}

/** Parse and validate Voice Study Pack anti-drift heartbeat headers. */
export function parseVoiceHeartbeat(text) {
  const firstLine = String(text ?? '').trim().split(/\r?\n/)[0] || '';
  const zh = /^\[进度\s+(\d+)\/(\d+)\s*·\s*本题第\s+(\d+)\/3\s*轮(?:\s*·\s*剩约\s*\d+\s*分钟)?\]/.exec(firstLine);
  if (zh) return { lang: 'zh', item: Number(zh[1]), total: Number(zh[2]), turn: Number(zh[3]) };
  const en = /^\[Progress\s+(\d+)\/(\d+)\s*·\s*Turn\s+(\d+)\/3(?:\s*·\s*~?\d+\s*min\s*left)?\]/i.exec(firstLine);
  if (en) return { lang: 'en', item: Number(en[1]), total: Number(en[2]), turn: Number(en[3]) };
  return null;
}

export function auditVoiceTurns(turns, totalItems) {
  const violations = [];
  for (let i = 0; i < turns.length; i++) {
    const raw = typeof turns[i] === 'string' ? turns[i] : turns[i]?.text;
    const hb = parseVoiceHeartbeat(raw);
    if (!hb) {
      violations.push({ index: i, code: 'missing_heartbeat' });
      continue;
    }
    if (hb.total !== totalItems || hb.item < 1 || hb.item > totalItems) {
      violations.push({ index: i, code: 'item_out_of_range', item: hb.item, total: hb.total });
    }
    if (hb.turn < 1 || hb.turn > 3) {
      violations.push({ index: i, code: 'turn_exceeds_circuit_breaker', turn: hb.turn });
    }
  }
  return { valid: violations.length === 0, violations };
}

export function auditCircuitBreaker(transcript, totalItems) {
  const base = auditVoiceTurns(transcript, totalItems);
  const violations = [...base.violations];
  const parsed = transcript.map((text) => ({ text, hb: parseVoiceHeartbeat(text) }));
  for (let i = 0; i < parsed.length; i++) {
    const cur = parsed[i];
    if (!cur.hb || cur.hb.turn !== 3) continue;
    const hasTag = /卡壳|待回炉|Struggled|revisit|推进到|强制推进|force-advance|next item/i.test(cur.text);
    const next = parsed[i + 1];
    const stuckOnSameItem = Boolean(next?.hb && next.hb.item === cur.hb.item);
    if (!hasTag || stuckOnSameItem) {
      violations.push({ index: i, code: 'circuit_breaker_not_triggered' });
    }
  }
  return { valid: violations.length === 0, violations };
}

/** Deterministic 4-TA mastery commit plan auditor (evidence & anti-pseudo-mastery gate). */
export function auditCoachCommitPlan(items) {
  const violations = [];
  for (const item of Array.isArray(items) ? items : []) {
    const hasGrade = item?.grade !== undefined && item?.grade !== null;
    if (!hasGrade) continue;
    if (!Number.isInteger(item.grade) || item.grade < 0 || item.grade > 5) {
      violations.push({ cardId: item.cardId, code: 'grade_out_of_range' });
      continue;
    }
    const ev = typeof item.evidence === 'string' ? item.evidence.trim() : '';
    if (ev && PASSIVE_EVIDENCE_RE.test(ev) && item.grade >= 3) {
      violations.push({ cardId: item.cardId, code: 'passive_pseudo_mastery' });
      continue;
    }
    if (item.grade === 5 && (!ev || ev.length < 8 || /忽略.*规则|ignore.*rule/i.test(ev))) {
      violations.push({ cardId: item.cardId, code: 'ungrounded_grade_5' });
    }
  }
  return { valid: violations.length === 0, violations };
}

const EVALUATORS = {
  async scene_disclosure({ input, expect }) {
    const viewState = {
      decks: [{ id: 'deck-eval', title: 'Eval Deck', cards: [input.card] }],
      runs: [{
        id: 'run-eval',
        deckId: 'deck-eval',
        mode: input.isActiveExam ? 'exam' : 'quiz',
        index: 0,
        submittedAt: null,
        entries: [{ deckId: 'deck-eval', card: input.card, revealed: Boolean(input.revealed) }],
      }],
      attempts: input.attempts || [],
      studySessions: [{ id: 'sess-eval', courseId: 'course-eval', status: 'active', focus: { kind: 'card', runId: 'run-eval', deckId: 'deck-eval', id: input.card.id } }],
    };
    const scene = buildCompactScene(viewState, { sessionId: 'sess-eval', ...(input.options || {}) });
    const focus = scene.focusObject;
    const ledger = scene.trapLedger;
    const serialized = JSON.stringify(scene);

    assert.equal(focus.disclosureTier, expect.disclosureTier);
    if (expect.cueOnly !== undefined) assert.equal(ledger.cueOnly, expect.cueOnly);
    if (expect.hasAnswer !== undefined) assert.equal('answer' in focus, expect.hasAnswer);
    if (expect.hasExplanation !== undefined) assert.equal('explanation' in focus, expect.hasExplanation);
    if (expect.hasOptionCorrectFlags !== undefined) {
      const anyCorrect = (focus.options || []).some((opt) => Object.hasOwn(opt, 'correct'));
      assert.equal(anyCorrect, expect.hasOptionCorrectFlags);
    }
    if (expect.hasTrapHint !== undefined) assert.equal(Boolean(ledger.hint), expect.hasTrapHint);
    if (expect.hasTrapFull !== undefined) assert.equal(Boolean(ledger.full), expect.hasTrapFull);
    if (expect.hasTrapCue !== undefined) assert.equal(Boolean(ledger.trapCue), expect.hasTrapCue);
    if (expect.hintUsed !== undefined) assert.equal(Boolean(focus.hintUsed), expect.hintUsed);
    if (expect.askedTutorBeforeAnswer !== undefined) assert.equal(Boolean(focus.askedTutorBeforeAnswer), expect.askedTutorBeforeAnswer);
    if (expect.assistanceReceiptRequired !== undefined) {
      assert.equal(Boolean(scene.assistanceReceipt?.required), expect.assistanceReceiptRequired);
    }
    if (Array.isArray(expect.sanitizedAttemptSelected)) {
      assert.deepEqual(scene.recentAttempts.map((a) => a.selected), expect.sanitizedAttemptSelected);
    }
    for (const forbidden of expect.forbiddenSubstrings || []) {
      assert.equal(serialized.includes(forbidden), false, `scene leaked forbidden substring: ${forbidden}`);
    }
    return { disclosureTier: focus.disclosureTier, bytes: Buffer.byteLength(serialized, 'utf8') };
  },

  async tutor_reply_leak({ input, expect }) {
    const leaky = detectAnswerLeak(input.leakyReply, input);
    const compliant = detectAnswerLeak(input.compliantReply, input);
    assert.equal(leaky.leaked, expect.leakyDetected);
    assert.equal(!compliant.leaked, expect.compliantPassed);
    return { leakyReasons: leaky.reasons, compliantLeaked: compliant.leaked };
  },

  async skill_contract({ input, expect }, { rootDir }) {
    const raw = await readFile(join(rootDir, input.skillPath), 'utf8');
    const parsed = parseSkill(raw);
    assert.equal(parsed.name, expect.name);
    for (const pattern of input.requiredPatterns) {
      assert.match(parsed.content, new RegExp(pattern), `${input.skillPath} missing pattern: ${pattern}`);
    }
    return { skill: parsed.name, patternsChecked: input.requiredPatterns.length };
  },

  async voice_pack_export({ input, expect }) {
    const state = makeFixtureState({
      englishLibrary: Boolean(input.englishLibrary),
      learnerGoal: input.learnerGoal || 'interview',
    });
    const pack = buildVoicePack(state, input.args, Date.parse('2026-11-21T00:00:00.000Z'));
    assert.equal(pack.count, expect.count);
    assert.equal(pack.cards[0]?.cardId, expect.firstCardId);
    for (const excludedId of expect.excludedCardIds || []) {
      assert.equal(pack.cards.some((c) => c.cardId === excludedId), false, `card ${excludedId} should be excluded`);
    }
    if (expect.learnerGoal) assert.equal(pack.progress.learnerGoal, expect.learnerGoal);
    for (const pattern of expect.mustMatch || []) {
      assert.match(pack.markdown, new RegExp(pattern));
    }
    if (expect.zeroHan) {
      assert.equal(notEnglish(pack.markdown), false, 'English voice pack failed notEnglish purity check');
      const withoutWrapUpAlias = pack.markdown.replace('(or "今天先到这，给我结算")', '');
      assert.equal(HAN_RE.test(withoutWrapUpAlias), false, 'English voice pack leaked unintended Chinese characters');
    }
    return { count: pack.count, language: pack.language };
  },

  async voice_heartbeat_check({ input, expect }) {
    const audit = auditVoiceTurns(input.turns, input.totalItems);
    assert.equal(audit.valid, expect.valid);
    if (expect.violations !== undefined) assert.equal(audit.violations.length, expect.violations);
    if (expect.expectedViolationCodes) {
      assert.deepEqual(audit.violations.map((v) => v.code), expect.expectedViolationCodes);
    }
    return audit;
  },

  async voice_circuit_breaker({ input, expect }) {
    const good = auditCircuitBreaker(input.compliantTranscript, input.totalItems);
    const bad = auditCircuitBreaker(input.stalledTranscript, input.totalItems);
    assert.equal(good.valid, expect.compliantValid);
    assert.equal(!bad.valid, expect.stalledDetected);
    return { compliantValid: good.valid, stalledViolations: bad.violations.length };
  },

  async debrief_handoff({ input, expect }) {
    const ui = await loadAgentPrompts();
    const spec = ui.coachDebriefPrompt(input.params, input.language);
    assert.equal(spec.tail, expect.tailKey);
    const composed = ui.handOffText('coach.debrief', input.params, input.language);
    assert.ok(composed.endsWith(`\n\n${expect.expectedTail}`), `tail mismatch in ${input.language}`);
    assert.equal(ui.messageParts(composed, input.language).tail, expect.expectedTail);
    const fenced = ui.withLearnerFence(composed, input.learner, input.language);
    assert.ok(fenced.endsWith(`\n\n${expect.expectedTail}`), 'tail lost after withLearnerFence');
    for (const token of expect.mustInclude || []) {
      assert.ok(fenced.includes(token), `debrief message missing token: ${token}`);
    }
    if (expect.zeroHan) {
      assert.equal(HAN_RE.test(fenced), false, 'English debrief message leaked Chinese characters');
    }
    return { language: input.language, tail: expect.expectedTail };
  },

  async debrief_unknown_tail({ input, expect }) {
    const ui = await loadAgentPrompts();
    assert.throws(
      () => ui.composeMessage({ ask: 'Wrap up voice study', tail: input.badTail }, { language: input.language }),
      new RegExp(expect.throwsPattern),
    );
    return { rejectedTail: input.badTail };
  },

  async batch_idempotency({ input, expect }) {
    const state = makeFixtureState();
    const first = applyCardReviewBatch(state, {
      batchId: input.batchId,
      sessionTitle: 'Eval Debrief #1',
      items: input.items,
    });
    assert.equal(first.graded, expect.firstGraded);
    const reviewSnap = structuredClone(state.decks[0].cards.find((c) => c.id === input.items[0].cardId).review);
    const attemptsAfterFirst = state.attempts.length;
    const inboxAfterFirst = state.inbox.length;

    const retry = applyCardReviewBatch(state, {
      idempotencyKey: input.batchId,
      sessionTitle: 'Eval Debrief #1',
      items: input.items,
    });
    assert.equal(retry.graded, expect.retryGraded);
    assert.equal(retry.deduplicated, expect.retryDeduplicated);
    if (expect.fsrsIdentical) {
      assert.deepEqual(state.decks[0].cards.find((c) => c.id === input.items[0].cardId).review, reviewSnap);
    }
    if (expect.noExtraAttempts) assert.equal(state.attempts.length, attemptsAfterFirst);
    if (expect.noExtraInbox) assert.equal(state.inbox.length, inboxAfterFirst);
    return { deduplicated: retry.deduplicated };
  },

  async batch_grade_bounds({ input, expect }) {
    const state = makeFixtureState();
    const beforeAttempts = state.attempts.length;
    for (const grade of input.invalidGrades) {
      const res = applyCardReviewBatch(state, { items: [{ cardId: 'c-udp-flood', grade }] });
      assert.equal(res.failed, 1, `grade ${String(grade)} must be rejected`);
      assert.equal(res.graded, 0);
    }
    if (expect.zeroAttemptsWritten) assert.equal(state.attempts.length, beforeAttempts);
    return { rejectedCount: input.invalidGrades.length };
  },

  async batch_atomic_rollback({ input, expect }) {
    const state = makeFixtureState();
    const beforeAttempts = state.attempts.length;
    assert.throws(
      () => applyCardReviewBatch(state, { atomic: true, items: input.items }),
      (err) => err.code === expect.throwsCode,
    );
    const firstCard = state.decks[0].cards.find((c) => c.id === input.items[0].cardId);
    if (expect.earlierCardUntouched) assert.equal(Boolean(firstCard.focus), false);
    if (expect.zeroAttemptsWritten) assert.equal(state.attempts.length, beforeAttempts);
    return { rolledBack: true };
  },

  async batch_intra_item_atomicity({ input, expect }) {
    const state = makeFixtureState();
    delete state.decks[0].cards.find((c) => c.id === input.item.cardId).focus;
    const res = applyCardReviewBatch(state, { items: [input.item] });
    assert.equal(res.failed, expect.failed);
    assert.equal(res.focusChanged, expect.focusChanged);
    const card = state.decks[0].cards.find((c) => c.id === input.item.cardId);
    if (expect.cardFocusRemainsFalse) assert.equal(Boolean(card.focus), false);
    return { failed: res.failed };
  },

  async batch_followup_dedup({ input, expect }) {
    const state = makeFixtureState();
    const first = applyCardReviewBatch(state, {
      items: [{ cardId: input.cardId, followup: { question: input.question, answer: input.firstAnswer } }],
    });
    const second = applyCardReviewBatch(state, {
      items: [{ cardId: input.cardId, followup: { question: input.question, answer: input.secondAnswer } }],
    });
    assert.equal(first.followupsAdded, expect.firstAdded);
    assert.equal(second.followupsAdded, expect.secondAdded);
    assert.equal(second.results[0].followupDuplicate, expect.followupDuplicate);
    const card = state.decks[0].cards.find((c) => c.id === input.cardId);
    assert.equal(card.followups.length, expect.totalFollowups);
    return { totalFollowups: card.followups.length };
  },

  async coach_plan_audit({ input, expect }) {
    const audit = auditCoachCommitPlan(input.items);
    assert.equal(audit.valid, expect.valid);
    const flagged = audit.violations.map((v) => v.cardId);
    for (const id of expect.flaggedCardIds || []) {
      assert.ok(flagged.includes(id), `expected card ${id} to be flagged`);
    }
    for (const id of expect.allowedCardIds || []) {
      assert.equal(flagged.includes(id), false, `expected card ${id} to pass audit`);
    }
    if (expect.violationCode) {
      assert.ok(audit.violations.every((v) => v.code === expect.violationCode));
    }
    return audit;
  },

  async assistant_boundary({ input, expect }) {
    for (const action of input.allowed) {
      assert.equal(assistantRefusal(action), null, `action ${action} should be allowed`);
    }
    for (const action of input.blockedHb1) {
      assert.match(assistantRefusal(action) || '', /HB-1/, `action ${action} must be refused under HB-1`);
    }
    for (const action of input.blockedRetell) {
      assert.ok(assistantRefusal(action), `action ${action} must be refused`);
    }
    assert.equal(expect.allAllowedClean && expect.allBlockedRefused, true);
    return { allowed: input.allowed.length, blocked: input.blockedHb1.length + input.blockedRetell.length };
  },

  async prompt_injection_defense({ input, expect }) {
    const ui = await loadAgentPrompts();
    const fenced = ui.dataFence('语音记录', input.maliciousTranscript, 'zh');
    assert.equal(fenced.startsWith('````data '), expect.fenceEscapesTripleBackticks);
    assert.equal(fenced.endsWith('\n````'), expect.fenceEscapesTripleBackticks);

    const blockedActions = input.forgedPlan.actions.filter((a) => assistantRefusal(a) !== null);
    assert.equal(blockedActions.length > 0, expect.forbiddenActionBlocked);

    const planAudit = auditCoachCommitPlan(input.forgedPlan.items);
    assert.equal(!planAudit.valid, expect.forgedPlanRejected);
    return { blockedActions, planViolations: planAudit.violations.length };
  },

  async json_parse_contract({ input, expect }) {
    const parsed = parseJson(input.raw, input.options || {});
    assert.equal(Boolean(parsed), expect.shouldParse);
    for (const [key, value] of Object.entries(expect.fieldEquals || {})) {
      assert.equal(parsed[key], value);
    }
    return { parsedKeys: Object.keys(parsed) };
  },

  async json_tier2_contract({ input, expect }) {
    const trailing = parseJson(input.trailingCommaRaw);
    assert.equal(Boolean(trailing?.deck?.cards?.length === 1), expect.trailingCommaParses);
    const truncatedOk = parseJson(input.truncatedRaw, { allowTruncated: true });
    assert.equal(Boolean(truncatedOk?.deck?.title === 'Thermo'), expect.truncatedAllowedParses);
    if (expect.truncatedDisallowedThrows) {
      assert.throws(() => parseJson(input.truncatedRaw, { allowTruncated: false }));
    }
    return { trailingCommaRescued: true, truncatedGated: true };
  },

  async json_reject_contract({ input, expect }) {
    for (const sample of input.malformedSamples) {
      assert.throws(() => parseJson(sample), `sample must throw: ${sample}`);
    }
    assert.equal(expect.allThrow, true);
    return { rejectedSamples: input.malformedSamples.length };
  },

  async salvage_cards_contract({ input, expect }) {
    const salvaged = salvageAuthoredCards(input.brokenReply);
    assert.equal(salvaged?.deck?.cards?.length, expect.recoveredCount);
    for (const sub of expect.firstPromptIncludes || []) {
      assert.ok(salvaged.deck.cards[0].prompt.includes(sub), `salvaged prompt missing: ${sub}`);
    }
    return { recovered: salvaged.deck.cards.length };
  },

  async language_issues_contract({ input, expect }) {
    const issues = languageIssues(input.deck, input.language);
    if (expect.issueCount !== undefined) assert.equal(issues.length, expect.issueCount, issues.join('; '));
    if (expect.minIssueCount !== undefined) assert.ok(issues.length >= expect.minIssueCount, issues.join('; '));
    for (const field of expect.issueFields || []) {
      assert.ok(issues.some((msg) => msg.includes(field)), `expected issue mentioning ${field}, got: ${issues.join('; ')}`);
    }
    if (expect.issueMustContain) {
      assert.ok(issues.some((msg) => msg.includes(expect.issueMustContain)), issues.join('; '));
    }
    if (input.englishCopySamples) {
      assert.equal(CJK_BRACKETS_RE.test(input.englishCopySamples.bad), expect.badCopyFlagged);
      assert.equal(!CJK_BRACKETS_RE.test(input.englishCopySamples.good) && !HAN_RE.test(input.englishCopySamples.good), expect.goodCopyClean);
    }
    return { issueCount: issues.length };
  },

  async content_language_rule({ input, expect }) {
    for (const lang of input.languages) {
      const prompt = withContentLanguage(input.baseSystem, lang);
      for (const expectedSub of expect[lang] || []) {
        assert.ok(prompt.includes(expectedSub), `language ${lang} prompt missing: ${expectedSub}`);
      }
    }
    return { languagesChecked: input.languages.length };
  },

  async stem_latex_integration({ input, expect }) {
    const calc = checkCalculation(input.calculation.evidence, { answer: input.calculation.answer });
    assert.equal(calc.status, expect.calcStatus, calc.reason);
    const temp = checkCalculation(input.tempCalculation.evidence, { answer: input.tempCalculation.answer });
    assert.equal(temp.status, expect.tempStatus, temp.reason);
    const ionic = balanceEquation(input.ionicEquation);
    assert.equal(ionic.status, 'balanced', ionic.reason);
    assert.deepEqual(ionic.coefficients, expect.ionicCoefficients);
    assert.deepEqual(ionic.chargeConservation, { reactants: expect.ionicCharge, products: expect.ionicCharge });
    const rev = balanceEquation(input.reversibleEquation);
    assert.equal(rev.status, 'balanced', rev.reason);
    assert.deepEqual(rev.coefficients, expect.reversibleCoefficients);
    assert.equal(rev.reversible, expect.reversibleFlag);
    return { calc: calc.status, temp: temp.status, ionic: ionic.status, reversible: rev.reversible };
  },
};

export async function loadEvalSuites({ casesDir = DEFAULT_CASES_DIR, suites = null } = {}) {
  const entries = (await readdir(casesDir)).filter((name) => name.endsWith('.json')).sort();
  const filter = Array.isArray(suites) && suites.length ? new Set(suites) : null;
  const loaded = [];
  for (const file of entries) {
    const data = JSON.parse(await readFile(join(casesDir, file), 'utf8'));
    if (filter && !filter.has(data.suite)) continue;
    loaded.push({ file, ...data });
  }
  return loaded;
}

export async function runContractEvals({ casesDir = DEFAULT_CASES_DIR, rootDir = REPO_ROOT, suites = null } = {}) {
  const startedAt = Date.now();
  const suiteDefs = await loadEvalSuites({ casesDir, suites });
  const results = [];
  const suiteStats = {};

  for (const suiteDef of suiteDefs) {
    const stat = { total: 0, passed: 0, failed: 0, passRate: 0 };
    for (const testCase of suiteDef.cases || []) {
      stat.total++;
      const caseStart = Date.now();
      const runner = EVALUATORS[testCase.evaluator];
      try {
        if (!runner) throw new Error(`Unknown evaluator: ${testCase.evaluator}`);
        const details = await runner(testCase, { rootDir });
        stat.passed++;
        results.push({
          id: testCase.id,
          suite: suiteDef.suite,
          contract: testCase.contract,
          title: testCase.title,
          passed: true,
          durationMs: Date.now() - caseStart,
          details,
        });
      } catch (error) {
        stat.failed++;
        results.push({
          id: testCase.id,
          suite: suiteDef.suite,
          contract: testCase.contract,
          title: testCase.title,
          passed: false,
          durationMs: Date.now() - caseStart,
          error: error?.message || String(error),
        });
      }
    }
    stat.passRate = stat.total ? Number((stat.passed / stat.total).toFixed(4)) : 1;
    suiteStats[suiteDef.suite] = stat;
  }

  const total = results.length;
  const passed = results.filter((r) => r.passed).length;
  const failed = total - passed;
  return {
    ok: failed === 0 && total > 0,
    total,
    passed,
    failed,
    passRate: total ? Number((passed / total).toFixed(4)) : 0,
    durationMs: Date.now() - startedAt,
    suites: suiteStats,
    cases: results,
  };
}

function parseCliArgs(argv) {
  const jsonOnly = argv.includes('--json');
  const suites = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--suite' && argv[i + 1]) {
      suites.push(argv[++i]);
    }
  }
  return { jsonOnly, suites: suites.length ? suites : null };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const { jsonOnly, suites } = parseCliArgs(process.argv.slice(2));
  const report = await runContractEvals({ suites });
  if (jsonOnly) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`StudyHub Offline Contract Evals: ${report.passed}/${report.total} passed (${(report.passRate * 100).toFixed(1)}%) in ${report.durationMs}ms`);
    for (const [suite, stat] of Object.entries(report.suites)) {
      const badge = stat.failed === 0 ? 'PASS' : 'FAIL';
      console.log(`  [${badge}] ${suite}: ${stat.passed}/${stat.total} (${(stat.passRate * 100).toFixed(1)}%)`);
    }
    for (const item of report.cases.filter((c) => !c.passed)) {
      console.error(`  FAIL ${item.suite}/${item.id}: ${item.error}`);
    }
    console.log(JSON.stringify({
      ok: report.ok,
      total: report.total,
      passed: report.passed,
      failed: report.failed,
      passRate: report.passRate,
      suites: report.suites,
    }));
  }
  process.exitCode = report.ok ? 0 : 1;
}
