/* Versioned modular generation requirements, reference-continuity checks, conflict detection,
   and zero-call effective preview (#851 / #852 / #853). Pure and browser-safe. */

import { QUESTION_REFERENCE_FORMAT_DEFAULT, normalizeQuestionReferenceFormat, normalizeQuestionReferenceLimits } from "./question-references.js";

export const REQUIREMENTS_SCHEMA_VERSION = "req-v1";
export const EDITABLE_MODULE_IDS = Object.freeze(["reasoning", "distractors", "rubric"]);
export const LOCKED_PROTOCOL_MODULE_ID = "protocol_invariants";
export const MODULE_INSTRUCTION_MAX = 600;
export const TEMPLATE_NAME_MAX = 80;

const isPlainObject = (value) => !!value && typeof value === "object" && !Array.isArray(value);

function fnv1aHex(text) {
  const str = String(text ?? "");
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < str.length; i += 1) {
    hash ^= BigInt(str.charCodeAt(i));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return `${str.length}:${hash.toString(16).padStart(16, "0")}`;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .filter((key) => value[key] !== undefined)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  }
  return value;
}

/** Validate and normalize optional user-editable modular overrides; protocol invariants are strictly locked. */
export function normalizeModuleOverrides(raw, { strict = false } = {}) {
  if (raw === undefined || raw === null) return undefined;
  if (!isPlainObject(raw)) {
    if (strict) throw new Error("moduleOverrides must be an object");
    return undefined;
  }
  if (Object.hasOwn(raw, LOCKED_PROTOCOL_MODULE_ID) || Object.hasOwn(raw, "disableReview") || Object.hasOwn(raw, "disableCitations")) {
    throw new Error("Protocol invariants (JSON schema, verbatim citations, answer-leak checks, independent review) are read-only and cannot be disabled");
  }
  const allowedTop = new Set([...EDITABLE_MODULE_IDS, "templateName", "taskFamilies"]);
  for (const key of Object.keys(raw)) {
    if (!allowedTop.has(key)) {
      if (strict) throw new Error(`Unknown generation module override: ${key}`);
    }
  }
  const out = {};
  if (typeof raw.templateName === "string" && raw.templateName.trim()) {
    const trimmed = raw.templateName.trim();
    if (strict && trimmed.length > TEMPLATE_NAME_MAX) throw new Error(`templateName exceeds ${TEMPLATE_NAME_MAX} characters`);
    out.templateName = trimmed.slice(0, TEMPLATE_NAME_MAX);
  }
  for (const key of EDITABLE_MODULE_IDS) {
    const entry = raw[key];
    if (entry === undefined || entry === null) continue;
    if (!isPlainObject(entry)) {
      if (strict) throw new Error(`moduleOverrides.${key} must be an object`);
      continue;
    }
    const enabled = entry.enabled === undefined ? true : Boolean(entry.enabled);
    const instruction = typeof entry.instruction === "string" ? entry.instruction.trim() : "";
    if (strict && instruction.length > MODULE_INSTRUCTION_MAX) {
      throw new Error(`moduleOverrides.${key}.instruction exceeds ${MODULE_INSTRUCTION_MAX} characters`);
    }
    if (!enabled || instruction) {
      out[key] = {
        enabled,
        instruction: instruction.slice(0, MODULE_INSTRUCTION_MAX),
      };
    }
  }
  if (Array.isArray(raw.taskFamilies) && raw.taskFamilies.length) {
    out.taskFamilies = raw.taskFamilies
      .filter((item) => isPlainObject(item) && typeof item.id === "string" && item.id.trim())
      .slice(0, 20)
      .map((item) => ({
        id: item.id.trim().slice(0, 60),
        name: String(item.name || item.id).trim().slice(0, 120),
        ...(Array.isArray(item.forms) ? { forms: item.forms.filter((f) => typeof f === "string").slice(0, 8) } : {}),
        ...(Array.isArray(item.requiredSteps) ? { requiredSteps: item.requiredSteps.filter((s) => typeof s === "string" && s.trim()).map((s) => s.trim().slice(0, 200)).slice(0, 10) } : {}),
        ...(Array.isArray(item.misconceptions) ? { misconceptions: item.misconceptions.filter((s) => typeof s === "string" && s.trim()).map((s) => s.trim().slice(0, 200)).slice(0, 10) } : {}),
        ...(Array.isArray(item.rubricPoints) ? { rubricPoints: item.rubricPoints.filter((s) => typeof s === "string" && s.trim()).map((s) => s.trim().slice(0, 200)).slice(0, 10) } : {}),
        ...(Number.isInteger(item.quota) && item.quota >= 0 ? { quota: item.quota } : {}),
      }));
    if (!out.taskFamilies.length) delete out.taskFamilies;
  }
  return Object.keys(out).length ? out : undefined;
}

