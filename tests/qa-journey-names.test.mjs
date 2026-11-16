// The journey finds controls by name; a typed glyph (→, ＋) that #1073 turns into an icon must not break it, in zh or en, before or after
// the en key changes with the source string (#1088).
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { controlName } from "../scripts/qa/journey.mjs";

const zh = (text) => text;

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

test("nav() opens the narrow-window drawer and the 更多 fold before it looks for an entry", async () => {
  const source = await readFile(new URL("../scripts/qa/journey.mjs", import.meta.url), "utf8");
  const nav = source.slice(source.indexOf("async nav(id)"), source.indexOf("async openAddSource()"));
  assert.match(nav, /打开导航/, "a narrow window hides the sidebar in a drawer");
  assert.match(nav, /data-nav-fold/, "entries such as 任务 sit in the closed 更多 fold");
  assert.match(nav, /has no entry for/, "a missing entry is named instead of a 30 s timeout");
});
