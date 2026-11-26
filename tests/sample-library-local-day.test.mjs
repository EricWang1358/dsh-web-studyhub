/* The sample library's practice history is placed relative to the moment it is loaded. Late at night or just after
   midnight, "N days ago plus a few minutes" crossed into the neighbouring calendar day, so a day lost its answers and
   the streak the sample shows broke (7 → 5 in the TUI golden layout, which failed on CI from about 22:40 UTC). Each
   past day's answers must stay on that local calendar day, today's on today, and the relearned cards must still be
   due when the sample opens, whatever the time of day. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StudyService } from "../lib/service.js";
import { studyStats } from "../lib/insights.js";
import { sampleAction } from "../lib/sample-library.js";
import zh from "../lib/sample/zh.js";

const localDay = (value) => {
  const d = new Date(value);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const daysBefore = (now, days) => { const d = new Date(now); d.setDate(d.getDate() - days); return localDay(d); };
const at = (hours, minutes) => new Date(2026, 10, 18, hours, minutes).getTime();

for (const [label, now] of [["midday", at(12, 0)], ["late evening", at(23, 50)], ["just after midnight", at(0, 10)]]) {
  test(`a sample loaded ${label} keeps every answer on its own local day`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "studyhub-sample-day-"));
    const service = new StudyService(root);
    t.after(async () => { await service.dispose?.(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 40 }); });

    // The same host shape lib/host.js hands the sample loader, with the load time fixed.
    const host = { call: (name, input) => service.call(name, input), store: service.store, has: (name) => service.runtime.hasAction(name) };
    await sampleAction(host, "sample.load", { language: "zh", now });
    const state = await service.store.read();
    const history = state.attempts.filter((attempt) => /^sample-attempt-\d+-\d+$/.test(attempt.id));
    assert.ok(history.length >= 30, `history answers: ${history.length}`);
    for (const attempt of history) {
      const day = Number(attempt.id.split("-")[2]);
      assert.equal(localDay(attempt.timestamp), daysBefore(now, day), `${attempt.id} at ${attempt.timestamp}`);
    }
    const today = state.attempts.filter((attempt) => attempt.id.startsWith("sample-mistake-"));
    assert.ok(today.length >= 1);
    for (const attempt of today) {
      assert.equal(localDay(attempt.timestamp), localDay(now), `${attempt.id} at ${attempt.timestamp}`);
      assert.ok(Date.parse(attempt.timestamp) <= now, `${attempt.id} is not in the future`);
    }

    // Today plus the six practice days before the first rest day.
    assert.equal(studyStats(state, {}, new Date(now)).totals.streak, 7);

    const deck = state.decks.find((item) => item.id === "sample-deck-patterns");
    for (const key of zh.due) {
      const card = deck.cards.find((item) => item.id === `sample-${key}`);
      assert.ok(Date.parse(card.review.due_at) <= now, `${card.id} is due when the sample opens (due ${card.review.due_at})`);
    }
  });
}
