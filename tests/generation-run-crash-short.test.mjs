/* Short-world crash recovery and 接着做 continuation (issue #608): split from generation-run-crash.test.mjs so CI shards and local workers run
   the short-draft crash scenarios in parallel with the window matrix and restart-replacement suites. Fake models only. */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  CRASH_CONCURRENCY, SHORT_WORLDS, attemptOf, clusteringModel, die, draftOf, jobsOnDraft,
  reopen, roundList, settleJob, shortScenario, shortfallFor,
} from './helpers/generation-run-crash.mjs';

describe('short-world crash and continue', { concurrency: CRASH_CONCURRENCY }, () => {
  // Every size on the legacy path, and the one on each switch: what differs under a switch is the job, not the sizes.
  for (const [mode, world] of [...SHORT_WORLDS.map(item => ['legacy', item]), ['generation', SHORT_WORLDS[1]], ['restart', SHORT_WORLDS[1]]]) test(`${mode}, ${world.name}: closing a run that is short keeps the goal the card showed and offers the way to add more`, async t => {
    const scenario = shortScenario(world), root = await die(t, 'every-section-covered', mode, scenario), after = await reopen(t, root, mode, scenario);
    const left = await draftOf(after.service), kept = left.cards.length;
    assert.ok(kept < world.goal, `this world is short when it is cut (${kept} of ${world.goal})`);
    const [card] = await jobsOnDraft(after.service, left);
    assert.equal(card.requestedTotal, world.goal, 'the goal the interrupted card shows');
    // (Behind generationRestart the card is the kernel's last record, which a kill can leave a save behind the draft.)
    if (mode !== 'restart') assert.equal(card.savedCount, kept, 'the count it shows');
    const reply = await after.service.call('job.control', { jobId: card.id, action: 'retry' });
    const done = await settleJob(after.service, attemptOf(reply));
    assert.deepEqual(after.log, [], 'closing asks no model');
    assert.equal(done.status, 'complete', done.stage);
    assert.deepEqual([done.savedCount, done.requestedTotal], [kept, world.goal], 'the number does not change between the card and the close');
    assert.doesNotMatch(done.stage, /target|ready/i, 'a run that is short does not claim it reached anything');
    assert.match(done.stage, new RegExp(`${kept} of ${world.goal}`));
    const closed = await draftOf(after.service), short = await shortfallFor(after.service, closed);
    assert.equal(closed.cards.length, kept);
    assert.ok(roundList(closed.editorial.coverageSpec).every(round => !['pending', 'running'].includes(round.status)), 'no round left open');
    assert.deepEqual([short.questionsKept, short.questionsGoal, short.questionsMissing], [kept, world.goal, world.goal - kept]);
    assert.deepEqual([short.state, short.reason, short.ready, short.percent], ['done', 'questions-short', false, Math.round(kept / world.goal * 100)]);
    assert.deepEqual([short.action, short.continueKind, short.canContinue], ['continue', 'count', true], 'the way any short draft is added to');
    // That way: the action a plain short run gets, asked for what the sentence says.
    after.use(clusteringModel({ readsExisting: true }).complete);
    const more = await after.service.call('generate', { resumeDraftId: closed.id, draftVersion: closed.draftVersion });
    assert.equal(more.missing, world.goal - kept, 'the number on the button is the number the job is asked for');
    const added = await settleJob(after.service, attemptOf(more));
    assert.equal(added.status, 'complete', added.stage);
    const last = await draftOf(after.service);
    assert.ok(last.cards.length > kept && last.cards.length <= world.goal, `it added to the draft (${kept} -> ${last.cards.length} of ${world.goal})`);
    assert.ok(left.cards.every(card => last.cards.some(item => item.id === card.id)), 'what had passed review is kept');
    const then = await shortfallFor(after.service, last);
    assert.equal(then.questionsMissing, world.goal - last.cards.length);
    assert.equal(then.ready, last.cards.length === world.goal);
    assert.equal(last.editorial.requested, world.goal, 'what the next press counts from');
    if (then.questionsMissing > 0) {
      assert.deepEqual([then.action, then.continueKind, then.canContinue], ['continue', 'count', true], 'it keeps saying so until the goal is met');
      const second = await settleJob(after.service, attemptOf(await after.service.call('generate', { resumeDraftId: last.id, draftVersion: last.draftVersion })));
      assert.equal(second.status, 'complete', second.stage);
      const final = await draftOf(after.service), now = await shortfallFor(after.service, final);
      assert.ok(final.cards.length >= last.cards.length);
      assert.equal(now.action, now.questionsMissing > 0 ? 'continue' : null);
    } else {
      assert.deepEqual([last.editorial.coverageRun.state, last.editorial.coverageRun.stop.reason, then.action], ['complete', 'complete', null], 'the goal met clears it');
    }
  });

  /* The press of a run closed short, killed in its turn: it is the job that has work left, so it comes back. */
  test('restart: the 接着做 of a run closed short, killed after its first save: it comes back, and its retry goes on towards the goal', async t => {
    const scenario = shortScenario(SHORT_WORLDS[1]), root = await die(t, 'every-section-covered', 'restart', scenario), first = await reopen(t, root, 'restart', scenario);
    const [card] = (await first.service.call('snapshot')).jobs;
    await settleJob(first.service, attemptOf(await first.service.call('job.control', { jobId: card.id, action: 'retry' })));
    const kept = (await draftOf(first.service)).cards.length;
    await first.service.dispose();
    await die(t, 'more-saved', 'restart', { ...scenario, press: true, kept }, root);
    const after = await reopen(t, root, 'restart', scenario), cut = await draftOf(after.service);
    assert.ok(cut.cards.length > kept && cut.cards.length < 24, `${kept} -> ${cut.cards.length}`);
    assert.equal(cut.editorial.coverageRun.stop.reason, 'questions-short', 'the draft still says it owes');
    const jobs = (await after.service.call('snapshot')).jobs.filter(job => job.contract.status === 'interrupted');
    assert.equal(jobs.length, 1, 'the press comes back');
    assert.deepEqual(after.log, []);
    after.use(clusteringModel({ readsExisting: true }).complete);
    const done = await settleJob(after.service, attemptOf(await after.service.call('job.control', { jobId: jobs[0].id, action: 'retry' })));
    assert.equal(done.status, 'complete', done.stage);
    assert.doesNotMatch(done.stage, /计划已经完成|plan of this draft is complete/);
    const last = await draftOf(after.service), short = await shortfallFor(after.service, last);
    assert.ok(last.cards.length > cut.cards.length, `${cut.cards.length} -> ${last.cards.length}`);
    assert.equal(short.action, short.questionsMissing > 0 ? 'continue' : null);
    assert.deepEqual((await after.service.call('snapshot')).jobs.filter(job => job.contract.status === 'interrupted'), [], 'no retry is left standing');
  });

  test('legacy: the 接着做 of a run closed short, killed after its first save: nothing to bring back, and the draft still offers the rest', async t => {
    const scenario = shortScenario(SHORT_WORLDS[1]), root = await die(t, 'every-section-covered', 'legacy', scenario), first = await reopen(t, root, 'legacy', scenario);
    const [card] = (await first.service.call('snapshot')).jobs;
    await settleJob(first.service, attemptOf(await first.service.call('job.control', { jobId: card.id, action: 'retry' })));
    const kept = (await draftOf(first.service)).cards.length;
    await first.service.dispose();
    await die(t, 'more-saved', 'legacy', { ...scenario, press: true, kept }, root);
    const after = await reopen(t, root, 'legacy', scenario), cut = await draftOf(after.service), short = await shortfallFor(after.service, cut);
    assert.deepEqual([short.questionsGoal, short.action, short.continueKind], [24, 'continue', 'count']);
    assert.deepEqual([cut.cards.length > kept, short.questionsKept], [true, cut.cards.length]);
  });
});
