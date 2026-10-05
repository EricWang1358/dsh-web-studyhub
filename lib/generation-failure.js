/* Why a part, a call or a whole run did not finish: ONE classifier that reads an Error or the text the pipeline left, and names the cause with a stable code.
   The code is what every place keeps (the part report, the planned targets of a draft, the 任务 console); the learner's wording of each code lives in ONE
   place too (ui/generation-status.js describeFailure). Pure and browser-safe: no Node imports, no wording here beyond the agent-facing English of the
   review protocol error. */

/** A section of a material got fewer planned knowledge points than its quota, after the one re-ask (lib/assigned-plan.js). */
export const PLAN_SHORT = 'plan-short';

/** The review reply could not be used (cut off, not JSON, or without a complete check for every question) even after the automatic re-asks. */
export const REVIEW_PROTOCOL = 'review-protocol';
/** How many times a malformed or incomplete review reply is asked again (so a review is at most 1 + this many calls). */
export const REVIEW_REASKS = 2;

/** Why a review reply was unusable: 'json' (not readable as JSON at all) or 'checks' (readable, but without a complete check for every question). */
const REVIEW_WHY = { json: 'json', checks: 'checks' };

/**
 * The error of a review that stayed unusable after its re-asks. The message keeps the English prefix the logs and older records know
 * ("Review protocol failed" / "Review JSON protocol failed"), and says how many calls were spent.
 */
export function reviewProtocolError({ why = REVIEW_WHY.checks, attempts = REVIEW_REASKS + 1, detail = '', missing = 0 } = {}) {
  const calls = `after ${attempts} attempt${attempts === 1 ? '' : 's'}`;
  const error = new Error(why === REVIEW_WHY.json
    ? `Review JSON protocol failed ${calls}: ${String(detail || 'reply is not valid JSON').slice(0, 120)}`
    : `Review protocol failed ${calls}: missing complete per-card checks${missing > 0 ? ` (${missing} card${missing === 1 ? '' : 's'})` : ''}`);
  error.code = REVIEW_PROTOCOL;
  error.attempts = attempts;
  error.reviewWhy = why;
  return error;
}

// Most specific first. A rule is [code, pattern]; the existing part-report codes keep their exact patterns (lib/generation-report.js used them first).
const RULES = [
  // The plan of a section had fewer knowledge points than it was assigned, even after asking for the missing ones once (lib/assigned-plan.js).
  [PLAN_SHORT, /plan[- ]short|plan came back short/i],
  [REVIEW_PROTOCOL, /Review (?:JSON )?protocol failed|审阅[^。；;]{0,10}格式不对/i],
  ['quote', /quote\b|not in source|unknown source|sourceId .* is not one of|citation/i],
  ['plan', /Assessment plan is not usable|Return exactly \d+ targets|infeasible self-contained/i],
  ['quality', /Quality gate failed|Editorial review still found issues|Answer blueprint|Author returned no questions|insufficient evidence|answerLeak|selfContained|optionQuality|learningValue|sourceSupport|explanationQuality|duplicate|formula outside math delimiters|the stem asks what the source says|Card \d+: [\w-]+ (?:is required|must be text)|need 3.6 options|invalid correct option count|each option requires|hint reveals the answer/i],
  ['quota', /insufficient[ _-]?(?:balance|quota|credit)|exceeded your current quota|ACCOUNT_QUOTA|\b402\b|余额不足|额度不足/i],
  ['credential', /api[ _-]?key|credential|NO_ADAPTER|\b40[13]\b|unauthori[sz]ed|forbidden|permission[_ ]?error|model[_ ]not[_ ]found|unsupported model|密钥|没有可用模型|未注册模型提供方/i],
  ['budget', /total budget|time budget|minute budget|执行时限|用时太长/i],
  ['timeout', /timed? ?out|timeout|超时|did not respond|没有回应|没有响应/i],
  ['no-reply', /Model returned no text|没有返回内容/i],
  ['rate-limit', /rate.?limit|too many requests|\b429\b|限流/i],
  ['cancelled', /\babort(?:ed)?\b|cancel+ed|已停止|被停止/i],
  ['unavailable', /overloaded|\b5\d\d\b|unavailable|暂时不可用/i],
];

/** Every code the classifier can return (the learner's wording of each is in ui/generation-status.js and ui/draft-shortfall.js; a test keeps them in step). */
export const FAILURE_CODES = Object.freeze([...RULES.map(([code]) => code), 'unknown']);

const textOf = (input) => {
  if (input && typeof input === 'object') return String(input.message ?? input.error ?? input.reason ?? input.text ?? '');
  return String(input ?? '');
};

/**
 * What a failure is, as `{ code, attempts, retries, raw }`. `code` is one of plan-short, review-protocol, quote, plan, quality, quota, credential, budget, cancelled, no-reply,
 * rate-limit, timeout, unavailable, or 'unknown'. `attempts` is how many calls the message says were spent ("after 3 attempts"); `retries` how many
 * times it says it was tried again automatically ("after 3 attempts" -> 2; the console's "已自动重试 2 次" -> 2). An error object may carry its own
 * `code` / `attempts` (a typed error) and name 'AbortError' / 'TimeoutError'.
 */
export function classifyFailure(input) {
  const raw = textOf(input).trim();
  const typed = input && typeof input === 'object' ? input : null;
  let code = typed?.code === REVIEW_PROTOCOL ? REVIEW_PROTOCOL : null;
  if (!code && typed?.name === 'AbortError') code = typed?.reason?.code === 'GENERATION_BUDGET' ? 'budget' : 'cancelled';
  if (!code && typed?.name === 'TimeoutError') code = 'timeout';
  if (!code) code = RULES.find(([, pattern]) => pattern.test(raw))?.[0] || 'unknown';
  const calls = /after (\d+) attempts?/i.exec(raw), tried = /(?:已自动重试|retried(?: automatically)?)\s*(\d+)/i.exec(raw);
  const attempts = Number.isInteger(typed?.attempts) ? typed.attempts : calls ? Number(calls[1]) : tried ? Number(tried[1]) + 1 : 0;
  return { code, attempts, retries: Math.max(0, attempts - 1), raw };
}

/** A failure that repeating the work cannot fix: a missing or refused credential, an account without balance, a model the provider retired. */
export const isPermanentFailure = (input) => ['credential', 'quota'].includes(classifyFailure(input).code);

/** The part-report code of a failure: the classifier's code, with every cause it does not know folded into 'other' (older records and tests use that word). */
export const reasonCode = (input) => { const { code } = classifyFailure(input); return code === 'unknown' ? 'other' : code; };
