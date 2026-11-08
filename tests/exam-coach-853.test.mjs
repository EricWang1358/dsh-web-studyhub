import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  cognitiveLevel,
  isSurfaceApplicationOnly,
  preservesOpenTaskForm,
  variantContractMeta,
  variantKind,
  writeVariants,
} from "../lib/coach.js";
import {
  analyzeAssessmentModes,
  compileCoachGenerationRequest,
  composeStrictMockPaper,
  computeCoachEvidence,
  computeCoachSpecVersion,
  confirmCalibrationFamily,
  detectCalibrationDefects,
  diagnoseChoiceAttempt,
  isFamilyCalibrated,
  isNearDuplicateOfExposedSample,
  normalizeTaskFamily,
  projectCoachSpecForView,
  saveCoachSpec,
  stemSimilarity,
} from "../lib/exam-coach.js";
import { StudyService } from "../lib/service.js";
import { createFakeModel } from "../scripts/fake-model.mjs";

test("#853 open/task variants preserve open/hands-on form by default and mark too-hard / explicit downgrade as non-qualifying", async () => {
  const openCard = {
    id: "open-1",
    kind: "open",
    topic: "事务隔离级别",
    objective: "分步推导幻读发生条件与加锁范围",
    prompt: "给定可重复读隔离级别与范围更新语句，请分步推导为何仍可能出现当前读异常并给出修复方案。",
    answer: "第1步区分快照读与当前读；第2步指出临键锁边界；第3步给出显式加锁或串行化条件。",
    rubric: "1. 区分快照读与当前读（4分）；2. 说明临键锁范围（3分）；3. 给出修复方案（3分）。",
    hint: "区分快照读与当前读语句。",
    misconception: "误以为可重复读在任何更新语句下都只看初始快照而不会触发当前读加锁",
    explanation: "考察多步并发时序推导。",
    citations: [{ sourceId: "s1", quote: "可重复读隔离级别下快照读与当前读的锁边界不同" }],
    taskFamilyId: "multi-step-derivation",
    coachSpecVersion: "coach-v1-abc123",
  };
  const taskCard = {
    ...openCard,
    id: "task-1",
    kind: "task",
  };

  assert.equal(preservesOpenTaskForm(openCard), true);
  assert.equal(preservesOpenTaskForm(taskCard), true);
  assert.equal(preservesOpenTaskForm({ kind: "quiz" }), false);

  // Wrong / application-gap / too-easy keep open & task form instead of silently converting to quiz
  assert.equal(variantKind("wrong", openCard), "open");
  assert.equal(variantKind("application-gap", openCard), "open");
  assert.equal(variantKind("too-easy", taskCard), "task");
  assert.deepEqual(variantContractMeta("wrong", openCard, "open"), {
    purpose: "transfer-variant",
    countsForOriginalTask: true,
    originalKind: "open",
  });

  // Explicit opt-in downgrade produces a quiz drill that NEVER counts as passing the original open task
  const downgradedKind = variantKind("wrong", openCard, { allowFormDowngrade: true });
  assert.equal(downgradedKind, "quiz");
  assert.deepEqual(variantContractMeta("wrong", openCard, downgradedKind), {
    purpose: "form-downgraded-drill",
    downgradedFromKind: "open",
    countsForOriginalTask: false,
    originalKind: "open",
  });

  // `too-hard` produces a prerequisite flashcard scaffold that NEVER counts as original task mastery
  const scaffoldKind = variantKind("too-hard", openCard);
  assert.equal(scaffoldKind, "flashcard");
  assert.deepEqual(variantContractMeta("too-hard", openCard, scaffoldKind), {
    purpose: "foundation-scaffold",
    countsForOriginalTask: false,
    originalKind: "open",
  });

  // writeVariants produces valid open/task cards with rubric & taskFamilyId inheritance
  const sources = [{
    id: "s1",
    title: "并发控制讲义",
    text: "可重复读隔离级别下快照读与当前读的锁边界不同，更新未命中索引记录时会升级锁范围。",
  }];
  const fakeComplete = async (_sys, userPrompt) => {
    assert.match(userPrompt, /保持开放作答\/实操要求，不要改为选择题/);
    return JSON.stringify({
      cards: [{
        target: 0,
        kind: "open",
        topic: "事务隔离级别",
        objective: "分步推导范围更新下的当前读加锁边界",
        prompt: "当事务 A 读取快照后执行范围更新，事务 B 插入临界记录，请分步推导两者的可见性与锁等待顺序。",
        answer: "1. 事务 A 快照读不见新行；2. 当前读触发临键锁等待或覆盖；3. 给出索引条件约束。",
        rubric: "1. 写出快照版本可见性（4分）；2. 推导当前读加锁顺序（4分）；3. 给出边界验证结论（2分）。",
        hint: "先区分 MVCC 快照读与当前读语句。",
        explanation: "检验在同一考点新时序下的分步推导能力。",
        citations: [{ sourceId: "s1", quote: "可重复读隔离级别下快照读与当前读的锁边界不同" }],
      }],
    });
  };
  const written = await writeVariants(fakeComplete, {
    targets: [{ card: openCard, reason: "wrong", kind: "open" }],
    sources,
    learner: {},
  });
  assert.equal(written.length, 1);
  assert.equal(written[0].card.kind, "open");
  assert.equal(written[0].card.options, undefined);
  assert.match(written[0].card.rubric, /4分/);
  assert.equal(written[0].card.variantMeta.countsForOriginalTask, true);
  assert.equal(written[0].card.taskFamilyId, "multi-step-derivation");
  assert.equal(written[0].card.coachSpecVersion, "coach-v1-abc123");
});