/** Compact prompt brief injected into planning, blueprint, authoring, repair, and review stages when moduleOverrides are active. */
export function moduleOverridesBrief(moduleOverrides) {
  const clean = normalizeModuleOverrides(moduleOverrides);
  if (!clean) return {};
  const rules = [];
  if (clean.reasoning) {
    rules.push(clean.reasoning.enabled === false
      ? "Reasoning module: keep direct single-step recall/check without forcing multi-step chains."
      : `Required reasoning & condition discrimination: ${clean.reasoning.instruction}`);
  }
  if (clean.distractors) {
    rules.push(clean.distractors.enabled === false
      ? "Distractor module: use standard plausible near-miss distractors without extra custom constraints."
      : `Distractor & misconception rules (distinct from surface wording style): ${clean.distractors.instruction}`);
  }
  if (clean.rubric) {
    rules.push(clean.rubric.enabled === false
      ? "Rubric module: use standard concise grading criteria."
      : `Marking & partial-credit rubric rules: ${clean.rubric.instruction}`);
  }
  if (clean.taskFamilies?.length) {
    rules.push(`Confirmed assessment task families (preserve required reasoning steps, misconceptions, and rubric criteria even when question form varies): ${JSON.stringify(clean.taskFamilies)}`);
  }
  if (!rules.length) return {};
  return {
    moduleRequirementsVersion: REQUIREMENTS_SCHEMA_VERSION,
    ...(clean.templateName ? { requirementTemplate: clean.templateName } : {}),
    moduleRequirements: rules,
  };
}

/** Fingerprint of resolved reference-question materials (`[{ id, title, chars, hash }]`). */
export function computeReferenceDigest(questionReferences = [], styleText = "") {
  const items = (Array.isArray(questionReferences) ? questionReferences : [])
    .filter((item) => item && typeof item.id === "string")
    .map((item) => ({
      id: item.id,
      title: String(item.title || ""),
      chars: typeof item.text === "string" ? item.text.length : 0,
      hash: fnv1aHex(item.text || ""),
    }));
  const trimmedStyle = typeof styleText === "string" ? styleText.trim() : "";
  return {
    items,
    ...(trimmedStyle ? { styleChars: trimmedStyle.length, styleHash: fnv1aHex(trimmedStyle) } : {}),
    digest: fnv1aHex(JSON.stringify(canonical({ items, styleHash: trimmedStyle ? fnv1aHex(trimmedStyle) : "" }))),
  };
}

/**
 * Deterministic digest of all requirement inputs that govern card validity & review credentials (#851 / #852).
 * Changing constraints, notation, reference materials/text, referenceFormat, or modular overrides produces a new digest.
 */
