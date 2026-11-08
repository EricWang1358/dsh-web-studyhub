/* Pure Exam Coach calibration, task-family versioning, sample exposure guard,
   three-layer evidence readout, and strict mock-paper composer (#853 / #847 / #852). */

import { validateDeck } from "./domain.js";
import { isSurfaceApplicationOnly } from "./coach.js";
import { MODULE_INSTRUCTION_MAX, normalizeModuleOverrides } from "./generation-modules.js";
import { cardExposureStatus, recordSolutionExposure } from "./solution-exposure.js";
import { assistanceEvidence } from "./study-progress.js";
import { isSelfReportedAttempt, rubricAttemptPassed } from "./course-method-progress.js";

export const COACH_SPEC_SCHEMA = "coach-spec-v1";
export const DELAYED_RETENTION_MS = 12 * 3600 * 1000;
export const NEAR_DUPLICATE_SIMILARITY = 0.72;

export const ANSWER_FORMATS = Object.freeze([
  { id: "quiz", label: "单选题", isChoice: true, isOpenOrTask: false },
  { id: "multi", label: "多选题", isChoice: true, isOpenOrTask: false },
  { id: "truefalse", label: "判断题", isChoice: true, isOpenOrTask: false },
  { id: "cloze", label: "填空题", isChoice: false, isOpenOrTask: false },
  { id: "open", label: "开放简答/计算", isChoice: false, isOpenOrTask: true },
  { id: "task", label: "实操/综合任务", isChoice: false, isOpenOrTask: true },
  { id: "case", label: "材料案例大题", isChoice: false, isOpenOrTask: true },
]);

const VALID_FORMATS = new Set(ANSWER_FORMATS.map((f) => f.id));
const VALID_ORIGINS = new Set(["source-fact", "reference-observed", "model-suggested", "user-defined"]);
const VALID_PRIORITIES = new Set(["high", "medium", "deferred"]);
const VALID_UNITS = new Set(["question", "shared-material-group", "subquestion"]);
const VAGUE_RUBRIC_RE = /酌情(给分|扣分)?|言之有理(即可)?|视情况(而定|给分)?|意思对即可|合理即可|适当给分/i;

const cleanStr = (v, max = 240) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");
const cleanList = (arr, maxItems = 12, maxLen = 180) =>
  [...new Set((Array.isArray(arr) ? arr : []).map((x) => cleanStr(x, maxLen)).filter(Boolean))].slice(0, maxItems);
const timeOf = (value) => (typeof value === "number" && Number.isFinite(value) ? value : value ? Date.parse(value) || 0 : 0);

function fnv1aHex(text) {
  const str = String(text ?? "");
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < str.length; i += 1) {
    hash ^= BigInt(str.charCodeAt(i));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, "0");
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .filter((k) => value[k] !== undefined)
        .sort()
        .map((k) => [k, canonical(value[k])]),
    );
  }
  return value;
}

export function normalizeStemForComparison(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, "");
}

/** Character 2-gram Sørensen–Dice similarity for near-duplicate stem detection (#853 / #847). */
export function stemSimilarity(a, b) {
  const s1 = normalizeStemForComparison(a);
  const s2 = normalizeStemForComparison(b);
  if (!s1 || !s2) return 0;
  if (s1 === s2) return 1;
  if (s1.length < 2 || s2.length < 2) return s1 === s2 ? 1 : 0;
  const grams = (s) => {
    const map = new Map();
    for (let i = 0; i < s.length - 1; i += 1) {
      const g = s.slice(i, i + 2);
      map.set(g, (map.get(g) || 0) + 1);
    }
    return map;
  };
  const g1 = grams(s1);
  const g2 = grams(s2);
  let overlap = 0;
  for (const [g, count] of g1) {
    if (g2.has(g)) overlap += Math.min(count, g2.get(g));
  }
  return (2 * overlap) / (s1.length - 1 + (s2.length - 1));
}

export function defaultFormatTradeoff(primaryFormat, allowedFormats = []) {
  const isOpen = ["open", "task", "case"].includes(primaryFormat);
  const hasChoice = allowedFormats.some((f) => ["quiz", "multi", "truefalse"].includes(f));
  if (isOpen && hasChoice) {
    return "将开放推导/实操改为选择题会把“主动构造与分步论证”降为“选项识别”，仅适合作为前置辨析，默认不计入原复杂任务达标。";
  }
  if (isOpen) {
    return "保持开放推导或实操交付物，完整考察条件核对与分步推理，不降级为选择题。";
  }
  return "允许在等价客观题形式间切换，但须保留相同的条件约束与干扰项错因映射。";
}

export function normalizeTaskFamily(raw = {}, index = 0) {
  const id = cleanStr(raw.id, 60) || `family-${index + 1}`;
  const primaryFormat = VALID_FORMATS.has(raw.primaryFormat) ? raw.primaryFormat : "quiz";
  const allowedFormats = [...new Set(
    (Array.isArray(raw.allowedFormats) ? raw.allowedFormats : [primaryFormat]).filter((f) => VALID_FORMATS.has(f)),
  )];
  if (!allowedFormats.includes(primaryFormat)) allowedFormats.unshift(primaryFormat);
  const isOpenPrimary = ["open", "task", "case"].includes(primaryFormat);
  const allowFormSubstitute = typeof raw.allowFormSubstitute === "boolean" ? raw.allowFormSubstitute : !isOpenPrimary;
  const origin = VALID_ORIGINS.has(raw.origin) ? raw.origin : "source-fact";
  const priority = VALID_PRIORITIES.has(raw.priority) ? raw.priority : "high";
  const quotaUnit = VALID_UNITS.has(raw.quotaUnit) ? raw.quotaUnit : "question";
  const quota = Number.isInteger(raw.quota) && raw.quota >= 0 ? raw.quota : 4;
  const questionsPerUnit = Number.isInteger(raw.questionsPerUnit) && raw.questionsPerUnit >= 1
    ? raw.questionsPerUnit
    : (quotaUnit === "shared-material-group" ? 3 : 1);
  const marksPerItem = Number.isFinite(Number(raw.marksPerItem)) && Number(raw.marksPerItem) > 0
    ? Number(raw.marksPerItem)
    : (isOpenPrimary ? 10 : 2);
  const timeBudgetSec = Number.isInteger(raw.timeBudgetSec) && raw.timeBudgetSec > 0
    ? raw.timeBudgetSec
    : (isOpenPrimary ? 480 : 90);

  const distractorRules = (Array.isArray(raw.distractorRules) ? raw.distractorRules : [])
    .map((d, idx) => ({
      id: cleanStr(d?.id, 50) || `${id}-mis-${idx + 1}`,
      code: cleanStr(d?.code, 40) || `M${idx + 1}`,
      label: cleanStr(d?.label, 120),
      reason: cleanStr(d?.reason, 220),
    }))
    .filter((d) => d.label || d.reason)
    .slice(0, 10);

  const rubricPoints = (Array.isArray(raw.rubricPoints) ? raw.rubricPoints : [])
    .map((r, idx) => ({
      id: cleanStr(r?.id, 50) || `${id}-rub-${idx + 1}`,
      criterion: cleanStr(r?.criterion, 160),
      marks: Number.isFinite(Number(r?.marks)) && Number(r?.marks) >= 0 ? Number(r.marks) : 2,
      condition: cleanStr(r?.condition, 200),
    }))
    .filter((r) => r.criterion)
    .slice(0, 10);

  const sampleRaw = raw.sample && typeof raw.sample === "object" ? raw.sample : {};
  const sampleFormat = VALID_FORMATS.has(sampleRaw.format) ? sampleRaw.format : primaryFormat;
  const sampleOptions = Array.isArray(sampleRaw.options)
    ? sampleRaw.options.map((o, idx) => ({
        id: cleanStr(o?.id, 40) || `opt-${idx + 1}`,
        text: cleanStr(o?.text, 200),
        correct: o?.correct === true,
        ...(cleanStr(o?.misconceptionId, 50) ? { misconceptionId: cleanStr(o.misconceptionId, 50) } : {}),
        ...(cleanStr(o?.misconceptionReason, 200) ? { misconceptionReason: cleanStr(o.misconceptionReason, 200) } : {}),
        ...(cleanStr(o?.explanation, 240) ? { explanation: cleanStr(o.explanation, 240) } : {}),
      })).filter((o) => o.text)
    : [];

  const sample = {
    id: cleanStr(sampleRaw.id, 60) || `${id}-sample`,
    format: sampleFormat,
    stem: cleanStr(sampleRaw.stem, 500),
    ...(sampleOptions.length ? { options: sampleOptions } : {}),
    answer: cleanStr(sampleRaw.answer, 400),
    rubric: cleanStr(sampleRaw.rubric, 500),
    explanation: cleanStr(sampleRaw.explanation, 400),
    ...(typeof sampleRaw.solutionRevealedAt === "string" && sampleRaw.solutionRevealedAt
      ? { solutionRevealedAt: sampleRaw.solutionRevealedAt }
      : {}),
  };

  const confRaw = raw.confirmations && typeof raw.confirmations === "object" ? raw.confirmations : {};
  const confirmations = {
    appearanceApproved: confRaw.appearanceApproved === true,
    intentApproved: confRaw.intentApproved === true,
    answerVerified: confRaw.answerVerified === true,
    confirmedSpecVersion: typeof confRaw.confirmedSpecVersion === "string" && confRaw.confirmedSpecVersion
      ? confRaw.confirmedSpecVersion
      : null,
    staleReason: typeof confRaw.staleReason === "string" && confRaw.staleReason ? confRaw.staleReason : null,
  };

  return {
    id,
    title: cleanStr(raw.title, 120) || `考察任务 ${index + 1}`,
    origin,
    knowledgePoints: cleanList(raw.knowledgePoints, 10, 120),
    keyConditions: cleanList(raw.keyConditions, 8, 160),
    reasoningSteps: cleanList(raw.reasoningSteps, 8, 180),
    expectedArtifact: cleanStr(raw.expectedArtifact, 160) || (isOpenPrimary ? "分步推导过程与结论" : "唯一有据选项"),
    primaryFormat,
    allowedFormats,
    formatTradeoff: cleanStr(raw.formatTradeoff, 260) || defaultFormatTradeoff(primaryFormat, allowedFormats),
    allowFormSubstitute,
    quota,
    quotaUnit,
    questionsPerUnit,
    priority,
    marksPerItem,
    timeBudgetSec,
    distractorRules,
    rubricPoints,
    sample,
    confirmations,
  };
}