test("#853 counterexample: surface framing words ('某公司') and 100% recall cards never inflate complex task coverage or readiness", () => {
  const surfaceCard = {
    id: "surface-1",
    kind: "quiz",
    topic: "网络协议",
    prompt: "在某公司的生产环境中，TCP 的全称是什么？",
    options: [
      { id: "a", text: "Transmission Control Protocol", correct: true, explanation: "TCP 标准全称。" },
      { id: "b", text: "Transfer Channel Protocol", correct: false, explanation: "伪造名称。" },
      { id: "c", text: "Transport Core Packet", correct: false, explanation: "伪造名称。" },
    ],
    answer: "Transmission Control Protocol",
    explanation: "基础术语全称。",
    citations: [{ sourceId: "src-net", quote: "TCP（Transmission Control Protocol）提供面向连接的可靠字节流服务。" }],
    review: { reps: 8, interval: 21, stability: 21 },
  };
  const recallFlashcard = {
    id: "flash-1",
    kind: "flashcard",
    topic: "拥塞控制",
    prompt: "慢启动阈值 ssthresh 的定义是什么？",
    answer: "区分慢启动指数增长与拥塞避免线性增长的窗口阈值。",
    explanation: "基础概念记忆。",
    citations: [{ sourceId: "src-net", quote: "慢启动阈值 ssthresh 用于区分慢启动与拥塞避免阶段。" }],
    review: { reps: 10, interval: 30, stability: 30 },
  };

  // Even though legacy lightweight `cognitiveLevel` matches "某公司" as 'apply', `isSurfaceApplicationOnly` catches it!
  assert.equal(cognitiveLevel(surfaceCard), "apply");
  assert.equal(isSurfaceApplicationOnly(surfaceCard), true);

  const state = {
    sources: [{
      id: "src-net",
      course: "计算机网络",
      title: "传输层协议",
      text: "# 网络协议\nTCP（Transmission Control Protocol）提供面向连接的可靠字节流服务。\n# 拥塞控制\n慢启动阈值 ssthresh 用于区分慢启动与拥塞避免阶段。",
    }],
    decks: [{
      id: "deck-net",
      course: "计算机网络",
      title: "传输层记忆题",
      cards: [surfaceCard, recallFlashcard],
    }],
    attempts: [
      {
        quiz_id: "surface-1",
        deckId: "deck-net",
        correct: true,
        grade: 5,
        elapsed_ms: 15000,
        timestamp: "2026-10-01T10:00:00.000Z",
      },
      {
        quiz_id: "flash-1",
        deckId: "deck-net",
        assessment: "self",
        grade: 5,
        elapsed_ms: 8000,
        timestamp: "2026-10-01T10:02:00.000Z",
      },
    ],
  };

  const spec = {
    course: "计算机网络",
    taskFamilies: [
      normalizeTaskFamily({
        id: "congestion-derivation",
        title: "拥塞控制：窗口演化多步推导",
        knowledgePoints: ["网络协议", "拥塞控制"],
        primaryFormat: "open",
        allowedFormats: ["open"],
        allowFormSubstitute: false,
        reasoningSteps: ["确定初始 cwnd 与 ssthresh", "按 RTT 逐步推导超时或三重复 ACK 后的窗口值"],
        rubricPoints: [{ criterion: "每轮 RTT 窗口计算正确", marks: 6, condition: "写出慢启动与拥塞避免切换点" }],
        quota: 2,
      }),
    ],
  };

  const ev = computeCoachEvidence(state, { course: "计算机网络", spec });
  // Material coverage is 100% (2/2 sections touched) and review familiarity is high...
  assert.equal(ev.materialCoverage.coveredSections, 2);
  assert.equal(ev.materialCoverage.totalSections, 2);
  assert.equal(ev.materialCoverage.ratio, 1);
  assert.equal(ev.materialCoverage.recallOnlyCardCount, 1);
  assert.equal(ev.materialCoverage.surfaceApplicationCardCount, 1);
  assert.equal(ev.capabilityEvidence.reviewFamiliarity.highStabilityCards, 2);

  // ...yet training coverage for the complex derivation family is 0 and independent capability readiness is strictly FALSE!
  assert.equal(ev.trainingCoverage.generated, 0);
  assert.equal(ev.trainingCoverage.excludedScaffoldOrDowngradeCount, 2);
  assert.equal(ev.capabilityEvidence.unseenIndependentPassCount, 0);
  assert.equal(ev.capabilityEvidence.readyForExam, false);
  assert.match(ev.capabilityEvidence.verdict, /不能把记忆卡掌握度当考试准备度/);
});