export function computeRequirementsDigest(request = {}) {
  const refSummary = request.referenceDigest?.items
    ? request.referenceDigest
    : computeReferenceDigest(request.questionReferences || [], request.case?.styleText ?? request.styleText ?? "");
  const normalizedKinds = Array.isArray(request.kinds) && request.kinds.length ? [...request.kinds] : [request.kind || "quiz"];
  const payload = {
    schema: REQUIREMENTS_SCHEMA_VERSION,
    kind: request.kind || "quiz",
    kinds: normalizedKinds.length > 1 ? normalizedKinds : undefined,
    kindCounts: isPlainObject(request.kindCounts) ? request.kindCounts : undefined,
    difficulty: request.difficulty || "mixed",
    focus: typeof request.focus === "string" ? request.focus.trim() : "",
    focusTopics: Array.isArray(request.focusTopics) ? [...request.focusTopics] : [],
    role: typeof request.role === "string" ? request.role.trim() : "",
    constraints: request.constraints || undefined,
    notation: request.notationResolved || request.notation || "auto",
    referenceFormat: normalizeQuestionReferenceFormat(request.referenceFormat || QUESTION_REFERENCE_FORMAT_DEFAULT),
    referenceDigest: refSummary.digest,
    moduleOverrides: normalizeModuleOverrides(request.moduleOverrides),
  };
  const digest = fnv1aHex(JSON.stringify(canonical(payload)));
  return {
    version: `${REQUIREMENTS_SCHEMA_VERSION}:${digest.slice(-8)}`,
    digest,
    referenceDigest: refSummary,
  };
}

/**
 * Resolve stored reference questions for repair / publication re-review (#851), checking against the
 * recorded `referenceDigest` so deleted or edited sample papers are reported honestly instead of
 * silently ignored or treated as unchanged original inputs.
 */
export function resolveStoredReferences(generation = {}, sources = []) {
  const ids = Array.isArray(generation?.referenceSourceIds) ? generation.referenceSourceIds.filter((id) => typeof id === "string" && id.trim()) : [];
  const referenceFormat = normalizeQuestionReferenceFormat(generation?.referenceFormat || QUESTION_REFERENCE_FORMAT_DEFAULT);
  const referenceLimits = normalizeQuestionReferenceLimits(generation?.referenceLimits);
  if (!ids.length) {
    return {
      questionReferences: [],
      referenceFormat,
      referenceLimits,
      status: "none",
      missingIds: [],
      modifiedIds: [],
    };
  }
  const recordedItems = new Map((generation?.referenceDigest?.items || []).map((item) => [item.id, item]));
  const questionReferences = [];
  const missingIds = [];
  const modifiedIds = [];
  for (const id of ids) {
    const found = (sources || []).find((source) => source && source.id === id && !source.archived && typeof source.text === "string" && source.text.trim());
    if (!found) {
      missingIds.push(id);
      continue;
    }
    const prior = recordedItems.get(id);
    if (prior && prior.hash && fnv1aHex(found.text) !== prior.hash) {
      modifiedIds.push(id);
    }
    questionReferences.push({ id: found.id, title: found.title, text: found.text });
  }
  const status = missingIds.length
    ? (questionReferences.length ? "partial-missing" : "all-missing")
    : modifiedIds.length
      ? "modified"
      : "intact";
  return {
    questionReferences,
    referenceFormat,
    referenceLimits,
    status,
    missingIds,
    modifiedIds,
  };
}

