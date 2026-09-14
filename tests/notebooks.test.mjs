import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publishNotebook, unpublishNotebook, listNotebooks } from "../lib/notebooks.js";
import { workspaceLibrary } from "../lib/host.js";
import { Store } from "../lib/store.js";

test("concurrent registry transactions retain independent publishes and removals", async () => {
  const home = await mkdtemp(join(tmpdir(), "study-registry-race-"));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    const roots = Array.from({ length: 8 }, (_, i) => join(home, `library-${i}`));
    await Promise.all(roots.map((root) => publishNotebook(root, root)));
    assert.equal((await listNotebooks(roots[0])).notebooks.length, roots.length);
    await Promise.all([unpublishNotebook(roots[0]), publishNotebook(home, join(home, "extra"))]);
    const list = await listNotebooks(roots[1]);
    assert.equal(list.notebooks.length, roots.length);
    assert.ok(!list.notebooks.some((entry) => entry.root === roots[0]));
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous;
    await rm(home, { recursive: true, force: true });
  }
});

test("global notebook registry publishes, lists and unpublishes workspaces", async () => {
  const home = await mkdtemp(join(tmpdir(), "study-nb-home-"));
  const wsA = await mkdtemp(join(tmpdir(), "study-nb-a-"));
  const wsB = await mkdtemp(join(tmpdir(), "study-nb-b-"));
  process.env.DSH_HOME = home;
  try {
    const rootA = await workspaceLibrary(wsA);
    // A workspace without a library yet still publishes: the panel is usable empty.
    await publishNotebook(wsA, rootA);
    let list = await listNotebooks(rootA);
    assert.equal(list.notebooks.length, 1);
    assert.equal(list.notebooks[0].current, true);
    assert.equal(list.notebooks[0].exists, false);
    assert.equal(list.notebooks[0].workspace, wsA);
    assert.equal(list.registryPath, join(home, "study", "notebooks.json"));

    // B holds a real deck; its stats are read live from its own library.
    const rootB = await workspaceLibrary(wsB);
    await new Store(rootB).update((s) => {
      s.decks.push({
        id: "d1",
        title: "Patterns",
        folder: "",
        archived: false,
        cards: [
          {
            id: "c1",
            suspended: false,
            review: { due_at: new Date(Date.now() - 1000).toISOString() },
          },
          {
            id: "c2",
            suspended: false,
            review: { due_at: new Date(Date.now() + 86400000).toISOString() },
          },
        ],
      });
      return s;
    });
    await publishNotebook(wsB, rootB);
    list = await listNotebooks(rootA);
    assert.equal(list.notebooks.length, 2);
    const b = list.notebooks.find((n) => n.root === rootB);
    assert.equal(b.current, false);
    assert.equal(b.exists, true);
    assert.equal(b.deckCount, 1);
    assert.equal(b.dueToday, 1);
    assert.equal(b.decks[0].title, "Patterns");
    assert.deepEqual(list.notebooks[0], list.notebooks.find((n) => n.current));

    // A corrupt registry file degrades to an empty directory, not an error.
    await writeFile(list.registryPath, "{not json", "utf8");
    list = await listNotebooks(rootA);
    assert.deepEqual(list.notebooks, []);

    await mkdir(join(home, "study"), { recursive: true });
    await publishNotebook(wsA, rootA);
    await unpublishNotebook(rootA);
    list = await listNotebooks(rootA);
    assert.equal(list.notebooks.length, 0);
    assert.equal(
      JSON.parse(await readFile(join(home, "study", "notebooks.json"), "utf8"))
        .notebooks.length,
      0,
    );
  } finally {
    delete process.env.DSH_HOME;
    await rm(home, { recursive: true, force: true });
    await rm(wsA, { recursive: true, force: true });
    await rm(wsB, { recursive: true, force: true });
  }
});
