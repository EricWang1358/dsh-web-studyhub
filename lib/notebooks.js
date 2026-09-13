import { mkdir, readFile, writeFile, rename, rm, access } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import lockfile from "proper-lockfile";
import { Store } from "./store.js";
import { norm } from "./domain.js";

/**
 * Cross-workspace notebook registry. Published notebooks stay in their own
 * workspace; the registry only records where each library lives so any
 * workspace's study panel can offer one-click jumps to the others.
 */
const dshHome = () => {
  const override = process.env.DSH_HOME?.trim();
  return override || join(homedir(), ".dsh");
};
const registryPath = () => join(dshHome(), "study", "notebooks.json");

async function readRegistry() {
  try {
    const parsed = JSON.parse(await readFile(registryPath(), "utf8"));
    if (Array.isArray(parsed?.notebooks)) return parsed;
  } catch {}
  return { version: 1, notebooks: [] };
}
/** Best-effort durable write: a lost registry update never loses study data. */
async function writeRegistry(registry) {
  const target = registryPath();
  await mkdir(join(target, ".."), { recursive: true });
  let release;
  try {
    release = await lockfile.lock(join(target, ".."), {
      realpath: true,
      retries: { retries: 3, minTimeout: 25, maxTimeout: 100 },
      stale: 10000,
    });
  } catch {}
  const tmp = target + "." + Date.now() + ".tmp";
  try {
    await writeFile(tmp, JSON.stringify(registry, null, 2) + "\n", "utf8");
    await rename(tmp, target);
  } finally {
    await rm(tmp, { force: true }).catch(() => {});
    await release?.();
  }
}
const libraryExists = (root) =>
  access(join(root, "study-workspace.json")).then(
    () => true,
    () => false,
  );
/** Live read-only stats for one entry; a missing library reads as absent. */
async function describe(entry, currentRoot) {
  const exists = await libraryExists(entry.root);
  const base = {
    root: entry.root,
    workspace: entry.workspace || "",
    title: entry.title || basename(entry.workspace || entry.root),
    publishedAt: entry.publishedAt || null,
    current: entry.root === currentRoot,
    exists,
    decks: [],
    deckCount: 0,
    dueToday: 0,
  };
  if (!exists) return base;
  try {
    const s = await new Store(entry.root).read();
    const decks = s.decks.map((d) => {
      const cards = d.cards.filter((q) => !q.suspended);
      return {
        id: d.id,
        title: d.title,
        folder: d.folder || "",
        archived: !!d.archived,
        count: cards.length,
        due: cards.filter(
          (q) =>
            !q.review?.due_at || Date.parse(q.review.due_at) <= Date.now(),
        ).length,
      };
    });
    return {
      ...base,
      decks: decks.slice(0, 50),
      deckCount: decks.filter((d) => !d.archived).length,
      dueToday: decks
        .filter((d) => !d.archived)
        .reduce((n, d) => n + d.due, 0),
    };
  } catch {
    return { ...base, exists: false };
  }
}
const byRecency = (a, b) =>
  a.current === b.current
    ? String(b.publishedAt || "").localeCompare(String(a.publishedAt || ""))
    : a.current
      ? -1
      : 1;
export async function listNotebooks(currentRoot) {
  const registry = await readRegistry();
  const described = await Promise.all(
    registry.notebooks
      .filter((e) => e && typeof e.root === "string")
      .map((e) => describe(e, currentRoot)),
  );
  return {
    registryPath: registryPath(),
    currentRoot,
    notebooks: described.filter(Boolean).sort(byRecency),
  };
}
export async function publishNotebook(cwd, currentRoot) {
  const registry = await readRegistry(),
    now = new Date().toISOString();
  const entry = {
    root: currentRoot,
    workspace: cwd,
    title: basename(cwd),
    publishedAt:
      registry.notebooks.find((e) => e?.root === currentRoot)?.publishedAt ||
      now,
  };
  registry.notebooks = [
    ...registry.notebooks.filter((e) => e?.root !== currentRoot),
    entry,
  ];
  await writeRegistry(registry);
  return entry;
}
export async function unpublishNotebook(currentRoot) {
  const registry = await readRegistry();
  registry.notebooks = registry.notebooks.filter((e) => e?.root !== currentRoot);
  await writeRegistry(registry);
}
const normSearch = norm;
/** Read-only search across published libraries: deck titles, topics, prompts. */
export async function searchNotebooks(query) {
  const q = normSearch(query);
  if (!q || q.length > 100)
    throw new Error("A 1–100 character query is required");
  const registry = await readRegistry(),
    items = [];
  for (const entry of registry.notebooks) {
    if (!entry || typeof entry.root !== "string") continue;
    let s;
    try {
      s = await new Store(entry.root).read();
    } catch {
      continue;
    }
    for (const deck of s.decks) {
      if (deck.archived) continue;
      if (normSearch(deck.title).includes(q))
        items.push({
          root: entry.root,
          workspace: entry.workspace || "",
          title: entry.title || basename(entry.workspace || entry.root),
          deckId: deck.id,
          deckTitle: deck.title,
          topic: "",
          cardId: "",
          prompt: "",
          due: 0,
        });
      for (const card of deck.cards) {
        if (card.suspended) continue;
        const hit =
          normSearch(card.topic).includes(q) ||
          normSearch(card.prompt).includes(q) ||
          normSearch(card.objective).includes(q);
        if (!hit) continue;
        items.push({
          root: entry.root,
          workspace: entry.workspace || "",
          title: entry.title || basename(entry.workspace || entry.root),
          deckId: deck.id,
          deckTitle: deck.title,
          topic: card.topic || "",
          cardId: card.id,
          prompt: card.prompt,
          due:
            !card.review?.due_at || Date.parse(card.review.due_at) <= Date.now()
              ? 1
              : 0,
        });
      }
      if (items.length >= 50) break;
    }
    if (items.length >= 50) break;
  }
  return { items: items.slice(0, 50) };
}