/** Detect human-understandable conflicts between chosen question kinds, quotas, and sample-paper adherence (#852). */
export function detectRequirementConflicts({ kinds = [], kindCounts, referenceFormat, questionReferences = [], count, language = "zh" } = {}) {
  const en = language === "en";
  const say = (zhText, enText) => (en ? enText : zhText);
  const conflicts = [];
  const hasRefs = Array.isArray(questionReferences) && questionReferences.length > 0;
  const refChars = hasRefs ? questionReferences.reduce((sum, item) => sum + (item.text?.length || 0), 0) : 0;

  if (kinds.includes("flashcard") && hasRefs && (referenceFormat === "strict" || refChars > 1500)) {
    conflicts.push({
      code: "flashcard-vs-strict-sample",
      severity: "warn",
      priority: "kind-over-reference",
      message: say(
        "闪卡侧重单点回忆，与严格多步骤样题不兼容：闪卡批次会优先保持单点问答，不会硬套长情景；若想按样题练多步推导，请改选「开放问答」或「单选题」。",
        "Flashcards target single-point recall and are incompatible with strict multi-step sample questions: flashcard batches keep focused recall instead of forcing long scenarios; switch to Open or Single-choice for multi-step reasoning.",
      ),
    });
  }
  if (kinds.includes("truefalse") && hasRefs && referenceFormat === "strict") {
    conflicts.push({
      code: "truefalse-vs-strict-sample",
      severity: "info",
      priority: "kind-over-reference",
      message: say(
        "判断题固定为二选一命题辨析，严格贴合度只会借鉴样题的易错条件，不会复制多选或分问结构。",
        "True/false questions use fixed two-choice statements; strict adherence borrows only misconception conditions rather than multi-option or sub-question layouts.",
      ),
    });
  }
  if (isPlainObject(kindCounts) && kinds.length >= 2) {
    const zeroKinds = kinds.filter((kind) => kindCounts[kind] === 0);
    if (zeroKinds.length) {
      conflicts.push({
        code: "zero-quota-kinds",
        severity: "info",
        priority: "explicit-quota",
        message: say(
          `已将 ${zeroKinds.join("、")} 的题数配额设为 0：本次生成与补题都不会分配该题型（不会退回均分）。`,
          `Quota for ${zeroKinds.join(", ")} is explicitly 0: neither generation nor continuation will allocate those types (no fallback to uniform split).`,
        ),
      });
    }
  }
  if (Number.isInteger(count) && count > 0 && count < kinds.length && !isPlainObject(kindCounts)) {
    conflicts.push({
      code: "count-below-kinds",
      severity: "warn",
      priority: "count-cap",
      message: say(
        `所选题型共 ${kinds.length} 种，但总题数仅 ${count} 道：排在后面的 ${kinds.length - count} 种题型本次分到 0 道。`,
        `${kinds.length} question types selected for only ${count} question(s): the last ${kinds.length - count} type(s) receive 0 questions this run.`,
      ),
    });
  }
  return conflicts;
}