/** Substantive digest of a single task family (ignores pure quota/priority scheduling adjustments). */
export function computeFamilySubstantiveDigest(family) {
  const f = normalizeTaskFamily(family);
  return fnv1aHex(JSON.stringify(canonical({
    id: f.id,
    primaryFormat: f.primaryFormat,
    allowedFormats: f.allowedFormats,
    allowFormSubstitute: f.allowFormSubstitute,
    keyConditions: f.keyConditions,
    reasoningSteps: f.reasoningSteps,
    expectedArtifact: f.expectedArtifact,
    distractorRules: f.distractorRules,
    rubricPoints: f.rubricPoints,
    sample: {
      format: f.sample.format,
      stem: f.sample.stem,
      options: (f.sample.options || []).map((o) => ({
        id: o.id,
        text: o.text,
        correct: o.correct,
        misconceptionId: o.misconceptionId || "",
        misconceptionReason: o.misconceptionReason || "",
      })),
      answer: f.sample.answer,
      rubric: f.sample.rubric,
    },
  })));
}

/** Deterministic version identifier across substantive assessment specifications (#853). */
export function computeCoachSpecVersion(spec = {}) {
  const families = (Array.isArray(spec.taskFamilies) ? spec.taskFamilies : []).map((f, i) => {
    const norm = normalizeTaskFamily(f, i);
    return { id: norm.id, digest: computeFamilySubstantiveDigest(norm) };
  });
  return `coach-v1-${fnv1aHex(JSON.stringify(canonical(families))).slice(0, 12)}`;
}

/** Check whether a task family has all 3 independent confirmations on the active specVersion. */
export function isFamilyCalibrated(family, activeSpecVersion) {
  const c = family?.confirmations;
  if (!c) return false;
  if (!c.appearanceApproved || !c.intentApproved || !c.answerVerified) return false;
  if (c.staleReason) return false;
  if (activeSpecVersion && c.confirmedSpecVersion && c.confirmedSpecVersion !== activeSpecVersion) return false;
  return Boolean(c.confirmedSpecVersion);
}

/** Detect vague open rubrics, missing distractor rationales, or contradictory sample answers before `answerVerified`. */
export function detectCalibrationDefects(family) {
  const f = normalizeTaskFamily(family);
  const defects = [];
  const isOpen = ["open", "task", "case"].includes(f.primaryFormat) || ["open", "task", "case"].includes(f.sample.format);
  const isChoice = ["quiz", "multi", "truefalse"].includes(f.sample.format);

  if (f.reasoningSteps.length === 0) {
    defects.push({ code: "missing-reasoning-steps", message: `「${f.title}」尚未声明关键推理步骤，无法核验题目考察深度。` });
  }

  if (isOpen) {
    if (f.rubricPoints.length === 0 && !f.sample.rubric) {
      defects.push({ code: "missing-rubric", message: `「${f.title}」为开放/实操题，必须提供具体分步评分细则（rubric）。` });
    }
    if (VAGUE_RUBRIC_RE.test(f.sample.rubric)) {
      defects.push({ code: "vague-rubric", message: `「${f.title}」样题评分细则含“酌情/言之有理”等模糊表述，请改为可核对的给分条件。` });
    }
    for (const rp of f.rubricPoints) {
      if (VAGUE_RUBRIC_RE.test(`${rp.criterion} ${rp.condition}`)) {
        defects.push({ code: "vague-rubric", message: `「${f.title}」评分点「${rp.criterion}」含模糊给分表述，请写明具体触发条件。` });
      } else if (!rp.condition && rp.criterion.length < 6) {
        defects.push({ code: "underspecified-rubric", message: `「${f.title}」评分点「${rp.criterion}」过于笼统，请补充判分依据。` });
      }
    }
    if (!f.sample.answer && !f.sample.rubric) {
      defects.push({ code: "missing-sample-answer", message: `「${f.title}」样题缺少参考答案或评分标准，无法完成答案核实。` });
    }
  }

  if (isChoice && f.sample.stem) {
    const opts = f.sample.options || [];
    if (opts.length < 2) {
      defects.push({ code: "insufficient-options", message: `「${f.title}」代表样题至少需要 2 个可对比选项。` });
    } else {
      const correctCount = opts.filter((o) => o.correct).length;
      if (f.sample.format === "quiz" && correctCount !== 1) {
        defects.push({ code: "invalid-correct-count", message: `「${f.title}」单选题样题必须且只能有 1 个正确选项（当前 ${correctCount} 个）。` });
      } else if (correctCount === 0) {
        defects.push({ code: "invalid-correct-count", message: `「${f.title}」代表样题没有标记正确选项。` });
      }
      const wrongWithoutReason = opts.filter((o) => !o.correct && !o.misconceptionId && !o.misconceptionReason);
      if (wrongWithoutReason.length > 0) {
        defects.push({
          code: "unmapped-distractor",
          message: `「${f.title}」有 ${wrongWithoutReason.length} 个干扰项未绑定具体错因，不能靠凑数选项充当诊断题。`,
        });
      }
    }
  }

  return defects;
}

/**
 * Diagnose a choice attempt strictly by stable `option.id` (immune to option order shuffling).
 * A single wrong selection is always reported as a `candidate-hypothesis`, never a confirmed misconception (#853).
 */
export function diagnoseChoiceAttempt(sampleOrCard, selectedOptionIds = [], priorMisconceptionCounts = {}) {
  const options = Array.isArray(sampleOrCard?.options) ? sampleOrCard.options : [];
  const byId = new Map(options.map((o) => [String(o.id), o]));
  const selected = [...new Set((Array.isArray(selectedOptionIds) ? selectedOptionIds : []).map(String))];
  const correctIds = options.filter((o) => o.correct === true).map((o) => String(o.id)).sort();
  const isCorrect = selected.length === correctIds.length && selected.slice().sort().every((id, i) => id === correctIds[i]);

  const matchedMisconceptions = [];
  for (const optId of selected) {
    const opt = byId.get(optId);
    if (!opt || opt.correct === true) continue;
    const misconceptionId = opt.misconceptionId || `opt:${opt.id}`;
    const prior = Number(priorMisconceptionCounts[misconceptionId] || 0);
    const occurrences = prior + 1;
    matchedMisconceptions.push({
      optionId: opt.id,
      misconceptionId,
      reason: opt.misconceptionReason || opt.explanation || sampleOrCard?.misconception || "未命名干扰项假设",
      occurrences,
      hypothesisType: occurrences >= 2 ? "recurring-pattern" : "candidate-hypothesis",
      confirmedMisconception: occurrences >= 2,
    });
  }

  return {
    isCorrect,
    selectedOptionIds: selected,
    correctOptionIds: correctIds,
    matchedMisconceptions,
    hypothesisType: isCorrect
      ? "none"
      : matchedMisconceptions.some((m) => m.confirmedMisconception)
        ? "recurring-pattern"
        : "candidate-hypothesis",
    confirmedMisconception: !isCorrect && matchedMisconceptions.some((m) => m.confirmedMisconception),
  };
}

export function normalizeCoachSpec(raw = {}, course = "") {
  const base = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const taskFamilies = (Array.isArray(base.taskFamilies) ? base.taskFamilies : []).map((f, i) => normalizeTaskFamily(f, i));
  const scopeRaw = base.scopeBoundary && typeof base.scopeBoundary === "object" ? base.scopeBoundary : {};
  const crunchRaw = base.crunchMode && typeof base.crunchMode === "object" ? base.crunchMode : {};
  const spec = {
    schema: COACH_SPEC_SCHEMA,
    course: cleanStr(base.course || course, 120),
    stage: ["analyze", "confirm", "configure", "evidence"].includes(base.stage) ? base.stage : "analyze",
    templateName: cleanStr(base.templateName, 80) || "课程校准训练方案",
    scopeBoundary: {
      samplePaperIds: cleanList(scopeRaw.samplePaperIds, 20, 80),
      materialSourceIds: cleanList(scopeRaw.materialSourceIds, 50, 80),
      sampleFrequencyNote: cleanStr(scopeRaw.sampleFrequencyNote, 240)
        || "历史样卷统计仅反映所给样本的观察频率，不等同真实考试必然分布；未出现在样卷中的教材章节仍需核对。",
      uncoveredMaterialSections: cleanList(scopeRaw.uncoveredMaterialSections, 30, 140),
    },
    crunchMode: {
      enabled: crunchRaw.enabled === true,
      remainingMinutes: Number.isInteger(crunchRaw.remainingMinutes) && crunchRaw.remainingMinutes > 0
        ? crunchRaw.remainingMinutes
        : 120,
      deferredFamilyIds: cleanList(crunchRaw.deferredFamilyIds, 20, 60),
    },
    exposedSampleStems: (Array.isArray(base.exposedSampleStems) ? base.exposedSampleStems : [])
      .filter((e) => e && typeof e === "object" && cleanStr(e.stem, 500))
      .map((e) => ({
        familyId: cleanStr(e.familyId, 60),
        stem: cleanStr(e.stem, 500),
        at: cleanStr(e.at, 40),
        specVersion: cleanStr(e.specVersion, 40),
      })),
    specHistory: (Array.isArray(base.specHistory) ? base.specHistory : [])
      .filter((h) => h && typeof h === "object" && cleanStr(h.specVersion, 40))
      .slice(-25),
    taskFamilies,
    updatedAt: typeof base.updatedAt === "string" && base.updatedAt ? base.updatedAt : null,
  };
  spec.specVersion = computeCoachSpecVersion(spec);
  return spec;
}

