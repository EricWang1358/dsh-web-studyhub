import { isPermanentModelError, isTransientModelError } from '../../../model-retry.js';
import { SILENT_CUT } from '../../../jobs/gateway-policy.js';
import { modelFailingText } from './messages.js';

/* When the model itself is failing, a parallel stage (inventory/parallel.js) stops with ONE reason instead of failing every part alone (2026-11-11: a 整理总纲
   whose session ran on a local account-pool proxy that answered every call `503 no_healthy_account`, or held it open until the host's 8-minute limit, asked
   all 249 parts twice in 1 h 31 min and saved nothing). A refusal that asking again cannot mend (a missing key, an exhausted quota) stops at once; any other
   failure stops once DEAD_RUN calls in a row failed the same way with no answer between them. A failure among answers still fails its part alone. */

/** Calls in a row that failed the same way, with no answer between them, before the stage stops: two tries of three parts. */
export const DEAD_RUN = 6;
/** A call that sends nothing at all (no reasoning, no text) for this long is cut: a hung request, a provider queue that never serves it. */
export const SILENT_MS = 3 * 60 * 1000;

// DSH's own failure classes say no more than the kind does; an identifier the provider sent (`"code":"no_healthy_account"`) does.
const GENERIC = /^(SERVER|SERVER_ERROR|TRANSPORT|UNAVAILABLE|OVERLOADED|TIMEOUT|STALLED|RATE_LIMIT|EMPTY_RESPONSE)$/i;
const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_.-]{1,40}$/;

/** What went wrong with a call, in a form the console may show: a kind, the HTTP status and the provider's error code (never the free text of its body). */
export function causeOf(error, { silentMs = SILENT_MS } = {}) {
  if (error?.code === SILENT_CUT) return { kind: 'silent', minutes: Math.max(1, Math.round(silentMs / 60000)) };
  const message = String(error?.message ?? ''), own = String(error?.code ?? '');
  const status = Number(error?.status ?? error?.statusCode) || Number(/^\s*(\d{3})\b/.exec(message)?.[1]) || null;
  const body = /"code"\s*:\s*"([^"]{1,60})"/.exec(message)?.[1];
  const code = body && IDENTIFIER.test(body) ? body : IDENTIFIER.test(own) && !GENERIC.test(own) ? own : null;
  const kind = isPermanentModelError(error) ? 'refused' : error?.name === 'TimeoutError' ? 'timeout'
    : status === 429 || /^RATE_LIMIT$/i.test(own) ? 'rate-limit' : isTransientModelError(error) ? 'unavailable' : 'failed';
  return { kind, ...(status ? { status } : {}), ...(code ? { code } : {}) };
}
const sameWay = cause => `${cause.kind}|${cause.status ?? ''}|${cause.code ?? ''}`;

/** -> { tripped, answered(), failed(error) }: `failed` returns the error that stops the stage when this failure trips the breaker, else null. */
export function createBreaker({ language, deadRun = DEAD_RUN, silentMs = SILENT_MS } = {}) {
  let run = 0, last = null, tripped = null;
  return {
    get tripped() { return tripped; },
    answered() { run = 0; last = null; },
    failed(error) {
      if (tripped) return tripped;
      const cause = causeOf(error, { silentMs }), way = sameWay(cause);
      run = way === last ? run + 1 : 1; last = way;
      if (cause.kind !== 'refused' && run < deadRun) return null;
      tripped = Object.assign(new Error(modelFailingText(language, cause, run)), { code: 'model-failing', fatal: true, modelCause: cause });
      return tripped;
    },
  };
}

/** The silence watch of one call: armed when the call starts, re-armed by every piece of output; its signal ends the call with a SILENT_CUT reason. */
export function watchSilence(ms) {
  const controller = new AbortController(), reason = Object.assign(new Error(`no output for ${ms} ms`), { code: SILENT_CUT });
  let timer = null;
  const arm = () => { clearTimeout(timer); timer = setTimeout(() => controller.abort(reason), ms); };
  return { signal: controller.signal, reason, get fired() { return controller.signal.aborted; }, start: arm, clear: () => clearTimeout(timer),
    output: { open: () => {}, append: arm, reasoning: arm, close: () => {} } };
}