/** Build zero-call pre-run effective requirements & stage rules preview from a prepared generation request (#852). */
export function buildEffectivePreview({ a = {}, s = {}, request = {}, sources = [], count, planGoal, planned = [], wantsCoverage = false, language = "zh" } = {}) {
  const en = language === "en";
  const say = (zhText, enText) => (en ? enText : zhText);
  const saved = s?.settings?.generation || {};
  const kinds = Array.isArray(request.kinds) && request.kinds.length ? request.kinds : [request.kind || "quiz"];
  const effectiveCount = wantsCoverage ? (planGoal || count || 0) : (count || request.count || 0);
  const { version, digest, referenceDigest } = computeRequirementsDigest(request);
  const overrides = normalizeModuleOverrides(request.moduleOverrides);
  const originOf = (key, explicitValue, inheritedCondition = false) => {
    if (explicitValue !== undefined && explicitValue !== "" && !(Array.isArray(explicitValue) && !explicitValue.length)) return "explicit";
    if (inheritedCondition) return "course";
    if (saved[key] !== undefined) return "default";
    return "default";
  };

  const origins = {
    kinds: originOf("kinds", a.kinds ?? a.kind),
    quota: isPlainObject(a.kindCounts) ? "explicit" : Number.isInteger(a.count) ? "explicit" : wantsCoverage ? "coverage-plan" : "default",
    difficulty: originOf("difficulty", a.difficulty),
    language: originOf("language", a.language),
    notation: a.notation && a.notation !== "auto" ? "explicit" : "auto-detected",
    focus: a.focus ? "explicit" : "default",
    focusTopics: Array.isArray(a.focusTopics) && a.focusTopics.length ? "explicit" : (request.focusTopics?.length ? "course" : "none"),
    references: request.questionReferences?.length || request.case?.styleText ? "explicit" : "none",
    moduleOverrides: overrides ? "explicit" : "default",
  };

  const partSummary = (planned || []).reduce((acc, part) => {
    acc[part.kind] = (acc[part.kind] || 0) + (part.count || 0);
    return acc;
  }, {});

  const modules = [
    {
      id: "scope_and_quota",
      locked: false,
      title: say("题型与配额分配", "Question types & quota allocation"),
      origin: origins.quota,
      unit: request.kind === "case" ? "case-question" : "question",
      kinds,
      kindCounts: request.kindCounts || partSummary,
      totalQuestions: effectiveCount,
      parts: planned?.length || 1,
      unsupportedNote: request.kind !== "case"
        ? say("当前按「题数（独立题目）」精确分配；按分值或预计作答时长反推题数仅作估算展示，不冒充已生效自动配比。", "Quotas allocate exact question counts; marks and answering-time conversions are shown as estimates only, not active auto-allocation.")
        : null,
    },
    {
      id: "focus_and_difficulty",
      locked: false,
      title: say("难度、侧重点与课程重点继承", "Difficulty, focus & course highlights"),
      origin: origins.focusTopics === "course" ? "course" : origins.focus,
      difficulty: request.difficulty,
      focus: request.focus || "",
      focusTopics: request.focusTopics || [],
      role: request.role || "",
      language: request.language,
      notation: request.notationResolved || request.notation || "text",
    },
    {
      id: "reference_adherence",
      locked: false,
      title: say("参考样题与贴合边界（仅作形式参考，不作事实出处）", "Reference questions & adherence (form only, never factual evidence)"),
      origin: origins.references,
      referenceFormat: request.referenceFormat || QUESTION_REFERENCE_FORMAT_DEFAULT,
      referenceLimits: request.referenceLimits,
      references: (request.questionReferences || []).map((ref) => ({ id: ref.id, title: ref.title, chars: ref.text.length })),
      separationNote: say(
        "措辞/版式贴合（由参考样题与贴合度控制）与关键推理/错因要求（由下方业务模块控制）分开生效；样题绝不进入事实引文池。",
        "Surface layout/style adherence (from reference questions) is separate from required reasoning & misconception rules (from modules below); sample questions never enter the factual citation pool.",
      ),
    },
    {
      id: "reasoning_and_distractors",
      locked: false,
      title: say("关键推理、干扰项错因与评分要点模块", "Key reasoning, distractor misconceptions & rubric module"),
      origin: origins.moduleOverrides,
      templateName: overrides?.templateName || null,
      overrides: overrides || {},
    },
    {
      id: LOCKED_PROTOCOL_MODULE_ID,
      locked: true,
      title: say("系统基础安全约束（只读）", "System protocol & integrity safeguards (read-only)"),
      origin: "system",
      rules: [
        say("JSON 结构协议与字段校验不可关闭", "JSON protocol schema & field validation (always on)"),
        say("仅从所选证据资料逐字核对引文出处", "Verbatim citation verification against selected evidence sources only"),
        say("题干与提示禁止泄露答案，独立审阅阶段不可跳过", "Stem/hint answer-leak guard & mandatory independent review"),
      ],
    },
  ];

  const stages = [
    {
      id: "plan",
      label: say("阶段 1 · 知识与目标规划", "Stage 1 · Knowledge & target planning"),
      containsSolution: false,
      determinedInputs: [
        say(`${sources.length} 份证据资料（按原文前缀排在请求最前以便缓存）`, `${sources.length} evidence material(s) (ordered sources-first for prefix caching)`),
        ...(request.focusTopics?.length ? [say(`继承课程重点 ${request.focusTopics.length} 项`, `${request.focusTopics.length} inherited course focus topic(s)`)] : []),
        ...(overrides ? [say("已注入模块化推理/错因要求", "Active modular reasoning/misconception requirements injected")] : []),
      ],
      pendingInputs: [say("小节逐句引文与去重后的具体目标列表（运行后由本阶段产出）", "Verbatim section quotes and deduplicated learning targets (produced at runtime)")],
    },
    {
      id: "blueprint",
      label: say("阶段 2 · 答案蓝图与条件设计", "Stage 2 · Answer blueprint & decisive conditions"),
      containsSolution: true,
      determinedInputs: [
        say(`公式写法：${request.notationResolved || request.notation || "text"}；难度：${request.difficulty}`, `Notation: ${request.notationResolved || request.notation || "text"}; Difficulty: ${request.difficulty}`),
        ...(overrides?.reasoning || overrides?.distractors || overrides?.rubric
          ? [say("已启用自定义推理步骤 / 干扰项错因 / 评分标准模块", "Custom reasoning / distractor / rubric module overrides active")]
          : [say("默认比较轴、决定性条件与错因干扰项规则", "Default comparison-axis, decisive-condition & misconception distractor rules")]),
      ],
      pendingInputs: [say("阶段 1 验证通过的知识目标与引文（开始前尚不存在，不预填假蓝图）", "Verified targets & quotes from Stage 1 (pending runtime; never faked pre-run)")],
    },
    {
      id: "author",
      label: say("阶段 3 · 写题与自查", "Stage 3 · Question authoring & self-check"),
      containsSolution: true,
      determinedInputs: [
        ...(request.questionReferences?.length
          ? [say(`参考样题 ${request.questionReferences.length} 份（贴合度：${request.referenceFormat}）`, `${request.questionReferences.length} reference material(s) (adherence: ${request.referenceFormat})`)]
          : [say("未使用参考样题，按标准教学清晰度写题", "No reference questions selected; standard instructional clarity")]),
      ],
      pendingInputs: [say("阶段 2 锁定的答案蓝图、选项真值与评分要点", "Locked answer blueprint, option truth values & rubric from Stage 2")],
    },
    {
      id: "review",
      label: say("阶段 4 · 独立审阅与按需修题", "Stage 4 · Independent review & bounded repair"),
      containsSolution: true,
      determinedInputs: [
        say("六维独立审阅（自包含、不漏答案、选项区分度、学习价值、原文支撑、解析质量）", "6-check independent review (selfContained, answerLeak, optionQuality, learningValue, sourceSupport, explanationQuality)"),
        ...(request.questionReferences?.length
          ? [say("复审与文字修复同步携带同一份样题与贴合度规格", "Repair and publication re-review carry the exact same reference questions & adherence")]
          : []),
      ],
      pendingInputs: [say("候选题目与本地程序校验结果；运行中补充说明仅对尚未开始的后续阶段生效", "Candidate cards & local check findings; mid-run messages apply only to subsequent unstarted stages")],
    },
  ];

  const conflicts = detectRequirementConflicts({
    kinds,
    kindCounts: request.kindCounts,
    referenceFormat: request.referenceFormat,
    questionReferences: request.questionReferences,
    count: effectiveCount,
    language: en ? "en" : "zh",
  });

  return {
    previewOnly: true,
    modelCalls: 0,
    requirementsVersion: version,
    requirementsDigest: digest,
    referenceDigest,
    origins,
    summary: {
      course: request.course || "",
      kinds,
      kindCounts: request.kindCounts || partSummary,
      totalQuestions: effectiveCount,
      parts: planned?.length || 1,
      difficulty: request.difficulty,
      language: request.language,
      notation: request.notationResolved || request.notation || "text",
      evidenceSourceCount: sources.length,
      referenceSourceCount: request.questionReferences?.length || 0,
      referenceFormat: request.referenceFormat || QUESTION_REFERENCE_FORMAT_DEFAULT,
      tokenBudget: request.tokenBudget || null,
    },
    modules,
    stages,
    conflicts,
  };
}
