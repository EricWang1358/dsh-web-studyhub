export const LEARNER_PREFERENCES_MAX = 12;
export const LEARNER_PREFERENCE_MAX_CHARS = 120;
export const LEARNER_BULLETS_MAX = 10;
export const LEARNER_BULLET_MAX_CHARS = 140;
export const LEARNER_BULLET_REFS_MAX = 6;
export const LEARNER_BULLET_SOURCES = Object.freeze(["coach", "user", "retell"]);
export const LEARNER_BULLET_REF_KINDS = Object.freeze(["card", "hid", "companion"]);

export const LEARNER_ATOMIC_FACTS_MAX = 60;
export const LEARNER_ATOMIC_FACTS_PER_COURSE_MAX = 20;
export const LEARNER_ATOMIC_FACT_MAX_CHARS = 180;
export const LEARNER_ATOMIC_FACT_KINDS = Object.freeze([
  "misconception",
  "weakness",
  "strength",
  "preference",
  "strategy",
  "goal",
]);
export const LEARNER_ATOMIC_FACT_SOURCES = Object.freeze(["coach", "user", "retell"]);
export const LEARNER_ATOMIC_FACT_HALF_LIFE_DAYS = 30;
export const LEARNER_ATOMIC_FACT_MIN_CONFIDENCE = 0.15;

const DAY_MS = 864e5;
const FACT_SEGMENTER = typeof Intl !== "undefined" && typeof Intl.Segmenter === "function"
  ? new Intl.Segmenter("zh", { granularity: "word" })
  : null;

const collapseText = (value) => (typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "");
const clampConfidence = (value, fallback = 0.7) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.round(Math.min(1, Math.max(0.05, n)) * 10000) / 10000;
};
const normKey = (value) => collapseText(value).normalize("NFKC").toLowerCase();

function factTokens(text) {
  const clean = normKey(text);
  if (!clean) return new Set();
  const out = new Set();
  for (const match of clean.matchAll(/[a-z0-9][a-z0-9_+-]{1,}/g)) out.add(match[0]);
  if (FACT_SEGMENTER) {
    for (const part of FACT_SEGMENTER.segment(clean)) {
      if (part.isWordLike && /[\u3400-\u9fff]/u.test(part.segment) && part.segment.length >= 2) out.add(part.segment);
    }
  } else {
    for (const match of clean.matchAll(/[\u3400-\u9fff]{2,}/gu)) out.add(match[0]);
  }
  if (!out.size) out.add(clean);
  return out;
}

function tokenJaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const tok of a) if (b.has(tok)) inter++;
  const union = a.size + b.size - inter;
  return union > 0 ? inter / union : 0;
}

function deterministicFactId(course, topic, kind, statement) {
  const input = `${normKey(course)}|${normKey(topic)}|${kind}|${normKey(statement)}`;
  let hash = 2166136261;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return `af-${hash.toString(36).padStart(7, "0")}`;
}

