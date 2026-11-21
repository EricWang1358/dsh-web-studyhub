import { pieceOfAssignment } from '../assigned-plan.js';
import { autofixDeck } from '../card-autofix.js';
import { cardLocalIssues } from '../assessment-quality.js';
import { isPermanentFailure } from '../generation-failure.js';
import { GENERATION_STAGE_TEXT as STAGE } from '../contexts/jobs/contracts.js';
import { createPlacer, cardOf, optionsProblem, answerStandsOut } from './checks.js';
import { writePrompts, rewritePrompts, reviewPrompts } from './prompts.js';
import { quoteWindow, reviewBatches, readVerdicts } from './review.js';
import { askJson, readCards } from './reply.js';
import { portionDeck, omissionOf } from './deck.js';
import { ONE_PASS_LIMITS } from './limits.js';
import { normalizeGenerationPerformance } from '../generation-settings.js';

/* One portion of a one-pass run (docs/plans/2026-11-21-feat-one-pass-generation-plan.md §3):
     1. WRITE   one call for every section of the portion, each told its own quota, in the run's write style (performance.writeStyle); the program places each card
                (lib/one-pass/checks.js) or drops it with a reason.
     2. RE-ASK  a section left with no card is asked again once, alone, over its own text.
     3. REWRITE one call for the cards whose correct option stands out by its length; a card that still does is dropped.
     4. CHECK   the program's own card checks (lib/assessment-quality.js cardLocalIssues), no model.
     5. REVIEW  one call per batch of at most 7 cards, each judged from its quote and the text around it; a failed card is dropped (no repair in this slice).
   `complete(system, prompt, context)` is the run's call (lib/batch.js passes its limited, staged call); `context.stage` names the stage for the 任务 console.
   Result: { targets, deck, short, notes } — every verified target, the portion's deck (lib/one-pass/deck.js), the sections still short of their quota in the
   record lib/assigned-plan.js keeps, and the lines that say what the program dropped. A failure of a call itself (a refused key, a stop) is thrown. */

const LOCAL_CHECK_TITLE = 'One pass';
const stripCard = line => String(line).replace(/^Card \d+:\s*/, '');
// A call that cannot go on (a stop, a refused key, no balance) ends the portion; a re-ask or a rewrite that fails otherwise only leaves its cards as they were.
const fatal = (error, request) => request.signal?.aborted || isPermanentFailure(error);

/** Every call settled first, then the first failure thrown: no call of a portion outlives it (lib/batch.js waits for the portion, not for its calls). */
async function settledAll(promises) {
  const results = await Promise.allSettled(promises), failed = results.find(result => result.status === 'rejected');
  if (failed) throw failed.reason;
  return results.map(result => result.value);
}

export async function writePortion({ complete, request, assignments, existing = [], random = Math.random }) {
  const slots = assignments.map((assignment, index) => {
    const label = `S${index + 1}`;
    return { ...assignment, label, pieces: pieceOfAssignment(assignment, request.sources, label) };
  });
  const usable = slots.filter(slot => slot.pieces.length), place = createPlacer({ slots, existing });
  const placed = [], dropped = new Map(), again = new Map();
  const absorb = written => {
    let outside = 0;
    for (const item of written) {
      const result = place(item);
      if (result.target) placed.push({ written: item, target: result.target });
      else { dropped.set(result.reason, (dropped.get(result.reason) || 0) + 1); if (result.reason === 'quote-not-found') outside++; }
    }
    return { returned: written.length, outside };
  };
  // How the cards ask (writeStyle, scenario by default): the same for the portion's write, the re-ask of an empty section and a second ask of an unreadable reply.
  const { writeStyle: style } = normalizeGenerationPerformance(request.performance);
  const write = async (list, context) => {
    const { system, prompt } = writePrompts(request, list.map(slot => ({ label: slot.label, title: slot.title, quota: slot.quota, pieces: slot.pieces })),
      [...existing, ...placed.map(item => item.target.objective)], { style });
    return askJson(complete, system, prompt, { stage: STAGE.authoring, ...context }, readCards);
  };

  if (usable.length) absorb(await write(usable, {}));
  const empty = usable.filter(slot => !placed.some(item => item.target.assignment === slot.key));
  await settledAll(empty.map(async slot => {
    try { again.set(slot.key, absorb(await write([slot], { unit: `section-${slot.label}` }))); }
    catch (error) { if (fatal(error, request)) throw error; again.set(slot.key, { returned: 0, error: String(error.message).slice(0, 200), why: 'reply' }); }
  }));

  const ordered = orderTargets(placed, slots);
  const omitted = [], notes = [...dropped].map(([reason, n]) => `${n} written card(s) dropped: ${reason}`);
  const evened = await rewriteLoud(complete, request, ordered, omitted, random);
  const { checked, autofixed } = localChecks(request, evened, omitted);
  const { passed, lost } = await review(complete, request, checked, omitted);
  return { targets: ordered.map(item => item.target), deck: portionDeck({ cards: passed.map(item => item.card), targets: ordered.map(item => item.target), omitted,
    checks: passed.map(item => item.check), autofixed }), short: shortOf(slots, placed, again), notes, reviewLost: lost };
}

/** The placed cards in reading order (section by section, then by where the quote stands), their targets numbered in that order. */
function orderTargets(placed, slots) {
  const order = new Map(slots.map((slot, index) => [slot.key, index]));
  return [...placed].sort((a, b) => order.get(a.target.assignment) - order.get(b.target.assignment) || a.target.start - b.target.start)
    .map((item, index) => ({ ...item, target: { ...item.target, targetId: `target-${index + 1}` } }));
}

