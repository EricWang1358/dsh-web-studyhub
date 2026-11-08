/* Pure solution-exposure and unseen-status contract (#852 / #847 / #853).
   Whenever a learner reveals, copies, or exports stage requests containing answer blueprints,
   option truth values, candidate answers, or marking rubrics — or inspects answers/explanations
   during representative sample calibration — an immutable exposure receipt is recorded on
   `learner.solutionExposures`. Exposed cards can never count as unseen independent passes;
   batches exposed before card IDs exist honestly downgrade unseen status to `unknown`. */

const MAX_EXPOSURES = 500;
const SOLUTION_PURPOSES = new Set(["blueprint", "author", "review", "repair", "case-author", "case-review"]);

const cleanIds = (list) => [...new Set((Array.isArray(list) ? list : []).filter((id) => typeof id === "string" && id.trim()).map((id) => id.trim()))];

/**
 * Does a model stage / trace record carry answer blueprints, option truth values, candidate answers, or marking rubrics?
 * Stage 1 (`plan` / `weights`) carries only evidence quotes and learning targets, never answers or rubrics.
 */
export function containsSolutionContent(meta = {}) {
  const purpose = String(meta?.purpose || meta?.kind || "").toLowerCase();
  if (SOLUTION_PURPOSES.has(purpose)) return true;
  const stage = String(meta?.stage || "").toLowerCase();
  if (!stage) return false;
  if (stage.includes("weight") || stage.startsWith("planning ") || stage.startsWith("规划")) return false;
  return /blueprint|answer|author|writ|review|repair|patch|rubric|审阅|修复|写题|答案|蓝图/i.test(stage);
}

function exposureKey(entry) {
  return [
    entry.source || "request-trace",
    entry.jobId || "",
    entry.draftId || "",
    entry.deckId || "",
    entry.stage || "",
    entry.requirementsVersion || "",
    (entry.cardIds || []).slice().sort().join(","),
    entry.unmapped ? "unmapped" : "mapped",
  ].join("|");
}

/** Normalize an existing `learner.solutionExposures` array without mutating inputs. */
export function normalizeSolutionExposures(list) {
  if (!Array.isArray(list)) return [];
  return list.filter((item) => item && typeof item === "object" && typeof item.at === "string").map((item) => {
    const cardIds = cleanIds(item.cardIds);
    return {
      id: typeof item.id === "string" && item.id ? item.id : `exp-${item.at}`,
      at: item.at,
      source: typeof item.source === "string" && item.source ? item.source : "request-trace",
      action: typeof item.action === "string" && item.action ? item.action : "reveal",
      ...(typeof item.jobId === "string" && item.jobId ? { jobId: item.jobId } : {}),
      ...(typeof item.draftId === "string" && item.draftId ? { draftId: item.draftId } : {}),
      ...(typeof item.deckId === "string" && item.deckId ? { deckId: item.deckId } : {}),
      ...(typeof item.callId === "string" && item.callId ? { callId: item.callId } : {}),
      ...(typeof item.stage === "string" && item.stage ? { stage: item.stage } : {}),
      ...(typeof item.requirementsVersion === "string" && item.requirementsVersion ? { requirementsVersion: item.requirementsVersion } : {}),
      ...(typeof item.requirementsDigest === "string" && item.requirementsDigest ? { requirementsDigest: item.requirementsDigest } : {}),
      cardIds,
      unmapped: item.unmapped === true || cardIds.length === 0,
    };
  });
}

/**
 * Append a solution-exposure receipt to `learner` (idempotent for identical scope + version).
 * Returns `{ learner, receipt, added }`.
 */