/** Normalize one structured atomic learner fact (Mem0/Letta-inspired partitioned memory entry). */
export function cleanAtomicFact(item, { strict = false, now = new Date().toISOString(), fallbackId = "" } = {}) {
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    if (strict) throw new Error("原子记忆条目格式无效");
    return null;
  }
  const rawStatement = collapseText(item.statement ?? item.text);
  if (!rawStatement) {
    if (strict) throw new Error("原子记忆内容 statement 不能为空");
    return null;
  }
  if (strict && rawStatement.length > LEARNER_ATOMIC_FACT_MAX_CHARS) {
    throw new Error(`每条原子记忆不超过 ${LEARNER_ATOMIC_FACT_MAX_CHARS} 字`);
  }
  const statement = rawStatement.slice(0, LEARNER_ATOMIC_FACT_MAX_CHARS).trim();
  const course = collapseText(item.course).slice(0, 120);
  const topic = collapseText(item.topic).slice(0, 120);
  const rawKind = typeof item.kind === "string" ? item.kind.trim().toLowerCase() : "";
  if (strict && rawKind && !LEARNER_ATOMIC_FACT_KINDS.includes(rawKind)) {
    throw new Error(`未知原子记忆类型：${rawKind}`);
  }
  const kind = LEARNER_ATOMIC_FACT_KINDS.includes(rawKind) ? rawKind : "weakness";
  const rawSource = typeof item.source === "string" ? item.source.trim().toLowerCase() : "";
  if (strict && rawSource && !LEARNER_ATOMIC_FACT_SOURCES.includes(rawSource)) {
    throw new Error(`未知原子记忆来源：${rawSource}`);
  }
  const source = LEARNER_ATOMIC_FACT_SOURCES.includes(rawSource) ? rawSource : "coach";
  const rawConf = item.confidence === undefined ? 0.7 : Number(item.confidence);
  if (strict && (!Number.isFinite(rawConf) || rawConf < 0 || rawConf > 1)) {
    throw new Error("原子记忆置信度 confidence 必须在 0 到 1 之间");
  }
  const confidence = clampConfidence(rawConf, 0.7);
  const rawEvidence = item.evidenceCount === undefined ? 1 : Number(item.evidenceCount);
  if (strict && (!Number.isInteger(rawEvidence) || rawEvidence < 1)) {
    throw new Error("原子记忆证据计数 evidenceCount 必须是大于等于 1 的整数");
  }
  const evidenceCount = Number.isFinite(rawEvidence) && rawEvidence >= 1 ? Math.min(999, Math.floor(rawEvidence)) : 1;
  const rawUpdated = typeof item.updatedAt === "string" && Number.isFinite(Date.parse(item.updatedAt))
    ? new Date(item.updatedAt).toISOString()
    : (typeof now === "string" && now.trim() ? now.trim() : new Date().toISOString());
  const id = collapseText(item.id) || fallbackId || deterministicFactId(course, topic, kind, statement);
  return {
    id: id.slice(0, 64),
    course,
    topic,
    kind,
    statement,
    confidence,
    updatedAt: rawUpdated,
    evidenceCount,
    ...(source !== "coach" ? { source } : {}),
  };
}

/** Normalize a list of atomic learner facts (deduplicated by id, bounded by `maxTotal`). */
export function cleanAtomicFacts(value, { strict = false, now = new Date().toISOString(), maxTotal = LEARNER_ATOMIC_FACTS_MAX } = {}) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    if (strict) throw new Error("atomicFacts 必须是数组");
    return [];
  }
  const out = [];
  const seenIds = new Set();
  for (let i = 0; i < value.length; i++) {
    const clean = cleanAtomicFact(value[i], { strict, now });
    if (!clean || seenIds.has(clean.id)) continue;
    seenIds.add(clean.id);
    out.push(clean);
    if (!strict && out.length >= maxTotal) break;
  }
  if (strict && out.length > maxTotal) {
    throw new Error(`原子记忆最多保存 ${maxTotal} 条`);
  }
  return out;
}

/**
 * Exponential time-decayed confidence for an atomic fact.
 * Higher `evidenceCount` slows decay (`halfLife * (1 + 0.5 * log2(evidenceCount))`).
 */
export function effectiveAtomicConfidence(fact, {
  now = Date.now(),
  halfLifeDays = LEARNER_ATOMIC_FACT_HALF_LIFE_DAYS,
} = {}) {
  if (!fact || typeof fact !== "object") return 0;
  const base = clampConfidence(fact.confidence, 0.5);
  const updatedMs = Date.parse(fact.updatedAt);
  const nowMs = typeof now === "number" ? now : Date.parse(now);
  if (!Number.isFinite(updatedMs) || !Number.isFinite(nowMs) || nowMs <= updatedMs) return base;
  const elapsedDays = (nowMs - updatedMs) / DAY_MS;
  const evidence = Math.max(1, Number(fact.evidenceCount) || 1);
  const halfLife = Math.max(1, Number(halfLifeDays) || LEARNER_ATOMIC_FACT_HALF_LIFE_DAYS) * (1 + 0.5 * Math.log2(evidence));
  const decayed = base * Math.pow(0.5, elapsedDays / halfLife);
  return Math.round(decayed * 10000) / 10000;
}

