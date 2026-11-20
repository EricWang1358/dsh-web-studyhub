export const LEARNER_PREFERENCES_MAX = 12;
export const LEARNER_PREFERENCE_MAX_CHARS = 120;
export const LEARNER_BULLETS_MAX = 10;
export const LEARNER_BULLET_MAX_CHARS = 140;
export const LEARNER_BULLET_REFS_MAX = 6;
export const LEARNER_BULLET_SOURCES = Object.freeze(["coach", "user", "retell"]);
export const LEARNER_BULLET_REF_KINDS = Object.freeze(["card", "hid", "companion"]);

const collapseText = (value) => (typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "");

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
  return {
    ...base,
    ...l,
    consent: { ...base.consent, ...(l.consent || {}) },
    goal: typeof l.goal === "string" ? l.goal : "",
    preferences: cleanLearnerPreferences(l.preferences),
    summary: typeof l.summary === "string" ? l.summary : "",
    bullets: cleanLearnerBullets(l.bullets, { now: typeof l.updatedAt === "string" && l.updatedAt.trim() ? l.updatedAt.trim() : "" }),
    signals: { ...base.signals, ...(l.signals || {}) },
    levels: { ...(l.levels || {}) },
    solutionExposures: Array.isArray(l.solutionExposures) ? l.solutionExposures : [],
    examCoach: l.examCoach && typeof l.examCoach === "object" && !Array.isArray(l.examCoach) ? { ...l.examCoach } : {},
    memoryRevision: Number.isSafeInteger(l.memoryRevision) && l.memoryRevision >= 0 ? l.memoryRevision : 0,
    prepRevision: Number.isSafeInteger(l.prepRevision) && l.prepRevision >= 0 ? l.prepRevision : 0,
  };
}