test("#853 stable option.id misconception diagnosis survives option shuffling and distinguishes single-mistake hypothesis from recurring pattern", () => {
  const sample = {
    id: "s-choice",
    options: [
      { id: "opt-ok", text: "先加锁再校验版本号", correct: true },
      { id: "opt-race", text: "先读无锁缓存再直接覆盖写入", correct: false, misconceptionId: "mis-check-then-act", misconceptionReason: "忽略并发窗口内的状态变更" },
      { id: "opt-dead", text: "按任意顺序分别获取两把互斥锁", correct: false, misconceptionId: "mis-lock-order", misconceptionReason: "未固定全局加锁顺序导致循环等待" },
    ],
  };

  const shuffled = {
    ...sample,
    options: [sample.options[2], sample.options[0], sample.options[1]],
  };

  // First mistake on `opt-race` -> candidate hypothesis only (`confirmedMisconception: false`)
  const firstDiag = diagnoseChoiceAttempt(sample, ["opt-race"], {});
  const shuffledFirstDiag = diagnoseChoiceAttempt(shuffled, ["opt-race"], {});
  assert.deepEqual(shuffledFirstDiag, firstDiag);
  assert.equal(firstDiag.isCorrect, false);
  assert.equal(firstDiag.hypothesisType, "candidate-hypothesis");
  assert.equal(firstDiag.confirmedMisconception, false);
  assert.equal(firstDiag.matchedMisconceptions[0].misconceptionId, "mis-check-then-act");
  assert.equal(firstDiag.matchedMisconceptions[0].occurrences, 1);

  // Second occurrence of the same misconception across items -> recurring pattern (`confirmedMisconception: true`)
  const secondDiag = diagnoseChoiceAttempt(shuffled, ["opt-race"], { "mis-check-then-act": 1 });
  assert.equal(secondDiag.hypothesisType, "recurring-pattern");
  assert.equal(secondDiag.confirmedMisconception, true);
  assert.equal(secondDiag.matchedMisconceptions[0].occurrences, 2);
});

