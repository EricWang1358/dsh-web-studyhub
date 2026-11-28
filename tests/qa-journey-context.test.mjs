// Imports scripts/qa/journey.mjs, which pulls in the browser helpers, so this lives apart from qa-journey-names (kept in the fast suite).
import test from "node:test";
import assert from "node:assert/strict";
import { journeyContext } from "../scripts/qa/journey.mjs";
import { navPageHarness } from "./helpers/journey-nav-page.mjs";

// The journey's own context must get nav() from createJourneyNav: a local nav that skips the drawer would pass every test above (review of #1721).
test("the journey context navigates through createJourneyNav, so it opens the drawer and the 更多 fold before clicking", async () => {
  const { page, events } = navPageHarness({ drawerClosed: true, entryId: "tasks", folded: true });
  const j = journeyContext({ page, server: null, previewCall: async () => ({}), options: { lang: "zh" }, english: {}, fixtures: {}, step: () => "nav-test" });
  await j.nav("tasks");
  assert.deepEqual(events, [
    "click:drawer:打开导航",
    "waitFor:nav:visible",
    "click:fold",
    "waitFor:entry:tasks:visible",
    "dispatch:tasks:click",
  ]);
  assert.equal(typeof j.openDrawer, "function");
});
