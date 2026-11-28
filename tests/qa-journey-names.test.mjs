// The journey finds controls by name; a typed glyph (→, ＋) that #1073 turns into an icon must not break it, in zh or en, before or after
// the en key changes with the source string (#1088).
import test from "node:test";
import assert from "node:assert/strict";
import { controlName } from "../scripts/qa/control-name.mjs";
import { createJourneyNav } from "../scripts/qa/journey-nav.mjs";
import { navPageHarness } from "./helpers/journey-nav-page.mjs";

const zh = (text) => text;

function makeJourney(page, { lang = "zh", english = {} } = {}) {
  const t = (text) => (lang === "en" && Object.hasOwn(english, text) ? english[text] : text);
  return createJourneyNav({ page, t, wait: async () => {} });
}

test("a zh name matches with or without the typed arrow or plus", () => {
  const publish = controlName(zh, "发布并开始练");
  assert.match("发布并开始练 →", publish);
  assert.match("发布并开始练", publish);
  assert.doesNotMatch("发布并开始练第一轮", publish);
  const add = controlName(zh, "添加资料");
  assert.match("＋ 添加资料", add);
  assert.match("添加资料", add);
  assert.doesNotMatch("再添加资料", add);
});

test("an en name matches whether the en key still carries the arrow or not", () => {
  const old = { "发布并开始练 →": "Publish and start →" };
  const renamed = { "发布并开始练": "Publish and start" };
  for (const english of [old, renamed]) {
    const t = (text) => (Object.hasOwn(english, text) ? english[text] : text);
    const name = controlName(t, "发布并开始练");
    assert.match("Publish and start", name);
    assert.match("Publish and start →", name);
  }
});

test("nav() opens the narrow-window drawer and the 更多 fold before clicking an entry", async () => {
  const { page, events } = navPageHarness({ drawerClosed: true, entryId: "tasks", folded: true });
  const j = makeJourney(page);
  await j.nav("tasks");
  assert.deepEqual(events, [
    "click:drawer:打开导航",
    "waitFor:nav:visible",
    "click:fold",
    "waitFor:entry:tasks:visible",
    "dispatch:tasks:click",
  ]);
});

test("nav() uses the translated drawer button label when lang is en", async () => {
  const { page, events } = navPageHarness({ drawerClosed: true, drawerLabel: "Open navigation", entryId: "sources" });
  const j = makeJourney(page, { lang: "en", english: { 打开导航: "Open navigation" } });
  await j.nav("sources");
  assert.deepEqual(events, [
    "click:drawer:Open navigation",
    "waitFor:nav:visible",
    "waitFor:entry:sources:visible",
    "dispatch:sources:click",
  ]);
});

test("nav() names a missing entry immediately instead of waiting for a timeout", async () => {
  const { page, events } = navPageHarness({ drawerClosed: false, entryId: null });
  const j = makeJourney(page);
  await assert.rejects(
    () => j.nav("tasks"),
    /has no entry for "tasks"/,
  );
  assert.deepEqual(events, []);
});

test("nav() reports clearly when an entry stays hidden after opening the drawer and fold", async () => {
  const { page, events } = navPageHarness({ drawerClosed: true, entryId: "tasks", folded: true, staysHidden: true });
  const j = makeJourney(page);
  await assert.rejects(
    () => j.nav("tasks"),
    /stays hidden after opening the drawer and the 「更多」 fold/,
  );
  assert.deepEqual(events, [
    "click:drawer:打开导航",
    "waitFor:nav:visible",
    "click:fold",
    "waitFor:entry:tasks:visible",
  ]);
});