test("#853 scope honesty, 3 independent confirmations, defect blocking, spec versioning, and irreversible sample-exposure guard", async () => {
  const state = {
    sources: [
      {
        id: "mat-1",
        course: "操作系统",
        title: "操作系统讲义",
        text: "# 进程调度\n最短剩余时间优先需要估计运行时间公式。\n# 虚拟内存置换\n缺页率推导与工作集窗口案例计算。\n# 文件系统日志\n崩溃恢复预写日志 WAL 幂等条件。",
      },
      {
        id: "ref-2025",
        course: "操作系统",
        title: "2025往年真题样卷",
        text: "一、选择题：进程调度与周转时间计算。\n二、计算大题：虚拟内存置换缺页率推导。",
      },
    ],
    decks: [
      {
        id: "deck-os",
        course: "操作系统",
        title: "OS 练习",
        cards: [
          {
            id: "card-near-dup",
            kind: "quiz",
            topic: "进程调度",
            prompt: "围绕「进程调度」，当约束条件发生变化时，下列哪一项判断严格成立？",
            options: [
              { id: "a", text: "满足前提", correct: true, explanation: "正确" },
              { id: "b", text: "忽略前提", correct: false, explanation: "错" },
              { id: "c", text: "混淆概念", correct: false, explanation: "错" },
            ],
            answer: "满足前提",
            explanation: "解析",
            citations: [{ sourceId: "mat-1", quote: "最短剩余时间优先需要估计运行时间公式。" }],
          },
        ],
      },
    ],
    learner: { solutionExposures: [] },
  };

  const analyzed = await analyzeAssessmentModes(state, {
    course: "操作系统",
    referenceSourceIds: ["ref-2025"],
  });
  assert.deepEqual(analyzed.scopeBoundary.samplePaperIds, ["ref-2025"]);
  assert.deepEqual(analyzed.scopeBoundary.materialSourceIds, ["mat-1"]);
  assert.ok(
    analyzed.scopeBoundary.uncoveredMaterialSections.some((sec) => sec.includes("文件系统日志")),
    `expected uncovered section '文件系统日志', got ${JSON.stringify(analyzed.scopeBoundary.uncoveredMaterialSections)}`,
  );

  // Unrevealed view redacts sample answer, rubric, and option.correct flags
  const projected0 = projectCoachSpecForView(analyzed);
  const fam0 = projected0.taskFamilies[0];
  assert.equal(fam0.sample.redacted, true);
  assert.equal(fam0.sample.answer, undefined);
  assert.equal(fam0.sample.options.some((o) => "correct" in o), false);
  assert.throws(
    () => compileCoachGenerationRequest(analyzed, state, { requireConfirmed: true }),
    /尚未完成三项校准确认/,
  );

  // Confirming appearanceApproved alone does NOT calibrate the family
  const step1 = confirmCalibrationFamily(analyzed, {
    familyId: fam0.id,
    appearanceApproved: true,
    learner: state.learner,
    state,
    now: "2026-10-02T09:00:00.000Z",
  });
  assert.equal(isFamilyCalibrated(step1.spec.taskFamilies[0], step1.spec.specVersion), false);

  // Vague rubric ("酌情给分") or unmapped distractor blocks `answerVerified: true`
  const vagueOpenFamily = normalizeTaskFamily({
    id: "vague-open",
    title: "模糊评分题",
    primaryFormat: "open",
    reasoningSteps: ["第一步分析"],
    rubricPoints: [{ criterion: "写对大概方向", marks: 5, condition: "言之有理酌情给分" }],
    sample: { format: "open", stem: "简述 WAL 作用。", answer: "保证原子性与持久性。", rubric: "言之有理即可酌情给分" },
  });
  const defects = detectCalibrationDefects(vagueOpenFamily);
  assert.ok(defects.some((d) => d.code === "vague-rubric"));
  const specWithVague = saveCoachSpec(step1.spec, { operations: [{ type: "add", family: vagueOpenFamily }] });
  assert.throws(
    () => confirmCalibrationFamily(specWithVague, { familyId: "vague-open", answerVerified: true }),
    /模糊/,
  );

  // Revealing sample solution records an immutable `sample-calibration` exposure receipt and marks near-duplicate cards exposed
  const revealed = confirmCalibrationFamily(step1.spec, {
    familyId: fam0.id,
    intentApproved: true,
    answerVerified: true,
    revealSampleSolution: true,
    learner: state.learner,
    state,
    now: "2026-10-02T09:05:00.000Z",
  });
  const v1 = revealed.spec.specVersion;
  assert.equal(isFamilyCalibrated(revealed.spec.taskFamilies[0], v1), true);
  assert.ok(revealed.exposureReceipt);
  assert.equal(revealed.exposureReceipt.source, "sample-calibration");
  assert.ok(revealed.exposureReceipt.cardIds.includes("card-near-dup"));
  assert.ok(stemSimilarity(fam0.sample.stem, "围绕进程调度，当约束条件发生变化时，下列哪一项判断严格成立？") >= 0.72);
  assert.equal(
    isNearDuplicateOfExposedSample(
      "围绕进程调度，当约束条件发生变化时，下列哪一项判断严格成立？",
      revealed.spec,
      "2026-10-02T10:00:00.000Z",
    ),
    true,
  );

  // Editing substantive reasoningSteps bumps `specVersion`, records `specHistory`, and invalidates `intentApproved` & `answerVerified` while keeping sample exposure!
  const editedFamilies = revealed.spec.taskFamilies.map((f, idx) =>
    idx === 0 ? { ...f, reasoningSteps: [...f.reasoningSteps, "补充检查饥饿边界条件"] } : f,
  );
  const savedV2 = saveCoachSpec(revealed.spec, { taskFamilies: editedFamilies }, { now: "2026-10-02T11:00:00.000Z" });
  assert.notEqual(savedV2.specVersion, v1);
  assert.equal(computeCoachSpecVersion(savedV2), savedV2.specVersion);
  assert.ok(savedV2.specHistory.some((h) => h.specVersion === v1));
  assert.equal(savedV2.taskFamilies[0].confirmations.appearanceApproved, true);
  assert.equal(savedV2.taskFamilies[0].confirmations.intentApproved, false);
  assert.equal(savedV2.taskFamilies[0].confirmations.answerVerified, false);
  assert.equal(savedV2.taskFamilies[0].confirmations.staleReason, "rules-updated");
  assert.equal(isFamilyCalibrated(savedV2.taskFamilies[0], savedV2.specVersion), false);
  assert.equal(savedV2.taskFamilies[0].sample.solutionRevealedAt, "2026-10-02T09:05:00.000Z");
});