/** Apply time decay to a list of atomic facts and prune stale entries below `minConfidence`. Pure. */
export function decayAtomicFacts(facts, {
  now = Date.now(),
  halfLifeDays = LEARNER_ATOMIC_FACT_HALF_LIFE_DAYS,
  minConfidence = LEARNER_ATOMIC_FACT_MIN_CONFIDENCE,
} = {}) {
  const nowIso = typeof now === "string" ? now : new Date(now).toISOString();
  const clean = cleanAtomicFacts(facts, { now: nowIso, maxTotal: LEARNER_ATOMIC_FACTS_MAX * 2 });
  const out = [];
  for (const fact of clean) {
    const decayed = effectiveAtomicConfidence(fact, { now, halfLifeDays });
    if (decayed < minConfidence) continue;
    out.push({ ...fact, confidence: Math.max(0.05, decayed) });
  }
  return out;
}

const isUserFact = (fact) => fact?.source === "user" || fact?.source === "retell";

/**
 * Mem0/Letta-style incremental merge of incoming atomic facts into existing partitioned facts:
 * - Decays and prunes expired facts first.
 * - Deduplicates exact or high-overlap near-duplicate facts within the same `(course, topic, kind)`,
 *   reinforcing `evidenceCount` and `confidence` rather than overwriting.
 * - Attenuates contradicting opposite polarity (`strength` vs `weakness`) on the same `(course, topic)`.
 * - Enforces per-course and global caps without letting one course evict another course's memory.
 */
export function mergeAtomicFacts(existing, incoming, {
  now = new Date().toISOString(),
  halfLifeDays = LEARNER_ATOMIC_FACT_HALF_LIFE_DAYS,
  minConfidence = LEARNER_ATOMIC_FACT_MIN_CONFIDENCE,
  maxTotal = LEARNER_ATOMIC_FACTS_MAX,
  maxPerCourse = LEARNER_ATOMIC_FACTS_PER_COURSE_MAX,
  similarityThreshold = 0.65,
} = {}) {
  const nowIso = typeof now === "string" && Number.isFinite(Date.parse(now)) ? new Date(now).toISOString() : new Date().toISOString();
  const nowMs = Date.parse(nowIso);
  const current = decayAtomicFacts(existing, { now: nowMs, halfLifeDays, minConfidence }).map((fact) => ({ ...fact }));
  const fresh = cleanAtomicFacts(incoming, { now: nowIso, maxTotal: maxTotal * 2 });

  const samePartition = (a, b) => normKey(a.course) === normKey(b.course) && normKey(a.topic) === normKey(b.topic);
  const findSimilar = (candidate) => {
    const candText = normKey(candidate.statement);
    const candTokens = factTokens(candidate.statement);
    for (const item of current) {
      if (!samePartition(item, candidate) || item.kind !== candidate.kind) continue;
      if (item.id === candidate.id || normKey(item.statement) === candText) return item;
      if (tokenJaccard(factTokens(item.statement), candTokens) >= similarityThreshold) return item;
    }
    return null;
  };

  for (const cand of fresh) {
    // Attenuate opposing strength <-> weakness on the same (course, topic) when new strong evidence arrives.
    if ((cand.kind === "strength" || cand.kind === "weakness") && cand.topic && cand.confidence >= 0.65) {
      const opposite = cand.kind === "strength" ? "weakness" : "strength";
      for (const item of current) {
        if (samePartition(item, cand) && item.kind === opposite && !isUserFact(item)) {
          item.confidence = Math.round(item.confidence * 0.45 * 10000) / 10000;
        }
      }
    }

    const hit = findSimilar(cand);
    if (hit) {
      const mergedEvidence = Math.min(999, hit.evidenceCount + cand.evidenceCount);
      const reinforced = 1 - (1 - hit.confidence) * (1 - cand.confidence * 0.85);
      hit.confidence = Math.round(Math.min(0.99, Math.max(hit.confidence, cand.confidence, reinforced)) * 10000) / 10000;
      hit.evidenceCount = mergedEvidence;
      const candNewer = Date.parse(cand.updatedAt) >= Date.parse(hit.updatedAt);
      if (candNewer) hit.updatedAt = cand.updatedAt;
      if (!isUserFact(hit) && (isUserFact(cand) || (candNewer && cand.statement.length >= hit.statement.length * 0.75))) {
        hit.statement = cand.statement;
        if (cand.source) hit.source = cand.source;
      }
      continue;
    }

    const existsId = current.some((item) => item.id === cand.id);
    current.push(existsId ? { ...cand, id: `${cand.id.slice(0, 56)}-${current.length + 1}` } : { ...cand });
  }

  // Drop facts attenuated below threshold.
  const surviving = current.filter((fact) => isUserFact(fact) || fact.confidence >= minConfidence);
  const rankScore = (fact) => {
    const conf = effectiveAtomicConfidence(fact, { now: nowMs, halfLifeDays });
    const evidenceBoost = 1 + 0.15 * Math.log2(Math.max(1, fact.evidenceCount));
    return conf * evidenceBoost + (isUserFact(fact) ? 0.35 : 0);
  };

  // Partitioned per-course cap so one busy course never wipes out another course's memory.
  const byCourse = new Map();
  for (const fact of surviving) {
    const cKey = normKey(fact.course);
    if (!byCourse.has(cKey)) byCourse.set(cKey, []);
    byCourse.get(cKey).push(fact);
  }
  const perCourseKept = [];
  for (const list of byCourse.values()) {
    list.sort((a, b) => rankScore(b) - rankScore(a) || Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || a.id.localeCompare(b.id));
    perCourseKept.push(...list.slice(0, maxPerCourse));
  }
  perCourseKept.sort((a, b) => rankScore(b) - rankScore(a) || Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || a.id.localeCompare(b.id));
  return perCourseKept.slice(0, maxTotal);
}