// A rewrite may change the words of the options, never which one is correct: the correct option must stand where it stood (the options are sent in their written order).
const sameKey = (before, after) => before.findIndex(option => option?.correct) === after.findIndex(option => option?.correct);

/** The cards whose correct option stands out by its length, sent back once in one call to have their options rewritten; one that still stands out is dropped. */
async function rewriteLoud(complete, request, placed, omitted, random) {
  const loud = placed.filter(item => answerStandsOut(item.written.options));
  const fixed = new Map();
  if (loud.length) {
    const { system, prompt } = rewritePrompts(request, loud.map(item => item.written));
    let reply = null;
    try { reply = await askJson(complete, system, prompt, { stage: STAGE.repairing }); } catch (error) { if (fatal(error, request)) throw error; }
    for (const entry of Array.isArray(reply?.cards) ? reply.cards : []) {
      const item = loud[entry?.index];
      if (item && !fixed.has(item) && !optionsProblem(entry.options) && sameKey(item.written.options, entry.options)) fixed.set(item, { ...item.written, options: entry.options });
    }
  }
  return placed.flatMap(item => {
    const written = fixed.get(item) || item.written, card = cardOf(written, item.target, { random });
    if (!answerStandsOut(written.options)) return [{ ...item, written, card }];
    omitted.push(omissionOf(card, [`option cue (length): the correct option is more than ${Math.round((ONE_PASS_LIMITS.optionLengthRatio - 1) * 100)}% longer than the longest wrong option after one rewrite`]));
    return [];
  });
}

/** The program's own checks of every card, one card at a time so each defect is that card's: what autofix fills is filled, a card with a defect left is dropped. */
function localChecks(request, list, omitted) {
  const assessmentPlan = { targets: list.map(item => item.target) }, answerBlueprint = { items: list.map(item => ({ targetId: item.target.targetId, options: item.card.options })) };
  const options = { expectedKind: 'quiz', constraints: request.constraints, language: request.language, notation: request.notation };
  let autofixed = 0;
  const checked = list.flatMap(item => {
    const fixed = autofixDeck({ title: LOCAL_CHECK_TITLE, cards: [item.card] }, { assessmentPlan, answerBlueprint, ...options });
    autofixed += fixed.fixes.length;
    const card = fixed.deck.cards[0], issues = cardLocalIssues({ title: LOCAL_CHECK_TITLE, cards: [card] }, { sources: request.sources, ...options });
    if (!issues.length) return [{ ...item, card }];
    omitted.push(omissionOf(card, issues.map(stripCard)));
    return [];
  });
  return { checked, autofixed };
}

/**
 * The review: batches of at most `reviewBatch` cards, each card with its quote and the text around it. A card the review fails, or says nothing usable about, is dropped.
 * A batch whose call fails (a passing failure, or a reply unreadable after asking again) is reviewed once more (`unit: batch-n-again`); if that fails too, only that batch
 * is dropped, and its cards are counted in `lost`. A stop or a refused key is passed on once every batch's call has settled.
 */
async function review(complete, request, list, omitted) {
  const batches = reviewBatches(list);
  const judged = await settledAll(batches.map(async (batch, index) => {
    const { system, prompt } = reviewPrompts(request, batch.map(item => ({ card: item.card, quote: item.target.citations[0].quote, around: quoteWindow(request.sources, item.target) })));
    let failure = null;
    for (const unit of [`batch-${index + 1}`, `batch-${index + 1}-again`]) {
      try { return { verdicts: readVerdicts(await askJson(complete, system, prompt, { stage: STAGE.reviewing, unit }), batch.length) }; }
      catch (error) { if (fatal(error, request)) throw error; failure = error; }
    }
    return { verdicts: batch.map(() => null), failure };
  }));
  let lost = 0;
  const passed = batches.flatMap((batch, b) => batch.flatMap((item, i) => {
    const { verdicts, failure } = judged[b], verdict = verdicts[i];
    if (verdict?.pass) return [{ ...item, check: { cardId: item.card.id, explanation: verdict.issue || 'Passed the one-pass review against its quote and the text around it.' } }];
    if (failure) lost++;
    omitted.push(omissionOf(item.card, [verdict ? `Editorial review still found issues: ${verdict.issue || `blocker ${verdict.blocker ?? '?'}`}`
      : failure && !(failure instanceof SyntaxError) ? `Review call failed after a second try: ${String(failure.message).slice(0, 160)}`
        : 'Review protocol failed: the review gave no usable verdict for this card']));
    return [];
  }));
  return { passed, lost };
}

/** The sections still short of their quota, in the record lib/assigned-plan.js planAssigned keeps (lib/batch.js makes them ONE failed part with the code plan-short). */
function shortOf(slots, placed, again) {
  return slots.flatMap(slot => {
    const got = placed.filter(item => item.target.assignment === slot.key).length;
    if (got >= slot.quota) return [];
    return [{ key: slot.key, sectionId: slot.sectionId ?? slot.key, sourceId: slot.sourceId, start: slot.start, end: slot.end, quota: slot.quota, planned: got, missing: slot.quota - got,
      chars: Math.max(0, slot.end - slot.start), ...(slot.title ? { title: slot.title } : {}), ...(again.get(slot.key) || {}) }];
  });
}