test("#853 + #847 three-layer evidence rules: same-item repeat, exposed sample, >=12h delayed distinct transfer, timed budget, and legacy unknown honesty", () => {
  const spec = saveCoachSpec(
    { course: "算法设计" },
    {
      taskFamilies: [
        {
          id: "dp-invariant",
          title: "动态规划：状态转移与最优子结构证明",
          knowledgePoints: ["动态规划"],
          primaryFormat: "open",
          allowedFormats: ["open"],
          allowFormSubstitute: false,
          quota: 2,
          priority: "high",
          marksPerItem: 10,
          timeBudgetSec: 300,
          reasoningSteps: ["定义无后效性状态", "写出状态转移方程与边界初值"],
          rubricPoints: [
            { criterion: "状态定义无后效性", marks: 5, condition: "指明维度含义与约束" },
            { criterion: "转移方程与边界完整", marks: 5, condition: "覆盖初值与递推顺序" },
          ],
          sample: {
            format: "open",
            stem: "给定带冷却期的股票交易序列，定义无后效性状态并写出转移方程。",
            answer: "三维状态持有/冷冻/空仓。",
            rubric: "状态定义5分；转移方程与初值5分。",
            solutionRevealedAt: "2026-10-01T08:00:00.000Z",
          },
          confirmations: {
            appearanceApproved: true,
            intentApproved: true,
            answerVerified: true,
          },
        },
      ],
      exposedSampleStems: [
        {
          familyId: "dp-invariant",
          stem: "给定带冷却期的股票交易序列，定义无后效性状态并写出转移方程。",
          at: "2026-10-01T08:00:00.000Z",
          specVersion: "coach-v1-init",
        },
      ],
    },
  );

  const activeVersion = spec.specVersion;
  const makeOpenCard = (id, prompt, extra = {}) => ({
    id,
    kind: "open",
    topic: "动态规划",
    objective: `状态定义与转移推导-${id}`,
    prompt,
    answer: "先定义状态含义，再列转移方程并验证初值。",
    hint: "检查子问题是否满足无后效性。",
    misconception: "遗漏冷冻期或父子节点互斥状态维度",
    rubric: "1. 状态定义（5分）；2. 转移方程与初值（5分）。",
    explanation: "考察动态规划建模。",
    citations: [{ sourceId: "src-alg", quote: "动态规划要求子问题具备最优子结构与无后效性。" }],
    taskFamilyId: "dp-invariant",
    coachSpecVersion: activeVersion,
    ...extra,
  });

  const baseState = {
    sources: [{
      id: "src-alg",
      course: "算法设计",
      title: "动态规划讲义",
      text: "# 动态规划\n动态规划要求子问题具备最优子结构与无后效性。",
    }],
    decks: [{
      id: "deck-alg",
      course: "算法设计",
      title: "DP 专项",
      cards: [
        makeOpenCard("c-dup-sample", "给定带冷却期的股票交易序列，请定义无后效性状态并写出转移方程。"),
        makeOpenCard("c-old-ver", "给定背包容量与分组互斥约束，定义状态并推导转移方程。", { coachSpecVersion: "coach-v1-older" }),
        makeOpenCard("c-unseen-1", "给定区间合并代价矩阵，请定义区间状态并推导最小合并代价方程。"),
        makeOpenCard("c-unseen-2", "给定树形独立集权重约束，请定义父子节点状态并写出递推方程。"),
      ],
    }],
    learner: { solutionExposures: [] },
  };

  // Case A: Legacy attempts without `elapsed_ms` or `timestamp` report `unknown` instead of fabricating failure or pass!
  const legacyEv = computeCoachEvidence(
    {
      ...baseState,
      attempts: [
        {
          quiz_id: "c-unseen-1",
          deckId: "deck-alg",
          assessment: "rubric",
          score: 9,
          maxScore: 10,
          grade: 5,
        },
      ],
    },
    { course: "算法设计", spec },
  );
  assert.equal(legacyEv.trainingCoverage.verifiedUsable, 3);
  assert.equal(legacyEv.trainingCoverage.practiced, 1);
  assert.equal(legacyEv.trainingCoverage.outdatedVersionCardCount, 1);
  assert.equal(legacyEv.capabilityEvidence.unseenIndependentPassCount, 1);
  assert.equal(legacyEv.capabilityEvidence.delayedIndependent.status, "unknown");
  assert.equal(legacyEv.capabilityEvidence.timedIndependent.status, "unknown");
  assert.equal(legacyEv.capabilityEvidence.readyForExam, false);

  // Case B: Full sequence with exposed near-duplicate, same-item repeat, initial unseen pass, and >=12h delayed unseen transfer within time budget
  const fullEv = computeCoachEvidence(
    {
      ...baseState,
      attempts: [
        // 1. Near-duplicate of revealed calibration sample -> counted as assisted/exposed, NOT unseen!
        {
          quiz_id: "c-dup-sample",
          deckId: "deck-alg",
          assessment: "rubric",
          score: 9,
          maxScore: 10,
          grade: 5,
          elapsed_ms: 120000,
          timestamp: "2026-10-01T09:00:00.000Z",
        },
        // 2. First unseen independent pass on c-unseen-1 within 300s budget
        {
          quiz_id: "c-unseen-1",
          deckId: "deck-alg",
          assessment: "rubric",
          score: 9,
          maxScore: 10,
          grade: 5,
          elapsed_ms: 210000,
          timestamp: "2026-10-01T09:30:00.000Z",
        },
        // 3. Same-item repeat 16h later on c-unseen-1 -> counted as sameItemRepeat, does NOT satisfy delayed distinct transfer!
        {
          quiz_id: "c-unseen-1",
          deckId: "deck-alg",
          assessment: "rubric",
          score: 10,
          maxScore: 10,
          grade: 5,
          elapsed_ms: 150000,
          timestamp: "2026-10-02T01:30:00.000Z",
        },
      ],
    },
    { course: "算法设计", spec },
  );
  assert.equal(fullEv.capabilityEvidence.assistedOrExposedCount, 1);
  assert.equal(fullEv.capabilityEvidence.sameItemRepeatCount, 1);
  assert.equal(fullEv.capabilityEvidence.unseenIndependentPassCount, 1);
  assert.equal(fullEv.capabilityEvidence.delayedIndependent.passedFamilyCount, 0);
  assert.equal(fullEv.capabilityEvidence.readyForExam, false);

  // 4. Now add a distinct unseen transfer item (`c-unseen-2`) >= 12h after first family activity, within 300s budget -> readyForExam becomes true!
  const readyEv = computeCoachEvidence(
    {
      ...baseState,
      attempts: [
        {
          quiz_id: "c-unseen-1",
          deckId: "deck-alg",
          assessment: "rubric",
          score: 9,
          maxScore: 10,
          grade: 5,
          elapsed_ms: 210000,
          timestamp: "2026-10-01T09:30:00.000Z",
        },
        {
          quiz_id: "c-unseen-2",
          deckId: "deck-alg",
          assessment: "rubric",
          score: 9,
          maxScore: 10,
          grade: 5,
          elapsed_ms: 240000,
          timestamp: "2026-10-02T00:00:00.000Z",
        },
      ],
    },
    { course: "算法设计", spec },
  );
  assert.equal(readyEv.capabilityEvidence.unseenIndependentPassCount, 2);
  assert.equal(readyEv.capabilityEvidence.delayedIndependent.status, "verified");
  assert.equal(readyEv.capabilityEvidence.timedIndependent.status, "verified");
  assert.equal(readyEv.capabilityEvidence.readyForExam, true);
});