/** Select course/topic-partitioned atomic facts ranked by decayed confidence and evidence count. */
export function selectAtomicFacts(facts, {
  course = "",
  topic = "",
  limit = 12,
  now = Date.now(),
  halfLifeDays = LEARNER_ATOMIC_FACT_HALF_LIFE_DAYS,
  minConfidence = LEARNER_ATOMIC_FACT_MIN_CONFIDENCE,
  includeCoach = true,
  resolveCourse = null,
} = {}) {
  const courseTarget = normKey(course);
  const topicTarget = normKey(topic);
  const decayed = decayAtomicFacts(facts, { now, halfLifeDays, minConfidence });
  const filtered = decayed.filter((fact) => {
    if (!includeCoach && !isUserFact(fact)) return false;
    if (courseTarget && fact.course) {
      const resolved = typeof resolveCourse === "function" ? resolveCourse(fact.course) : fact.course;
      if (normKey(resolved) !== courseTarget) return false;
    }
    if (topicTarget && fact.topic && normKey(fact.topic) !== topicTarget) return false;
    return true;
  });
  filtered.sort((a, b) => {
    const aCourseMatch = courseTarget && a.course ? 1 : 0;
    const bCourseMatch = courseTarget && b.course ? 1 : 0;
    const aScore = a.confidence * (1 + 0.15 * Math.log2(a.evidenceCount)) + aCourseMatch * 0.2;
    const bScore = b.confidence * (1 + 0.15 * Math.log2(b.evidenceCount)) + bCourseMatch * 0.2;
    return bScore - aScore || Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || a.id.localeCompare(b.id);
  });
  return filtered.slice(0, Math.max(1, Math.round(Number(limit) || 12)));
}