export function recordSolutionExposure(learner, raw = {}) {
  const base = learner && typeof learner === "object" && !Array.isArray(learner) ? { ...learner } : {};
  const existing = normalizeSolutionExposures(base.solutionExposures);
  const cardIds = cleanIds(raw.cardIds);
  const at = typeof raw.at === "string" && raw.at ? raw.at : new Date().toISOString();
  const receipt = {
    id: typeof raw.id === "string" && raw.id ? raw.id : `exp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    at,
    source: typeof raw.source === "string" && raw.source ? raw.source : "request-trace",
    action: typeof raw.action === "string" && raw.action ? raw.action : "reveal",
    ...(typeof raw.jobId === "string" && raw.jobId ? { jobId: raw.jobId } : {}),
    ...(typeof raw.draftId === "string" && raw.draftId ? { draftId: raw.draftId } : {}),
    ...(typeof raw.deckId === "string" && raw.deckId ? { deckId: raw.deckId } : {}),
    ...(typeof raw.callId === "string" && raw.callId ? { callId: raw.callId } : {}),
    ...(typeof raw.stage === "string" && raw.stage ? { stage: raw.stage } : {}),
    ...(typeof raw.requirementsVersion === "string" && raw.requirementsVersion ? { requirementsVersion: raw.requirementsVersion } : {}),
    ...(typeof raw.requirementsDigest === "string" && raw.requirementsDigest ? { requirementsDigest: raw.requirementsDigest } : {}),
    cardIds,
    unmapped: raw.unmapped === true || cardIds.length === 0,
  };
  const key = exposureKey(receipt);
  const duplicate = existing.find((item) => exposureKey(item) === key);
  if (duplicate) return { learner: { ...base, solutionExposures: existing }, receipt: duplicate, added: false };
  const next = [...existing, receipt].slice(-MAX_EXPOSURES);
  return { learner: { ...base, solutionExposures: next }, receipt, added: true };
}

/**
 * Evaluate whether a card / batch has recorded solution exposure before `beforeAt` (optional timestamp).
 * - Direct card match -> `{ exposed: true, unseenStatus: "exposed", receipts }`
 * - Batch/draft/job match where card IDs could not yet be mapped (`unmapped: true`) -> `{ exposed: false, unseenStatus: "unknown", receipts }`
 * - No match -> `{ exposed: false, unseenStatus: "unseen", receipts: [] }`
 */
export function cardExposureStatus(exposures, { cardId, draftId, deckId, jobId, beforeAt } = {}) {
  const list = normalizeSolutionExposures(exposures);
  const limitMs = beforeAt ? (typeof beforeAt === "number" ? beforeAt : Date.parse(beforeAt) || Infinity) : Infinity;
  const direct = [];
  const batchUnmapped = [];
  for (const item of list) {
    const itemMs = Date.parse(item.at) || 0;
    if (itemMs > limitMs) continue;
    if (cardId && item.cardIds.includes(cardId)) {
      direct.push(item);
      continue;
    }
    if (item.unmapped) {
      const sameDraft = draftId && item.draftId === draftId;
      const sameDeck = deckId && (item.deckId === deckId || item.draftId === deckId);
      const sameJob = jobId && item.jobId === jobId;
      if (sameDraft || sameDeck || sameJob) batchUnmapped.push(item);
    }
  }
  if (direct.length) return { exposed: true, unseenStatus: "exposed", receipts: direct };
  if (batchUnmapped.length) return { exposed: false, unseenStatus: "unknown", receipts: batchUnmapped };
  return { exposed: false, unseenStatus: "unseen", receipts: [] };
}

/** Stamp attempt assistance metadata when a card has prior solution or batch exposure. */
export function applyExposureToAssistance(assistance, exposures, scope = {}) {
  const status = cardExposureStatus(exposures, scope);
  const base = assistance && typeof assistance === "object" ? { ...assistance } : {};
  if (status.exposed) {
    const fromSample = status.receipts.some((item) => item.source === "sample-calibration");
    return {
      ...base,
      used: true,
      blueprintExposed: status.receipts.some((item) => item.source !== "sample-calibration") || !fromSample,
      ...(fromSample ? { sampleExposed: true } : {}),
      unseenStatus: "exposed",
    };
  }
  if (status.unseenStatus === "unknown") {
    return { ...base, unseenStatus: "unknown" };
  }
  return base;
}