test("#853 strict homomorphic mock-paper composer preserves subparts, shared materials, required figures, optional choose-K scoring, and never pads shortfalls", () => {
  const state = {
    decks: [{
      id: "deck-mock",
      course: "电路分析",
      title: "电路题库",
      cards: [
        // Plenty of unrelated quiz cards that MUST NEVER be used to pad open/figure/case shortfalls
        ...Array.from({ length: 6 }, (_, i) => ({
          id: `quiz-${i + 1}`,
          kind: "quiz",
          prompt: `基尔霍夫定律选择题 ${i + 1}`,
        })),
        // Flat open card without subquestions -> must be rejected when `subpartsCount: 2`
        {
          id: "open-flat",
          kind: "open",
          prompt: "单问平铺计算题（无小题结构）",
        },
        // Valid structured 2-subpart open card
        {
          id: "open-tree",
          kind: "open",
          prompt: "一阶 RC 电路响应综合题",
          subquestions: [{ id: "q1", prompt: "求时间常数" }, { id: "q2", prompt: "求零状态响应" }],
        },
        // Open card requiring figure, one missing figure and one valid figure
        {
          id: "fig-broken",
          kind: "open",
          prompt: "根据下图戴维南等效网络求开路电压",
          requiresFigure: true,
          missingFigure: true,
        },
        {
          id: "fig-ok",
          kind: "open",
          prompt: "根据给定相量图求功率因数",
          figure: { svg: "<svg><circle cx='10' cy='10' r='5'/></svg>" },
        },
        // Two optional-section case cards with sharedMaterial ("二选一")
        {
          id: "opt-case-1",
          kind: "case",
          prompt: "选做题 A：三相不对称负载分析",
          sharedMaterial: "某变电站实测三相电压与阻抗数据表……",
        },
        {
          id: "opt-case-2",
          kind: "case",
          prompt: "选做题 B：谐振滤波网络选型",
          sharedMaterial: "某通信前端带通滤波器参数测量记录……",
        },
      ],
    }],
  };

  const composed = composeStrictMockPaper(state, {
    course: "电路分析",
    examShape: {
      sections: [
        {
          id: "sec-subparts",
          title: "一、分步大题（含2小问）",
          allowedKinds: ["open"],
          count: 2,
          subpartsCount: 2,
          marksPerItem: 12,
          timePerItemSec: 600,
        },
        {
          id: "sec-figure",
          title: "二、识图推导题",
          allowedKinds: ["open"],
          count: 2,
          requiresFigure: true,
          marksPerItem: 10,
          timePerItemSec: 480,
        },
        {
          id: "sec-optional",
          title: "三、综合案例选做题（二选一）",
          allowedKinds: ["case"],
          optionalChoose: { choose: 1, total: 2 },
          requiresSharedMaterial: true,
          marksPerItem: 20,
          timePerItemSec: 900,
        },
      ],
    },
  });

  assert.equal(composed.complete, false);
  assert.equal(composed.noUnrelatedPadding, true);

  // None of the 6 quiz cards, `open-flat`, or `fig-broken` were used to pad!
  assert.deepEqual(composed.selectedCardIds, ["open-tree", "fig-ok", "opt-case-1", "opt-case-2"]);

  // Optional choose-1-of-2 section supplies 2 items in pool, but counts ONLY 1 * 20 = 20 marks & 900s toward totals!
  const optSec = composed.sections.find((s) => s.sectionId === "sec-optional");
  assert.equal(optSec.fulfilledCount, 2);
  assert.equal(optSec.sectionMarks, 20);
  assert.equal(optSec.targetSectionMarks, 20);
  assert.equal(optSec.sectionTimeSec, 900);

  // Target marks = 2*12 (24) + 2*10 (20) + 1*20 (20) = 64; achieved marks = 12 + 10 + 20 = 42
  assert.equal(composed.targetMarks, 64);
  assert.equal(composed.totalMarks, 42);

  // Shortfalls accurately report rejected flat subparts and missing figure without silent conversion
  assert.equal(composed.shortfalls.length, 2);
  assert.equal(composed.shortfalls[0].sectionId, "sec-subparts");
  assert.equal(composed.shortfalls[0].rejectedFlatSubparts, 3);
  assert.match(composed.shortfalls[0].reason, /拒绝用零散单题平铺替代/);
  assert.equal(composed.shortfalls[1].sectionId, "sec-figure");
  assert.equal(composed.shortfalls[1].rejectedMissingFigure, 2);
  assert.match(composed.shortfalls[1].reason, /拒绝静默改写为纯文字题/);
});