/** Project top atomic facts into a backward-compatible <=300 char summary string. */
export function summarizeAtomicFacts(facts, { course = "", maxChars = 300, now = Date.now(), includeCoach = true } = {}) {
  const top = selectAtomicFacts(facts, { course, limit: 8, now, includeCoach });
  if (!top.length) return "";
  const parts = [];
  let len = 0;
  for (const fact of top) {
    const prefix = fact.topic ? `${fact.topic}：` : "";
    const piece = `${prefix}${fact.statement}`.replace(/[。；;]+$/u, "");
    const sep = parts.length ? "；" : "";
    if (len + sep.length + piece.length + 1 > maxChars) {
      if (!parts.length) {
        const room = Math.max(1, maxChars - 1);
        return `${piece.slice(0, room).trimEnd()}…`;
      }
      break;
    }
    parts.push(piece);
    len += sep.length + piece.length;
  }
  return parts.length ? `${parts.join("；")}。` : "";
}

/** Normalize a single typed local anchor on a learner bullet, or throw in strict mode when invalid. */
export function cleanLearnerBulletRef(ref, { strict = false } = {}) {
  if (!ref || typeof ref !== "object" || Array.isArray(ref)) {
    if (strict) throw new Error("溯源锚点格式无效");
    return null;
  }
  const kind = typeof ref.kind === "string" ? ref.kind.trim() : "";
  if (kind === "card") {
    const deckId = collapseText(ref.deckId);
    const cardId = collapseText(ref.cardId);
    if (!deckId || !cardId) {
      if (strict) throw new Error("题目溯源锚点需要 deckId 与 cardId");
      return null;
    }
    return { kind: "card", deckId, cardId };
  }
  if (kind === "hid") {
    const course = collapseText(ref.course);
    const hid = collapseText(ref.hid);
    if (!course || !hid) {
      if (strict) throw new Error("全书溯源锚点需要 course 与 hid");
      return null;
    }
    return { kind: "hid", course, hid };
  }
  if (kind === "companion") {
    const companionId = collapseText(ref.companionId);
    if (!companionId) {
      if (strict) throw new Error("伴学溯源锚点需要 companionId");
      return null;
    }
    let slide;
    if (ref.slide !== undefined && ref.slide !== null && ref.slide !== "") {
      const n = Number(ref.slide);
      if (!Number.isInteger(n) || n < 1) {
        if (strict) throw new Error("伴学页码 slide 必须是大于等于 1 的整数");
        return null;
      }
      slide = n;
    }
    return { kind: "companion", companionId, ...(slide !== undefined ? { slide } : {}) };
  }
  if (strict) throw new Error(`未知溯源锚点类型：${kind || "空"}`);
  return null;
}

const bulletRefKey = (ref) => (
  ref.kind === "card" ? `card:${ref.deckId}:${ref.cardId}`
    : ref.kind === "hid" ? `hid:${ref.course}:${ref.hid}`
      : `companion:${ref.companionId}:${ref.slide ?? ""}`
);

/** Normalize one traceable learner bullet (<=140 chars, strongly typed local refs). */
export function cleanLearnerBullet(item, { strict = false, now = new Date().toISOString(), fallbackId = "" } = {}) {
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    if (strict) throw new Error("学习要点格式无效");
    return null;
  }
  const rawText = collapseText(item.text);
  if (!rawText) {
    if (strict) throw new Error("学习要点内容不能为空");
    return null;
  }
  if (strict && rawText.length > LEARNER_BULLET_MAX_CHARS) {
    throw new Error(`每条学习要点不超过 ${LEARNER_BULLET_MAX_CHARS} 字`);
  }
  const text = rawText.slice(0, LEARNER_BULLET_MAX_CHARS).trim();
  const id = collapseText(item.id) || fallbackId;
  if (!id) {
    if (strict) throw new Error("学习要点缺少 id");
    return null;
  }
  const rawSource = typeof item.source === "string" ? item.source.trim() : "";
  if (strict && rawSource && !LEARNER_BULLET_SOURCES.includes(rawSource)) {
    throw new Error(`未知要点来源：${rawSource}`);
  }
  const source = LEARNER_BULLET_SOURCES.includes(rawSource) ? rawSource : (strict ? "user" : "coach");
  const course = collapseText(item.course);
  const rawRefs = item.refs === undefined ? [] : item.refs;
  if (strict && !Array.isArray(rawRefs)) throw new Error("溯源锚点 refs 必须是数组");
  const refs = [];
  const seenRefs = new Set();
  for (const entry of Array.isArray(rawRefs) ? rawRefs : []) {
    const clean = cleanLearnerBulletRef(entry, { strict });
    if (!clean) continue;
    const key = bulletRefKey(clean);
    if (seenRefs.has(key)) continue;
    seenRefs.add(key);
    refs.push(clean);
    if (refs.length >= LEARNER_BULLET_REFS_MAX) break;
  }
  const updatedAt = typeof item.updatedAt === "string" && item.updatedAt.trim() ? item.updatedAt.trim() : now;
  return {
    id,
    text,
    ...(course ? { course } : {}),
    refs,
    source,
    updatedAt,
  };
}