/** Redact unrevealed sample answers/explanations/truth flags so inspecting appearance/intent does not leak solutions (#853). */
export function projectCoachSpecForView(spec) {
  const norm = normalizeCoachSpec(spec, spec?.course);
  return {
    ...norm,
    taskFamilies: norm.taskFamilies.map((f) => {
      const revealed = Boolean(f.sample?.solutionRevealedAt);
      const defects = detectCalibrationDefects(f);
      return {
        ...f,
        calibrated: isFamilyCalibrated(f, norm.specVersion),
        defects,
        sample: revealed
          ? f.sample
          : {
              id: f.sample.id,
              format: f.sample.format,
              stem: f.sample.stem,
              ...(Array.isArray(f.sample.options)
                ? {
                    options: f.sample.options.map((o) => ({
                      id: o.id,
                      text: o.text,
                      ...(o.misconceptionId ? { misconceptionId: o.misconceptionId } : {}),
                      ...(o.misconceptionReason ? { misconceptionReason: o.misconceptionReason } : {}),
                    })),
                  }
                : {}),
              redacted: true,
            },
      };
    }),
  };
}

function extractHeadingsFromSources(sources = []) {
  const headings = [];
  for (const src of sources) {
    const title = cleanStr(src?.title, 100);
    const lines = String(src?.text || "").split(/\r?\n/);
    let foundInSrc = 0;
    for (const line of lines) {
      const m = /^(?:#{1,3}\s+|第[一二三四五六七八九十0-9]+[章节部分]\s*|[0-9]+(?:\.[0-9]+)?\s+)(.{2,60})$/.exec(line.trim());
      if (m) {
        headings.push({ sourceId: src.id, sourceTitle: title, heading: cleanStr(m[1], 90) });
        foundInSrc += 1;
        if (foundInSrc >= 8) break;
      }
    }
    if (foundInSrc === 0 && title) {
      headings.push({ sourceId: src.id, sourceTitle: title, heading: title });
    }
  }
  return headings;
}

function isReferenceLikeSource(src, explicitRefIds) {
  if (explicitRefIds.has(src.id)) return true;
  const hay = `${src?.title || ""} ${src?.kind || ""}`;
  return /真题|样卷|往年|模拟卷|试卷|past\s*paper|sample\s*exam/i.test(hay);
}

/**
 * Stage 1: Analyze assessment ways from course materials + optional past papers (#853).
 * Explicitly separates source facts, sample-paper observations, and model suggestions,
 * and reports material sections absent from sample papers.
 */
export async function analyzeAssessmentModes(state, { course = "", sourceIds, referenceSourceIds, completeLight } = {}) {
  const allSources = (state?.sources || []).filter((s) => !s.archived && (!course || !s.course || s.course === course));
  const chosenIds = Array.isArray(sourceIds) && sourceIds.length ? new Set(sourceIds) : null;
  const explicitRefIds = new Set(Array.isArray(referenceSourceIds) ? referenceSourceIds : []);
  const scoped = chosenIds ? allSources.filter((s) => chosenIds.has(s.id) || explicitRefIds.has(s.id)) : allSources;

  const sampleSources = scoped.filter((s) => isReferenceLikeSource(s, explicitRefIds));
  const materialSources = scoped.filter((s) => !isReferenceLikeSource(s, explicitRefIds));
  const effectiveMaterials = materialSources.length ? materialSources : scoped;

  const materialHeadings = extractHeadingsFromSources(effectiveMaterials);
  const sampleTextAll = sampleSources.map((s) => String(s.text || "")).join("\n");
  const uncoveredMaterialSections = sampleSources.length
    ? materialHeadings
        .map((h) => h.heading)
        .filter((h) => h && !sampleTextAll.includes(h.slice(0, Math.min(6, h.length))))
        .slice(0, 15)
    : [];

  const families = [];
  const primaryTopic = materialHeadings[0]?.heading || effectiveMaterials[0]?.title || course || "核心概念";
  const secondaryTopic = materialHeadings[1]?.heading || materialHeadings[0]?.heading || primaryTopic;
  const combinedText = scoped.map((s) => String(s.text || "")).join("\n");
  const hasCalcOrDerive = /公式|计算|推导|证明|复杂度|边界|方程|速率|概率|求|derive|calculate|proof|complexity/i.test(combinedText);
  const hasCaseOrDesign = /案例|方案|设计|架构|排查|权衡|材料分析|综合|实操|代码|实现|scenario|design|trade-?off/i.test(combinedText);

  families.push(normalizeTaskFamily({
    id: "concept-discrimination",
    title: `${primaryTopic}：边界条件与概念辨析`,
    origin: sampleSources.length ? "reference-observed" : "source-fact",
    knowledgePoints: [primaryTopic],
    keyConditions: ["给定具体前提约束条件", "区分易混概念适用边界"],
    reasoningSteps: ["识别题干限定条件", "排除表面相似但前提不符的干扰项"],
    expectedArtifact: "唯一成立的判断及排除依据",
    primaryFormat: "quiz",
    allowedFormats: ["quiz", "multi", "truefalse"],
    allowFormSubstitute: true,
    quota: 4,
    priority: "high",
    marksPerItem: 2,
    timeBudgetSec: 90,
    distractorRules: [
      { id: "mis-boundary", code: "M1", label: "忽略适用前提", reason: "把仅在特定约束下成立的结论当成无条件成立" },
      { id: "mis-swap", code: "M2", label: "混淆相邻概念职责", reason: "记住了术语名称但把上下游或对偶概念的职责张冠李戴" },
    ],
    sample: {
      id: "sample-concept-discrimination",
      format: "quiz",
      stem: `围绕「${primaryTopic}」，当约束条件发生变化时，下列哪一项判断严格成立？`,
      options: [
        { id: "opt-correct", text: `满足「${primaryTopic}」核心前提与边界约束的判断`, correct: true, explanation: "同时核对了前提条件与作用边界。" },
        { id: "opt-ignore-cond", text: "忽略前置约束、直接套用默认结论的判断", correct: false, misconceptionId: "mis-boundary", misconceptionReason: "忽略了结论成立所依赖的边界前提" },
        { id: "opt-swap-role", text: `将「${secondaryTopic}」的机制误归入「${primaryTopic}」的判断`, correct: false, misconceptionId: "mis-swap", misconceptionReason: "混淆了相邻机制的职责边界" },
      ],
      answer: `选择 opt-correct：必须先核对「${primaryTopic}」成立的前提约束。`,
      explanation: "考察在具体限定条件下辨析概念边界，而非背诵定义原文。",
    },
  }, 0));

  if (hasCalcOrDerive || sampleSources.length > 0) {
    families.push(normalizeTaskFamily({
      id: "multi-step-derivation",
      title: `${secondaryTopic}：多步推导与条件演算`,
      origin: sampleSources.length ? "reference-observed" : "source-fact",
      knowledgePoints: [secondaryTopic],
      keyConditions: ["给出初始参数或中间状态变化", "要求按步骤写出推导依据与最终结果"],
      reasoningSteps: ["列出已知量与守恒/约束关系", "逐步代入并验证边界情况", "得出可核验结论并说明单位或量级"],
      expectedArtifact: "完整分步推导过程与最终结果",
      primaryFormat: "open",
      allowedFormats: ["open", "quiz"],
      allowFormSubstitute: false,
      quota: 2,
      priority: "high",
      marksPerItem: 10,
      timeBudgetSec: 420,
      rubricPoints: [
        { id: "rub-setup", criterion: "正确列出关系式或状态转移条件", marks: 4, condition: "明确写出适用公式及对应前提变量" },
        { id: "rub-step", criterion: "完成中间步骤代入与边界检验", marks: 4, condition: "中间量计算无跳步，指明边界约束是否满足" },
        { id: "rub-final", criterion: "给出准确最终结果与结论解释", marks: 2, condition: "数值/符号与前序推导一致" },
      ],
      sample: {
        id: "sample-multi-step-derivation",
        format: "open",
        stem: `已知「${secondaryTopic}」的初始约束条件发生调整，请分步推导调整后的关键指标并检验边界条件是否仍然满足。`,
        answer: "第1步列出约束方程；第2步代入调整参数逐步求解；第3步验证边界条件并给出结论。",
        rubric: "1. 写出适用关系式与前提变量（4分）；2. 中间推导无跳步并检验边界（4分）；3. 最终结果准确且与推导一致（2分）。",
        explanation: "必须保留开放分步作答，不能默认退化为单选识别题。",
      },
    }, 1));
  }

  if (hasCaseOrDesign || materialHeadings.length >= 2) {
    families.push(normalizeTaskFamily({
      id: "scenario-tradeoff-task",
      title: `${secondaryTopic}：综合方案权衡与故障诊断`,
      origin: hasCaseOrDesign ? "source-fact" : "model-suggested",
      knowledgePoints: cleanList([primaryTopic, secondaryTopic], 4, 90),
      keyConditions: ["存在相互冲突的资源/一致性/成本约束", "需结合材料证据给出取舍理由"],
      reasoningSteps: ["定位材料中的瓶颈或冲突条件", "对比候选方案在当前约束下的代价", "给出可执行方案与风险兜底措施"],
      expectedArtifact: "诊断依据 + 方案对比 + 落地验证指标",
      primaryFormat: "task",
      allowedFormats: ["task", "open"],
      allowFormSubstitute: false,
      quota: 1,
      quotaUnit: "question",
      questionsPerUnit: 1,
      priority: "medium",
      marksPerItem: 15,
      timeBudgetSec: 600,
      rubricPoints: [
        { id: "rub-diag", criterion: "准确定位核心矛盾或根因", marks: 5, condition: "引用题干给定约束指出关键瓶颈而非泛泛而谈" },
        { id: "rub-tradeoff", criterion: "结合约束对比至少两种方案的取舍", marks: 6, condition: "说明所选方案为何优于备选方案及其代价" },
        { id: "rub-verify", criterion: "提出可观测的验证或回滚条件", marks: 4, condition: "给出明确的检验指标或边界回退策略" },
      ],
      sample: {
        id: "sample-scenario-tradeoff",
        format: "task",
        stem: `综合「${primaryTopic}」与「${secondaryTopic}」的约束条件，分析给定瓶颈的根因，提出改进方案并说明权衡代价与验证方法。`,
        answer: "定位约束冲突根因；对比备选方案代价并给出选型依据；列出上线后的关键验证指标。",
        rubric: "1. 结合题干约束定位根因（5分）；2. 对比候选方案收益与代价（6分）；3. 给出可量化验证或兜底指标（4分）。",
        explanation: "考察多约束综合权衡，不在定义题前拼“某公司”充数。",
      },
    }, 2));
  }

  if (typeof completeLight === "function" && scoped.length > 0) {
    try {
      const snippet = scoped.slice(0, 3).map((s) => `【${clipText(s.title, 50)}】\n${clipText(s.text, 600)}`).join("\n\n");
      const rawReply = await completeLight(
        "你是严谨的考试测量与教学设计专家。只输出 JSON，不输出多余解释。",
        JSON.stringify({
          task: "根据资料片段补充至多 1 个模型建议的考察任务族（origin 固定为 model-suggested），包含 title, primaryFormat(quiz/multi/open/task), keyConditions, reasoningSteps, distractorRules 或 rubricPoints。",
          snippet,
        }),
        { maxTokens: 500, task: "coach.calibration.analyze" },
      );
      const parsed = safeJson(rawReply);
      const extra = parsed?.taskFamily || (Array.isArray(parsed?.taskFamilies) ? parsed.taskFamilies[0] : null);
      if (extra && typeof extra === "object" && cleanStr(extra.title, 100)) {
        families.push(normalizeTaskFamily({ ...extra, id: extra.id || "model-suggested-family", origin: "model-suggested", priority: "medium", quota: 2 }, families.length));
      }
    } catch {
      // Deterministic analysis stands on its own when light model is unavailable or returns malformed JSON.
    }
  }

  return normalizeCoachSpec({
    course,
    stage: "confirm",
    templateName: course ? `${course} 校准训练方案` : "课程校准训练方案",
    scopeBoundary: {
      samplePaperIds: sampleSources.map((s) => s.id),
      materialSourceIds: effectiveMaterials.map((s) => s.id),
      sampleFrequencyNote: sampleSources.length
        ? `已分析 ${sampleSources.length} 份参考样卷与 ${effectiveMaterials.length} 份课程资料：样卷题型频次仅代表样本观察，未覆盖章节仍需在规划中显式取舍。`
        : `当前基于 ${effectiveMaterials.length} 份课程资料推导考察方式（暂无往年样卷输入，题型配额为建议初值，请结合考纲确认）。`,
      uncoveredMaterialSections,
    },
    taskFamilies: families,
    updatedAt: new Date().toISOString(),
  }, course);
}

const clipText = (s, max) => String(s || "").slice(0, max);
function safeJson(raw) {
  if (!raw || typeof raw !== "string") return null;
  const trimmed = raw.trim().replace(/^```(?:json)?\s*|\s*```$/gi, "");
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

/**
 * Save / mutate a CoachSpec with task-family operations (`add`, `rename`, `delete`, `merge`, `split`),
 * crunch-time compression, and automatic invalidation of stale confirmations when substantive rules change (#853).
 */
export function saveCoachSpec(prevSpec, patch = {}, { now = new Date().toISOString() } = {}) {
  const prev = normalizeCoachSpec(prevSpec, patch.course || prevSpec?.course || "");
  const prevById = new Map(prev.taskFamilies.map((f) => [f.id, f]));
  let families = prev.taskFamilies.map((f) => ({ ...f }));

  // Apply explicit structural operations first if provided
  for (const op of Array.isArray(patch.operations) ? patch.operations : []) {
    if (!op || typeof op !== "object") continue;
    if (op.type === "add") {
      families.push(normalizeTaskFamily({ ...op.family, origin: op.family?.origin || "user-defined" }, families.length));
    } else if (op.type === "rename" && op.familyId && cleanStr(op.title, 120)) {
      families = families.map((f) => (f.id === op.familyId ? { ...f, title: cleanStr(op.title, 120) } : f));
    } else if (op.type === "delete" && op.familyId) {
      families = families.filter((f) => f.id !== op.familyId);
    } else if (op.type === "merge" && Array.isArray(op.sourceIds) && op.sourceIds.length >= 2) {
      const srcSet = new Set(op.sourceIds);
      const picked = families.filter((f) => srcSet.has(f.id));
      if (picked.length >= 2) {
        const merged = normalizeTaskFamily({
          id: cleanStr(op.targetId, 60) || `merged-${picked[0].id}`,
          title: cleanStr(op.title, 120) || picked.map((p) => p.title).join(" + "),
          origin: "user-defined",
          knowledgePoints: picked.flatMap((p) => p.knowledgePoints),
          keyConditions: picked.flatMap((p) => p.keyConditions),
          reasoningSteps: picked.flatMap((p) => p.reasoningSteps),
          primaryFormat: picked[0].primaryFormat,
          allowedFormats: picked.flatMap((p) => p.allowedFormats),
          allowFormSubstitute: picked.every((p) => p.allowFormSubstitute),
          quota: picked.reduce((sum, p) => sum + p.quota, 0),
          priority: picked.some((p) => p.priority === "high") ? "high" : "medium",
          marksPerItem: Math.max(...picked.map((p) => p.marksPerItem)),
          timeBudgetSec: Math.max(...picked.map((p) => p.timeBudgetSec)),
          distractorRules: picked.flatMap((p) => p.distractorRules),
          rubricPoints: picked.flatMap((p) => p.rubricPoints),
          sample: picked[0].sample,
          confirmations: { appearanceApproved: false, intentApproved: false, answerVerified: false, confirmedSpecVersion: null, staleReason: "merged-family" },
        }, families.length);
        families = [...families.filter((f) => !srcSet.has(f.id)), merged];
      }
    } else if (op.type === "split" && op.sourceId && Array.isArray(op.parts) && op.parts.length >= 2) {
      const originFamily = families.find((f) => f.id === op.sourceId);
      if (originFamily) {
        const splitItems = op.parts.map((part, idx) => normalizeTaskFamily({
          ...originFamily,
          ...part,
          id: cleanStr(part?.id, 60) || `${originFamily.id}-part-${idx + 1}`,
          title: cleanStr(part?.title, 120) || `${originFamily.title}（子项 ${idx + 1}）`,
          origin: "user-defined",
          quota: Number.isInteger(part?.quota) ? part.quota : Math.max(1, Math.ceil(originFamily.quota / op.parts.length)),
          confirmations: { appearanceApproved: false, intentApproved: false, answerVerified: false, confirmedSpecVersion: null, staleReason: "split-family" },
        }, idx));
        families = families.flatMap((f) => (f.id === op.sourceId ? splitItems : [f]));
      }
    }
  }

  if (Array.isArray(patch.taskFamilies)) {
    families = patch.taskFamilies.map((f, idx) => normalizeTaskFamily(f, idx));
  }

  // Reconcile confirmations: if substantive rules changed vs previous family, invalidate intentApproved & answerVerified!
  families = families.map((f, idx) => {
    const norm = normalizeTaskFamily(f, idx);
    const old = prevById.get(norm.id);
    if (!old) return norm;
    const oldDigest = computeFamilySubstantiveDigest(old);
    const newDigest = computeFamilySubstantiveDigest(norm);
    // Preserve prior solutionRevealedAt on the same sample stem so exposure can never be wiped out by saving
    if (old.sample?.solutionRevealedAt && stemSimilarity(old.sample.stem, norm.sample.stem) >= NEAR_DUPLICATE_SIMILARITY) {
      norm.sample.solutionRevealedAt = old.sample.solutionRevealedAt;
    }
    if (oldDigest !== newDigest) {
      norm.confirmations = {
        appearanceApproved: norm.confirmations.appearanceApproved && old.sample.stem === norm.sample.stem && old.primaryFormat === norm.primaryFormat,
        intentApproved: false,
        answerVerified: false,
        confirmedSpecVersion: null,
        staleReason: "rules-updated",
      };
    }
    return norm;
  });

  // Apply crunch-mode compression if enabled: keep high-priority families, defer medium/low when over remainingMinutes budget, NEVER lower pass standard
  const crunchPatch = patch.crunchMode && typeof patch.crunchMode === "object"
    ? { ...prev.crunchMode, ...patch.crunchMode }
    : prev.crunchMode;
  const deferredFamilyIds = [];
  if (crunchPatch.enabled) {
    const budgetSec = Math.max(15, Number(crunchPatch.remainingMinutes || 120)) * 60;
    let usedSec = 0;
    const ordered = [...families].sort((a, b) => {
      const rank = { high: 0, medium: 1, deferred: 2 };
      return (rank[a.priority] ?? 1) - (rank[b.priority] ?? 1);
    });
    const keepMap = new Map();
    for (const f of ordered) {
      const totalItems = f.quota * f.questionsPerUnit;
      const neededSec = totalItems * f.timeBudgetSec;
      if (f.priority === "deferred" || (usedSec > 0 && usedSec + neededSec > budgetSec && f.priority !== "high")) {
        deferredFamilyIds.push(f.id);
        keepMap.set(f.id, { ...f, priority: "deferred" });
      } else {
        usedSec += neededSec;
        keepMap.set(f.id, f);
      }
    }
    families = families.map((f) => keepMap.get(f.id) || f);
  }

  const mergedExposedStems = [...prev.exposedSampleStems];
  const pushStem = (entry) => {
    if (!entry || !cleanStr(entry.stem, 500)) return;
    const stem = cleanStr(entry.stem, 500);
    const familyId = cleanStr(entry.familyId, 60);
    if (!mergedExposedStems.some((e) => e.familyId === familyId && e.stem === stem)) {
      mergedExposedStems.push({
        familyId,
        stem,
        at: cleanStr(entry.at, 40) || now,
        specVersion: cleanStr(entry.specVersion, 40) || prev.specVersion || "coach-v1-init",
      });
    }
  };
  for (const item of Array.isArray(patch.exposedSampleStems) ? patch.exposedSampleStems : []) pushStem(item);
  for (const f of families) {
    if (f.sample?.solutionRevealedAt && f.sample?.stem) {
      pushStem({ familyId: f.id, stem: f.sample.stem, at: f.sample.solutionRevealedAt, specVersion: prev.specVersion });
    }
  }

  const next = normalizeCoachSpec({
    ...prev,
    ...(patch.stage ? { stage: patch.stage } : {}),
    ...(patch.templateName !== undefined ? { templateName: patch.templateName } : {}),
    ...(patch.scopeBoundary ? { scopeBoundary: { ...prev.scopeBoundary, ...patch.scopeBoundary } } : {}),
    crunchMode: { ...crunchPatch, deferredFamilyIds },
    exposedSampleStems: mergedExposedStems,
    specHistory: prev.specVersion && prev.taskFamilies.length
      ? [
          ...prev.specHistory.filter((h) => h.specVersion !== prev.specVersion),
          { specVersion: prev.specVersion, savedAt: prev.updatedAt || now, familyCount: prev.taskFamilies.length },
        ]
      : prev.specHistory,
    taskFamilies: families,
    updatedAt: now,
  }, prev.course);

  // Keep valid confirmations bound to their confirmed version if substantive digest did not change
  next.taskFamilies = next.taskFamilies.map((f) => {
    const old = prevById.get(f.id);
    if (
      old
      && computeFamilySubstantiveDigest(old) === computeFamilySubstantiveDigest(f)
      && f.confirmations.appearanceApproved
      && f.confirmations.intentApproved
      && f.confirmations.answerVerified
      && !f.confirmations.staleReason
    ) {
      return {
        ...f,
        confirmations: {
          ...f.confirmations,
          confirmedSpecVersion: next.specVersion,
        },
      };
    }
    return f;
  });

  return next;
}

/**
 * Stage 2: Update the 3 distinct confirmation flags or reveal a sample solution (recording irreversible exposure).
 */
export function confirmCalibrationFamily(spec, {
  familyId,
  appearanceApproved,
  intentApproved,
  answerVerified,
  revealSampleSolution = false,
  learner = null,
  state = null,
  now = new Date().toISOString(),
} = {}) {
  const norm = normalizeCoachSpec(spec, spec?.course);
  const idx = norm.taskFamilies.findIndex((f) => f.id === familyId);
  if (idx === -1) throw new Error(`未找到考察任务族：${familyId}`);
  const target = structuredClone(norm.taskFamilies[idx]);
  let nextLearner = learner ? { ...learner } : null;
  let exposureReceipt = null;
  const exposedSampleStems = [...norm.exposedSampleStems];

  if (revealSampleSolution) {
    if (!target.sample.solutionRevealedAt) target.sample.solutionRevealedAt = now;
    if (target.sample.stem && !exposedSampleStems.some((e) => e.familyId === target.id && e.stem === target.sample.stem)) {
      exposedSampleStems.push({ familyId: target.id, stem: target.sample.stem, at: now, specVersion: norm.specVersion });
    }
    const matchingCardIds = findNearDuplicateCardIds(state, target.sample.stem);
    if (nextLearner) {
      const recorded = recordSolutionExposure(nextLearner, {
        at: now,
        source: "sample-calibration",
        action: "reveal-sample",
        stage: `calibration:${target.id}`,
        requirementsVersion: norm.specVersion,
        cardIds: matchingCardIds,
        unmapped: false,
      });
      nextLearner = recorded.learner;
      exposureReceipt = recorded.receipt;
    }
  }

  const nextConf = { ...target.confirmations };
  if (typeof appearanceApproved === "boolean") nextConf.appearanceApproved = appearanceApproved;
  if (typeof intentApproved === "boolean") nextConf.intentApproved = intentApproved;
  if (typeof answerVerified === "boolean") {
    if (answerVerified === true) {
      const defects = detectCalibrationDefects(target);
      if (defects.length > 0) {
        throw new Error(defects[0].message);
      }
    }
    nextConf.answerVerified = answerVerified;
  }

  if (nextConf.appearanceApproved && nextConf.intentApproved && nextConf.answerVerified) {
    nextConf.confirmedSpecVersion = norm.specVersion;
    nextConf.staleReason = null;
  } else {
    nextConf.confirmedSpecVersion = null;
    if (typeof intentApproved === "boolean" || typeof answerVerified === "boolean") {
      nextConf.staleReason = null;
    }
  }

  target.confirmations = nextConf;
  const nextFamilies = norm.taskFamilies.map((f, i) => (i === idx ? target : f));
  const nextSpec = normalizeCoachSpec({
    ...norm,
    exposedSampleStems,
    taskFamilies: nextFamilies,
    updatedAt: now,
  }, norm.course);

  // Re-stamp confirmedSpecVersion across already-calibrated families
  nextSpec.taskFamilies = nextSpec.taskFamilies.map((f) => {
    if (f.confirmations.appearanceApproved && f.confirmations.intentApproved && f.confirmations.answerVerified && !f.confirmations.staleReason) {
      return { ...f, confirmations: { ...f.confirmations, confirmedSpecVersion: nextSpec.specVersion } };
    }
    return f;
  });

  return { spec: nextSpec, learner: nextLearner, exposureReceipt };
}

function findNearDuplicateCardIds(state, sampleStem) {
  if (!sampleStem || !state) return [];
  const ids = [];
  for (const deck of [...(state.decks || []), ...(state.drafts || [])]) {
    for (const card of deck?.cards || []) {
      if (card?.id && stemSimilarity(card.prompt, sampleStem) >= NEAR_DUPLICATE_SIMILARITY) {
        ids.push(card.id);
      }
    }
  }
  return [...new Set(ids)];
}

export function isNearDuplicateOfExposedSample(cardPrompt, spec, beforeAt) {
  const stems = Array.isArray(spec?.exposedSampleStems) ? spec.exposedSampleStems : [];
  const limitMs = beforeAt ? timeOf(beforeAt) || Infinity : Infinity;
  for (const item of stems) {
    const atMs = timeOf(item.at);
    if (atMs && atMs > limitMs) continue;
    if (stemSimilarity(cardPrompt, item.stem) >= NEAR_DUPLICATE_SIMILARITY) return true;
  }
  return false;
}

/**
 * Stage 3 -> 4: Compile calibrated CoachSpec into a concrete `generate` / `generate.preview` request (#853 / #852).
 */
export function compileCoachGenerationRequest(spec, state = {}, overrides = {}) {
  const norm = normalizeCoachSpec(spec, overrides.course || spec?.course);
  const activeFamilies = [];
  const zeroQuotaFamilies = [];
  const deferredFamilies = [];
  const uncalibratedFamilies = [];
  const unitConversions = [];
  const kindCounts = {};

  const allKindsSet = new Set();
  for (const f of norm.taskFamilies) {
    const genKind = f.primaryFormat === "case" ? "open" : f.primaryFormat;
    allKindsSet.add(genKind);
    if (f.quota === 0) {
      zeroQuotaFamilies.push({ id: f.id, title: f.title, kind: genKind });
      if (kindCounts[genKind] === undefined) kindCounts[genKind] = 0;
      continue;
    }
    if (norm.crunchMode.enabled && (f.priority === "deferred" || norm.crunchMode.deferredFamilyIds.includes(f.id))) {
      deferredFamilies.push({ id: f.id, title: f.title, quota: f.quota, kind: genKind });
      if (kindCounts[genKind] === undefined) kindCounts[genKind] = 0;
      continue;
    }
    if (!isFamilyCalibrated(f, norm.specVersion)) {
      uncalibratedFamilies.push({ id: f.id, title: f.title, confirmations: f.confirmations });
    }
    const questionCount = f.quota * f.questionsPerUnit;
    if (f.quotaUnit !== "question" || f.questionsPerUnit > 1) {
      unitConversions.push({
        familyId: f.id,
        title: f.title,
        quota: f.quota,
        quotaUnit: f.quotaUnit,
        questionsPerUnit: f.questionsPerUnit,
        questionCount,
      });
    }
    kindCounts[genKind] = (kindCounts[genKind] || 0) + questionCount;
    activeFamilies.push({ ...f, questionCount, generationKind: genKind });
  }

  if (overrides.requireConfirmed === true && uncalibratedFamilies.length > 0) {
    throw new Error(`仍有 ${uncalibratedFamilies.length} 个启用中的考察任务族尚未完成三项校准确认（${uncalibratedFamilies.map((u) => u.title).join("、")}）`);
  }

  const activeKinds = Object.keys(kindCounts).filter((k) => kindCounts[k] > 0);
  const allKinds = [...allKindsSet];
  const totalCount = Object.values(kindCounts).reduce((sum, n) => sum + n, 0);

  const reasoningLines = activeFamilies
    .map((f) => `${f.title}：条件[${f.keyConditions.join("；")}] -> 步骤[${f.reasoningSteps.join("→")}]`)
    .join("；")
    .slice(0, MODULE_INSTRUCTION_MAX);
  const distractorLines = activeFamilies
    .flatMap((f) => f.distractorRules.map((d) => `${d.code}(${d.label}): ${d.reason}`))
    .join("；")
    .slice(0, MODULE_INSTRUCTION_MAX);
  const rubricLines = activeFamilies
    .flatMap((f) => f.rubricPoints.map((r) => `${r.criterion}(${r.marks}分, 条件:${r.condition || "按步骤核对"})`))
    .join("；")
    .slice(0, MODULE_INSTRUCTION_MAX);

  const moduleOverrides = normalizeModuleOverrides({
    templateName: norm.templateName,
    ...(reasoningLines ? { reasoning: { enabled: true, instruction: reasoningLines } } : {}),
    ...(distractorLines ? { distractors: { enabled: true, instruction: distractorLines } } : {}),
    ...(rubricLines ? { rubric: { enabled: true, instruction: rubricLines } } : {}),
    taskFamilies: activeFamilies.map((f) => ({
      id: f.id,
      name: f.title,
      forms: f.allowFormSubstitute ? f.allowedFormats : [f.primaryFormat],
      requiredSteps: f.reasoningSteps,
      misconceptions: f.distractorRules.map((d) => `${d.label}: ${d.reason}`),
      rubricPoints: f.rubricPoints.map((r) => `${r.criterion} (${r.marks}分): ${r.condition}`),
      quota: f.questionCount,
    })),
  }, { strict: true });

  const courseSources = (state?.sources || []).filter((s) => !s.archived && (!norm.course || !s.course || s.course === norm.course));
  const sourceIds = Array.isArray(overrides.sourceIds) && overrides.sourceIds.length
    ? overrides.sourceIds
    : norm.scopeBoundary.materialSourceIds.length
      ? norm.scopeBoundary.materialSourceIds.filter((id) => courseSources.some((s) => s.id === id))
      : courseSources.map((s) => s.id);
  const referenceSourceIds = Array.isArray(overrides.referenceSourceIds)
    ? overrides.referenceSourceIds
    : norm.scopeBoundary.samplePaperIds.filter((id) => (state?.sources || []).some((s) => s.id === id));

  const shortfallWarnings = [];
  if (sourceIds.length === 0) {
    shortfallWarnings.push("当前未选中可用课程资料，无法直接发起有据出题。");
  } else if (totalCount > sourceIds.length * 15) {
    shortfallWarnings.push(`请求总题量（${totalCount} 题）相对当前资料篇幅（${sourceIds.length} 份）偏高，若证据不足将按真实可达数量交付并报告缺口。`);
  }

  const focusTopics = [...new Set(activeFamilies.flatMap((f) => f.knowledgePoints.length ? f.knowledgePoints : [f.title]))]
    .join("；")
    .slice(0, 240);

  const primaryKind = activeKinds[0] || allKinds[0] || "quiz";
  const requestKindsList = allKinds.length >= 2 ? allKinds : [primaryKind];

  const request = {
    ...(norm.course ? { course: norm.course } : {}),
    title: overrides.title || `${norm.templateName}（${norm.specVersion}）`,
    sourceIds,
    ...(referenceSourceIds.length ? { referenceSourceIds } : {}),
    kind: primaryKind,
    kinds: requestKindsList,
    ...(totalCount > 0
      ? (requestKindsList.length >= 2 ? { count: totalCount, kindCounts } : { count: totalCount })
      : { count: 0 }),
    ...(focusTopics ? { focus: focusTopics } : {}),
    difficulty: overrides.difficulty || "application",
    ...(moduleOverrides ? { moduleOverrides } : {}),
  };

  return {
    coachSpecVersion: norm.specVersion,
    request,
    totalCount,
    kindCounts,
    activeFamilyCount: activeFamilies.length,
    zeroQuotaFamilies,
    deferredFamilies,
    uncalibratedFamilies,
    unitConversions,
    shortfallWarnings,
  };
}

function matchCardToFamily(card, families) {
  if (!card || !families.length) return null;
  if (card.taskFamilyId) {
    const direct = families.find((f) => f.id === card.taskFamilyId);
    if (direct) return direct;
  }
  const hay = `${card.topic || ""} ${card.objective || ""} ${card.prompt || ""}`.toLowerCase();
  for (const f of families) {
    const keys = [...f.knowledgePoints, f.title].map((k) => k.toLowerCase()).filter(Boolean);
    if (keys.some((k) => k.length >= 2 && hay.includes(k))) return f;
  }
  return null;
}

function cardCountsForTaskFamily(card, family) {
  if (!card || !family) return false;
  if (card.variantMeta?.countsForOriginalTask === false) return false;
  if (card.origin?.reason === "too-hard") return false;
  const isComplexFamily = ["open", "task", "case"].includes(family.primaryFormat) || family.reasoningSteps.length >= 2;
  if (isComplexFamily && (card.kind === "flashcard" || isSurfaceApplicationOnly(card))) return false;
  if (!family.allowFormSubstitute && card.kind !== family.primaryFormat) {
    if (!(family.primaryFormat === "case" && card.kind === "open" && (card.sharedMaterial || card.caseText))) {
      return false;
    }
  }
  return true;
}

/**
 * Three-layer separated evidence readout (#853 / #847):
 * 1. `materialCoverage` (资料覆盖)
 * 2. `trainingCoverage` (训练覆盖: planned / generated / verifiedUsable / practiced + version binding)
 * 3. `capabilityEvidence` (独立能力证据: familiarity vs same-item repeat vs assisted/exposed vs unseen independent vs >=12h delayed vs timed)
 */
export function computeCoachEvidence(state = {}, { course = "", spec: explicitSpec } = {}) {
  const rawSpec = explicitSpec || state?.learner?.examCoach?.[course || "__default__"] || {};
  const spec = normalizeCoachSpec(rawSpec, course);
  const sources = (state?.sources || []).filter((s) => !s.archived && (!course || !s.course || s.course === course));
  const decks = (state?.decks || []).filter((d) => !d.archived && (!course || !d.course || d.course === course));
  const drafts = (state?.drafts || []).filter((d) => !course || !d.course || d.course === course);
  const allDecksAndDrafts = [...decks, ...drafts];
  const publishedCards = decks.flatMap((d) => (d.cards || []).map((c) => ({ card: c, deck: d, isDraft: false })));
  const allCards = allDecksAndDrafts.flatMap((d) => (d.cards || []).map((c) => ({ card: c, deck: d, isDraft: drafts.includes(d) })));

  // 1. Material Coverage (资料覆盖)
  const headings = extractHeadingsFromSources(sources);
  const sectionUnits = headings.length
    ? headings.map((h) => ({ id: `${h.sourceId}:${h.heading}`, label: h.heading, sourceId: h.sourceId }))
    : sources.map((s) => ({ id: s.id, label: s.title || s.id, sourceId: s.id }));

  let coveredSectionCount = 0;
  const uncoveredSections = [];
  for (const sec of sectionUnits) {
    const covered = publishedCards.some(({ card }) => {
      const cited = (card.citations || []).some((c) => c.sourceId === sec.sourceId);
      const topicHit = `${card.topic || ""} ${card.prompt || ""}`.includes(sec.label.slice(0, Math.min(6, sec.label.length)));
      return cited || topicHit;
    });
    if (covered) coveredSectionCount += 1;
    else uncoveredSections.push(sec.label);
  }
  const recallOnlyCardCount = publishedCards.filter(({ card }) => card.kind === "flashcard" || card.kind === "cloze").length;
  const surfaceApplicationCardCount = publishedCards.filter(({ card }) => isSurfaceApplicationOnly(card)).length;

  const materialCoverage = {
    totalSources: sources.length,
    totalSections: sectionUnits.length,
    coveredSections: coveredSectionCount,
    ratio: sectionUnits.length > 0 ? Number((coveredSectionCount / sectionUnits.length).toFixed(3)) : 0,
    uncoveredSections: uncoveredSections.slice(0, 15),
    totalPublishedCards: publishedCards.length,
    recallOnlyCardCount,
    surfaceApplicationCardCount,
  };

  // Index feedback & attempts
  const downFeedbackCardIds = new Set(
    (state?.feedback || []).filter((f) => f.vote === "down" && (f.tags || []).some((t) => t !== "too-easy" && t !== "too-hard")).map((f) => f.cardId),
  );
  const attempts = [...(state?.attempts || [])].sort((a, b) => timeOf(a.timestamp) - timeOf(b.timestamp));
  const attemptsByCard = new Map();
  for (const att of attempts) {
    const cid = att.quiz_id || att.cardId;
    if (!cid) continue;
    if (!attemptsByCard.has(cid)) attemptsByCard.set(cid, []);
    attemptsByCard.get(cid).push(att);
  }

  // 2. Training Coverage (训练覆盖)
  let plannedTotal = 0;
  let generatedTotal = 0;
  let verifiedUsableTotal = 0;
  let practicedTotal = 0;
  let outdatedVersionCardCount = 0;
  let excludedScaffoldOrDowngradeCount = 0;

  const familyCoverage = spec.taskFamilies.map((f) => {
    const isDeferred = spec.crunchMode.enabled && (f.priority === "deferred" || spec.crunchMode.deferredFamilyIds.includes(f.id));
    const planned = isDeferred ? 0 : f.quota * f.questionsPerUnit;
    let generated = 0;
    let verifiedUsable = 0;
    let practiced = 0;
    let outdated = 0;
    let excluded = 0;

    for (const { card, deck } of allCards) {
      const matched = matchCardToFamily(card, [f]);
      if (!matched) continue;
      if (card.coachSpecVersion && card.coachSpecVersion !== spec.specVersion) {
        outdated += 1;
        outdatedVersionCardCount += 1;
        continue;
      }
      if (!cardCountsForTaskFamily(card, f)) {
        excluded += 1;
        excludedScaffoldOrDowngradeCount += 1;
        continue;
      }
      generated += 1;
      const deckErrs = validateDeck({ title: deck.title || "check", cards: [card] }, state?.sources || []).errors;
      const usable = deckErrs.length === 0 && !downFeedbackCardIds.has(card.id);
      if (usable) {
        verifiedUsable += 1;
        const cardAtts = attemptsByCard.get(card.id) || [];
        if (cardAtts.some((a) => !isSelfReportedAttempt(a) && a.assessment !== "self")) {
          practiced += 1;
        }
      }
    }

    plannedTotal += planned;
    generatedTotal += generated;
    verifiedUsableTotal += verifiedUsable;
    practicedTotal += practiced;

    return {
      familyId: f.id,
      title: f.title,
      primaryFormat: f.primaryFormat,
      calibrated: isFamilyCalibrated(f, spec.specVersion),
      deferred: isDeferred,
      planned,
      generated,
      verifiedUsable,
      practiced,
      outdatedVersionCount: outdated,
      excludedCount: excluded,
    };
  });

  const trainingCoverage = {
    specVersion: spec.specVersion,
    planned: plannedTotal,
    generated: generatedTotal,
    verifiedUsable: verifiedUsableTotal,
    practiced: practicedTotal,
    outdatedVersionCardCount,
    excludedScaffoldOrDowngradeCount,
    families: familyCoverage,
  };

  // 3. Independent Capability Evidence (独立能力证据, #847)
  const cardLookup = new Map(publishedCards.map(({ card, deck }) => [card.id, { card, deck }]));
  const exposures = state?.learner?.solutionExposures || [];

  const reviewedCards = publishedCards.filter(({ card }) => Number(card.review?.reps || 0) > 0).length;
  const highStabilityCards = publishedCards.filter(({ card }) => Number(card.review?.interval || card.review?.stability || 0) >= 7).length;

  let sameItemRepeatCount = 0;
  let assistedOrExposedCount = 0;
  let selfReportedCount = 0;
  let unknownLegacyCount = 0;
  let unseenIndependentPassCount = 0;
  let timedPassedCount = 0;
  let untimedUnknownCount = 0;
  let overBudgetCount = 0;
  let missingTimestampCount = 0;

  const seenCardAttemptCount = new Map();
  const familyFirstActivityAt = new Map();
  const familyUnseenPassEvents = new Map();
  const misconceptionTallies = new Map();

  for (const att of attempts) {
    const cid = att.quiz_id || att.cardId;
    const entry = cardLookup.get(cid);
    if (!entry) continue;
    const { card, deck } = entry;
    const priorOnSameCard = seenCardAttemptCount.get(cid) || 0;
    seenCardAttemptCount.set(cid, priorOnSameCard + 1);

    const matchedFamily = matchCardToFamily(card, spec.taskFamilies);
    const attMs = timeOf(att.timestamp);
    if (!attMs) missingTimestampCount += 1;
    if (matchedFamily && attMs > 0 && !familyFirstActivityAt.has(matchedFamily.id)) {
      familyFirstActivityAt.set(matchedFamily.id, { atMs: attMs, cardId: cid });
    }

    // Choice misconception tracking by stable option.id
    if (Array.isArray(card.options) && Array.isArray(att.selected) && att.selected.length > 0) {
      const currentCounts = Object.fromEntries([...misconceptionTallies.entries()].map(([k, v]) => [k, v.count]));
      const diag = diagnoseChoiceAttempt(card, att.selected, currentCounts);
      for (const m of diag.matchedMisconceptions) {
        const prev = misconceptionTallies.get(m.misconceptionId) || { id: m.misconceptionId, reason: m.reason, count: 0 };
        prev.count += 1;
        misconceptionTallies.set(m.misconceptionId, prev);
      }
    }

    if (isSelfReportedAttempt(att) || att.assessment === "self" || card.kind === "flashcard") {
      selfReportedCount += 1;
      continue;
    }

    const isPass = (att.assessment === "rubric" || att.assessment === "task-static" || att.taskCheck)
      ? rubricAttemptPassed(att)
      : (att.correct === true || (typeof att.grade === "number" && att.grade >= 3));
    if (!isPass) continue;

    // Exclude scaffolds, downgraded forms, and surface-only "某公司" wrappers from complex capability passes
    if (card.variantMeta?.countsForOriginalTask === false || card.origin?.reason === "too-hard") {
      assistedOrExposedCount += 1;
      continue;
    }
    if (matchedFamily && !cardCountsForTaskFamily(card, matchedFamily)) {
      assistedOrExposedCount += 1;
      continue;
    }
    if (!matchedFamily && isSurfaceApplicationOnly(card)) {
      // Surface wrapper on a recall card cannot count as complex unseen task transfer when task families exist
      if (spec.taskFamilies.length > 0) {
        sameItemRepeatCount += 0;
        continue;
      }
    }

    if (priorOnSameCard > 0 || att.retry) {
      sameItemRepeatCount += 1;
      continue;
    }

    const expStatus = cardExposureStatus(exposures, {
      cardId: cid,
      deckId: deck.id,
      draftId: deck.id,
      jobId: deck.editorial?.generation?.runId,
      beforeAt: att.timestamp,
    });
    const nearDupExposed = isNearDuplicateOfExposedSample(card.prompt, spec, att.timestamp);
    const ev = assistanceEvidence(
      att.assistance,
      expStatus.exposed ? { blueprintExposed: true, unseenStatus: "exposed" } : {},
      expStatus.unseenStatus === "unknown" ? { unseenStatus: "unknown" } : {},
      nearDupExposed ? { sampleExposed: true, unseenStatus: "exposed" } : {},
    );

    if (ev.used || expStatus.exposed || nearDupExposed) {
      assistedOrExposedCount += 1;
      continue;
    }
    if (ev.unseenStatus === "unknown") {
      unknownLegacyCount += 1;
      continue;
    }

    unseenIndependentPassCount += 1;

    // Timing check against family or card budget (never fabricate when elapsed_ms is absent!)
    const budgetSec = Number(card.timeBudgetSec || matchedFamily?.timeBudgetSec || 0);
    if (typeof att.elapsed_ms === "number" && att.elapsed_ms > 0 && budgetSec > 0) {
      if (att.elapsed_ms <= budgetSec * 1000) timedPassedCount += 1;
      else overBudgetCount += 1;
    } else {
      untimedUnknownCount += 1;
    }

    if (matchedFamily) {
      if (!familyUnseenPassEvents.has(matchedFamily.id)) familyUnseenPassEvents.set(matchedFamily.id, []);
      familyUnseenPassEvents.get(matchedFamily.id).push({ cardId: cid, atMs: attMs });
    }
  }

  // Delayed (>= 12h) transfer verification per active task family
  const activeFamilies = spec.taskFamilies.filter((f) => f.quota > 0 && !(spec.crunchMode.enabled && f.priority === "deferred"));
  let delayedPassedFamilyCount = 0;
  let delayedUnknownFamilyCount = 0;
  for (const f of activeFamilies) {
    const first = familyFirstActivityAt.get(f.id);
    const passes = familyUnseenPassEvents.get(f.id) || [];
    if (!first || passes.length === 0) continue;
    if (passes.some((p) => !p.atMs) || !first.atMs) {
      delayedUnknownFamilyCount += 1;
      continue;
    }
    const hasDelayedDistinctTransfer = passes.some(
      (p) => p.cardId !== first.cardId && p.atMs - first.atMs >= DELAYED_RETENTION_MS,
    );
    if (hasDelayedDistinctTransfer) delayedPassedFamilyCount += 1;
  }

  const delayedStatus = missingTimestampCount > 0 && delayedPassedFamilyCount === 0 && unseenIndependentPassCount > 0
    ? "unknown"
    : delayedPassedFamilyCount > 0 && delayedPassedFamilyCount >= activeFamilies.length && activeFamilies.length > 0
      ? "verified"
      : delayedPassedFamilyCount > 0
        ? "partial"
        : "not-yet-verified";

  const timedStatus = unseenIndependentPassCount === 0
    ? "not-yet-verified"
    : timedPassedCount === 0 && untimedUnknownCount > 0
      ? "unknown"
      : timedPassedCount > 0 && overBudgetCount === 0 && untimedUnknownCount === 0
        ? "verified"
        : timedPassedCount > 0
          ? "partial"
          : "over-budget";

  const misconceptions = [...misconceptionTallies.values()].map((m) => ({
    misconceptionId: m.id,
    reason: m.reason,
    occurrences: m.count,
    hypothesisType: m.count >= 2 ? "recurring-pattern" : "candidate-hypothesis",
    confirmedMisconception: m.count >= 2,
  }));

  const readyForExam = activeFamilies.length > 0
    && activeFamilies.every((f) => (familyUnseenPassEvents.get(f.id) || []).length > 0)
    && delayedPassedFamilyCount === activeFamilies.length
    && timedStatus === "verified";

  return {
    specVersion: spec.specVersion,
    materialCoverage,
    trainingCoverage,
    capabilityEvidence: {
      reviewFamiliarity: {
        reviewedCards,
        highStabilityCards,
        note: "复习熟练度仅表示见过的卡片间隔稳定，不代表未见变式独立考试能力。",
      },
      sameItemRepeatCount,
      assistedOrExposedCount,
      selfReportedCount,
      unknownLegacyCount,
      unseenIndependentPassCount,
      delayedIndependent: {
        thresholdHours: 12,
        passedFamilyCount: delayedPassedFamilyCount,
        totalActiveFamilyCount: activeFamilies.length,
        unknownFamilyCount: delayedUnknownFamilyCount,
        status: delayedStatus,
      },
      timedIndependent: {
        passedCount: timedPassedCount,
        overBudgetCount,
        untimedUnknownCount,
        status: timedStatus,
      },
      misconceptionHypotheses: misconceptions,
      readyForExam,
      verdict: readyForExam
        ? "已具备当前校准任务族的未见独立、隔日保持与限时通过证据"
        : unseenIndependentPassCount > 0
          ? "已有部分未见题独立通过证据，但尚未补齐全部重点任务族的隔日（≥12h）或限时验证"
          : materialCoverage.ratio >= 0.9 && publishedCards.length > 0
            ? "资料覆盖较高，但尚无复杂任务族的未见题独立通过证据（不能把记忆卡掌握度当考试准备度）"
            : "尚未建立未见题独立作答证据",
    },
  };
}

function cardSubpartsCount(card) {
  if (Array.isArray(card?.subquestions) && card.subquestions.length > 0) return card.subquestions.length;
  if (Array.isArray(card?.parts) && card.parts.length > 0) return card.parts.length;
  if (Array.isArray(card?.caseQuestions) && card.caseQuestions.length > 0) return card.caseQuestions.length;
  return 0;
}

function cardHasSharedMaterial(card) {
  return Boolean(cleanStr(card?.sharedMaterial, 50) || cleanStr(card?.caseText, 50) || cleanStr(card?.passage, 50));
}

function cardHasValidFigure(card) {
  if (card?.missingFigure === true) return false;
  return Boolean(
    (card?.figure && typeof card.figure === "object" && (card.figure.src || card.figure.svg || card.figure.assetId))
    || cleanStr(card?.imageUrl, 200)
    || cleanStr(card?.diagramSvg, 200),
  );
}

/**
 * Strict 同型模拟 (homomorphic mock-paper) composer (#853):
 * - Preserves subquestion trees (`subpartsCount > 1` never filled by scattered flat single questions)
 * - Enforces shared-material presence when `requiresSharedMaterial === true`
 * - Never silently converts missing required figures (`requiresFigure === true` or `card.requiresFigure === true`) into plain text
 * - Computes optional-section (`optionalChoose: { choose: K, total: N }`) marks & time over `K` only, never double-counting all `N`
 * - Never pads shortfalls with unrelated question kinds; emits machine-checkable `shortfalls`
 */
export function composeStrictMockPaper(state = {}, { course = "", examShape = {} } = {}) {
  const sectionsSpec = Array.isArray(examShape.sections) ? examShape.sections : [];
  const decks = (state?.decks || []).filter((d) => !d.archived && (!course || !d.course || d.course === course));
  const candidatePool = decks.flatMap((d) => (d.cards || []).map((c) => ({ card: c, deckId: d.id })));
  const usedCardIds = new Set();

  const composedSections = [];
  const shortfalls = [];
  let totalMarks = 0;
  let targetMarks = 0;
  let totalTimeSec = 0;

  for (let sIdx = 0; sIdx < sectionsSpec.length; sIdx += 1) {
    const sec = sectionsSpec[sIdx] || {};
    const sectionId = cleanStr(sec.id, 60) || `sec-${sIdx + 1}`;
    const title = cleanStr(sec.title, 120) || `第 ${sIdx + 1} 大题`;
    const allowedKinds = Array.isArray(sec.allowedKinds) && sec.allowedKinds.length
      ? sec.allowedKinds
      : [sec.kind || "quiz"];
    const optionalChoose = sec.optionalChoose && Number.isInteger(sec.optionalChoose.choose) && Number.isInteger(sec.optionalChoose.total)
      && sec.optionalChoose.choose > 0 && sec.optionalChoose.total >= sec.optionalChoose.choose
      ? { choose: sec.optionalChoose.choose, total: sec.optionalChoose.total }
      : null;

    const requiredPoolCount = optionalChoose ? optionalChoose.total : (Number.isInteger(sec.count) && sec.count > 0 ? sec.count : 1);
    const scoredItemCount = optionalChoose ? optionalChoose.choose : requiredPoolCount;
    const marksPerItem = Number.isFinite(Number(sec.marksPerItem)) && Number(sec.marksPerItem) > 0 ? Number(sec.marksPerItem) : 5;
    const timePerItemSec = Number.isInteger(sec.timePerItemSec) && sec.timePerItemSec > 0 ? sec.timePerItemSec : 180;
    const subpartsCount = Number.isInteger(sec.subpartsCount) && sec.subpartsCount > 1 ? sec.subpartsCount : 0;
    const requiresSharedMaterial = sec.requiresSharedMaterial === true;
    const requiresFigure = sec.requiresFigure === true;

    targetMarks += scoredItemCount * marksPerItem;

    const picked = [];
    let rejectedFlatSubparts = 0;
    let rejectedMissingMaterial = 0;
    let rejectedMissingFigure = 0;

    for (const item of candidatePool) {
      if (picked.length >= requiredPoolCount) break;
      const { card } = item;
      if (!card?.id || usedCardIds.has(card.id)) continue;
      if (!allowedKinds.includes(card.kind)) continue;
      if (card.variantMeta?.countsForOriginalTask === false || card.origin?.reason === "too-hard") continue;
      if (sec.taskFamilyId && card.taskFamilyId !== sec.taskFamilyId) continue;

      if (subpartsCount > 1 && cardSubpartsCount(card) < subpartsCount) {
        rejectedFlatSubparts += 1;
        continue;
      }
      if (requiresSharedMaterial && !cardHasSharedMaterial(card)) {
        rejectedMissingMaterial += 1;
        continue;
      }
      if ((requiresFigure || card.requiresFigure === true) && !cardHasValidFigure(card)) {
        rejectedMissingFigure += 1;
        continue;
      }

      usedCardIds.add(card.id);
      picked.push({
        cardId: card.id,
        deckId: item.deckId,
        kind: card.kind,
        prompt: clipText(card.prompt, 160),
        marks: marksPerItem,
        subpartsCount: cardSubpartsCount(card),
        hasSharedMaterial: cardHasSharedMaterial(card),
        hasFigure: cardHasValidFigure(card),
      });
    }

    const effectiveScoredCount = optionalChoose ? Math.min(optionalChoose.choose, picked.length) : picked.length;
    const sectionMarks = effectiveScoredCount * marksPerItem;
    const sectionTimeSec = effectiveScoredCount * timePerItemSec;
    totalMarks += sectionMarks;
    totalTimeSec += sectionTimeSec;

    if (picked.length < requiredPoolCount) {
      const missingCount = requiredPoolCount - picked.length;
      const reasons = [];
      if (rejectedFlatSubparts > 0) reasons.push("缺少保留小题层级结构（subquestions）的大题，拒绝用零散单题平铺替代");
      if (rejectedMissingMaterial > 0) reasons.push("缺少共用材料（sharedMaterial）题组");
      if (rejectedMissingFigure > 0) reasons.push("缺少必需配图资产（figure），拒绝静默改写为纯文字题");
      if (reasons.length === 0) reasons.push(`题库中符合题型（${allowedKinds.join("/")}）的可用题数量不足，拒绝拿无关题型凑数`);
      shortfalls.push({
        sectionId,
        title,
        requested: requiredPoolCount,
        fulfilled: picked.length,
        missing: missingCount,
        rejectedFlatSubparts,
        rejectedMissingMaterial,
        rejectedMissingFigure,
        reason: reasons.join("；"),
      });
    }

    composedSections.push({
      sectionId,
      title,
      allowedKinds,
      requestedCount: requiredPoolCount,
      fulfilledCount: picked.length,
      ...(optionalChoose ? { optionalChoose, ruleNote: `选做规则：提供 ${optionalChoose.total} 题，任选 ${optionalChoose.choose} 题计分（按 ${optionalChoose.choose} 题计入总分与限时）` } : {}),
      marksPerItem,
      sectionMarks,
      targetSectionMarks: scoredItemCount * marksPerItem,
      sectionTimeSec,
      items: picked,
    });
  }

  return {
    ok: shortfalls.length === 0,
    complete: shortfalls.length === 0,
    noUnrelatedPadding: true,
    totalMarks,
    targetMarks,
    totalTimeSec,
    selectedCardIds: [...usedCardIds],
    sections: composedSections,
    shortfalls,
  };
}