test("#853 StudyService integration: calibration RPCs, zero/unit/crunch request compilation, coach.forget exposure preservation, and direct ordinary generation", async () => {
  const root = await mkdtemp(join(tmpdir(), "study-exam-coach-svc-"));
  const service = new StudyService(root, { model: createFakeModel({ latencyMs: 5, generationLatencyMs: 5 }) });
  try {
    await service.call("snapshot");
    await service.store.update((s) => {
      s.sources.push({
        id: "src-db",
        course: "数据库系统",
        title: "索引与事务讲义.md",
        text: "# B+树索引\n联合索引最左前缀推导公式与范围查询边界条件。\n# 并发事务与锁\n两阶段封锁协议案例设计与死锁排查权衡。",
        chars: 120,
        createdAt: "2026-10-01T08:00:00.000Z",
      });
    });

    // 1. Ordinary user path: direct `generate.preview` works without ever visiting Exam Coach
    const directPreview = await service.call("generate.preview", {
      sourceIds: ["src-db"],
      kind: "quiz",
      count: 4,
    });
    assert.equal(directPreview.modelCalls, 0);
    assert.equal(directPreview.summary.totalQuestions, 4);

    // 2. Analyze via `coach.calibration.analyze`
    const analyzed = await service.call("coach.calibration.analyze", { course: "数据库系统" });
    assert.ok(analyzed.spec.taskFamilies.length >= 2);
    assert.equal(analyzed.spec.taskFamilies[0].sample.redacted, true);

    // 3. Reveal sample solution & confirm all 3 flags on family 0
    const fam0Id = analyzed.spec.taskFamilies[0].id;
    const confirmed = await service.call("coach.calibration.confirm", {
      course: "数据库系统",
      familyId: fam0Id,
      appearanceApproved: true,
      intentApproved: true,
      answerVerified: true,
      revealSampleSolution: true,
    });
    assert.equal(confirmed.spec.taskFamilies[0].calibrated, true);
    assert.equal(confirmed.spec.taskFamilies[0].sample.redacted, undefined);
    assert.equal(confirmed.exposureReceipt.source, "sample-calibration");

    // 4. Configure non-uniform quotas: family 0 -> shared-material-group (quota 2 * 3 = 6), family 1 -> quota 0, family 2 -> medium priority deferred under crunchMode
    const patchedFamilies = confirmed.spec.taskFamilies.map((f, idx) => {
      if (idx === 0) return { ...f, quota: 2, quotaUnit: "shared-material-group", questionsPerUnit: 3, priority: "high", timeBudgetSec: 300 };
      if (idx === 1) return { ...f, quota: 0, priority: "high" };
      return { ...f, quota: 3, priority: "medium", timeBudgetSec: 600 };
    });
    const saved = await service.call("coach.calibration.save", {
      course: "数据库系统",
      templateName: "数据库期末冲刺模板",
      crunchMode: { enabled: true, remainingMinutes: 25 },
      taskFamilies: patchedFamilies,
    });
    assert.equal(saved.spec.templateName, "数据库期末冲刺模板");

    // 5. Build generation request & pass directly into `generate.preview`
    const built = await service.call("coach.calibration.buildRequest", { course: "数据库系统" });
    assert.equal(built.totalCount, 6);
    assert.equal(built.zeroQuotaFamilies.length, 1);
    assert.equal(built.unitConversions.length, 1);
    assert.equal(built.unitConversions[0].questionCount, 6);
    if (patchedFamilies.length >= 3) {
      assert.ok(built.deferredFamilies.length >= 1, "crunch mode defers medium-priority family over 25-min budget");
    }

    const coachGenPreview = await service.call("generate.preview", built.request);
    assert.equal(coachGenPreview.modelCalls, 0);
    assert.equal(coachGenPreview.summary.totalQuestions, 6);
    assert.ok(coachGenPreview.requirementsVersion);

    // 6. Calling `coach.forget` clears preferences/profile BUT preserves immutable `solutionExposures`!
    await service.call("coach.forget", {});
    const snapAfterForget = await service.store.read();
    assert.equal(snapAfterForget.learner.solutionExposures.length, 1);
    assert.equal(snapAfterForget.learner.solutionExposures[0].source, "sample-calibration");
  } finally {
    await service.dispose?.();
    await rm(root, { recursive: true, force: true });
  }
});