/** Normalize a list of traceable learner bullets (max 10 items, <=140 chars each). */
export function cleanLearnerBullets(value, { strict = false, now = new Date().toISOString() } = {}) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    if (strict) throw new Error("bullets 必须是数组");
    return [];
  }
  const out = [];
  const seenIds = new Set();
  for (let i = 0; i < value.length; i++) {
    const clean = cleanLearnerBullet(value[i], { strict, now, fallbackId: strict ? "" : `b-${i + 1}` });
    if (!clean || seenIds.has(clean.id)) continue;
    seenIds.add(clean.id);
    out.push(clean);
    if (!strict && out.length >= LEARNER_BULLETS_MAX) break;
  }
  if (strict && out.length > LEARNER_BULLETS_MAX) {
    throw new Error(`学习要点最多保存 ${LEARNER_BULLETS_MAX} 条`);
  }
  return out;
}

/** Normalize a stored list of free-form learner preferences without throwing on legacy data. */
export function cleanLearnerPreferences(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  const seen = new Set();
  for (const item of value) {
    if (typeof item !== "string") continue;
    const text = item.replace(/\s+/g, " ").trim().slice(0, LEARNER_PREFERENCE_MAX_CHARS).trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
    if (out.length >= LEARNER_PREFERENCES_MAX) break;
  }
  return out;
}

/** Learner profile defaults, shared by storage normalization and the coach. */
export function emptyLearner() {
  return {
    consent: { prep: null },
    goal: "",
    preferences: [],
    summary: "",
    bullets: [],
    atomicFacts: [],
    signals: { got: 0, confused: 0, easy: 0, hard: 0, up: 0, down: 0 },
    levels: {},
    solutionExposures: [],
    examCoach: {},
    updatedAt: null,
    memoryRevision: 0,
    prepRevision: 0,
  };
}
/** A complete learner record built from whatever an older library stored. */
export function normalizeLearner(value) {
  const l = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const base = emptyLearner();
  const fallbackNow = typeof l.updatedAt === "string" && l.updatedAt.trim() ? l.updatedAt.trim() : "";
  return {
    ...base,
    ...l,
    consent: { ...base.consent, ...(l.consent || {}) },
    goal: typeof l.goal === "string" ? l.goal : "",
    preferences: cleanLearnerPreferences(l.preferences),
    summary: typeof l.summary === "string" ? l.summary : "",
    bullets: cleanLearnerBullets(l.bullets, { now: fallbackNow }),
    atomicFacts: cleanAtomicFacts(l.atomicFacts, { now: fallbackNow || new Date().toISOString() }),
    signals: { ...base.signals, ...(l.signals || {}) },
    levels: { ...(l.levels || {}) },
    solutionExposures: Array.isArray(l.solutionExposures) ? l.solutionExposures : [],
    examCoach: l.examCoach && typeof l.examCoach === "object" && !Array.isArray(l.examCoach) ? { ...l.examCoach } : {},
    memoryRevision: Number.isSafeInteger(l.memoryRevision) && l.memoryRevision >= 0 ? l.memoryRevision : 0,
    prepRevision: Number.isSafeInteger(l.prepRevision) && l.prepRevision >= 0 ? l.prepRevision : 0,
  };
}
