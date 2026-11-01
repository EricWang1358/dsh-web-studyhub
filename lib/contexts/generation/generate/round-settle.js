import { mergeContinuedDraft } from '../../../bank-import.js';
import { coverageForDraft, sourcesOfDraft } from '../../../coverage-state.js';
import { progressOf, recordAttempts, uncreditedOf, wantedUncovered } from '../../../coverage-run.js';
import { classifyFailure } from '../../../generation-failure.js';
import { recordEvent } from '../../../job-calls.js';
import { shortOfPlans } from '../../../plan-record.js';

/* The round is over: what it kept, what it covered, what it cost, and the state of the plan. What comes next is round-next.js. */

/** A round that kept nothing still knows what it planned and why each part failed: the sections it asked for are planned-and-failed, not unknown (the fill round writes
    them again). */
async function keepFailureRecord({ plan, host }, failure, after, draft) {
  if (!failure?.result || !draft) return;
  try {
    const merged = mergeContinuedDraft(draft, failure.result, sourcesOfDraft(after, draft));
    await host.call('draft.save', { deck: { ...merged, draftVersion: draft.draftVersion, editorial: { ...merged.editorial, coverageSpec: plan.spec,
      coverageRun: plan.marker } }, requireExisting: true });
  } catch { /* the record is a convenience */ }
}

/** A cause worth naming: an unknown one says nothing. */
export const knownCode = code => (code && code !== 'unknown' ? { code } : {});

/** The cause in plain text for the log, and as a code (lib/generation-failure.js): every screen says it in its own words; the provider's English is only the log's. */
function causeOf(failure, timedOut) {
  if (!failure) return {};
  return { reason: timedOut ? 'timeout' : String(failure.message || failure).replace(/\s+/g, ' ').slice(0, 160), code: timedOut ? 'timeout' : classifyFailure(failure).code };
}

/** A section this round was asked for and that still has no question has failed one more time: the plan keeps how often and why, so a run does not try a section that
    fails again and again for ever
    (REPEAT_LIMIT). Only the sections this pass was ASKED for: a section of the round that was cut to fit, or that the learner did not choose, was not tried. What the
    plan knew about a section that
    came back short (how many points it needed, how many it got, how long the section is) is kept with the attempt: the screens word it. */
function noteFailedSections({ plan }, { failedKeys, coverageNow, failure, deck, code, round }) {
  if (!failedKeys.length) return;
  const sectionOf = new Map((coverageNow?.sections || []).map(section => [section.key, section]));
  const shortHere = shortOfPlans((failure ? failure.result : deck)?.editorial?.partPlans);
  const reasonFor = key => {
    const section = sectionOf.get(key);
    if (section?.state === 'planned-failed' && section.reason) return section.reason;
    return code && code !== 'unknown' ? code : 'plan-short';
  };
  const detailFor = key => {
    const row = reasonFor(key) === 'plan-short' ? shortHere.get(key) : null;
    if (!row || !Number.isFinite(row.needed)) return null;
    return { needed: row.needed, got: row.got ?? 0, ...(Number.isFinite(row.chars) ? { chars: row.chars } : {}),
      ...(Number.isFinite(row.returned) ? { returned: row.returned, outside: row.outside ?? 0 } : {}), ...(row.why ? { why: row.why } : {}) };
  };
  plan.spec = recordAttempts(plan.spec, failedKeys, reasonFor, round.round, detailFor, !!round.fill);
}

/** The sections the round was asked for and still has no question for, named with what is known of each (at most six; the count says how many). */
function lostSections({ plan, book }, failedKeys) {
  return failedKeys.slice(0, 6).map(key => {
    const record = plan.spec.attempts?.[key], note = record?.short ? { needed: record.short.needed, got: record.short.got } : record?.reason ? { reason: record.reason } : {};
    return { ...(book.refOf(key) || {}), ...note };
  });
}

function logRoundEnd(run, { ctx, round, failure, own, uncredited, asked, failedKeys, reason, code }) {
  const { job, plan } = run, status = failure ? 'failed' : 'done', row = plan.spec.rounds[ctx.index];
  recordEvent(job, { level: failure ? 'warn' : 'done', code: 'round-end', args: { round: round.round, rounds: plan.spec.rounds.length, status, fill: !!round.fill,
    kept: row.kept, covered: own,
    ...(uncredited ? { uncredited } : {}), tried: asked.length, unit: row.unit, percent: plan.percent,
    ...(failedKeys.length ? { lost: lostSections(run, failedKeys), lostCount: failedKeys.length } : {}), ...(reason ? { reason } : {}), ...knownCode(code) } });
}

/** What the plan and the log say now. The answer is what the next step is decided from. */
export async function settleRound(run, { ctx, before, round, asked, failure, timedOut }) {
  const { job, plan, host, book, clock } = run;
  const after = await host.read(), draft = after.drafts.find(item => item.id === job.draftId);
  await keepFailureRecord(run, failure, after, draft);
  const settled = (await host.read()).drafts.find(item => item.id === job.draftId) || draft;
  const coverageNow = settled ? coverageForDraft(await host.read(), settled) : null;
  const uncovered = coverageNow ? wantedUncovered(plan.spec, coverageNow) : before;
  const { progress, gained } = progressOf(before, uncovered);
  run.lastUncovered = uncovered;
  // What the round did for ITS OWN sections (a question whose quote lies in another section covers that one too: that is progress, not something the round was asked for).
  const own = asked.filter(key => before.has(key) && !uncovered.has(key)).length;
  if (coverageNow) book.seen(coverageNow);
  const { reason, code } = causeOf(failure, timedOut);
  const kept = Math.max(0, (settled?.cards.length ?? 0) - plan.cardsBefore), uncredited = uncreditedOf({ kept, gained });
  book.moved({ type: 'round-finish', index: ctx.index, status: failure ? 'failed' : 'done', kept, covered: own, uncredited, tokens: book.tokensNow() - plan.tokensBefore,
    ms: clock.workedMs(), reason, ...knownCode(code), asked, left: uncovered });
  const failedKeys = asked.filter(key => before.has(key) && uncovered.has(key));
  noteFailedSections(run, { failedKeys, coverageNow, failure, deck: run.deck, code, round });
  book.moved({ type: 'usage', tokensUsed: book.tokensNow() });
  logRoundEnd(run, { ctx, round, failure, own, uncredited, asked, failedKeys, reason, code });
  return { uncovered, progress, uncredited, reason, code };
}
