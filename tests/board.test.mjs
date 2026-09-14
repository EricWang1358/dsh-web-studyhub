import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boardAction } from "../lib/board.js";

async function isolated(run) {
  const home = await mkdtemp(join(tmpdir(), "study-board-"));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try { await run(home); }
  finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
    await rm(home, { recursive: true, force: true });
  }
}

test("board is global across workspaces and isolated by DSH_HOME", () => isolated(async (home) => {
  const initial = await boardAction("board.get");
  assert.equal(initial.revision, 0);
  assert.deepEqual(initial.columns.map((column) => column.title), ["待办", "进行中", "已完成"]);
  let board = await boardAction("board.card.add", { revision: 0, title: "Read", labels: ["study", "study"], due: "2028-02-29" }, "C:\\courses\\module");
  const id = board.columns[0].cardIds[0];
  assert.deepEqual(board.cards[id].origin, { workspace: "C:\\courses\\module", workspaceTitle: "module" });
  assert.deepEqual(board.cards[id].labels, ["study"]);
  assert.deepEqual(await boardAction("board.get", {}, "/another/workspace"), board);
  assert.deepEqual(await boardAction("board.get", { since: 1 }), { unchanged: true, revision: 1 });
  assert.equal(JSON.parse(await readFile(join(home, "study", "board.json"), "utf8")).revision, 1);
  board.cards[id].title = "Outside mutation";
  assert.equal((await boardAction("board.get")).cards[id].title, "Read");
  process.env.DSH_HOME = join(home, "other-home");
  assert.equal((await boardAction("board.get")).revision, 0);
}));

test("board supports ordering, edits, archive, restore, deletion and stable completion", () => isolated(async () => {
  let board = await boardAction("board.get");
  const mutate = async (action, args) => board = await boardAction(action, { ...args, revision: board.revision });
  for (const title of ["A", "B", "C"]) await mutate("board.card.add", { title });
  const [a, b, c] = board.columns[0].cardIds;
  await mutate("board.card.move", { id: a, column: "todo", index: 2 });
  assert.deepEqual(board.columns[0].cardIds, [b, c, a]);
  await mutate("board.card.move", { id: a, column: "doing", index: 0 });
  await mutate("board.card.move", { id: c, column: "doing", index: 0 });
  assert.deepEqual(board.columns[1].cardIds, [c, a]);
  await mutate("board.card.edit", { id: a, title: "Changed", note: "**Note**", due: "2030-01-02", labels: ["urgent"] });
  assert.equal(board.cards[a].note, "**Note**");
  await mutate("board.card.archive", { id: a });
  assert.equal(board.cards[a], undefined);
  assert.equal(board.archived[0].id, a);
  await mutate("board.card.restore", { id: a, column: "done" });
  assert.equal(board.archived.length, 0);
  assert.deepEqual(board.columns[2].cardIds, [a]);
  await mutate("board.column.rename", { id: "done", title: "Shipped" });
  assert.equal(board.columns[2].done, true);
  await mutate("board.card.remove", { id: a });
  await mutate("board.card.archive", { id: b });
  await mutate("board.card.remove", { id: b });
  assert.equal(board.archived.length, 0);
  await mutate("board.column.add", { title: "Later" });
  assert.equal(board.columns.at(-1).done, false);
  await mutate("board.column.remove", { id: board.columns.at(-1).id });
  assert.equal(board.columns.length, 3);
}));

test("revision lock lets only one concurrent mutation commit", () => isolated(async () => {
  const results = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => boardAction("board.card.add", { revision: 0, title: `Card ${i}` })));
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  for (const result of results.filter((result) => result.status === "rejected")) assert.match(result.reason.message, /revision conflict.*board.get/);
  const board = await boardAction("board.get");
  assert.equal(board.revision, 1);
  assert.equal(Object.keys(board.cards).length, 1);
  await assert.rejects(boardAction("board.card.add", { title: "Missing revision" }), /revision is required/);
}));

test("invalid mutation never changes committed bytes", () => isolated(async (home) => {
  const board = await boardAction("board.card.add", { revision: 0, title: "First" });
  const id = board.columns[0].cardIds[0];
  const path = join(home, "study", "board.json"), before = await readFile(path, "utf8");
  const invalid = [
    ["board.card.add", { title: "Bad date", due: "2026-02-29" }],
    ["board.card.add", { title: "Bad month", due: "2026-13-01" }],
    ["board.card.add", { title: " " }],
    ["board.card.edit", { id, labels: "tag" }],
    ["board.card.move", { id, column: "todo", index: 1 }],
    ["board.column.remove", { id: "todo" }],
    ["board.card.edit", { id: "__proto__", title: "Unsafe" }],
    ["board.card.add", JSON.parse('{"title":"Unsafe","__proto__":{}}')],
    ["board.unknown", {}],
  ];
  for (const [action, args] of invalid) {
    await assert.rejects(boardAction(action, { ...args, revision: 1 }));
    assert.equal(await readFile(path, "utf8"), before);
  }
}));

test("corrupt, unsupported and structurally invalid boards stay read-only and intact", () => isolated(async (home) => {
  await mkdir(join(home, "study"), { recursive: true });
  const path = join(home, "study", "board.json");
  const normal = await boardAction("board.get");
  const duplicate = structuredClone(normal);
  duplicate.columns.push(structuredClone(duplicate.columns[0]));
  for (const bytes of ["{bad json", JSON.stringify({ ...normal, version: 2 }), JSON.stringify(duplicate), JSON.stringify({ ...normal, cards: { missing: {} } }), '{"__proto__":{}}']) {
    await writeFile(path, bytes);
    const result = await boardAction("board.get", { since: 0 });
    assert.equal(result.readOnly, true);
    assert.match(result.error, /preserved/);
    assert.equal(result.unchanged, undefined);
    await assert.rejects(boardAction("board.card.add", { revision: 0, title: "Must not overwrite" }), /preserved/);
    assert.equal(await readFile(path, "utf8"), bytes);
  }
}));
