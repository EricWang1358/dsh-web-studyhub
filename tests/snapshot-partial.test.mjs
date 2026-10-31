import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StudyService } from "../lib/service.js";
import { Store } from "../lib/store.js";
import { seedLibrary } from "../scripts/qa/perf-seed.mjs";
import { TIME_KEYS } from "../lib/snapshot-time.js";

/* #567: an idle panel's once-a-minute poll. When only the clock moved since the fingerprint it sends, and it says it can take a
   partial answer, the snapshot answers the parts that read the clock (and of those only what changed), not the 300 sources again. */

const NOON = new Date(2026, 9, 6, 12, 0, 10).getTime();
const MINUTE = 60_000;

async function fixture(t, { dueIn = 2 * MINUTE } = {}) {
  t.mock.timers.enable({ apis: ["Date"], now: NOON });
  const root = await mkdtemp(join(tmpdir(), "study-snapshot-partial-"));
  await seedLibrary(root, { sources: 30, decks: 4, cardsPerDeck: 6, runs: 3, attempts: 40, courses: 3, largeSources: 0 });
  // One card falls due two minutes from now, so a later poll has a due count that moved with nothing written.
  await new Store(root).update((state) => {
    state.decks[0].cards[0].review = { repetitions: 2, interval_days: 3, ease_factor: 2.5, due_at: new Date(NOON + dueIn).toISOString() };
  });
  const service = new StudyService(root);
  t.after(async () => { await service.dispose(); await rm(root, { recursive: true, force: true }); });
  return { service, tick: (ms) => t.mock.timers.tick(ms) };
}

const merge = (held, partial) => { const { partial: _flag, ...parts } = partial; return { ...held, ...parts }; };

test("a minute later with nothing written, a poll that can take it gets only the clock's parts", async (t) => {
  const { service, tick } = await fixture(t);
  const first = await service.call("snapshot");
  tick(MINUTE);
  const quiet = await service.call("snapshot", { since: first.fingerprint, partial: true });
  assert.equal(quiet.partial, true);
  assert.notEqual(quiet.fingerprint, first.fingerprint, "the fingerprint still rolls over with the minute");
  assert.deepEqual(Object.keys(quiet).sort(), ["fingerprint", "partial"], "nothing that reads the clock changed either: no sources, no decks");
  const held = merge(first, quiet);
  assert.deepEqual(await service.call("snapshot", { since: quiet.fingerprint, partial: true }), { unchanged: true, fingerprint: quiet.fingerprint });

  tick(2 * MINUTE);
  const due = await service.call("snapshot", { since: held.fingerprint, partial: true });
  assert.equal(due.partial, true);
  assert.equal(due.sources, undefined, "the sources are not sent again");
  for (const key of Object.keys(due)) assert.ok(["partial", "fingerprint", ...TIME_KEYS].includes(key), `${key} is not a part that reads the clock`);
  assert.ok(due.decks && due.progress, "the card that fell due moves the deck's due count and the progress");
  // What the panel holds after merging is exactly the whole snapshot of this minute.
  assert.deepEqual(merge(held, due), await service.call("snapshot"));
});

test("a write since the fingerprint answers the whole snapshot, partial or not", async (t) => {
  const { service, tick } = await fixture(t);
  const first = await service.call("snapshot");
  tick(MINUTE);
  await service.call("coach.goal", { goal: "exam" });
  const next = await service.call("snapshot", { since: first.fingerprint, partial: true });
  assert.equal(next.partial, undefined);
  assert.equal(next.coach.goal, "exam");
  assert.equal(next.sources.length, first.sources.length);
});

test("a caller that does not ask for a partial answer, or polls on another day, gets the whole snapshot", async (t) => {
  const { service, tick } = await fixture(t);
  const first = await service.call("snapshot");
  tick(MINUTE);
  const old = await service.call("snapshot", { since: first.fingerprint });
  assert.equal(old.partial, undefined);
  assert.ok(Array.isArray(old.sources) && old.sources.length > 0, "an older panel keeps getting the whole snapshot");
  assert.equal((await service.call("snapshot", { since: first.fingerprint, partial: true, compact: true })).partial, undefined, "the agents' compact snapshot is never partial");
  assert.equal((await service.call("snapshot", { since: "not a fingerprint", partial: true })).partial, undefined);
  tick(24 * 60 * MINUTE);
  const tomorrow = await service.call("snapshot", { since: old.fingerprint, partial: true });
  assert.equal(tomorrow.partial, undefined, "the coach's days and the day buckets move with the date: a new day is a whole snapshot");
  assert.ok(tomorrow.sources);
});

test("a panel whose fingerprint the host no longer remembers gets every part that reads the clock", async (t) => {
  const { service, tick } = await fixture(t);
  const first = await service.call("snapshot");
  // The host keeps what it answered for its last few fingerprints only (several panels may be open); eight later minutes push `first` out.
  for (let i = 0; i < 8; i++) { tick(MINUTE); await service.call("snapshot"); }
  const answer = await service.call("snapshot", { since: first.fingerprint, partial: true });
  assert.equal(answer.partial, true);
  assert.deepEqual(Object.keys(answer).filter((key) => key !== "partial" && key !== "fingerprint").sort(), [...TIME_KEYS].sort());
});

test("a card that falls due inside the panel's minute still reaches it, whoever else asked in that minute", async (t) => {
  // Due 30 s after the panel's snapshot, in the same minute: the reader's own snapshot call 40 s in sees one more due card under the same fingerprint.
  const { service, tick } = await fixture(t, { dueIn: 30_000 });
  const held = await service.call("snapshot");
  tick(40_000);
  const other = await service.call("snapshot");
  assert.equal(other.fingerprint, held.fingerprint, "the same minute, the same fingerprint");
  assert.notDeepEqual(other.decks, held.decks);
  tick(20_000);
  const next = await service.call("snapshot", { since: held.fingerprint, partial: true });
  assert.equal(next.partial, true);
  assert.ok(next.decks, "the due count the panel never got is sent");
  assert.deepEqual(merge(held, next), await service.call("snapshot"));
});
